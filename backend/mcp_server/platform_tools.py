"""M6：其余平台的 MCP 工具映射（设计文档 §7.3/§16）。

机械映射到现有平台端点，不重复实现业务。响应统一包装为业务契约。
不暴露：代理启停/证书安装（系统级变更，仅 Web，§9）、删除历史/清缓存（破坏性）。
"""

from __future__ import annotations

import json
import urllib.parse

from . import backend_client
from .tools import _text


def _wrap(resp: dict, summary: str | None = None) -> dict:
    """把旧端点的自由格式响应包装进统一契约。"""
    if not isinstance(resp, dict):
        return {"success": True, "summary": summary or "完成", "data": {"result": resp}, "error": None}
    # 旧端点错误形态：{"error": "..."}（无 success 键）不能被掩成成功
    success = resp.get("success", "error" not in resp and "err" not in resp)
    err = resp.get("error")
    if isinstance(err, str):
        err = {"code": "INTERNAL", "message": err, "retryable": False}
    return {
        "success": bool(success),
        "summary": summary or resp.get("message") or resp.get("summary") or ("完成" if success else "失败"),
        "data": {k: v for k, v in resp.items() if k not in ("success", "error", "message")},
        "error": err,
    }


# ── 抖音 ─────────────────────────────────────────────────

def dy_detect(args): return _text(_wrap(backend_client.call("/api/douyin/detect-url", "POST", {"url": args["url"]})))
def dy_download_single(args): return _text(_wrap(backend_client.call("/api/douyin/download-single", "POST", {"url": args["url"]}), "已提交抖音解析下载"))
def dy_download_user(args): return _text(_wrap(backend_client.call("/api/douyin/download-user", "POST", {"url": args["url"], **({"scroll_depth": args["scroll_depth"]} if args.get("scroll_depth") else {})}), "已提交抖音博主作品批量下载"))
def dy_progress(args): return _text(_wrap(backend_client.call("/api/douyin/progress"), "抖音任务进度"))
def dy_cancel(args): return _text(_wrap(backend_client.call("/api/douyin/cancel-download", "POST", {}), "取消请求已受理"))

# ── B站 ──────────────────────────────────────────────────

def bili_detect(args): return _text(_wrap(backend_client.call("/api/bilibili/detect-url", "POST", {"url": args["url"]})))
def bili_download_single(args):
    payload = {"url": args["url"]}
    if args.get("quality") is not None:
        payload["quality"] = args["quality"]
    return _text(_wrap(backend_client.call("/api/bilibili/download-single", "POST", payload), "已提交B站解析下载"))
def bili_accounts(args): return _text(_wrap(backend_client.call("/api/bilibili/accounts"), "B站UP主列表"))
def bili_user_videos(args): return _text(_wrap(backend_client.call(f"/api/bilibili/accounts/{args['mid']}/videos?page={args.get('page', 1)}")))
def bili_progress(args): return _text(_wrap(backend_client.call("/api/bilibili/progress"), "B站任务进度"))
def bili_cancel(args): return _text(_wrap(backend_client.call("/api/bilibili/cancel-download", "POST", {}), "取消请求已受理"))

# ── 快手 ─────────────────────────────────────────────────

def ks_download_single(args): return _text(_wrap(backend_client.call("/api/kuaishou/download-single", "POST", {"url": args["url"]}), "已提交快手解析下载"))
def ks_user_feed(args): return _text(_wrap(backend_client.call("/api/kuaishou/user-feed", "POST", {"url": args["url"], **({"pcursor": args["pcursor"]} if args.get("pcursor") else {})})))
def ks_progress(args): return _text(_wrap(backend_client.call("/api/kuaishou/progress"), "快手任务进度"))
def ks_cancel(args): return _text(_wrap(backend_client.call("/api/kuaishou/cancel-download", "POST", {}), "取消请求已受理"))

# ── 小红书 ────────────────────────────────────────────────

def xhs_parse(args): return _text(_wrap(backend_client.call("/api/xhs/parse", "POST", {"url": args["url"]})))
def xhs_download_single(args): return _text(_wrap(backend_client.call("/api/xhs/download", "POST", {"urls": [args["url"]]}), "已提交小红书下载"))
def xhs_status(args): return _text(_wrap(backend_client.call(f"/api/xhs/download-status/{args['task_id']}"), "小红书任务状态"))
def xhs_cancel(args): return _text(_wrap(backend_client.call(f"/api/xhs/download-cancel/{args['task_id']}", "POST", {}), "取消请求已受理"))

# ── 视频号（仅只读解析与下载提交；代理管理不在 MCP 暴露） ──

def ch_profile(args): return _text(_wrap(backend_client.call("/api/channels/fetch_video_profile", "POST", {"url": args["url"]})))
def ch_download_start(args): return _text(_wrap(backend_client.call("/api/channels/download/start", "POST", {"url": args["url"], "description": args.get("description", ""), "createtime": args.get("createtime", ""), "decrypt_key": args.get("decrypt_key")}), "视频号下载已提交"))
def ch_download_status(args): return _text(_wrap(backend_client.call(f"/api/channels/download/status/{args['task_id']}"), "视频号任务状态"))
def ch_download_cancel(args): return _text(_wrap(backend_client.call(f"/api/channels/download/cancel/{args['task_id']}", "POST", {}), "取消请求已受理"))


_URL = {"type": "object", "properties": {"url": {"type": "string"}}, "required": ["url"], "additionalProperties": False}
_TASK = {"type": "object", "properties": {"task_id": {"type": "string"}}, "required": ["task_id"], "additionalProperties": False}

PLATFORM_TOOLS = [
    # 抖音
    ("douyin_detect_url", "识别抖音链接（视频/图集/用户主页）", _URL, dy_detect),
    ("douyin_download_single", "抖音单条视频/图集无水印下载。提交成功不等于采集成功，用 douyin_task_status 轮询", _URL, dy_download_single),
    ("douyin_download_user", "抖音博主主页作品批量下载（需登录态，有增量去重）", _URL, dy_download_user),
    ("douyin_task_status", "查询抖音下载任务进度", {"type": "object", "properties": {}, "additionalProperties": False}, dy_progress),
    ("douyin_task_cancel", "请求取消抖音下载（协作式）", {"type": "object", "properties": {}, "additionalProperties": False}, dy_cancel),
    # B站
    ("bili_detect_url", "识别B站链接（视频/番剧/分P）", _URL, bili_detect),
    ("bili_download_single", "B站单视频下载（音视频自动混流 MP4）", _URL, bili_download_single),
    ("bili_list_accounts", "列出已收藏的B站UP主", {"type": "object", "properties": {}, "additionalProperties": False}, bili_accounts),
    ("bili_user_videos", "获取UP主投稿视频列表", {"type": "object", "properties": {"mid": {"type": "string"}, "page": {"type": "integer"}}, "required": ["mid"], "additionalProperties": False}, bili_user_videos),
    ("bili_task_status", "查询B站下载任务进度", {"type": "object", "properties": {}, "additionalProperties": False}, bili_progress),
    ("bili_task_cancel", "请求取消B站下载（协作式）", {"type": "object", "properties": {}, "additionalProperties": False}, bili_cancel),
    # 快手
    ("ks_download_single", "快手单视频/图集解析下载", _URL, ks_download_single),
    ("ks_user_feed", "快手博主主页作品列表（需登录态）", _URL, ks_user_feed),
    ("ks_task_status", "查询快手下载任务进度", {"type": "object", "properties": {}, "additionalProperties": False}, ks_progress),
    ("ks_task_cancel", "请求取消快手下载（协作式）", {"type": "object", "properties": {}, "additionalProperties": False}, ks_cancel),
    # 小红书
    ("xhs_parse", "解析小红书笔记（图文/视频元数据）", _URL, xhs_parse),
    ("xhs_download_single", "小红书笔记下载（图片/视频/Live）", _URL, xhs_download_single),
    ("xhs_task_status", "查询小红书下载任务状态", _TASK, xhs_status),
    ("xhs_task_cancel", "请求取消小红书下载（协作式）", _TASK, xhs_cancel),
    # 视频号
    ("channels_fetch_video_profile", "解析视频号分享链接（状态/清晰度/主播信息）", _URL, ch_profile),
    ("channels_download_start", "提交视频号视频下载（需代理与证书就绪，见 Web 设置）",
     {"type": "object", "properties": {"url": {"type": "string"}, "description": {"type": "string"},
                                        "createtime": {"type": "string"}, "decrypt_key": {"type": "string"}},
      "required": ["url"], "additionalProperties": False}, ch_download_start),
    ("channels_download_status", "查询视频号下载任务状态", _TASK, ch_download_status),
    ("channels_download_cancel", "请求取消视频号下载（协作式）", _TASK, ch_download_cancel),
]

# ── 公众号后台官方能力（mp_admin 通道） ───────────────────

def mp_search_biz(args):
    return _text(_wrap(backend_client.call(
        f"/api/mp-admin/search-biz?query={urllib.parse.quote(args.get('query',''))}",
        timeout=30), "公众号搜索结果"))


PLATFORM_TOOLS += [
    ("mp_search_biz", "按名称搜索公众号（官方后台接口，返回 fakeid/nickname/头像），用于 mp 文章列表与订阅",
     {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"], "additionalProperties": False}, mp_search_biz),
]


# ── 公众号爆款文章洞察（免登录发现类数据源，借鉴 creator-buddy） ──

def mp_hot_articles(args):
    payload = {
        "keyword": args.get("keyword", ""),
        "days": args.get("days", 7),
        "max_items": args.get("max_items", 20),
    }
    return _text(_wrap(backend_client.call("/api/mp-hot/query", "POST", payload, timeout=60),
                       "公众号爆款文章洞察"))


PLATFORM_TOOLS += [
    ("mp_hot_articles", "查询公众号爆款文章洞察（第三方公开快照库，免登录、不受 200013 频控影响）。"
     "keyword 为空=全站热门；返回标题/账号/阅读/分享/点赞/数据分/原文链接，链接可直接交给 mp_collect 采集",
     {"type": "object",
      "properties": {"keyword": {"type": "string", "description": "赛道关键词，建议细分词；留空=全站热门"},
                     "days": {"type": "integer", "description": "回看天数 1-30，默认 7"},
                     "max_items": {"type": "integer", "description": "返回条数上限 1-50，默认 20"}},
      "additionalProperties": False}, mp_hot_articles),
]


# ── 搜狗公开索引（免登录，2026-07 后台列表接口关闭后的近期文章通路） ──

def mp_sogou_articles(args):
    payload = {"account_name": args.get("account_name", ""), "limit": args.get("limit", 10)}
    return _text(_wrap(backend_client.call("/api/sogou/search", "POST", payload, timeout=90),
                       "搜狗索引近期文章"))


PLATFORM_TOOLS += [
    ("mp_sogou_articles", "按公众号名搜索其近期文章（搜狗公开索引，免登录）。"
     "仅近期文章非全量历史；返回真实文章 URL（带签名有时效），请立即交给 mp_collect 采集",
     {"type": "object",
      "properties": {"account_name": {"type": "string", "description": "公众号显示名（精确匹配过滤）"},
                     "limit": {"type": "integer", "description": "返回条数 1-20，默认 10"}},
      "required": ["account_name"], "additionalProperties": False}, mp_sogou_articles),
]


# ── M7：视频转码 ──────────────────────────────────────────

def tc_check_ffmpeg(args): return _text(_wrap(backend_client.call("/api/transcode/check-ffmpeg"), "FFmpeg 环境检查"))
def tc_scan(args): return _text(_wrap(backend_client.call("/api/transcode/scan-downloads"), "已扫描下载媒体"))
def tc_info(args): return _text(_wrap(backend_client.call("/api/transcode/video-info", "POST", {"path": args["path"]})))
def tc_start(args):
    payload = {"input_path": args["path"]}
    for k in ("format", "codec", "quality", "audio_mode", "hardware_accel"):
        if args.get(k) is not None:
            payload[k] = args[k]
    return _text(_wrap(backend_client.call("/api/transcode/start", "POST", payload), "转码任务已提交"))
def tc_status(args): return _text(_wrap(backend_client.call("/api/transcode/status"), "转码队列状态"))


_TC_PATH = {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"], "additionalProperties": False}

PLATFORM_TOOLS += [
    ("transcode_check_ffmpeg", "检查 FFmpeg 环境是否可用", {"type": "object", "properties": {}, "additionalProperties": False}, tc_check_ffmpeg),
    ("transcode_scan_downloads", "扫描已下载媒体文件（视频号/抖音目录）", {"type": "object", "properties": {}, "additionalProperties": False}, tc_scan),
    ("transcode_video_info", "读取媒体元信息（编码/分辨率/码率/时长）", _TC_PATH, tc_info),
    ("transcode_start", "提交转码任务（格式转换/压缩/提取音频）", {"type": "object",
        "properties": {"path": {"type": "string"}, "format": {"type": "string"}, "codec": {"type": "string"},
                        "quality": {"type": "string"}, "audio_mode": {"type": "string"},
                        "hardware_accel": {"type": "boolean"}},
        "required": ["path"], "additionalProperties": False}, tc_start),
    ("transcode_status", "查询转码队列状态与进度", {"type": "object", "properties": {}, "additionalProperties": False}, tc_status),
]
