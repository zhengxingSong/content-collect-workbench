"""产物契约层（设计文档 §10/§11/§12）。

- output/ 即对外契约：条目目录原子发布（.tmp -> _COMPLETE -> os.replace），半成品不可见；
- 条目身份 = 平台+平台内容ID（无平台 ID 时用规范化 URL）；content_hash 只识别内容变化；
- 去重索引 state/dedup_index.json（urlnorm-v1 身份键 -> entry_id）；
- library_export 提供自包含导出（校验 sha256 后清理临时副本）。
"""

from __future__ import annotations

import base64
import hashlib
import mimetypes
import re
import shutil
import threading
import time
import uuid
from pathlib import Path

from backend.config import SCRIPT_DIR
from backend.core import state_store, urlnorm
from backend.core.errors import CollectError, ErrorCode

import os

LIBRARY_DIR = Path(os.environ.get("WMT_OUTPUT_DIR") or (SCRIPT_DIR / "output"))
SCHEMA_VERSION = "1.0"
COLLECTOR_VERSION = "1.0.0"
MAX_ENTRY_FILES = 500

_lock = threading.Lock()


def _safe_slug(text: str, mx: int = 40) -> str:
    text = re.sub(r"[\\/:*?\"<>|\s\x00-\x1f]+", "_", (text or "").strip())
    return text.strip("_")[:mx] or "untitled"


def entry_id_for(platform: str, identity_key: str) -> str:
    """条目 ID：身份键的规范化哈希（稳定、路径安全）。"""
    return hashlib.sha256(f"{platform}|{identity_key}".encode("utf-8")).hexdigest()[:16]


def find_entry(entry_id: str) -> Path | None:
    """按 entry_id 定位条目目录（内容库只暴露已提交条目，见 §10.4）。"""
    if not re.fullmatch(r"[0-9a-f]{16}", entry_id):
        return None
    for platform_dir in LIBRARY_DIR.iterdir() if LIBRARY_DIR.exists() else []:
        if not platform_dir.is_dir():
            continue
        for source_dir in platform_dir.iterdir():
            if not source_dir.is_dir():
                continue
            for entry_dir in source_dir.iterdir():
                if entry_dir.is_dir() and entry_dir.name.endswith(f"_{entry_id}"):
                    if (entry_dir / "_COMPLETE").exists():
                        return entry_dir
    return None


def commit_entry(platform: str, item: dict) -> dict:
    """提交一个条目（§10.4 原子提交协议）。返回 {entry_id, dir, deduped}。

    item 字段：source_url（必填）、content_md / content_html / media_paths（可含 data: URI）、
    title、author{name,id,url}、publish_time、content_text（用于 hash）、
    warnings、failed_items、extra。
    """
    source_url = (item.get("source_url") or "").strip()
    if not source_url:
        raise CollectError(ErrorCode.INVALID_INPUT, "source_url is required")

    identity = urlnorm.identity_key(source_url)
    entry_id = entry_id_for(platform, identity)
    content_hash = urlnorm.nchash(item.get("content_text") or item.get("content_md") or "")

    with _lock:
        index = state_store.read_json(state_store.DEDUP_INDEX_FILE, {}) or {}
        prev = index.get(identity)

    # 内容变化检测：同身份、内容 hash 不同 → 版本化目录，不覆盖历史
    prev_dir = find_entry(prev) if prev else None
    version_suffix = ""
    if prev_dir is not None:
        prev_meta = state_store.read_json(prev_dir / "metadata.json", {}) or {}
        if prev_meta.get("content_hash", {}).get("value") == content_hash:
            return {"entry_id": prev, "dir": str(prev_dir), "deduped": True}
        version_suffix = f".v{int(prev_meta.get('version', 1)) + 1}"

    title = _safe_slug(item.get("title") or "untitled")
    publish_date = (item.get("publish_time") or "")[:10] or time.strftime("%Y-%m-%d")
    source_slug = _safe_slug(item.get("author", {}).get("id") or item.get("author", {}).get("name") or "unknown")

    final_dir = LIBRARY_DIR / platform / source_slug / f"{publish_date}_{title}_{entry_id}{version_suffix}"
    tmp_dir = final_dir.parent / f".tmp_{entry_id}_{uuid.uuid4().hex[:8]}"

    if final_dir.exists():
        # 目录名冲突（同日期同标题同 id）：视为已存在条目
        return {"entry_id": entry_id, "dir": str(final_dir), "deduped": True}

    try:
        (tmp_dir / "media").mkdir(parents=True, exist_ok=True)
        if item.get("content_md"):
            (tmp_dir / "content.md").write_text(item["content_md"], encoding="utf-8")
        if item.get("content_html"):
            (tmp_dir / "content.html").write_text(item["content_html"], encoding="utf-8")
        media_sources = _write_media(tmp_dir / "media", item.get("media_paths") or [])

        files_manifest = _manifest(tmp_dir, media_sources)
        metadata = {
            "schema_version": SCHEMA_VERSION,
            "id": entry_id,
            "version": 2 if version_suffix else 1,
            "platform": platform,
            "platform_item_id": item.get("platform_item_id"),
            "canonical_url": urlnorm.normalize_url(source_url),
            "source_url": source_url,
            "content_type": item.get("content_type") or "article",
            "collection_status": "complete" if not (item.get("failed_items") or item.get("warnings")) else "partial",
            "collector_version": COLLECTOR_VERSION,
            "title": item.get("title") or "",
            "author": item.get("author") or {},
            "publish_time": item.get("publish_time"),   # 未知不伪造，可为 null
            "collect_time": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "content_hash": {"algo": urlnorm.NCHASH_VERSION, "value": content_hash},
            "files": files_manifest,
            "warnings": item.get("warnings") or [],
            "failed_items": item.get("failed_items") or [],
            "extra": item.get("extra") or {},
        }
        state_store.atomic_write_json(tmp_dir / "metadata.json", metadata)
        (tmp_dir / "_COMPLETE").write_text("ok", encoding="utf-8")

        # 同文件系统原子发布（§10.4）
        final_dir.parent.mkdir(parents=True, exist_ok=True)
        import os
        os.replace(tmp_dir, final_dir)
    finally:
        if tmp_dir.exists():
            shutil.rmtree(tmp_dir, ignore_errors=True)

    with _lock:
        index = state_store.read_json(state_store.DEDUP_INDEX_FILE, {}) or {}
        index[identity] = entry_id
        state_store.atomic_write_json(state_store.DEDUP_INDEX_FILE, index)

    return {"entry_id": entry_id, "dir": str(final_dir), "deduped": False}


def _write_media(media_dir: Path, media_specs: list[dict]) -> dict:
    """media_specs: {data_b64 | src_path, name, source_url} — 落盘媒体文件（有数量上限）。

    返回 {相对路径: 远程来源URL} 映射，供预览时把远程图片重写为本地文件。
    """
    sources: dict[str, str] = {}
    for i, spec in enumerate(media_specs[:MAX_ENTRY_FILES]):
        name = _safe_slug(spec.get("name") or f"media_{i}", 80)
        try:
            if spec.get("data_b64"):
                (media_dir / name).write_bytes(base64.b64decode(spec["data_b64"]))
            elif spec.get("src_path"):
                shutil.copyfile(spec["src_path"], media_dir / name)
            else:
                continue
            if spec.get("source_url"):
                sources[f"media/{name}"] = spec["source_url"]
        except (OSError, ValueError):
            continue
    return sources


def _manifest(entry_dir: Path, media_sources: dict | None = None) -> list[dict]:
    media_sources = media_sources or {}
    out = []
    for f in sorted(entry_dir.rglob("*")):
        if not f.is_file() or f.name == "_COMPLETE":
            continue
        data = f.read_bytes()
        mime = mimetypes.guess_type(f.name)[0] or "application/octet-stream"
        rel = str(f.relative_to(entry_dir)).replace("\\", "/")
        entry = {
            "path": rel,
            "mime": mime,
            "size": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
        }
        if rel in media_sources:
            entry["source_url"] = media_sources[rel]
        out.append(entry)
    return out


# ── 查询与导出（§12） ─────────────────────────────────────

def list_entries(platform: str | None = None, date: str | None = None) -> list[dict]:
    out = []
    if not LIBRARY_DIR.exists():
        return out
    for platform_dir in sorted(LIBRARY_DIR.iterdir()):
        if not platform_dir.is_dir():
            continue
        if platform and platform_dir.name != platform:
            continue
        for source_dir in platform_dir.iterdir():
            if not source_dir.is_dir():
                continue
            for entry_dir in source_dir.iterdir():
                if not entry_dir.is_dir() or not (entry_dir / "_COMPLETE").exists():
                    continue
                meta = state_store.read_json(entry_dir / "metadata.json") or {}
                if date and not meta.get("collect_time", "").startswith(date):
                    continue
                out.append({
                    "id": meta.get("id"),
                    "platform": platform_dir.name,
                    "title": meta.get("title"),
                    "author": (meta.get("author") or {}).get("name"),
                    "publish_time": meta.get("publish_time"),
                    "collect_time": meta.get("collect_time"),
                    "collection_status": meta.get("collection_status"),
                    "dir": str(entry_dir),
                })
    return sorted(out, key=lambda e: e.get("collect_time") or "", reverse=True)


def get_entry(entry_id: str) -> dict | None:
    entry_dir = find_entry(entry_id)
    if not entry_dir:
        return None
    meta = state_store.read_json(entry_dir / "metadata.json") or {}
    meta["dir"] = str(entry_dir)
    return meta


def export_entries(entry_ids: list[str], dest: str) -> dict:
    """自包含导出（§12）：复制条目到 dest，逐文件校验 sha256。"""
    dest_path = Path(dest)
    if not dest_path.is_absolute():
        raise CollectError(ErrorCode.INVALID_INPUT, "dest must be an absolute path")
    results = []
    for eid in entry_ids:
        entry_dir = find_entry(eid)
        if not entry_dir:
            results.append({"entry_id": eid, "status": "failed", "message": "entry not found"})
            continue
        meta = state_store.read_json(entry_dir / "metadata.json") or {}
        target = dest_path / entry_dir.name
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            shutil.copytree(entry_dir, target)
            ok = True
            for f in meta.get("files", []):
                fp = target / f["path"]
                if not fp.exists() or hashlib.sha256(fp.read_bytes()).hexdigest() != f["sha256"]:
                    ok = False
                    break
            # 临时副本清理（跨文件系统不假定原子，§10.4）
            results.append({"entry_id": eid, "status": "succeeded" if ok else "failed",
                            "dir": str(target)})
        except OSError as e:
            results.append({"entry_id": eid, "status": "failed", "message": str(e)})
    return {"exported": sum(1 for r in results if r["status"] == "succeeded"), "items": results}
