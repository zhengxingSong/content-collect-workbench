/**
 * Hash 路由 — 沿用旧约定(#/page),视图按需渲染并缓存
 */
const Router = {
  routes: {},          // name -> { render(container, params), meta }
  current: null,
  rendered: {},        // name -> true(已渲染过)

  register(name, def) { this.routes[name] = def; },

  init(defaultView) {
    window.addEventListener('hashchange', () => this.handle());
    if (!location.hash) location.hash = `#/${defaultView}`;
    this.handle();
  },

  handle() {
    const name = (location.hash.replace(/^#\/?/, '') || 'dashboard').split('?')[0];
    const def = this.routes[name];
    if (!def) { location.hash = '#/dashboard'; return; }
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    const el = document.getElementById(`view-${name}`);
    if (!el) return;
    el.classList.add('active');
    document.querySelectorAll('.nav-item[data-view]').forEach(n => n.classList.toggle('active', n.dataset.view === name));
    if (def.meta) {
      const c = document.getElementById('crumbSection'), d = document.getElementById('crumbDetail');
      if (c) c.textContent = def.meta.section || '';
      if (d) d.textContent = def.meta.title || '';
    }
    if (!this.rendered[name]) { def.render(el); this.rendered[name] = true; }
    else if (def.onShow) def.onShow(el);
    if (def.meta && def.meta.title) document.title = `${def.meta.title} · 内容收集工作台`;
    this.current = name;
    document.querySelector('.view-wrap').scrollTop = 0;
  },
};
