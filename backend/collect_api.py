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
    from urllib.parse import urlsplit
    if urlsplit(url).scheme not in ("http", "https") or not urlsplit(url).hostname:
        return jsonify(fail(CollectError(ErrorCode.INVALID_INPUT, "仅支持 http/https 链接"))), 400
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


def _hostname(url: str) -> str:
    """从 URL 提取纯 hostname：剔除 userinfo(:@)、端口(:port)、IPv6 括号与结尾点。"""
    from urllib.parse import urlsplit
    try:
        netloc = urlsplit(url).netloc.lower()
    except ValueError:
        return ""
    if "@" in netloc:
        netloc = netloc.rsplit("@", 1)[1]
    # IPv6 字面量如 [::1]:5200
    if netloc.startswith("["):
        end = netloc.find("]")
        return netloc[1:end] if end != -1 else ""
    host = netloc.split(":", 1)[0]
    host = host.lstrip(".").rstrip(".")
    return host


def _matches(host: str, *domains: str) -> bool:
    """精确域名或点边界子域匹配（evilbilibili.com 不会命中 bilibili.com）。"""
    return any(host == d or host.endswith("." + d) for d in domains)


def _platform_of(url: str) -> str:
    host = _hostname(url)
    if not host:
        return "generic"
    if _matches(host, "mp.weixin.qq.com"):
        return "mp"
    if _matches(host, "bilibili.com", "b23.tv"):
        return "bilibili"
    if _matches(host, "douyin.com", "iesdouyin.com"):
        return "douyin"
    if _matches(host, "kuaishou.com"):
        return "kuaishou"
    if _matches(host, "xiaohongshu.com", "xhslink.com"):
        return "xiaohongshu"
    if _matches(host, "channels.weixin.qq.com"):
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

    try:
        record, created = task_manager.create("mp", "collect", {"urls": urls}, run_mp_collect,
                                              idempotency_key=body.get("idempotency_key"))
    except CollectError as e:
        return jsonify(fail(e)), 429 if e.code == ErrorCode.QUOTA_EXCEEDED else 400
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


@collect_bp.route("/tasks/<task_id>/retry-failed", methods=["POST"])
@local_access_required
def retry_failed_task(task_id):
    """仅重试原任务失败条目，不重复处理成功/跳过项。"""
    from backend.collectors.mp import run_mp_collect
    original = task_manager.get(task_id)
    if not original:
        return jsonify(fail(CollectError(ErrorCode.NOT_FOUND, "task not found"))), 404
    if original.get("platform") != "mp" or original.get("kind") != "collect":
        return jsonify(fail(CollectError(ErrorCode.INVALID_INPUT, "当前仅支持重试 mp collect 任务"))), 400
    try:
        rec, created, count = task_manager.retry_failed(task_id, run_mp_collect)
    except CollectError as e:
        return jsonify(fail(e)), 429 if e.code == ErrorCode.QUOTA_EXCEEDED else 400
    if not count:
        return jsonify(fail(CollectError(ErrorCode.INVALID_INPUT, "原任务没有可重试的失败条目"))), 400
    return jsonify(ok("失败条目重试任务已创建" if created else "失败条目重试任务已复用", {
        "task_id": rec["task_id"], "status": rec["status"], "created": created,
        "retry_of": task_id, "retry_count": count,
    }))
