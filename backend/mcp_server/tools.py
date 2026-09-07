"""MCP 工具注册表（设计文档 §7.3）。统一响应契约 + image content 支持。"""

from __future__ import annotations

import json

from . import backend_client
from . import __version__

# ── 能力矩阵（§7.2，与文档同步维护） ──────────────────────
CAPABILITIES = {
    "mp": {
        "display_name": "微信公众号",
        "operations": ["download_single", "download_range", "collect", "subscriptions", "rss", "hot_articles"],
        "auth": {"method": "qrcode", "channel": "mp_admin_scan", "qr_source": "backend_direct"},
        "environment": [],
        "incremental": "rss_scheduler",
    },
    "bili": {
        "display_name": "哔哩哔哩",
        "operations": ["download_single", "download_batch", "download_user"],
        "auth": {"method": "qrcode_or_cookie", "channel": "backend_qrcode_api", "qr_source": "backend_direct"},
        "environment": ["ffmpeg"],
        "mcp_ready": True, "note": "M6 已接入基础操作",
    },
    "channels": {
        "display_name": "微信视频号",
        "operations": ["download_single", "download_user", "favorites"],
        "auth": {"method": "cookie", "channel": "web_acquisition"},
        "environment": ["mitm_proxy", "ca_certificate"],
        "incremental": "followed_authors",
        "mcp_ready": True, "note": "M6 已接入解析与下载；代理/证书管理仅 Web（系统级变更）",
    },
    "douyin": {
        "display_name": "抖音",
        "operations": ["download_single", "download_user", "download_liked", "collections", "live"],
        "auth": {"method": "qrcode", "channel": "playwright_window", "qr_source": "needs_adaptation"},
        "environment": ["signature_service"],
        "mcp_ready": True, "note": "M6 已接入基础操作；收藏/直播等高级操作见 Web",
    },
    "ks": {
        "display_name": "快手",
        "operations": ["download_single", "download_user"],
        "auth": {"method": "qrcode", "channel": "playwright_window", "qr_source": "needs_adaptation"},
        "mcp_ready": True, "note": "M6 已接入基础操作",
    },
    "xhs": {
        "display_name": "小红书",
        "operations": ["download_single", "download_user"],
        "auth": {"method": "qrcode_or_sms", "channel": "playwright_window", "qr_source": "needs_adaptation"},
        "mcp_ready": True, "note": "M6 已接入基础操作",
    },
    "bili": {
        "display_name": "哔哩哔哩",
        "operations": ["download_single", "download_batch", "download_user"],
        "auth": {"method": "qrcode_or_cookie", "channel": "backend_qrcode_api", "qr_source": "backend_direct"},
        "environment": ["ffmpeg"],
        "mcp_ready": False, "note": "M6 接入",
    },
}


def _text(value) -> list[dict]:
    return [{"type": "text", "text": json.dumps(value, ensure_ascii=False, indent=2)}]


# ── 工具处理函数 ─────────────────────────────────────────

def tool_service_status(args: dict) -> list[dict]:
    from backend.core import state_store
    info = state_store.read_json(state_store.SERVICE_FILE, {}) or {}
    try:
        settings = backend_client.call("/api/settings")
        return _text({"success": True, "summary": "后端服务可用",
                      "data": {"backend": settings.get("backend_port", info.get("backend_port")),
                               "backend_pid": info.get("pid"), "mcp_version": __version__},
                      "error": None})
    except backend_client.BackendUnavailable as e:
        return _text({"success": False, "summary": "后端服务不可用",
                      "data": {}, "error": {"code": "SERVICE_UNAVAILABLE",
                                            "message": str(e), "retryable": True}})


def tool_platform_capabilities(args: dict) -> list[dict]:
    platform = (args.get("platform") or "").strip()
    if platform:
        cap = CAPABILITIES.get(platform)
        if not cap:
            return _text(_err("INVALID_INPUT", f"unknown platform: {platform}"))
        return _text({"success": True, "summary": cap["display_name"],
                      "data": {"platform": platform, **cap}, "error": None})
    return _text({"success": True, "summary": "平台能力矩阵",
                  "data": {"platforms": CAPABILITIES}, "error": None})


def tool_detect_url(args: dict) -> list[dict]:
    return _text(backend_client.call("/api/collect/detect-url", "POST",
                                     {"url": args.get("url", "")}))


def tool_mp_collect(args: dict) -> list[dict]:
    payload = {"urls": args.get("urls") or []}
    if args.get("idempotency_key"):
        payload["idempotency_key"] = args["idempotency_key"]
    return _text(backend_client.call("/api/collect/mp", "POST", payload, timeout=30))


def tool_collect_task_status(args: dict) -> list[dict]:
    return _text(backend_client.call(f"/api/collect/tasks/{args['task_id']}"))


def tool_collect_task_cancel(args: dict) -> list[dict]:
    return _text(backend_client.call(f"/api/collect/tasks/{args['task_id']}/cancel", "POST", {}))


def tool_collect_task_retry_failed(args: dict) -> list[dict]:
    return _text(backend_client.call(f"/api/collect/tasks/{args['task_id']}/retry-failed", "POST", {}))


def tool_mp_download_single(args: dict) -> list[dict]:
    """旧归档路径（data/articles_full，保留排版）。注意：提交成功≠采集成功。"""
    return _text(backend_client.call("/api/articles/download-url", "POST",
                                     {"urls": args.get("urls") or []}))


def tool_mp_task_status(args: dict) -> list[dict]:
    return _text(backend_client.call(f"/api/articles/download-status/{args['task_id']}"))


def tool_mp_list_accounts(args: dict) -> list[dict]:
    status = backend_client.call("/api/mp-admin/status")
    return _text({"success": True, "summary": status.get("message", "公众号后台凭证状态"),
                  "data": {"logged_in": status.get("logged_in"),
                           "credential_valid": status.get("credential_valid"),
                           "nickname": status.get("nickname")}, "error": None})


def tool_mp_start_auth(args: dict) -> list[dict]:
    resp = backend_client.call("/api/auth-requests/start", "POST",
                               {"platform": "mp_admin", "refresh": bool(args.get("refresh"))})
    data = resp.get("data") or {}
    content = _text(resp)
    qr_image = (data.get("qr_image") or data.get("request", {}).get("qr_image", "")) \
        if isinstance(data, dict) else ""
    if isinstance(data, dict) and data.get("qr_image"):
        b64 = data["qr_image"].split(",", 1)[-1]
        content.append({"type": "image", "data": b64, "mimeType": "image/png"})
    return content


def tool_mp_check_auth(args: dict) -> list[dict]:
    return _text(backend_client.call(f"/api/auth-requests/check/{args['auth_id']}"))


def tool_library_list(args: dict) -> list[dict]:
    qs = []
    if args.get("platform"):
        qs.append("platform=" + str(args["platform"]))
    if args.get("date"):
        qs.append("date=" + str(args["date"]))
    return _text(backend_client.call("/api/library/entries" + ("?" + "&".join(qs) if qs else "")))


def tool_library_get(args: dict) -> list[dict]:
    return _text(backend_client.call(f"/api/library/entries/{args['entry_id']}"))


def tool_library_export(args: dict) -> list[dict]:
    return _text(backend_client.call("/api/library/export", "POST",
                                     {"entry_ids": args.get("entry_ids") or [],
                                      "dest": args.get("dest", "")}))


def tool_subscriptions_list(args: dict) -> list[dict]:
    return _text(backend_client.call("/api/rss/subscriptions"))


def tool_subscriptions_add(args: dict) -> list[dict]:
    return _text(backend_client.call("/api/rss/subscriptions", "POST", {
        "fakeid": args.get("fakeid", ""), "nickname": args.get("nickname", ""),
        "interval_minutes": args.get("interval_minutes", 60)}))


def tool_subscriptions_remove(args: dict) -> list[dict]:
    return _text(backend_client.call(f"/api/rss/subscriptions/{args['fakeid']}", "DELETE"))


def _err(code: str, message: str, retryable: bool = False) -> dict:
    return {"success": False, "summary": message, "data": {},
            "error": {"code": code, "message": message, "retryable": retryable}}


# ── 工具定义（name → JSON Schema + handler） ─────────────

TOOLS = [
    ("service_status", "检查本地后端服务是否可用", {"type": "object", "properties": {}, "additionalProperties": False}, tool_service_status),
    ("platform_capabilities", "查询平台能力矩阵（先发现能力再发起操作）",
     {"type": "object", "properties": {"platform": {"type": "string", "enum": list(CAPABILITIES)}}, "additionalProperties": False}, tool_platform_capabilities),
    ("collect_detect_url", "统一链接识别：返回平台、规范化 URL 与平台内容 ID",
     {"type": "object", "properties": {"url": {"type": "string"}}, "required": ["url"], "additionalProperties": False}, tool_detect_url),
    ("mp_collect", "微信公众号统一采集：正文归一化 + 媒体本地化，产物落 output/ 内容库。返回 task_id，请轮询 collect_task_status（上限 50 条/次）",
     {"type": "object", "properties": {"urls": {"type": "array", "items": {"type": "string"}},
                                        "idempotency_key": {"type": "string"}},
      "required": ["urls"], "additionalProperties": False}, tool_mp_collect),
    ("collect_task_status", "查询统一采集任务状态（含分条目结果）",
     {"type": "object", "properties": {"task_id": {"type": "string"}}, "required": ["task_id"], "additionalProperties": False}, tool_collect_task_status),
    ("collect_task_cancel", "请求取消任务（协作式，不保证瞬时停止）",
     {"type": "object", "properties": {"task_id": {"type": "string"}}, "required": ["task_id"], "additionalProperties": False}, tool_collect_task_cancel),
    ("collect_task_retry_failed", "仅重试统一采集任务失败条目，不重复处理成功/已存在条目",
     {"type": "object", "properties": {"task_id": {"type": "string"}}, "required": ["task_id"], "additionalProperties": False}, tool_collect_task_retry_failed),
    ("mp_download_single", "公众号文章离线归档（保留原排版，产物在 data/articles_full）。提交成功不等于采集成功",
     {"type": "object", "properties": {"urls": {"type": "array", "items": {"type": "string"}}},
      "required": ["urls"], "additionalProperties": False}, tool_mp_download_single),
    ("mp_task_status", "查询 mp_download_single 归档任务进度",
     {"type": "object", "properties": {"task_id": {"type": "string"}}, "required": ["task_id"], "additionalProperties": False}, tool_mp_task_status),
    ("mp_list_accounts", "查看公众号采集通道（mp_admin）认证状态",
     {"type": "object", "properties": {}, "additionalProperties": False}, tool_mp_list_accounts),
    ("mp_start_auth", "发起公众号后台管理员扫码认证（官方通道）：返回二维码图片，请在有效期内扫码",
     {"type": "object", "properties": {"refresh": {"type": "boolean"}}, "additionalProperties": False}, tool_mp_start_auth),
    ("mp_check_auth", "查询认证请求状态（只读；expired 时请重新 mp_start_auth）",
     {"type": "object", "properties": {"auth_id": {"type": "string"}}, "required": ["auth_id"], "additionalProperties": False}, tool_mp_check_auth),
    ("library_list", "浏览 output/ 内容库条目",
     {"type": "object", "properties": {"platform": {"type": "string"}, "date": {"type": "string"}},
      "additionalProperties": False}, tool_library_list),
    ("library_get", "读取内容库条目元数据",
     {"type": "object", "properties": {"entry_id": {"type": "string"}}, "required": ["entry_id"], "additionalProperties": False}, tool_library_get),
    ("library_export", "导出条目为自包含标准产物（含 sha256 校验）",
     {"type": "object", "properties": {"entry_ids": {"type": "array", "items": {"type": "string"}},
                                        "dest": {"type": "string"}},
      "required": ["entry_ids", "dest"], "additionalProperties": False}, tool_library_export),
    ("mp_subscriptions_list", "列出公众号 RSS 订阅",
     {"type": "object", "properties": {}, "additionalProperties": False}, tool_subscriptions_list),
    ("mp_subscriptions_add", "添加公众号 RSS 订阅（定时自动采集）",
     {"type": "object", "properties": {"fakeid": {"type": "string"}, "nickname": {"type": "string"},
                                        "interval_minutes": {"type": "integer", "default": 60}},
      "required": ["fakeid", "nickname"], "additionalProperties": False}, tool_subscriptions_add),
    ("mp_subscriptions_remove", "移除公众号 RSS 订阅",
     {"type": "object", "properties": {"fakeid": {"type": "string"}}, "required": ["fakeid"], "additionalProperties": False}, tool_subscriptions_remove),
]

TOOL_MAP = {name: (schema, handler) for name, _, schema, handler in TOOLS}

# M6：其余平台工具映射（platform_tools.py），合并进同一注册表
from .platform_tools import PLATFORM_TOOLS  # noqa: E402
TOOL_MAP.update({name: (schema, handler) for name, _, schema, handler in PLATFORM_TOOLS})


def list_tools() -> list[dict]:
    all_tools = TOOLS + PLATFORM_TOOLS
    return [{"name": name, "description": desc, "inputSchema": schema}
            for name, desc, schema, _ in all_tools]


def call_tool(name: str, args: dict) -> tuple[list[dict], bool]:
    entry = TOOL_MAP.get(name)
    if not entry:
        return _text(_err("INVALID_INPUT", f"Unknown tool: {name}")), True
    _, handler = entry
    try:
        return handler(args or {}), False
    except backend_client.BackendUnavailable as e:
        return _text(_err("SERVICE_UNAVAILABLE", str(e), retryable=True)), True
    except Exception as e:
        return _text(_err("INTERNAL", str(e))), True
