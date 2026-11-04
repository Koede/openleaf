// Symbols dropdown: Mathematica-style Templates, searchable Symbols, and a Detexify-style drawing matcher.
import { S, bus, prefs, savePrefs, esc, debounce } from './state.js';
import { insertTemplate, insertSymbol, setExtraCommands, view } from './editor.js';
import { editFile, openFile } from './files.js';
import { dropdown, toast } from './ui.js';

const $ = (id) => document.getElementById(id);
let DATA = null, loading = null;
const symUrl = (n) => (window.__symUrl ? window.__symUrl(n) : `/symbols/${n}.png`);
const GRID = 20;

async function ensureData() {
  if (DATA) return DATA;
  if (!loading) loading = fetch('/symbols/symbols.json').then((r) => { if (!r.ok) throw new Error('symbol data missing — run: python3 tools/gen-symbols.py'); return r.json(); }).then((d) => {
    d.symbols.forEach((s) => { s.f = Float32Array.from(s.p, (v) => v / 100); s.hay = (s.c + ' ' + s.cat + ' ' + s.k + ' ' + s.pkg).toLowerCase(); });
    d.templates.forEach((t) => { t.hay = (t.n + ' ' + t.cat + ' ' + t.i.replace(/#\{\d+\}/g, '')).toLowerCase(); });
    setExtraCommands([...new Set(d.symbols.map((s) => s.c).filter((c) => /^\\[A-Za-z]+$/.test(c)).map((c) => c.slice(1)))]);
    DATA = d; return d;
  });
  return loading;
}
// warm the command-completion list shortly after start
setTimeout(() => ensureData().catch(() => {}), 1500);

// ---------- packages ----------
const IMPLIES = { mathtools: ['amsmath'], amssymb: ['amsfonts'], beamer: ['amsmath', 'amssymb', 'amsfonts', 'graphicx', 'hyperref'], physics: ['amsmath'], siunitx: [], hyperref: [] };
function loadedPackages() {
  const have = new Set(); let beamer = false;
  for (const [p, t] of S.cache) {
    if (!/\.(tex|sty|cls)$/.test(p)) continue;
    for (const m of t.matchAll(/\\(?:usepackage|RequirePackage)(?:\[[^\]]*\])?\{([^}]*)\}/g)) m[1].split(',').forEach((x) => have.add(x.trim()));
    if (/\\documentclass(?:\[[^\]]*\])?\{beamer\}/.test(t)) beamer = true;
  }
  if (beamer) have.add('beamer');
  for (const h of [...have]) (IMPLIES[h] || []).forEach((x) => have.add(x));
  return have;
}
const warned = new Set();
function checkPackage(pkg, label) {
  if (!pkg || ['latexsym'].includes(pkg) && loadedPackages().has('amssymb')) return;
  if (loadedPackages().has(pkg) || warned.has(S.project + pkg)) return;
  warned.add(S.project + pkg);
  toast(`${label} needs \\usepackage{${pkg}}`, { kind: 'warn', action: { label: 'Add it', run: () => addPackage(pkg) } });
}
export async function addPackage(pkg) {
  const files = [...S.cache.entries()].filter(([p, t]) => /\.(tex|sty|cls)$/.test(p) && /\\usepackage/.test(t));
  const root = S.settings.main && S.cache.get(S.settings.main);
  let target = null;
  if (root && /\\usepackage/.test(root)) target = S.settings.main;
  else if (files.length) target = files.sort((a, b) => (b[1].match(/\\usepackage/g) || []).length - (a[1].match(/\\usepackage/g) || []).length)[0][0];
  else if (root) target = S.settings.main;
  if (!target) return toast('No document found to add the package to', { kind: 'error' });
  const ok = await editFile(target, (text) => {
    const lines = text.split('\n'); let at = -1;
    lines.forEach((l, i) => { if (/^\s*\\usepackage/.test(l)) at = i; });
    if (at < 0) lines.forEach((l, i) => { if (/\\documentclass/.test(l) && at < 0) at = i; });
    if (at < 0) return `\\usepackage{${pkg}}\n` + text;
    lines.splice(at + 1, 0, `\\usepackage{${pkg}}`); return lines.join('\n');
  });
  if (ok) toast(`Added \\usepackage{${pkg}} to ${target}`, { kind: 'ok' });
}

// ---------- recents ----------
const recents = () => (Array.isArray(prefs.recents) ? prefs.recents : []);
function pushRecent(kind, id) { prefs.recents = [{ k: kind, id }, ...recents().filter((r) => !(r.k === kind && r.id === id))].slice(0, 14); savePrefs(); renderRecent(); }
const symId = (s) => s.c + '|' + s.m;

// ---------- glyph rendering (CSS sprite) ----------
function glyph(item, kind) {
  const d = DATA; const el = document.createElement('span'); el.className = 'glyph';
  const cols = kind === 'tpl' ? d.tcols : d.cols, cw = (kind === 'tpl' ? d.tcw : d.cw) / 2, ch = (kind === 'tpl' ? d.tch : d.ch) / 2;
  if (item.t < 0) { el.className = 'glyph text'; el.textContent = item.n; return el; }
  const col = item.t % cols, row = Math.floor(item.t / cols);
  el.style.cssText = `width:${cw}px;height:${ch}px;background-image:url(${symUrl(kind === 'tpl' ? 'templates' : 'sprite')});background-size:${cols * cw}px auto;background-position:-${col * cw}px -${row * ch}px`;
  return el;
}

// ---------- pickers ----------
function pickTemplate(t) {
  if (insertTemplate(t.i, { mode: t.m, pkg: t.pkg })) { pushRecent('tpl', t.n); checkPackage(t.pkg, t.n); }
}
function pickSymbol(s) {
  if (insertSymbol(s)) { pushRecent('sym', symId(s)); checkPackage(s.pkg, s.c); }
}
const tplByName = (n) => DATA.templates.find((t) => t.n === n);
const symById = (id) => DATA.symbols.find((s) => symId(s) === id);

// ---------- UI ----------
let tab = 'tpl', query = '', symCat = '';
const panel = $('palette');

function build() {
  panel.innerHTML = `
    <div class="pal-head" id="palHead"><span class="pal-title">Σ Symbols &amp; templates</span><span class="grow"></span>
      <button id="palPin" class="icon" title="Pin as a floating palette that stays open" aria-pressed="false">📌</button>
      <button id="palClose" class="icon" title="Close" aria-label="Close palette">✕</button></div>
    <div class="pal-tabs" role="tablist">
      <button role="tab" data-t="tpl">Templates</button><button role="tab" data-t="sym">Symbols</button><button role="tab" data-t="det">Detexify ✎</button></div>
    <div class="pal-tools" id="palTools"><input id="palSearch" type="search" placeholder="Search… (Enter inserts first match)" autocomplete="off" spellcheck="false"><select id="palCat" aria-label="Symbol category"></select></div>
    <div class="pal-recent" id="palRecent"></div>
    <div class="pal-body" id="palBody"></div>
    <div class="pal-foot" id="palFoot"></div>`;
  panel.querySelectorAll('[data-t]').forEach((b) => (b.onclick = () => setTab(b.dataset.t)));
  $('palSearch').oninput = (e) => { query = e.target.value.trim().toLowerCase(); renderBody(); };
  $('palSearch').onkeydown = (e) => { if (e.key === 'Enter') { const f = $('palBody').querySelector('[data-pick]'); if (f) f.click(); e.preventDefault(); } else if (e.key === 'ArrowDown') { $('palBody').querySelector('[data-pick]')?.focus(); e.preventDefault(); } };
  $('palCat').onchange = (e) => { symCat = e.target.value; renderBody(); };
  $('palClose').onclick = () => { setPinned(false); dd.close(); };
  $('palPin').onclick = () => setPinned(!prefs.pinPalette);
  // keep editor focus + selection when clicking palette buttons (so typing continues in the new box)
  panel.addEventListener('mousedown', (e) => { if (e.target.closest('button') && !e.target.closest('#palSearch')) e.preventDefault(); });
  panel.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !prefs.pinPalette) { dd.close(); view.focus(); } });
  dragify($('palHead'));
  $('palCat').innerHTML = '<option value="">All categories</option>' + [...new Set(DATA.symbols.map((s) => s.cat))].map((c) => `<option>${esc(c)}</option>`).join('');
  panel.dataset.built = '1';
}

function setTab(t) {
  tab = t; panel.querySelectorAll('[data-t]').forEach((b) => { b.classList.toggle('active', b.dataset.t === t); b.setAttribute('aria-selected', b.dataset.t === t); });
  $('palTools').hidden = t === 'det'; $('palCat').hidden = t !== 'sym'; $('palRecent').hidden = t === 'det';
  $('palSearch').placeholder = t === 'tpl' ? 'Search templates: derivative, hat, matrix, bra…' : 'Search symbols: alpha, leq, arrow, \\partial…';
  renderBody(); renderRecent();
  const foot = { tpl: 'Click a template: the caret lands in the first <span class="box"></span>. Type, then <kbd>Tab</kbd> for the next box, <kbd>Esc</kbd> to leave. Selected text is moved into the first box.', sym: 'Click to insert at the caret. Outside math, symbols are wrapped in <code>$…$</code>.', det: 'Draw the symbol you are looking for (several strokes are fine). Matching runs locally against glyphs rendered from your own TeX install.' };
  $('palFoot').innerHTML = foot[t];
}

function renderRecent() {
  const box = $('palRecent'); if (!box || !DATA) return; box.innerHTML = '';
  const items = recents().map((r) => (r.k === 'tpl' ? { k: 'tpl', it: tplByName(r.id) } : { k: 'sym', it: symById(r.id) })).filter((x) => x.it);
  if (!items.length) { box.hidden = true; return; }
  box.hidden = tab === 'det';
  const lab = document.createElement('span'); lab.className = 'lab'; lab.textContent = 'Recent'; box.appendChild(lab);
  for (const { k, it } of items.slice(0, 10)) { const b = document.createElement('button'); b.className = 'cell small'; b.title = k === 'tpl' ? it.n : it.c; b.appendChild(glyph(it, k)); b.onclick = () => (k === 'tpl' ? pickTemplate(it) : pickSymbol(it)); box.appendChild(b); }
}

function renderBody() {
  if (!DATA) return;
  const body = $('palBody'); body.innerHTML = '';
  if (tab === 'det') return renderDetexify(body);
  const terms = query.split(/\s+/).filter(Boolean);
  const match = (hay) => terms.every((t) => hay.includes(t));
  if (tab === 'tpl') {
    const groups = new Map();
    for (const t of DATA.templates) { if (terms.length && !match(t.hay)) continue; if (!groups.has(t.cat)) groups.set(t.cat, []); groups.get(t.cat).push(t); }
    if (!groups.size) body.innerHTML = '<div class="empty">No matching templates.</div>';
    for (const [cat, items] of groups) {
      const h = document.createElement('div'); h.className = 'grp'; h.textContent = cat; body.appendChild(h);
      const g = document.createElement('div'); g.className = 'grid tpl';
      for (const t of items) {
        const b = document.createElement('button'); b.className = 'cell tplcell' + (t.t < 0 ? ' texty' : ''); b.dataset.pick = '1'; b.title = t.n + (t.pkg ? `  (needs ${t.pkg})` : ''); b.setAttribute('aria-label', t.n);
        b.appendChild(glyph(t, 'tpl')); b.onclick = () => pickTemplate(t); g.appendChild(b);
      }
      body.appendChild(g);
    }
  } else {
    const list = DATA.symbols.filter((s) => (!symCat || s.cat === symCat) && (!terms.length || match(s.hay)));
    if (!list.length) body.innerHTML = '<div class="empty">No matching symbols.</div>';
    let last = null, g = null;
    for (const s of list.slice(0, 700)) {
      if (s.cat !== last) { last = s.cat; const h = document.createElement('div'); h.className = 'grp'; h.textContent = s.cat; body.appendChild(h); g = document.createElement('div'); g.className = 'grid sym'; body.appendChild(g); }
      const b = document.createElement('button'); b.className = 'cell'; b.dataset.pick = '1'; b.title = `${s.c}${s.pkg ? '   [' + s.pkg + ']' : ''}`; b.setAttribute('aria-label', s.c);
      b.appendChild(glyph(s, 'sym')); b.onclick = () => pickSymbol(s); g.appendChild(b);
    }
  }
}

// ---------- Detexify ----------
const det = { strokes: [], cur: null, canvas: null, ctx: null };
function renderDetexify(body) {
  body.innerHTML = `<div class="det"><div class="det-pad"><canvas id="detCanvas" width="300" height="220" aria-label="Drawing area"></canvas>
    <div class="det-hint" id="detHint">Draw here ✎</div></div>
    <div class="det-btns"><button id="detUndo">Undo stroke</button><button id="detClear">Clear</button><span class="grow"></span><span id="detInfo" class="muted"></span></div>
    <div id="detRes" class="det-res"></div></div>`;
  const c = $('detCanvas'); det.canvas = c;
  const dpr = window.devicePixelRatio || 1; c.width = 300 * dpr; c.height = 220 * dpr; c.style.width = '300px'; c.style.height = '220px';
  det.ctx = c.getContext('2d'); det.ctx.scale(dpr, dpr);
  const pos = (e) => { const r = c.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  c.addEventListener('pointerdown', (e) => { c.setPointerCapture(e.pointerId); det.cur = [pos(e)]; det.strokes.push(det.cur); $('detHint').hidden = true; redraw(); e.preventDefault(); });
  c.addEventListener('pointermove', (e) => { if (!det.cur) return; const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e]; for (const ev of (evs.length ? evs : [e])) det.cur.push(pos(ev)); redraw(); });
  const end = () => { if (!det.cur) return; det.cur = null; classifySoon(); };
  c.addEventListener('pointerup', end); c.addEventListener('pointercancel', end);
  $('detUndo').onclick = () => { det.strokes.pop(); redraw(); classifySoon(); };
  $('detClear').onclick = () => { det.strokes = []; redraw(); $('detRes').innerHTML = ''; $('detInfo').textContent = ''; $('detHint').hidden = false; };
  redraw(); if (det.strokes.length) { $('detHint').hidden = true; classifySoon(); }
}
function redraw() {
  const ctx = det.ctx; if (!ctx) return;
  ctx.clearRect(0, 0, 300, 220);
  ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--text').trim() || '#000'; ctx.lineWidth = 3.2; ctx.lineCap = ctx.lineJoin = 'round';
  for (const s of det.strokes) {
    ctx.beginPath(); ctx.moveTo(s[0].x, s[0].y);
    if (s.length === 1) ctx.lineTo(s[0].x + 0.1, s[0].y);
    for (let i = 1; i < s.length; i++) ctx.lineTo(s[i].x, s[i].y);
    ctx.stroke();
  }
}

// Convert strokes to a normalised point set, exactly like the generator does for rendered glyphs.
export function strokesToPoints(strokes) {
  const pts = [];
  for (const s of strokes) {
    if (!s.length) continue;
    for (let i = 1; i < s.length; i++) { const a = s[i - 1], b = s[i]; const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 2)); for (let k = 0; k < n; k++) pts.push({ x: a.x + (b.x - a.x) * k / n, y: a.y + (b.y - a.y) * k / n }); }
    pts.push(s[s.length - 1]);
  }
  if (!pts.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  const w = x1 - x0, h = y1 - y0, span = Math.max(w, h);
  if (span < 10) return null;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2; const cells = new Map();
  for (const p of pts) {
    const u = (p.x - cx) / span + 0.5, v = (p.y - cy) / span + 0.5;
    const key = Math.min(GRID - 1, Math.floor(u * GRID)) * 100 + Math.min(GRID - 1, Math.floor(v * GRID));
    const c = cells.get(key); if (c) { c.u += u; c.v += v; c.n++; } else cells.set(key, { u, v, n: 1 });
  }
  const arr = []; for (const c of cells.values()) arr.push(c.u / c.n, c.v / c.n);
  return { f: Float32Array.from(arr), aspect: (w + 1) / (h + 1) };
}
function chamfer(a, b) {
  const na = a.length / 2, nb = b.length / 2; let s1 = 0, s2 = 0; const mb = new Float32Array(nb).fill(1e9);
  for (let i = 0; i < na; i++) {
    const ax = a[2 * i], ay = a[2 * i + 1]; let best = 1e9;
    for (let j = 0; j < nb; j++) { const dx = ax - b[2 * j], dy = ay - b[2 * j + 1]; const d = dx * dx + dy * dy; if (d < best) best = d; if (d < mb[j]) mb[j] = d; }
    s1 += Math.sqrt(best);
  }
  for (let j = 0; j < nb; j++) s2 += Math.sqrt(mb[j]);
  s1 /= na; s2 /= nb;
  return 0.5 * (s1 + s2) + 0.25 * Math.max(s1, s2);
}
export function classify(strokes, symbols = DATA && DATA.symbols) {
  const u = strokesToPoints(strokes); if (!u || !symbols) return null;
  const res = symbols.map((s) => ({ s, d: chamfer(u.f, s.f) + Math.min(1.2, Math.abs(Math.log(u.aspect / s.a))) * 0.05 }));
  res.sort((a, b) => a.d - b.d);
  const seen = new Set(), out = [];
  for (const r of res) { const k = r.s.c; if (seen.has(k)) continue; seen.add(k); out.push(r); if (out.length >= 12) break; }
  return out;
}
const classifySoon = debounce(() => {
  const res = $('detRes'); if (!res) return;
  if (!det.strokes.length) { res.innerHTML = ''; return; }
  const t0 = performance.now(); const out = classify(det.strokes);
  if (!out) { res.innerHTML = '<div class="empty">Draw a bit larger…</div>'; return; }
  $('detInfo').textContent = `${Math.round(performance.now() - t0)} ms`;
  const best = out[0].d; res.innerHTML = '';
  out.forEach(({ s, d }, i) => {
    const b = document.createElement('button'); b.className = 'det-row' + (i === 0 ? ' best' : ''); b.dataset.pick = '1';
    b.title = 'Insert ' + s.c; const conf = Math.max(0.04, Math.min(1, 1 - (d - best) / 0.12));
    b.appendChild(glyph(s, 'sym'));
    const label = document.createElement('span'); label.className = 'lbl'; label.innerHTML = `<code>${esc(s.c)}</code>${s.pkg ? `<small>${esc(s.pkg)}</small>` : ''}${s.m === 'text' ? '<small>text</small>' : ''}`;
    const bar = document.createElement('span'); bar.className = 'bar'; bar.innerHTML = `<i style="width:${Math.round(conf * 100)}%"></i>`;
    b.append(label, bar); b.onclick = () => pickSymbol(s); res.appendChild(b);
  });
}, 90);

// ---------- open/close, pinning, dragging ----------
function setPinned(p) {
  prefs.pinPalette = p; savePrefs();
  $('palPin')?.setAttribute('aria-pressed', p); $('palPin')?.classList.toggle('on', p);
  if (p) { const r = panel.getBoundingClientRect(); panel.dataset.floating = '1'; panel.style.left = r.left + 'px'; panel.style.top = r.top + 'px'; panel.classList.add('floating'); }
  else { panel.dataset.floating = ''; panel.classList.remove('floating'); dd.place(); }
}
function dragify(handle) {
  handle.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    const r = panel.getBoundingClientRect(); const dx = e.clientX - r.left, dy = e.clientY - r.top;
    handle.setPointerCapture(e.pointerId);
    const mv = (ev) => { panel.dataset.floating = '1'; panel.classList.add('floating'); panel.style.left = Math.max(0, Math.min(innerWidth - 80, ev.clientX - dx)) + 'px'; panel.style.top = Math.max(0, Math.min(innerHeight - 40, ev.clientY - dy)) + 'px'; };
    const up = () => { handle.removeEventListener('pointermove', mv); handle.removeEventListener('pointerup', up); if (!prefs.pinPalette) { prefs.pinPalette = true; savePrefs(); $('palPin').classList.add('on'); $('palPin').setAttribute('aria-pressed', 'true'); } };
    handle.addEventListener('pointermove', mv); handle.addEventListener('pointerup', up);
  });
}

const btn = $('symBtn');
const dd = dropdown(btn, panel, {
  keepOpen: () => !!prefs.pinPalette,
  onOpen: async () => {
    try { await ensureData(); } catch (e) { panel.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
    if (!panel.dataset.built) build();
    if (prefs.pinPalette) { panel.classList.add('floating'); panel.dataset.floating = '1'; }
    $('palPin').classList.toggle('on', !!prefs.pinPalette); setTab(tab);
    if (tab !== 'det') setTimeout(() => $('palSearch')?.focus(), 30);
  },
});
bus.on('toggle-palette', () => (dd.isOpen() ? (prefs.pinPalette ? setPinned(false) || dd.close() : dd.close()) : dd.open()));
window.addEventListener('resize', () => dd.isOpen() && !prefs.pinPalette && dd.place());