# 内容收集工作台 — 前端设计文档

> 版本 2.0 · content-collect-workbench · 多来源媒体内容采集与服务监控工作台
> 视觉基线:`designs/taste/index.html`(暗色 `#0b0e14` + `#2dd98a`,高密度)

## 1. 产品设计

### 1.1 定位

本地运行的多来源媒体内容采集与服务监控工作台。**微信(公众号/视频号)是第一个接入的来源,不是全部**——产品按"来源注册表"演进,新来源以适配器接入,前端不写死任何平台。

### 1.2 核心抽象:来源注册表(Sources Registry)

全站唯一平台枚举,位于 `js/sources/registry.js`:

```js
Source = {
  id: 'wechat-mp',          // 稳定 ID
  label: '公众号',           // 展示名
  kind: 'article|video|note|feed|any',
  color: '#2dd98a',          // 来源识别色
  status: 'live|planned',    // live=已接入 planned=规划槽位
  detect: [/mp\.weixin\.qq\.com/],   // URL 识别(新建任务自动路由)
  api: 'articles',           // 对应后端 blueprint 前缀
}
```

- 已接入(8):公众号、视频号、抖音、快手、小红书、B站、RSS 订阅、URL 直链
- 规划槽位(3):知乎、Twitter/X、播客——UI 中灰态展示"规划中",点击提示,不可创建任务
- 新增来源 = 注册表加一项,筛选器/卡片/新建任务/设置页自动出现

### 1.3 领域模型

| 模型 | 字段 | 对应后端 |
|---|---|---|
| Entry 内容条目 | `{id, title, source, author, kind, integrity, size, date, files[], warnings}` | `output/` 目录 + manifest(P2) |
| File 清单项 | `{name, kind: text/image/audio/video, size, sha256: ok/missing/fail}` | `metadata.json` |
| Task 采集任务 | `{id, source, title, status: running/done/failed/canceled, progress, total, done, speed}` | 各平台 download task(内存) |
| AccountPool 账号 | `{id, nickname, status: active/cooldown/banned/invalid, failures, last_used}` | `account_pool.json` |
| Service 服务 | `{id, name, url, state, uptime, restarts}` | Flask 5200 / MCP 3333 / mitmproxy / 转码队列 |
| Backup 备份 | `{id, name, size, entries, files, date, status}` | `backend/backup.py`(P2 规划) |

## 2. 信息架构(7 视图,替代旧 37 个按平台页面)

| 视图 | 路由 | 内容 |
|---|---|---|
| 总览 | `#/dashboard` | 4 KPI(今日入库/库总量/完整率/服务健康)· 实时吞吐图 · 来源健康度 · 最近动态 |
| 采集任务 | `#/collect` | 统一任务中心:进行中(SSE 轮询进度)· 新建任务(粘贴链接自动识别来源)· 历史 |
| 内容库 | `#/library` | 高密度表格 · 来源/类型/完整性/搜索多维筛选 · manifest 详情弹窗 · 批量导出 |
| 采集源 | `#/sources` | 来源注册表卡片墙:账号池/登录态/RSS 订阅 · 启停 · 巡检 |
| 服务监控 | `#/services` | 后端/MCP/mitmproxy/转码 面板 · 运行日志流 · 故障预算 |
| 备份恢复 | `#/backup` | 4 步向导(预检→确认→执行→结果)· 备份历史 · 恢复;**凭证不纳入备份** |
| 设置 | `#/settings` | 采集行为 / 网络与代理 / 来源凭据(按来源分 tab) / 关于 |

## 3. 布局

```
.app { grid-template-columns: 248px 1fr; height: 100dvh }
├── .sidebar   品牌 · 导航(工作台组/基础设施组/数据安全组) · 底部服务状态点
└── .main
    ├── .topbar  面包屑 · 全局搜索(⌘K) · 数据源徽标(实时/模拟) · 状态点
    └── .view-wrap  { flex:1; overflow:auto }  → .view.active
```

- 860px 以下:侧栏收窄为 64px 图标栏;1180px 以下网格降为单列
- 数字一律 mono 字体;动效统一 `--spring` / `--ease` 曲线

## 4. 视觉令牌(tokens.css)

沿用 Taste 基线:`--bg:#0b0e14`、`--accent:#2dd98a`、`--amber/--rose/--sky` 语义色、`--radius:18px`、面板双层描边 `--line/--line-2`、body 双径向渐变背景。来源色仅用于来源 pill 与卡片边线,不参与全局语义。

## 5. 组件清单(components.css)

`kpi` 指标卡 · `panel` 面板 · `chip` 筛选片(单选/多选) · `seg` 分段控件 · `table` 高密度表 · `integrity` 完整性 pill · `pill` 来源徽标 · `source-card` 来源卡 · `task-row` 任务行(进度条) · `modal/overlay` 弹窗 · `toast` 右下提示 · `spark` SVG 迷你图 · `log` 日志流 · `steps` 向导步条 · `toggle` 开关 · `pagination` 分页 · `empty/skeleton` 空态骨架

## 6. 数据层(api.js)

**Mock 优先 + 真实 API 适配**:

1. 所有请求先走真实端点(按后端 blueprint:`/api/articles/*`、`/api/account-pool/*`、`/api/settings` 等),短超时探测
2. 任一失败(网络/404/CORS)→ 自动降级 `js/mock/data.js` 中**与真实契约同形**的演示数据
3. topbar 徽标实时显示当前数据源(实时=绿 / 模拟=琥珀),点击可查看探测详情
4. 内容库/备份等 P2 未实现端点(`/api/library/*`、`/api/backup/*`)固定走 mock,后端就绪后零改动接通

## 7. 工程结构

```
frontend/
├── index.html          # 壳,按序加载脚本(无构建、无依赖)
├── DESIGN.md
├── css/ tokens.css base.css components.css views.css
└── js/
    ├── app.js          # 导航配置 + 启动
    ├── router.js       # hash 路由(沿用旧约定,页面级缓存)
    ├── api.js          # 适配层
    ├── mock/data.js
    ├── sources/registry.js
    ├── components/     # ui.js(toast/modal/工具) charts.js
    └── views/          # dashboard collect library sources services backup settings
```

## 8. 兼容性

- 入口仍为 `frontend/index.html`,`app.py` 与 Electron 壳(`loadURL(backendUrl)`)零改动加载
- 旧版完整备份于 `frontend.bak-20260909/`,可随时回退
