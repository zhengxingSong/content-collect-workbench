/**
 * 应用壳:侧栏导航 + 顶栏 + 路由注册 + 数据源探测 + 全局快捷键
 */
(() => {
  const ICONS = {
    dashboard: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>',
    collect: '<svg viewBox="0 0 24 24"><path d="M12 3v12m0 0l-4-4m4 4l4-4"/><path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2"/></svg>',
    library: '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg>',
    sources: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><circle cx="5" cy="6" r="2"/><circle cx="19" cy="6" r="2"/><circle cx="5" cy="18" r="2"/><circle cx="19" cy="18" r="2"/><path d="M6.7 7.2l3.6 3M17.3 7.2l-3.6 3M6.7 16.8l3.6-3M17.3 16.8l-3.6-3"/></svg>',
    services: '<svg viewBox="0 0 24 24"><path d="M22 12h-4l-3 8-6-16-3 8H2"/></svg>',
    backup: '<svg viewBox="0 0 24 24"><path d="M12 3l7 3v5c0 5-3.5 8-7 10-3.5-2-7-5-7-10V6z"/><path d="M9 12.5l2 2 4.5-5"/></svg>',
    settings: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.3 1.9l.1.1a2 2 0 11-2.9 2.9l-.1-.1a1.7 1.7 0 00-1.9-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.2a1.7 1.7 0 00-1-1.5 1.7 1.7 0 00-1.9.3l-.1.1a2 2 0 11-2.9-2.9l.1-.1a1.7 1.7 0 00.3-1.9 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.2a1.7 1.7 0 001.5-1 1.7 1.7 0 00-.3-1.9l-.1-.1a2 2 0 112.9-2.9l.1.1a1.7 1.7 0 001.9.3h.1a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.2a1.7 1.7 0 001 1.5h.1a1.7 1.7 0 001.9-.3l.1-.1a2 2 0 112.9 2.9l-.1.1a1.7 1.7 0 00-.3 1.9v.1a1.7 1.7 0 001.5 1h.2a2 2 0 110 4h-.2a1.7 1.7 0 00-1.5 1z"/></svg>',
    search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>',
    bell: '<svg viewBox="0 0 24 24"><path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 01-3.4 0"/></svg>',
  };

  const NAV = [
    { group: '工作台', items: [
      { view: 'dashboard', label: '总览', icon: 'dashboard', meta: { section: '工作台', title: '总览' } },
      { view: 'collect', label: '采集任务', icon: 'collect', meta: { section: '工作台', title: '采集任务' } },
      { view: 'library', label: '内容库', icon: 'library', meta: { section: '工作台', title: '内容库' } },
      { view: 'subs', label: '订阅与批量', icon: 'sources', meta: { section: '工作台', title: '订阅与批量' } },
    ]},
    { group: '基础设施', items: [
      { view: 'sources', label: '采集源', icon: 'sources', meta: { section: '基础设施', title: '采集源' } },
      { view: 'services', label: '服务监控', icon: 'services', badge: '2动', meta: { section: '基础设施', title: '服务监控' } },
    ]},
    { group: '数据安全', items: [
      { view: 'backup', label: '备份与恢复', icon: 'backup', meta: { section: '数据安全', title: '备份与恢复' } },
      { view: 'settings', label: '设置', icon: 'settings', meta: { section: '数据安全', title: '设置' } },
    ]},
  ];

  const VIEWS = {
    dashboard: DashboardPage, collect: CollectPage, library: LibraryPage,
    sources: SourcesPage, services: ServicesPage, backup: BackupPage, settings: SettingsPage, subs: SubsPage,
  };

  function buildShell() {
    const app = document.getElementById('app');
    app.innerHTML = `
      <aside class="sidebar">
        <div class="brand">
          <div class="brand-logo"><svg viewBox="0 0 24 24"><path d="M4 5.5A2.5 2.5 0 016.5 3h11A2.5 2.5 0 0120 5.5v8a2.5 2.5 0 01-2.5 2.5H13l-4.2 4.2c-.6.6-1.8.2-1.8-.8V16H6.5A2.5 2.5 0 014 13.5z"/></svg></div>
          <div><div class="brand-name">内容收集工作台</div><div class="brand-sub">Content Collect Workbench</div></div>
        </div>
        ${NAV.map(g => `<div class="nav-group"><div class="nav-label">${g.group}</div>${g.items.map(it =>
          `<button class="nav-item" data-view="${it.view}">${ICONS[it.icon]}<span>${it.label}</span>${it.badge ? `<span class="badge">${it.badge}</span>` : ''}</button>`).join('')}</div>`).join('')}
        <div class="sidebar-foot">
          <div class="svc-pill"><span class="svc-dot" id="footBackend"></span><span>后端 5200</span></div>
          <div class="svc-pill"><span class="svc-dot" id="footMcp"></span><span>MCP 3333</span></div>
        </div>
      </aside>
      <main class="main">
        <header class="topbar">
          <div class="crumb"><b id="crumbSection">工作台</b><span class="sep">/</span><span id="crumbDetail">总览</span></div>
          <div class="search-wrap">${ICONS.search}<input id="globalSearch" placeholder="搜索内容库…" aria-label="全局搜索"><span class="kbd">⌘K</span></div>
          <button class="icon-btn" id="btnMode" title="数据源状态"><span class="pill" id="modePill" style="cursor:pointer">探测中</span></button>
          <button class="icon-btn" title="通知">${ICONS.bell}<span class="dot"></span></button>
          <div class="svc-pill"><span class="svc-dot"></span><span style="font-weight:600">本地</span></div>
        </header>
        <div class="view-wrap" id="viewWrap">
          ${Object.keys(VIEWS).map(v => `<section class="view" id="view-${v}"></section>`).join('')}
        </div>
      </main>`;

    // 导航
    document.querySelectorAll('.nav-item[data-view]').forEach(n =>
      n.addEventListener('click', () => { location.hash = `#/${n.dataset.view}`; }));

    // 全局搜索(⌘K)→ 跳转内容库并带词
    const gs = document.getElementById('globalSearch');
    document.addEventListener('keydown', e => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); gs.focus(); }
    });
    gs.addEventListener('keydown', e => {
      if (e.key === 'Enter' && gs.value.trim()) {
        location.hash = '#/library';
        setTimeout(() => {
          const inp = document.getElementById('libSearch');
          if (inp) { inp.value = gs.value.trim(); inp.dispatchEvent(new Event('input')); }
        }, 60);
      }
    });
    document.getElementById('btnMode').addEventListener('click', () => {
      const rows = API.probes.slice(-8).map(p => `<div class="stat-line"><span class="k">${UI.esc(p.name)}</span><span class="v" style="color:${p.ok ? 'var(--accent)' : 'var(--rose)'};font-weight:400;max-width:70%;font-size:11.5px">${UI.esc(p.detail)}</span></div>`).join('');
      UI.openModal(`<div class="modal-head"><div><div class="modal-title">数据源探测</div><div class="modal-sub">真实后端优先,不可达自动降级演示数据</div></div><button class="icon-btn modal-x" data-close><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div><div class="modal-body">${rows || '<div class="empty">暂无探测记录</div>'}</div>`);
    });

    // 数据源徽标
    const pill = document.getElementById('modePill');
    API.onMode(mode => {
      if (mode === 'live') { pill.textContent = '实时数据'; pill.className = 'pill ok'; }
      else if (mode === 'mock') { pill.textContent = '演示数据'; pill.className = 'pill warn'; }
      else pill.textContent = '探测中…';
    });
  }

  async function boot() {
    buildShell();
    Object.entries(VIEWS).forEach(([name, page]) => {
      Router.register(name, { render: el => page.render(el), onShow: page.onShow ? page.onShow.bind(page) : null, meta: NAV.flatMap(g => g.items).find(i => i.view === name)?.meta });
    });
    // 先探测后端可达性,再渲染首个视图:避免 probing 态误用演示数据
    await API.probe();
    Router.init('dashboard');
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
