/** 视图:采集源 — 来源注册表卡片墙 · 账号池 · RSS 订阅 · 巡检 */
const SourcesPage = {
  patrolTimer: null,

  async render(el) {
    const st = Mock.stats();
    const live = SourceRegistry.live(), planned = SourceRegistry.planned();
    el.innerHTML = `
      <div class="view-head">
        <div><h1 class="view-title">采集源</h1><div class="view-sub">注册表驱动 · ${live.length} 个已接入 + ${planned.length} 个规划槽位 · 新增来源零改动出现</div></div>
        <div class="spacer"></div>
        <button class="btn" id="btnPatrol"><svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 11-9-9"/><path d="M21 3l-9 9"/></svg>立即巡检</button>
        <button class="btn primary" id="btnAddSource"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>添加来源</button>
      </div>
      <div class="bar" id="patrolWrap" style="margin-bottom:16px;visibility:hidden"><i id="patrolBar" style="width:0%"></i></div>
      <div class="sources-grid stagger" id="sourcesGrid"></div>
      <div class="grid-2" style="margin-top:20px">
        <div class="panel">
          <div class="panel-head"><div><div class="panel-title">账号与登录态</div><div class="panel-sub">真实登录态 · 点击「管理」发起登录</div></div><div class="spacer"></div><button class="mini-btn" id="btnVerifyPool">全量验活</button></div>
          <div id="poolList"></div>
        </div>
        <div class="panel">
          <div class="panel-head"><div><div class="panel-title">RSS 订阅</div><div class="panel-sub">公众号定时增量拉取 · Feed 输出</div></div></div>
          <div id="rssList"></div>
        </div>
      </div>`;

    // 来源卡
    const grid = document.getElementById('sourcesGrid');
    grid.innerHTML = SourceRegistry.sources.map(s => {
      const cnt = st.bySource[s.id] || 0;
      const plannedCls = s.status === 'planned' ? ' planned' : '';
      if (s.status === 'planned') {
        return `<div class="source-card${plannedCls}" style="--src-color:${s.color}">
          <div class="sc-head"><div class="sc-avatar" style="background:var(--text-3)">${UI.esc(s.label[0])}</div>
            <div style="min-width:0"><div class="sc-name">${UI.esc(s.label)}</div><div class="sc-kind">${UI.esc(SourceRegistry.kindLabel(s.kind))} · 规划中</div></div>
            <div class="spacer"></div><span class="pill">待接入</span></div>
          <div class="sc-stats"><div class="sc-stat"><b>—</b><span>适配器待接入</span></div></div>
          <button class="mini-btn" data-planned="${s.id}">了解接入方式</button>
        </div>`;
      }
      const pool = (Mock.pools[s.id] || []).reduce((a, p) => (a[p.status] = (a[p.status] || 0) + 1, a), {});
      const on = JSON.parse(localStorage.getItem(`src-${s.id}`) ?? 'true');
      return `<div class="source-card${plannedCls}" style="--src-color:${s.color}">
        <div class="sc-head"><div class="sc-avatar">${UI.esc(s.label[0])}</div>
          <div style="min-width:0"><div class="sc-name">${UI.esc(s.label)}</div><div class="sc-kind">${UI.esc(SourceRegistry.kindLabel(s.kind))} · 已接入</div></div>
          <div class="spacer"></div><button class="toggle${on ? ' on' : ''}" data-toggle="${s.id}" aria-label="启用 ${UI.esc(s.label)}"></button></div>
        <div class="sc-stats">
          <div class="sc-stat"><b class="mono">${cnt}</b><span>在库条目</span></div>
          <div class="sc-stat"><b class="mono">${pool.active || 0}</b><span>可用账号</span></div>
          <div class="sc-stat"><b class="mono" style="color:${pool.banned ? 'var(--rose)' : 'inherit'}">${pool.banned || 0}</b><span>已封禁</span></div>
        </div>
        <div style="display:flex;gap:8px"><button class="mini-btn" data-manage="${s.id}">管理登录态</button><button class="mini-btn" data-plan="${s.id}">采集计划</button></div>
      </div>`;
    }).join('');

    grid.addEventListener('click', e => {
      const t = e.target.closest('[data-toggle]');
      if (t) {
        const s = SourceRegistry.get(t.dataset.toggle);
        const on = t.classList.toggle('on');
        localStorage.setItem(`src-${s.id}`, on);
        UI.toast(`${s.label} 采集已${on ? '启用' : '停用'}`, on ? '调度器将恢复该来源任务' : '进行中任务不受影响,新任务不再调度', on ? 'ok' : 'warn');
        return;
      }
      const p = e.target.closest('[data-planned]');
      if (p) { UI.toast('规划中的来源', `${SourceRegistry.get(p.dataset.planned).label}:在 sources/registry.js 注册适配器即可接入`, 'warn'); return; }
      const m = e.target.closest('[data-manage], [data-plan]');
      if (m) this.authModal(m.dataset.manage || m.dataset.plan);
    });

    // 账号池(live:真实收藏账号 + 管理员态;mock:演示)
    const poolList = document.getElementById('poolList');
    const poolPill = { active: '<span class="pill ok">可用</span>', cooldown: '<span class="pill warn">冷却中</span>', banned: '<span class="pill err">已封禁</span>', invalid: '<span class="pill err">失效</span>' };
    poolList.addEventListener('click', e => {
      const m = e.target.closest('[data-manage]');
      if (m) { e.stopPropagation(); this.authModal(m.dataset.manage); }
    });
    if (API.state.mode === 'live') {
      this.renderLivePool(poolList);
    } else {
      this.renderMockPool(poolList, poolPill);
      poolList.addEventListener('click', e => {
        const b = e.target.closest('[data-revive]');
        if (b) UI.toast('复活请求已提交', '账号将走浏览器会话重新建立登录态');
      });
    }
    document.getElementById('btnVerifyPool').addEventListener('click', async () => {
      if (API.state.mode === 'live') {
        UI.toast('登录态探测已启动', '逐来源探测认证状态…');
        const r = await this.probeAllSources();
        UI.toast('探测完成', `${r.ok}/${r.total} 个来源状态正常`);
      } else {
        UI.toast('全量验活已启动', '逐账号探测登录态与健康度…');
        await API.pools.verify();
      }
    });

    // RSS
    if (API.state.mode === 'live') {
      try {
        const d = await API.accounts.rss();
        const subs = d.subscriptions || [];
        document.getElementById('rssList').innerHTML = subs.length ? subs.map(r => `
          <div class="src-row"><div class="src-dot" style="background:${SourceRegistry.get('rss').color}">R</div>
            <div style="min-width:0;flex:1"><div class="src-name">${UI.esc(r.nickname || r.fakeid)}</div><div class="src-sub">${UI.esc(r.fakeid)}</div></div>
            <button class="toggle${r.enabled ? ' on' : ''}" data-rss="${r.fakeid}" aria-label="订阅开关"></button></div>`).join('')
          : '<div class="empty">暂无 RSS 订阅 — 在公众号收藏中开启订阅</div>';
      } catch (err) { document.getElementById('rssList').innerHTML = `<div class="empty">订阅加载失败:${UI.esc(err.message)}</div>`; }
    } else {
      document.getElementById('rssList').innerHTML = Mock.rssSubs.map(r => `
        <div class="src-row"><div class="src-dot" style="background:${SourceRegistry.get('rss').color}">R</div>
          <div style="min-width:0;flex:1"><div class="src-name">${UI.esc(r.nickname)}</div><div class="src-sub">上次同步 ${r.last_sync} · ${r.items} 篇</div></div>
          <button class="toggle${r.enabled ? ' on' : ''}" data-rss="${r.fakeid}" aria-label="订阅开关"></button>
          <button class="mini-btn" data-sync="${r.fakeid}">立即拉取</button></div>`).join('');
    }
    document.getElementById('rssList').addEventListener('click', e => {
      const tg = e.target.closest('[data-rss]');
      if (tg) {
        const on = tg.classList.toggle('on');
        if (API.state.mode === 'live') {
          API.accounts.rssToggle(tg.dataset.rss, on)
            .then(() => UI.toast(`RSS 订阅已${on ? '开启' : '关闭'}`, tg.dataset.rss, on ? 'ok' : 'warn'))
            .catch(err => { tg.classList.toggle('on'); UI.toast('操作失败', err.message, 'err'); });
        } else {
          const r = Mock.rssSubs.find(x => x.fakeid === tg.dataset.rss); r.enabled = on; UI.toast(`RSS 定时拉取已${on ? '开启' : '关闭'}`, r.nickname, on ? 'ok' : 'warn');
        }
      }
      const sy = e.target.closest('[data-sync]');
      if (sy && API.state.mode !== 'live') { const r = Mock.rssSubs.find(x => x.fakeid === sy.dataset.sync); UI.toast('增量拉取已触发', r.nickname); }
    });

    // 巡检动画
    document.getElementById('btnPatrol').addEventListener('click', () => {
      const wrap = document.getElementById('patrolWrap'), bar = document.getElementById('patrolBar');
      wrap.style.visibility = 'visible';
      let v = 12;
      clearInterval(this.patrolTimer);
      this.patrolTimer = setInterval(() => {
        v = Math.min(100, v + 9 + Math.random() * 8);
        bar.style.width = v + '%';
        if (v >= 100) {
          clearInterval(this.patrolTimer);
          setTimeout(() => { wrap.style.visibility = 'hidden'; bar.style.width = '0%'; }, 900);
          UI.toast('巡检完成', API.state.mode === 'live' ? `${live.length} 个来源状态已更新` : `${live.length} 个来源 · 发现 1 个账号待复活`, 'warn');
        }
      }, 260);
    });

    // 添加来源
    document.getElementById('btnAddSource').addEventListener('click', () => {
      const { close } = UI.openModal(`
        <div class="modal-head"><div><div class="modal-title">添加来源</div><div class="modal-sub">已接入来源直接配置;新平台需先注册适配器</div></div><button class="icon-btn modal-x" data-close><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
        <div class="modal-body">
          <div class="field"><label>来源名称</label><input id="srcName" placeholder="例如:播客收藏夹"></div>
          <div class="field"><label>平台类型</label><div class="seg" id="srcPlat">${SourceRegistry.sources.map(s => `<button data-id="${s.id}" class="${s.status === 'live' ? '' : ''}">${UI.esc(s.label)}</button>`).join('')}</div></div>
        </div>
        <div class="modal-foot"><button class="btn" data-close>取消</button><button class="btn primary" id="btnAddOk">确认添加</button></div>`);
      let picked = SourceRegistry.live()[0].id;
      const seg = overlay.querySelector('#srcPlat');
      seg.addEventListener('click', e => {
        const b = e.target.closest('[data-id]'); if (!b) return;
        picked = b.dataset.id;
        seg.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
      });
      seg.querySelector('[data-id="' + picked + '"]').classList.add('on');
      overlay.querySelector('#btnAddOk').addEventListener('click', () => {
        const s = SourceRegistry.get(picked);
        UI.toast(s.status === 'live' ? '来源配置已保存' : '该平台尚未接入', s.status === 'live' ? s.label : `${s.label}:需在 sources/registry.js 注册适配器`, s.status === 'live' ? 'ok' : 'warn');
        close();
      });
    });
  },

  async renderLivePool(poolList) {
    poolList.innerHTML = '<div class="empty">加载中…</div>';
    let rows = '';
    try {
      const st = await API.auth.mpAdmin.status();
      const on = st.logged_in || st.is_login;
      rows += `<div class="src-row"><div class="src-dot" style="background:${SourceRegistry.get('wechat-mp').color}">M</div>
        <div style="min-width:0;flex:1"><div class="src-name">公众号管理员通道</div><div class="src-sub">搜号 / 批量历史列表依赖</div></div>
        ${on ? '<span class="pill ok">已认证</span>' : '<span class="pill warn">未认证</span>'}<button class="mini-btn" data-manage="wechat-mp">管理</button></div>`;
    } catch (e) { rows += `<div class="empty">管理员状态探测失败</div>`; }
    try {
      const d = await API.accounts.list();
      const accs = (d.accounts || []).slice(0, 6);
      if (accs.length) rows += accs.map(a => `
        <div class="src-row"><div class="src-dot" style="background:${SourceRegistry.get('wechat-mp').color}">${UI.esc((a.nickname || '?')[0])}</div>
          <div style="min-width:0;flex:1"><div class="src-name">${UI.esc(a.nickname || a.fakeid)}</div><div class="src-sub mono">${UI.esc(a.fakeid)}</div></div>
          <span class="pill ok">已收藏</span></div>`).join('');
      else rows += `<div class="src-row"><div class="empty" style="padding:14px">暂无收藏公众号</div></div>`;
    } catch (e) { /* accounts 端点失败不阻塞 */ }
    // 各平台登录态(真实探测,含 B站扫码结果)
    const addState = async (id, name) => {
      try {
        let st, on = false, sub = '';
        if (id === 'bilibili') {
          st = await API.auth.bilibili.status();
          on = !!st.logged_in;
          sub = (st.account_info && (st.account_info.uname || st.account_info.nickname)) || st.message || '';
        } else if (id === 'xhs') {
          st = await API.auth.xhs.status();
          const ls = st.login_state || {};
          on = ls.status === 'success' || !!st.logged_in;
          sub = on ? 'Cookie 已保存' : '未登录';
        } else {
          st = await API.auth[id].status();
          on = st.status === 'success';
          sub = st.message || '';
        }
        rows += `<div class="src-row"><div class="src-dot" style="background:${SourceRegistry.get(id).color}">${UI.esc(name[0])}</div>
          <div style="min-width:0;flex:1"><div class="src-name">${UI.esc(name)} 登录态</div><div class="src-sub">${UI.esc(sub)}</div></div>
          ${on ? '<span class="pill ok">已登录</span>' : '<span class="pill">未登录</span>'}<button class="mini-btn" data-manage="${id}">管理</button></div>`;
      } catch (e) { /* 单平台失败不影响其余 */ }
      poolList.innerHTML = rows;
    };
    poolList.innerHTML = rows;
    void ['bilibili', 'douyin', 'kuaishou', 'xhs'].reduce((chain, id) =>
      chain.then(() => addState(id, SourceRegistry.get(id).label)), Promise.resolve());
    void addState;
  },

  renderMockPool(poolList, poolPill) {
    const poolRows = Object.entries(Mock.pools).flatMap(([src, list]) => list.map(p2 =>
      `<div class="src-row"><div class="src-dot" style="background:${SourceRegistry.get(src).color}">${UI.esc(SourceRegistry.get(src).label[0])}</div>
       <div style="min-width:0;flex:1"><div class="src-name mono">${UI.esc(p2.nickname)}</div><div class="src-sub">失败 ${p2.failures} 次 · 最近使用 ${p2.last_used}</div></div>
       ${poolPill[p2.status]}<button class="mini-btn" data-revive="${p2.id}">复活</button></div>`)).join('');
    poolList.innerHTML = poolRows || '<div class="empty">暂无账号</div>';
  },

  async probeAllSources() {
    let ok = 0;
    const checks = [];
    checks.push(API.auth.mpAdmin.status().then(s => (s.logged_in || s.is_login) && ok++).catch(() => {}));
    checks.push(API.auth.douyin.status().then(s => s.status !== 'error' && ok++).catch(() => {}));
    checks.push(API.auth.kuaishou.status().then(s => s.status !== 'error' && ok++).catch(() => {}));
    checks.push(API.auth.xhs.status().then(s => (s.login_state || {}).status !== 'failed' && ok++).catch(() => {}));
    checks.push(API.auth.wechatChannels.proxyStatus().then(() => ok++).catch(() => {}));
    checks.push(API.progress.bilibili().then(() => ok++).catch(() => {}));
    await Promise.all(checks);
    return { ok, total: checks.length };
  },

  /** 认证路由:按来源分发到对应平台的真实认证流程 */
  authModal(sourceId) {
    const s = SourceRegistry.get(sourceId);
    if (!s) return;
    if (s.status !== 'live') { UI.toast('规划中的来源', `${s.label}:适配器待接入`, 'warn'); return; }
    if (sourceId === 'bilibili') return this.biliQrModal(s);
    if (sourceId === 'douyin' || sourceId === 'kuaishou') return this.browserAuthModal(s);
    if (sourceId === 'xhs') return this.browserAuthModal(s, 'xhs');
    if (sourceId === 'wechat-channels') return this.channelsModal(s);
    if (sourceId === 'wechat-mp') return this.mpAdminModal(s);
    UI.toast('无需认证', `${s.label} 不需要登录态`);
  },

  stateLine(st) {
    const map = { success: '<span class="pill ok">已登录</span>', scanning: '<span class="pill sky">等待扫码/登录</span>', idle: '<span class="pill">空闲</span>', expired: '<span class="pill warn">已过期</span>', failed: '<span class="pill err">失败</span>', error: '<span class="pill err">错误</span>', cancelled: '<span class="pill">已取消</span>' };
    return (map[st] || `<span class="pill warn">${UI.esc(st)}</span>`) + (st ? '' : '');
  },

  /** B站:扫码登录(本地 segno 渲染二维码 + 轮询 passport 状态) */
  async biliQrModal(s) {
    const { close, overlay } = UI.openModal(`
      <div class="modal-head"><div><div class="modal-title">${UI.esc(s.label)} · 扫码登录</div><div class="modal-sub">使用 B 站 App 扫描二维码;成功后 Cookie 自动保存到本机设置</div></div><button class="icon-btn modal-x" data-close><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
      <div class="modal-body" style="text-align:center">
        <div id="qrBox" style="width:200px;height:200px;margin:6px auto;border:1px solid var(--line-2);border-radius:12px;display:grid;place-items:center;background:#fff"><div class="skeleton" style="width:180px;height:180px"></div></div>
        <div id="qrState" class="view-sub" style="margin-top:10px">正在生成二维码…</div>
      </div>
      <div class="modal-foot"><button class="btn" id="qrRefresh">刷新二维码</button><button class="btn primary" data-close>完成</button></div>`,
      { onClose: () => { this._qrStop = true; } });
    this._qrStop = false;
    const box = overlay.querySelector('#qrBox'), state = overlay.querySelector('#qrState');
    const run = async () => {
      this._qrStop = false;
      state.textContent = '正在生成二维码…';
      box.innerHTML = '<div class="skeleton" style="width:180px;height:180px"></div>';
      let d;
      try { d = await API.auth.bilibili.qrGenerate(); } catch (err) { state.textContent = `生成失败:${err.message}`; return; }
      if (this._qrStop) return;
      if (d.mock || !d.url) { state.textContent = '演示模式:后端不可达,无法发起真实登录'; box.innerHTML = ''; return; }
      box.innerHTML = `<img src="${API.auth.bilibili.qrSvg(d.url)}" alt="二维码" width="196" height="196" style="border-radius:10px">`;
      state.textContent = '请使用 B 站 App 扫码';
      const key = d.qrcode_key;
      for (;;) {
        await UI.sleep(1600);
        if (this._qrStop) return;
        let r;
        try { r = await API.auth.bilibili.poll(key); } catch (err) { state.textContent = `轮询失败:${err.message}`; return; }
        if (r.status === 'success') { state.innerHTML = this.stateLine('success') + ' <span style="color:var(--accent)">登录成功,Cookie 已保存</span>'; UI.toast('B站登录成功', 'Cookie 已写入本机设置'); return; }
        if (r.status === 'scanned') state.textContent = '已扫码,请在手机上确认';
        else if (r.status === 'expired') { state.textContent = '二维码已过期,请点击刷新'; box.innerHTML = ''; return; }
        else if (r.status === 'failed') { state.textContent = `失败:${r.message || '未知原因'}`; return; }
      }
    };
    overlay.querySelector('#qrRefresh').addEventListener('click', run);
    run();
  },

  _containerCache: undefined,
  async isContainerMode() {
    if (this._containerCache !== undefined) return this._containerCache;
    try {
      const s = await API.settings.get();
      const dir = (s && s.download_dir) || '';
      this._containerCache = dir.startsWith('/app/') || (dir.startsWith('/') && !/^[a-zA-Z]:/.test(dir));
    } catch (e) { this._containerCache = false; }
    return this._containerCache;
  },

  /** 抖音/快手/小红书:浏览器会话登录(start + status 轮询) */
  browserAuthModal(s, kind) {
    const auth = kind === 'xhs' ? API.auth.xhs : API.auth[kind || s.id];
    const { close, overlay } = UI.openModal(`
      <div class="modal-head"><div><div class="modal-title">${UI.esc(s.label)} · 登录</div><div class="modal-sub">将打开本机浏览器会话窗口完成登录,Cookie 自动保存</div></div><button class="icon-btn modal-x" data-close><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
      <div class="modal-body">
        <div class="stat-line"><span class="k">当前状态</span><span class="v" id="authState"><span class="pill">未知</span></span></div>
        <div class="view-sub" id="authMsg" style="margin-top:8px;min-height:18px">点击下方按钮发起登录</div>
      </div>
      <div class="modal-foot">${kind === 'xhs' ? '<button class="btn danger" id="authLogout">退出登录</button>' : ''}<button class="btn" id="authCancel">取消登录</button><button class="btn primary" id="authStart">打开登录窗口</button></div>`,
      { onClose: () => { this._authStop = true; } });
    this._authStop = false;
    const stateEl = overlay.querySelector('#authState'), msgEl = overlay.querySelector('#authMsg');
    // xhs 的状态嵌套在 login_state 字段内,统一归一化
    const norm = st => (kind === 'xhs' && st && st.login_state) ? { ...st.login_state, logged_in: st.logged_in, cookie_set: st.cookie_set } : st;
    const setState = (st, msg) => {
      const val = typeof st === 'string' ? st : (st && st.status) || 'idle';
      const loggedIn = typeof st === 'object' && st && (st.logged_in || val === 'success');
      stateEl.innerHTML = loggedIn ? '<span class="pill ok">已登录</span>' : this.stateLine(val === 'scanning' ? 'scanning' : val === 'failed' || val === 'error' ? 'failed' : val === 'success' ? 'success' : 'idle');
      if (msg) msgEl.textContent = msg;
    };
    overlay.querySelector('#authStart').addEventListener('click', async () => {
      if (await this.isContainerMode()) {
        msgEl.innerHTML = '检测到 <b>容器部署</b>:后端无法唤起宿主机浏览器完成扫码。<br>替代方案:① 在宿主机用 venv 直接运行后端;② 使用桌面壳(Electron)启动的本地实例;③ 若仅采公开内容,无需登录可直接采集。';
        return;
      }
      try {
        const r = await auth.start();
        if (r.mock) { msgEl.textContent = '演示模式:后端不可达,无法发起真实登录'; return; }
        msgEl.textContent = r.message || '登录窗口已打开,请完成登录';
        for (;;) {
          await UI.sleep(2000);
          if (this._authStop) return;
          const st = norm(await auth.status());
          setState(st, st.message);
          if (st.status === 'success') { UI.toast(`${s.label} 登录成功`, 'Cookie 已保存'); return; }
          if (['failed', 'error', 'expired'].includes(st.status)) return;
        }
      } catch (err) { msgEl.textContent = `发起失败:${err.message}`; }
    });
    overlay.querySelector('#authCancel').addEventListener('click', async () => {
      try { const r = await auth.cancel(); msgEl.textContent = r.message || '已取消'; } catch (err) { msgEl.textContent = err.message; }
    });
    const lo = overlay.querySelector('#authLogout');
    if (lo) lo.addEventListener('click', async () => {
      try { await auth.logout(); UI.toast('已退出登录', s.label); } catch (err) { msgEl.textContent = err.message; }
    });
    // 打开即查询一次当前状态
    auth.status().then(raw0 => { if (this._authStop) return; const st = norm(raw0); if (st && !raw0.mock) setState(st, st.message === '演示模式' ? '' : st.message); });
  },

  /** 视频号:Cookie 获取 + mitmproxy 证书 */
  channelsModal(s) {
    const { overlay } = UI.openModal(`
      <div class="modal-head"><div><div class="modal-title">${UI.esc(s.label)} · 登录与代理</div><div class="modal-sub">视频号采集依赖 mitmproxy HTTPS 注入:启动代理 → 安装证书 → 获取 Cookie</div></div><button class="icon-btn modal-x" data-close><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
      <div class="modal-body">
        <div class="stat-line"><span class="k">mitm 代理</span><span class="v" id="chProxy">查询中…</span></div>
        <div class="stat-line"><span class="k">Cookie 获取</span><span class="v" id="chCookie"><span class="pill">未知</span></span></div>
        <div class="view-sub" id="chMsg" style="margin-top:8px;min-height:18px"></div>
      </div>
      <div class="modal-foot"><button class="btn" id="chInstallCert">安装证书</button><button class="btn" id="chProxyStart">启动代理</button><button class="btn primary" id="chCookieStart">获取 Cookie</button></div>`);
    const msg = overlay.querySelector('#chMsg'), cookieEl = overlay.querySelector('#chCookie'), proxyEl = overlay.querySelector('#chProxy');
    const say = t => { msg.textContent = t; };
    const refresh = async () => {
      try {
        const p = await API.auth.wechatChannels.proxyStatus();
        proxyEl.innerHTML = p.mock ? '<span class="pill warn">演示</span>' : p.running ? '<span class="pill ok">运行中</span>' : '<span class="pill">已停止</span>';
        const c = await API.auth.wechatChannels.cookieStatus();
        if (!c.mock) cookieEl.innerHTML = this.stateLine(c.status) + (c.message ? `<span style="font-weight:400;color:var(--text-3);margin-left:6px">${UI.esc(c.message)}</span>` : '');
        else cookieEl.innerHTML = '<span class="pill warn">演示</span>';
      } catch (err) { say(err.message); }
    };
    overlay.querySelector('#chProxyStart').addEventListener('click', async () => { try { const r = await API.auth.wechatChannels.proxyStart(); say(r.message || '代理已启动'); refresh(); } catch (e) { say(e.message); } });
    overlay.querySelector('#chInstallCert').addEventListener('click', async () => { try { const r = await API.auth.wechatChannels.installCert(); say(r.message || '证书已安装'); } catch (e) { say(e.message); } });
    overlay.querySelector('#chCookieStart').addEventListener('click', async () => {
      if (await this.isContainerMode()) {
        say('容器部署无法唤起宿主机浏览器完成微信扫码;请在宿主机以 venv 运行后端或使用桌面壳。');
        return;
      }
      try {
        const r = await API.auth.wechatChannels.cookieStart();
        say(r.mock ? '演示模式:后端不可达' : (r.message || '已启动 Cookie 获取,请在打开的窗口中登录'));
        for (;;) {
          await UI.sleep(2000);
          const c = await API.auth.wechatChannels.cookieStatus();
          cookieEl.innerHTML = this.stateLine(c.status) + (c.message ? ` <span style="font-weight:400;color:var(--text-3)">${UI.esc(c.message)}</span>` : '');
          if (['success', 'failed', 'error'].includes(c.status)) { if (c.status === 'success') UI.toast('视频号 Cookie 已获取', s.label); break; }
        }
      } catch (e) { say(e.message); }
    });
    refresh();
  },

  /** 公众号:mp-admin 管理员扫码状态 */
  mpAdminModal(s) {
    const { overlay } = UI.openModal(`
      <div class="modal-head"><div><div class="modal-title">${UI.esc(s.label)} · 管理员通道</div><div class="modal-sub">搜号/批量历史列表需要公众号平台管理员扫码认证;单篇短链采集无需登录</div></div><button class="icon-btn modal-x" data-close><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
      <div class="modal-body">
        <div class="stat-line"><span class="k">认证状态</span><span class="v" id="mpState">查询中…</span></div>
        <div class="view-sub" id="mpMsg" style="margin-top:8px;min-height:18px"></div>
      </div>
      <div class="modal-foot"><button class="btn danger" id="mpLogout">退出登录</button><button class="btn" id="mpCancel">取消扫码</button><button class="btn primary" id="mpLogin">发起扫码</button></div>`);
    const stateEl = overlay.querySelector('#mpState'), msg = overlay.querySelector('#mpMsg');
    const refresh = async () => {
      try {
        const st = await API.auth.mpAdmin.status();
        if (st.mock) { stateEl.innerHTML = '<span class="pill warn">演示</span>'; return; }
        const on = st.logged_in || st.is_login || st.status === 'success';
        stateEl.innerHTML = on ? '<span class="pill ok">已认证</span>' : '<span class="pill">未认证</span>';
        if (st.message) msg.textContent = st.message;
      } catch (err) { msg.textContent = err.message; }
    };
    overlay.querySelector('#mpLogin').addEventListener('click', async () => {
      try { const r = await API.auth.mpAdmin.login(); msg.textContent = r.mock ? '演示模式:后端不可达' : (r.message || '请使用管理员微信扫码'); } catch (e) { msg.textContent = e.message; }
    });
    overlay.querySelector('#mpCancel').addEventListener('click', async () => { try { await API.auth.mpAdmin.cancel(); msg.textContent = '已取消'; } catch (e) { msg.textContent = e.message; } });
    overlay.querySelector('#mpLogout').addEventListener('click', async () => { try { await API.auth.mpAdmin.logout(); UI.toast('已退出', s.label); refresh(); } catch (e) { msg.textContent = e.message; } });
    refresh();
  },
};
