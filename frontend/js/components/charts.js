/**
 * 轻量图表:SVG 迷你吞吐图
 */
const Charts = (() => {
  /**
   * 实时面积图:容器内渲染 SVG,返回 {update(series)} 轮询驱动
   * series: 0..1 数值数组
   */
  function sparkline(container, { w = 720, h = 130, color = '#2dd98a' } = {}) {
    const id = `g${Math.random().toString(36).slice(2, 8)}`;
    container.innerHTML = `
      <svg class="chart-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="${color}" stop-opacity=".28"/>
            <stop offset="1" stop-color="${color}" stop-opacity="0"/>
          </linearGradient>
        </defs>
        <path id="${id}-area" fill="url(#${id})"/>
        <path id="${id}-line" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      </svg>`;
    const area = container.querySelector(`#${id}-area`);
    const line = container.querySelector(`#${id}-line`);
    let series = [];
    function update(next) {
      series = next;
      if (!series.length) return;
      const n = series.length;
      const px = i => (i / (n - 1)) * w;
      const py = v => h - 8 - Math.max(0, Math.min(1, v)) * (h - 18);
      let d = `M0,${py(series[0])}`;
      for (let i = 1; i < n; i++) d += ` L${px(i).toFixed(1)},${py(series[i]).toFixed(1)}`;
      line.setAttribute('d', d);
      area.setAttribute('d', `${d} L${w},${h} L0,${h} Z`);
    }
    return { update };
  }

  /** 简单随机游走数据源(演示;真实数据接入后替换为采样器) */
  function randomWalk(len = 48, base = 0.45, vol = 0.14) {
    let v = base;
    return Array.from({ length: len }, () => {
      v += (Math.random() - 0.5) * vol * 2;
      v = Math.max(0.04, Math.min(1, v));
      return v;
    });
  }

  return { sparkline, randomWalk };
})();
