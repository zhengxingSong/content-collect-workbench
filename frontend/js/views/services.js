/** 视图:服务监控 — Flask/MCP/mitmproxy/转码 面板 · 运行日志 · 故障预算 */
const ServicesPage = {
  logTimer: null,

  render(el) {
    el.innerHTML = `
      <div class="view-head">
        <div><h1 class="view-title">服务监控</h1><div class="view-sub">进程监督 · 指数退避重启 · 每小时故障预算 5 次</div></div>
        <div class="spacer"></div>
        <button class="btn" id="btnRestart"><svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 11-9-9"/><path d="M21 3l-9 9"/></svg>重启全部服务</button>
      </div>
      <div class="kpi-grid stagger" style="grid-template-columns:repeat(4,1fr)">
        <div class="kpi"><div class="kpi-top">累计运行</div><div class="k-val">3<small> 天 04:12</small></div><div class="k-trend">自上次冷启动</div></div>
        <div class="kpi" data-accent="amber"><div class="kpi-top">故障预算</div><div class="k-val">1<small> / 5 每小时</small></div><div class="k-trend">mitmproxy 一次退出重启</div></div>
        <div class="kpi" data-accent="sky"><div class="kpi-top">MCP 工具</div><div class="k-val">3<small> 个</small></div><div class="k-trend">wechat_article_download / progress / status</div></div>
        <div class="kpi" data-accent="rose"><div class="kpi-top">致命错误</div><div class="k-val">0</div><div class="k-trend up">全部自愈</div></div>
      </div>
      <div class="grid-2">
        <div class="panel"><div class="panel-head"><div class="panel-title">服务实例</div><div class="panel-sub">spawn / 就绪轮询 / 退避重启</div></div><div id="svcList"></div></div>
        <div class="panel">
          <div class="panel-head"><div><div class="panel-title">运行日志</div><div class="panel-sub">滚动 · 保留 120 行</div></div><div class="spacer"></div><button class="mini-btn" id="btnClearLog">清空</button></div>
          <div class="panel-body"><div class="log" id="logView"></div></div>
        </div>
      </div>`;

    const statePill = { running: '<span class="pill ok"><span class="svc-dot"></span>运行中</span>', idle: '<span class="pill warn"><span class="svc-dot idle"></span>空闲(按需)</span>', stopped: '<span class="pill err">已停止</span>' };
    document.getElementById('svcList').innerHTML = Mock.services.map(s => `
      <div class="svc-head">
        <div style="min-width:0;flex:1"><div class="svc-title">${UI.esc(s.name)}</div><div class="svc-url mono">${UI.esc(s.url)} · ${UI.esc(s.role)}</div></div>
        ${statePill[s.state]}
        <div style="text-align:right"><div class="mono" style="font-size:12px">${s.uptime}</div><div class="svc-url">重启 ${s.restarts} 次</div></div>
        <button class="mini-btn" data-svc="${s.id}">${s.state === 'running' ? '停止' : '启动'}</button>
      </div>`).join('');
    document.getElementById('svcList').addEventListener('click', e => {
      const b = e.target.closest('[data-svc]'); if (!b) return;
      const s = Mock.services.find(x => x.id === b.dataset.svc);
      UI.toast(`${s.name} ${s.state === 'running' ? '停止' : '启动'}指令已发送`, '进程监督器将按退避策略接管', s.state === 'running' ? 'warn' : 'ok');
    });
    document.getElementById('btnRestart').addEventListener('click', () =>
      UI.toast('重启序列已启动', '后端就绪 → 注入地址启动 MCP → 健康检查', 'warn'));

    // 日志流
    const log = document.getElementById('logView');
    let lines = [...Mock.logs];
    const renderLog = () => { log.innerHTML = lines.slice(-120).map(l => `<div class="log-line"><span class="t">[${l.t}]</span> <span class="src ${l.cls}">[${l.name}]</span> <span class="lv-${l.lv}">${UI.esc(l.msg)}</span></div>`).join(''); log.scrollTop = log.scrollHeight; };
    renderLog();
    const SOURCES = [['b', '后端'], ['m', 'mcp'], ['p', '转码']];
    clearInterval(this.logTimer);
    this.logTimer = setInterval(() => {
      const [cls, name] = SOURCES[Math.floor(Math.random() * 3)];
      const m = Mock.logs[Math.floor(Math.random() * Mock.logs.length)];
      const p = n => String(n).padStart(2, '0'); const d = new Date();
      lines.push({ cls, name, lv: m.lv, msg: m.msg, t: `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` });
      lines = lines.slice(-120);
      renderLog();
    }, 2600);
    document.getElementById('btnClearLog').addEventListener('click', () => { lines = []; renderLog(); });
  },
};
