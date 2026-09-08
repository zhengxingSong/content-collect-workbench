"""失败媒体定向补采（P2-3）：只重下 failed_items 中的媒体，不新建条目。

成功后：文件落 media/、manifest 追加（含 source_url）、failed_items 清空、
collection_status 重算（有 warnings 仍为 partial）。metadata.json 原子写。
"""

from __future__ import annotations

import hashlib
import mimetypes
import time
from pathlib import Path

from backend import library
from backend.core import state_store
from backend.core.errors import CollectError, ErrorCode


def _default_downloader(url: str, path: Path) -> bool:
    from backend.downloader import download_resource
    return download_resource(url, path)


def _media_name(url: str, existing: set[str]) -> str:
    from backend.downloader import get_ext
    from urllib.parse import urlparse
    base = Path(urlparse(url).path).name or "media"
    base = library._safe_slug(base, 60) or "media"
    ext = get_ext(url) or ".dat"
    if not ext.startswith("."):
        ext = "." + ext
    stem = base[:60] if base.endswith(ext) else base
    name = f"{stem}{ext}"
    i = 1
    while name in existing:
        name = f"{stem}_{i}{ext}"
        i += 1
    return name


def retry_entry_media(entry_id: str, downloader=None) -> dict:
    """重试条目内失败的媒体下载。返回 {retried, succeeded, failed, still_failed}。"""
    downloader = downloader or _default_downloader
    entry_dir = library.find_entry(entry_id)
    if not entry_dir:
        raise CollectError(ErrorCode.NOT_FOUND, "entry not found")
    meta = state_store.read_json(entry_dir / "metadata.json") or {}
    failed = [f for f in (meta.get("failed_items") or [])
              if isinstance(f, dict) and f.get("key", "").startswith("http")]
    if not failed:
        return {"retried": 0, "succeeded": 0, "failed": 0, "still_failed": []}

    media_dir = entry_dir / "media"
    media_dir.mkdir(parents=True, exist_ok=True)
    existing_names = {f["path"].split("/", 1)[1] for f in meta.get("files", [])
                      if str(f.get("path", "")).startswith("media/")}
    still: list[dict] = []
    succeeded = 0
    new_files: list[dict] = []
    for item in failed:
        url = item["key"]
        name = _media_name(url, existing_names)
        target = media_dir / name
        try:
            ok = downloader(url, target)
        except Exception:  # noqa: BLE001 - 下载器异常按失败处理
            ok = False
        if ok and target.is_file() and target.stat().st_size > 0:
            data = target.read_bytes()
            new_files.append({
                "path": f"media/{name}", "mime": mimetypes.guess_type(name)[0] or "application/octet-stream",
                "size": len(data), "sha256": hashlib.sha256(data).hexdigest(), "source_url": url,
            })
            existing_names.add(name)
            succeeded += 1
        else:
            if target.exists():
                target.unlink(missing_ok=True)
            still.append({"key": url, "reason": item.get("reason") or "补采仍失败"})
        time.sleep(0.3)  # 温和限速，避免补采触发图片防盗链风控

    if succeeded:
        meta["files"] = list(meta.get("files") or []) + new_files
        meta["failed_items"] = still
        warnings = [w for w in (meta.get("warnings") or [])
                    if not (isinstance(w, str) and "个媒体资源下载失败" in w)]
        if still:
            warnings.append(f"{len(still)} 个媒体资源仍下载失败（保留远程链接）")
        meta["warnings"] = warnings
        meta["collection_status"] = "complete" if not (still or meta["warnings"]) else "partial"
        meta["repaired_at"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
        state_store.atomic_write_json(entry_dir / "metadata.json", meta, private=False)
    return {"retried": len(failed), "succeeded": succeeded,
            "failed": len(still), "still_failed": still}
