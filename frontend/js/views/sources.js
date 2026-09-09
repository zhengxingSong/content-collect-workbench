/** 视图:采集源 — 来源注册表卡片墙 · 账号池 · RSS 订阅 · 巡检 */
const SourcesPage = {
  patrolTimer: null,

  render(el) {
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
          <div class="panel-head"><div><div class="panel-title">账号池</div><div class="panel-sub">自动轮换 · 风控自愈 · 冷却调度</div></div><div class="spacer"></div><button class="mini-btn" id="btnVerifyPool">全量验活</button></div>
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
      if (m) UI.toast('跳转来源详情', '来源级管理页即将上线,当前可在设置 → 来源凭据中配置');
    });

    // 账号池
    const poolList = document.getElementById('poolList');
    const poolPill = { active: '<span class="pill ok">可用</span>', cooldown: '<span class="pill warn">冷却中</span>', banned: '<span class="pill err">已封禁</span>', invalid: '<span class="pill err">失效</span>' };
    const poolRows = Object.entries(Mock.pools).flatMap(([src, list]) => list.map(p =>
      `<div class="src-row"><div class="src-dot" style="background:${SourceRegistry.get(src).color}">${UI.esc(SourceRegistry.get(src).label[0])}</div>
       <div style="min-width:0;flex:1"><div class="src-name mono">${UI.esc(p.nickname)}</div><div class="src-sub">失败 ${p.failures} 次 · 最近使用 ${p.last_used}</div></div>
       ${poolPill[p.status]}<button class="mini-btn" data-revive="${p.id}">复活</button></div>`)).join('');
    poolList.innerHTML = poolRows || '<div class="empty">暂无账号</div>';
    poolList.addEventListener('click', e => {
      const b = e.target.closest('[data-revive]');
      if (b) UI.toast('复活请求已提交', '账号将走浏览器会话重新建立登录态');
    });
    document.getElementById('btnVerifyPool').addEventListener('click', async () => {
      UI.toast('全量验活已启动', '逐账号探测登录态与健康度…');
      await API.pools.verify();
    });

    // RSS
    document.getElementById('rssList').innerHTML = Mock.rssSubs.map(r => `
      <div class="src-row"><div class="src-dot" style="background:${SourceRegistry.get('rss').color}">R</div>
        <div style="min-width:0;flex:1"><div class="src-name">${UI.esc(r.nickname)}</div><div class="src-sub">上次同步 ${r.last_sync} · ${r.items} 篇</div></div>
        <button class="toggle${r.enabled ? ' on' : ''}" data-rss="${r.fakeid}" aria-label="订阅开关"></button>
        <button class="mini-btn" data-sync="${r.fakeid}">立即拉取</button></div>`).join('');
    document.getElementById('rssList').addEventListener('click', e => {
      const tg = e.target.closest('[data-rss]');
      if (tg) { const on = tg.classList.toggle('on'); const r = Mock.rssSubs.find(x => x.fakeid === tg.dataset.rss); r.enabled = on; UI.toast(`RSS 定时拉取已${on ? '开启' : '关闭'}`, r.nickname, on ? 'ok' : 'warn'); }
      const sy = e.target.closest('[data-sync]');
      if (sy) { const r = Mock.rssSubs.find(x => x.fakeid === sy.dataset.sync); UI.toast('增量拉取已触发', r.nickname); }
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
          UI.toast('巡检完成', `${live.length} 个来源 · 发现 1 个账号待复活`, 'warn');
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
};
