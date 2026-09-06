"""内容库 HTTP 端点（设计文档 §12）。供 Web 与 MCP 工具共用。"""

from __future__ import annotations

import urllib.parse

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
    return jsonify(ok("条目列表", {"entries": library.list_entries(platform, date)}))


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
