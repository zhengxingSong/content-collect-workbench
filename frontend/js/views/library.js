/** 视图:内容库 — 真实 /api/library/entries · 服务端搜索 · 客户端多维筛选 · manifest 详情 · ZIP 导出 */
const LibraryPage = {
  state: { q: '', platform: 'all', integrity: new Set(), page: 1, pageSize: 8, selected: new Set() },
  all: [],        // 服务端返回的全量条目(单次拉取 page_size=200,客户端筛选/分页)
  loaded: false,
  error: null,

  /** 注册表 id → 内容库 platform 代码 */
  libPlatform(regId) {
    return ({ 'wechat-mp': 'mp', rss: 'mp', url: 'mp', 'wechat-channels': 'channels', douyin: 'douyin', kuaishou: 'kuaishou', xhs: 'xhs', bilibili: 'bilibili' })[regId] || regId;
  },
  platformSource(code) {
    return SourceRegistry.sources.find(s => this.libPlatform(s.id) === code) || { label: code, color: '#9aa3b2' };
  },
  fmtSize(bytes) {
    if (!bytes && bytes !== 0) return '—';
    if (bytes > 1073741824) return (bytes / 1073741824).toFixed(1) + ' GB';
    if (bytes > 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
    return Math.max(1, Math.round(bytes / 1024)) + ' KB';
  },

  async refresh() {
    this.error = null;
    try {
      const d = await API.library.list(this.state.q ? { q: this.state.q } : {});
      this.all = d.entries || [];
      this.loaded = true;
    } catch (err) {
      this.all = []; this.loaded = true; this.error = err.message;
      UI.toast('内容库加载失败', err.message, 'err');
    }
    this.renderPlatformFilters();
    this.renderIntegrityFilters();
    this.renderTable();
  },

  render(el) {
    el.innerHTML = `
      <div class="view-head">
        <div><h1 class="view-title">内容库</h1><div class="view-sub">manifest 完整性校验 · sha256 逐文件核对 · 可离线迁移</div></div>
        <div class="spacer"></div>
        <button class="btn" id="btnRefresh"><svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 11-9-9"/><path d="M21 3l-9 9"/></svg>刷新</button>
        <button class="btn primary" id="btnExport" disabled><svg viewBox="0 0 24 24"><path d="M12 3v12m0 0l-4-4m4 4l4-4M4 21h16"/></svg>批量导出</button>
      </div>
      <div class="toolbar">
        <input id="libSearch" placeholder="搜索标题 / 作者…" style="width:230px;border-radius:999px">
        <div class="filters" id="fPlatform"></div>
        <div class="spacer"></div>
        <div class="filters" id="fIntegrity"></div>
      </div>
      <div class="panel">
        <div class="table-wrap" style="overflow-x:auto"><table class="table">
          <thead><tr>
            <th style="width:34px"><input type="checkbox" class="checkbox" id="chkAll"></th>
            <th>标题</th><th>来源</th><th>完整性</th><th>文件</th><th>大小</th><th>入库时间</th><th style="width:120px">操作</th>
          </tr></thead>
          <tbody id="libBody"></tbody>
        </table></div>
        <div class="pagination"><div class="page-info" id="pageInfo"></div><div class="page-btns" id="pageBtns"></div></div>
      </div>`;

    this.renderPlatformFilters();
    this.renderIntegrityFilters();
    document.getElementById('libSearch').addEventListener('input', UI.debounce(e => { this.state.q = e.target.value.trim(); this.refresh(); }, 350));
    document.getElementById('btnRefresh').addEventListener('click', () => this.refresh());
    document.getElementById('chkAll').addEventListener('change', e => {
      this.filtered().slice((this.state.page - 1) * this.state.pageSize, this.state.page * this.state.pageSize)
        .forEach(r => e.target.checked ? this.state.selected.add(r.id) : this.state.selected.delete(r.id));
      this.renderTable();
    });
    document.getElementById('btnExport').addEventListener('click', () => this.exportModal());
    document.getElementById('libBody').addEventListener('click', e => {
      const chk = e.target.closest('[data-sel]');
      if (chk) { chk.checked ? this.state.selected.add(chk.dataset.sel) : this.state.selected.delete(chk.dataset.sel); this.renderTable(); return; }
      const btn = e.target.closest('[data-open]'); if (btn) { e.stopPropagation(); this.detail(btn.dataset.open); return; }
      const dir = e.target.closest('[data-dir]'); if (dir) { e.stopPropagation(); this.openFolder(dir.dataset.dir); return; }
      const pv = e.target.closest('[data-preview]'); if (pv) { e.stopPropagation(); window.open(API.library.previewUrl(pv.dataset.preview), '_blank'); return; }
      const tr = e.target.closest('tr[data-id]');
      if (tr) this.detail(tr.dataset.id);
    });
    document.getElementById('pageBtns').addEventListener('click', e => {
      const b = e.target.closest('[data-pg]'); if (!b || b.disabled) return;
      this.state.page = Math.max(1, Math.min(999, +b.dataset.pg)); this.renderTable();
    });
    this.refresh();
  },

  async openFolder(id) {
    try {
      const r = await API.library.openFolder(id);
      const d = r.data || r;
      if (d && d.supported === false) {
        UI.toast('容器部署无法唤起宿主机文件管理器', '已改为浏览器内查看资源', 'warn');
        this.filesBrowser(id);
        return;
      }
      UI.toast('已打开目录', (d && (d.dir || d.message)) || id);
    } catch (err) { UI.toast('打开失败', err.message, 'err'); }
  },

  /** 二级资源浏览器:条目内全部文件,点击即在新标签查看/下载 */
  async filesBrowser(id) {
    const { close, overlay } = UI.openModal(`
      <div class="modal-head"><div><div class="modal-title">资源浏览</div><div class="modal-sub mono">${UI.esc(id)}</div></div><button class="icon-btn modal-x" data-close><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
      <div class="modal-body">
        <div style="display:flex;gap:8px;margin-bottom:12px">
          <button class="btn" id="fbPreview">阅读视图</button>
          <button class="btn" id="fbZip">打包下载整条</button>
        </div>
        <div class="manifest-grid" id="fbList" style="max-height:380px;overflow:auto"><div class="empty">加载中…</div></div>
      </div>
      <div class="modal-foot"><button class="btn primary" data-close>关闭</button></div>`, { wide: true });
    overlay.querySelector('#fbPreview').addEventListener('click', () => window.open(API.library.previewUrl(id), '_blank'));
    overlay.querySelector('#fbZip').addEventListener('click', () => window.open(API.library.downloadEntryUrl(id), '_blank'));
    let d;
    try { d = await API.library.files(id); } catch (err) {
      overlay.querySelector('#fbList').innerHTML = `<div class="empty">加载失败:${UI.esc(err.message)}</div>`;
      return;
    }
    if (!overlay.isConnected) return;
    const list = d.files || [];
    const fmt = n => !n ? '' : n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
    overlay.querySelector('#fbList').innerHTML = list.length ? list.map(f => `
      <div class="manifest-row" style="cursor:pointer" data-fpath="${UI.esc(f.path)}" title="点击查看/下载">
        <span class="f-ico">${f.path.endsWith('.html') || f.path.endsWith('.md') ? 'T' : f.path.match(/\.(png|jpe?g|webp|gif)$/i) ? 'IMG' : f.path.match(/\.(mp4|m4s)$/i) ? 'VID' : 'F'}</span>
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap" class="mono">${UI.esc(f.path)}</span>
        <span class="mono" style="color:var(--text-3);font-size:10.5px">${fmt(f.size)}</span>
        <span class="sha ok">打开</span>
      </div>`).join('') : '<div class="empty">条目目录为空</div>';
    overlay.querySelector('#fbList').addEventListener('click', e => {
      const row = e.target.closest('[data-fpath]');
      if (row) window.open(API.library.fileUrl(id, row.dataset.fpath), '_blank');
    });
  },

  async exportModal() {
    const ids = [...this.state.selected];
    if (!ids.length) return;
    const def = `data/exports/export-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.zip`;
    const { close, overlay } = UI.openModal(`
      <div class="modal-head"><div><div class="modal-title">批量导出 ${ids.length} 条</div><div class="modal-sub">打包为 ZIP;仅含 output 条目,不含 data/state 凭证</div></div><button class="icon-btn modal-x" data-close><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
      <div class="modal-body"><div class="field"><label>导出目标路径(服务端)</label><input id="expDest" value="${def}"></div></div>
      <div class="modal-foot"><button class="btn" data-close>取消</button><button class="btn primary" id="expGo">开始导出</button></div>`);
    overlay.querySelector('#expGo').addEventListener('click', async () => {
      try {
        const r = await API.library.exportEntries(ids, overlay.querySelector('#expDest').value.trim());
        UI.toast('导出完成', `${r.exported ?? ids.length}/${ids.length} 条已写入服务器路径`);
        close();
      } catch (err) { UI.toast('导出失败', err.message, 'err'); }
    });
  },

  renderPlatformFilters() {
    const wrap = document.getElementById('fPlatform');
    const byPlat = {};
    for (const e of this.all) byPlat[e.platform] = (byPlat[e.platform] || 0) + 1;
    const total = this.all.length;
    const entries = [['all', '全部', total, null], ...Object.entries(byPlat).map(([code, n]) => {
      const s = this.platformSource(code);
      return [code, s.label || code, n, s.color];
    })];
    wrap.innerHTML = entries.map(([id, label, n, color]) =>
      `<button class="chip${this.state.platform === id ? ' on' : ''}" data-fp="${id}">${color ? `<span class="cdot" style="background:${color}"></span>` : ''}${UI.esc(label)} <span class="cnt">${n}</span></button>`).join('');
    wrap.onclick = e => {
      const b = e.target.closest('[data-fp]'); if (!b) return;
      this.state.platform = b.dataset.fp; this.state.page = 1;
      this.renderPlatformFilters(); this.renderTable();
    };
  },

  renderIntegrityFilters() {
    const wrap = document.getElementById('fIntegrity');
    const defs = [['complete', '完整'], ['partial', '部分缺失'], ['corrupt', '损坏']];
    wrap.innerHTML = defs.map(([v, label]) =>
      `<button class="chip${this.state.integrity.has(v) ? ' on' : ''}" data-fi="${v}">${label}</button>`).join('');
    wrap.onclick = e => {
      const b = e.target.closest('[data-fi]'); if (!b) return;
      const v = b.dataset.fi;
      this.state.integrity.has(v) ? this.state.integrity.delete(v) : this.state.integrity.add(v);
      this.state.page = 1;
      this.renderIntegrityFilters(); this.renderTable();
    };
  },

  filtered() {
    const { platform, integrity, q } = this.state;
    return this.all.filter(e =>
      (platform === 'all' || e.platform === platform) &&
      (!integrity.size || integrity.has(e.collection_status)) &&
      (!q || (e.title || '').toLowerCase().includes(q.toLowerCase()) || (typeof e.author === 'string' ? e.author : e.author?.name || '').toLowerCase().includes(q.toLowerCase())));
  },

  renderTable() {
    const body = document.getElementById('libBody'); if (!body) return;
    const rows = this.filtered();
    const { page, pageSize } = this.state;
    const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
    if (page > totalPages) this.state.page = totalPages;
    const slice = rows.slice((this.state.page - 1) * pageSize, this.state.page * pageSize);
    if (this.error && !this.all.length) {
      body.innerHTML = `<tr><td colspan="8"><div class="empty">加载失败:${UI.esc(this.error)}</div></td></tr>`;
    } else if (!slice.length) {
      body.innerHTML = `<tr><td colspan="8"><div class="empty">${this.loaded ? '内容库为空 — 提交采集任务后条目会出现在这里' : '加载中…'}</div></td></tr>`;
    }
    body.innerHTML = slice.map((e, i) => {
      const s = this.platformSource(e.platform);
      const author = typeof e.author === 'string' ? e.author : e.author?.name || '';
      return `<tr data-id="${e.id}" class="${this.state.selected.has(e.id) ? 'selected' : ''}" style="animation:viewIn .35s var(--ease) ${i * 35}ms backwards">
        <td><input type="checkbox" class="checkbox" data-sel="${e.id}" ${this.state.selected.has(e.id) ? 'checked' : ''}></td>
        <td class="td-title">${UI.esc(e.title || '未命名')}<div class="td-sub">${UI.esc(author)}</div></td>
        <td><span class="pill ok"><span class="cdot" style="width:7px;height:7px;border-radius:50%;background:${s.color}"></span>${UI.esc(s.label || e.platform)}</span></td>
        <td>${UI.integrityPill(e.collection_status)}</td>
        <td class="mono">${e.file_count ?? '—'}${e.failed_media_count ? `<span style="color:var(--rose)"> (-${e.failed_media_count})</span>` : ''}</td>
        <td class="mono">${this.fmtSize(e.total_bytes)}</td>
        <td class="mono" style="font-size:11.5px;color:var(--text-3)">${(e.collect_time || '').replace('T', ' ').slice(0, 16)}</td>
        <td><div class="row-actions"><button class="mini-btn" data-preview="${e.id}">预览</button><button class="mini-btn" data-open="${e.id}">详情</button><button class="mini-btn" data-dir="${e.id}">打开目录</button></div></td>
      </tr>`;
    }).join('');
    if (slice.length) body.parentElement.querySelectorAll('.empty').forEach(x => x.remove());
    document.getElementById('pageInfo').textContent = `共 ${rows.length} 条 · 第 ${this.state.page}/${totalPages} 页`;
    document.getElementById('pageBtns').innerHTML = UI.pageBtns(this.state.page, totalPages);
    const chkAll = document.getElementById('chkAll');
    const selOnPage = slice.filter(e => this.state.selected.has(e.id)).length;
    chkAll.checked = slice.length > 0 && selOnPage === slice.length;
    chkAll.indeterminate = selOnPage > 0 && selOnPage < slice.length;
    const btn = document.getElementById('btnExport');
    btn.disabled = this.state.selected.size === 0;
    btn.textContent = `批量导出${this.state.selected.size ? `(${this.state.selected.size})` : ''}`;
  },

  /** manifest 详情弹窗(真实 /api/library/entries/<id>) */
  async detail(id) {
    const { close, overlay } = UI.openModal(`
      <div class="modal-head"><div><div class="modal-title">条目详情</div><div class="modal-sub mono">${UI.esc(id)}</div></div><button class="icon-btn modal-x" data-close><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
      <div class="modal-body"><div class="empty">加载中…</div></div>`, { wide: true });
    // 预取引用:弹窗被关闭(断开 DOM)后不再写入,杜绝 null 竞态
    const bodyEl = overlay.querySelector('.modal-body');
    const footEl = overlay.querySelector('.modal-foot');
    let e;
    try { e = (await API.library.detail(id)).entry; } catch (err) {
      if (bodyEl.isConnected) bodyEl.innerHTML = `<div class="empty">加载失败:${UI.esc(err.message)}</div>`;
      return;
    }
    if (!bodyEl.isConnected) return;
    const author = typeof e.author === 'string' ? e.author : e.author?.name || '';
    const failedSet = new Set(e.failed_items || []);
    const files = e.files || [];
    const kindOf = f => (f.mime || f.kind || '').startsWith('image') ? 'IMG' : (f.mime || '').startsWith('video') ? 'VID' : (f.mime || '').startsWith('audio') ? 'AUD' : 'T';
    const statusOf = f => f.status ? f.status : failedSet.has(f.path) ? 'fail' : 'ok';
    bodyEl.innerHTML = `
      <div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap">${UI.integrityPill(e.collection_status)}<span class="kind">${UI.esc(e.content_type || 'article')}</span><span class="badge">${files.length} 文件</span><span class="badge">${this.fmtSize(e.total_bytes)}</span></div>
      <div class="view-sub" style="margin-bottom:10px">${UI.esc(e.title || '')} · ${UI.esc(author)} · ${(e.collect_time || '').replace('T', ' ').slice(0, 16)}</div>
      <div class="panel-title" style="font-size:12.5px;margin-bottom:8px">文件清单 <span style="color:var(--text-3);font-weight:400">· sha256</span></div>
      <div class="manifest-grid" style="max-height:300px;overflow:auto">${files.map(f => `
        <div class="manifest-row">
          <span class="f-ico">${kindOf(f)}</span>
          <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap" class="mono">${UI.esc(f.path || f.name)}</span>
          <span class="sha ${statusOf(f)}">${({ ok: '校验通过', fail: '校验失败', missing: '缺失' })[statusOf(f)] || statusOf(f)}</span>
          <span class="mono" style="color:var(--text-3);font-size:10.5px">${(f.sha256 || '').slice(0, 8) || this.fmtSize(f.size)}</span>
        </div>`).join('') || '<div class="empty">无文件清单</div>'}</div>
      ${(e.failed_items || []).length ? `<div class="warn-box"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 8v5m0 3.5v.5M10.3 3.8L1.9 18a2 2 0 001.7 3h16.8a2 2 0 001.7-3L13.7 3.8a2 2 0 00-3.4 0z"/></svg><span>${e.failed_items.length} 项资源采集失败,可尝试"重试媒体"</span></div>` : ''}`;
    footEl.innerHTML = `
      <button class="btn" data-close>关闭</button>
      <button class="btn" id="mOpenDir">打开目录</button>
      <button class="btn" id="mFiles">资源文件</button>
      <button class="btn" id="mPreview">${e.platform === 'bilibili' ? '播放预览' : '阅读视图'}</button>
      <button class="btn primary" id="mExport" ${e.collection_status === 'corrupt' ? 'disabled' : ''}>导出此条</button>`;
    overlay.querySelector('#mOpenDir').addEventListener('click', () => { this.openFolder(id); });
    overlay.querySelector('#mFiles').addEventListener('click', () => { close(); this.filesBrowser(id); });
    const mp = overlay.querySelector('#mPreview');
    if (mp) mp.addEventListener('click', () => window.open(API.library.previewUrl(id), '_blank'));
    if (e.canonical_url) {
      const src = footEl.querySelector('#mOpenDir');
      const a = document.createElement('button');
      a.className = 'btn'; a.textContent = '原址';
      a.addEventListener('click', () => window.open(e.canonical_url, '_blank'));
      src ? src.before(a) : footEl.prepend(a);
    }
    overlay.querySelector('#mExport').addEventListener('click', async () => {
      try {
        const r = await API.library.exportEntries([id], `data/exports/${id}.zip`);
        UI.toast('导出完成', `${r.exported ?? 1}/1 → data/exports/${id}.zip`);
      } catch (err) { UI.toast('导出失败', err.message, 'err'); }
    });
  },
};
