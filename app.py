#!/usr/bin/env python3
"""
微信公众号文章下载管理工具 — 桌面端应用
Flask 后端 + Web 前端

启动方式：
    python3 app.py              # 默认启动（浏览器模式）
    python3 app.py --port 5100  # 指定端口
"""

import os
import sys

def ensure_virtualenv():
    """检测当前是否运行在虚拟环境 venv312 中。
    如果不是，并且检测到本地存在 venv312，则自动使用 venv312 的 python 解释器重载当前脚本！
    """
    if getattr(sys, 'frozen', False):
        return
    project_root = os.path.dirname(os.path.abspath(__file__))
    if sys.platform == 'win32':
        venv_python = os.path.join(project_root, 'venv312', 'Scripts', 'python.exe')
    else:
        venv_python = os.path.join(project_root, 'venv312', 'bin', 'python')
    if os.path.exists(venv_python):
        current_exe = os.path.abspath(sys.executable)
        target_exe = os.path.abspath(venv_python)
        if current_exe != target_exe:
            print(f"[Env Auto-Switch] 检测到虚拟环境，正在自动切换至: {venv_python}", flush=True)
            args = [venv_python] + sys.argv
            os.execv(venv_python, args)

ensure_virtualenv()

import argparse
import webbrowser
import threading
from pathlib import Path


from flask import Flask, send_from_directory
from flask_cors import CORS

from backend.runtime import configure_runtime, resource_dir

configure_runtime()

from backend.config import ensure_dirs
from backend.accounts import accounts_bp
from backend.articles import articles_bp
from backend.proxy import proxy_bp
from backend.douyin import douyin_bp
from backend.douyin_login import douyin_login_bp
from backend.douyin_auth import douyin_auth_bp
from backend.kuaishou import kuaishou_bp
from backend.kuaishou_auth import kuaishou_auth_bp
from backend.channels import channels_bp
from backend.transcode import transcode_bp
from backend.xiaohongshu import xhs_bp
from backend.xiaohongshu_login import xhs_login_bp
from backend.bilibili import bilibili_bp
from backend.bilibili_login import bilibili_login_bp
from backend.updater import updater_bp
from backend.collect_api import collect_bp
from backend.auth_requests import auth_requests_bp
from backend.library_api import library_bp
from backend.rss_api import rss_api_bp
from backend.status_api import status_bp
from backend.mp_admin_login import mp_admin_bp
from backend.mp_hot import mp_hot_bp
from backend.sogou_api import sogou_bp

# ── Flask 应用 ────────────────────────────────────────────
static_folder_path = resource_dir() / "frontend"

app = Flask(
    __name__,
    static_folder=str(static_folder_path),
    static_url_path="",
)
# §4：CORS 显式白名单（仅本机来源），杜绝任意网页跨域读取本地 API
CORS(app, origins=r"http://(127\.0\.0\.1|localhost)(:\d+)?")

# §4：全局 Host 校验（防 DNS rebinding）
_LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1", "[::1]"}

@app.before_request
def _enforce_local_boundary():
    from flask import request, jsonify
    host = (request.host or "").split(":")[0]
    if host in _LOCAL_HOSTS:
        return None
    # Docker 模式：容器间调用（mcp→backend）Host 为服务名，凭有效服务令牌放行
    # （外部攻击者拿不到令牌，DNS rebinding 防护不受影响）
    from backend.security import _bearer_ok
    if _bearer_ok():
        return None
    return jsonify({"error": "invalid Host header"}), 403

# 注册蓝图
app.register_blueprint(accounts_bp)
app.register_blueprint(articles_bp)
app.register_blueprint(proxy_bp)
app.register_blueprint(douyin_bp)
app.register_blueprint(douyin_login_bp)
app.register_blueprint(douyin_auth_bp)
app.register_blueprint(kuaishou_bp)
app.register_blueprint(kuaishou_auth_bp)
app.register_blueprint(channels_bp)
app.register_blueprint(transcode_bp)
app.register_blueprint(xhs_bp)
app.register_blueprint(xhs_login_bp)
app.register_blueprint(bilibili_bp)
app.register_blueprint(bilibili_login_bp)
app.register_blueprint(updater_bp)
app.register_blueprint(collect_bp)
app.register_blueprint(auth_requests_bp)
app.register_blueprint(library_bp)
app.register_blueprint(rss_api_bp)
app.register_blueprint(status_bp)
app.register_blueprint(mp_admin_bp)
app.register_blueprint(mp_hot_bp)
app.register_blueprint(sogou_bp)


# ── M0+ 契约层初始化：state/ 目录、服务令牌、任务恢复 ──────
BACKEND_PORT = int(os.environ.get("WECHAT_MP_PORT", "5200"))
from backend.core import state_store
state_store.ensure_dirs()
# 启动自愈：校验 state/*.json 可解析（损坏回滚 .bak）、清理残留 .tmp
for _p in state_store.validate_state_dir():
    print(f"[state] {_p}", flush=True)
state_store.ensure_service_token(BACKEND_PORT)
# 存量明文凭证迁移：就地加密 mp_admin cookie/token（仅首次启动时写一次）
try:
    from backend.config import DATA_DIR
    from backend.core.credential_store import protect_credential_file
    if protect_credential_file(DATA_DIR / "mp_admin_config.json", ("cookie", "token")):
        print("[state] 已迁移 mp_admin 凭证为加密存储", flush=True)
except Exception as _e:  # noqa: BLE001 - 迁移失败不阻塞启动
    print(f"[state] mp_admin 凭证加密迁移失败（可忽略，下次登录会再加密）: {_e}", flush=True)
from backend.core.task_manager import task_manager
task_manager.recover()
from backend.library import LIBRARY_DIR
LIBRARY_DIR.mkdir(parents=True, exist_ok=True)

# 启动 RSS 自动抓取调度器
from backend.rss_scheduler import rss_scheduler
rss_scheduler.start()



# ── 前端路由 ──────────────────────────────────────────────

@app.route("/favicon.ico")
def favicon():
    return ("", 204)

@app.route("/")
def serve_index():
    """SPA 主页面"""
    return send_from_directory(app.static_folder, "index.html")


@app.route("/<path:path>")
def serve_static(path):
    """静态文件"""
    file_path = Path(app.static_folder) / path
    if file_path.exists():
        return send_from_directory(app.static_folder, path)
    # SPA fallback
    return send_from_directory(app.static_folder, "index.html")


# ── 应用设置 API ──────────────────────────────────────────

@app.route("/api/settings", methods=["GET"])
def get_settings():
    from backend.config import get_settings as _get
    from flask import jsonify
    return jsonify(_get())


@app.route("/api/local/token", methods=["GET"])
def local_token():
    """返回本机服务令牌,供 SPA 附到后续请求(本地单用户工具;仅本机 Host 可达)。"""
    from backend.core import state_store
    from backend.security import _host_ok
    from flask import jsonify
    if not _host_ok():
        return jsonify({"error": "非本机请求"}), 403
    tok = state_store.load_service_token()
    return jsonify({"token": tok or "", "ok": bool(tok)})


@app.route("/api/settings", methods=["POST"])
def save_settings():
    from backend.config import get_settings as _get, save_settings as _save
    from flask import request, jsonify
    data = request.get_json() or {}
    settings = _get()
    settings.update(data)
    _save(settings)
    return jsonify({"message": "设置已保存"})


# ── 启动 ──────────────────────────────────────────────────

def open_browser(port: int):
    """延迟 1 秒后打开浏览器"""
    import time
    time.sleep(1)
    webbrowser.open(f"http://localhost:{port}")


def main():
    parser = argparse.ArgumentParser(description="微信公众号文章下载管理工具")
    parser.add_argument("--port", type=int, default=5200, help="服务端口 (默认 5200)")
    parser.add_argument("--host", type=str, default="127.0.0.1", help="监听地址")
    parser.add_argument("--no-browser", action="store_true", help="不自动打开浏览器")
    parser.add_argument("--debug", action="store_true", help="调试模式")
    args = parser.parse_args()

    ensure_dirs()

    print()
    print("=" * 56)
    print("  📱 微信公众号文章下载管理工具")
    print(f"  🌐 http://{args.host}:{args.port}")
    print("=" * 56)
    print()

    if not args.no_browser:
        threading.Thread(target=open_browser, args=(args.port,), daemon=True).start()

    try:
        app.run(
            host=args.host,
            port=args.port,
            debug=args.debug,
            threaded=True,
        )
    finally:
        try:
            from backend.mitm_proxy import ProxyManager
            ProxyManager.get_instance().stop()
        except Exception as ep:
            print(f"Error stopping Channels proxy on shutdown: {ep}")



if __name__ == "__main__":
    main()
