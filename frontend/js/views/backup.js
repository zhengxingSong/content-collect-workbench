/** 视图:备份恢复 — 4 步向导(预检→确认→执行→结果)· 历史 · 凭证不纳入备份 */
const BackupPage = {
  render(el) {
    el.innerHTML = `
      <div class="view-head">
        <div><h1 class="view-title">备份与恢复</h1><div class="view-sub">整库原子备份 · 恢复时从 output 重建 dedup_index · 仅限 Web 人工操作,不接入 MCP</div></div>
      </div>
      <div class="assume"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8h.01M12 11v5"/></svg><span>安全边界:备份内容仅含 <b>output/ 内容库</b> 与非敏感状态;凭证、cookie、token、代理证书一律排除。恢复流程强制人工确认。</span></div>
      <div class="steps stagger" id="bkSteps">
        <div class="step"><div class="s-idx">STEP 01</div><div class="s-name">预检</div><div class="s-desc">统计条目/文件/字节数,校验磁盘空间</div></div>
        <div class="step"><div class="s-idx">STEP 02</div><div class="s-name">确认</div><div class="s-desc">核对备份范围,确认排除敏感凭证</div></div>
        <div class="step"><div class="s-idx">STEP 03</div><div class="s-name">执行</div><div class="s-desc">生成 manifest → 打包 ZIP → 原子替换</div></div>
        <div class="step"><div class="s-idx">STEP 04</div><div class="s-name">结果</div><div class="s-desc">校验 sha256 · 写入备份历史</div></div>
      </div>
      <div class="grid-2">
        <div class="panel">
          <div class="panel-head"><div><div class="panel-title">新建备份</div><div class="panel-sub">全量 / 增量</div></div></div>
          <div class="panel-body">
            <div class="seg" id="bkSeg" style="margin-bottom:14px"><button data-t="full" class="on">全量备份</button><button data-t="inc">增量备份</button></div>
            <div class="stat-line"><span class="k">内容条目</span><span class="v" id="bkEntries">—</span></div>
            <div class="stat-line"><span class="k">文件总数</span><span class="v mono">28,411</span></div>
            <div class="stat-line"><span class="k">预估体积</span><span class="v mono" id="bkSize">12.8 GB</span></div>
            <div class="stat-line"><span class="k">排除项</span><span class="v" style="color:var(--amber)">凭证 / cookie / token / 证书</span></div>
            <div style="margin-top:16px;display:flex;gap:10px">
              <button class="btn primary" id="btnBackup"><svg viewBox="0 0 24 24"><path d="M12 3v12m0 0l-4-4m4 4l4-4M4 21h16"/></svg>开始备份</button>
              <button class="btn danger" id="btnRestore">从备份恢复…</button>
            </div>
          </div>
        </div>
        <div class="panel">
          <div class="panel-head"><div><div class="panel-title">备份历史</div><div class="panel-sub">按时间倒序</div></div></div>
          <div id="bkList"></div>
        </div>
      </div>`;

    let type = 'full';
    document.getElementById('bkEntries').textContent = Mock.entries.length;
    document.getElementById('bkSeg').addEventListener('click', e => {
      const b = e.target.closest('[data-t]'); if (!b) return;
      type = b.dataset.t;
      document.querySelectorAll('#bkSeg button').forEach(x => x.classList.toggle('on', x === b));
      document.getElementById('bkSize').textContent = type === 'full' ? '12.8 GB' : '340 MB';
    });

    const renderList = () => {
      document.getElementById('bkList').innerHTML = Mock.backups.map(b => `
        <div class="bk-row">
          <div class="bk-ico"><svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg></div>
          <div style="min-width:0;flex:1"><div style="font-weight:600">${UI.esc(b.name)} <span class="badge">${b.type === 'full' ? '全量' : '增量'}</span></div>
          <div class="td-sub mono">${b.date} · ${b.size} · ${b.entries} 条 / ${b.files} 文件</div></div>
          <span class="pill ok">完成</span>
          <button class="mini-btn" data-restore="${b.id}">恢复</button>
        </div>`).join('');
    };
    renderList();
    document.getElementById('bkList').addEventListener('click', e => {
      const b = e.target.closest('[data-restore]');
      if (b) this.restoreModal(Mock.backups.find(x => x.id === b.dataset.restore));
    });

    document.getElementById('btnBackup').addEventListener('click', () => this.runWizard(type));
    document.getElementById('btnRestore').addEventListener('click', () => this.restoreModal(Mock.backups[0]));
  },

  async runWizard(type) {
    const steps = [...document.querySelectorAll('#bkSteps .step')];
    const btn = document.getElementById('btnBackup');
    btn.disabled = true;
    const spin = setInterval(() => { btn.lastChild.textContent = ' 执行中' + '.'.repeat(1 + (Date.now() / 400 | 0) % 3); }, 400);
    for (let i = 0; i < steps.length; i++) {
      steps.forEach((s, j) => s.classList.toggle('cur', j === i));
      await API.backup.create({ type });
      await new Promise(r => setTimeout(r, 900));
      steps[i].classList.add('done');
    }
    clearInterval(spin);
    steps.forEach(s => s.classList.remove('cur'));
    btn.disabled = false;
    btn.lastChild.textContent = ' 开始备份';
    Mock.backups.unshift({ id: `bk_${Date.now()}`, name: `内容库${type === 'full' ? '全量' : '增量'}备份`, size: type === 'full' ? '12.8 GB' : '340 MB', entries: Mock.entries.length, files: 28411, date: new Date().toISOString().slice(0, 16).replace('T', ' '), status: 'done', type });
    UI.toast('备份完成', `manifest sha256 校验通过 · ${type === 'full' ? '全量' : '增量'}已写入历史`);
    this.render();
  },

  restoreModal(bk) {
    if (!bk) return;
    const { close } = UI.openModal(`
      <div class="modal-head"><div><div class="modal-title">恢复备份</div><div class="modal-sub">${UI.esc(bk.name)} · ${bk.date} · ${bk.size}</div></div><button class="icon-btn modal-x" data-close><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
      <div class="modal-body">
        <div class="warn-box"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 8v5m0 3.5v.5M10.3 3.8L1.9 18a2 2 0 001.7 3h16.8a2 2 0 001.7-3L13.7 3.8a2 2 0 00-3.4 0z"/></svg><span>恢复为<b>覆盖性操作</b>:将先解压到临时目录,校验通过后原子替换内容库;dedup_index 将从 output 重建(不信任备份内索引);<b>凭证不会被恢复</b>,需重新登录。</span></div>
        <div class="field" style="margin-top:14px"><label>输入 <span class="mono">RESTORE</span> 确认执行</label><input id="restoreConfirm" placeholder="RESTORE" autocomplete="off"></div>
      </div>
      <div class="modal-foot"><button class="btn" data-close>取消</button><button class="btn danger" id="btnRestoreGo" disabled>确认恢复</button></div>`);
    const inp = overlay.querySelector('#restoreConfirm'), go = overlay.querySelector('#btnRestoreGo');
    inp.addEventListener('input', () => { go.disabled = inp.value.trim() !== 'RESTORE'; });
    go.addEventListener('click', () => {
      close();
      UI.toast('恢复任务已启动', '校验 → 临时解压 → 原子替换 → 重建索引', 'warn');
      setTimeout(() => UI.toast('恢复完成', `${bk.entries} 条内容已还原,请重新登录各来源账号`), 2200);
    });
  },
};
