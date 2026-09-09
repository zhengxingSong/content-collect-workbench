/**
 * API 适配层 — 真实端点优先,失败自动降级 Mock
 * - 探测短超时(2.5s),任何失败(网络/404/解析)走 Mock,视图无感知
 * - topbar 徽标实时显示当前数据源(实时/模拟),由 onMode 订阅通知
 * - P2 未实现端点(library/backup)固定走 Mock,后端就绪后零改动接通
 */
const API = (() => {
  const TIMEOUT = 2500;
  const state = {
    mode: 'probing',          // probing | live | mock
    lastProbe: 0,             // 最近一次成功真实请求时间
    probes: [],               // 探测记录 {name, ok, detail}
    listeners: [],
    token: '',
  };

  function notify() { state.listeners.forEach(fn => { try { fn(state.mode); } catch (e) { /* noop */ } }); }
  function onMode(fn) { state.listeners.push(fn); fn(state.mode); }

  async function raw(url, opts = {}) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), opts.timeout || TIMEOUT);
    try {
      const authHd = state.token ? { 'Authorization': `Bearer ${state.token}` } : {};
      const resp = await fetch(url, { ...opts, signal: ctl.signal, headers: { 'Content-Type': 'application/json', ...authHd, ...(opts.headers || {}) } });
      const text = await resp.text();
      let data; try { data = JSON.parse(text); } catch { throw new Error(`非 JSON 响应 (HTTP ${resp.status})`); }
      if (!resp.ok) {
        // 后端错误是 {error:{code,message}} 对象,取可读 message(避免 [object Object])
        const em = data && data.error && (data.error.message || data.error.code);
        const msg = em || (data && data.message) || (data && data.summary) || `HTTP ${resp.status}`;
        throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
      }
      return data;
    } finally { clearTimeout(timer); }
  }

  /** 真实优先 + Mock 降级:name 用于徽标探测记录;mock 为降级取值 */
  async function call(name, url, opts, mock) {
    try {
      const data = await raw(url, opts);
      state.mode = 'live'; state.lastProbe = Date.now();
      state.probes.push({ name, ok: true, detail: url });
      notify();
      return data;
    } catch (err) {
      state.probes.push({ name, ok: false, detail: `${url} → ${err.message}` });
      state.probes = state.probes.slice(-40);
      if (!(state.lastProbe && Date.now() - state.lastProbe < 30000)) { state.mode = 'mock'; notify(); }
      return typeof mock === 'function' ? mock() : mock;
    }
  }

  const api = {
    state, onMode,
    get probes() { return state.probes; },

    /**
     * 动作型请求(live 模式直接调真实端点,失败抛错;demo 模式返回 mock)
     * 用于下载提交/登录发起等"必须区分真实成败"的操作
     */
    async act(name, url, opts, mock) {
      if (state.mode !== 'live') return typeof mock === 'function' ? mock() : { ...mock, mock: true };
      try {
        const data = await raw(url, opts);
        state.probes.push({ name, ok: true, detail: url });
        return data;
      } catch (err) {
        state.probes.push({ name, ok: false, detail: `${url} → ${err.message}` });
        throw err;
      }
    },

    /**
     * 真实数据 GET:live 模式失败抛错(视图显示空态/错误,绝不静默回退假数据);
     * mock 模式返回兜底数据。返回体已拆包 {summary, data} → data
     */
    async liveGet(name, url, mock) {
      if (state.mode !== 'live') {
        const m = typeof mock === 'function' ? mock() : mock;
        return m && m.data !== undefined ? m.data : m;
      }
      const resp = await raw(url);
      state.probes.push({ name, ok: true, detail: url });
      return resp && resp.data !== undefined ? resp.data : resp;
    },

    // ── 探测 ──
    async probe() {
      try { state.token = (await raw('/api/local/token', { timeout: 1800 })).token || ''; } catch (e) { state.token = ''; }
      try { await raw('/api/settings', { timeout: 1800 }); state.mode = 'live'; state.lastProbe = Date.now(); }
      catch (err) { state.mode = 'mock'; }
      state.probes.push({ name: 'probe', ok: state.mode === 'live', detail: state.mode === 'live' ? '/api/settings 200' : '后端不可达,演示数据模式' });
      notify();
      return state.mode;
    },

    // ── 设置(真实: /api/settings) ──
    settings: {
      get: () => call('settings', '/api/settings', {}, Mock.settings),
      save: patch => call('settings', '/api/settings', { method: 'POST', body: JSON.stringify(patch) }, ({ ok: true, ...patch })),
    },

    // ── 内容库(真实端点 /api/library/*;mock 模式用演示数据映射成同形) ──
    library: {
      list: (params = {}) => api.liveGet('lib', `/api/library/entries?${new URLSearchParams({ page_size: 200, ...params })}`, () => ({
        entries: Mock.entries.map(e => ({
          id: e.id, title: e.title, author: e.author, platform: e.source,
          collect_time: e.date.replace(' ', 'T') + ':00', publish_time: null,
          collection_status: e.integrity, file_count: e.files.length,
          media_count: e.files.filter(f => f.kind !== 'text').length,
          failed_media_count: e.files.filter(f => f.sha !== 'ok').length,
          warning_count: e.warnings.length, total_bytes: parseFloat(e.size) * 1048576 || 0,
          dir: '', warnings: e.warnings, files: e.files,
        })), total: Mock.entries.length, page: 1, page_size: 200, has_more: false,
      })),
      detail: id => api.liveGet('lib-d', `/api/library/entries/${id}`, () => {
        const e = Mock.entries.find(x => x.id === id);
        return { entry: e ? { ...e, platform: e.source, collection_status: e.integrity, collect_time: e.date, total_bytes: parseFloat(e.size) * 1048576 || 0, files: e.files.map(f => ({ path: f.name, kind: f.kind, status: f.sha, size: 0 })) } : null };
      }),
      exportEntries: (ids, dest) => api.act('lib-export', '/api/library/export', { method: 'POST', body: JSON.stringify({ entry_ids: ids, dest }) }, { exported: ids.length }),
      openFolder: id => api.act('lib-dir', `/api/library/entries/${id}/open-folder`, { method: 'POST' }, { message: '已打开(演示)' }),
      files: id => api.liveGet('lib-f', `/api/library/entries/${id}/files`, () => {
        const e = Mock.entries.find(x => x.id === id);
        return { entry_id: id, dir: '', files: (e ? e.files : []).map(f => ({ path: f.name || f.path, size: 0 })), total: e ? e.files.length : 0 };
      }),
      previewUrl: id => `/api/library/entries/${id}/preview`,
      fileUrl: (id, path) => `/api/library/entries/${id}/file?path=${encodeURIComponent(path)}`,
      downloadEntryUrl: id => `/api/library/entries/${id}/download`,
      backups: {
        list: () => api.liveGet('bk-list', '/api/library/backup/list', () => ({ backups: Mock.backups.map(b => ({ name: b.name + '.zip', path: b.id, size: 13762560000 * Math.random(), mtime_h: b.date, entries: b.entries, files: b.files, type: b.type })) })),
        create: () => api.act('bk', '/api/library/backup', { method: 'POST', body: '{}' }, { mock: true }),
        validate: path => api.act('bk-v', '/api/library/restore/validate', { method: 'POST', body: JSON.stringify({ path }) }, { valid: true, mock: true }),
        restore: body => api.act('bk-r', '/api/library/restore', { method: 'POST', body: JSON.stringify(body) }, { mock: true }),
      },
    },

    // ── 统一采集任务(真实端点 /api/collect/*) ──
    collect: {
      tasks: () => api.liveGet('tasks', '/api/collect/tasks', () => ({
        tasks: Mock.tasks.map(t => ({
          task_id: t.id, platform: t.source === 'wechat-mp' ? 'mp' : t.source, kind: 'collect',
          status: t.status === 'running' ? 'running' : t.status === 'done' ? 'succeeded' : t.status === 'canceled' ? 'cancelled' : 'failed',
          progress: { done: t.done, failed: 0, skipped: 0, total: t.total },
          params: { urls: [t.title] }, error: t.error || null, created_at: Date.now() / 1000,
        })),
      })),
      detail: id => api.liveGet('task', `/api/collect/tasks/${id}`, () => ({ task: null })),
      createMp: (urls, idem) => api.act('collect-mp', '/api/collect/mp', { method: 'POST', body: JSON.stringify({ urls, idempotency_key: idem }) }, { task_id: `t_${Date.now()}`, status: 'running', mock: true }),
      cancel: id => api.act('task-c', `/api/collect/tasks/${id}/cancel`, { method: 'POST' }, { message: '已取消(演示)' }),
      retryFailed: id => api.act('task-r', `/api/collect/tasks/${id}/retry-failed`, { method: 'POST' }, { message: '已重试(演示)' }),
      detect: url => api.act('detect', '/api/collect/detect-url', { method: 'POST', body: JSON.stringify({ url }) }, { platform: null, mock: true }),
    },

    // ── 订阅与批量(组识别:UP主/主页/博主,真实端点) ──
    subs: {
      biliParse: url => api.act('sub-bp', '/api/bilibili/accounts/parse', { method: 'POST', body: JSON.stringify({ url }) }, { mid: '0', nickname: '演示UP主' }),
      biliAccounts: () => api.liveGet('sub-ba', '/api/bilibili/accounts', () => ({ accounts: [], total: 0 })),
      biliAdd: acc => api.act('sub-badd', '/api/bilibili/accounts', { method: 'POST', body: JSON.stringify(acc) }, { message: '已添加(演示)' }),
      biliRemove: mid => api.act('sub-bdel', `/api/bilibili/accounts/${mid}`, { method: 'DELETE' }, { message: '已退订(演示)' }),
      biliVideos: (mid, page = 1) => api.liveGet('sub-bv', `/api/bilibili/accounts/${mid}/videos?page=${page}`, () => ({ videos: [], total: 0 })),
      biliBatch: items => api.act('sub-bb', '/api/bilibili/download-batch', { method: 'POST', body: JSON.stringify({ items }) }, { message: '批量下载已启动(演示)', task_started: true, mock: true }),
      douyinUserDetail: url => api.act('sub-dud', `/api/douyin/user-detail?url=${encodeURIComponent(url)}`, {}, { sec_uid: '', mock: true }),
      douyinDownloadUser: (secUid, types, maxPages) => api.act('sub-du', '/api/douyin/download-user', { method: 'POST', body: JSON.stringify({ sec_uid: secUid, types, max_pages: maxPages }) }, { message: '批量已启动(演示)', mock: true }),
      ksProfile: (url, maxPages) => api.act('sub-kp', '/api/kuaishou/download-profile', { method: 'POST', body: JSON.stringify({ url, max_pages: maxPages }) }, { message: '主页批量已启动(演示)', mock: true }),
      xhsParse: url => api.act('sub-xp', '/api/xhs/accounts/parse', { method: 'POST', body: JSON.stringify({ url }) }, { user_id: 'demo', nickname: '演示博主', mock: true }),
      xhsNotes: uid => api.liveGet('sub-xn', `/api/xhs/accounts/${uid}/notes`, () => ({ notes: [] })),
      xhsDownloadNotes: (notes, accountName) => api.act('sub-xd', '/api/xhs/download-notes', { method: 'POST', body: JSON.stringify({ notes, account_name: accountName }) }, { message: '笔记下载已启动(演示)', task_id: `xhs_${Date.now()}`, mock: true }),
    },

    // ── 公众号收藏账号 + RSS 订阅(真实端点) ──
    accounts: {
      list: () => api.liveGet('acc', '/api/accounts', () => ({ accounts: [], total: 0 })),
      rss: () => api.liveGet('rss', '/api/rss/subscriptions', () => ({ subscriptions: Mock.rssSubs.map(r => ({ fakeid: r.fakeid, nickname: r.nickname, enabled: r.enabled, last_sync: r.last_sync, items: r.items })) })),
      rssToggle: (fakeid, on) => on
        ? api.act('rss-sub', '/api/rss/subscriptions', { method: 'POST', body: JSON.stringify({ fakeid, nickname: fakeid }) }, { ok: true })
        : api.act('rss-unsub', `/api/rss/subscriptions/${fakeid}`, { method: 'DELETE' }, { ok: true }),
    },

    // ── 任务(真实: /api/articles/*;演示聚合) ──
    tasks: {
      active: () => call('tasks', '/api/articles/history', {}, Mock.tasks.filter(t => t.status === 'running')),
      history: () => call('tasks', '/api/articles/history', {}, Mock.tasks),
      /** 新建任务:真实环境走 detect-url 识别后的对应端点;demo 中模拟 */
      create: payload => call('create', '/api/articles/download-url', { method: 'POST', body: JSON.stringify(payload) }, { ok: true, task_id: `task_${Date.now()}` }),
      cancel: id => call('cancel', `/api/articles/download-cancel/${id}`, { method: 'POST' }, { ok: true }),
    },

    // ── 账号池(真实: /api/account-pool/summary) ──
    pools: {
      summary: () => call('pools', '/api/account-pool/summary', {}, Mock.pools),
      verify: () => call('verify', '/api/account-pool/verify-all', { method: 'POST' }, { ok: true }),
    },

    // ── RSS 订阅(真实: /api/accounts/rss-subscriptions) ──
    rss: {
      list: () => call('rss', '/api/accounts/rss-subscriptions', {}, Mock.rssSubs),
    },

    // ── 备份(P2 端点,当前固定 Mock;备份/恢复仅限 Web 人工,不走 MCP) ──
    backup: {
      list: () => Promise.resolve(Mock.backups),
      create: payload => Promise.resolve({ ok: true, id: `bk_${Date.now()}`, ...payload }),
    },

    // ── 各平台单条下载(按来源注册表路由;live 失败抛错,demo 走 mock) ──
    downloadSingle: {
      'wechat-mp':       urls => api.act('dl-mp',  '/api/collect/mp', { method: 'POST', body: JSON.stringify({ urls }) }, { ok: true, task_id: `t_${Date.now()}` }).then(r => (r && r.data) || r),
      'rss':             urls => api.act('dl-rss', '/api/collect/mp', { method: 'POST', body: JSON.stringify({ urls }) }, { ok: true, task_id: `t_${Date.now()}` }).then(r => (r && r.data) || r),
      'url':             urls => api.act('dl-url', '/api/collect/mp', { method: 'POST', body: JSON.stringify({ urls }) }, { ok: true, task_id: `t_${Date.now()}` }).then(r => (r && r.data) || r),
      'douyin':          url  => api.act('dl-dy',  '/api/douyin/download-single', { method: 'POST', body: JSON.stringify({ url }) }, { ok: true, message: '下载成功' }),
      'kuaishou':        url  => api.act('dl-ks',  '/api/kuaishou/download-single', { method: 'POST', body: JSON.stringify({ url }) }, { ok: true, message: '下载成功' }),
      'bilibili':        url  => api.act('dl-bili','/api/bilibili/download-single', { method: 'POST', body: JSON.stringify({ url }) }, { ok: true, task_started: true, message: '下载已启动' }),
      'xhs':             urls => api.act('dl-xhs', '/api/xhs/download', { method: 'POST', body: JSON.stringify({ urls }) }, { ok: true, task_id: `xhs_${Date.now()}`, count: urls.length }),
      'wechat-channels': url  => api.act('dl-ch',  '/api/channels/download', { method: 'POST', body: JSON.stringify({ url }) }, { ok: true, message: '下载成功' }),
    },

    // ── 后台任务进度(轮询;GET 失败自动降级 mock) ──
    progress: {
      bilibili: () => call('prog-bili', '/api/bilibili/progress', {}, { status: 'idle' }),
      xhs: id => call('prog-xhs', `/api/xhs/download-status/${id}`, {}, { status: 'done' }),
    },

    // ── 各平台认证(对照后端 auth blueprint) ──
    auth: {
      douyin: {
        start:  () => api.act('au-dy',  '/api/douyin/auth/start',  { method: 'POST' }, { message: '已启动登录流程' }),
        status: () => call('au-dy-s',   '/api/douyin/auth/status', {}, { status: 'idle', message: '演示模式' }),
        cancel: () => api.act('au-dy-c','/api/douyin/auth/cancel', { method: 'POST' }, { message: '已取消' }),
      },
      kuaishou: {
        start:  () => api.act('au-ks',  '/api/kuaishou/auth/start',  { method: 'POST' }, { message: '已启动登录流程' }),
        status: () => call('au-ks-s',   '/api/kuaishou/auth/status', {}, { status: 'idle', message: '演示模式' }),
        cancel: () => api.act('au-ks-c','/api/kuaishou/auth/cancel', { method: 'POST' }, { message: '已取消' }),
      },
      xhs: {
        start:  () => api.act('au-xhs',   '/api/xhs-auth/login',  { method: 'POST' }, { message: '已启动登录流程' }),
        status: () => call('au-xhs-s',    '/api/xhs-auth/status', {}, { status: 'idle', message: '演示模式' }),
        logout: () => api.act('au-xhs-o', '/api/xhs-auth/logout', { method: 'POST' }, { message: '已退出' }),
      },
      bilibili: {
        status: () => api.liveGet('au-bili-s', '/api/bilibili-auth/status', () => ({ logged_in: false, message: '演示模式' })),
        qrGenerate: () => api.act('au-bili', '/api/bilibili-auth/qrcode/generate', {}, { url: 'demo://qr', qrcode_key: 'demo' }),
        qrSvg: data => `/api/bilibili-auth/qrcode/svg?data=${encodeURIComponent(data)}`,
        poll: key => api.act('au-bili-p', '/api/bilibili-auth/qrcode/poll', { method: 'POST', body: JSON.stringify({ qrcode_key: key }) }, { status: 'not_scanned' }),
        logout: () => api.act('au-bili-o', '/api/bilibili-auth/logout', { method: 'POST' }, { message: '已退出' }),
      },
      wechatChannels: {
        cookieStart:  () => api.act('au-ch',  '/api/channels/start_cookie_acquisition', { method: 'POST' }, { message: '已启动 Cookie 获取' }),
        cookieStatus: () => call('au-ch-s',   '/api/channels/cookie_acquisition_status', {}, { status: 'idle', message: '演示模式' }),
        proxyStatus:  () => call('au-ch-p',   '/api/channels/proxy/status', {}, { running: false }),
        proxyStart:   () => api.act('au-ch-p1','/api/channels/proxy/start', { method: 'POST' }, { message: '代理已启动' }),
        installCert:  () => api.act('au-ch-c','/api/channels/proxy/install-cert', { method: 'POST' }, { message: '证书已安装' }),
      },
      mpAdmin: {
        status: () => call('au-mp-s',  '/api/mp-admin/status', {}, { logged_in: false, message: '演示模式' }),
        login:  () => api.act('au-mp',  '/api/mp-admin/login', { method: 'POST' }, { message: '已启动扫码' }),
        cancel: () => api.act('au-mp-c','/api/mp-admin/cancel', { method: 'POST' }, { message: '已取消' }),
        logout: () => api.act('au-mp-o','/api/mp-admin/logout', { method: 'POST' }, { message: '已退出' }),
      },
    },
  };
  return api;
})();
