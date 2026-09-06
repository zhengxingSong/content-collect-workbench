"""MCP 资源注册表（设计文档 §7.4）：状态走 Resources，与工具读同一份后端数据。"""

from __future__ import annotations

import json

from . import backend_client
from .tools import CAPABILITIES


def _read_status() -> str:
    try:
        settings = backend_client.call("/api/settings")
        payload = {"success": True, "data": {"backend_ok": True, "settings": settings}}
    except backend_client.BackendUnavailable as e:
        payload = {"success": False, "data": {"backend_ok": False, "message": str(e)}}
    return json.dumps(payload, ensure_ascii=False, indent=2)


def _read_tasks() -> str:
    return json.dumps(backend_client.call("/api/collect/tasks"), ensure_ascii=False, indent=2)


def _read_pending_auth() -> str:
    return json.dumps(backend_client.call("/api/auth-requests/pending"), ensure_ascii=False, indent=2)


def _read_subscriptions() -> str:
    return json.dumps(backend_client.call("/api/rss/subscriptions"), ensure_ascii=False, indent=2)


def _read_capabilities_all() -> str:
    return json.dumps({"platforms": CAPABILITIES}, ensure_ascii=False, indent=2)


def _read_platform_capabilities(uri: str) -> str:
    platform = uri.rsplit("/", 1)[-1]
    cap = CAPABILITIES.get(platform, {})
    return json.dumps({"platform": platform, **cap}, ensure_ascii=False, indent=2)


RESOURCES = [
    ("mp-tools://status", "service_status", "本地各服务健康状态", "application/json", _read_status),
    ("mp-tools://tasks", "collect_tasks", "统一采集任务列表与进度", "application/json", _read_tasks),
    ("mp-tools://auth/pending", "pending_auth_requests", "待人工认证请求（含二维码）", "application/json", _read_pending_auth),
    ("mp-tools://subscriptions", "rss_subscriptions", "公众号 RSS 订阅列表", "application/json", _read_subscriptions),
    ("mp-tools://capabilities", "platform_capabilities", "全平台能力矩阵", "application/json", _read_capabilities_all),
]


def list_resources() -> list[dict]:
    return [{"uri": uri, "name": name, "description": desc, "mimeType": mime}
            for uri, name, desc, mime, _ in RESOURCES]


def read_resource(uri: str) -> dict | None:
    for r_uri, _name, _desc, mime, reader in RESOURCES:
        if r_uri == uri:
            return {"uri": uri, "mimeType": mime, "text": reader()}
    if uri.startswith("mp-tools://capabilities/"):
        platform = uri.rsplit("/", 1)[-1]
        if platform in CAPABILITIES:
            return {"uri": uri, "mimeType": "application/json", "text": _read_platform_capabilities(uri)}
    return None
