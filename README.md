# 内容收集工作台 (Content Collect Workbench)

本地运行的多来源内容采集枢纽：**微信公众号 / 视频号 / 抖音 / 快手 / 小红书 / 哔哩哔哩** 的内容采集、媒体本地化与统一内容库，原生支持 **MCP 协议（48 个工具）** 供 AI Agent 操作，同时提供 Web 单页仪表盘与 Electron 桌面端。

> 本项目 fork 自多平台下载工具箱并完成 MCP 化与桌面端重构（详见 [docs/设计文档.md](docs/设计文档.md) 的通道演进记录）。

## 能力矩阵（诚实版）

| 能力 | 通路 | 可靠性 | 说明 |
|---|---|---|---|
| 公众号单篇/批量正文采集 | 短链 `mp.weixin.qq.com/s/{token}` | ★★★★★ | 免登录，正文归一化 + 图片本地化，落内容库 |
| 公众号搜号 | mp_admin 管理员扫码 → searchbiz | ★★★★☆ | 需管理员扫码认证（Web 或 MCP askuser 均可） |
| 公众号爆款发现 | 第三方公开快照库 | ★★★★☆ | 免登录、不受频控影响；条目可直接进采集管线 |
| 公众号批量历史列表 | appmsg（管理员通道） | ★☆☆☆☆ | 上游接口被微信收紧/关闭（生态已验证），仅作实验性 |
| 抖音 / 快手 / 小红书 / B站 | 各平台解析下载 | ★★★★☆ | 单条 + 主页批量（部分需平台登录态） |
| 视频号 | mitm 代理 + Cookie | ★★★☆☆ | 依赖代理环境，仅 Web/桌面端配置 |
| 视频转码 | FFmpeg | ★★★★★ | 格式转换 / 压缩 / 提取音频 |

**路线依据**：微信 2026-07 前后关闭了公众号后台批量同步接口族（12k+ star 的 wechat-article-exporter 因此停止维护），本项目的能力重心放在短链采集与发现类通路上。详见 [docs/ROADMAP.md](docs/ROADMAP.md)。

## 快速开始（Docker，推荐）

```bash
git clone https://github.com/zhengxingSong/content-collect-workbench.git
cd content-collect-workbench
docker compose up -d
```

- Web 仪表盘：http://127.0.0.1:5200 （全部端口仅绑定 127.0.0.1）
- MCP 端点：`http://127.0.0.1:3333/mcp`（Streamable HTTP，协议版本 2025-03-26）
- 健康检查：`curl http://127.0.0.1:3333/health`

## MCP 接入（AI Agent）

HTTP 方式（远程 agent / 桌面端共用）：

```json
{
  "mcpServers": {
    "content-collect-workbench": {
      "url": "http://127.0.0.1:3333/mcp",
      "headers": { "Authorization": "Bearer <state/service.json 中的 token>" }
    }
  }
}
```

stdio 兜底（本地客户端）：`python mcp_server.py`，同一注册表 48 工具。

完整工具清单与调用约定见 [docs/MCP工具清单.md](docs/MCP工具清单.md)。支持 **askuser 认证流**：agent 调用 `mp_start_auth` 获得二维码，用户扫码后 `mp_check_auth` 确认，全程无需打开 Web。

## 桌面端

Electron 外壳参照 llama.cpp desktop 模式：启动后监督服务进程，支持两种运行时形态（`runtimeMode: python | docker`）。构建见 [BUILD.md](BUILD.md) 与 [desktop/README.md](desktop/README.md)。

## 文档索引

| 文档 | 内容 |
|---|---|
| [docs/架构文档.md](docs/架构文档.md) | 运行时拓扑、模块职责、数据流、安全模型 |
| [docs/设计文档.md](docs/设计文档.md) | 通道演进、契约设计、关键决策与理由 |
| [docs/ROADMAP.md](docs/ROADMAP.md) | 已完成里程碑、近期改造、中期候选与生态风险 |
| [docs/MCP工具清单.md](docs/MCP工具清单.md) | 48 工具全量参考 |
| [docs/Docker部署.md](docs/Docker部署.md) | 部署细节、卷与端口、平台登录限制 |
| [docs/顶层设计-MCP化与桌面端.md](docs/顶层设计-MCP化与桌面端.md) | 原始顶层设计 + 变更记录（历史档案） |

## 合规声明

- 抓取内容仅限**个人学习、研究与本地备份**，请尊重原作者版权，避免高频批量抓取或未经授权的二次发布；
- MCP 只暴露采集/读取类操作，不暴露删除历史、清理缓存、代理启停等破坏性或系统级操作；
- 全部服务仅绑定 `127.0.0.1`，跨容器访问需持有 `state/service.json` 中的本地令牌；
- 使用本项目产生的任何数据与法律责任由使用者自行承担。
