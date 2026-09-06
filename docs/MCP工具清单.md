# MCP 工具清单（47 项）

> 协议：Streamable HTTP，`POST http://127.0.0.1:3333/mcp`，协议版本 **2025-03-26**。stdio 兜底：`python mcp_server.py`（同一注册表）。

## 认证

端点需要 `Authorization: Bearer <state/service.json 中的 token>`。容器间调用额外做 Host 校验（绑定 127.0.0.1）。

## 统一响应契约

每个工具调用返回结构（文本 content 内含 JSON）：

```json
{
  "success": true,
  "summary": "一句话结果",
  "data": { ... },
  "error": null,
  "request_id": "..."
}
```

失败时 `success=false`，`error` 为 `{code, message, retryable}`。`retryable=true` 表示可稍后重试（如平台频率限制）。

## 工具分组

### 服务与能力（M0）

| 工具 | 说明 |
|---|---|
| `service_status` | 后端服务是否可用、版本、端口 |
| `platform_capabilities` | 平台能力矩阵（含认证方式、增量、缺陷声明） |

### 统一采集与任务（M0-M1）

| 工具 | 说明 |
|---|---|
| `collect_detect_url` | 识别链接 → 平台 + 规范化 URL + 平台内容 ID |
| `mp_collect` | 公众号统一采集：正文归一化 + 媒体本地化，落 `output/` 内容库。返回 task_id（上限 50 条/次） |
| `collect_task_status` | 查询任务状态（含分条目结果） |
| `collect_task_cancel` | 请求取消任务（协作式） |

### 公众号历史归档（M0，旧通路）

| 工具 | 说明 |
|---|---|
| `mp_download_single` | 公众号文章离线归档（保留原排版，产物在 `data/articles_full`）。提交≠采集成功，需轮询 `mp_task_status` |
| `mp_task_status` | 归档任务进度 |

### 认证（askuser 扫码流，M3）

| 工具 | 说明 |
|---|---|
| `mp_start_auth` | 发起公众号管理员扫码认证：返回二维码图片（图片 content），请在有效期内扫码 |
| `mp_check_auth` | 查询认证请求状态（只读；expired 时重发 `mp_start_auth`） |
| `mp_list_accounts` | 公众号采集通道（mp_admin）认证状态 |

### 公众号官方能力（mp_admin 通道）

| 工具 | 说明 |
|---|---|
| `mp_search_biz` | 按名称搜索公众号（官方后台接口）：fakeid/nickname/头像 |
| `mp_hot_articles` | 公众号爆款洞察（第三方公开快照库，免登录、不受频控影响）。keyword 为空=全站热门；返回标题/账号/阅读/分享/数据分/原文链接，链接可直接交 `mp_collect` |

### 内容库（M2/M5）

| 工具 | 说明 |
|---|---|
| `library_list` | 列出内容库条目（分平台/日期过滤） |
| `library_get` | 读取单条目详情（含 content.md / 媒体） |
| `library_export` | 导出条目（sha256 校验） |

### 订阅（RSS 增量，实验性）

| 工具 | 说明 |
|---|---|
| `mp_subscriptions_list` | 列出公众号 RSS 订阅 |
| `mp_subscriptions_add` | 添加订阅（fakeid + 间隔分钟） |
| `mp_subscriptions_remove` | 移除订阅 |

> ⚠️ RSS 增量依赖 appmsg 族接口，属实验性（见 ROADMAP 风险声明）。

### 抖音

| 工具 | 说明 |
|---|---|
| `douyin_detect_url` | 识别抖音链接（视频/图集/用户主页） |
| `douyin_download_single` | 抖音单条无水印下载 |
| `douyin_download_user` | 博主主页作品批量下载（需登录态） |
| `douyin_task_status` / `douyin_task_cancel` | 任务进度查询 / 协作式取消 |

### B站

| 工具 | 说明 |
|---|---|
| `bili_detect_url` | 识别 B站链接（视频/番剧/分P） |
| `bili_download_single` | 单视频下载（音视频混流 MP4） |
| `bili_list_accounts` | 已收藏 UP 主 |
| `bili_user_videos` | UP 主投稿列表（page 分页） |
| `bili_task_status` / `bili_task_cancel` | 进度 / 取消 |

### 快手

| 工具 | 说明 |
|---|---|
| `ks_download_single` | 快手单条解析下载 |
| `ks_user_feed` | 博主主页作品列表（需登录态） |
| `ks_task_status` / `ks_task_cancel` | 进度 / 取消 |

### 小红书

| 工具 | 说明 |
|---|---|
| `xhs_parse` | 解析小红书笔记（图文/视频元数据） |
| `xhs_download_single` | 笔记下载（图片/视频/Live） |
| `xhs_task_status` / `xhs_task_cancel` | 进度 / 取消 |

### 视频号

| 工具 | 说明 |
|---|---|
| `channels_fetch_video_profile` | 解析视频号分享链接（状态/清晰度/主播信息） |
| `channels_download_start` | 提交视频号下载（需代理与证书就绪，见 Web 设置） |
| `channels_download_status` / `channels_download_cancel` | 进度 / 取消 |

### 视频转码（M7）

| 工具 | 说明 |
|---|---|
| `transcode_check_ffmpeg` | FFmpeg 环境检查 |
| `transcode_scan_downloads` | 扫描已下载媒体 |
| `transcode_video_info` | 媒体元信息（编码/分辨率/码率/时长） |
| `transcode_start` | 提交转码任务：`{path, format?, codec?, quality?, audio_mode?, hardware_accel?}` |
| `transcode_status` | 转码队列状态与进度 |

## 安全边界（MCP 刻意不暴露）

删除历史 / 清理缓存 / 代理启停 / 证书安装 —— 这些破坏性或系统级操作**不进入 MCP**，仅保留在 Web（人工确认）。MCP 只暴露采集与读取类操作。