"""RSS 订阅管理端点（设计文档 §7.3 订阅工具的 HTTP 后端）。

直接调用现有 RssScheduler，不重复实现逻辑。
"""

from __future__ import annotations

from flask import Blueprint, jsonify, request

from backend.core.errors import CollectError, ErrorCode, fail, ok
from backend.security import local_access_required
from backend.rss_scheduler import rss_scheduler

rss_api_bp = Blueprint("rss_api", __name__, url_prefix="/api/rss")


@rss_api_bp.route("/subscriptions", methods=["GET"])
@local_access_required
def list_subscriptions():
    return jsonify(ok("订阅列表", {"subscriptions": rss_scheduler.get_subscriptions()}))


@rss_api_bp.route("/subscriptions", methods=["POST"])
@local_access_required
def add_subscription():
    body = request.get_json(silent=True) or {}
    fakeid = (body.get("fakeid") or "").strip()
    nickname = (body.get("nickname") or "").strip()
    interval = body.get("interval_minutes", 60)
    if not fakeid or not nickname:
        return jsonify(fail(CollectError(ErrorCode.INVALID_INPUT,
                                         "fakeid and nickname are required"))), 400
    sub = rss_scheduler.subscribe(fakeid, nickname, int(interval))
    return jsonify(ok("订阅已添加", {"subscription": sub}))


@rss_api_bp.route("/subscriptions/<fakeid>", methods=["DELETE"])
@local_access_required
def remove_subscription(fakeid):
    removed = rss_scheduler.unsubscribe(fakeid)
    if not removed:
        return jsonify(fail(CollectError(ErrorCode.NOT_FOUND, "subscription not found"))), 404
    return jsonify(ok("订阅已移除", {"fakeid": fakeid}))
