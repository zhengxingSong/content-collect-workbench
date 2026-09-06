# 顶层设计：多来源数据收集平台（MCP 化 + 桌面端）

> 状态：**v2 — M0–M7 全部实现；NSIS 安装包已产出并通过打包侧运行时验收**
> 实现进度（2026-09-05）：M0 契约层 `backend/core/`；M1 MCP 服务 `backend/mcp_server/`；M3 认证 `backend/auth_requests.py`；M4 产物 `backend/library.py` + `backend/collectors/`；M2 桌面外壳 `desktop/`；M5 Web 单页仪表盘（frontend 四区改造，见 §13）；M6 全平台 MCP 工具（`platform_tools.py`，共 45 工具含转码）；M7 转码工具映射。stdio 兜底适配器 `mcp_server.py`（连接模式，与 HTTP 版共用注册表）。NSIS 安装包 `desktop/release/内容收集工作台 Setup 0.1.0.exe`（150MB），打包版运行时启动验证通过（2 秒服务就绪、45 工具可用、state/ 隔离）。测试 `tests/test_core_contracts.py` + `tests/test_stdio_and_redact.py`（37 项）；验收核对 `docs/验收清单-§17核对记录.md`。
> 日期：2026-09-05
> 参考项目：TrendRadar（仅借鉴思想：统一工具响应契约、Resources 暴露状态、配置驱动订阅、URL 标准化去重、产物即接口。不引入其代码、数据源 adapter、推送渠道与部署形态）；llama.cpp desktop（仅借鉴模式：Electron 主进程进程监督）。
> 修订说明：v1 为已确认的产品与架构方向；v2 补齐契约与生命周期设计，重点新增：数据持久化规范（§3）、本地安全模型（§4）、运行时连接管理（§5）、统一任务模型（§8）、能力矩阵（§7.2）、结构化错误码（§7.4）、产物原子提交协议（§10）、认证生命周期收紧（§9）、M0 契约冻结阶段与验收清单（§16/§17）。

---

## 1. 定位与边界

### 1.1 本项目是什么

**多来源数据的收集枢纽**：以桌面应用为载体，一键启动全部服务；Web 界面负责人工操作与状态总览；MCP 负责让 agent（AI 助手）代为操作全部采集能力；采集产物以标准文件目录形式落地。

### 1.2 定性的重要修正

本系统**没有数据库，但它是有状态服务**。凭证、订阅、任务断点、去重记录、认证请求都是必须跨重启存活的持久状态。"无数据库"只意味着存储介质是文件，**不意味着可以没有持久化设计**（详见 §3）。

### 1.3 职责边界（严格限定）

| 范围内 | 范围外 |
|---|---|
| 桌面端平台搭建（进程监督、托盘、日志、打包） | 知识库接入（WeKnora 或任何下游系统） |
| 六平台数据采集（公众号/视频号/抖音/快手/小红书/B站） | 数据库（无 SQLite/MySQL 等，纯文件产物） |
| MCP 服务（agent 操作入口 + 认证二维码交付） | 产物向下游的推送/同步 |
| 订阅轨定时增量采集（现有 RSS 调度器） | 多用户/公网服务（始终单机本地） |
| 归一化文件产物（Markdown + 元数据 + 媒体） | `backend/subtitle_remover/` 重型 ML（不直接暴露给 agent） |

**解耦原则**：`output/` 目录即对外契约（§10）。下游只消费文件，本项目对其一无所知。

---

## 2. 总体架构

```
┌─────────────────────────────────────────────────────────┐
│                Electron 桌面外壳（监督者）                │
│   进程监督 · 连接信息管理(§5) · 托盘 · 单实例 · NSIS       │
└───────┬──────────────────────────┬──────────────────────┘
        │ spawn/监控                │ spawn/监控（注入实际端口）
        ▼                          ▼
┌──────────────────┐      ┌──────────────────────┐
│  Flask 后端       │      │  MCP HTTP 服务        │
│  127.0.0.1:5200  │◄─────│  127.0.0.1:3333/mcp  │
│  业务/账号池/任务  │ HTTP │  FastMCP（薄代理）     │
└──────┬───────────┘      └──────────┬───────────┘
       │                             │
       ▼                             ▼
┌──────────────┐            ┌──────────────────────┐
│ Web SPA 前端  │            │ Agent 客户端们         │
│ 单页仪表盘    │            │ (配 URL + 令牌接入)    │
└──────────────┘            └──────────────────────┘
```

- **一个后端，两个前端**：所有业务逻辑、账号池、任务状态只在 Flask 后端一份；Web 与 MCP 是平级的两个前端。
- **MCP = 薄代理**：FastMCP 进程不写业务，只转发到 Flask HTTP API；stdio 兜底适配器连接同一后端（§7.5）。
- **Electron 是运行时连接信息的唯一管理者**（§5）。

---

## 3. 数据持久化规范（新增）

按数据性质分三类，目录与处理规则分离：

| 类别 | 内容 | 位置 | 规则 |
|---|---|---|---|
| **内容产物** | 正文、元数据、媒体 | `output/` | 原子提交协议（§10.3），只暴露已提交条目 |
| **运行状态** | 订阅、任务断点、认证请求、去重索引、迁移记录、调度器心跳 | `state/` | JSON/JSONL；**后端单点写入**；原子替换 |
| **敏感凭证** | 各平台 Cookie、Token、代理凭据 | `state/credentials/` | 加密文件：优先 OS 凭据保护（DPAPI/Keychain），`cryptography` Fernet 兜底；文件权限限当前用户 |
| 应用配置 | 代理、端口偏好、MCP 设置 | `state/app_settings.json` | 用户可编辑；临时文件写入后原子替换 |

通用规则：

1. **原子写**：所有 JSON 状态先写 `*.tmp` 再 `os.replace()`，杜绝半写损坏；
2. **单写者**：`state/` 只由后端进程写入；MCP/Web 均不得直写；
3. **重启语义**（任务模型 §8.4 细化）：订阅、去重索引、凭证**必须恢复**；任务断点**可恢复**（有游标的续采）；无游标的 running 任务重启后标记 `interrupted`，不自动重跑；
4. **日志**：按服务落盘、5MB 轮转；事件类记录 JSONL + 定期压缩；
5. **术语修正**：全文"凭证落库"一律理解为"凭证持久化到加密凭据存储"（§3 敏感凭证行）；
6. 现有 `data/` 下分散 JSON（settings/proxy/history/凭证）在 M1 迁移到上述分类；提供一次性迁移器并保留回滚。

---

## 4. 本地服务安全模型（新增）

**原则：监听 127.0.0.1 ≠ 可信。** 防御对象：恶意网页（浏览器内 CSRF/探测）、非授权本地客户端、被采集内容本身；明确局限：同用户权限下的恶意进程无法仅凭本地令牌防御，此为接受的残余风险，写入文档告知用户。

| 层 | 措施 |
|---|---|
| 绑定 | Flask 与 MCP 显式绑 `127.0.0.1`，禁止 `0.0.0.0`（配置文件强校验） |
| 认证 | MCP HTTP 与 Flask 业务 API 统一本地访问令牌（启动时生成，存 `state/` 限当前用户读）；不能只保护 MCP |
| 请求校验 | 校验 `Host` 头；对带 `Origin` 的请求实施来源白名单（仅 `http://127.0.0.1:*` 与桌面端页面） |
| Web 会话 | 若引入 Cookie 会话则同步加 CSRF 防护；CORS 显式白名单——CORS 是浏览器策略，不当身份认证使用 |
| 日志脱敏 | Cookie、Token、二维码内容、敏感 URL 参数默认脱敏后再落盘 |
| 出站防护 | 采集目标 URL/媒体地址禁止命中本地与内网网段（含短链展开、重定向后目标），防 SSRF（§11.3） |
| Electron | `contextIsolation: true`、`nodeIntegration: false`、启用沙箱；IPC 方法白名单；打开文件/目录/外链前校验目标；**原始采集 HTML 一律不在具备桌面特权的页面中执行**（内容库预览用沙箱 iframe/独立渲染进程，剥离脚本） |

---

## 5. 端口与运行时连接管理（新增）

**Electron = 连接信息管理者**，启动序列：

```
1. 确定后端端口（默认 5200，5200-5220 避让）
2. 启动 Flask → 轮询就绪（区分：进程存活 / HTTP 就绪 / 业务可用，§15）
3. 将实际地址注入 MCP 子进程（环境变量，非陈旧文件）
4. 启动 MCP → 就绪检查（3333 占用时明确报错并允许用户改端口；
   若自动切换端口，必须同步提示客户端配置需更新）
5. 加载 Web，展示实际连接信息
```

- `runtime.json` 记录运行信息（限当前用户读），但**连接前必须验证对端身份**（握手携带启动令牌）——不得"端口上有响应就当是自己的服务"；
- MCP 客户端配置默认固定 3333 保持稳定；3333 冲突时走"报错 + 用户改端口/改配置"，不做静默漂移。

---

## 6. 桌面端（Electron 外壳）

参照 llama.cpp desktop 模式，新建 `desktop/`（Electron + Vite + TS）：

```
desktop/src/
├── main/  index.ts(窗口/托盘/单实例) service-manager.ts(进程监督§15)
│          config.ts logger.ts(轮转/脱敏) mcp-registry.ts(接入辅助)
├── preload/index.ts          # contextBridge 白名单暴露
└── renderer/                 # 复用现有 frontend/ SPA
```

被监督服务：Flask 后端（随启，含 RSS 调度/账号池保活）、MCP HTTP（随启）、mitm 代理（按需，生命周期归属后端，退出清理责任在后端，见 §15）。托盘常驻、关窗隐藏、退出询问（默认停服务）、单实例、崩溃退避重启 + 系统通知（受故障预算约束 §15）。

**MCP 接入辅助**：设置页展示 `http://127.0.0.1:3333/mcp` + 访问令牌 + 一键复制配置片段（Cherry Studio 等）；不静默改写第三方配置文件。

**打包**：不将开发用 `venv312` 视为可移植运行时；M2 期在干净机器上验证 Python 分发（embeddable/独立构建）、FFmpeg、原生依赖（curl_cffi/playwright）、升级与卸载行为（升级不删 `state/` 与 `output/`，卸载前明确询问）。

---

## 7. MCP 设计

### 7.1 传输

- 主路径：**streamableHTTP** `http://127.0.0.1:3333/mcp`，随桌面端常驻。
- 兜底：**stdio 薄适配器，连接模式**——只连接已运行的后端，不负责拉起；后端未启动时返回结构化 `SERVICE_UNAVAILABLE`。配套 headless 启动命令（`app.py --no-browser`）供不用桌面端的场景。**明确：stdio 不依赖 Electron，但依赖运行中的 Flask 后端。** 单一后端进程由启动方（Electron 或用户手动）保证，杜绝多 agent 各自拉起后端导致的账号池/调度/文件写入竞争。
- **实现偏差记录**：MCP 协议层采用**手写最小合规实现**（Flask，POST /mcp 收 JSON-RPC、回 application/json），未引入 FastMCP——其依赖链（pydantic/httpx）与 venv 中 `typing-extensions==4.14.0` 锁定（mitmproxy 依赖）冲突风险高。协议版本 `2025-03-26`，无状态会话。代码位于 `backend/mcp_server/`。

### 7.2 能力矩阵（取代"各平台接口完全对称"的假设）

统一的是**调用语义**，不是功能对称。Agent 先经 `platform_capabilities(platform)` / `mp-tools://capabilities/{platform}` 发现能力，再发起操作。下表为依据现有代码核对的初版（★=已核对，?=实现时确认）：

| 平台 | 采集操作 | 认证方式 | 二维码/登录形态（MCP 交付适配点） | 环境依赖 | 增量能力 |
|---|---|---|---|---|---|
| mp 公众号 | 单条/批量/时间范围/列表 ★ | 微信读书扫码 ★ | 后端直出 scanUrl ★（需服务端渲染为二维码图） | 无特殊 | RSS 增量已有 ★ |
| channels 视频号 | 单条/作者作品/关注增量 ★ | Cookie ★ | — | mitm 代理 + CA 证书（显式授权，§9） | 关注采集增量已有 ★ |
| douyin | 单条/图集/用户/喜欢/收藏/直播 ★ | 扫码 ★ | Playwright 窗口，状态机含 qrcode 字段 ★（可适配为后端出图） | 接口签名 | 滚动翻页采集 ★ |
| ks 快手 | 单条/主页/批量 ★ | 扫码 ★ | Playwright 原生窗口 ★（MCP 交付需适配） | — | feed 翻页 ★ |
| xhs | 单条/博主全量 ★ | 扫码/验证码 ★ | Playwright 窗口 ★（同上需适配） | — | 主页分页 ★ |
| bili | 单条/分P/UP主 ★ | **Cookie 导入（当前无扫码实现）★** | — | **FFmpeg 混流必需** ★ | 投稿列表分页 ★ |

平台限制（条数/频率/媒体限制）列在 M6 各平台接入时补全。

### 7.3 工具清单（按平台命名空间，动词统一）

| 类别 | 工具（`{p}` = `mp`/`channels`/`douyin`/`ks`/`xhs`/`bili`） |
|---|---|
| 通用 | `collect_detect_url(url)`；`platform_capabilities(platform)`；`service_status()`（§7.4 定位） |
| 采集 | `{p}_download_single` / `{p}_download_batch` / `{p}_download_user`（均含 `max_items`/时间范围/续采游标，§8.3） |
| 任务 | `{p}_task_status(task_id)` / `{p}_task_cancel(task_id)`（§7.4 定位） |
| 账号 | `{p}_list_accounts` / `{p}_start_auth` / `{p}_check_auth`（§9） |
| 订阅 | `mp_subscriptions_list/add/remove/sync` |
| 内容库 | `library_list(platform?, date?)` / `library_get(entry_id)` / `library_export(entry_ids, dest)`（§12） |

长任务规则：下载类工具**立即返回 task_id**；禁止工具内部长阻塞。

### 7.4 状态暴露原则与结构化错误（修订）

**Resources 与查询工具的统一定位**：

> 状态提供统一只读模型，经 Resources 暴露；为客户端兼容与 agent 便利，同时提供必要查询工具。**两者读同一份状态，不重复实现逻辑**（工具内部即资源同一数据源的薄封装）。客户端支持订阅/通知时用资源订阅，否则按工具返回的建议间隔轮询。

Resources：`mp-tools://status`、`mp-tools://accounts/{p}`、`mp-tools://auth/pending`、`mp-tools://tasks`、`mp-tools://subscriptions`、`mp-tools://capabilities/{p}`。

**结构化错误**（agent 按错误码行动，不解析自然语言）：

```json
{
  "success": false,
  "summary": "需要重新认证",
  "data": { "auth_request_id": "ar_…", "platform": "douyin" },
  "error": { "code": "AUTH_REQUIRED", "message": "当前账号凭证已失效", "retryable": false },
  "request_id": "req_…"
}
```

错误码集：`AUTH_REQUIRED` / `RATE_LIMITED`（含建议等待秒数）/ `UNSUPPORTED_URL` / `ENV_NOT_READY`（细分 `FFMPEG_MISSING`、`PROXY_DOWN`…）/ `SERVICE_UNAVAILABLE` / `INVALID_INPUT` / `QUOTA_EXCEEDED` / `PARTIAL_FAILURE`。

附加约定：每个工具定义输入/输出 Schema；参数、分页与返回大小上限；结构化数据 + 文件（二维码图片）+ 文本摘要的内容组合方式；MCP `isError` 标记映射规则；**"任务提交成功 ≠ 采集成功"** 在工具描述中显式声明。

---

## 8. 统一任务模型（新增）

### 8.1 状态机

```text
queued → running → succeeded
                 → partially_succeeded
                 → failed
                 → cancel_requested → cancelled
running → waiting_auth → queued        # 认证闸门（§9）
重启后：running → interrupted（有游标者可 resume → queued）
```

### 8.2 任务记录字段

`task_id` + 请求幂等键（客户端可传；未传时按 参数规范化哈希 生成）、创建/开始/更新时间、进度与 成功/失败/跳过 计数、结构化错误（§7.4）+ `retryable`、产物条目 ID 列表（§10 身份）、建议轮询间隔、取消语义（**协作式**，请求已受理不保证瞬时停止）、分条目结果（批量允许部分成功，失败项可选择性重试）。

### 8.3 限额（修正 v1 的"单次 ≤50"盲区）

数量上限只对 `download_batch` 这类显式列表生效；`download_user` 与订阅同步改为**游标推进 + 分页上限**模型：`max_items`（默认/硬上限）、时间范围过滤、`cursor`（续采）、平台级与账号级并发闸（同账号同时任务数=1，全局任务并发默认 3）。Agent 的网络重试由幂等键吸收：同键重复提交返回既有任务，不产生重复下载。

### 8.4 持久化与恢复

任务记录 JSONL 追加写入 `state/tasks/`（§3 单写者+原子规则）。重启后：queued/running→`interrupted`（有游标者提示可 resume）；订阅同步依赖去重索引（§11）天然幂等，重复采集无副作用。

---

## 9. 认证交付机制（生命周期收紧）

统一 AuthRequest 服务；二维码生成复用各平台登录逻辑，MCP 只负责取出展示。**命名统一**：按平台命名空间 `{p}_start_auth` / `{p}_check_auth`（v1 示例 `mp_start_auth(douyin)` 系笔误，作废）。

生命周期规则：

1. **每个 平台+账号目标 最多一个活跃 AuthRequest**；重复 `start_auth` 返回既有请求或显式取消旧的；
2. 状态机：`pending → scanned → confirmed | expired | cancelled | failed`；
3. `check_auth` **只读**；二维码刷新由 agent 显式再次调用触发（或用户在 Web 手工刷新），设**刷新次数与时间预算**（默认 ≤3 次 / ≤10 分钟），防止 agent 重试造成刷码循环；
4. 二维码以 MCP image content 返回；客户端不支持图片时返回本地认证页 URL 作为备用入口（仍受 §4 来源校验保护）；
5. 认证成功**不向 agent 返回原始凭证**，仅返回成功状态与账号别名；
6. 视频号等涉及代理/证书安装的平台：认证流内加**显式授权步骤**（agent 需向用户转述将发生的系统级变更），Web 端提供状态提示与撤销入口；
7. 平台差异按 §7.2 能力矩阵处理：后端直出 scanUrl 的平台（公众号/抖音）直接交付图片；Playwright 窗口扫码的平台（快手/小红书）M3 期统一适配为后端出图或"引导打开 Web 认证页"的降级路径；
8. Web 兜底不变：同一 AuthRequest 在仪表盘"待认证"区渲染，凭证写入加密凭据存储（§3）后双路径共享账号池。

---

## 10. 产物契约 output/ v2（对外接口升级）

### 10.1 目录结构

```
output/
└── {platform}/
    └── {source_slug}/
        └── {publish_date}_{title_slug}_{entry_id8}/   # 条目目录，原子发布（§10.3）
            ├── _COMPLETE                # 完成标记（最后写入）
            ├── content.md
            ├── content.html            # 保留排版时
            ├── metadata.json
            └── media/
```

### 10.2 metadata.json Schema v2

```json
{
  "schema_version": "1.0",
  "id": "entry_id = 平台内容ID 的规范化哈希",
  "platform_item_id": "平台原生内容ID",
  "canonical_url": "规范化URL（去参后）",
  "source_url": "原始URL（永久保留）",
  "content_type": "article|note|video|gallery|live",
  "collection_status": "complete|partial",
  "collector_version": "1.0.0",
  "title": "…",
  "author": { "name": "…", "id": "…", "url": "…" },
  "publish_time": "ISO8601 或 null（未知不伪造）",
  "collect_time": "ISO8601",
  "content_hash": { "algo": "nchash-v1", "value": "…" },
  "files": [
    { "path": "media/1.jpg", "mime": "image/jpeg", "size": 12345, "sha256": "…" }
  ],
  "warnings": [ "部分高清图源失败，已降级" ],
  "failed_items": [],
  "extra": { "平台特有字段" }
}
```

### 10.3 身份设计（修正 v1：hash 不再同时承担身份与版本）

- **条目身份 = 平台 + 平台内容 ID**；无平台 ID 时用规范化 URL；
- `content_hash` 只用于识别**内容变化**（同一条目更新时产生新版本标记）与辅助去重——不同帖子正文相同不合并，身份不同就是不同条目；
- URL 规范化与 hash 算法均带版本号（`nchash-v1`），规则演进不破坏历史条目。

### 10.4 提交协议（原子发布）

```text
下载/生成 → 临时目录(.tmp，位于 output/ 同一文件系统)
→ 校验文件完整性与元数据 schema
→ 写入 _COMPLETE 标记
→ 同文件系统 os.replace() 原子发布为正式条目目录
```

内容库与下游**只见已提交条目**；`.tmp` 残留由启动时清扫任务回收。跨文件系统移动不做原子假定（校验后才删除临时副本）。

---

## 11. URL 去重与规范化（平台化规则，修正 v1 的全局剥参）

1. **原始 URL 永久保留**（metadata.source_url）；规范化 URL 仅用于身份判断，**不替代下载请求地址**；
2. **按平台维护参数白名单/黑名单**（如公众号剥离 `chksm/scene`，B站保留 `p=` 分P参数）——不搞全局一刀切，避免误删内容身份/鉴权参数；
3. **优先提取平台原生内容 ID** 作为身份依据（§10.3）；
4. hash 规范化只做**语义安全**的空白归一化（连续空白合一），不做激进变换，防损伤代码/表格；
5. 媒体文件单独记 `sha256` 校验值（§10.2），媒体重复不等于条目重复；
6. 短链展开、重定向链各跳与最终媒体地址均做**目标校验**：禁止本地/内网网段（SSRF，§4），黑名单外再采信。

去重索引存 `state/dedup_index.json`（url 规范化键 → entry_id），启动时重建校验。

---

## 12. 历史条目处理（修正 v1 的自包含冲突）

历史登记定位为**内部浏览能力**（内容库可展示 `data/` 旧条目，显式标记"历史/非自包含"）；对外契约只认 `output/`。提供 **`library_export` 操作**：把历史条目按 §10 契约复制导出为自包含标准产物（校验后清理临时副本）。下游拿走整个 `output/` 必定可读。

现有 `data/` 各平台目录保留不动；一次性"历史登记"工具只写 `state/` 索引，不搬文件。

---

## 13. Web 简化（单页仪表盘）

导航四区，杜绝多页跳转：**仪表盘**（服务状态/账号池健康/待认证请求内嵌二维码/最近收集/活跃任务）、**内容库**（`output/` 浏览 + 历史登记展示 + 导出；HTML 预览按 §4 沙箱化）、**采集**（统一粘贴链接入口 + 订阅管理；各平台高级功能收入抽屉）、**设置**（代理/MCP 接入/FFmpeg/数据目录）。

---

## 14. 采集触发模型（双轨）

| 轨道 | 驱动 | 说明 |
|---|---|---|
| 订阅轨 | 配置 + RSS 调度器定时 | 增量采集落 `output/`；断点/幂等由 §8/§11 保证 |
| Agent 轨 | agent 经 MCP 按需 | 订阅管理本身是 MCP 工具，agent 可代管 |

两轨共用任务模型、账号池、去重与产物契约。

---

## 15. 进程监督：就绪分层与故障预算（新增）

- **就绪三级**：进程存活 → 服务就绪（HTTP 应答）→ 业务可用（依赖自检：FFmpeg/代理/调度器心跳）。UI 与 `mp-tools://status` 区分展示；
- **重启策略**：指数退避 + 随机抖动 + **次数预算**（默认 5 次/小时）；配置错误、端口冲突属**不可重启错误**，直接报错停手；
- 后端不可用时 MCP 返回结构化 `SERVICE_UNAVAILABLE`，不悬挂；
- **退出顺序**：停止接单 → 暂停调度器 → 保存状态（§3 原子写）→ 优雅停止 → 超时强制结束；mitm 代理子进程归属后端、由后端负责清理（恢复系统代理/环境）；
- 边界条件：磁盘不足（任务转 `failed`，`ENV_NOT_READY` 明细）、系统休眠唤醒后健康重探、网络断开时订阅轨退避。

---

## 16. 路线图 v2

| 阶段 | 内容 | 验收重点 |
|---|---|---|
| **M0 契约冻结**（新增） | 冻结：任务状态机与 JSONL 格式、错误码、安全模型、`state/` 分类、metadata/产物 Schema | 核心协议有示例与测试；schema_version 定版 |
| **M1 MCP 最小闭环** | FastMCP HTTP + `mp` 工具 + 统一响应/错误 + resources；**明确以已有登录态为前提**，无凭证时返回 `AUTH_REQUIRED` 引导 | 提交/查询/取消/失败处理闭环 |
| **M2 桌面外壳** | Electron 监督 + 连接信息管理 + 托盘/单实例/日志 + NSIS | 无 Python 环境可启动；端口冲突可诊断；干净机验证打包 |
| **M3 认证交付** | 统一 AuthRequest 协议 + **已纳入 v1 的平台**（mp 先行，Playwright 窗口类平台适配）+ Web 待认证区 | Agent 与 Web 共享认证状态；刷新预算生效；其余平台随 M6 接入（**不承诺全平台进 v1**） |
| **M4 产物契约** | 归一化 + `output/` 原子提交 + 去重 + `library_*`（含最小浏览与 `library_export`、故障恢复、`data/` 迁移） | 半成品不可见；重复提交安全；断电/重启状态可解释 |
| **M5 Web 仪表盘** | 单页改造 + 统一采集入口 | 验收走 §17 清单 |
| **M6 平台横铺** | channels/douyin/bili/ks/xhs 按 §7.2 矩阵逐个接入（含各自认证适配与能力补全） | 按矩阵逐平台验收 |
| **M7 辅助能力** | 转码、订阅扩展到非公众号平台 | — |

**v1 = M0–M4**，M5–M7 为 v2。每期独立可验证、可停。

---

## 17. 验收清单（新增）

- [ ] 无 Python 的目标机器可安装并启动
- [ ] 5200/3333 被占用时有明确行为与诊断提示
- [ ] 后端异常退出后不重复启动调度器（单实例锁 + 心跳）
- [ ] 任务执行中退出应用，重开后状态可解释（interrupted/可 resume）
- [ ] 同一采集请求重试不重复产出（幂等键 + 去重索引）
- [ ] 批量任务部分失败可查询、可选择性重试
- [ ] 二维码过期/取消/客户端不支持图片均有明确路径
- [ ] 磁盘写满不留下被视为完整的产物（`.tmp` + `_COMPLETE`）
- [ ] 非授权客户端无法调用本地业务接口（令牌 + Host/Origin 校验）
- [ ] 恶意 HTML/异常文件名/路径穿越输入不突破边界（含沙箱预览）
- [ ] 日志与诊断包不含凭证（脱敏验证）
- [ ] 升级不误删 `state/` 与 `output/`；卸载前明确询问

---

## 18. 待后续细化

- SQLite 只读索引：仅在产物规模导致浏览困难时再评估（本轮明确否决）；
- stdio 适配器细节、Playwright 窗口类平台的二维码后端出图适配（M3 设计文档）；
- 打包分发的运行时选型定稿（M2 干净机验证后）；
- 各平台限额/频率参数（M6 逐平台补充能力矩阵）。

## 19. 通道与数据源变更记录

### 2026-09-06 新增：公众号爆款文章洞察（免登录发现类数据源）

- 来源：借鉴 [creator-buddy](https://github.com/SpaceZephyr/creator-buddy) 的公众号数据获取方式（其 `baokuan-article-analysis` / `gzh-explosive-content-detector` 两个 skill）。
- 数据源：第三方公开快照库「公众号爆款文章洞察-SkillHub」（每日收录 10w+/低粉爆款/原创，覆盖昨天至 30 天前）。**不需要任何登录态，不经过公众号官方接口，不受 mp_admin 200013 频控影响**。
- 实现：`backend/mp_hot.py`（客户端 + `POST /api/mp-hot/query`）；MCP 工具 `mp_hot_articles`（工具总数 46→47）；Web 采集页新增「公众号爆款洞察」卡片。
- 借鉴与裁剪：
  - 采纳：关键词查询、四榜单归一化、photoId→原文链接、对数尺度加权评分、按 photoId 去重；
  - 裁剪：其 raw-socket 无 SNI + 关闭证书校验的请求方式（实测标准 TLS 即可访问，且该方式破坏证书校验不可采纳）；其写作建议/选题公式等创作侧输出（超出本项目"只负责收集"的边界）；
  - 调整：评分权重按公众号阅读量级（10^4-10^6）缩放 1/3，避免头部全部饱和在 100。
- 闭环：洞察条目的 `oriUrl` 直接进入既有 URL 采集管线（`/api/collect/mp` → `output/` 内容库），实测 `succeeded`。上游关键词匹配偏科（泛词如「AI」常为空，细分词如「AI Agent」有效），前端提示已注明。

### 2026-09-06 修正：爆款链接采集的环境校验问题与入库守卫

- 现象：爆款洞察 → 统一采集管线的闭环验证出现假阳性——微信"环境异常/参数错误"挑战页被当作成功文章入库（无标题、182 字节）。
- 诊断：微信对 `s?__biz=…&mid=…&idx=…&sn…` 查询形态入口实施服务端环境校验（urllib / curl_cffi / headless Chromium 均被拦，带 mp_admin cookie 亦然）；`/s/{token}` 短链完全不受影响（当日 15/15 成功 vs 查询形态 0/2）。爆款库恰好只提供查询形态 oriUrl（部分 sn/chksm 还是脏数据 → 参数错误），photoId 也不能转短链（`/s/{photoId}` 返回参数错误），官方 long2short 接口已下线（404）。
- 修复：
  1. `backend/collectors/mp.py` 新增入库守卫 `_detect_blocked_page`——先认文章标记（msg_title/activity-name/js_content，防止正文提及"环境异常"误伤），再查错误页特征（环境异常/参数错误/被删除/违规），兜底空壳页；命中即该条目 failed 并给出"浏览器打开后复制短链重采"的指引，绝不再当成功入库；
  2. 清理 2 条污染条目、2 条假成功历史记录、2 条去重索引（按 value 清理，避免挡住重采）；
  3. Web 爆款卡片注明长链接可能被风控拦截的替代路径。
- 遗留：查询形态服务端抓取何时放行取决于微信策略；爆款条目采集失败属预期行为，前端已给出短链重采路径。

### 2026-09-06 生态调研：同类公众号下载仓库情报与路线影响

调研对象：TrendRadar、wechat-miniapp-radar、res-downloader、wechat-article-exporter、wechatDownload。

- **关键情报（wechat-article-exporter，12k+ star）**：已于 2026-07-30 停止维护，官方声明"项目所依赖的微信上游核心接口已被官方关闭，且大概率不会再开放"（issue #200）；其"公号三刀"后续项目仅剩少量非群发文章与阅读量/评论抓取可用。该项目的文章列表能力与本项目 mp_admin 的 appmsg 同族（公众号后台"写文章搜文章"接口）。**含义：本项目的 200013 频控不宜按"等待冷却"规划，appmsg 批量历史列表通路（含 RSS 增量调度，其实现走 `_fetch_articles_page` → appmsg）应视为不可靠依赖，不再投入增强。**
- **wechatDownload（qiye45）**：闭源二进制。机制 = 引导用户在 PC 微信客户端内置浏览器打开文章，本机抓取 key/uin/pass_ticket 凭证 → 走 `profile_ext?action=getmsg`（微信客户端接口族，非公众号后台接口）拉历史消息。与 exporter 的 Credential 通道同族。依赖 PC 客户端 + 本机抓取，无法进 Docker 服务端；仅桌面端理论可行且脆弱。**暂不采纳。**
- **res-downloader**：Go 代理嗅探抓包（视频号/小程序/直播流等），与本项目视频号 mitm 方案同族，无公众号文章能力。**对公众号下载无可借鉴点。**
- **wechat-miniapp-radar**：小程序生态技术雷达（静态资源集 + AI 选型评估），与公众号下载无关。**无可借鉴点。**
- **TrendRadar**：热搜聚合监控，不做公众号下载；其可借鉴思想（配置驱动订阅、统一响应、URL 归一化去重、output 即接口）已于早期融入本项目，无新增。
- **路线结论**：能力重心放在已验证通路——短链 `/s/{token}` 单篇/批量正文采集（15/15 成功）、searchbiz 搜号、爆款洞察发现（免登录第三方库）；单篇短链采集 + 守卫是当前最稳的公众号获取形态。若未来需要批量历史列表，唯一现实通道是微信客户端凭证族（profile_ext），属桌面端可选特性，需单独评估合规与脆弱性。
