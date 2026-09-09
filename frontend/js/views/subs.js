/** 视图:订阅与批量 — 组识别采集:UP主投稿 / 主页批量 / 博主笔记(对应各平台已有后端能力) */
const SubsPage = {
  biliVideos: [],
  biliPage: 1,
  biliSelected: new Set(),

  render(el) {
    el.innerHTML = `
      <div class="view-head">
        <div><h1 class="view-title">订阅与批量</h1><div class="view-sub">组识别采集:UP主全部投稿 · 博主笔记 · 主页批量(单视频走「采集任务」)</div></div>
      </div>
      <div class="assume"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8h.01M12 11v5"/></svg><span>B站 UGC 合集(非多P)暂需后端扩展;多P 课程/选集直接粘贴单视频链接即全 P 下载。抖音合集与喜欢列表经 sec_uid 批量。</span></div>
      <div class="grid-2" style="grid-template-columns:1fr 1fr">
        <div class="panel">
          <div class="panel-head"><div><div class="panel-title">B站 · UP主订阅</div><div class="panel-sub">粘贴 UP 主主页链接解析并订阅,勾选投稿批量下载</div></div></div>
          <div class="panel-body">
            <div style="display:flex;gap:8px">
              <input id="biliParseUrl" placeholder="https://space.bilibili.com/…" style="flex:1">
              <button class="btn primary" id="biliParseBtn">解析</button>
            </div>
            <div id="biliParseInfo" class="view-sub" style="margin-top:8px;min-height:18px"></div>
          </div>
          <div class="panel-head"><div class="panel-title" style="font-size:12.5px">已订阅 UP 主</div><div class="spacer"></div><span class="badge" id="biliAccCnt">0</span></div>
          <div id="biliAccounts"><div class="empty">加载中…</div></div>
        </div>
        <div class="panel">
          <div class="panel-head"><div><div class="panel-title">投稿列表与批量下载</div><div class="panel-sub">选中后入 B站后台队列(需先扫码登录)</div></div></div>
          <div id="biliVideoArea"><div class="empty">左侧选择一个 UP 主查看投稿</div></div>
        </div>
      </div>
      <div class="sources-grid" style="margin-top:16px;grid-template-columns:repeat(auto-fill,minmax(340px,1fr))">
        <div class="source-card" style="--src-color:#f06a72">
          <div class="sc-head"><div class="sc-avatar" style="background:#f06a72">抖</div><div><div class="sc-name">抖音 · 主页/喜欢/合集批量</div><div class="sc-kind">按 sec_uid 批量,单任务全局队列</div></div></div>
          <div class="panel-body" style="padding:12px 0 0">
            <div class="field"><input id="dySecUid" placeholder="sec_uid 或抖音主页链接"></div>
            <div class="seg" id="dyTypes"><button data-t="post" class="on">作品</button><button data-t="like">喜欢</button><button data-t="mix">合集</button></div>
            <div style="display:flex;gap:8px;margin-top:10px;align-items:center"><span class="view-sub">页数上限</span><input id="dyPages" type="number" value="10" style="width:80px"><button class="btn primary" id="dyGo">开始批量</button></div>
            <div class="view-sub" id="dyMsg" style="margin-top:6px;min-height:16px"></div>
          </div>
        </div>
        <div class="source-card" style="--src-color:#f5b64d">
          <div class="sc-head"><div class="sc-avatar" style="background:#f5b64d">快</div><div><div class="sc-name">快手 · 主页批量</div><div class="sc-kind">按主页链接批量下载作品</div></div></div>
          <div class="panel-body" style="padding:12px 0 0">
            <div class="field"><input id="ksUrl" placeholder="快手主页链接"></div>
            <div style="display:flex;gap:8px;align-items:center"><span class="view-sub">页数上限</span><input id="ksPages" type="number" value="5" style="width:80px"><button class="btn primary" id="ksGo">开始批量</button></div>
            <div class="view-sub" id="ksMsg" style="margin-top:6px;min-height:16px"></div>
          </div>
        </div>
        <div class="source-card" style="--src-color:#ff7aa2">
          <div class="sc-head"><div class="sc-avatar" style="background:#ff7aa2">红</div><div><div class="sc-name">小红书 · 博主笔记批量</div><div class="sc-kind">解析博主 → 拉取笔记 → 入库下载</div></div></div>
          <div class="panel-body" style="padding:12px 0 0">
            <div class="field"><input id="xhsUrl" placeholder="小红书博主主页链接"></div>
            <button class="btn primary" id="xhsGo">解析并批量下载</button>
            <div class="view-sub" id="xhsMsg" style="margin-top:6px;min-height:16px"></div>
          </div>
        </div>
        <div class="source-card" style="--src-color:#2dd98a">
          <div class="sc-head"><div class="sc-avatar" style="background:#2dd98a">公</div><div><div class="sc-name">公众号 · 收藏与 RSS</div><div class="sc-kind">收藏公众号 + RSS 定时增量(采集源页管理)</div></div></div>
          <div class="panel-body" style="padding:12px 0 0"><button class="btn" id="mpGo">前往采集源管理</button></div>
        </div>
      </div>`;

    document.getElementById('biliParseBtn').addEventListener('click', () => this.parseBiliUp());
    document.getElementById('dyGo').addEventListener('click', () => this.douyinBatch());
    document.getElementById('ksGo').addEventListener('click', () => this.ksBatch());
    document.getElementById('xhsGo').addEventListener('click', () => this.xhsBatch());
    document.getElementById('mpGo').addEventListener('click', () => { location.hash = '#/sources'; });
    this.loadBiliAccounts();
  },

  // ── B站 UP主 ──
  async parseBiliUp() {
    const info = document.getElementById('biliParseInfo');
    const url = document.getElementById('biliParseUrl').value.trim();
    if (!url) return;
    info.textContent = '解析中…';
    try {
      const r = await API.subs.biliParse(url);
      const d = r.data || r;
      info.innerHTML = `UP主:<b>${UI.esc(d.nickname || d.mid)}</b> <button class="mini-btn" id="biliAddBtn">订阅</button>`;
      document.getElementById('biliAddBtn').addEventListener('click', async () => {
        try {
          await API.subs.biliAdd({ mid: d.mid, nickname: d.nickname, avatar: d.avatar, desc: d.desc });
          UI.toast('已订阅 UP 主', d.nickname || d.mid);
          this.loadBiliAccounts();
        } catch (err) { UI.toast('订阅失败', err.message, 'err'); }
      });
    } catch (err) { info.textContent = `解析失败:${err.message}`; }
  },

  async loadBiliAccounts() {
    const box = document.getElementById('biliAccounts');
    try {
      const d = await API.subs.biliAccounts();
      const accs = d.accounts || [];
      document.getElementById('biliAccCnt').textContent = accs.length;
      box.innerHTML = accs.length ? accs.map(a => `
        <div class="src-row"><div class="src-dot" style="background:#7ab8ff">${UI.esc((a.nickname || '?')[0])}</div>
          <div style="min-width:0;flex:1"><div class="src-name">${UI.esc(a.nickname || a.mid)}</div><div class="src-sub mono">mid ${UI.esc(a.mid)}</div></div>
          <button class="mini-btn" data-bv="${a.mid}">投稿列表</button>
          <button class="mini-btn danger" data-bdel="${a.mid}">退订</button></div>`).join('')
        : '<div class="empty">暂无订阅 — 上方解析并订阅</div>';
      box.onclick = e => {
        const v = e.target.closest('[data-bv]');
        if (v) { this.loadBiliVideos(v.dataset.bv); return; }
        const del = e.target.closest('[data-bdel]');
        if (del) API.subs.biliRemove(del.dataset.bdel).then(() => { UI.toast('已退订'); this.loadBiliAccounts(); }).catch(err => UI.toast('退订失败', err.message, 'err'));
      };
    } catch (err) { box.innerHTML = `<div class="empty">加载失败:${UI.esc(err.message)}</div>`; }
  },

  async loadBiliVideos(mid) {
    const area = document.getElementById('biliVideoArea');
    area.innerHTML = '<div class="empty">加载投稿中…</div>';
    this.biliPage = 1; this.biliSelected = new Set(); this._biliMid = mid;
    const load = async () => {
      try {
        const d = await API.subs.biliVideos(mid, this.biliPage);
        this.biliVideos = d.videos || [];
        const total = d.total || this.biliVideos.length;
        if (!this.biliVideos.length) { area.innerHTML = '<div class="empty">该 UP 主暂无投稿</div>'; return; }
        area.innerHTML = `
          <div class="task-meta" style="padding:10px 20px 0"><span>共 ${total} 个投稿 · 第 ${this.biliPage} 页</span><div class="spacer" style="flex:1"></div>
            <button class="mini-btn" id="biliPrev" ${this.biliPage <= 1 ? 'disabled' : ''}>上一页</button>
            <button class="mini-btn" id="biliNext" ${this.biliPage * 30 >= total ? 'disabled' : ''}>下一页</button>
            <button class="btn primary" id="biliBatch" ${this.biliSelected.size ? '' : 'disabled'}>批量下载 (${this.biliSelected.size})</button></div>
          <div class="table-wrap" style="max-height:420px;overflow:auto"><table class="table"><tbody>
            ${this.biliVideos.map(v => `<tr><td style="width:34px"><input type="checkbox" class="checkbox" data-bvid="${UI.esc(v.bvid)}" ${this.biliSelected.has(v.bvid) ? 'checked' : ''}></td>
              <td class="td-title" style="max-width:280px">${UI.esc(v.title || v.bvid)}</td></tr>`).join('')}
          </tbody></table></div>`;
        area.querySelectorAll('[data-bvid]').forEach(c => c.addEventListener('change', () => {
          c.checked ? this.biliSelected.add(c.dataset.bvid) : this.biliSelected.delete(c.dataset.bvid);
          const btn = document.getElementById('biliBatch');
          if (btn) { btn.textContent = `批量下载 (${this.biliSelected.size})`; btn.disabled = !this.biliSelected.size; }
        }));
        document.getElementById('biliPrev').addEventListener('click', () => { this.biliPage--; load(); });
        document.getElementById('biliNext').addEventListener('click', () => { this.biliPage++; load(); });
        document.getElementById('biliBatch').addEventListener('click', async () => {
          const items = this.biliVideos.filter(v => this.biliSelected.has(v.bvid)).map(v => ({ bvid: v.bvid, title: v.title, page_num: 1 }));
          try {
            const r = await API.subs.biliBatch(items);
            UI.toast('B站批量任务已提交', r.message || `${items.length} 项`);
            location.hash = '#/collect';
          } catch (err) { UI.toast('提交失败', err.message, 'err'); }
        });
      } catch (err) { area.innerHTML = `<div class="empty">投稿加载失败:${UI.esc(err.message)}</div>`; }
    };
    load();
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
      UI.toast('快手主页批量已提交', `${url.slice(0, 30)}… ≤${pages} 页`);
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
