// PDF viewer: virtualised pages, selectable text, search, zoom, SyncTeX forward highlight + reverse (double-click).
import * as pdfjsLib from 'pdfjs-dist/build/pdf.mjs';
import { S, bus, prefs, debounce, esc } from './state.js';
import { api, P } from './api.js';
import { toast } from './ui.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.mjs';
const $ = (id) => document.getElementById(id);
const GAP = 12, PAD = 12;

const V = { doc: null, pages: [], size: [], top: [], scale: 1, mode: 'fit-width', custom: 1, loadToken: 0, buildToken: 0, version: null, name: 'main.pdf', io: null, texts: new Map(), query: '', hits: [], cur: -1 };
const killDoc = (d) => { try { (d.loadingTask && d.loadingTask.destroy ? d.loadingTask.destroy() : d.destroy && d.destroy()); } catch {} };
export const hasDoc = () => !!V.doc;
const scroller = () => $('pdfScroll');

function computeScale() {
  const sc = scroller(); const maxW = Math.max(...V.size.map((s) => s.w), 1);
  if (V.mode === 'fit-width') return Math.max(0.2, (sc.clientWidth - 2 * PAD - 2) / maxW);
  if (V.mode === 'fit-page') return Math.max(0.2, Math.min((sc.clientWidth - 2 * PAD) / maxW, (sc.clientHeight - 2 * PAD) / Math.max(...V.size.map((s) => s.h), 1)));
  return V.custom;
}
function layout(scale) { let y = PAD; V.top = V.size.map((s) => { const t = y; y += s.h * scale + GAP; return t; }); return y - GAP + PAD; }
const pageAt = (y) => { let lo = 0, hi = V.top.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (V.top[mid] <= y) lo = mid; else hi = mid - 1; } return lo; };

// opts.quiet: no error toast when there is simply no PDF yet (opening a project that was never compiled).
export async function load(url, version, name, opts = {}) {
  const my = ++V.loadToken;
  let doc;
  try { doc = await pdfjsLib.getDocument({ url }).promise; } catch (e) {
    const missing = e && (e.name === 'MissingPDFException' || e.status === 404 || /\(404\)/.test(e.message));
    if (my === V.loadToken && !(opts.quiet && missing)) toast('Could not display the PDF: ' + e.message, { kind: 'error' });
    return;
  }
  if (my !== V.loadToken) { killDoc(doc); return; }
  const old = V.doc;
  V.doc = doc; V.version = version; if (name) V.name = name; V.texts.clear();
  V.pages = await Promise.all(Array.from({ length: doc.numPages }, (_, i) => doc.getPage(i + 1)));
  if (my !== V.loadToken) return;
  V.size = V.pages.map((p) => { const v = p.getViewport({ scale: 1 }); return { w: v.width, h: v.height }; });
  await build(true);
  if (old) killDoc(old);
  $('pdfEmpty').classList.add('hidden');
  if (V.query) find(V.query, { keep: true });
}

async function build(keepPos) {
  const token = ++V.buildToken; const sc = scroller();
  // anchor: which page / fraction of it is at the top of the viewport
  let anchorPage = 0, anchorFrac = 0;
  if (keepPos && V.top.length && $('pdfPages').firstChild) { anchorPage = pageAt(sc.scrollTop); const h = (V.size[anchorPage]?.h || 1) * V.scale; anchorFrac = Math.max(0, (sc.scrollTop - V.top[anchorPage]) / h); }
  const scale = computeScale(); const total = layout(scale); V.scale = scale;
  const wrap = document.createElement('div'); wrap.className = 'pdf-doc'; wrap.style.height = total + 'px';
  V.els = V.pages.map((p, i) => {
    const el = document.createElement('div'); el.className = 'pdf-page'; el.dataset.n = i + 1;
    el.style.cssText = `top:${V.top[i]}px;width:${V.size[i].w * scale}px;height:${V.size[i].h * scale}px;--scale-factor:${scale};--total-scale-factor:${scale}`;
    wrap.appendChild(el); return el;
  });
  const target = keepPos && anchorPage < V.top.length ? V.top[Math.min(anchorPage, V.top.length - 1)] + anchorFrac * V.size[Math.min(anchorPage, V.size.length - 1)].h * scale : 0;
  // pre-render what will be visible so the swap does not flash
  const vis = [];
  for (let i = 0; i < V.els.length; i++) if (V.top[i] + V.size[i].h * scale >= target - 200 && V.top[i] <= target + sc.clientHeight + 200) vis.push(i);
  await Promise.all(vis.map((i) => renderPage(V.els[i], token)));
  if (token !== V.buildToken) return;
  if (V.io) V.io.disconnect();
  $('pdfPages').replaceChildren(wrap); sc.scrollTop = target;
  V.io = new IntersectionObserver((entries) => { for (const e of entries) { const el = e.target; if (e.isIntersecting) renderPage(el, V.buildToken).catch(() => {}); else release(el); } }, { root: sc, rootMargin: '1600px 0px' });
  V.els.forEach((el) => V.io.observe(el));
  $('zoomLabel').textContent = Math.round(scale * 100) + '%'; $('pageTotal').textContent = V.pages.length; updatePage();
}

async function renderPage(el, token) {
  const i = Number(el.dataset.n) - 1; const page = V.pages[i]; if (!page) return;
  if (el._ok && el._scale === V.scale) return;
  if (el._busy) return el._busy;
  const scale = V.scale;
  el._busy = (async () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    let vp = page.getViewport({ scale: scale * dpr });
    const px = vp.width * vp.height; if (px > 24e6) vp = page.getViewport({ scale: scale * dpr * Math.sqrt(24e6 / px) });
    const canvas = document.createElement('canvas'); canvas.width = Math.floor(vp.width); canvas.height = Math.floor(vp.height);
    const task = page.render({ canvasContext: canvas.getContext('2d', { alpha: false }), canvas, viewport: vp }); el._task = task;
    try { await task.promise; } catch (e) { if (e?.name !== 'RenderingCancelledException') console.warn(e); return; }
    if (token !== undefined && token !== V.buildToken && el.isConnected) return;
    const tdiv = document.createElement('div'); tdiv.className = 'textLayer';
    const layer = new pdfjsLib.TextLayer({ textContentSource: page.streamTextContent(), container: tdiv, viewport: page.getViewport({ scale }) });
    try { await layer.render(); } catch {}
    const marks = document.createElement('div'); marks.className = 'marks';
    el.replaceChildren(canvas, tdiv, marks); el._ok = true; el._scale = scale; el._layer = layer;
    markHits(el);
  })().finally(() => { el._busy = null; });
  return el._busy;
}
function release(el) { if (el._task) { try { el._task.cancel(); } catch {} } if (el._ok) { el.replaceChildren(); el._ok = false; el._layer = null; } }

// ---------- zoom / scroll ----------
export const setMode = (m) => { V.mode = m; if (V.doc) build(true); };
export const zoomBy = (f) => { V.mode = 'custom'; V.custom = Math.min(6, Math.max(0.2, V.scale * f)); if (V.doc) build(true); };
const rebuildSoon = debounce(() => V.doc && V.mode !== 'custom' && build(true), 200);
new ResizeObserver(rebuildSoon).observe(scroller());
scroller().addEventListener('wheel', (e) => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1); } }, { passive: false });
let raf = 0;
scroller().addEventListener('scroll', () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; updatePage(); }); });
function updatePage() { if (!V.top.length) return; const sc = scroller(); const i = pageAt(sc.scrollTop + sc.clientHeight / 3); $('pageNum').value = i + 1; }
export function gotoPage(n) { n = Math.min(Math.max(1, n), V.pages.length); scroller().scrollTo({ top: V.top[n - 1] - PAD, behavior: 'auto' }); }

// ---------- SyncTeX ----------
export function showSource(r) {
  if (!r || !r.found || !V.top.length) return false;
  const i = r.page - 1; const sc = scroller(); const y = V.top[i] + (r.v - r.H) * V.scale;
  sc.scrollTo({ top: Math.max(0, y - sc.clientHeight / 3), behavior: 'smooth' });
  const el = V.els[i];
  const apply = () => {
    const marks = el.querySelector('.marks'); if (!marks) return;
    const m = document.createElement('div'); m.className = 'sync-mark';
    m.style.cssText = `left:${Math.max(0, r.h * V.scale - 4)}px;top:${(r.v - r.H) * V.scale - 2}px;width:${Math.max(24, r.W * V.scale) + 8}px;height:${(r.H + 3) * V.scale + 4}px`;
    marks.appendChild(m); setTimeout(() => m.remove(), 2200);
  };
  el._ok ? apply() : renderPage(el).then(apply);
  return true;
}
async function sourceAt(page, x, y) {
  const q = new URLSearchParams({ pdf: V.name, page, x: x.toFixed(2), y: y.toFixed(2) });
  try { const s = await api(`${P()}/synctex/edit?${q}`); if (s.found) bus.emit('goto-source', s); else toast('No matching source for that spot', { kind: 'warn' }); } catch (x) { toast(x.message, { kind: 'error' }); }
}
$('pdfPages').addEventListener('dblclick', async (e) => {
  const el = e.target.closest('.pdf-page'); if (!el || !S.server.synctex) return;
  const r = el.getBoundingClientRect();
  sourceAt(el.dataset.n, (e.clientX - r.left) / V.scale, (e.clientY - r.top) / V.scale);
});
// "←" between editor and PDF: the source of what is at the top third of the PDF view.
export function syncToSource() {
  if (!V.doc || !S.server.synctex) { toast(V.doc ? 'SyncTeX is not available on this server' : 'No PDF yet', { kind: 'warn' }); return; }
  const sc = scroller(), y = sc.scrollTop + sc.clientHeight / 3, i = pageAt(y);
  sourceAt(i + 1, (V.size[i].w / 2), Math.max(0, (y - V.top[i]) / V.scale));
}
export const visiblePage = () => (V.doc ? pageAt(scroller().scrollTop + scroller().clientHeight / 3) + 1 : 1);

// ---------- presentation mode: one page at a time, full screen ----------
export async function present() {
  if (!V.doc) { toast('No PDF yet', { kind: 'warn' }); return; }
  const total = V.doc.numPages; let n = visiblePage(), token = 0;
  const ov = document.createElement('div'); ov.id = 'present'; ov.tabIndex = -1; ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-label', 'Presentation');
  ov.innerHTML = '<canvas></canvas><div class="pr-count" aria-live="polite"></div><div class="pr-help">← → or click to move · Esc to leave</div>';
  document.body.appendChild(ov);
  const canvas = ov.querySelector('canvas'), count = ov.querySelector('.pr-count');
  const draw = async () => {
    const my = ++token; const page = await V.doc.getPage(n); if (my !== token) return;
    const base = page.getViewport({ scale: 1 }), W = ov.clientWidth || innerWidth, H = ov.clientHeight || innerHeight;
    const scale = Math.min(W / base.width, H / base.height), dpr = window.devicePixelRatio || 1;
    const vp = page.getViewport({ scale: scale * dpr });
    canvas.width = Math.floor(vp.width); canvas.height = Math.floor(vp.height);
    canvas.style.width = Math.floor(vp.width / dpr) + 'px'; canvas.style.height = Math.floor(vp.height / dpr) + 'px';
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
    count.textContent = `${n} / ${total}`; count.classList.remove('fade'); void count.offsetWidth; count.classList.add('fade');
  };
  const go = (d) => { const m = Math.min(total, Math.max(1, d === 'first' ? 1 : d === 'last' ? total : n + d)); if (m !== n) { n = m; draw(); } };
  const leave = () => { document.removeEventListener('keydown', key, true); removeEventListener('resize', onResize); document.removeEventListener('fullscreenchange', onFs); ov.remove(); gotoPage(n); if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); };
  const key = (e) => {
    const k = e.key; let used = true;
    if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter', 'n'].includes(k)) go(1);
    else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace', 'p'].includes(k)) go(-1);
    else if (k === 'Home') go('first'); else if (k === 'End') go('last');
    else if (k === 'Escape' || k === 'q') leave(); else used = false;
    if (used) { e.preventDefault(); e.stopPropagation(); }
  };
  const onResize = debounce(draw, 100);
  const onFs = () => { if (!document.fullscreenElement && document.body.contains(ov)) leave(); };
  ov.addEventListener('click', (e) => go(e.clientX < ov.clientWidth / 4 ? -1 : 1));
  ov.addEventListener('contextmenu', (e) => { e.preventDefault(); go(-1); });
  document.addEventListener('keydown', key, true); addEventListener('resize', onResize);
  try { await ov.requestFullscreen(); document.addEventListener('fullscreenchange', onFs); } catch {} // full window if full screen is refused
  ov.focus(); draw();
}

// ---------- search ----------
async function pageStrings(i) {
  if (V.texts.has(i)) return V.texts.get(i);
  const tc = await V.pages[i].getTextContent(); const arr = tc.items.filter((it) => 'str' in it).map((it) => it.str);
  V.texts.set(i, arr); return arr;
}
function markHits(el) {
  if (!el._layer || !V.query) return;
  const q = V.query.toLowerCase(); const strs = el._layer.textContentItemsStr, divs = el._layer.textDivs; let k = 0;
  const n = Number(el.dataset.n);
  strs.forEach((s, j) => { if (s && s.toLowerCase().includes(q)) { divs[j].classList.add('hit'); const gi = V.hits.findIndex((h) => h.page === n && h.k === k); if (gi === V.cur) divs[j].classList.add('cur'); k++; } });
}
export async function find(query, { keep = false } = {}) {
  V.query = query; V.hits = []; if (!keep) V.cur = -1;
  if (!V.doc || !query) { updateFind(); V.els?.forEach((e) => e.querySelectorAll('.hit').forEach((d) => d.classList.remove('hit', 'cur'))); return; }
  const q = query.toLowerCase();
  for (let i = 0; i < V.pages.length; i++) { const strs = await pageStrings(i); let k = 0; strs.forEach((s) => { if (s && s.toLowerCase().includes(q)) V.hits.push({ page: i + 1, k: k++ }); }); }
  if (V.cur < 0 && V.hits.length) { const sc = scroller(); const here = pageAt(sc.scrollTop) + 1; V.cur = Math.max(0, V.hits.findIndex((h) => h.page >= here)); await showHit(); }
  else { V.els.forEach((el) => { el.querySelectorAll('.hit').forEach((d) => d.classList.remove('hit', 'cur')); markHits(el); }); updateFind(); }
}
async function showHit() {
  updateFind(); const h = V.hits[V.cur]; if (!h) return;
  const el = V.els[h.page - 1]; el.querySelectorAll('.hit,.cur').forEach((d) => d.classList.remove('hit', 'cur'));
  gotoPage(h.page); await renderPage(el); markHits(el);
  el.querySelector('.cur')?.scrollIntoView({ block: 'center', inline: 'nearest' });
}
export const findStep = (d) => { if (!V.hits.length) return; V.cur = (V.cur + d + V.hits.length) % V.hits.length; V.els.forEach((el) => el.querySelectorAll('.cur').forEach((x) => x.classList.remove('cur'))); showHit(); };
function updateFind() { $('findCount').textContent = V.query ? (V.hits.length ? `${V.cur + 1}/${V.hits.length}` : 'none') : ''; }
export const resizeNow = () => { if (V.doc && V.mode !== 'custom') build(true); };
export const currentName = () => V.name;
