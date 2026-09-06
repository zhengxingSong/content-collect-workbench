"""公众号爆款文章洞察（借鉴 creator-buddy 的公众号数据获取方式）。

数据来源：第三方公开快照库「公众号爆款文章洞察-SkillHub」（每日收录 10w+ /
低粉爆款 / 原创文章，覆盖昨天至 30 天前）。只读发现类数据源，无需任何登录态，
不经过公众号官方接口，因此不受 mp_admin 200013 频控影响。

返回的每条记录都带完整原文链接（oriUrl / photoId → mp.weixin.qq.com），
可直接进入既有 URL 采集管线（/api/collect/mp）落盘到内容库。

合规：仅个人学习、研究与本地备份用途；互动数据为入库快照，非实时。
"""

from __future__ import annotations

import datetime as dt
import math
import re
from urllib.parse import quote, urlparse

from flask import Blueprint, jsonify, request

mp_hot_bp = Blueprint("mp_hot", __name__)

_API_HOST_PATH = "onetotenvip.com/skill/cozeSkill/getWxCozeSkillData"
_SOURCE = "公众号爆款文章洞察-SkillHub"

_RANKINGS = (
    ("lowPowderExplosiveArticle", "低粉高阅读"),
    ("tenWReadingRank", "阅读靠前"),
    ("originalRank", "原创靠前"),
    ("oneWReadingRank", "数据增长中"),
)

# 借鉴 creator-buddy 的对数尺度加权思路（分享权重最高），但按公众号
# 阅读 10^4-10^6 的量级把权重缩放 1/3，避免头部全部饱和在 100 失去区分度。
# 键与 query_hot_articles 归一化后的 item 字段对应
_SCORE_WEIGHTS = {
    "reads": 6.0, "shares": 7.0, "likes": 5.0, "comments": 5.0,
}


def parse_count(value) -> int:
    """解析 "10w+" / "1.5w" / "267" 等平台计数格式。"""
    if value is None:
        return 0
    if isinstance(value, int):
        return value
    text = str(value).replace("+", "").replace(",", "").strip()
    if not text:
        return 0
    if "w" in text.lower():
        try:
            return int(float(text.lower().replace("w", "")) * 10000)
        except Exception:
            return 0
    try:
        return int(float(text))
    except Exception:
        return 0


def _score_item(item: dict) -> float:
    score = sum(
        math.log10(parse_count(item.get(field)) + 1) * weight
        for field, weight in _SCORE_WEIGHTS.items()
    )
    return round(min(100.0, score), 2)


def _sanitize_url(url) -> str:
    if url is None:
        return ""
    url = str(url).strip()
    if not url or len(url) > 4096:
        return ""
    try:
        if urlparse(url).scheme not in ("http", "https"):
            return ""
    except Exception:
        return ""
    return url


def _fetch_upstream(keyword: str, start_date: str, timeout: int) -> dict:
    params = {"keyword": keyword, "source": _SOURCE}
    if start_date:
        params["startDate"] = start_date
    query = "&".join(f"{quote(str(k))}={quote(str(v))}" for k, v in params.items())
    url = f"https://{_API_HOST_PATH}?{query}"
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "zh-CN,zh;q=0.9",
    }
    last_err = None
    for attempt in range(2):
        try:
            try:
                from curl_cffi import requests as c_req
                resp = c_req.get(url, headers=headers, timeout=timeout, impersonate="chrome")
                if resp.status_code >= 400:
                    raise RuntimeError(f"HTTP {resp.status_code}")
                body = resp.content
            except ImportError:
                import urllib.request
                req = urllib.request.Request(url, headers=headers)
                with urllib.request.urlopen(req, timeout=timeout) as r:
                    body = r.read()
            import json as _json
            data = _json.loads(body.decode("utf-8", errors="ignore"))
            if not isinstance(data.get("data"), dict):
                raise RuntimeError(f"接口返回异常: {data.get('msg') or 'data 字段缺失'}")
            return data["data"]
        except Exception as e:  # noqa: BLE001 - 上游不稳定，吞异常重试一次
            last_err = e
    raise RuntimeError(f"爆款洞察接口请求失败: {last_err}")


def query_hot_articles(keyword: str = "", days: int = 7, max_items: int = 20,
                       timeout: int = 30) -> dict:
    """查询爆款洞察并归一化、评分、去重、排序。keyword 为空 = 全站热门。"""
    keyword = (keyword or "").strip()
    days = max(1, min(int(days or 7), 30))
    max_items = max(1, min(int(max_items or 20), 50))
    start_date = (dt.date.today() - dt.timedelta(days=days)).isoformat()

    raw = _fetch_upstream(keyword, start_date, timeout)

    items: list[dict] = []
    seen: set[str] = set()
    total_before = 0
    for key, label in _RANKINGS:
        for raw_item in raw.get(key) or []:
            total_before += 1
            photo_id = str(raw_item.get("photoId") or "").strip()
            link = _sanitize_url(raw_item.get("oriUrl")) or (
                f"https://mp.weixin.qq.com/s/{photo_id}" if photo_id else "")
            dedup_key = photo_id or link
            if not dedup_key or dedup_key in seen:
                continue
            seen.add(dedup_key)
            title = str(raw_item.get("title") or "").strip()
            summary = str(raw_item.get("summary") or "").strip()
            if not title:
                title = summary[:42] + ("…" if len(summary) > 42 else "")
            item = {
                "category": label,
                "title": title or "无标题",
                "summary": summary[:200],
                "account_name": str(raw_item.get("userName") or raw_item.get("accountName") or "").strip(),
                "fans": str(raw_item.get("fans") or ""),
                "publish_time": str(raw_item.get("publicTime") or ""),
                "link": link,
                "reads": str(raw_item.get("clicksCount") or "0"),
                "likes": parse_count(raw_item.get("likeCount")),
                "shares": parse_count(raw_item.get("shareCount")),
                "comments": parse_count(raw_item.get("useCommentCount") or raw_item.get("commentCount")),
                "watch": str(raw_item.get("watchCount") or "0"),
            }
            item["data_score"] = _score_item(item)
            items.append(item)

    items.sort(key=lambda x: x["data_score"], reverse=True)
    return {
        "keyword": keyword,
        "days": days,
        "start_date": start_date,
        "source": _SOURCE,
        "total_before_dedupe": total_before,
        "items": items[:max_items],
    }


@mp_hot_bp.route("/api/mp-hot/query", methods=["POST"])
def query_hot():
    """查询公众号爆款文章洞察（发现类数据源，免登录）。"""
    data = request.get_json(silent=True) or {}
    try:
        result = query_hot_articles(
            keyword=str(data.get("keyword") or ""),
            days=data.get("days") or 7,
            max_items=data.get("max_items") or 20,
        )
        return jsonify({"success": True, **result})
    except Exception as e:  # noqa: BLE001
        return jsonify({"success": False, "error": str(e)}), 502
