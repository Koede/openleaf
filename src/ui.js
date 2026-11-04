// Small UI toolkit: toasts, modal dialogs, context menus, dropdown behaviour.
import { esc } from './state.js';

const $ = (id) => document.getElementById(id);

export function toast(msg, opts = {}) {
  const { kind = 'info', ms = 3500, action } = typeof opts === 'number' ? { ms: opts } : opts;
  const host = $('toasts');
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.setAttribute('role', 'status');
  el.innerHTML = `<span>${esc(msg)}</span>`;
  if (action) { const b = document.createElement('button'); b.textContent = action.label; b.onclick = () => { action.run(); el.remove(); }; el.appendChild(b); }
  host.appendChild(el);
  const t = setTimeout(() => el.remove(), action ? Math.max(ms, 8000) : ms);
  el.onclick = (e) => { if (e.target === el) { clearTimeout(t); el.remove(); } };
  return el;
}

// Generic modal. fields: [{name,label,value,type:'text'|'select'|'checkbox',options:[{value,label}],hint,placeholder}]
export function modal({ title, message, fields = [], ok = 'OK', cancel = 'Cancel', danger = false, html = '', width }) {
  return new Promise((resolve) => {
    const prev = document.activeElement;
    const back = document.createElement('div');
    back.className = 'modal-back';
    const box = document.createElement('form');
    box.className = 'modal'; if (width) box.style.width = width;
    box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-label', title);
    box.innerHTML = `<h3>${esc(title)}</h3>${message ? `<p class="modal-msg">${esc(message)}</p>` : ''}${html}`;
    const inputs = {};
    for (const f of fields) {
      const row = document.createElement('label'); row.className = 'field' + (f.type === 'checkbox' ? ' check' : '');
      let ctl;
      if (f.type === 'select') { ctl = document.createElement('select'); for (const o of f.options) { const op = document.createElement('option'); op.value = o.value; op.textContent = o.label; ctl.appendChild(op); } ctl.value = f.value ?? f.options[0]?.value; }
      else if (f.type === 'checkbox') { ctl = document.createElement('input'); ctl.type = 'checkbox'; ctl.checked = !!f.value; }
      else { ctl = document.createElement('input'); ctl.type = 'text'; ctl.value = f.value ?? ''; ctl.placeholder = f.placeholder || ''; ctl.spellcheck = false; ctl.autocomplete = 'off'; }
      const span = document.createElement('span'); span.textContent = f.label;
      if (f.type === 'checkbox') { row.append(ctl, span); } else { row.append(span, ctl); }
      if (f.hint) { const h = document.createElement('small'); h.textContent = f.hint; row.appendChild(h); }
      box.appendChild(row); inputs[f.name] = ctl;
    }
    const bar = document.createElement('div'); bar.className = 'modal-actions';
    const c = document.createElement('button'); c.type = 'button'; c.textContent = cancel; if (!cancel) c.hidden = true;
    const o = document.createElement('button'); o.type = 'submit'; o.textContent = ok; o.className = danger ? 'danger' : 'primary';
    bar.append(c, o); box.appendChild(bar); back.appendChild(box); document.body.appendChild(back);
    const done = (v) => { back.remove(); if (prev && prev.focus) prev.focus(); resolve(v); };
    c.onclick = () => done(null);
    back.addEventListener('mousedown', (e) => { if (e.target === back) done(null); });
    box.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(null); } });
    box.onsubmit = (e) => { e.preventDefault(); const v = {}; for (const f of fields) v[f.name] = f.type === 'checkbox' ? inputs[f.name].checked : inputs[f.name].value; done(fields.length ? v : true); };
    const first = fields.length ? inputs[fields[0].name] : (danger ? c : o);
    setTimeout(() => { first.focus(); if (first.select && first.type === 'text') first.select(); }, 0);
  });
}
export const promptText = async (title, label, value = '', opts = {}) => { const r = await modal({ title, fields: [{ name: 'v', label, value, ...opts }], ok: opts.ok || 'OK' }); return r ? r.v.trim() : null; };
export const confirmBox = (title, message, { ok = 'OK', danger = false } = {}) => modal({ title, message, ok, danger });

// Context menu: items [{label, run, danger, disabled, sep, hint}]
let openMenu = null;
export function contextMenu(x, y, items) {
  closeMenu();
  const m = document.createElement('div'); m.className = 'ctxmenu'; m.setAttribute('role', 'menu');
  for (const it of items) {
    if (it.sep) { const s = document.createElement('div'); s.className = 'sep'; m.appendChild(s); continue; }
    const b = document.createElement('button'); b.type = 'button'; b.setAttribute('role', 'menuitem');
    b.className = (it.danger ? 'danger ' : '') + (it.disabled ? 'disabled' : '');
    b.innerHTML = `<span>${esc(it.label)}</span>${it.hint ? `<kbd>${esc(it.hint)}</kbd>` : ''}`;
    if (!it.disabled) b.onclick = () => { closeMenu(); it.run(); };
    m.appendChild(b);
  }
  document.body.appendChild(m);
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 4)) + 'px';
  m.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 4)) + 'px';
  openMenu = m;
  const off = (e) => { if (!m.contains(e.target)) closeMenu(); };
  setTimeout(() => { document.addEventListener('pointerdown', off, true); document.addEventListener('keydown', escClose, true); window.addEventListener('blur', closeMenu); }, 0);
  m._cleanup = () => { document.removeEventListener('pointerdown', off, true); document.removeEventListener('keydown', escClose, true); window.removeEventListener('blur', closeMenu); };
  m.querySelector('button:not(.disabled)')?.focus();
}
const escClose = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeMenu(); } };
export function closeMenu() { if (openMenu) { openMenu._cleanup && openMenu._cleanup(); openMenu.remove(); openMenu = null; } }

// Anchored dropdown: toggles `panel` under `button`. Returns {open, close, isOpen}.
export function dropdown(button, panel, { onOpen, onClose, keepOpen = () => false } = {}) {
  let isOpen = false;
  const place = () => {
    if (panel.dataset.floating === '1') return;
    const b = button.getBoundingClientRect(); const w = panel.offsetWidth;
    panel.style.left = Math.max(6, Math.min(b.left, innerWidth - w - 6)) + 'px';
    panel.style.top = b.bottom + 4 + 'px';
  };
  const open = () => { if (isOpen) return; isOpen = true; panel.hidden = false; button.setAttribute('aria-expanded', 'true'); place(); onOpen && onOpen(); document.addEventListener('pointerdown', off, true); document.addEventListener('keydown', key, true); };
  const close = () => { if (!isOpen) return; isOpen = false; panel.hidden = true; button.setAttribute('aria-expanded', 'false'); onClose && onClose(); document.removeEventListener('pointerdown', off, true); document.removeEventListener('keydown', key, true); };
  const off = (e) => { if (keepOpen()) return; if (!panel.contains(e.target) && !button.contains(e.target)) close(); };
  const key = (e) => { if (e.key === 'Escape' && !keepOpen()) { close(); } };
  button.addEventListener('click', () => (isOpen ? close() : open()));
  return { open, close, isOpen: () => isOpen, place };
}

export const timeAgo = (ts) => {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 45) return 'just now'; if (s < 3600) return Math.round(s / 60) + ' min ago'; if (s < 86400) return Math.round(s / 3600) + ' h ago';
  return new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};
