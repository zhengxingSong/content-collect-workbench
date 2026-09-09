/** 视图:采集任务 — 跨来源统一任务中心(新建任务自动识别来源)
 *  数据边界:live 模式只显示真实历史 + 本次会话提交的真实任务;
 *  演示任务行(Mock.tasks)仅在"演示数据"模式下出现。 */
const CollectPage = {
  filter: 'all',
  timer: null,
  page: 1,
  pageSize: 10,
  _sig: '',
  liveTasks: [],      // 真实后端历史(/api/articles/history)映射的任务行
  sessionTasks: [],   // 本次会话提交的真实任务行(live 模式)

  render(el) {
    el.innerHTML = `
      <div class="view-head">
        <div><h1 class="view-title">采集任务</h1><div class="view-sub">跨来源统一队列 · 粘贴任意链接自动识别来源</div></div>
        <div class="spacer"></div>
        <button class="btn primary" id="btnNewTask"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>新建任务</button>
      </div>
      <div class="kpi-grid stagger" style="grid-template-columns:repeat(4,1fr)">
        <div class="kpi"><div class="kpi-top">进行中</div><div class="k-val" id="cRun">—</div></div>
        <div class="kpi" data-accent="sky"><div class="kpi-top">今日完成</div><div class="k-val" id="cDone">—</div></div>
        <div class="kpi" data-accent="amber"><div class="kpi-top">失败待重试</div><div class="k-val" id="cFail">—</div></div>
        <div class="kpi" data-accent="rose"><div class="kpi-top">队列速度</div><div class="k-val" id="cSpeed">—</div></div>
      </div>
      <div class="panel">
        <div class="panel-head"><div class="panel-title">任务队列</div><div class="spacer"></div>
          <div class="seg" id="taskSeg">
            <button data-f="all" class="on">全部</button><button data-f="running">进行中</button><button data-f="done">已完成</button><button data-f="failed">失败</button>
          </div>
        </div>
        <div id="taskList"></div>
        <div class="pagination"><div class="page-info" id="taskPageInfo"></div><div class="page-btns" id="taskPageBtns"></div></div>
      </div>`;

    document.getElementById('btnNewTask').addEventListener('click', () => this.newTaskModal());
    document.getElementById('taskPageBtns').addEventListener('click', e => {
      const b = e.target.closest('[data-pg]'); if (!b || b.disabled) return;
      this.page = Math.max(1, +b.dataset.pg); this.renderTasks();
    });
    document.getElementById('taskSeg').addEventListener('click', e => {
      const b = e.target.closest('[data-f]'); if (!b) return;
      this.filter = b.dataset.f;
      document.querySelectorAll('#taskSeg button').forEach(x => x.classList.toggle('on', x === b));
      this.renderTasks();
    });
    this.renderTasks();
    // 真实任务:统一采集队列 /api/collect/tasks,每 5s 刷新
    this.refreshLiveTasks();
    clearInterval(this.liveTimer);
    this.liveTimer = setInterval(() => { if (API.state.mode === 'live' && document.getElementById('taskList')) this.refreshLiveTasks(); }, 5000);
    clearInterval(this.timer);
    // 演示进度推进仅在 mock 模式运行;live 模式的真实任务由各自 poller 驱动
    this.timer = setInterval(() => {
      if (API.state.mode !== 'mock') return;
      const running = Mock.tasks.filter(t => t.status === 'running');
      let changed = false;
      for (const t of running) {
        if (t.done < t.total && Math.random() > 0.5) { t.done++; changed = true; }
        if (t.done >= t.total) { t.status = 'done'; changed = true; }
      }
      if (changed && document.getElementById('taskList')) this.renderTasks();
    }, 1500);
  },

  /** 当前应显示的任务集合:live=真实历史+会话任务;mock=演示任务 */
  visibleTasks() {
    return API.state.mode === 'live'
      ? [...this.liveTasks, ...this.sessionTasks]
      : Mock.tasks;
  },

  track(row) {
    this.sessionTasks.unshift(row);
    return row;
  },
  isTracked(row) {
    return this.sessionTasks.includes(row) || Mock.tasks.includes(row);
  },
  findTask(id) {
    return this.sessionTasks.find(x => x.id === id) || Mock.tasks.find(x => x.id === id);
  },

  renderTasks(force = false) {
    const list = document.getElementById('taskList');
    if (!list) return;
    const all = this.visibleTasks();
    // 内容未变化时跳过重渲染,避免轮询导致的整页闪烁
    const sig = JSON.stringify([this.filter, all.map(t => [t.id, t.status, t.done, t.total, t.eta, t.speed, t.error])]);
    if (!force && sig === this._sig) return;
    this._sig = sig;
    const rows = all.filter(t => this.filter === 'all' || t.status === this.filter);
    document.getElementById('cRun').textContent = all.filter(t => t.status === 'running').length;
    document.getElementById('cDone').textContent = all.filter(t => t.status === 'done').length;
    document.getElementById('cFail').textContent = all.filter(t => t.status === 'failed').length;
    const speed = document.getElementById('cSpeed');
    if (speed) speed.innerHTML = API.state.mode === 'live' ? '—' : '15.6<small> MB/s</small>';
    const totalPages = Math.max(1, Math.ceil(rows.length / this.pageSize));
    if (this.page > totalPages) this.page = totalPages;
    const slice = rows.slice((this.page - 1) * this.pageSize, this.page * this.pageSize);
    const info = document.getElementById('taskPageInfo'), btns = document.getElementById('taskPageBtns');
    if (info) info.textContent = rows.length ? `共 ${rows.length} 条 · 第 ${this.page}/${totalPages} 页` : '';
    if (btns) btns.innerHTML = UI.pageBtns(this.page, totalPages);
    if (!slice.length) { list.innerHTML = `<div class="empty"><svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg>暂无该状态任务</div>`; return; }
    const statusPill = { running: '<span class="pill sky"><span class="svc-dot" style="background:var(--sky)"></span>进行中</span>', done: '<span class="pill ok">已完成</span>', failed: '<span class="pill err">失败</span>', canceled: '<span class="pill">已取消</span>' };
    list.innerHTML = slice.map(t => {
      const s = SourceRegistry.get(t.source);
      const pct = Math.round(t.done / t.total * 100);
      return `<div class="task-row">
        <div class="src-dot" style="background:${s.color}">${UI.esc(s.label[0])}</div>
        <div class="task-main"><div class="task-title">${UI.esc(t.title)}</div>
          <div class="task-meta">${statusPill[t.status]}<span>${t.speed}</span>${t.eta ? `<span>· ${t.eta}</span>` : ''}${t.error ? `<span style="color:var(--rose)">· ${UI.esc(t.error)}</span>` : ''}</div></div>
        <div class="task-progress"><div class="task-meta" style="justify-content:space-between"><span class="mono">${t.done}/${t.total}</span><span class="mono">${pct}%</span></div><div class="bar ${t.status === 'failed' ? 'err' : ''}"><i style="width:${pct}%"></i></div></div>
        <div class="row-actions">${t.status === 'running' || t.status === 'failed' ? `<button class="mini-btn danger" data-cancel="${t.id}">取消</button>` : ''}${t.status === 'failed' ? `<button class="mini-btn" data-retry="${t.id}">重试</button>` : ''}</div>
      </div>`;
    }).join('');
    list.querySelectorAll('[data-cancel]').forEach(b => b.addEventListener('click', () => {
      const t = this.findTask(b.dataset.cancel);
      if (t) { t.status = 'canceled'; UI.toast('任务已取消', t.title, 'warn'); this.renderTasks(true); }
    }));
    list.querySelectorAll('[data-retry]').forEach(b => b.addEventListener('click', () => {
      const t = this.findTask(b.dataset.retry);
      if (t) { t.status = 'running'; t.done = 0; UI.toast('已重新入队', t.title); this.renderTasks(true); }
    }));
  },

  /** 新建任务:粘贴链接 → 注册表 detect 自动识别来源 */
  newTaskModal() {
    const { overlay, close } = UI.openModal(`
      <div class="modal-head"><div><div class="modal-title">新建采集任务</div><div class="modal-sub">支持文章 / 视频 / 笔记链接,自动路由到对应来源适配器</div></div><button class="icon-btn modal-x" data-close><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
      <div class="modal-body">
        <div class="field"><label>内容链接(每行一个)</label><textarea id="taskUrls" rows="4" placeholder="https://mp.weixin.qq.com/s/...&#10;https://b23.tv/...&#10;https://www.xiaohongshu.com/..."></textarea>
          <div class="hint">已接入:${SourceRegistry.live().map(s => s.label).join(' · ')}</div></div>
        <div id="detectBox"></div>
      </div>
      <div class="modal-foot"><button class="btn" data-close>取消</button><button class="btn primary" id="btnCreate" disabled>创建任务</button></div>`);

    const ta = overlay.querySelector('#taskUrls'), box = overlay.querySelector('#detectBox'), create = overlay.querySelector('#btnCreate');
    const analyze = UI.debounce(() => {
      const urls = ta.value.split('\n').map(s => s.trim()).filter(Boolean);
      if (!urls.length) { box.innerHTML = ''; create.disabled = true; return; }
      const hits = {};
      let unknown = 0;
      for (const u of urls) { const s = SourceRegistry.detect(u); if (s && s.status === 'live') hits[s.id] = (hits[s.id] || 0) + 1; else if (s) { hits[s.id] = (hits[s.id] || 0) + 1; } else unknown++; }
      const parts = Object.entries(hits).map(([id, n]) => { const s = SourceRegistry.get(id); return `<span class="pill ${s.status === 'live' ? 'ok' : ''}"><span class="cdot" style="width:7px;height:7px;border-radius:50%;background:${s.color}"></span>${UI.esc(s.label)} × ${n}${s.status === 'planned' ? ' · 未接入' : ''}</span>`; });
      if (unknown) parts.push(`<span class="pill">未识别 × ${unknown} · 将走 URL 直链</span>`);
      box.innerHTML = `<div class="detect-result">${parts.join(' ')}</div>`;
      create.disabled = false;
    }, 200);
    ta.addEventListener('input', analyze);
    create.addEventListener('click', async () => {
      const urls = ta.value.split('\n').map(s => s.trim()).filter(Boolean);
      close();
      if (!urls.length) return;
      // 按来源注册表分组,分别路由到对应平台端点
      const groups = {};
      for (const u of urls) {
        const s = SourceRegistry.detect(u);
        const id = s && s.status === 'live' ? s.id : 'url';
        (groups[id] = groups[id] || []).push(u);
      }
      for (const [id, list] of Object.entries(groups)) {
        const s = SourceRegistry.get(id);
        try {
          const resp = await API.downloadSingle[id](id === 'xhs' ? list : list[0]);
          if (resp && resp.mock) {
            Mock.tasks.unshift({ id: `task_${Date.now()}_${id}`, source: id, title: `新建任务(${s.label}) · ${list.length} 个链接`, status: 'running', done: 0, total: list.length, speed: '…', eta: '排队中(演示)' });
            UI.toast(`${s.label} 任务已创建(演示模式)`, `${list.length} 个链接已入队`, 'warn');
          } else if (id === 'wechat-mp' || id === 'rss' || id === 'url') {
            // 统一采集管道:任务持久化于 /api/collect/tasks
            UI.toast(`${s.label} 任务已提交到后端`, resp.task_id || `${list.length} 个链接`);
            setTimeout(() => this.refreshLiveTasks(), 800);
          } else {
            this.addLiveTask(id, list, resp);
            UI.toast(`${s.label} 任务已提交到后端`, resp.message || `${list.length} 个链接`);
          }
        } catch (err) {
          this.track({ id: `err_${Date.now()}_${id}`, source: id, title: `${s.label} · ${list[0].slice(0, 46)}`, status: 'failed', done: 0, total: 1, speed: '—', eta: '', error: err.message });
          UI.toast(`${s.label} 提交失败`, err.message, 'err');
        }
      }
      this.renderTasks(true);
    });
  },

  /** live 模式:按平台响应形态落任务行,并启动必要的进度轮询 */
  addLiveTask(source, list, resp) {
    const s = SourceRegistry.get(source);
    const brief = list[0].replace(/^https?:\/\//, '').slice(0, 44);
    if (source === 'bilibili' && resp && resp.task_started) {
      // B站是全局单任务:progress 端点驱动
      const row = this.track({ id: `bili_${Date.now()}`, source, title: `B站后台下载 · ${brief}`, status: 'running', done: 0, total: 1, speed: '—', eta: '后台任务', biliPoll: true });
      this.pollBili(row);
    } else if (source === 'xhs' && resp && resp.task_id) {
      const row = this.track({ id: resp.task_id, source, title: `小红书下载 · ${resp.count || list.length} 条 · ${brief}`, status: 'running', done: 0, total: resp.count || list.length, speed: '—', eta: '已提交', xhsPoll: true });
      this.pollXhs(row);
    } else if (resp && resp.task_id && (source === 'wechat-mp' || source === 'rss' || source === 'url')) {
      // 公众号通道:SSE/轮询 download-status
      const row = this.track({ id: resp.task_id, source, title: `公众号下载 ${resp.task_id} · ${list.length} 篇`, status: 'running', done: 0, total: list.length, speed: '—', eta: '已提交', mpPoll: true });
      this.pollMp(row);
    } else {
      const title = (resp && (resp.title || (resp.data && resp.data.title))) || brief;
      this.track({ id: `ok_${Date.now()}_${source}`, source, title: `${s.label} · ${title}`, status: 'done', done: 1, total: 1, speed: '—', eta: '已完成' });
    }
  },

  /** B站全局任务进度轮询(/api/bilibili/progress) */
  async pollBili(row) {
    for (;;) {
      await UI.sleep(2000);
      if (!this.isTracked(row)) return;
      if (i === -1) return;
      let p;
      try { p = await API.progress.bilibili(); } catch { continue; }
      if (p.mock) { row.status = 'running'; }
      else if (p.status === 'running') {
        row.status = 'running'; row.total = Math.max(1, p.total || 1); row.done = p.current_index || 0;
        row.eta = p.current_title || ''; row.speed = `${p.current_percent || 0}%`;
      } else if (p.status === 'completed') { row.status = 'done'; row.done = row.total; row.eta = ''; this.renderTasks(); return; }
      else if (['failed', 'cancelled', 'idle'].includes(p.status)) { row.status = p.status === 'failed' ? 'failed' : 'canceled'; row.eta = p.status === 'idle' ? '无任务' : ''; this.renderTasks(); return; }
      this.renderTasks();
    }
  },

  /** 小红书任务进度轮询(/api/xhs/download-status/<id>) */
  async pollXhs(row) {
    for (;;) {
      await UI.sleep(2200);
      if (!this.isTracked(row)) return;
      if (i === -1) return;
      let p;
      try { p = await API.progress.xhs(row.id); } catch { continue; }
      if (p.mock) { row.status = 'done'; row.done = row.total; this.renderTasks(); return; }
      const st = String(p.status || '').toLowerCase();
      if (['done', 'completed', 'success'].includes(st)) { row.status = 'done'; row.done = row.total; this.renderTasks(); return; }
      if (['failed', 'error', 'cancelled', 'canceled'].includes(st)) { row.status = st.startsWith('fail') || st === 'error' ? 'failed' : 'canceled'; row.error = p.error || p.message || ''; this.renderTasks(); return; }
      if (p.total) { row.total = p.total; row.done = p.completed || p.done || 0; }
      this.renderTasks();
    }
  },

  /** 拉取统一采集队列(真实持久化任务) */
  async refreshLiveTasks() {
    if (API.state.mode !== 'live') return;
    try {
      const d = await API.collect.tasks();
      this.liveTasks = (d.tasks || []).map(x => this.mapCollectTask(x)).reverse();
      if (document.getElementById('taskList')) this.renderTasks();
    } catch (err) { /* 静默:等待下个定时周期 */ }
  },

  mapCollectTask(t) {
    const stMap = { succeeded: 'done', running: 'running', queued: 'running', waiting_auth: 'running', cancel_requested: 'running', partially_succeeded: 'done', failed: 'failed', cancelled: 'canceled', interrupted: 'failed' };
    const pr = t.progress || {};
    const url0 = (t.params && t.params.urls && t.params.urls[0]) || '';
    const brief = url0.replace(/^https?:\/\//, '').slice(0, 44) || `${t.platform || ''} ${t.kind || ''}`.trim();
    const src = t.platform === 'mp' ? 'wechat-mp' : (t.platform || 'url');
    const eta = t.status === 'interrupted' ? '服务重启中断'
      : t.status === 'partially_succeeded' ? `${pr.failed || 0} 项失败`
      : t.updated_at ? UI.ago(new Date(t.updated_at * 1000).toISOString().slice(0, 19).replace('T', ' ')) : '';
    return {
      id: t.task_id, source: src,
      title: brief + (pr.total > 1 ? ` · 共 ${pr.total} 项` : ''),
      status: stMap[t.status] || 'canceled',
      done: pr.done || 0, total: Math.max(1, pr.total || 1),
      speed: pr.failed ? `${pr.failed} 失败` : '—', eta,
      error: t.error || '', live: true,
    };
  },

};
