"""本地服务安全模型（设计文档 §4）——新增端点的统一准入。

准入规则（满足其一）：
1. Authorization: Bearer <token> 与 state/service.json 中的服务令牌匹配；
2. 同源浏览器请求：Origin/Referer 的 host 与请求 Host 一致（127.0.0.1/localhost）。

Host 校验：始终要求 Host 为 127.0.0.1/localhost（防 DNS rebinding）。
局限：同用户权限下的恶意进程无法仅凭令牌防御（文档已声明为接受残余风险）。
"""

from __future__ import annotations

import functools

from flask import request, jsonify

from backend.core import state_store
from backend.core.errors import envelope

_LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1", "[::1]"}


def _host_ok() -> bool:
    host = (request.host or "").split(":")[0]
    return host in _LOCAL_HOSTS


def _bearer_ok() -> bool:
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        return False
    token = state_store.load_service_token()
    return bool(token) and auth[7:] == token


def _origin_ok() -> bool:
    for header in ("Origin", "Referer"):
        value = request.headers.get(header)
        if not value:
            continue
        from urllib.parse import urlsplit
        try:
            origin_host = urlsplit(value).netloc.split(":")[0]
        except ValueError:
            continue
        request_host = (request.host or "").split(":")[0]
        if origin_host in _LOCAL_HOSTS and origin_host == request_host:
            return True
    return False


def local_access_required(fn):
    """Blueprint 路由装饰器：令牌或同源放行，其余 403。

    Host 规则：本机 Host 直接放行；非本机 Host（Docker 容器间调用，如
    mcp→backend 的 Host=服务名）必须持有效服务令牌——与 app.py 全局守卫
    保持同一规则，避免全局放行后被蓝图层再次拒绝（UAT 2026-09-08）。
    GET/HEAD（只读）仅需 Host 校验；POST/PUT/DELETE（写操作）必须持令牌
    或同源 Origin（CSRF 防护）。
    """

    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        if not _host_ok() and not _bearer_ok():
            return jsonify(envelope(False, "非法 Host", None,
                                    {"code": "SERVICE_UNAVAILABLE", "message": "invalid Host header",
                                     "retryable": False})), 403
        if request.method in ("GET", "HEAD") or _bearer_ok() or _origin_ok():
            return fn(*args, **kwargs)
        return jsonify(envelope(False, "未授权访问", None,
                                {"code": "AUTH_REQUIRED", "message": "missing or invalid local token",
                                 "retryable": False})), 403

    return wrapper
