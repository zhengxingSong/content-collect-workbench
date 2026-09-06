"""统一认证请求服务（设计文档 §9）。

- 每个 平台+目标 最多一个活跃 AuthRequest；重复 start 返回既有请求；
- 状态机 pending -> scanned -> confirmed | expired | cancelled | failed；
- check 只读；二维码刷新由显式 start 触发，刷新预算默认 3 次 / 10 分钟；
- 二维码以 data URL（segno PNG）交付，认证成功不向 agent 返回原始凭证；
- mp_admin：公众号后台管理员扫码（官方通道）；微信读书适配器已随上游接口下线移除。
"""

from __future__ import annotations

import base64
import io
import threading
import time
import uuid

from flask import Blueprint, jsonify, request

from backend.core.errors import CollectError, ErrorCode, envelope, fail, ok

auth_requests_bp = Blueprint("auth_requests", __name__, url_prefix="/api/auth-requests")

QR_TTL_SECONDS = 180
REFRESH_BUDGET = 3
BUDGET_WINDOW = 10 * 60

_lock = threading.Lock()
_requests: dict[str, dict] = {}   # id -> record


def _qr_data_url(text: str) -> str:
    import segno
    buf = io.BytesIO()
    segno.make(text, error="m").save(buf, kind="png", scale=6, border=2)
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


def _active(platform: str) -> dict | None:
    for r in _requests.values():
        if r["platform"] == platform and r["status"] in {"pending", "scanned"}:
            if time.time() < r["expire_at"]:
                return r
            r["status"] = "expired"
    return None


# ── 平台适配器：mp ────────────────────────────────────────

# ── 平台适配器：mp_admin（公众号后台管理员扫码，2026-09-06 新通道） ──

def _mp_admin_start() -> dict:
    """发起公众号后台扫码，等待二维码截图就绪（最长 ~25s）。"""
    from backend import mp_admin_login as m
    m.login()
    qr = ""
    deadline = time.time() + 25
    while time.time() < deadline:
        state = m._state
        with m._lock:
            st = state.get("status")
            qr = state.get("qr_image", "")
        if qr:
            return {"qr_image": qr, "message": "请使用公众号管理员微信扫码并确认登录"}
        if st == "failed":
            raise CollectError(ErrorCode.ENV_NOT_READY, state.get("message") or "二维码获取失败")
        time.sleep(0.5)
    raise CollectError(ErrorCode.ENV_NOT_READY, "二维码获取超时，请稍后重试", retryable=True)


def _mp_admin_check() -> dict:
    from backend import mp_admin_login as m
    with m._lock:
        st = m._state.get("status")
        msg = m._state.get("message", "")
    if st == "success":
        return {"status": "confirmed", "message": msg}
    if st == "failed":
        return {"status": "failed", "message": msg}
    if st == "scanning":
        return {"status": "pending", "message": msg}
    return {"status": "pending", "message": msg or "等待扫码"}


_PLATFORMS = {"mp_admin": {"start": _mp_admin_start, "check": _mp_admin_check}}


# ── 服务函数（供 MCP 工具层与 Web 共用） ─────────────────

def start_auth(platform: str, refresh: bool = False) -> dict:
    adapter = _PLATFORMS.get(platform)
    if not adapter:
        raise CollectError(ErrorCode.INVALID_INPUT, f"unsupported platform: {platform}")

    with _lock:
        existing = _active(platform)
        if existing and not refresh:
            return _public(existing)
        if existing and refresh:
            first = existing["created_at"]
            if existing["refresh_count"] >= REFRESH_BUDGET:
                raise CollectError(ErrorCode.QUOTA_EXCEEDED,
                                   f"刷新次数已达预算（{REFRESH_BUDGET} 次），请稍后再试")
            if time.time() - first > BUDGET_WINDOW:
                raise CollectError(ErrorCode.QUOTA_EXCEEDED, "认证会话时间预算已用尽，请重新发起")
            existing["status"] = "cancelled"  # 旧请求出列
        refresh_count = (existing["refresh_count"] + 1) if (existing and refresh) else 0

    info = adapter["start"]()
    now = time.time()
    record = {
        "id": f"ar_{uuid.uuid4().hex[:10]}",
        "platform": platform,
        "status": "pending",
        "created_at": now,
        "expire_at": now + QR_TTL_SECONDS,
        "refresh_count": refresh_count,
        "message": info.get("message", ""),
        "account_hint": None,
    }
    if info.get("qr_image"):
        # 适配器已产出 data URL（如 mp_admin 页面截图）
        record["qr_content"] = ""
        record["qr_image"] = info["qr_image"]
    else:
        record["qr_content"] = info["qr_content"]
        record["qr_image"] = _qr_data_url(info["qr_content"])
    with _lock:
        _requests[record["id"]] = record
    return _public(record)


def _sync(rec: dict) -> None:
    """pending 状态下向平台适配器同步一次真实登录状态（check/pending 共用）。"""
    if rec["status"] in {"pending", "scanned"}:
        adapter = _PLATFORMS[rec["platform"]]
        result = adapter["check"]()
        if result["status"] in {"confirmed", "failed"}:
            rec["status"] = result["status"]
            rec["message"] = result.get("message", rec["message"])
        elif result["status"] == "scanned":
            rec["status"] = "scanned"
            rec["message"] = result.get("message", "")


def check_auth(auth_id: str) -> dict:
    """只读；不隐式创建新二维码（§9.3）。"""
    with _lock:
        rec = _requests.get(auth_id)
        if not rec:
            raise CollectError(ErrorCode.NOT_FOUND, "auth request not found")
        if rec["status"] in {"pending", "scanned"} and time.time() > rec["expire_at"]:
            rec["status"] = "expired"
        _sync(rec)
    return _public(rec, with_image=False)


def list_pending() -> list[dict]:
    with _lock:
        for r in list(_requests.values()):
            if r["status"] in {"pending", "scanned"} and time.time() > r["expire_at"]:
                r["status"] = "expired"
            _sync(r)   # 仪表盘轮询时同步平台真实状态（扫码成功即出列）
        return [_public(r) for r in _requests.values() if r["status"] in {"pending", "scanned"}]


def cancel_auth(auth_id: str) -> dict:
    with _lock:
        rec = _requests.get(auth_id)
        if not rec:
            raise CollectError(ErrorCode.NOT_FOUND, "auth request not found")
        rec["status"] = "cancelled"
        if rec["platform"] == "mp":
            from backend import auth as mp_auth
            mp_auth._set_login_state("idle", "登录已取消")
        return _public(rec)


def _public(rec: dict, with_image: bool = True) -> dict:
    out = {k: rec[k] for k in
           ("id", "platform", "status", "created_at", "expire_at",
            "refresh_count", "message", "account_hint")}
    if with_image and rec.get("qr_image"):
        out["qr_image"] = rec["qr_image"]   # data URL，供 MCP image content / Web 展示
    return out


# ── HTTP 端点（Web 兜底认证用；MCP 工具走同两函数） ───────

@auth_requests_bp.route("/start", methods=["POST"])
def api_start():
    body = request.get_json(silent=True) or {}
    try:
        return jsonify(ok("认证请求已就绪", start_auth((body.get("platform") or "mp_admin").strip(),
                                                      bool(body.get("refresh")))))
    except CollectError as e:
        return jsonify(fail(e)), 200


@auth_requests_bp.route("/check/<auth_id>", methods=["GET"])
def api_check(auth_id):
    try:
        return jsonify(ok("认证状态", check_auth(auth_id)))
    except CollectError as e:
        return jsonify(fail(e)), 200


@auth_requests_bp.route("/pending", methods=["GET"])
def api_pending():
    return jsonify(ok("待认证请求", {"requests": list_pending()}))


@auth_requests_bp.route("/cancel/<auth_id>", methods=["POST"])
def api_cancel(auth_id):
    try:
        return jsonify(ok("已取消", cancel_auth(auth_id)))
    except CollectError as e:
        return jsonify(fail(e)), 200
