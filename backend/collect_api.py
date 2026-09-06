"""统一采集 API（设计文档 §7.3/§8）：受令牌/来源白名单保护的新端点。

- POST /api/collect/detect-url   统一链接识别（mp/douyin/bili 已有解析能力，其余平台标记 unsupported）
- POST /api/collect/mp           公众号统一采集（走任务模型，产物落 output/）
- GET  /api/collect/tasks        任务列表（统一任务模型）
- GET  /api/collect/tasks/<id>   任务详情
- POST /api/collect/tasks/<id>/cancel  协作式取消
"""

from __future__ import annotations

from flask import Blueprint, jsonify, request

from backend.core.task_manager import task_manager
from backend.core import urlnorm
from backend.core.errors import CollectError, ErrorCode, envelope, fail, ok
from backend.security import local_access_required

collect_bp = Blueprint("collect", __name__, url_prefix="/api/collect")


@collect_bp.route("/detect-url", methods=["POST"])
@local_access_required
def detect_url():
    body = request.get_json(silent=True) or {}
    url = (body.get("url") or "").strip()
    if not url.startswith("http"):
        return jsonify(fail(CollectError(ErrorCode.INVALID_INPUT, "url is required"))), 400
    platform = _platform_of(url)
    data = {"platform": platform, "canonical_url": urlnorm.normalize_url(url),
            "identity_key": urlnorm.identity_key(url), "platform_item_id": urlnorm.platform_item_id(url)}
    if platform == "generic":
        data["supported"] = False
        return jsonify(envelope(False, "不支持的链接", data,
                                {"code": ErrorCode.UNSUPPORTED_URL, "message": "无法识别该平台",
                                 "retryable": False})), 200
    data["supported"] = True
    return jsonify(ok("链接识别成功", data))


def _platform_of(url: str) -> str:
    try:
        from urllib.parse import urlsplit
        host = urlsplit(url).netloc.lower().removeprefix("www.")
    except ValueError:
        return "generic"
    if host.endswith("mp.weixin.qq.com"):
        return "mp"
    if "bilibili.com" in host or "b23.tv" in host:
        return "bilibili"
    if "douyin.com" in host or "iesdouyin.com" in host:
        return "douyin"
    if "kuaishou.com" in host:
        return "kuaishou"
    if "xiaohongshu.com" in host or "xhslink.com" in host:
        return "xiaohongshu"
    if "channels.weixin.qq.com" in host:
        return "channels"
    return "generic"


@collect_bp.route("/mp", methods=["POST"])
@local_access_required
def collect_mp():
    from backend.collectors.mp import run_mp_collect
    body = request.get_json(silent=True) or {}
    urls = body.get("urls") or []
    if not isinstance(urls, list) or not urls:
        return jsonify(fail(CollectError(ErrorCode.INVALID_INPUT, "urls must be a non-empty list"))), 400

    record, created = task_manager.create("mp", "collect", {"urls": urls}, run_mp_collect,
                                          idempotency_key=body.get("idempotency_key"))
    summary = "任务已创建" if created else "存在进行中的相同任务，已复用"
    return jsonify(ok(summary, {
        "task_id": record["task_id"],
        "idempotency_key": record["idempotency_key"],
        "status": record["status"],
        "created": created,
        "note": "任务提交成功不等于采集成功，请轮询任务状态",
    }))


@collect_bp.route("/tasks", methods=["GET"])
@local_access_required
def list_tasks():
    platform = request.args.get("platform")
    status = request.args.get("status")
    return jsonify(ok("任务列表", {"tasks": task_manager.list_tasks(platform, status)}))


@collect_bp.route("/tasks/<task_id>", methods=["GET"])
@local_access_required
def get_task(task_id):
    rec = task_manager.get(task_id)
    if not rec:
        return jsonify(fail(CollectError(ErrorCode.NOT_FOUND, "task not found"))), 404
    return jsonify(ok("任务状态", {"task": rec}))


@collect_bp.route("/tasks/<task_id>/cancel", methods=["POST"])
@local_access_required
def cancel_task(task_id):
    rec = task_manager.request_cancel(task_id)
    if not rec:
        return jsonify(fail(CollectError(ErrorCode.NOT_FOUND, "task not found"))), 404
    return jsonify(ok("取消请求已受理（协作式取消）", {"task": rec}))
