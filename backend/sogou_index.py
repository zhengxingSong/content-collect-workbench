"""搜狗微信公开索引通道（Lovstudio 2026-07 方案的实施）。

背景：2026-07-30 起微信关闭了第三方会话的跨号文章列表能力（appmsg /
appmsgpublish 一律 ret=200013）。公开索引（搜狗微信）成为"某公众号近期
文章列表"的现实来源。本模块实现：

1. 搜索结果页解析（文章卡片：标题/摘要/账号/时间戳/跳转链接）；
2. 发布者精确过滤（标题命中关键词不算——同名号/关键词串档是已知坑）；
3. /link 跳转还原（url += 片段拼接；显式 &amp; 替换，防 &times; 实体坑）；
4. 文章页身份提取（sn/biz/js_name），用于 biz 复核与稳定去重身份；
5. 6 小时搜索缓存 + 会话化请求（/link 依赖搜索时种下的 Cookie）。

边界：只有近期文章（非全量历史）；反爬严苛时可能要求验证码——识别后
返回可行动错误而不是硬失败。
"""

from __future__ import annotations

import hashlib
import json
import re
import time
from urllib.parse import quote, urlsplit

from backend.core import state_store
from backend.core.errors import CollectError, ErrorCode

SOGOU_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")
_SOGOU_BASE = "https://weixin.sogou.com"
_CACHE_TTL = 6 * 3600
_CACHE_MAX_ENTRIES = 200

_CARD_RE = re.compile(
    r'<div class="txt-box">.*?<h3>\s*<a[^>]*?href="(?P<link>/link\?url=[^"]+)"[^>]*?'
    r'>(?P<title>.*?)</a>.*?<span class="all-time-y2">(?P<account>.*?)</span>',
    re.S)
_SUMMARY_RE = re.compile(r'<p class="txt-info"[^>]*>(?P<summary>.*?)</p>', re.S)
_TS_RE = re.compile(r"timeConvert\('(\d+)'\)")
_EM_RE = re.compile(r"</?em[^>]*>")
_TAG_RE = re.compile(r"<[^>]+>")
_URL_PARTS_RE = re.compile(r"url \+= '([^']*)'")


def _clean(text: str) -> str:
    return _TAG_RE.sub("", _EM_RE.sub("", text or "")).strip()


def parse_article_cards(html: str) -> list[dict]:
    """解析搜狗文章搜索结果页。纯函数，供离线 fixture 测试。"""
    cards: list[dict] = []
    body = html.split("txt-box", 1)
    if len(body) == 1:
        return cards
    # 以 <li> 为界切分卡片区域
    for m in _CARD_RE.finditer(html):
        card = {
            "title": _clean(m.group("title")),
            "account": _clean(m.group("account")),
            "link": m.group("link"),
        }
        tail = html[m.end():m.end() + 2000]
        sm = _SUMMARY_RE.search(tail)
        if sm:
            card["summary"] = _clean(sm.group("summary"))[:200]
        tm = _TS_RE.search(tail)
        card["publish_ts"] = int(tm.group(1)) if tm else None
        cards.append(card)
    return cards


def filter_by_publisher(cards: list[dict], account_name: str) -> list[dict]:
    """发布者精确匹配过滤（ Lovstudio：索引阶段要求显示名精确一致）。"""
    target = (account_name or "").strip()
    return [c for c in cards if c.get("account", "").strip() == target]


def is_anti_bot_page(html: str) -> bool:
    return ("anti.min.css" in html) or ("verify.css" in html) or ("antispider" in html)


def extract_real_url_from_link_page(html: str) -> str | None:
    """从 /link 响应的 JS 片段拼出真实文章 URL；反爬页返回 None。"""
    if is_anti_bot_page(html):
        return None
    parts = _URL_PARTS_RE.findall(html)
    real = "".join(parts).replace("@", "")
    if not real.startswith("http"):
        return None
    return real


def extract_article_identity(page_html: str) -> dict:
    """从文章页提取稳定身份与发布者：sn（去重身份）、biz（复核）、js_name（账号名）。"""
    sn = re.search(r"sn=([a-f0-9]{32})", page_html)
    biz = (re.search(r'var biz = "([^"]+)"', page_html)
           or re.search(r"var biz = '([^']+)'", page_html))
    name = (re.search(r'id="js_name"[^>]*>\s*(.*?)\s*<', page_html, re.S)
            or re.search(r"var nickname = \"([^\"]+)\"", page_html)
            or re.search(r"var nickname = '([^']+)'", page_html))
    return {
        "sn": sn.group(1) if sn else None,
        "biz": biz.group(1) if biz else None,
        "account_name": _clean(name.group(1)) if name else None,
    }


def _cache_get(key: str):
    cache = state_store.read_json(state_store.STATE_DIR / "sogou_cache.json", {}) or {}
    entry = cache.get(key)
    if not entry:
        return None
    if time.time() - entry["ts"] > _CACHE_TTL:
        return None
    return entry["data"]


def _cache_put(key: str, data: dict) -> None:
    cache = state_store.read_json(state_store.STATE_DIR / "sogou_cache.json", {}) or {}
    cache[key] = {"ts": time.time(), "data": data}
    if len(cache) > _CACHE_MAX_ENTRIES:
        oldest = sorted(cache.items(), key=lambda kv: kv[1]["ts"])[:-_CACHE_MAX_ENTRIES]
        for k, _ in oldest:
            cache.pop(k, None)
    state_store.atomic_write_json(state_store.STATE_DIR / "sogou_cache.json", cache)


def _http_get(session, url: str, referer: str | None = None) -> str:
    headers = {"User-Agent": SOGOU_UA}
    if referer:
        headers["Referer"] = referer
    resp = session.get(url, headers=headers, timeout=20)
    return resp.text if hasattr(resp, "text") else resp.read().decode("utf-8", "ignore")


class _UrllibSession:
    """标准库会话：跨请求保持 Cookie——/link 还原依赖搜索时种下的 SNUID 等。"""

    def __init__(self):
        import http.cookiejar
        import urllib.request
        self._opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def get(self, url: str, headers: dict | None = None, timeout: int = 20) -> str:
        req = urllib.request.Request(url, headers=headers or {})
        return self._opener.open(req, timeout=timeout).read().decode("utf-8", "ignore")


def _make_session():
    try:
        from curl_cffi import requests as c_req
        return c_req.Session(impersonate="chrome")
    except ImportError:
        return _UrllibSession()


def search_articles(account_name: str, limit: int = 10,
                    session=None, *, use_cache: bool = True) -> dict:
    """按公众号名搜近期文章：搜索 → 发布者过滤 → /link 还原。

    返回 {query, items: [{title, account, publish_ts, url}], resolved, failed_resolve}。
    url 为还原后的真实文章页 URL（带签名，需尽快采集）；还原失败时保留
    sogou 链接相对路径并计入 failed_resolve。
    """
    account_name = (account_name or "").strip()
    if not account_name:
        raise CollectError(ErrorCode.INVALID_INPUT, "account_name 不能为空")
    limit = max(1, min(int(limit or 10), 20))
    cache_key = hashlib.sha256(f"sogou:v1:{account_name}:{limit}".encode()).hexdigest()[:24]
    if use_cache:
        cached = _cache_get(cache_key)
        if cached is not None:
            return cached
    session = session or _make_session()

    search_url = f"{_SOGOU_BASE}/weixin?type=2&query={quote(account_name)}"
    try:
        html = _http_get(session, search_url, referer=_SOGOU_BASE + "/")
    except Exception as e:  # noqa: BLE001
        raise CollectError(ErrorCode.SERVICE_UNAVAILABLE, f"搜狗索引请求失败: {e}", retryable=True)

    if is_anti_bot_page(html):
        raise CollectError(ErrorCode.RATE_LIMITED,
                           "搜狗索引触发验证码，请稍后再试或换网络环境", retryable=True)

    cards = filter_by_publisher(parse_article_cards(html), account_name)[:limit]
    items = []
    failed_resolve = 0
    for c in cards:
        full_link = _SOGOU_BASE + c["link"].replace("&amp;", "&")
        url = None
        try:
            link_html = _http_get(session, full_link, referer=_SOGOU_BASE + "/")
            url = extract_real_url_from_link_page(link_html)
        except Exception:  # noqa: BLE001
            url = None
        if not url:
            failed_resolve += 1
            url = full_link  # 降级：保留搜狗链接，调用方可自行处理
        items.append({
            "title": c["title"], "account": c["account"],
            "publish_ts": c.get("publish_ts"), "url": url,
        })
        time.sleep(0.8)  # 温和限速
    result = {
        "query": account_name,
        "items": items,
        "resolved": len(items) - failed_resolve,
        "failed_resolve": failed_resolve,
        "note": "搜狗索引仅提供近期文章（非全量历史）；签名 URL 有时效，请尽快采集",
    }
    _cache_put(cache_key, result)
    return result
