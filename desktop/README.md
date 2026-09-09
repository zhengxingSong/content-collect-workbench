# 内容收集工作台 — 桌面端

Electron 外壳，参照 llama.cpp desktop 模式：启动后自动拉起并监督全部服务。

## 被监督的服务

| 服务 | 命令 | 就绪探针 | 说明 |
|---|---|---|---|
| Flask 后端 | `venv312 python app.py --no-browser --port 5200` | `GET /api/settings` | 业务、账号池、RSS 调度 |
| MCP HTTP | `venv312 python -m backend.mcp_server --port 3333` | `GET /health` | agent 接入；后端地址经 `CONTENT_COLLECT_WORKBENCH_URL` 注入 |

- **就绪分层**：进程存活 → HTTP 就绪 → 窗口加载 SPA（未就绪时显示等待页并自动重试）。
- **故障预算**：每服务 5 次/小时滑动窗口，指数退避 + 随机抖动；配置错误（Python 缺失、端口冲突）不重启，直接弹窗报错。
- **退出顺序**：`will-quit` → 全部子进程 `taskkill /T /F`；状态保存与 mitm 清理由后端自身负责。

## 行为

- 托盘常驻，关窗隐藏到托盘；托盘菜单可显示窗口或退出（默认停止全部服务）。
- 强制单实例，重复双击唤起已有窗口。
- 外部链接交给系统浏览器打开，不在桌面特权页面内导航。
- 渲染层 `contextIsolation + sandbox`，无 nodeIntegration（设计文档 §4）。

## 配置与日志

- 配置：`%APPDATA%/内容收集工作台/config.json`（backendPort / mcpPort / host）
- 日志：`%APPDATA%/内容收集工作台/logs/services.log`（5MB 轮转）

## 开发与打包

```bash
pnpm install        # Electron 二进制下载需要放行构建脚本（package.json 已配置）
pnpm start          # 开发运行
pnpm dist           # electron-builder NSIS 打包，产物在 release/
```

> 注意：`pnpm start` 直接运行；若 venv312 不存在会回退到系统 `python`。
> 干净机器分发（embeddable Python、FFmpeg、原生依赖）验证属 M2 验收项，见设计文档 §16。
