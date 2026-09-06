"""
公众号管理模块
搜索、收藏、管理公众号列表
"""

import re
import time
import requests as req
from flask import Blueprint, jsonify, request

from backend.config import ACCOUNTS_FILE, load_json, save_json

accounts_bp = Blueprint("accounts", __name__, url_prefix="/api/accounts")


def is_legacy_fakeid(fakeid: str) -> bool:
    """判断是否为需要剔除的旧格式标识。

    - 微信读书通道的 mpId（MP_WXS_ 前缀等）：剔除（通道已失效）
    - 官方 mp 后台的 fakeid（base64 形态，如 MjM5ODYwMjI2MA==，以 = 结尾是正常的）：
      保留——2026-09-06 切换官方通道后这是唯一合法形态
    """
    if not fakeid:
        return True
    fid = str(fakeid).strip()
    if fid.startswith("MP_WXS_"):
        return True
    if re.fullmatch(r"[A-Za-z0-9+/]{6,}={0,2}", fid):
        return False
    return True


def _load_accounts() -> list:
    """加载已收藏的公众号列表（自动剔除旧版不兼容的 fakeid 记录）"""
    raw_accounts = load_json(ACCOUNTS_FILE, [])
    if not isinstance(raw_accounts, list):
        return []
    valid_accounts = [a for a in raw_accounts if isinstance(a, dict) and not is_legacy_fakeid(a.get("fakeid"))]
    if len(valid_accounts) != len(raw_accounts):
        save_json(ACCOUNTS_FILE, valid_accounts)
    return valid_accounts


def _save_accounts(accounts: list):
    """保存公众号列表"""
    save_json(ACCOUNTS_FILE, accounts)


@accounts_bp.route("", methods=["GET"])
def list_accounts():
    """获取已收藏的公众号列表"""
    accounts = _load_accounts()
    return jsonify({"accounts": accounts, "total": len(accounts)})


@accounts_bp.route("/search", methods=["POST"])
def search_accounts():
    """搜索/解析公众号（2026-09-06 改版）：
    - 粘贴文章链接：解析公开文章页提取 biz(fakeid)/昵称（无需任何认证）
    - 输入名称：走公众号后台官方 searchbiz 接口（需 mp_admin 扫码认证）
    """
    data = request.get_json() or {}
    keyword = data.get("keyword", "").strip()
    if not keyword:
        return jsonify({"error": "请输入公众号名称或文章链接"}), 400

    is_url = keyword.startswith("http://") or keyword.startswith("https://")

    if is_url:
        # 公开文章页本地解析 biz（微信读书 wxs2mp 通道已失效）
        try:
            from curl_cffi import requests as c_req
            resp = c_req.get(keyword, impersonate="chrome", timeout=25)
            html = resp.content.decode("utf-8", errors="replace")
            import re as _re
            m_biz = _re.search(r'var biz = "([^"]+)"', html)
            m_nick = (_re.search(r'var nickname = "([^"]+)"', html)
                      or _re.search(r'id="js_name"[^>]*>\s*([^<]+?)\s*<', html))
            m_avatar = _re.search(r'var (?:cdn_url|headimg) = "([^"]+)"', html)
            if not m_biz:
                return jsonify({"error": "未能从文章页解析出公众号 ID（页面可能已删除或非普通文章）"}), 404
            item = {
                "fakeid": m_biz.group(1),
                "nickname": (m_nick.group(1) if m_nick else "").strip(),
                "alias": "",
                "round_head_img": (m_avatar.group(1) if m_avatar else "").replace("\x0a", ""),
                "signature": "",
                "service_type": 1,
            }
            return jsonify({"results": [item], "total": 1})
        except Exception as e:
            return jsonify({"error": f"文章页解析失败: {str(e)[:100]}"}), 500

    # 名称搜索：公众号后台官方 searchbiz
    try:
        from backend.mp_admin_login import mp_admin_get
        data_biz = mp_admin_get("/cgi-bin/searchbiz", {
            "action": "search_biz", "begin": 0, "count": 10, "query": keyword,
        })
    except RuntimeError as e:
        if "mp_admin_not_configured" in str(e):
            return jsonify({"error": "尚未认证公众号后台：请到仪表盘点「公众号后台扫码认证」"}), 401
        return jsonify({"error": str(e)}), 500
    except PermissionError as e:
        return jsonify({"error": str(e)}), 401

    results = []
    for item in data_biz.get("list") or []:
        if isinstance(item, dict) and item.get("fakeid"):
            results.append({
                "fakeid": item.get("fakeid"),
                "nickname": item.get("nickname", ""),
                "alias": item.get("alias", ""),
                "round_head_img": item.get("round_head_img", ""),
                "signature": item.get("signature", ""),
                "service_type": item.get("service_type", 0),
            })
    return jsonify({"results": results, "total": len(results)})


@accounts_bp.route("", methods=["POST"])
def add_account():
    """添加公众号到收藏（若已存在同名旧账号，自动升级其 mpId）"""
    data = request.get_json() or {}
    fakeid = data.get("fakeid", "").strip()
    nickname = data.get("nickname", "").strip()

    if not fakeid or not nickname:
        return jsonify({"error": "fakeid 和 nickname 不能为空"}), 400

    accounts = _load_accounts()

    # 1. 检查 fakeid 是否完全一致
    for acc in accounts:
        if acc.get("fakeid") == fakeid:
            return jsonify({"error": "该公众号已在收藏中"}), 400

    # 2. 同名旧账号：更新其 fakeid（历史数据兼容）
    for acc in accounts:
        if acc.get("nickname") == nickname:
            acc["fakeid"] = fakeid
            if data.get("round_head_img"):
                acc["round_head_img"] = data.get("round_head_img")
            if data.get("signature"):
                acc["signature"] = data.get("signature")
            acc["updated_time"] = time.time()
            _save_accounts(accounts)
            return jsonify({"message": "已更新同名公众号的 fakeid", "account": acc})

    new_account = {
        "fakeid": fakeid,
        "nickname": nickname,
        "alias": data.get("alias", ""),
        "round_head_img": data.get("round_head_img", ""),
        "signature": data.get("signature", ""),
        "service_type": data.get("service_type", 0),
        "added_time": time.time(),
    }

    accounts.append(new_account)
    _save_accounts(accounts)

    return jsonify({"message": "添加成功", "account": new_account})


@accounts_bp.route("/<fakeid>", methods=["DELETE"])
def remove_account(fakeid):
    """从收藏中删除公众号"""
    accounts = _load_accounts()
    new_accounts = [a for a in accounts if a.get("fakeid") != fakeid]

    if len(new_accounts) == len(accounts):
        return jsonify({"error": "未找到该公众号"}), 404

    _save_accounts(new_accounts)
    return jsonify({"message": "删除成功"})


@accounts_bp.route("/<fakeid>", methods=["PUT"])
def update_account(fakeid):
    """更新公众号信息"""
    data = request.get_json() or {}
    accounts = _load_accounts()

    for acc in accounts:
        if acc.get("fakeid") == fakeid:
            for key in ["nickname", "alias", "signature", "round_head_img"]:
                if key in data:
                    acc[key] = data[key]
            _save_accounts(accounts)
            return jsonify({"message": "更新成功", "account": acc})

    return jsonify({"error": "未找到该公众号"}), 404


@accounts_bp.route("/<fakeid>/rss-subscribe", methods=["POST"])
def rss_subscribe(fakeid):
    """开启 RSS 自动抓取订阅"""
    from backend.rss_scheduler import rss_scheduler

    data = request.get_json() or {}
    interval = data.get("interval_minutes", 60)

    # 从已收藏列表中查找公众号信息
    accounts = _load_accounts()
    account = None
    for acc in accounts:
        if acc.get("fakeid") == fakeid:
            account = acc
            break

    if not account:
        return jsonify({"error": "请先收藏该公众号"}), 404

    nickname = account.get("nickname", fakeid)
    sub = rss_scheduler.subscribe(fakeid, nickname, interval)

    immediate_fetch = rss_scheduler.is_in_fetch_window()
    if immediate_fetch:
        # 提交到线程池立即抓取，让 RSS 马上有内容
        rss_scheduler.submit_fetch(sub)

    message = f"已开启 RSS 订阅: {nickname}"
    if not immediate_fetch:
        message += "，当前不在采集时间段内，将在时间段内自动抓取"
    return jsonify({"message": message, "subscription": sub, "immediate_fetch": immediate_fetch})


@accounts_bp.route("/<fakeid>/rss-subscribe", methods=["DELETE"])
def rss_unsubscribe(fakeid):
    """关闭 RSS 自动抓取订阅"""
    from backend.rss_scheduler import rss_scheduler

    removed = rss_scheduler.unsubscribe(fakeid)
    if not removed:
        return jsonify({"error": "该公众号未订阅 RSS"}), 404

    return jsonify({"message": "已取消 RSS 订阅"})


@accounts_bp.route("/rss-subscriptions", methods=["GET"])
def rss_subscriptions():
    """获取所有 RSS 订阅状态（待上传/已隔离数实时从下载历史派生，保证单一事实来源）"""
    from backend.rss_scheduler import rss_scheduler
    from backend.config import load_json, DOWNLOAD_HISTORY_FILE

    subs = rss_scheduler.get_subscriptions()
    history = load_json(DOWNLOAD_HISTORY_FILE, [])
    for sub in subs:
        nickname = sub.get("nickname", "")
        sub["pending_upload_count"] = rss_scheduler.count_pending(history, nickname)
        sub["quarantined_count"] = rss_scheduler.count_quarantined(history, nickname)
    return jsonify({"subscriptions": subs})


@accounts_bp.route("/rss-upload-log", methods=["GET"])
def rss_upload_log():
    """获取 RSS 上传审计日志（最近若干次上传记录）"""
    from backend.rss_scheduler import rss_scheduler

    limit = request.args.get("limit", default=30, type=int)
    account = request.args.get("account") or None
    log = rss_scheduler.get_upload_log(limit=limit, account=account)
    return jsonify({"log": log})


@accounts_bp.route("/<fakeid>/rss-force-upload", methods=["POST"])
def rss_force_upload(fakeid):
    """强制上传该公众号所有待上传 + 历史未上传文章"""
    from backend.rss_scheduler import rss_scheduler
    from backend.accounts import accounts_bp as _a
    import threading

    sub = rss_scheduler.get_subscription(fakeid)
    if not sub or not sub.get("enabled"):
        return jsonify({"error": "该公众号未开启 RSS 订阅"}), 404

    nickname = sub.get("nickname", "")
    result = rss_scheduler.force_upload_all(nickname)

    # 同步更新订阅的上传状态
    with rss_scheduler._lock:
        subs = rss_scheduler.get_subscriptions()
        for s in subs:
            if s.get("fakeid") == fakeid:
                if result.get("attempted"):
                    s["last_upload_time"] = time.time()
                    s["last_upload_count"] = result.get("count", 0)
                s["last_upload_error"] = result.get("error")
                s["pending_upload_count"] = result.get("pending_count", 0)
                s["quarantined_count"] = result.get("quarantined", 0)
                s["last_upload_attempted"] = result.get("attempted", False)
                s["last_upload_disabled"] = result.get("disabled", False)
                break
        rss_scheduler._save_subscriptions(subs)

    return jsonify(result)
