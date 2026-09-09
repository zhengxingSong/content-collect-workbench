/** 视图:总览 — KPI · 实时吞吐 · 来源健康度 · 最近动态 */
const DashboardPage = {
  timer: null,
  chart: null,
  series: Charts.randomWalk(),

  render(el) {
    const st = Mock.stats();
    el.innerHTML = `
      <div class="view-head">
        <div><h1 class="view-title">总览</h1><div class="view-sub">多来源媒体内容采集 · <span class="mono">${st.total}</span> 条内容在库</div></div>
        <div class="spacer"></div>
        <button class="btn primary" data-nav="collect"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>新建采集任务</button>
      </div>
      <div class="kpi-grid stagger">
        <div class="kpi"><div class="kpi-top"><span class="k-icon"><svg viewBox="0 0 24 24"><path d="M12 3v12m0 0l-4-4m4 4l4-4M4 21h16"/></svg></span>今日入库</div><div class="k-val">${st.today}<small>条</small></div><div class="k-trend up">▲ 较昨日 +18%</div></div>
        <div class="kpi" data-accent="sky"><div class="kpi-top"><span class="k-icon"><svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg></span>内容库总量</div><div class="k-val">${st.total}<small>条</small></div><div class="k-trend">含 ${SourceRegistry.live().length} 个已接入来源</div></div>
        <div class="kpi" data-accent="amber"><div class="kpi-top"><span class="k-icon"><svg viewBox="0 0 24 24"><path d="M9 12.5l2 2 4.5-5M12 3l7 3v5c0 5-3.5 8-7 10-3.5-2-7-5-7-10V6z"/></svg></span>完整性达标</div><div class="k-val">${st.completePct}<small>%</small></div><div class="k-trend">${st.total - st.complete} 条待修复</div></div>
        <div class="kpi" data-accent="rose"><div class="kpi-top"><span class="k-icon"><svg viewBox="0 0 24 24"><path d="M22 12h-4l-3 8-6-16-3 8H2"/></svg></span>服务健康</div><div class="k-val">3/4</div><div class="k-trend">mitmproxy 空闲 · 按需启动</div></div>
      </div>
      <div class="overview-grid">
        <div class="panel">
          <div class="ticker"><div class="ticker-track" id="tickerTrack"></div></div>
          <div class="panel-head"><div><div class="panel-title">实时吞吐</div><div class="panel-sub">全部来源合计 · 每 900ms 采样</div></div><div class="spacer"></div><span class="pill ok"><span class="svc-dot"></span>采集进行中</span></div>
          <div class="panel-body chart-wrap" id="chartWrap"></div>
          <div class="panel-body chart-stats">
            <div class="chart-stat"><b class="mono">15.6 <small style="font-size:11px;color:var(--text-3)">MB/s</small></b><span>当前速度</span></div>
            <div class="chart-stat"><b class="mono">3</b><span>进行中任务</span></div>
            <div class="chart-stat"><b class="mono">812</b><span>今日文件数</span></div>
            <div class="chart-stat"><b class="mono">96.2%</b><span>sha256 通过率</span></div>
          </div>
        </div>
        <div class="panel">
          <div class="panel-head"><div><div class="panel-title">来源健康度</div><div class="panel-sub">注册表驱动 · 自动汇总</div></div><div class="spacer"></div><button class="mini-btn" data-nav="sources">管理来源</button></div>
          <div id="healthList"></div>
        </div>
      </div>
      <div class="panel" style="margin-top:16px">
        <div class="panel-head"><div><div class="panel-title">最近动态</div><div class="panel-sub">采集 · 校验 · 风控 · 服务事件</div></div></div>
        <div class="feed stagger" id="feedList"></div>
      </div>`;

    // ticker
    const tick = document.getElementById('tickerTrack');
    const ticks = [];
    for (let i = 0; i < 12; i++) {
      const e = Mock.entries[Math.floor(Mock.seeded(i, 8) * Mock.entries.length)];
      const s = SourceRegistry.get(e.source);
      ticks.push(`<span class="tick"><span class="cdot" style="background:${s.color}"></span>${UI.esc(s.label)} · ${UI.esc(e.title.slice(0, 14))}… 入库</span>`);
    }
    tick.innerHTML = ticks.join('') + ticks.join('');

    // chart
    this.chart = Charts.sparkline(document.getElementById('chartWrap'), { w: 720, h: 130 });
    this.chart.update(this.series);
    clearInterval(this.timer);
    this.timer = setInterval(() => {
      const last = this.series[this.series.length - 1];
      const next = Math.max(0.04, Math.min(1, last + (Math.random() - 0.5) * 0.22));
      this.series.push(next); this.series.shift();
      this.chart.update(this.series);
    }, 900);

    // health list
    const health = document.getElementById('healthList');
    health.innerHTML = SourceRegistry.sources.map((s, i) => {
      const cnt = st.bySource[s.id] || 0;
      const h = s.status === 'planned' ? 0 : Math.round(72 + Mock.seeded(i, 2) * 28);
      return `<div class="src-row stagger">
        <div class="src-dot" style="background:${s.color}">${UI.esc(s.label[0])}</div>
        <div style="min-width:0;flex:1"><div class="src-name">${UI.esc(s.label)}${s.status === 'planned' ? ' <span class="badge">规划中</span>' : ''}</div><div class="src-sub">${UI.esc(s.desc)}</div></div>
        <div class="src-health"><div class="src-sub" style="display:flex;justify-content:space-between"><span>${s.status === 'planned' ? '待接入' : `健康 ${h}%`}</span><span class="mono">${cnt} 条</span></div><div class="bar"><i style="width:${h}%"></i></div></div>
      </div>`;
    }).join('');

    // feed
    document.getElementById('feedList').innerHTML = Mock.feed.map(f =>
      `<div class="feed-item"><div class="feed-ico ${f.ico}">${UI.ICONS[f.ico === 'sky' ? 'info' : f.ico] || UI.ICONS.ok}</div><div class="feed-text">${f.html}</div><div class="feed-time">${f.time}</div></div>`).join('');
  },

  onShow() { /* 图表定时器已在 render 中持续运行 */ },
};
