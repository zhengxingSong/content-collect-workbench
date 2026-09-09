/**
 * Mock 数据 — 与真实后端契约同形
 * 真实端点不可达时由 api.js 降级使用;后端就绪后零改动接通。
 */
const Mock = (() => {
  const seeded = (i, salt) => Math.abs(Math.sin(i * 37.13 + (salt || 0) * 7.7) * 10000) % 1;
  const pad = n => String(n).padStart(2, '0');
  const dateAgo = i => {
    const d = new Date(Date.now() - Math.floor(seeded(i, 3) * 60 * 86400 * 1000));
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const sizeLabel = i => {
    const mb = 0.3 + seeded(i, 5) * 180;
    return mb > 100 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(1)} MB`;
  };

  const TITLES = {
    'wechat-mp': ['深度解读:多模态模型的推理边界', '一篇讲透 RAG 检索优化的实践笔记', '从零搭建本地知识库的完整指南', '大模型时代的个人数据管理', 'Agent 记忆系统的三种设计范式', '为什么你的 Prompt 总是失效', '本地部署开源模型的硬件清单', 'MCP 协议入门:连接一切工具'],
    'wechat-channels': ['三分钟看懂扩散模型', '城市夜景延时摄影合集', '极简办公桌搭建 Vlog', '咖啡冲煮手法全解析'],
    'douyin': ['手冲咖啡入门合集 P1-P8', '厨房收纳改造前后对比', '骑行通勤装备分享'],
    'kuaishou': ['东北早市烟火气记录', '老手艺:手工木梳制作'],
    'xhs': ['24 平米小家改造全记录', '通勤胶囊衣橱清单', '平价护肤成分党指南', '一人食一周备菜计划'],
    'bilibili': ['【4K】航线全景纪录:从北京到里斯本', 'STM32 外设从入门到精通(全42讲)', '史上最全 FFmpeg 命令速查', '独立开发者一年做了什么'],
    'rss': ['周刊第 128 期:端侧模型的夏天', '周刊第 127 期:检索增强的正确姿势'],
    'url': ['产品发布会完整文字实录', '技术分享:一次线上事故复盘'],
  };
  const AUTHORS = { 'wechat-mp': ['机器之心', '量子位', '少数派', '开源前线', '晚点聊'], 'wechat-channels': ['山野食集', '科技显影'], 'douyin': ['慢速生活', '城市漫游'], 'kuaishou': ['市井观察'], 'xhs': ['小宅改造日记', '轻装上阵'], 'bilibili': ['硬件茶谈', '影视飓风', '程序员鱼皮'], 'rss': ['阮一峰周刊'], 'url': ['外部链接'] };

  const entries = [];
  let id = 1000;
  for (const src of SourceRegistry.live()) {
    if (src.id === 'url') continue;
    const titles = TITLES[src.id] || ['未命名条目'];
    const authors = AUTHORS[src.id] || ['未知来源'];
    const n = src.id === 'wechat-mp' ? 96 : src.id === 'bilibili' ? 64 : src.id === 'xhs' ? 48 : src.id === 'rss' ? 40 : 20;
    for (let i = 0; i < n; i++) {
      const r = seeded(id, src.id.length);
      const integrity = r < 0.06 ? 'corrupt' : r < 0.22 ? 'partial' : 'complete';
      const title = titles[i % titles.length] + (i >= titles.length ? ` #${Math.floor(i / titles.length) + 1}` : '');
      const files = [];
      if (integrity !== 'corrupt' || seeded(id, 9) > .5) files.push({ name: 'content.md', kind: 'text', sha: integrity === 'complete' ? 'ok' : 'missing' });
      const imgs = 2 + Math.floor(seeded(id, 1) * 12);
      for (let k = 0; k < imgs; k++) files.push({ name: `media/img_${pad(k + 1)}.jpg`, kind: 'image', sha: integrity === 'complete' ? 'ok' : (seeded(id + k, 2) < .3 ? 'missing' : 'ok') });
      if (src.kind === 'video' || seeded(id, 4) > .8) files.push({ name: `media/video_${pad(1)}.mp4`, kind: 'video', sha: integrity === 'corrupt' ? 'fail' : 'ok' });
      if (seeded(id, 6) > .75) files.push({ name: `media/audio_${pad(1)}.mp3`, kind: 'audio', sha: integrity === 'complete' ? 'ok' : 'missing' });
      entries.push({
        id: `art_${id}`, title, source: src.id, author: authors[i % authors.length],
        kind: src.kind, integrity, size: sizeLabel(id), date: dateAgo(id),
        warnings: integrity === 'complete' ? [] : integrity === 'partial' ? ['部分图片资源缺失,已记录 leftover_urls'] : ['正文文件缺失,条目不可读'],
        files,
      });
      id++;
    }
  }
  entries.sort((a, b) => b.date.localeCompare(a.date));

  const tasks = [
    { id: 'task_a1', source: 'bilibili', title: 'STM32 外设从入门到精通(全42讲)· 批量 42 项', status: 'running', done: 27, total: 42, speed: '12.4 MB/s', eta: '约 6 分钟' },
    { id: 'task_a2', source: 'wechat-mp', title: '公众号「机器之心」增量拉取 · RSS 调度', status: 'running', done: 8, total: 12, speed: '3.1 MB/s', eta: '约 2 分钟' },
    { id: 'task_a3', source: 'xhs', title: '笔记合集:通勤胶囊衣橱(9 篇)', status: 'running', done: 9, total: 9, speed: '—', eta: '即将完成' },
    { id: 'task_b1', source: 'douyin', title: '喜欢列表采集 · 86 条', status: 'done', done: 86, total: 86, speed: '—', eta: '' },
    { id: 'task_b2', source: 'wechat-channels', title: '「科技显影」作品列表 · 增量 14 条', status: 'done', done: 14, total: 14, speed: '—', eta: '' },
    { id: 'task_c1', source: 'kuaishou', title: '单视频下载:老手艺:手工木梳制作', status: 'failed', done: 0, total: 1, speed: '—', eta: '', error: '风控拦截(200013),账号已冷却,建议更换账号后重试' },
    { id: 'task_c2', source: 'url', title: '产品发布会完整文字实录', status: 'canceled', done: 3, total: 10, speed: '—', eta: '' },
  ];

  const pools = {
    'wechat-mp': [
      { id: 'acc_01', nickname: '公众号_caiji100', status: 'active', failures: 0, last_used: '2 分钟前' },
      { id: 'acc_02', nickname: 'weread_kx29f', status: 'active', failures: 1, last_used: '18 分钟前' },
      { id: 'acc_03', nickname: 'weread_m8a2c', status: 'cooldown', failures: 3, last_used: '41 分钟前' },
      { id: 'acc_04', nickname: 'weread_p0d71', status: 'banned', failures: 9, last_used: '3 小时前' },
    ],
    'douyin': [{ id: 'dy_01', nickname: '慢速生活(主号)', status: 'active', failures: 0, last_used: '5 分钟前' }],
    'bilibili': [{ id: 'bili_01', nickname: 'archive_bot', status: 'active', failures: 0, last_used: '1 分钟前' }],
    'xhs': [{ id: 'xhs_01', nickname: '采集专用', status: 'cooldown', failures: 2, last_used: '26 分钟前' }],
  };

  const rssSubs = [
    { fakeid: 'MzIwNzA1', nickname: '机器之心', last_sync: '08:32', items: 214, enabled: true },
    { fakeid: 'MzA3MDMy', nickname: '少数派', last_sync: '08:31', items: 189, enabled: true },
    { fakeid: 'Mzk0NTIx', nickname: '开源前线', last_sync: '07:58', items: 96, enabled: false },
  ];

  const services = [
    { id: 'backend', name: 'Flask 后端', url: '127.0.0.1:5200', state: 'running', uptime: '3 天 04:12:51', restarts: 0, role: 'API + SPA 服务' },
    { id: 'mcp', name: 'MCP 服务', url: '127.0.0.1:3333', state: 'running', uptime: '3 天 04:12:47', restarts: 0, role: '3 个工具 · stdio/HTTP' },
    { id: 'mitm', name: 'mitmproxy', url: '127.0.0.1:8080', state: 'idle', uptime: '—', restarts: 1, role: '视频号 HTTPS 注入' },
    { id: 'ffmpeg', name: '转码队列', url: 'FFmpeg', state: 'running', uptime: '随按需负载', restarts: 0, role: '硬件加速 · DASH 混流' },
  ];

  const backups = [
    { id: 'bk_0042', name: '内容库全量备份', size: '12.8 GB', entries: 321, files: 28411, date: dateAgo(2), status: 'done', type: 'full' },
    { id: 'bk_0041', name: '内容库增量备份', size: '340 MB', entries: 36, files: 812, date: dateAgo(3), status: 'done', type: 'inc' },
    { id: 'bk_0040', name: '内容库全量备份', size: '12.1 GB', entries: 269, files: 27103, date: dateAgo(10), status: 'done', type: 'full' },
  ];

  const feed = [
    { ico: 'ok', html: '<b>B站</b> 批量任务完成 27/42 · <b>STM32 外设</b>', time: '刚刚' },
    { ico: 'warn', html: '<b>快手</b> 任务触发风控 200013,账号进入 10 分钟冷却', time: '6 分钟前' },
    { ico: 'ok', html: '<b>小红书</b> 9 篇图文入库,完整性 complete', time: '14 分钟前' },
    { ico: 'sky', html: '<b>RSS</b> 「机器之心」定时拉取新增 4 篇', time: '31 分钟前' },
    { ico: 'ok', html: '<b>公众号</b> 文章《Agent 记忆系统的三种设计范式》sha256 校验通过', time: '47 分钟前' },
    { ico: 'err', html: '<b>公众号</b> 账号 weread_p0d71 连续失败 8 次,标记 invalid', time: '1 小时前' },
  ];

  const logs = [];
  const LOG_SRC = [['b', '后端'], ['m', 'mcp'], ['p', '转码']];
  const LOG_MSG = [
    ['info', 'GET /api/library/list 200 · {page:1} 12ms'],
    ['info', 'SSE download-progress task_a1 → 27/42'],
    ['warn', '账号池调度:acc_03 冷却中,跳过'],
    ['info', 'sha256 校验通过 media/img_07.jpg'],
    ['info', 'FFmpeg 混流完成 DASH→MP4 1080p'],
    ['err', 'kuaishou 下载失败 200013'],
    ['info', 'RSS 增量同步 「少数派」 +2'],
    ['info', 'manifest 重建 dedup_index 321 条'],
  ];
  for (let i = 0; i < 24; i++) {
    const [cls, name] = LOG_SRC[i % 3];
    const [lv, msg] = LOG_MSG[i % LOG_MSG.length];
    logs.push({ cls, name, lv, msg, t: `${pad(9 + Math.floor(i / 4))}:${pad((i * 13) % 60)}:${pad((i * 29) % 60)}` });
  }

  const settings = {
    download_dir: 'E:/Tools/content-collect-workbench/output',
    page_size: 10, max_articles: 50, max_retries: 3, request_delay: 0.8,
    concurrent_downloads: 1, auto_save_images: true, auto_save_videos: true,
    rss_upload_enabled: false, rss_upload_url: '',
    appid: 'wxYOUR_APPID_PLACEHOLDER', proxy: '',
  };

  const stats = () => {
    const bySource = {};
    for (const s of SourceRegistry.live()) bySource[s.id] = entries.filter(e => e.source === s.id).length;
    const complete = entries.filter(e => e.integrity === 'complete').length;
    return { total: entries.length, today: 23, complete, completePct: Math.round(complete / entries.length * 100), bySource };
  };

  return { entries, tasks, pools, rssSubs, services, backups, feed, logs, settings, stats, seeded };
})();
