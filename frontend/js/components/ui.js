/**
 * UI 组件:toast / modal / 通用工具
 */
const UI = (() => {
  const ICONS = {
    ok: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    warn: '<svg viewBox="0 0 24 24"><path d="M12 8v5m0 3.5v.5M10.3 3.8L1.9 18a2 2 0 001.7 3h16.8a2 2 0 001.7-3L13.7 3.8a2 2 0 00-3.4 0z"/></svg>',
    err: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    info: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8h.01M12 11v5"/></svg>',
  };

  function toast(title, desc, type = 'ok') {
    let wrap = document.querySelector('.toast-wrap');
    if (!wrap) { wrap = document.createElement('div'); wrap.className = 'toast-wrap'; document.body.appendChild(wrap); }
    const el = document.createElement('div');
    el.className = `toast ${type === 'err' || type === 'warn' ? type : ''}`;
    el.innerHTML = `<div class="toast-ico">${ICONS[type] || ICONS.ok}</div><div style="min-width:0"><div class="toast-title"></div><div class="toast-desc"></div></div>`;
    el.querySelector('.toast-title').textContent = title;
    el.querySelector('.toast-desc').textContent = desc || '';
    wrap.appendChild(el);
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 320); }, 3600);
  }

  /** 打开内置 dialog;返回 close 函数。esc/背板关闭 */
  function openModal(innerHTML, { wide = false } = {}) {
    const overlay = document.createElement('div');
    overlay.className = 'overlay open';
    overlay.innerHTML = `<div class="modal${wide ? ' wide' : ''}" role="dialog" aria-modal="true">${innerHTML}</div>`;
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = e => { if (e.key === 'Escape') close(); };
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
    overlay.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', close));
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
    return { close, overlay };
  }

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const debounce = (fn, ms = 250) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  /** 来源 pill(注册表驱动) */
  function sourcePill(id) {
    const s = SourceRegistry.get(id);
    if (!s) return '<span class="pill">未知</span>';
    const planned = s.status === 'planned' ? ' opacity:.55' : '';
    return `<span class="pill${s.status === 'planned' ? '' : ' ok'}" style="--src-color:${s.color}${planned}" title="${esc(s.label)} · ${esc(s.desc)}"><span class="cdot" style="width:7px;height:7px;border-radius:50%;background:${s.color}"></span>${esc(s.label)}</span>`;
  }

  const integrityPill = v => `<span class="integrity ${v}">${({ complete: '完整', partial: '部分缺失', corrupt: '损坏' })[v] || v}</span>`;

  const fmtTime = d => {
    const p = n => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };
  const ago = str => {
    const diff = Date.now() - new Date(str.replace(' ', 'T')).getTime();
    const m = Math.floor(diff / 60000);
    if (m < 1) return '刚刚'; if (m < 60) return `${m} 分钟前`;
    const h = Math.floor(m / 60); if (h < 24) return `${h} 小时前`;
    return `${Math.floor(h / 24)} 天前`;
  };

  /** 分页(省略号逻辑) */
  function pageBtns(cur, total, go) {
    const pages = new Set([1, total, cur - 1, cur, cur + 1].filter(p => p >= 1 && p <= total));
    let html = `<button class="page-btn" data-pg="${cur - 1}" ${cur <= 1 ? 'disabled' : ''}>‹</button>`;
    let prev = 0;
    for (const p of [...pages].sort((a, b) => a - b)) {
      if (prev && p - prev > 1) html += '<span class="page-ellipsis">…</span>';
      html += `<button class="page-btn${p === cur ? ' on' : ''}" data-pg="${p}">${p}</button>`;
      prev = p;
    }
    html += `<button class="page-btn" data-pg="${cur + 1}" ${cur >= total ? 'disabled' : ''}>›</button>`;
    return html;
  }

  return { toast, openModal, esc, debounce, sourcePill, integrityPill, fmtTime, ago, pageBtns, ICONS };
})();
