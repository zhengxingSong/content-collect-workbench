"""mp（微信公众号）统一采集器：走统一任务模型，产物落 output/（设计文档 §8/§10）。

复用现有 downloader/articles 的抓取与解析能力，data/ 目录保持不动。
"""

from __future__ import annotations

import re
import shutil
import tempfile
import time
from pathlib import Path

from backend import library
from backend.core.errors import CollectError, ErrorCode
from backend.core.urlnorm import normalize_url, platform_item_id
from backend.core.task_manager import TaskContext

MAX_URLS_PER_TASK = 50          # §8.3 显式列表上限
MAX_MEDIA_PER_ENTRY = 50
MEDIA_FETCH_TIMEOUT = 30


def run_mp_collect(ctx: TaskContext) -> None:
    """TaskManager runner：抓取公众号文章 → 归一化 → 原子提交 output/。"""
    urls = ctx.params.get("urls") or []
    if not isinstance(urls, list) or not urls:
        raise CollectError(ErrorCode.INVALID_INPUT, "urls must be a non-empty list")
    if len(urls) > MAX_URLS_PER_TASK:
        raise CollectError(ErrorCode.QUOTA_EXCEEDED,
                           f"urls limited to {MAX_URLS_PER_TASK} per task",
                           detail={"limit": MAX_URLS_PER_TASK})

    from backend.downloader import (extract_article_content, find_mmbiz_urls,
                                    download_resource, sanitize, get_ext)

    ctx.report(total=len(urls), done=0, failed=0, skipped=0)
    tmp_media = Path(tempfile.mkdtemp(prefix="mp_collect_"))
    try:
        _run_urls(ctx, urls, tmp_media,
                  extract_article_content, find_mmbiz_urls, download_resource,
                  sanitize, get_ext)
    finally:
        shutil.rmtree(tmp_media, ignore_errors=True)


def _fetch_full_page(url: str) -> str:
    """抓完整文章页（显式 UTF-8 解码；fetch_article_detail_content 返回的是正文片段，缺元数据）。"""
    from curl_cffi import requests as c_req
    resp = c_req.get(url, impersonate="chrome", timeout=25)
    if resp.status_code != 200:
        raise RuntimeError(f"HTTP {resp.status_code}")
    return resp.content.decode("utf-8", errors="replace")


# 微信风控/错误页特征：这些页面返回 200 且有内容，但不是文章，绝不能入库
_BLOCKED_PAGE_MARKERS = (
    "环境异常",
    "参数错误",
    "完成验证后即可继续访问",
    "该内容已被发布者删除",
    "此内容因违规无法查看",
)


def _detect_blocked_page(raw_html: str) -> str | None:
    """返回风控/错误页类型描述；正常文章页返回 None。

    先认文章标记（正文可能提及"环境异常"等词，不能只看关键词），
    再查错误页特征，最后兜底空壳页。
    """
    has_article_marker = ('var msg_title' in raw_html or 'id="activity-name"' in raw_html
                          or 'id="js_content"' in raw_html)
    if has_article_marker:
        return None
    for marker in _BLOCKED_PAGE_MARKERS:
        if marker in raw_html:
            return marker
    # 壳页：无文章标记也无错误文案的挑战页
    return "空壳页（微信环境校验未通过）"


def _run_urls(ctx, urls, tmp_media: Path,
              extract_article_content, find_mmbiz_urls, download_resource,
              sanitize, get_ext) -> None:
    for url in urls:
        ctx.check_cancel()
        url = (url or "").strip()
        if not url.startswith("http"):
            ctx.item(url, "failed", "不是有效的链接（需以 http/https 开头）")
            continue

        try:
            # 微信对同一短链会间歇性返回挑战页（UAT 2026-09-08 实测：连续抓取
            # 交替出现正常页/空壳页）。命中守卫先重试再判失败，避免随机误杀。
            raw_html = ""
            blocked = None
            for attempt in range(3):
                raw_html = _fetch_full_page(url)
                if raw_html and not _detect_blocked_page(raw_html):
                    blocked = None
                    break
                blocked = _detect_blocked_page(raw_html) or "empty page"
                if attempt < 2:
                    time.sleep(2.5)
            if blocked:
                ctx.item(url, "failed",
                         f"微信拦截页（{blocked}）：服务端抓取被环境校验拦下（已重试 2 次）。"
                         f"稍后在浏览器打开原文复制短链重试，或直接重试本条")
                continue

            content_html = extract_article_content(raw_html)
            title = _extract_title(raw_html)
            # 无效页守卫：微信"参数错误/被删除"页 title 与正文皆空
            if not title and len(content_html.strip()) < 80:
                ctx.item(url, "failed", "页面无效（文章可能已被删除或链接错误）")
                continue

            from backend.core.html2md import html_to_markdown
            content_md = html_to_markdown(content_html)

            # 媒体本地化（图片/音频/视频），失败记入 failed_items 不阻断
            media_specs: list[dict] = []
            failed_media: list[str] = []
            for idx, murl in enumerate(list(find_mmbiz_urls(content_html))[:MAX_MEDIA_PER_ENTRY]):
                ctx.check_cancel()
                ext = get_ext(murl) or "dat"
                if not ext.startswith("."):
                    ext = "." + ext
                name = f"img_{idx:03d}_{sanitize(Path(murl.split('?')[0]).name or 'media', 40)}{ext}"
                target_dir = tmp_media / f"e_{hashlib4(url)}"
                target_dir.mkdir(parents=True, exist_ok=True)
                target = target_dir / name
                try:
                    if download_resource(murl, target):
                        media_specs.append({"src_path": str(target), "name": name, "source_url": murl})
                    else:
                        failed_media.append(murl)
                except Exception:
                    failed_media.append(murl)

            stable_id = _stable_item_id(url, raw_html)

            entry = library.commit_entry("mp", {
                "platform_item_id": stable_id,
                "source_url": url,
                "content_type": "article",
                "title": title,
                "author": _extract_author(raw_html),
                "publish_time": _extract_publish_time(raw_html),
                "content_md": content_md,
                "content_html": content_html,
                "content_text": content_md,
                "media_paths": media_specs,
                "warnings": [f"{len(failed_media)} 个媒体资源下载失败（保留远程链接）"] if failed_media else [],
                "failed_items": [{"key": m, "reason": "media download failed"} for m in failed_media],
                "extra": {"canonical_url": normalize_url(url)},
            })
            if entry["deduped"]:
                ctx.item(url, "skipped", "duplicate content", entry_id=entry["entry_id"])
            else:
                ctx.item(url, "succeeded", entry_id=entry["entry_id"])
                _append_download_history(url, title, entry, content_md)
        except CollectError:
            raise
        except Exception as e:
            ctx.item(url, "failed", str(e)[:200])


def _stable_item_id(url: str, raw_html: str) -> str | None:
    """稳定内容身份：短链用 token；签名查询形态（搜狗还原链接等）URL 里没有
    稳定 ID，从页面内嵌的 sn= 提取——保证同一文章重复解析不重复入库。"""
    pid = platform_item_id(url)
    if pid:
        return pid
    m = re.search(r"sn=([a-f0-9]{32})", raw_html)
    return f"mp:{m.group(1)}" if m else None


def _append_download_history(url: str, title: str, entry: dict, content_md: str) -> None:
    """同步一条记录到旧版下载历史（data/download_history.json），保持 #history 页面可用。"""
    try:
        from backend.config import DOWNLOAD_HISTORY_FILE, load_json, save_json
        history = load_json(DOWNLOAD_HISTORY_FILE, []) or []
        entry_dir = entry.get("dir", "")
        history.insert(0, {
            "title": title or "(无标题)",
            "link": url,
            "account": "公众号采集",
            "success": True,
            "time": time.time(),
            "error": None,
            "path": entry_dir,
            "cover_url": "",
            "digest": (content_md or "")[:120],
            "publish_time": int(time.time()),
        })
        save_json(DOWNLOAD_HISTORY_FILE, history[:500])
    except Exception as e:
        print(f"[mp_collect] 下载历史写入失败(不影响采集): {e}")


def hashlib4(text: str) -> str:
    import hashlib
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:12]


def _extract_title(raw_html: str) -> str:
    import re
    m = re.search(r'<meta property="og:title" content="([^"]+)"', raw_html)
    if m:
        return m.group(1)
    m = re.search(r"<title>([^<]+)</title>", raw_html)
    return (m.group(1) if m else "").strip()


def _extract_author(raw_html: str) -> dict:
    import re
    m = re.search(r'<meta property="og:article:author" content="([^"]+)"', raw_html)
    name = m.group(1) if m else None
    if not name:
        m = re.search(r'id="js_name"[^>]*>\s*([^<]+?)\s*<', raw_html)
        name = m.group(1) if m else ""
    return {"name": name or "", "id": "", "url": ""}


def _extract_publish_time(raw_html: str) -> str | None:
    import re
    m = re.search(r'var ct = "?(\d{10})"?', raw_html)
    if m:
        return time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(int(m.group(1))))
    m = re.search(r"createTime = '([^']+)'", raw_html)
    return m.group(1) if m else None
