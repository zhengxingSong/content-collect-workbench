# Docker 部署指南

> 运行时决策（2026-09-06，用户确认）：整个项目以 Docker 运行，Web 与桌面 GUI 作为前端接入。
> 解决公众号登录依赖的公共中转（weread.111965.xyz）502 问题——改用自建 wewe-rss 容器。

## 架构

```
┌─────────────────────── Docker Compose ───────────────────────┐
│  backend (5200)      mcp (3333)         wewe-rss (4000)      │
│  Flask+账号池+任务    45 工具 agent 入口   微信读书中转(自建)    │
│       ▲ 卷: ./data ./state ./output ◄─ 全部落宿主机          │
└──────────────────────────────────────────────────────────────┘
      ▲ 127.0.0.1 发布            ▲ 127.0.0.1 发布
┌──────┴───────┐          ┌────────┴────────┐
│ Web 浏览器    │          │ 桌面 GUI(Electron)│
│ localhost:5200│          │ runtimeMode=docker│
└──────────────┘          └─────────────────┘
```

## 快速开始

```bash
docker compose up -d --build     # 构建并启动全栈
# 就绪后：
#   Web      http://127.0.0.1:5200
#   MCP      http://127.0.0.1:3333/mcp   （令牌 ./state/service.json）
#   wewe-rss http://127.0.0.1:4000       （其自身的账号管理页）
docker compose stop              # 停止（保留容器与数据）
docker compose down              # 移除容器（数据仍在宿主机）
```

桌面 GUI：`%APPDATA%/内容收集工作台/config.json` 中 `"runtimeMode": "docker"`，
之后双击桌面图标即由 GUI 执行 `docker compose up -d --build` 并等待就绪后加载 Web。

## 公众号（微信读书）登录

后端容器通过环境变量 `WEREAD_PLATFORM_URL=http://wewe-rss:4000` 连接自建中转，
替代已故障的公共中转（weread.111965.xyz 502 / 备用域名证书过期）。
在 Web 仪表盘点"发起公众号账号认证"→ 扫描二维码即可。

wewe-rss 自身使用 SQLite（`data/wewe-rss/`），如需其完整文章抓取能力，
访问 http://127.0.0.1:4000 在其界面添加公众号源。

## 各平台登录方式在 Docker 模式下的形态

| 平台 | 登录方式 | Docker 模式形态 |
|---|---|---|
| 公众号（微信读书） | 中转二维码 | ✅ Web 内嵌二维码（wewe-rss 容器出码） |
| 抖音 | Playwright 扫码 | ✅ headless 运行 + Web 内嵌二维码（douyin 登录状态含 scanUrl） |
| B站 | 后端直出二维码 | ✅ 与宿主机模式一致 |
| 快手 | Playwright 窗口扫码 | ⚠️ 容器 headless 无出码字段——需宿主机模式（`python app.py`）或桌面 GUI python 模式登录 |
| 小红书 | Playwright 窗口扫码/验证码 | ⚠️ 同上 |
| 视频号 | Cookie 获取 + mitm 代理 | ⚠️ 需改写宿主机系统代理（Windows 注册表），仅宿主机模式支持 |

⚠️ 项的通用解法：`python app.py`（宿主机 dev 模式）与 Docker 模式共享 `data/`，
在宿主机登录一次，凭证落 `data/`，容器内即生效。

## 网络/镜像说明（国内环境）

构建时已内置：Debian apt → USTC、pip → USTC、Playwright 浏览器 → npmmirror。
基础镜像默认用本地 `docker-api:latest`（官方 python:3.12 派生）；Docker Hub 可达时：

```bash
docker compose build --build-arg BASE_IMAGE=python:3.12-slim backend
```

wewe-rss 镜像经国内镜像源拉取后已重打标签 `cooderl/wewe-rss-sqlite:latest`。

## 数据与升级（§17 #12）

| 宿主机路径 | 内容 | 升级/重建 |
|---|---|---|
| `./data/` | 各平台凭证、下载历史、配置 | 保留 |
| `./state/` | 服务令牌、任务断点、去重索引 | 保留 |
| `./output/` | 内容库产物（对外契约） | 保留 |

`docker compose down` 只删容器；镜像升级 = `git pull && docker compose up -d --build`。

## 公众号采集通道（2026-09-06 更新：mp_admin）

微信读书平台登录接口已被微信官方下线（原通道失效）。现改用**公众号后台管理员扫码**：

1. 仪表盘 → 待认证请求 →「公众号后台扫码认证」→ 管理员微信扫码
2. 凭证落 `data/mp_admin_config.json`，全栈（容器/宿主机）共享
3. 添加公众号：`GET /api/mp-admin/search-biz?query=名称`（官方 searchbiz）或粘贴文章链接
4. 文章列表走官方 `appmsg` 接口；单篇文章采集走公开页、无需认证

**频控说明**：新登录的管理员后台调用 `appmsg` 初期会返回 200013（freq control），
属平台策略，正常使用后台数日后自动解除；期间单篇采集不受影响。
MCP 工具 `mp_search_biz` 提供同样的搜索能力（agent 可代为搜索并添加订阅）。
