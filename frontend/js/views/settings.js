/** 视图:设置 — 采集行为 / 网络与代理 / 来源凭据(按来源 tab) / 关于 */
const SettingsPage = {
  tab: 'collect',

  render(el) {
    const live = SourceRegistry.live();
    el.innerHTML = `
      <div class="view-head">
        <div><h1 class="view-title">设置</h1><div class="view-sub">保存后立即写回 /api/settings,后端不可达时保留本地演示状态</div></div>
        <div class="spacer"></div>
        <button class="btn primary" id="btnSaveSettings"><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>保存全部</button>
      </div>
      <div class="tab-bar" id="setTabs">
        <button class="tab on" data-t="collect">采集行为</button>
        <button class="tab" data-t="network">网络与代理</button>
        <button class="tab" data-t="credentials">来源凭据</button>
        <button class="tab" data-t="about">关于</button>
      </div>
      <div id="setBody"></div>`;

    document.getElementById('setTabs').addEventListener('click', e => {
      const b = e.target.closest('[data-t]'); if (!b) return;
      this.tab = b.dataset.t;
      document.querySelectorAll('#setTabs .tab').forEach(x => x.classList.toggle('on', x === b));
      this.renderBody();
    });
    this.renderBody();

    document.getElementById('btnSaveSettings').addEventListener('click', async () => {
      await API.settings.save(Mock.settings);
      UI.toast('设置已保存', '已写回 /api/settings');
    });
  },

  renderBody() {
    const body = document.getElementById('setBody');
    const live = SourceRegistry.live();
    if (this.tab === 'collect') {
      body.innerHTML = `<div class="panel"><div class="panel-head"><div class="panel-title">采集行为</div></div><div class="panel-body">
        <div class="field"><label>下载目录</label><input value="${UI.esc(Mock.settings.download_dir)}" data-set="download_dir"><div class="hint">内容库根目录;manifest 与 media/ 均存于条目子目录</div></div>
        <div class="field"><label>单次最多拉取条数</label><input type="number" value="${Mock.settings.max_articles}" data-set="max_articles" style="width:140px"></div>
        <div class="field"><label>请求间隔(秒)</label><input type="number" step="0.1" value="${Mock.settings.request_delay}" data-set="request_delay" style="width:140px"><div class="hint">过小易触发风控,建议 ≥ 0.5</div></div>
        <div class="toggle-row"><span>自动保存正文图片</span><button class="toggle${Mock.settings.auto_save_images ? ' on' : ''}" data-tog="auto_save_images"></button></div>
        <div class="toggle-row"><span>自动保存正文视频</span><button class="toggle${Mock.settings.auto_save_videos ? ' on' : ''}" data-tog="auto_save_videos"></button></div>
        <div class="toggle-row"><span>RSS 自动上传(输出 Feed 到远端)</span><button class="toggle${Mock.settings.rss_upload_enabled ? ' on' : ''}" data-tog="rss_upload_enabled"></button></div>
      </div></div>`;
    } else if (this.tab === 'network') {
      body.innerHTML = `<div class="panel"><div class="panel-head"><div class="panel-title">网络与代理</div></div><div class="panel-body">
        <div class="field"><label>代理地址</label><input value="${UI.esc(Mock.settings.proxy)}" data-set="proxy" placeholder="http://127.0.0.1:7890(留空直连)"></div>
        <div class="stat-line"><span class="k">代理池</span><span class="v">未启用</span></div>
        <div class="stat-line"><span class="k">TLS 指纹</span><span class="v">curl_cffi · chrome 模拟</span></div>
        <div class="stat-line"><span class="k">mitmproxy 证书</span><span class="v" style="color:var(--amber)">未安装(视频号采集时按需安装)</span></div>
        <div class="stat-line"><span class="k">微信 AppID</span><span class="v mono">${UI.esc(Mock.settings.appid)}</span></div>
        <div style="margin-top:14px;display:flex;gap:10px"><button class="btn" id="btnTestProxy">测试连通性</button><button class="btn" id="btnReauth">重新认证</button></div>
      </div></div>`;
    } else if (this.tab === 'credentials') {
      body.innerHTML = `<div class="panel"><div class="panel-head"><div><div class="panel-title">来源凭据</div><div class="panel-sub">按来源隔离 · 凭证不纳入备份与 MCP</div></div></div><div class="panel-body">
        <div class="seg" id="credSeg" style="margin-bottom:16px">${live.map((s, i) => `<button data-c="${s.id}" class="${i === 0 ? 'on' : ''}">${UI.esc(s.label)}</button>`).join('')}</div>
        <div id="credBody"></div>
      </div></div>`;
      const renderCred = id => {
        const s = SourceRegistry.get(id);
        const hasPool = ['wechat-mp', 'douyin', 'bilibili', 'xhs', 'wechat-channels', 'kuaishou'].includes(id);
        document.getElementById('credBody').innerHTML = `
          <div class="stat-line"><span class="k">认证方式</span><span class="v">${id === 'rss' || id === 'url' ? '无需认证' : hasPool ? '浏览器会话 / Cookie' : '—'}</span></div>
          <div class="stat-line"><span class="k">登录态</span><span class="v">${hasPool ? '<span class="pill ok">有效</span>' : '<span class="pill">不适用</span>'}</span></div>
          ${hasPool ? `<div class="stat-line"><span class="k">账号池</span><span class="v">${(Mock.pools[id] || []).length} 个账号</span></div>` : ''}
          <div style="margin-top:14px;display:flex;gap:10px">
            ${hasPool ? '<button class="btn" id="btnScanLogin">扫码登录</button><button class="btn" id="btnBrowserLogin">浏览器登录</button>' : ''}
            <button class="btn danger" id="btnClearCred">清除该来源凭据</button>
          </div>
          <div class="hint" style="margin-top:10px">${UI.esc(s.desc)}</div>`;
        const bind = (sid, msg) => { const b = document.getElementById(sid); if (b) b.addEventListener('click', () => UI.toast(msg, s.label)); };
        bind('btnScanLogin', '二维码已生成,请使用对应 App 扫码');
        bind('btnBrowserLogin', '浏览器会话窗口已打开');
        bind('btnClearCred', '凭据清除请求已提交(需二次确认)');
      };
      let cred = live[0].id;
      document.getElementById('credSeg').addEventListener('click', e => {
        const b = e.target.closest('[data-c]'); if (!b) return;
        cred = b.dataset.c;
        document.querySelectorAll('#credSeg button').forEach(x => x.classList.toggle('on', x === b));
        renderCred(cred);
      });
      renderCred(cred);
    } else {
      body.innerHTML = `<div class="panel"><div class="panel-head"><div class="panel-title">关于</div></div><div class="panel-body">
        <div class="stat-line"><span class="k">产品</span><span class="v">内容收集工作台 v2.0</span></div>
        <div class="stat-line"><span class="k">内核</span><span class="v mono">content-collect-workbench v2.0 · Flask + vanilla SPA</span></div>
        <div class="stat-line"><span class="k">已接入来源</span><span class="v">${live.length} 个(+${SourceRegistry.planned().length} 规划)</span></div>
        <div class="stat-line"><span class="k">MCP 工具</span><span class="v mono">3 个(仅查询与下载,不含备份/恢复)</span></div>
        <div class="stat-line"><span class="k">定位声明</span><span class="v" style="font-weight:400;max-width:60%">仅供个人学习、技术研究与本地备份使用</span></div>
      </div></div>`;
    }

    // 通用交互绑定
    body.querySelectorAll('[data-tog]').forEach(t => t.addEventListener('click', () => {
      const on = t.classList.toggle('on');
      Mock.settings[t.dataset.tog] = on;
    }));
    body.querySelectorAll('[data-set]').forEach(i => i.addEventListener('input', () => { Mock.settings[i.dataset.set] = i.value; }));
    const tp = document.getElementById('btnTestProxy');
    if (tp) tp.addEventListener('click', () => UI.toast('代理连通性正常', '延迟 42ms · 出口 IP 伪装生效'));
    const ra = document.getElementById('btnReauth');
    if (ra) ra.addEventListener('click', () => UI.toast('重新认证流程已启动', '将打开浏览器会话', 'warn'));
  },
};
