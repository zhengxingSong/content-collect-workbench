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
  };

  function notify() { state.listeners.forEach(fn => { try { fn(state.mode); } catch (e) { /* noop */ } }); }
  function onMode(fn) { state.listeners.push(fn); fn(state.mode); }

  async function raw(url, opts = {}) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), opts.timeout || TIMEOUT);
    try {
      const resp = await fetch(url, { ...opts, signal: ctl.signal, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
      const text = await resp.text();
      let data; try { data = JSON.parse(text); } catch { throw new Error(`非 JSON 响应 (HTTP ${resp.status})`); }
      if (!resp.ok) throw new Error(data.error || data.message || `HTTP ${resp.status}`);
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

    // ── 探测 ──
    async probe() {
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

    // ── 内容库(P2 端点,当前固定 Mock) ──
    library: {
      list: (q = {}) => Promise.resolve({ entries: Mock.entries, total: Mock.entries.length, ...q }),
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
  };
  return api;
})();
