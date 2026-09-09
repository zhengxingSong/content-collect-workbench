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


def _preview_video_page(entry_id: str, entry_dir):
    """视频/音频条目预览页:内嵌播放器 + 逐文件下载链接,零脚本。"""
    import html as html_mod
    meta = library.get_entry(entry_id) or {}
    title = meta.get("title") or entry_dir.name
    files = meta.get("files") or []
    media = [f for f in files if str(f.get("path", "")).lower().endswith((".mp4", ".webm", ".mp3", ".m4a"))]
    others = [f for f in files if f not in media]
    if not media:
        return jsonify(fail(CollectError(ErrorCode.NOT_FOUND, "无可预览内容"))), 404

    def furl(p):
        return f"/api/library/entries/{entry_id}/file?path={urllib.parse.quote(p)}"

    def fmt_size(n):
        n = int(n or 0)
        return f"{n / 1073741824:.2f} GB" if n > 1073741824 else f"{n / 1048576:.1f} MB"

    parts = []
    for f in media:
        p = f["path"]
        is_audio = p.lower().endswith((".mp3", ".m4a"))
        tag = "audio" if is_audio else "video"
        parts.append(f"""
        <section style="margin:0 0 26px">
          <h3 style="font-size:15px;margin:0 0 8px">{html_mod.escape(p.rsplit('/', 1)[-1])}
            <span style="color:#888;font-weight:400;font-size:12px"> · {fmt_size(f.get('size'))}</span></h3>
          <{tag} controls preload="metadata" style="width:100%;max-width:960px;border-radius:10px;background:#000"
            src="{furl(p)}"></{tag}>
          <div style="margin-top:6px"><a style="color:#2dd98a" href="{furl(p)}" download>下载此文件</a></div>
        </section>""")
    if others:
        lis = "".join(
            f'<li><a style="color:#2dd98a" href="{furl(f["path"])}" download>{html_mod.escape(f["path"])}</a>'
            f' <span style="color:#888">({fmt_size(f.get("size"))})</span></li>' for f in others)
        parts.append(f'<section><h3 style="font-size:14px">其他文件({len(others)})</h3><ul style="line-height:1.9">{lis}</ul></section>')

    page = f"""<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>{html_mod.escape(title)}</title></head>
    <body style="margin:0;background:#0b0e14;color:#e9ecf2;font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif">
    <div style="max-width:980px;margin:0 auto;padding:28px 20px 60px">
      <h1 style="font-size:20px;line-height:1.45;margin:0 0 6px">{html_mod.escape(title)}</h1>
      <div style="color:#888;font-size:12.5px;margin-bottom:24px">
        {html_mod.escape((meta.get('author') or {}).get('name', '') if isinstance(meta.get('author'), dict) else str(meta.get('author') or ''))}
        · 共 {len(media)} 个媒体文件 · {len(files)} 个文件
        {f" · <a style='color:#2dd98a' href='https://www.bilibili.com/video/{meta.get('bvid')}' target='_blank' rel='noopener'>原址</a>" if meta.get('bvid') else ''}
      </div>
      {''.join(parts)}
    </div></body></html>"""
    from flask import Response
    return Response(page, mimetype="text/html",
                    headers={"Content-Security-Policy": "default-src 'none'; media-src 'self'; img-src 'self'; style-src 'unsafe-inline'; sandbox allow-same-origin",
                             "X-Content-Type-Options": "nosniff"})


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
        return _preview_video_page(entry_id, entry_dir)

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


@library_bp.route("/entries/<entry_id>/files", methods=["GET"])
def list_entry_files(entry_id):
    """递归列出条目目录内文件(相对路径+大小),供前端资源浏览器使用"""
    entry_dir = library.find_entry(entry_id)
    if not entry_dir:
        return jsonify(fail(CollectError(ErrorCode.NOT_FOUND, "entry not found"))), 404
    files = []
    for fp in sorted(entry_dir.rglob("*")):
        if fp.is_file():
            try:
                files.append({
                    "path": fp.relative_to(entry_dir).as_posix(),
                    "size": fp.stat().st_size,
                })
            except OSError:
                continue
    return jsonify(ok("文件列表", {
        "entry_id": entry_id, "dir": str(entry_dir),
        "files": files, "total": len(files),
    }))


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
    if not meta.get("files"):
        # B站等平台下载目录无 metadata.json:用合成条目(目录扫描)作为白名单
        meta = library.get_entry(entry_id) or {}
    allowed = {f["path"] for f in meta.get("files", [])}
    if rel not in allowed:
        abort(403)
    file_path = entry_dir / rel
    mime = next((f.get("mime") for f in meta.get("files", []) if f.get("path") == rel), None)
    if not mime:
        import mimetypes
        mime = mimetypes.guess_type(rel)[0] or "application/octet-stream"
    if rel.endswith(".md"):
        mime = "text/markdown"
    try:
        data = file_path.read_bytes()
    except FileNotFoundError:
        abort(404)
    # Range 支持:浏览器拖动进度条/按需加载必须(大视频不全量进内存响应)
    range_header = request.headers.get("Range")
    if range_header and mime.startswith(("video/", "audio/")):
        import re as _re
        m = _re.match(r"bytes=(\d*)-(\d*)$", range_header)
        if m:
            total = len(data)
            start = int(m.group(1)) if m.group(1) else 0
            end = int(m.group(2)) if m.group(2) else min(start + 4 * 1048576, total - 1)
            end = min(end, total - 1)
            if start > end or start >= total:
                return Response(status=416, headers={"Content-Range": f"bytes */{total}"})
            chunk = data[start:end + 1]
            return Response(chunk, status=206, mimetype=mime, headers={
                "Content-Range": f"bytes {start}-{end}/{total}",
                "Accept-Ranges": "bytes",
                "X-Content-Type-Options": "nosniff"})
    return Response(data, mimetype=mime,
                    headers={"Accept-Ranges": "bytes",
                             "Content-Security-Policy": "default-src 'none'; sandbox",
                             "X-Content-Type-Options": "nosniff"})
