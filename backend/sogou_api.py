"""搜狗公开索引通道的 HTTP 端点（Web 用）。"""

from __future__ import annotations

from flask import Blueprint, jsonify, request

from backend.core.errors import CollectError, ErrorCode, fail, ok
from backend.security import local_access_required
from backend.sogou_index import search_articles

sogou_bp = Blueprint("sogou", __name__, url_prefix="/api/sogou")


@sogou_bp.route("/search", methods=["POST"])
@local_access_required
def search():
    """按公众号名搜索近期文章（搜狗公开索引，免登录）。

    返回的 url 是带签名的真实文章页链接，有时效——提交采集请尽快。
    """
    body = request.get_json(silent=True) or {}
    name = (body.get("account_name") or "").strip()
    limit = body.get("limit") or 10
    if not name:
        return jsonify(fail(CollectError(ErrorCode.INVALID_INPUT, "account_name 不能为空"))), 400
    if len(name) > 60:
        return jsonify(fail(CollectError(ErrorCode.INVALID_INPUT, "account_name 过长"))), 400
    try:
        result = search_articles(name, limit=limit)
        return jsonify(ok(f"搜狗索引返回 {len(result['items'])} 条", result))
    except CollectError as e:
        return jsonify(fail(e)), (429 if e.code == ErrorCode.RATE_LIMITED else 502)
