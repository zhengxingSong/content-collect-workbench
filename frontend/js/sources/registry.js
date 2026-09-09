/**
 * 来源注册表 — 全站唯一平台枚举
 * 新增来源:在此加一项,筛选器/卡片/新建任务/设置页自动出现。
 * status: 'live' 已接入(对应后端 blueprint) | 'planned' 规划槽位
 */
const SourceRegistry = {
  sources: [
    { id: 'wechat-mp',       label: '公众号',    kind: 'article', color: '#2dd98a', status: 'live',    api: 'articles', detect: [/mp\.weixin\.qq\.com/i],               desc: '文章离线下载 · 账号池 · RSS 输出' },
    { id: 'wechat-channels', label: '视频号',    kind: 'video',   color: '#58a6ff', status: 'live',    api: 'channels', detect: [/channels\/|finder\.video\.qq\.com/i], desc: '作品列表批量采集 · mitmproxy 注入' },
    { id: 'douyin',          label: '抖音',      kind: 'video',   color: '#f06a72', status: 'live',    api: 'douyin',   detect: [/douyin\.com/i],                        desc: '作品/喜欢/收藏采集 · 风控自愈' },
    { id: 'kuaishou',        label: '快手',      kind: 'video',   color: '#f5b64d', status: 'live',    api: 'kuaishou', detect: [/kuaishou\.com/i],                      desc: '单视频/主页/批量下载' },
    { id: 'xhs',             label: '小红书',    kind: 'note',    color: '#ff7aa2', status: 'live',    api: 'xhs',      detect: [/xiaohongshu\.com|xhslink\.com/i],      desc: '笔记解析与图文下载' },
    { id: 'bilibili',        label: 'B站',       kind: 'video',   color: '#7ab8ff', status: 'live',    api: 'bilibili', detect: [/bilibili\.com|b23\.tv/i],              desc: 'DASH 混流 · 弹幕字幕 · 批量' },
    { id: 'rss',             label: 'RSS 订阅',  kind: 'feed',    color: '#b5838d', status: 'live',    api: 'articles', detect: [],                                      desc: '公众号定时增量拉取 · Feed 输出' },
    { id: 'url',             label: 'URL 直链',  kind: 'any',     color: '#9aa3b2', status: 'live',    api: 'articles', detect: [/^https?:\/\//i],                       desc: '任意文章链接直接下载' },
    { id: 'zhihu',           label: '知乎',      kind: 'article', color: '#58a6ff', status: 'planned', api: null,       detect: [/zhihu\.com/i],                         desc: '规划中 · 适配器待接入' },
    { id: 'twitter',         label: 'Twitter/X', kind: 'any',     color: '#9aa3b2', status: 'planned', api: null,       detect: [/twitter\.com|x\.com/i],                desc: '规划中 · 适配器待接入' },
    { id: 'podcast',         label: '播客',      kind: 'audio',   color: '#9aa3b2', status: 'planned', api: null,       detect: [],                                      desc: '规划中 · 适配器待接入' },
  ],

  get(id) { return this.sources.find(s => s.id === id) || null; },
  live() { return this.sources.filter(s => s.status === 'live'); },
  planned() { return this.sources.filter(s => s.status === 'planned'); },

  /** 按 URL 识别来源;识别到 planned 来源也返回(带 status) */
  detect(url) {
    if (!url) return null;
    for (const s of this.sources) {
      if (s.detect.some(re => re.test(url))) return s;
    }
    return null;
  },

  kindLabel(kind) {
    return ({ article: '文章', video: '视频', note: '图文', feed: '订阅', audio: '音频', any: '通用' })[kind] || kind;
  },
};
