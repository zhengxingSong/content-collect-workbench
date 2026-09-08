# ROADMAP

> 2026-09 状态。M0-M7 已全部落地并通过验收（详见顶层设计 §16/§17 与验收清单）；本文只写"从现在开始"。

## ✅ 已完成（现状基线）

- M0 契约层：state_store / task_manager（状态机+幂等+恢复）/ urlnorm / errors / 产物契约 output/ v2
- M1-M2：Flask 后端 + MCP HTTP 服务（手写 Streamable HTTP）+ stdio 兜底，统一响应契约
- M3：askuser 认证流（`mp_start_auth` 出二维码 → 扫码 → `mp_check_auth`），mp_admin 通道
- M4：公众号统一采集（短链正文 + 图片本地化 + 原子提交 + 内容库）
- M5：Web 单页仪表盘四区（仪表盘/采集/内容库/认证中心），简化认证为单页扫码
- M6：平台横铺（抖音/快手/小红书/B站/视频号）+ MCP 平台工具
- M7：视频转码 + 资源暴露（Resources）+ 日志脱敏 + NSIS 打包
- 运行时：Docker Compose 栈（backend/mcp/wewe-rss）为主形态；Electron 双形态（runtimeMode）
- 数据源扩展：爆款洞察发现源（`mp_hot_articles`，工具总数 47）
- 防回归：风控页守卫、base64 fakeid 过滤修复 ×2、预览渲染链修复

## 🔧 P0 近期改造（已排定）

| 项 | 内容 | 规模 |
|---|---|---|
| 凭证加密 | `data/mp_admin_config.json` 管理员 cookie/token 明文 → Windows DPAPI 加密（cryptography Fernet + DPAPI 主钥），失败降级明文并告警 | ~半天 |
| state 加固 | `state_store` 增加单代 `.bak` 备份；启动时清理残留 `.tmp`、校验全部 JSON（损坏则回滚备份） | ~1h |
| MCP 协议版本守卫 | initialize 时协议版本不匹配返回明确错误与指引 | ~0.5h |
| 文档同步 | 本轮文档体系（README/架构/设计/ROADMAP/工具清单）入库 | 已完成 |

## 🔭 P1 中期候选（按需启动，不自动排期）

| 项 | 触发条件 | 说明 |
|---|---|---|
| 爆款一键批量入队 | 用户有需求 | 爆款洞察结果勾选 → 批量提交短链采集（受查询形态限制，仅限短链条目） |
| 平台健康监控 | 通路再次波动 | `state/platform_health.json` 滑动窗口成功率，<50% 时 UI 降级提示 |
| Chrome 扩展 | 需要更顺的收集动线 | 右键"发送到采集工作台"（本地 fetch → collect API） |
| 搜狗微信发现源 | 爆款库不够用时 | 补充发现入口（注意其链接同为查询形态，采集受限） |
| md 图片离线重写 | 完全离线需求 | library_export 时把 md 内远程图片链接改写为本地 media/ 相对路径 |

## ⚠️ 生态风险声明（决策依据）

- **appmsg 族批量历史接口**：微信 2026-07 前后主动收紧/关闭（wechat-article-exporter 12k star 因此停维，见其 issue #200）。本项目不再对其投入增强，RSS 增量与文章列表页标记**实验性**。
- **查询形态 URL 环境校验**：`s?__biz=…` 服务端抓取被拦（环境异常/参数错误），`/s/{token}` 短链不受影响。任何新数据源接入前先验证其产出链接形态。
- **PC 微信凭证族**（profile_ext + key）：生态仅存的批量历史通路，但依赖 PC 客户端与本机抓取，无法进 Docker；若未来确有刚需，作为**桌面端候选特性**单独评估（合规与脆弱性风险自担）。

## 不做清单（防止 scope 蠕变）

数据库 / 知识库接入 / 内容发布 / 多用户 / 消息中间件 / 文档大重构 / FastMCP 迁移 / 打包分层分发体系。

## 🔧 P1 已启动（当前迭代）

- [x] 有界任务执行器：线程池并发上限 `WMT_TASK_MAX_WORKERS`（默认 3），活动任务上限 `workers + WMT_TASK_MAX_QUEUE`（默认排队 20）；队列满返回 `QUOTA_EXCEEDED`/HTTP 429。
- [x] 排队任务取消：runner 启动前检查取消标记，不再执行已取消任务。
- [x] 失败项恢复：`POST /api/collect/tasks/{id}/retry-failed` 与 MCP `collect_task_retry_failed`，仅携带原任务失败 URL，不重复成功/跳过条目。
- [x] 任务状态/进度契约测试：并发边界、排队取消、失败项重试。
- [ ] 平台能力健康状态：区分用户输入错误、认证过期、环境不支持、平台异常与实验性通路。
- [ ] 更细粒度的平台/转码并发预算与磁盘空间预算。

## ✅ P2 内容库完善（当前迭代完成）

- [x] 元数据搜索与分页：标题/作者 `q` 搜索、平台/日期过滤、服务端分页；无参数旧接口保持兼容。
- [x] 完整性详情：逐文件存在性/大小/sha256 校验，区分 `complete` / `partial` / `corrupt`，Web 详情展示 warnings 与失败文件。
- [x] 离线导出：单条下载保留；新增 1-50 条批量 ZIP，限 1000 文件/512MB，Markdown 中已落盘媒体链接改为 `media/` 相对路径。
- [x] 内容库备份/校验/恢复：只备份 `output/`，不含凭证、服务令牌、代理证书；ZIP manifest+sha256 校验；恢复需 Web `confirm=true`，默认 merge，并从 output 重建去重索引。
- [x] P2 契约测试：搜索/分页、完整性损坏检测、备份校验/恢复、凭证排除；核心测试 43 项通过。

## ✅ P3（当前迭代完成）

- [x] `/api/environment` 启动环境检查：Backend/MCP 端口、data/state/output 写权限、FFmpeg、磁盘空间；返回 `ready/degraded/blocked` 与逐项可行动 message。
- [x] 仪表盘新增“运行环境”状态卡；Web API `API.statusApi.environment()` 接入。
- [x] MCP 新增只读 `environment_check` 工具，阻塞环境返回 `ENV_NOT_READY` 与 blocking_checks。
- [x] MCP HTTP/stdio 协议兼容测试：initialize、版本不匹配提示、tools/list、tools/call、未知方法与 notification。
- [x] 全量 TDD 回归：148 passed。

## ✅ 采集韧性迭代（当前完成）

- [x] 失败媒体定向补采：`POST /api/library/entries/{id}/retry-media`；只重下 failed_items 中的媒体，成功后更新 manifest/sha256/source_url、清空 failed_items、重算 collection_status；Web 完整性详情内一键补采；不新建条目。
- [x] 磁盘预算：任务执行前检查 output 所在盘可用空间（默认 1GB，`WMT_TASK_MIN_FREE_GB` 可调/0 关闭），不足立即 `QUOTA_EXCEEDED` 失败，不启动 runner。
- [x] 平台健康统计：`GET /api/health/platforms` + MCP `platform_health`；从真实任务终态聚合（滑动窗口 200 条），错误分类 user_input/auth/platform/internal，小样本标注 `insufficient` 不妄断故障。
- [x] 契约测试 5 项新增（补采×2、磁盘预算、健康统计、样本阈值语义）；全量 154 passed。

## ✅ 搜狗公开索引通道（当前迭代完成）

- [x] 背景：2026-07-30 微信关闭第三方会话的跨号文章列表能力（appmsg/appmsgpublish 一律 200013，生态多家项目确认）。搜狗公开索引成为"某公众号近期文章"的现实来源。
- [x] `backend/sogou_index.py`：文章卡片解析（fixture 驱动 TDD）、发布者精确过滤（防同名号串档）、/link 跳转还原（url+= 拼接 + 显式 &amp; 替换 + 反爬页识别）、文章页 sn/biz/js_name 身份提取、6h 搜索缓存、会话化请求（CookieJar 保持）。
- [x] 稳定去重身份：签名 URL（/s?src=11&timestamp=..&signature=..）无稳定 ID，采集器从页面提取 sn 作为 platform_item_id——同一文章重复解析不重复入库（Docker 实测 signature 已变仍 skipped）。
- [x] 端点 `POST /api/sogou/search`、MCP `mp_sogou_articles`（51 工具）、Web 采集页"公众号近期文章"卡片。
- [x] 边界声明：仅近期文章非全量历史；签名 URL 有时效需尽快采集；搜狗反爬敏感时返回可行动错误（429 验证码提示）。
