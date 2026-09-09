/** 视图:采集任务 — 跨来源统一任务中心(新建任务自动识别来源) */
const CollectPage = {
  filter: 'all',
  timer: null,
  liveTasks: [],   // 真实后端历史(/api/articles/history)映射的任务行

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
        <div class="kpi" data-accent="rose"><div class="kpi-top">队列速度</div><div class="k-val">15.6<small> MB/s</small></div></div>
      </div>
      <div class="panel">
        <div class="panel-head"><div class="panel-title">任务队列</div><div class="spacer"></div>
          <div class="seg" id="taskSeg">
            <button data-f="all" class="on">全部</button><button data-f="running">进行中</button><button data-f="done">已完成</button><button data-f="failed">失败</button>
          </div>
        </div>
        <div id="taskList"></div>
      </div>`;

    document.getElementById('btnNewTask').addEventListener('click', () => this.newTaskModal());
    document.getElementById('taskSeg').addEventListener('click', e => {
      const b = e.target.closest('[data-f]'); if (!b) return;
      this.filter = b.dataset.f;
      document.querySelectorAll('#taskSeg button').forEach(x => x.classList.toggle('on', x === b));
      this.renderTasks();
    });
    this.renderTasks();
    // 真实联调:live 模式下拉取真实下载历史,映射为任务行(与演示任务并存)
    API.tasks.history().then(resp => {
      const h = Array.isArray(resp) ? resp : resp && resp.history;
      if (API.state.mode !== 'live' || !Array.isArray(h)) return;
      this.liveTasks = h.slice(0, 20).map(x => ({
        id: `h_${x.time}`, source: 'url',
        title: x.title || x.link || '未命名任务',
        status: x.success ? 'done' : 'failed',
        done: 1, total: 1, speed: '—', eta: x.time ? UI.ago(new Date(x.time * 1000).toISOString().slice(0, 19).replace('T', ' ')) : '',
        live: true, error: x.error || '',
      }));
      this.renderTasks();
    });
    clearInterval(this.timer);
    this.timer = setInterval(() => {
      const running = Mock.tasks.filter(t => t.status === 'running');
      let changed = false;
      for (const t of running) {
        if (t.done < t.total && Math.random() > 0.5) { t.done++; changed = true; }
        if (t.done >= t.total) { t.status = 'done'; changed = true; }
      }
      if (changed && this.current) this.renderTasks();
    }, 1500);
  },

  renderTasks() {
    const list = document.getElementById('taskList');
    if (!list) return;
    const all = [...this.liveTasks, ...Mock.tasks];
    const rows = all.filter(t => this.filter === 'all' || t.status === this.filter);
    document.getElementById('cRun').textContent = all.filter(t => t.status === 'running').length;
    document.getElementById('cDone').textContent = all.filter(t => t.status === 'done').length;
    document.getElementById('cFail').textContent = all.filter(t => t.status === 'failed').length;
    if (!rows.length) { list.innerHTML = `<div class="empty"><svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg>暂无该状态任务</div>`; return; }
    const statusPill = { running: '<span class="pill sky"><span class="svc-dot" style="background:var(--sky)"></span>进行中</span>', done: '<span class="pill ok">已完成</span>', failed: '<span class="pill err">失败</span>', canceled: '<span class="pill">已取消</span>' };
    list.innerHTML = rows.map((t, i) => {
      const s = SourceRegistry.get(t.source);
      const pct = Math.round(t.done / t.total * 100);
      return `<div class="task-row" style="animation:viewIn .4s var(--ease) ${i * 50}ms backwards">
        <div class="src-dot" style="background:${s.color}">${UI.esc(s.label[0])}</div>
        <div class="task-main"><div class="task-title">${UI.esc(t.title)}</div>
          <div class="task-meta">${statusPill[t.status]}<span>${t.speed}</span>${t.eta ? `<span>· ${t.eta}</span>` : ''}${t.error ? `<span style="color:var(--rose)">· ${UI.esc(t.error)}</span>` : ''}</div></div>
        <div class="task-progress"><div class="task-meta" style="justify-content:space-between"><span class="mono">${t.done}/${t.total}</span><span class="mono">${pct}%</span></div><div class="bar ${t.status === 'failed' ? 'err' : ''}"><i style="width:${pct}%"></i></div></div>
        <div class="row-actions">${t.status === 'running' || t.status === 'failed' ? `<button class="mini-btn danger" data-cancel="${t.id}">取消</button>` : ''}${t.status === 'failed' ? `<button class="mini-btn" data-retry="${t.id}">重试</button>` : ''}</div>
      </div>`;
    }).join('');
    list.querySelectorAll('[data-cancel]').forEach(b => b.addEventListener('click', () => {
      const t = Mock.tasks.find(x => x.id === b.dataset.cancel);
      if (t) { t.status = 'canceled'; UI.toast('任务已取消', t.title, 'warn'); this.renderTasks(); }
    }));
    list.querySelectorAll('[data-retry]').forEach(b => b.addEventListener('click', () => {
      const t = Mock.tasks.find(x => x.id === b.dataset.retry);
      if (t) { t.status = 'running'; t.done = 0; UI.toast('已重新入队', t.title); this.renderTasks(); }
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
      const first = SourceRegistry.detect(urls[0]);
      const source = first && first.status === 'live' ? first.id : 'url';
      // 真实联调:live 模式下真正调用后端 download-url;mock 模式仅本地演示
      const resp = await API.tasks.create({ urls });
      if (API.state.mode === 'live' && resp && resp.task_id) {
        Mock.tasks.unshift({ id: resp.task_id, source, title: `真实任务 ${resp.task_id} · ${urls.length} 个链接`, status: 'running', done: 0, total: urls.length, speed: '…', eta: '已提交后端' });
        UI.toast('任务已提交到后端', `${resp.task_id} · ${urls.length} 个链接`);
      } else {
        Mock.tasks.unshift({ id: `task_${Date.now()}`, source, title: `新建任务 · ${urls.length} 个链接`, status: 'running', done: 0, total: urls.length, speed: '…', eta: '排队中' });
        UI.toast('任务已创建', `${urls.length} 个链接已入队(演示模式)`);
      }
      close(); this.renderTasks();
    });
  },
};
