/** 视图:内容库 — 高密度表格 · 多维筛选 · manifest 详情 · 批量导出(P2 契约) */
const LibraryPage = {
  state: { q: '', platform: 'all', kinds: new Set(), integrity: new Set(), page: 1, pageSize: 8, selected: new Set() },

  render(el) {
    el.innerHTML = `
      <div class="view-head">
        <div><h1 class="view-title">内容库</h1><div class="view-sub">manifest 完整性校验 · sha256 逐文件核对 · 可离线迁移</div></div>
        <div class="spacer"></div>
        <button class="btn" id="btnVerify"><svg viewBox="0 0 24 24"><path d="M9 12.5l2 2 4.5-5M12 3l7 3v5c0 5-3.5 8-7 10-3.5-2-7-5-7-10V6z"/></svg>重新校验</button>
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
            <th>标题</th><th>来源</th><th>类型</th><th>完整性</th><th>大小</th><th>入库时间</th><th style="width:120px">操作</th>
          </tr></thead>
          <tbody id="libBody"></tbody>
        </table></div>
        <div class="pagination"><div class="page-info" id="pageInfo"></div><div class="page-btns" id="pageBtns"></div></div>
      </div>`;

    this.renderPlatformFilters();
    this.renderIntegrityFilters();
    document.getElementById('libSearch').addEventListener('input', UI.debounce(e => { this.state.q = e.target.value.trim().toLowerCase(); this.state.page = 1; this.renderTable(); }, 200));
    document.getElementById('chkAll').addEventListener('change', e => {
      const rows = this.filtered().slice((this.state.page - 1) * this.state.pageSize, this.state.page * this.state.pageSize);
      rows.forEach(r => e.target.checked ? this.state.selected.add(r.id) : this.state.selected.delete(r.id));
      this.renderTable();
    });
    document.getElementById('btnExport').addEventListener('click', () => {
      const n = this.state.selected.size;
      UI.toast('导出任务已创建', `将 ${n} 条内容打包为 ZIP(仅含 manifest 校验通过文件)`);
    });
    document.getElementById('btnVerify').addEventListener('click', () => {
      UI.toast('完整性校验已启动', '逐文件 sha256 核对,只读不改');
      setTimeout(() => UI.toast('校验完成', `${Mock.entries.length} 条 · 发现 2 条部分缺失`, 'warn'), 1800);
    });
    document.getElementById('libBody').addEventListener('click', e => {
      const chk = e.target.closest('[data-sel]');
      const btn = e.target.closest('[data-open]');
      if (chk) { chk.checked ? this.state.selected.add(chk.dataset.sel) : this.state.selected.delete(chk.dataset.sel); this.renderTable(); return; }
      if (btn) { this.detail(btn.dataset.open); return; }
      const tr = e.target.closest('tr[data-id]');
      if (tr) this.detail(tr.dataset.id);
    });
    document.getElementById('pageBtns').addEventListener('click', e => {
      const b = e.target.closest('[data-pg]'); if (!b || b.disabled) return;
      this.state.page = Math.max(1, Math.min(999, +b.dataset.pg)); this.renderTable();
    });
    this.renderTable();
  },

  renderPlatformFilters() {
    const st = Mock.stats();
    const wrap = document.getElementById('fPlatform');
    const items = [['all', '全部', st.total, null], ...SourceRegistry.sources.map(s => [s.id, s.label, st.bySource[s.id] || 0, s.color])];
    wrap.innerHTML = items.map(([id, label, n, color]) =>
      `<button class="chip${this.state.platform === id ? ' on' : ''}" data-fp="${id}">${color ? `<span class="cdot" style="background:${color}"></span>` : ''}${label} <span class="cnt">${n}</span></button>`).join('');
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
    const { q, platform, kinds, integrity } = this.state;
    return Mock.entries.filter(e =>
      (!q || e.title.toLowerCase().includes(q) || e.author.toLowerCase().includes(q)) &&
      (platform === 'all' || e.source === platform) &&
      (!integrity.size || integrity.has(e.integrity)));
  },

  renderTable() {
    const body = document.getElementById('libBody'); if (!body) return;
    const rows = this.filtered();
    const { page, pageSize } = this.state;
    const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
    if (page > totalPages) this.state.page = totalPages;
    const slice = rows.slice((this.state.page - 1) * pageSize, this.state.page * pageSize);
    body.innerHTML = slice.map((e, i) => {
      const s = SourceRegistry.get(e.source);
      return `<tr data-id="${e.id}" class="${this.state.selected.has(e.id) ? 'selected' : ''}" style="animation:viewIn .35s var(--ease) ${i * 35}ms backwards">
        <td><input type="checkbox" class="checkbox" data-sel="${e.id}" ${this.state.selected.has(e.id) ? 'checked' : ''}></td>
        <td class="td-title">${UI.esc(e.title)}<div class="td-sub">${UI.esc(e.author)}</div></td>
        <td>${UI.sourcePill(e.source)}</td>
        <td><span class="kind">${UI.esc(SourceRegistry.kindLabel(e.kind))}</span></td>
        <td>${UI.integrityPill(e.integrity)}</td>
        <td class="mono">${e.size}</td>
        <td class="mono" style="font-size:11.5px;color:var(--text-3)">${e.date}</td>
        <td><div class="row-actions"><button class="mini-btn" data-open="${e.id}">详情</button><button class="mini-btn" data-folder="${e.id}">打开目录</button></div></td>
      </tr>`;
    }).join('');
    document.getElementById('pageInfo').textContent = `共 ${rows.length} 条 · 第 ${this.state.page}/${totalPages} 页`;
    document.getElementById('pageBtns').innerHTML = UI.pageBtns(this.state.page, totalPages);
    const chkAll = document.getElementById('chkAll');
    const selOnPage = slice.filter(e => this.state.selected.has(e.id)).length;
    chkAll.checked = slice.length > 0 && selOnPage === slice.length;
    chkAll.indeterminate = selOnPage > 0 && selOnPage < slice.length;
    document.getElementById('btnExport').disabled = this.state.selected.size === 0;
    document.getElementById('btnExport').textContent = `批量导出${this.state.selected.size ? `(${this.state.selected.size})` : ''}`;
  },

  /** manifest 详情弹窗 */
  detail(id) {
    const e = Mock.entries.find(x => x.id === id); if (!e) return;
    const kindIco = { text: 'T', image: 'IMG', video: 'VID', audio: 'AUD' };
    const { close } = UI.openModal(`
      <div class="modal-head"><div><div class="modal-title">${UI.esc(e.title)}</div><div class="modal-sub">${UI.esc(e.author)} · ${e.date} · ${e.size}</div></div><button class="icon-btn modal-x" data-close><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
      <div class="modal-body">
        <div style="display:flex;gap:8px;margin-bottom:14px">${UI.sourcePill(e.source)}${UI.integrityPill(e.integrity)}<span class="kind">${UI.esc(SourceRegistry.kindLabel(e.kind))}</span></div>
        <div class="panel-title" style="font-size:12.5px;margin-bottom:8px">文件清单 <span style="color:var(--text-3);font-weight:400">· ${e.files.length} 项 · sha256</span></div>
        <div class="manifest-grid">${e.files.map(f => `
          <div class="manifest-row">
            <span class="f-ico">${kindIco[f.kind] || 'F'}</span>
            <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap" class="mono">${UI.esc(f.name)}</span>
            <span class="sha ${f.sha}">${({ ok: '校验通过', missing: '缺失', fail: '校验失败' })[f.sha]}</span>
            <span class="mono" style="color:var(--text-3);font-size:10.5px">a3f…${Math.abs(Mock.seeded(f.name.length, 3) * 8999 | 0).toString().slice(0, 4)}</span>
          </div>`).join('')}</div>
        ${e.warnings.length ? `<div class="warn-box"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 8v5m0 3.5v.5M10.3 3.8L1.9 18a2 2 0 001.7 3h16.8a2 2 0 001.7-3L13.7 3.8a2 2 0 00-3.4 0z"/></svg><span>${e.warnings.map(UI.esc).join(';')}</span></div>` : ''}
      </div>
      <div class="modal-foot"><button class="btn" data-close>关闭</button><button class="btn" id="mOpenDir">打开目录</button><button class="btn primary" id="mExport" ${e.integrity === 'corrupt' ? 'disabled title="条目损坏,不可导出"' : ''}>导出此条</button></div>`, { wide: true });
    // 绑定弹窗内动作(弹窗 DOM 已挂载)
    document.getElementById('mOpenDir').addEventListener('click', () => UI.toast('已调用系统文件管理器', `output/${SourceRegistry.get(e.source).label}/${e.title.slice(0, 20)}…`));
    document.getElementById('mExport').addEventListener('click', () => UI.toast('导出任务已创建', e.title));
  },
};
