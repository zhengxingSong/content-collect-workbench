"""URL 规范化与平台内容 ID 提取（设计文档 §11，urlnorm-v1）。

原则：
- 原始 URL 永久保留；规范化 URL 仅用于身份判断，不替代下载地址；
- 按平台维护参数规则，不做全局一刀切；
- 优先提取平台原生内容 ID 作为身份依据；
- hash 算法带版本号（nchash-v1），规则演进不破坏历史条目。
"""

from __future__ import annotations

import hashlib
import re
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

RULES_VERSION = "urlnorm-v1"
NCHASH_VERSION = "nchash-v1"

# 各平台：身份保留参数（白名单，其余全部剥离）；未列出的平台用通用剥离规则
_KEEP_PARAMS: dict[str, set[str]] = {
    "bilibili": {"p"},          # 分P
    "douyin": set(),
    "kuaishou": set(),
    "xiaohongshu": {"xsec_token"},  # 小红书部分接口取数需要，仅作为身份时剥离但在 extra 保留原始链接
}

# 通用跟踪参数：任何平台都剥离
_STRIP_ALWAYS = {
    "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
    "spm", "spm_id_from", "from_spm_id", "share_token", "share_app_id",
    "chksm", "chksm2", "scene", "scene2", "snscene", "wechat_share",
    "isappinstalled", "appinstall", "pd", "share_token_key",
    "from", "from_page", "refer_from", "share_source", "share_medium",
}

_MP_S_RE = re.compile(r"^/s/([A-Za-z0-9_-]+)")
_BV_RE = re.compile(r"(BV[0-9A-Za-z]{10})")
_DY_ID_RE = re.compile(r"/(?:video|note|slides)/(\d+)")
_KS_ID_RE = re.compile(r"/short-video/([0-9a-fA-Za-z]+)|shortVideo\.html\?[^#]*photoId=([\w-]+)")
_XHS_ID_RE = re.compile(r"/explore/([0-9a-fA-F]{24})|/discovery/item/([0-9a-fA-F]{24})")


def _platform_of(host: str) -> str:
    host = host.lower().removeprefix("www.")
    if host.endswith(("mp.weixin.qq.com",)):
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


def normalize_url(url: str) -> str:
    """规范化 URL（身份判断用）：剥通用跟踪参数 + 平台白名单参数，其余原样保留。"""
    try:
        parts = urlsplit(url.strip())
    except ValueError:
        return url
    if not parts.netloc:
        return url
    platform = _platform_of(parts.netloc)
    keep = _KEEP_PARAMS.get(platform, set())
    qs = [
        (k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True)
        if k in keep or k not in _STRIP_ALWAYS
    ]
    query = urlencode(qs)
    return urlunsplit((parts.scheme.lower(), parts.netloc.lower(), parts.path, query, ""))


def platform_item_id(url: str) -> str | None:
    """从 URL 提取平台原生内容 ID；短链等无法提取的返回 None（退回规范化 URL 作身份）。"""
    try:
        parts = urlsplit(url.strip())
    except ValueError:
        return None
    host = parts.netloc.lower()
    platform = _platform_of(host)
    if platform == "mp":
        m = _MP_S_RE.match(parts.path)
        return f"mp:{m.group(1)}" if m else None
    if platform == "bilibili":
        m = _BV_RE.search(url)
        if m:
            return f"bili:{m.group(1)}"
        m = re.search(r"^/av(\d+)", parts.path, re.I)
        return f"bili:av{m.group(1)}" if m else None
    if platform == "douyin":
        m = _DY_ID_RE.search(parts.path)
        return f"dy:{m.group(1)}" if m else None
    if platform == "kuaishou":
        m = _KS_ID_RE.search(url)
        if m:
            return f"ks:{m.group(1) or m.group(2)}"
        return None
    if platform == "xiaohongshu":
        m = _XHS_ID_RE.search(parts.path)
        if m:
            return f"xhs:{m.group(1) or m.group(2)}"
        return None
    return None


def identity_key(url: str) -> str:
    """条目身份键（§10.3）：平台+平台内容ID 优先；否则规范化 URL。"""
    pid = platform_item_id(url)
    if pid:
        return f"pid:{pid}"
    return f"url:{normalize_url(url)}"


def nchash(text: str) -> str:
    """nchash-v1：仅做语义安全的空白归一化后取 sha256（§11.4）。"""
    normalized = re.sub(r"\s+", " ", (text or "").strip())
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()
