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


def _bili_root() -> Path:
    """B站下载目录作为内容库第二库根（data/bilibili_downloads/<UP主>/<标题>_<bvid>/）。"""
    data_dir = Path(os.environ.get("WMT_DATA_DIR") or (SCRIPT_DIR / "data"))
    return data_dir / "bilibili_downloads"


def _bili_entry_meta(video_dir: Path) -> dict:
    """合成 B站条目元数据:优先读 metadata.json,缺失时从目录结构与文件系统推导。"""
    meta = state_store.read_json(video_dir / "metadata.json") or {}
    name = video_dir.name
    bvid = name.rsplit("_", 1)[-1] if "_" in name else name
    files = meta.get("files")
    if not files:
        files = [{"path": f.relative_to(video_dir).as_posix(), "size": f.stat().st_size}
                 for f in sorted(video_dir.rglob("*")) if f.is_file()]
    author = meta.get("author") or {"name": video_dir.parent.name}
    collect_time = meta.get("collect_time") or time.strftime(
        "%Y-%m-%dT%H:%M:%S", time.localtime(video_dir.stat().st_mtime))
    return {
        "id": meta.get("id") or bvid,
        "bvid": bvid,
        "title": meta.get("title") or name,
        "author": author,
        "content_type": "video",
        "collect_time": collect_time,
        "publish_time": meta.get("publish_time"),
        "collection_status": meta.get("collection_status") or "complete",
        "files": files,
        "canonical_url": f"https://www.bilibili.com/video/{bvid}",
    }


def find_bilibili_entry(entry_id: str) -> Path | None:
    root = _bili_root()
    if not root.exists() or not entry_id:
        return None
    for up_dir in root.iterdir():
        if not up_dir.is_dir():
            continue
        for video_dir in up_dir.iterdir():
            if video_dir.is_dir() and video_dir.name.endswith(f"_{entry_id}"):
                return video_dir
    return None


def find_entry(entry_id: str) -> Path | None:
    """按 entry_id 定位条目目录（内容库只暴露已提交条目，见 §10.4）。"""
    bili_dir = find_bilibili_entry(entry_id)
    if bili_dir:
        return bili_dir
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

def list_entries(platform: str | None = None, date: str | None = None,
                query: str | None = None, page: int | None = None,
                page_size: int = 50) -> list[dict] | dict:
    """列出条目。无分页参数时保持旧版 list 返回兼容；有 query/page 时返回分页包。"""
    out = []
    query_lower = (query or "").strip().casefold()
    if not LIBRARY_DIR.exists():
        return {"entries": [], "total": 0, "page": 1, "page_size": page_size, "has_more": False} if page is not None or query_lower else out
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
                author = (meta.get("author") or {}).get("name")
                if query_lower and query_lower not in f"{meta.get('title') or ''} {author or ''}".casefold():
                    continue
                files = meta.get("files") or []
                media_files = [f for f in files if str(f.get("path", "")).startswith("media/")]
                out.append({
                    "id": meta.get("id"), "platform": platform_dir.name,
                    "title": meta.get("title"), "author": author,
                    "publish_time": meta.get("publish_time"), "collect_time": meta.get("collect_time"),
                    "collection_status": meta.get("collection_status"), "dir": str(entry_dir),
                    "file_count": len(files), "media_count": len(media_files),
                    "total_bytes": sum(int(f.get("size") or 0) for f in files),
                    "failed_media_count": len(meta.get("failed_items") or []),
                    "warning_count": len(meta.get("warnings") or []),
                })
    # ── B站下载目录(第二库根):合成条目并参与平台/日期/搜索过滤 ──
    if not platform or platform == "bilibili":
        bili_root = _bili_root()
        if bili_root.exists():
            for video_dir in sorted(bili_root.glob("*/*/")):
                if not video_dir.is_dir():
                    continue
                meta = _bili_entry_meta(video_dir)
                author = meta["author"].get("name") if isinstance(meta["author"], dict) else (meta["author"] or "")
                if date and not str(meta.get("collect_time") or "").startswith(date):
                    continue
                if query_lower and query_lower not in f"{meta.get('title') or ''} {author or ''}".casefold():
                    continue
                files = meta.get("files") or []
                media_files = [f for f in files if str(f.get("path", "")).startswith("media/")]
                out.append({
                    "id": meta["id"], "platform": "bilibili",
                    "title": meta["title"], "author": author,
                    "publish_time": meta.get("publish_time"), "collect_time": meta.get("collect_time"),
                    "collection_status": meta.get("collection_status"), "dir": str(video_dir),
                    "file_count": len(files), "media_count": len(media_files),
                    "total_bytes": sum(int(f.get("size") or 0) for f in files),
                    "failed_media_count": 0, "warning_count": 0,
                })
    out.sort(key=lambda e: e.get("collect_time") or "", reverse=True)
    if page is None and not query_lower:
        return out
    page = max(1, int(page or 1))
    page_size = max(1, min(int(page_size or 50), 200))
    start = (page - 1) * page_size
    return {"entries": out[start:start + page_size], "total": len(out),
            "page": page, "page_size": page_size, "has_more": start + page_size < len(out)}


def get_entry(entry_id: str) -> dict | None:
    entry_dir = find_entry(entry_id)
    if not entry_dir:
        return None
    meta = state_store.read_json(entry_dir / "metadata.json") or {}
    if not meta:
        # B站下载目录:合成元数据(视频条目无正文,完整性按文件存在性计)
        meta = _bili_entry_meta(entry_dir)
        meta["integrity"] = {"status": "complete", "file_count": len(meta.get("files") or []),
                             "ok_count": len(meta.get("files") or [])}
        meta["dir"] = str(entry_dir)
        return meta
    meta["dir"] = str(entry_dir)
    meta["integrity"] = check_entry_integrity(entry_dir, meta)
    return meta


def check_entry_integrity(entry_dir: Path, meta: dict | None = None) -> dict:
    """校验条目 manifest 的存在性、大小和 sha256；只读，不修复、不删除。"""
    meta = meta or (state_store.read_json(entry_dir / "metadata.json") or {})
    files = meta.get("files") or []
    results = []
    for item in files:
        rel = str(item.get("path") or "")
        fp = entry_dir / rel
        status = "ok"
        reason = ""
        if not rel or not fp.is_file():
            status, reason = "missing", "文件不存在"
        else:
            try:
                actual_size = fp.stat().st_size
                actual_sha = hashlib.sha256(fp.read_bytes()).hexdigest()
                if item.get("size") is not None and int(item["size"]) != actual_size:
                    status, reason = "size_mismatch", f"大小不符（记录 {item['size']}，实际 {actual_size}）"
                elif item.get("sha256") and item["sha256"] != actual_sha:
                    status, reason = "hash_mismatch", "sha256 校验不符"
            except OSError as e:
                status, reason = "unreadable", str(e)
        results.append({"path": rel, "status": status, **({"reason": reason} if reason else {})})
    bad = [r for r in results if r["status"] != "ok"]
    declared_partial = meta.get("collection_status") == "partial" or bool(meta.get("failed_items"))
    if bad:
        status = "corrupt" if any(r["status"] in {"hash_mismatch", "size_mismatch"} for r in bad) else "partial"
    elif declared_partial:
        status = "partial"
    else:
        status = "complete"
    return {"status": status, "file_count": len(files), "ok_count": len(files) - len(bad),
            "bad_count": len(bad), "files": results,
            "warnings": meta.get("warnings") or [], "failed_items": meta.get("failed_items") or []}


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
