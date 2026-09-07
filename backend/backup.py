"""内容库备份/恢复：只处理 output/，不触碰敏感凭证与服务令牌。"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import tempfile
import time
import zipfile
from pathlib import Path

from backend import library
from backend.core import state_store
from backend.core.errors import CollectError, ErrorCode

BACKUP_VERSION = "1.0"
MAX_BACKUP_BYTES = 2 * 1024 * 1024 * 1024
MAX_BACKUP_FILES = 100_000


def _safe_rel(name: str) -> bool:
    p = Path(name)
    return bool(name) and not p.is_absolute() and ".." not in p.parts and "\\" not in name


def _sha(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def create_backup(dest: str) -> dict:
    dest_path = Path(dest)
    if not dest_path.is_absolute():
        raise CollectError(ErrorCode.INVALID_INPUT, "备份目标必须是绝对路径")
    dest_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest_path.with_suffix(dest_path.suffix + ".tmp")
    files = []
    total_bytes = 0
    for fp in sorted(library.LIBRARY_DIR.rglob("*")) if library.LIBRARY_DIR.exists() else []:
        if not fp.is_file() or not any((parent / "_COMPLETE").is_file() for parent in fp.parents):
            continue
        rel = str(fp.relative_to(library.LIBRARY_DIR)).replace("\\", "/")
        size = fp.stat().st_size
        total_bytes += size
        files.append({"path": rel, "size": size, "sha256": _sha(fp)})
    if len(files) > MAX_BACKUP_FILES or total_bytes > MAX_BACKUP_BYTES:
        raise CollectError(ErrorCode.QUOTA_EXCEEDED, "内容库超过备份上限")
    manifest = {"backup_version": BACKUP_VERSION, "created_at": time.time(),
                "file_count": len(files), "total_bytes": total_bytes, "files": files}
    try:
        with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
            z.writestr("BACKUP_MANIFEST.json", json.dumps(manifest, ensure_ascii=False, indent=2))
            for item in files:
                z.write(library.LIBRARY_DIR / item["path"], item["path"])
        os.replace(tmp, dest_path)
    finally:
        if tmp.exists():
            tmp.unlink(missing_ok=True)
    return {"path": str(dest_path), "file_count": len(files), "total_bytes": total_bytes,
            "backup_version": BACKUP_VERSION}


def validate_backup(path: str) -> dict:
    backup = Path(path)
    if not backup.is_absolute() or not backup.is_file():
        raise CollectError(ErrorCode.INVALID_INPUT, "备份文件不存在或路径不是绝对路径")
    total = 0
    checked = 0
    with zipfile.ZipFile(backup) as z:
        try:
            manifest = json.loads(z.read("BACKUP_MANIFEST.json"))
        except Exception as e:
            raise CollectError(ErrorCode.INVALID_INPUT, f"备份清单无效: {e}") from e
        if manifest.get("backup_version") != BACKUP_VERSION:
            raise CollectError(ErrorCode.INVALID_INPUT, "不支持的备份版本")
        entries = manifest.get("files") or []
        if len(entries) > MAX_BACKUP_FILES:
            raise CollectError(ErrorCode.QUOTA_EXCEEDED, "备份文件数超过上限")
        names = set(z.namelist())
        for item in entries:
            rel = item.get("path", "")
            if not _safe_rel(rel) or rel not in names or rel == "BACKUP_MANIFEST.json":
                raise CollectError(ErrorCode.INVALID_INPUT, f"备份路径无效或缺失: {rel}")
            info = z.getinfo(rel)
            total += info.file_size
            if total > MAX_BACKUP_BYTES:
                raise CollectError(ErrorCode.QUOTA_EXCEEDED, "备份大小超过上限")
            if info.file_size != int(item.get("size", -1)):
                raise CollectError(ErrorCode.INVALID_INPUT, f"文件大小校验失败: {rel}")
            with z.open(rel) as f:
                actual = hashlib.sha256(f.read()).hexdigest()
            if actual != item.get("sha256"):
                raise CollectError(ErrorCode.INVALID_INPUT, f"文件校验失败: {rel}")
            checked += 1
    return {"valid": True, "backup_version": BACKUP_VERSION,
            "file_count": checked, "total_bytes": total}


def restore_backup(path: str, mode: str = "merge") -> dict:
    if mode not in {"merge", "replace"}:
        raise CollectError(ErrorCode.INVALID_INPUT, "mode must be merge or replace")
    validation = validate_backup(path)
    backup = Path(path)
    temp_parent = library.LIBRARY_DIR.parent
    tmp_dir = Path(tempfile.mkdtemp(prefix=".restore_", dir=temp_parent))
    try:
        with zipfile.ZipFile(backup) as z:
            for name in z.namelist():
                if name == "BACKUP_MANIFEST.json":
                    continue
                if not _safe_rel(name):
                    raise CollectError(ErrorCode.INVALID_INPUT, f"备份路径无效: {name}")
                target = tmp_dir / name
                target.parent.mkdir(parents=True, exist_ok=True)
                with z.open(name) as src, target.open("wb") as dst:
                    shutil.copyfileobj(src, dst)
        # 仅把含 _COMPLETE 的条目视为可恢复内容
        recovered = 0
        for marker in tmp_dir.rglob("_COMPLETE"):
            if marker.is_file():
                recovered += 1
        if mode == "replace":
            old = library.LIBRARY_DIR.with_name(library.LIBRARY_DIR.name + ".before_restore")
            if old.exists():
                shutil.rmtree(old)
            if library.LIBRARY_DIR.exists():
                os.replace(library.LIBRARY_DIR, old)
            os.replace(tmp_dir, library.LIBRARY_DIR)
            shutil.rmtree(old, ignore_errors=True)
        else:
            library.LIBRARY_DIR.mkdir(parents=True, exist_ok=True)
            for child in tmp_dir.iterdir():
                target = library.LIBRARY_DIR / child.name
                if target.exists():
                    shutil.copytree(child, target, dirs_exist_ok=True)
                else:
                    os.replace(child, target)
        # 备份中的 dedup_index 不可信：从当前 output 重建
        _rebuild_dedup_index()
        return {**validation, "restored_entries": recovered, "mode": mode,
                "credentials_restored": False}
    except Exception:
        # replace 在 os.replace 前不会动现有库；异常时尽量清理临时目录
        raise
    finally:
        if tmp_dir.exists():
            shutil.rmtree(tmp_dir, ignore_errors=True)


def _rebuild_dedup_index() -> None:
    index = {}
    for entry in library.list_entries():
        if entry.get("id"):
            # 现有索引可通过 metadata 的 canonical_url 重建；未知键不强行猜测
            meta = library.get_entry(entry["id"]) or {}
            canonical = meta.get("canonical_url") or meta.get("source_url")
            if canonical:
                index[f"url:{canonical}"] = entry["id"]
    state_store.atomic_write_json(state_store.DEDUP_INDEX_FILE, index)
