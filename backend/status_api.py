"""聚合状态端点（设计文档 §13 仪表盘 / §15 就绪分层）。

GET /api/status：后端、MCP、RSS 调度器、代理、FFmpeg、内容库规模一次性返回。
"""

from __future__ import annotations

import json
import time
import urllib.request

from flask import Blueprint, jsonify

from backend.core import state_store
from backend.security import local_access_required

status_bp = Blueprint("status", __name__, url_prefix="/api")

_started_at = time.time()


def _probe_mcp(port: int) -> dict:
    # Docker 模式：backend 容器内 127.0.0.1 不是 mcp 容器，用 MCP_HEALTH_URL 覆盖
    import os
    url = os.environ.get("MCP_HEALTH_URL") or f"http://127.0.0.1:{port}/health"
    try:
        with urllib.request.urlopen(url, timeout=0.8) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return {"ok": True, "version": data.get("version"), "port": port}
    except Exception as e:
        return {"ok": False, "error": str(e)[:120], "port": port}


@status_bp.route("/status", methods=["GET"])
@local_access_required
def get_status():
    from backend.config import get_settings
    from backend.rss_scheduler import rss_scheduler

    settings = get_settings()
    mcp_port = int(settings.get("mcp_port") or 3333)

    scheduler_running = bool(rss_scheduler._thread and rss_scheduler._thread.is_alive())

    library_count = 0
    try:
        from backend.library import list_entries
        library_count = len(list_entries())
    except Exception:
        pass

    ffmpeg_ok = None
    try:
        import shutil
        ffmpeg_ok = bool(shutil.which("ffmpeg"))
    except Exception:
        ffmpeg_ok = False

    token_info = state_store.read_json(state_store.SERVICE_FILE, {}) or {}

    return jsonify({
        "backend": {"ok": True, "uptime_seconds": round(time.time() - _started_at),
                    "pid": token_info.get("pid")},
        "mcp": _probe_mcp(mcp_port),
        "scheduler": {"ok": scheduler_running, "subscriptions": len(rss_scheduler.get_subscriptions())},
        "ffmpeg": {"ok": ffmpeg_ok},
        "library": {"entries": library_count},
        "time": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    })
