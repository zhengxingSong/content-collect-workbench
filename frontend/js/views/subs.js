/** 视图:订阅与批量 — 组识别采集:UP主投稿 / 主页批量 / 博主笔记 */
const SubsPage = {
  biliVideos: [],
  biliPage: 1,
  biliSelected: new Set(),
  _biliMid: null,

  render(el) {
    el.innerHTML = `
      <div class="view-head">
        <div><h1 class="view-title">订阅与批量</h1><div class="view-sub">组识别采集:UP主全部投稿 · 主页批量 · 博主笔记;单视频走「采集任务」即全 P 下载</div></div>
      </div>

      <div class="panel">
        <div class="panel-head">
          <div><div class="panel-title">B站 · UP主订阅与批量下载</div><div class="panel-sub">解析主页 → 订阅 → 勾选投稿批量入队(需扫码登录)</div></div>
          <div class="spacer"></div>
          <span class="pill sky" id="biliState">登录态查询中…</span>
        </div>
        <div class="panel-body" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
          <input id="biliParseUrl" placeholder="粘贴 UP 主主页链接,如 https://space.bilibili.com/37974444" style="flex:1;min-width:260px">
          <button class="btn primary" id="biliParseBtn">解析并订阅</button>
        </div>
        <div class="panel-body" style="padding-top:0;display:flex;gap:8px;flex-wrap:wrap;align-items:center" id="biliAccounts">
          <span class="view-sub">已订阅加载中…</span>
        </div>
      </div>

      <div class="panel" id="biliVideoPanel" style="display:none;margin-top:16px">
        <div class="panel-head">
          <div><div class="panel-title" id="biliVideoTitle">投稿列表</div><div class="panel-sub" id="biliVideoSub"></div></div>
          <div class="spacer"></div>
          <button class="mini-btn" id="biliPrev" disabled>上一页</button>
          <button class="mini-btn" id="biliNext" disabled>下一页</button>
          <button class="btn primary" id="biliBatch" disabled>批量下载 (0)</button>
        </div>
        <div class="table-wrap" style="overflow:auto;max-height:480px"><table class="table">
          <thead><tr><th style="width:34px"></th><th style="width:120px">封面</th><th>标题(点击访问原址)</th><th style="width:90px">时长</th><th style="width:90px">播放</th><th style="width:110px">发布时间</th></tr></thead>
          <tbody id="biliVideoBody"></tbody>
        </table></div>
      </div>

      <div class="sources-grid" style="margin-top:16px;grid-template-columns:repeat(auto-fill,minmax(360px,1fr))">
        <div class="source-card" style="--src-color:#f06a72">
          <div class="sc-head"><div class="sc-avatar" style="background:#f06a72">抖</div><div><div class="sc-name">抖音 · 作品 / 喜欢 / 合集</div><div class="sc-kind">按 sec_uid 批量,全局任务队列</div></div></div>
          <div class="panel-body" style="padding:10px 0 0">
            <div class="field"><input id="dySecUid" placeholder="sec_uid 或抖音主页/分享链接"></div>
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
              <div class="seg" id="dyTypes"><button data-t="post" class="on">作品</button><button data-t="like">喜欢</button><button data-t="mix">合集</button></div>
              <span class="view-sub">≤</span><input id="dyPages" type="number" value="10" style="width:70px"><span class="view-sub">页</span>
              <button class="btn primary" id="dyGo">开始批量</button>
            </div>
            <div class="view-sub" id="dyMsg" style="margin-top:6px;min-height:16px"></div>
          </div>
        </div>
        <div class="source-card" style="--src-color:#f5b64d">
          <div class="sc-head"><div class="sc-avatar" style="background:#f5b64d">快</div><div><div class="sc-name">快手 · 主页批量</div><div class="sc-kind">按主页链接批量下载作品</div></div></div>
          <div class="panel-body" style="padding:10px 0 0">
            <div class="field"><input id="ksUrl" placeholder="快手主页链接"></div>
            <div style="display:flex;gap:8px;align-items:center">
              <span class="view-sub">≤</span><input id="ksPages" type="number" value="5" style="width:70px"><span class="view-sub">页</span>
              <button class="btn primary" id="ksGo">开始批量</button>
            </div>
            <div class="view-sub" id="ksMsg" style="margin-top:6px;min-height:16px"></div>
          </div>
        </div>
        <div class="source-card" style="--src-color:#ff7aa2">
          <div class="sc-head"><div class="sc-avatar" style="background:#ff7aa2">红</div><div><div class="sc-name">小红书 · 博主笔记</div><div class="sc-kind">解析博主 → 整批笔记入库</div></div></div>
          <div class="panel-body" style="padding:10px 0 0">
            <div class="field"><input id="xhsUrl" placeholder="小红书博主主页链接"></div>
            <button class="btn primary" id="xhsGo">解析并批量下载</button>
            <div class="view-sub" id="xhsMsg" style="margin-top:6px;min-height:16px"></div>
          </div>
        </div>
        <div class="source-card" style="--src-color:#2dd98a">
          <div class="sc-head"><div class="sc-avatar" style="background:#2dd98a">公</div><div><div class="sc-name">公众号 · 收藏与 RSS</div><div class="sc-kind">收藏公众号 + RSS 定时增量</div></div></div>
          <div class="panel-body" style="padding:10px 0 0"><button class="btn" id="mpGo">前往采集源管理</button></div>
        </div>
      </div>`;

    document.getElementById('biliParseBtn').addEventListener('click', () => this.parseBiliUp());
    document.getElementById('dyGo').addEventListener('click', () => this.douyinBatch());
    document.getElementById('ksGo').addEventListener('click', () => this.ksBatch());
    document.getElementById('xhsGo').addEventListener('click', () => this.xhsBatch());
    document.getElementById('mpGo').addEventListener('click', () => { location.hash = '#/sources'; });
    document.getElementById('biliPrev').addEventListener('click', () => { this.biliPage--; this.loadBiliVideos(this._biliMid); });
    document.getElementById('biliNext').addEventListener('click', () => { this.biliPage++; this.loadBiliVideos(this._biliMid); });
    document.getElementById('biliBatch').addEventListener('click', () => this.biliBatchDownload());
    document.getElementById('dyTypes').addEventListener('click', e => {
      const b = e.target.closest('[data-t]'); if (!b) return;
      b.classList.toggle('on');
    });
    this.loadBiliAccounts();
    this.loadBiliLoginState();
  },

  async loadBiliLoginState() {
    const el = document.getElementById('biliState');
    try {
      const st = await API.auth.bilibili.status();
      if (st.logged_in) {
        const name = st.account_info ? (st.account_info.uname || st.account_info.nickname || '') : '';
        el.className = 'pill ok'; el.textContent = `已登录${name ? ' · ' + name : ''}`;
      } else { el.className = 'pill warn'; el.textContent = '未登录 — 采集源页扫码'; }
    } catch (e) { el.className = 'pill err'; el.textContent = '探测失败'; }
  },

  // ── B站 UP主 ──
  async parseBiliUp() {
    const info = document.getElementById('biliAccounts');
    const url = document.getElementById('biliParseUrl').value.trim();
    if (!url) return;
    try {
      const r = await API.subs.biliParse(url);
      const d = r.data || r;
      try {
        await API.subs.biliAdd({ mid: d.mid, nickname: d.nickname, avatar: d.avatar, desc: d.desc });
        UI.toast('已订阅 UP 主', `${d.nickname || d.mid}`);
        this.loadBiliAccounts();
        document.getElementById('biliParseUrl').value = '';
      } catch (err) {
        if (/已存在/.test(err.message)) { UI.toast('该 UP 主已在订阅中', d.nickname || d.mid, 'warn'); this.loadBiliAccounts(); }
        else UI.toast('订阅失败', err.message, 'err');
      }
    } catch (err) { UI.toast('解析失败', err.message, 'err'); }
  },

  async loadBiliAccounts() {
    const box = document.getElementById('biliAccounts');
    try {
      const d = await API.subs.biliAccounts();
      const accs = d.accounts || [];
      box.innerHTML = accs.length ? accs.map(a => `
        <span class="chip${this._biliMid === String(a.mid) ? ' on' : ''}" data-bv="${UI.esc(a.mid)}" title="查看投稿列表">
          <span class="cdot" style="background:#7ab8ff"></span>${UI.esc(a.nickname || a.mid)}<span class="cnt">投稿</span>
        </span>
        <button class="mini-btn danger" data-bdel="${UI.esc(a.mid)}" title="退订">×</button>`).join('')
        : '<span class="view-sub">暂无订阅 — 上方粘贴主页链接解析</span>';
      box.onclick = e => {
        const v = e.target.closest('[data-bv]');
        if (v) {
          this._biliMid = v.dataset.bv;
          box.querySelectorAll('.chip').forEach(c => c.classList.toggle('on', c === v));
          document.getElementById('biliVideoTitle').textContent = `${v.textContent.replace('投稿', '').trim()} 的投稿`;
          this.loadBiliVideos(this._biliMid);
          return;
        }
        const del = e.target.closest('[data-bdel]');
        if (del) API.subs.biliRemove(del.dataset.bdel).then(() => { UI.toast('已退订'); if (this._biliMid === del.dataset.bdel) { this._biliMid = null; document.getElementById('biliVideoPanel').style.display = 'none'; } this.loadBiliAccounts(); }).catch(err => UI.toast('退订失败', err.message, 'err'));
      };
    } catch (err) { box.innerHTML = `<span class="view-sub">加载失败:${UI.esc(err.message)}</span>`; }
  },

  async loadBiliVideos(mid) {
    const panel = document.getElementById('biliVideoPanel');
    panel.style.display = 'block';
    const body = document.getElementById('biliVideoBody');
    body.innerHTML = '<tr><td colspan="6"><div class="empty">加载投稿中…</div></td></tr>';
    try {
      const d = await API.subs.biliVideos(mid, this.biliPage);
      this.biliVideos = d.videos || [];
      const total = d.total || this.biliVideos.length;
      document.getElementById('biliVideoSub').textContent = `共 ${total} 个投稿 · 第 ${this.biliPage} 页(每页 30)`;
      document.getElementById('biliPrev').disabled = this.biliPage <= 1;
      document.getElementById('biliNext').disabled = this.biliPage * 30 >= total;
      if (!this.biliVideos.length) { body.innerHTML = '<tr><td colspan="6"><div class="empty">该 UP 主暂无投稿</div></td></tr>'; return; }
      body.innerHTML = this.biliVideos.map(v => {
        const season = +v.season_id ? ' <span class="badge" title="所属合集">合集</span>' : '';
        return `<tr>
          <td><input type="checkbox" class="checkbox" data-bvid="${UI.esc(v.bvid)}" data-title="${UI.esc(v.title || '')}" ${this.biliSelected.has(v.bvid) ? 'checked' : ''}></td>
          <td><a href="https://www.bilibili.com/video/${UI.esc(v.bvid)}" target="_blank" rel="noopener"><img src="${UI.esc(v.pic || '')}" style="width:104px;height:64px;object-fit:cover;border-radius:8px" loading="lazy" onerror="this.style.opacity=.25"></a></td>
          <td class="td-title" style="max-width:420px;white-space:normal">
            <a href="https://www.bilibili.com/video/${UI.esc(v.bvid)}" target="_blank" rel="noopener" style="color:var(--text);border-bottom:1px dashed var(--line-2)">${UI.esc(v.title || v.bvid)}</a>${season}
            <div class="td-sub mono">${UI.esc(v.bvid)}</div></td>
          <td class="mono">${UI.esc(v.length || '—')}</td>
          <td class="mono">${v.play != null ? Number(v.play).toLocaleString() : '—'}</td>
          <td class="mono" style="font-size:11.5px;color:var(--text-3)">${v.created ? new Date(v.created * 1000).toISOString().slice(0, 10) : '—'}</td>
        </tr>`;
      }).join('');
      body.querySelectorAll('[data-bvid]').forEach(c => c.addEventListener('change', () => {
        c.checked ? this.biliSelected.add(c.dataset.bvid) : this.biliSelected.delete(c.dataset.bvid);
        this.updateBatchBtn();
      }));
      this.updateBatchBtn();
    } catch (err) { body.innerHTML = `<tr><td colspan="6"><div class="empty">投稿加载失败:${UI.esc(err.message)}</div></td></tr>`; }
  },

  updateBatchBtn() {
    const btn = document.getElementById('biliBatch');
    if (btn) { btn.textContent = `批量下载 (${this.biliSelected.size})`; btn.disabled = !this.biliSelected.size; }
  },

  async biliBatchDownload() {
    const items = this.biliVideos.filter(v => this.biliSelected.has(v.bvid)).map(v => ({ bvid: v.bvid, title: v.title, page_num: 1 }));
    if (!items.length) return;
    try {
      const r = await API.subs.biliBatch(items);
      UI.toast('B站批量任务已提交', r.message || `${items.length} 项`);
      location.hash = '#/collect';
    } catch (err) { UI.toast('提交失败', err.message, 'err'); }
  },

  // ── 抖音 ──
  async douyinBatch() {
    const msg = document.getElementById('dyMsg');
    let input = document.getElementById('dySecUid').value.trim();
    if (!input) { msg.textContent = '请填写 sec_uid 或主页链接'; return; }
    const types = [...document.querySelectorAll('#dyTypes button.on')].map(b => b.dataset.t);
    const pages = +document.getElementById('dyPages').value || 10;
    try {
      if (!/^[A-Za-z0-9_-]+$/.test(input)) {
        msg.textContent = '从链接解析 sec_uid…';
        const d = await API.subs.douyinUserDetail(input);
        const dd = d.data || d;
        input = dd.sec_uid || (dd.user && dd.user.sec_uid) || '';
        if (!input) { msg.textContent = '未能从该链接解析出 sec_uid,请直接粘贴 sec_uid'; return; }
      }
      msg.textContent = '已提交全局批量任务…';
      const r = await API.subs.douyinDownloadUser(input, types, pages);
      msg.textContent = r.message || '批量任务已启动';
      UI.toast('抖音批量任务已启动', `类型 ${types.join('/')} · ≤${pages} 页`);
      location.hash = '#/collect';
    } catch (err) { msg.textContent = `失败:${err.message}`; }
  },

  // ── 快手 ──
  async ksBatch() {
    const msg = document.getElementById('ksMsg');
    const url = document.getElementById('ksUrl').value.trim();
    if (!url) { msg.textContent = '请填写主页链接'; return; }
    const pages = +document.getElementById('ksPages').value || 5;
    try {
      const r = await API.subs.ksProfile(url, pages);
      msg.textContent = r.message || '已提交';
      UI.toast('快手主页批量已提交', `≤${pages} 页`);
      location.hash = '#/collect';
    } catch (err) { msg.textContent = `失败:${err.message}`; }
  },

  // ── 小红书 ──
  async xhsBatch() {
    const msg = document.getElementById('xhsMsg');
    const url = document.getElementById('xhsUrl').value.trim();
    if (!url) { msg.textContent = '请填写博主主页链接'; return; }
    msg.textContent = '解析博主…';
    try {
      const p = await API.subs.xhsParse(url);
      const pd = p.data || p;
      const uid = pd.user_id || pd.user?.user_id;
      if (!uid) { msg.textContent = '未能解析博主 ID'; return; }
      msg.textContent = `拉取 ${pd.nickname || pd.user?.nickname || uid} 的笔记…`;
      const n = await API.subs.xhsNotes(uid);
      const nd = n.data || n;
      const notes = nd.notes || [];
      if (!notes.length) { msg.textContent = '该博主暂无可下载笔记'; return; }
      await API.subs.xhsDownloadNotes(notes, pd.nickname || uid);
      msg.textContent = `已提交 ${notes.length} 篇笔记下载`;
      UI.toast('小红书批量已提交', `${notes.length} 篇笔记`);
      location.hash = '#/collect';
    } catch (err) { msg.textContent = `失败:${err.message}`; }
  },
};
