"""内容库 HTTP 端点（设计文档 §12）。供 Web 与 MCP 工具共用。"""

from __future__ import annotations

import urllib.parse
from pathlib import Path

from flask import Blueprint, jsonify, request

from backend import library
from backend.core import state_store
from backend.core.errors import CollectError, ErrorCode, fail, ok
from backend.security import local_access_required

library_bp = Blueprint("library", __name__, url_prefix="/api/library")


@library_bp.route("/entries", methods=["GET"])
@local_access_required
def list_entries():
    platform = request.args.get("platform")
    date = request.args.get("date")
    query = (request.args.get("q") or "").strip()
    if len(query) > 100:
        return jsonify(fail(CollectError(ErrorCode.INVALID_INPUT, "q must be at most 100 characters"))), 400
    page_arg = request.args.get("page")
    page_size_arg = request.args.get("page_size")
    try:
        # 显式 page_size 也意味着分页，从第 1 页开始；完全无分页参数才走旧全量返回。
        page = int(page_arg) if page_arg is not None else (1 if page_size_arg is not None else None)
        page_size = int(page_size_arg or 50)
    except ValueError:
        return jsonify(fail(CollectError(ErrorCode.INVALID_INPUT, "page and page_size must be integers"))), 400
    if page is not None and page < 1:
        return jsonify(fail(CollectError(ErrorCode.INVALID_INPUT, "page must be >= 1"))), 400
    if page_size < 1 or page_size > 200:
        return jsonify(fail(CollectError(ErrorCode.INVALID_INPUT, "page_size must be between 1 and 200"))), 400
    result = library.list_entries(platform, date, query or None, page, page_size)
    if isinstance(result, list):
        return jsonify(ok("条目列表", {"entries": result}))
    return jsonify(ok("条目列表", result))


@library_bp.route("/entries/<entry_id>", methods=["GET"])
@local_access_required
def get_entry(entry_id):
    meta = library.get_entry(entry_id)
    if not meta:
        return jsonify(fail(CollectError(ErrorCode.NOT_FOUND, "entry not found"))), 404
    return jsonify(ok("条目详情", {"entry": meta}))


@library_bp.route("/export", methods=["POST"])
@local_access_required
def export_entries():
    body = request.get_json(silent=True) or {}
    entry_ids = body.get("entry_ids") or []
    dest = (body.get("dest") or "").strip()
    if not entry_ids or not dest:
        return jsonify(fail(CollectError(ErrorCode.INVALID_INPUT,
                                         "entry_ids and dest are required"))), 400
    result = library.export_entries(entry_ids, dest)
    return jsonify(ok(f"导出完成 {result['exported']}/{len(entry_ids)}", result))


@library_bp.route("/backup/list", methods=["GET"])
def list_library_backups():
    """列出本地备份文件(名称/大小/修改时间),供前端备份历史展示"""
    import time as _time

    from backend.config import DATA_DIR

    bdir = DATA_DIR / "backups"
    items = []
    if bdir.is_dir():
        for fp in sorted(bdir.glob("*.zip"), key=lambda x: x.stat().st_mtime, reverse=True):
            st = fp.stat()
            items.append({
                "name": fp.name, "path": str(fp), "size": st.st_size,
                "mtime": st.st_mtime, "mtime_h": _time.strftime("%Y-%m-%d %H:%M", _time.localtime(st.st_mtime)),
            })
    return jsonify(ok("备份列表", {"backups": items, "total": len(items)}))


@library_bp.route("/backup", methods=["POST"])
@local_access_required
def backup_library():
    from backend.backup import create_backup
    body = request.get_json(silent=True) or {}
    dest = (body.get("dest") or "").strip()
    if not dest:
        from backend.config import DATA_DIR
        dest = str(DATA_DIR / "backups" / f"library-{__import__('time').strftime('%Y%m%d-%H%M%S')}.zip")
    try:
        result = create_backup(dest)
        return jsonify(ok("内容库备份完成", result))
    except CollectError as e:
        return jsonify(fail(e)), 413 if e.code == ErrorCode.QUOTA_EXCEEDED else 400


@library_bp.route("/restore/validate", methods=["POST"])
@local_access_required
def validate_library_backup():
    from backend.backup import validate_backup
    body = request.get_json(silent=True) or {}
    path = (body.get("path") or "").strip()
    try:
        return jsonify(ok("备份校验通过", validate_backup(path)))
    except CollectError as e:
        return jsonify(fail(e)), 400


@library_bp.route("/restore", methods=["POST"])
@local_access_required
def restore_library_backup():
    from backend.backup import restore_backup
    body = request.get_json(silent=True) or {}
    path = (body.get("path") or "").strip()
    mode = (body.get("mode") or "merge").strip()
    if body.get("confirm") is not True:
        return jsonify(fail(CollectError(ErrorCode.INVALID_INPUT, "restore requires confirm=true"))), 400
    try:
        return jsonify(ok("内容库恢复完成（凭证未恢复，请重新认证）", restore_backup(path, mode)))
    except CollectError as e:
        return jsonify(fail(e)), 400


@library_bp.route("/entries/<entry_id>/preview", methods=["GET"])
@local_access_required
def preview_entry(entry_id):
    """升级版预览（§4）：本地图片重写 + 文章排版，脚本一律不执行。

    - media/ 文件重写为本端点 file 路由（离线可读，旧条目无映射时保留远程图）；
    - CSP 允许 img/style，禁 script/外连；sandbox 禁 JS。
    """
    from flask import Response
    import html as html_mod
    entry_dir = library.find_entry(entry_id)
    if not entry_dir:
        return jsonify(fail(CollectError(ErrorCode.NOT_FOUND, "entry not found"))), 404
    meta = state_store.read_json(entry_dir / "metadata.json") or {}
    files = {f["path"]: f for f in meta.get("files", [])}
    body = None
    title = meta.get("title") or "(无标题)"
    for cand in ("content.html", "content.md"):
        if cand in files:
            body = (entry_dir / cand).read_text(encoding="utf-8", errors="replace")
            is_md = cand.endswith(".md")
            break
    if body is None:
        return jsonify(fail(CollectError(ErrorCode.NOT_FOUND, "无可预览正文"))), 404

    # 远程图片 → 本地文件（含 HTML 转义形态 &amp;）
    for f in meta.get("files", []):
        src = f.get("source_url")
        if not src or not f["path"].startswith("media/"):
            continue
        local = f"/api/library/entries/{entry_id}/file?path={f['path']}"
        body = body.replace(src, local).replace(
            html_mod.escape(src, quote=True), html_mod.escape(local, quote=True))
    if is_md:
        from backend.core.html2md import html_to_markdown  # noqa: F401 (占位，见下)
        # markdown 预览：极简 md→html 由前端渲染成本高，这里直接以 <pre> 风格呈现
        import markdown  # 可选依赖，缺失时降级
        try:
            body = markdown.markdown(body, extensions=["extra", "sane_lists"])
        except Exception:
            body = "<pre>" + html_mod.escape(body) + "</pre>"

    author = (meta.get("author") or {}).get("name", "")
    pub = meta.get("publish_time") or ""
    # 双保险：剥离脚本与事件属性（CSP+sandbox 已兜底）
    import re as _re
    body = _re.sub(r"<script\b[^>]*>.*?</script>", "", body, flags=_re.S | _re.I)
    body = _re.sub(r"\son\w+\s*=\s*(\"[^\"]*\"|'[^']*'|[^\s>]+)", "", body, flags=_re.I)
    # 微信文章懒加载：data-src 换成 src（沙箱内无脚本，必须在服务端完成）
    # 注意 "data-src=" 包含子串 "src="，必须用环视精确匹配真实 src 属性
    def _lift_lazy(m):
        tag = m.group(0)
        if 'data-src="' not in tag:
            return tag
        msrc = _re.search(r'(?<![-\w])src="([^"]*)"', tag)
        if msrc and msrc.group(1).strip():
            return tag  # 已有非空 src（占位图等），不覆盖
        return tag.replace('data-src="', 'src="', 1)
    body = _re.sub(r"<img\b[^>]*>", _lift_lazy, body, flags=_re.I)
    page = f"""<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="referrer" content="no-referrer">
<style>
  body {{ font-family: -apple-system,'PingFang SC','Microsoft YaHei',sans-serif;
         max-width: 720px; margin: 0 auto; padding: 28px 20px 60px;
         color:#1f2328; line-height:1.85; font-size:16px; background:#fff; }}
  h1 {{ font-size:1.5em; line-height:1.4; margin:.4em 0 .2em; }}
  .meta {{ color:#86909c; font-size:.85em; margin-bottom:1.6em; }}
  img {{ max-width:100%; height:auto; border-radius:6px; margin:8px 0; }}
  pre, code {{ background:#f6f8fa; border-radius:6px; font-size:.9em; }}
  pre {{ padding:12px; overflow:auto; }} code {{ padding:2px 5px; }}
  blockquote {{ margin:0; padding:4px 14px; color:#57606a; border-left:4px solid #d0d7de; }}
</style></head><body>
<h1>{html_mod.escape(title)}</h1>
<div class="meta">{html_mod.escape(author)}{' · ' + html_mod.escape(str(pub)[:10]) if pub else ''} · 来源 {html_mod.escape(meta.get('platform',''))}</div>
{body}
</body></html>"""
    return Response(page, mimetype="text/html",
                    headers={"Content-Security-Policy":
                             "default-src 'none'; img-src http: https: data:; "
                             "style-src 'unsafe-inline' http: https: data:; "
                             "font-src http: https: data:; sandbox",
                             "X-Content-Type-Options": "nosniff"})


@library_bp.route("/entries/<entry_id>/open-folder", methods=["POST"])
@local_access_required
def open_folder(entry_id):
    """打开条目目录。

    宿主机模式（Windows dev）直接调资源管理器；Docker 容器内无法打开
    宿主机文件管理器——返回 supported=False + 宿主可见路径，前端引导
    使用「下载打包」。
    """
    import subprocess
    import sys
    entry_dir = library.find_entry(entry_id)
    if not entry_dir:
        return jsonify(fail(CollectError(ErrorCode.NOT_FOUND, "entry not found"))), 404
    if sys.platform != "win32":
        return jsonify(ok("容器模式不支持直接打开目录，已提供打包下载", {
            "supported": False,
            "path": str(entry_dir),
            "download": f"/api/library/entries/{entry_id}/download",
        }))
    try:
        si = subprocess.STARTUPINFO()
        si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        subprocess.Popen(["explorer", str(entry_dir)], startupinfo=si)
        return jsonify(ok("已打开目录", {"dir": str(entry_dir)}))
    except OSError as e:
        return jsonify(fail(CollectError(ErrorCode.INTERNAL, str(e)))), 200


@library_bp.route("/entries/<entry_id>/retry-media", methods=["POST"])
@local_access_required
def retry_media(entry_id):
    """定向补采条目内失败媒体；成功后更新 manifest 与完整性状态。"""
    from backend.media_retry import retry_entry_media
    try:
        result = retry_entry_media(entry_id)
    except CollectError as e:
        return jsonify(fail(e)), 404 if e.code == ErrorCode.NOT_FOUND else 400
    if result["retried"] == 0:
        return jsonify(ok("该条目没有可补采的失败媒体", result))
    summary = (f"补采完成：成功 {result['succeeded']}/{result['retried']}"
               if result["failed"] == 0 else
               f"补采部分成功：{result['succeeded']}/{result['retried']}，剩余 {result['failed']} 个仍失败")
    return jsonify(ok(summary, result))


@library_bp.route("/entries/batch-download", methods=["POST"])
@local_access_required
def batch_download_entries():
    """将多个内容库条目打包为单个 ZIP；仅包含 output 条目，不含 data/state。"""
    import io
    import zipfile
    body = request.get_json(silent=True) or {}
    entry_ids = body.get("entry_ids") or []
    if not isinstance(entry_ids, list) or not entry_ids or len(entry_ids) > 50:
        return jsonify(fail(CollectError(ErrorCode.INVALID_INPUT, "entry_ids must contain 1-50 ids"))), 400
    entries = []
    for eid in entry_ids:
        entry_dir = library.find_entry(str(eid))
        if not entry_dir:
            return jsonify(fail(CollectError(ErrorCode.NOT_FOUND, f"entry not found: {eid}"))), 404
        entries.append((str(eid), entry_dir))
    buf = io.BytesIO()
    total_files = 0
    total_bytes = 0
    def add_entry_to_zip(z, eid, entry_dir):
        meta = state_store.read_json(entry_dir / "metadata.json") or {}
        replacements = {}
        for item in meta.get("files", []):
            if str(item.get("path", "")).startswith("media/") and item.get("source_url"):
                replacements[item["source_url"]] = "media/" + Path(item["path"]).name
        for fp in sorted(entry_dir.rglob("*")):
            if not fp.is_file():
                continue
            rel = str(fp.relative_to(entry_dir)).replace("\\", "/")
            data = fp.read_bytes()
            if rel == "content.md" and replacements:
                text = data.decode("utf-8", errors="replace")
                for remote, local in replacements.items():
                    text = text.replace(remote, local)
                data = text.encode("utf-8")
            yield rel, data

    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for eid, entry_dir in entries:
            for rel, data in add_entry_to_zip(z, eid, entry_dir):
                total_files += 1
                total_bytes += len(data)
                if total_files > 1000 or total_bytes > 512 * 1024 * 1024:
                    return jsonify(fail(CollectError(ErrorCode.QUOTA_EXCEEDED, "批量导出超过文件或大小上限"))), 413
                z.writestr(str(Path(eid) / rel), data)
    from flask import Response
    return Response(buf.getvalue(), mimetype="application/zip",
                    headers={"Content-Disposition": "attachment; filename*=UTF-8''library-export.zip"})


@library_bp.route("/entries/<entry_id>/download", methods=["GET"])
@local_access_required
def download_entry(entry_id):
    """整条目打包为 zip 下载（容器模式下的目录等效能力）。"""
    import io
    import zipfile
    entry_dir = library.find_entry(entry_id)
    if not entry_dir:
        return jsonify(fail(CollectError(ErrorCode.NOT_FOUND, "entry not found"))), 404
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for f in sorted(entry_dir.rglob("*")):
            if f.is_file():
                z.write(f, f.relative_to(entry_dir))
    filename = f"{entry_dir.name}.zip"
    from flask import Response
    return Response(
        buf.getvalue(),
        mimetype="application/zip",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{urllib.parse.quote(filename)}"},
    )


@library_bp.route("/entries/<entry_id>/file", methods=["GET"])
@local_access_required
def serve_file(entry_id):
    """按 metadata.files 白名单提供条目文件（§4：路径穿越面为零）。

    前端预览用 sandbox iframe 加载 content.md，脚本不执行。
    """
    from flask import Response, abort
    entry_dir = library.find_entry(entry_id)
    if not entry_dir:
        abort(404)
    rel = request.args.get("path", "")
    meta = state_store.read_json(entry_dir / "metadata.json") or {}
    allowed = {f["path"] for f in meta.get("files", [])}
    if rel not in allowed:
        abort(403)
    file_path = entry_dir / rel
    data = file_path.read_bytes()
    mime = next((f["mime"] for f in meta["files"] if f["path"] == rel), "application/octet-stream")
    if rel.endswith(".md"):
        mime = "text/markdown"
    return Response(data, mimetype=mime,
                    headers={"Content-Security-Policy": "default-src 'none'; sandbox",
                             "X-Content-Type-Options": "nosniff"})
