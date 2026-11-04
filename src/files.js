// Open files / tabs / saving / reacting to changes on disk.
import { S, bus, prefs, isText, IMG_EXT, flatFiles, fileName, esc, debounce } from './state.js';
import { api, P, rawUrl, fetchText } from './api.js';
import { view, mkState, setViewState, gotoPosition, replaceDocExternal, setDiagnosticsForCurrent, setExtraCommands } from './editor.js';
import { toast } from './ui.js';

const $ = (id) => document.getElementById(id);
const CACHEABLE = /\.(tex|bib|sty|cls|def|bbl)$/i;
export const isCompileInput = (p) => /\.(tex|bib|sty|cls|def|bst|png|jpe?g|pdf|svg|eps|cfg|clo|tikz|pgf|dat|csv|txt)$/i.test(p) || !/\.[^/.]+$/.test(p);

// ---------- tree / settings ----------
export async function loadTree() {
  const [t, settings] = await Promise.all([api(`${P()}/tree`), api(`${P()}/settings`)]);
  S.tree = t.tree; S.candidates = t.candidates; S.settings = { ...S.settings, ...settings };
  bus.emit('tree');
}
export async function saveSettings(patch) {
  Object.assign(S.settings, patch);
  await api(`${P()}/settings`, { method: 'PUT', json: patch });
  bus.emit('settings');
}
export async function refreshCache(paths) {
  const files = (paths || flatFiles().filter((p) => CACHEABLE.test(p))).filter((p) => !S.dirty.has(p));
  const live = new Set(flatFiles());
  for (const k of [...S.cache.keys()]) if (!live.has(k)) S.cache.delete(k);
  await Promise.all(files.map(async (p) => { try { S.cache.set(p, await fetchText(p)); } catch {} }));
  bus.emit('cache');
}

// ---------- tabs ----------
export function renderTabs() {
  const t = $('tabs'); t.innerHTML = '';
  for (const p of S.open) {
    const d = document.createElement('div');
    d.className = 'tab' + (p === S.current ? ' active' : ''); d.title = p; d.setAttribute('role', 'tab'); d.setAttribute('aria-selected', p === S.current);
    d.innerHTML = `<span class="tname">${esc(fileName(p))}</span>${S.dirty.has(p) ? '<span class="dot" title="Unsaved changes">●</span>' : ''}<button class="x" title="Close" aria-label="Close ${esc(fileName(p))}">✕</button>`;
    d.onclick = (e) => { if (e.target.closest('.x')) { closeTab(p); } else openFile(p); };
    d.onauxclick = (e) => { if (e.button === 1) closeTab(p); };
    t.appendChild(d);
  }
  const act = t.querySelector('.active'); if (act) act.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

export function stashState() { if (S.current && isText(S.current) && S.states.has(S.current)) S.states.set(S.current, view.state); }

export async function openFile(path, pos = {}) {
  if (S.current && S.current !== path) stashState();
  if (!S.open.includes(path)) S.open.push(path);
  S.current = path;
  const ed = $('editorHost'), pv = $('preview'), tools = $('editorTools'), ftools = $('fmtTools');
  if (isText(path)) {
    ed.hidden = false; pv.hidden = true; tools.classList.remove('disabled'); ftools.classList.remove('disabled');
    if (!S.states.has(path)) {
      let text;
      try { text = await fetchText(path); } catch (e) { toast(e.message, { kind: 'error' }); S.open = S.open.filter((x) => x !== path); S.current = S.open[0] || null; renderTabs(); return; }
      S.cache.set(path, text); S.states.set(path, mkState(text, path));
    }
    if (S.current !== path) return;                    // another open() won the race
    setViewState(S.states.get(path));
    if (pos.line) gotoPosition(pos.line, pos.col || 0, pos.len || 0); else if (pos.focus !== false) view.focus();
  } else {
    ed.hidden = true; pv.hidden = false; tools.classList.add('disabled'); ftools.classList.add('disabled');
    const url = rawUrl(path, `&t=${Date.now()}`);
    pv.innerHTML = IMG_EXT.test(path) ? `<img src="${url}" alt="${esc(path)}">` : /\.pdf$/i.test(path) ? `<iframe src="${url}" title="${esc(path)}"></iframe>` : `<div class="msg">“${esc(fileName(path))}” is a binary file.<br><a href="${rawUrl(path, '&download=1')}">Download</a></div>`;
  }
  renderTabs(); bus.emit('current', { path }); showBanner();
}

export function closeTab(path) {
  const i = S.open.indexOf(path); if (i < 0) return;
  if (S.dirty.has(path) && !confirm(`“${fileName(path)}” has unsaved changes that will still be autosaved shortly. Close anyway?`)) return;
  S.open.splice(i, 1); S.states.delete(path);
  if (S.current === path) {
    S.current = null;
    const next = S.open[Math.min(i, S.open.length - 1)];
    if (next) openFile(next);
    else { setViewState(mkState('', 'x.tex')); $('editorHost').hidden = false; $('preview').hidden = true; renderTabs(); bus.emit('current', { path: null }); }
  } else renderTabs();
}

// ---------- saving ----------
let saving = Promise.resolve();
export function saveDirty() {
  saving = saving.then(async () => {
    stashState();
    const paths = [...S.dirty]; if (!paths.length) return [];
    const done = [];
    await Promise.all(paths.map(async (p) => {
      const text = p === S.current && isText(p) ? view.state.doc.toString() : S.states.get(p)?.doc.toString();
      if (text === undefined) { S.dirty.delete(p); return; }
      try { await api(`${P()}/file`, { method: 'PUT', json: { path: p, content: text } }); if (S.current === p ? view.state.doc.toString() === text : true) S.dirty.delete(p); done.push(p); }
      catch (e) { toast('Could not save ' + p + ': ' + e.message, { kind: 'error', ms: 6000 }); }
    }));
    renderTabs(); if (done.length) bus.emit('saved', { paths: done });
    return done;
  });
  return saving;
}
const autosave = debounce(() => saveDirty(), 700);
bus.on('edit', () => { renderTabs(); autosave(); });
bus.on('save-request', async ({ compile } = {}) => { autosave.cancel(); const d = await saveDirty(); if (compile) bus.emit('compile-request', { force: true }); return d; });

// ---------- disk changes ----------
S.conflicts = new Set();
export async function reloadFromDisk(path) {
  let text; try { text = await fetchText(path); } catch { return; }
  if (CACHEABLE.test(path)) S.cache.set(path, text);
  if (!isText(path)) return;
  if (path === S.current && S.states.has(path)) replaceDocExternal(text);
  else if (S.states.has(path)) S.states.set(path, mkState(text, path));
  S.dirty.delete(path); S.conflicts.delete(path); renderTabs(); showBanner(); bus.emit('cache');
}
const reloadTreeSoon = debounce(async () => { try { await loadTree(); } catch {} }, 150);
export async function onFsEvent(m) {
  reloadTreeSoon();
  const p = m.path;
  if (m.kind === 'remove') {
    S.cache.delete(p);
    if (S.open.includes(p)) toast(`“${fileName(p)}” was deleted outside the editor`, { kind: 'warn' });
    bus.emit('cache'); return;
  }
  if (m.kind !== 'change') return;
  if (S.states.has(p) && isText(p)) {
    let disk; try { disk = await fetchText(p); } catch { return; }
    const mine = p === S.current ? view.state.doc.toString() : S.states.get(p).doc.toString();
    if (disk === mine) { S.dirty.delete(p); S.conflicts.delete(p); renderTabs(); showBanner(); return; }
    if (S.dirty.has(p)) { S.conflicts.add(p); showBanner(); return; }
    await reloadFromDisk(p); toast(`“${fileName(p)}” updated from disk`, { ms: 2200 });
  } else if (CACHEABLE.test(p)) { try { S.cache.set(p, await fetchText(p)); bus.emit('cache'); } catch {} }
  if (p === S.current && !isText(p)) openFile(p);
  bus.emit('external-change', { path: p });
}
export function showBanner() {
  const b = $('banner'); const p = S.current;
  if (p && S.conflicts.has(p)) {
    b.hidden = false;
    b.innerHTML = `<span><b>${esc(fileName(p))}</b> was changed on disk while you have unsaved edits.</span><button id="bnReload">Load disk version</button><button id="bnKeep">Keep mine</button>`;
    $('bnReload').onclick = () => reloadFromDisk(p);
    $('bnKeep').onclick = () => { S.conflicts.delete(p); showBanner(); autosave(); };
  } else { b.hidden = true; b.innerHTML = ''; }
}

// ---------- structural edits keep tabs in sync ----------
export function remapPaths(from, to) {
  const re = (p) => (p === from ? to : p.startsWith(from + '/') ? to + p.slice(from.length) : p);
  S.open = S.open.map(re); S.current = S.current && re(S.current);
  S.states = new Map([...S.states].map(([k, v]) => [re(k), v])); S.cache = new Map([...S.cache].map(([k, v]) => [re(k), v]));
  S.dirty = new Set([...S.dirty].map(re));
  if (S.settings.main) S.settings.main = re(S.settings.main);
  renderTabs();
}
export function dropPaths(prefix) {
  const gone = (p) => p === prefix || p.startsWith(prefix + '/');
  const wasCurrent = S.current && gone(S.current);
  S.open = S.open.filter((p) => !gone(p)); for (const k of [...S.states.keys()]) if (gone(k)) S.states.delete(k);
  for (const k of [...S.cache.keys()]) if (gone(k)) S.cache.delete(k); for (const k of [...S.dirty]) if (gone(k)) S.dirty.delete(k);
  if (wasCurrent) { S.current = null; if (S.open.length) openFile(S.open[S.open.length - 1]); else { setViewState(mkState('', 'x.tex')); renderTabs(); bus.emit('current', { path: null }); } } else renderTabs();
}

// Programmatic edit of any text file (open or not): used e.g. to add \usepackage lines.
export async function editFile(path, transform) {
  if (S.states.has(path) || path === S.current) {
    const st = path === S.current ? view.state : S.states.get(path);
    const next = transform(st.doc.toString()); if (next === null || next === st.doc.toString()) return false;
    const cur = st.doc.toString(); let a = 0; while (a < cur.length && a < next.length && cur[a] === next[a]) a++;
    let b = 0; while (b < cur.length - a && b < next.length - a && cur[cur.length - 1 - b] === next[next.length - 1 - b]) b++;
    const spec = { changes: { from: a, to: cur.length - b, insert: next.slice(a, next.length - b) } };
    if (path === S.current) view.dispatch(spec); else { S.states.set(path, st.update(spec).state); S.dirty.add(path); S.cache.set(path, next); bus.emit('edit', { path }); }
    return true;
  }
  const cur = await fetchText(path); const next = transform(cur); if (next === null || next === cur) return false;
  await api(`${P()}/file`, { method: 'PUT', json: { path, content: next } }); S.cache.set(path, next); bus.emit('cache'); bus.emit('saved', { paths: [path] });
  return true;
}
