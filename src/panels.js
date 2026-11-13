// Sidebar panels: Files / Outline / Search / History
import { S, bus, prefs, savePrefs, esc, debounce, fileName } from './state.js';
import { api, P, fetchText } from './api.js';
import { openFile, refreshCache, loadTree, reloadFromDisk, saveDirty } from './files.js';
import { toast, confirmBox, timeAgo } from './ui.js';
import { group } from './vparse.js';

const $ = (id) => document.getElementById(id);

// ---------- tabs ----------
export function setSideTab(t) {
  prefs.sideTab = t; savePrefs();
  document.querySelectorAll('#sideTabs [data-side]').forEach((b) => { const on = b.dataset.side === t; b.classList.toggle('active', on); b.setAttribute('aria-selected', on); });
  document.querySelectorAll('#sidebar .side-panel').forEach((p) => (p.hidden = p.dataset.panel !== t));
  if (t === 'outline') renderOutline(); if (t === 'history') renderHistory(); if (t === 'search') $('searchQ')?.focus();
  bus.emit('side-tab-shown', t);
}

// ---------- outline ----------
const LEVELS = { part: 0, chapter: 1, section: 2, subsection: 3, subsubsection: 4, paragraph: 5 };
const stripComments = (l) => l.replace(/(^|[^\\])%.*/, '$1');
// [, kind, title] of a heading on this line; the title is brace-matched, so a \label after it stays out
export function headingIn(l) {
  const m = /\\(part|chapter|section|subsection|subsubsection|paragraph)\*?\s*(?:\[[^\]]*\])?\s*\{/.exec(l); if (!m) return null;
  const s = m.index + m[0].length - 1, e = group(l, s, 4000);
  return [m[0], m[1], e > 0 ? l.slice(s + 1, e - 1) : l.slice(s + 1)];
}
// A heading as plain text: "L1 \MET\ and Large-$R$ Jets" -> "L1 MET and Large-R Jets".
const FORMATTING = /\\(?:textbf|textit|textsl|textsc|textrm|textsf|texttt|textup|emph|underline|mathrm|mathbf|mathit|mathsf|mathtt|mathcal|boldsymbol|ensuremath|text|mbox|hbox|protect|boldmath|unboldmath|bfseries|itshape|normalfont)\b\s*/g;
export const plainTitle = (t) => t
  .replace(/\\(?:label|footnote|index|cite[a-z]*|ref)\{[^}]*\}/g, '')
  .replace(/\\texorpdfstring\{(?:[^{}]|\{[^{}]*\})*\}\{([^{}]*)\}/g, '$1')
  .replace(/\\([ ,;:!])/g, ' ').replace(/~/g, ' ').replace(/\\\\/g, ' ')
  .replace(FORMATTING, '')
  .replace(/\\([a-zA-Z]+)/g, '$1')
  .replace(/[{}$]/g, '').replace(/\s+/g, ' ').trim();

// "a/b/../c" -> "a/c" (paths in the project never climb above its root)
const normPath = (p) => { const out = []; for (const seg of p.split('/')) { if (seg === '..') out.pop(); else if (seg && seg !== '.') out.push(seg); } return out.join('/'); };
const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '');
// Find an included file the way TeX would: relative to the current \import directory (the import
// package puts it on \input@path), then the project root, then the including file's folder.
function findIncluded(name, path, importDir) {
  const t = name.trim().replace(/^\.\//, '');
  for (const dir of [importDir, '', dirOf(path)]) for (const c of [t, t + '.tex']) { const n = normPath(dir + c); if (S.cache.has(n)) return n; }
  return null;
}
const INCLUDE_RE = /\\(input|include|subfile|import|subimport|includefrom|subincludefrom|inputfrom|subinputfrom)\*?\{([^}]*)\}(?:\{([^}]*)\})?/g;

function outlineOf(path, seen = new Set(), depth = 0, importDir = '') {
  if (seen.has(path) || depth > 16) return [];
  seen.add(path);
  const text = S.cache.get(path); if (text == null) return [];
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = stripComments(lines[i]);
    let m;
    if ((m = headingIn(l))) out.push({ lvl: LEVELS[m[1]], label: plainTitle(m[2]), file: path, line: i + 1, kind: m[1] });
    else if ((m = l.match(/\\begin\{(figure|table|algorithm)\*?\}/))) { let cap = ''; for (let j = i; j < Math.min(i + 25, lines.length); j++) { const c = lines[j].match(/\\caption(?:\[[^\]]*\])?\{(.*?)\}?\s*$/); if (c) { cap = c[1]; break; } if (/\\end\{/.test(lines[j]) && j > i) break; } out.push({ lvl: 9, label: `${m[1]}${cap ? ': ' + cap.replace(/\\[a-zA-Z]+\s*/g, '') : ''}`, file: path, line: i + 1, kind: m[1] }); }
    for (const im of l.matchAll(INCLUDE_RE)) {
      const [, cmd, a, b] = im; let hit = null, nextDir = importDir;
      if (b !== undefined && /import|from/.test(cmd)) {
        // \import{dir}{file}: dir from the project root; \subimport{dir}{file}: from the current import dir
        const dir = normPath((cmd.startsWith('sub') ? importDir : '') + a.trim() + '/');
        nextDir = dir ? dir + '/' : '';
        hit = findIncluded(b, path, nextDir);
        if (hit && /import/.test(cmd)) nextDir = dirOf(hit); // \import also makes later \input relative to it
      } else if (b === undefined && !/import|from/.test(cmd)) hit = findIncluded(a, path, importDir);
      if (hit) { out.push({ lvl: 8, label: hit, file: path, line: i + 1, kind: 'input' }); out.push(...outlineOf(hit, seen, depth + 1, nextDir)); }
    }
  }
  return out;
}

// compact (the outline under the file tree): headings only, titles get the full width.
function renderOutlineInto(box, compact = false) {
  const main = S.settings.main || [...S.cache.keys()].find((p) => p.endsWith('.tex'));
  let items = main ? outlineOf(main) : [];
  if (compact) items = items.filter((i) => i.lvl < 8);
  box._items = items;
  if (!items.length) { box.innerHTML = '<div class="empty">No sections yet.<br><small>Add <code>\\section{…}</code> and they appear here.</small></div>'; return; }
  const minLvl = Math.min(...items.filter((i) => i.lvl < 8).map((i) => i.lvl), 9);
  const icon = { input: '📄', figure: '🖼', table: '▦', algorithm: '⚙' };
  box.innerHTML = '';
  items.forEach((it, idx) => {
    const b = document.createElement('button'); b.className = 'ol-item k-' + it.kind; b.dataset.idx = idx; b.style.paddingLeft = 8 + (it.lvl < 8 ? it.lvl - minLvl : 1) * 12 + 'px';
    b.innerHTML = `${icon[it.kind] ? `<span class="ico">${icon[it.kind]}</span>` : ''}<span class="t">${esc(it.label || '(untitled)')}</span>${compact ? '' : `<small>${esc(fileName(it.file))}:${it.line}</small>`}`;
    b.title = `${it.label} (${it.file}:${it.line})`; b.onclick = () => openFile(it.file, { line: it.line, col: 0 });
    box.appendChild(b);
  });
  markCurrent();
}
export function renderOutline() {
  if ($('outline') && !$('outlinePanel').hidden) renderOutlineInto($('outline'));
  if ($('fileOutline') && !$('filesPanel').hidden && prefs.outlineOpen !== false) renderOutlineInto($('fileOutline'), true);
}
// The section the cursor is in is highlighted (the last heading above it in the current file).
let curLine = 1;
function markCurrent() {
  for (const box of [$('outline'), $('fileOutline')]) {
    if (!box || !box._items) continue;
    let best = -1;
    box._items.forEach((it, i) => { if (it.lvl < 8 && it.file === S.current && it.line <= curLine) best = i; });
    box.querySelectorAll('.ol-item.cur').forEach((e) => e.classList.remove('cur'));
    const el = best >= 0 && box.querySelector(`.ol-item[data-idx="${best}"]`);
    if (el) { el.classList.add('cur'); if (!box.matches(':hover')) el.scrollIntoView({ block: 'nearest' }); }
  }
}
bus.on('cursor', ({ line }) => { curLine = line; markCurrent(); });
export const outlineItems = () => { const main = S.settings.main || [...S.cache.keys()].find((p) => p.endsWith('.tex')); return main ? outlineOf(main) : []; };

// File outline stacked under the file tree (as in Overleaf): collapsible, with a draggable divider.
{
  const box = $('fileOutlineBox'), head = $('fileOutlineHead'), split = $('treeOutlineSplit');
  if (box) {
    const applyH = () => {
      const open = prefs.outlineOpen !== false;
      box.classList.toggle('closed', !open); head.setAttribute('aria-expanded', String(open)); split.hidden = !open;
      box.style.height = open ? Math.round((prefs.outlineH || 0.4) * 100) + '%' : '';
    };
    applyH();
    head.onclick = () => { prefs.outlineOpen = prefs.outlineOpen === false; savePrefs(); applyH(); renderOutline(); };
    split.addEventListener('pointerdown', (e) => {
      e.preventDefault(); split.setPointerCapture(e.pointerId);
      const panel = $('filesPanel').getBoundingClientRect();
      const move = (ev) => { prefs.outlineH = Math.min(0.85, Math.max(0.12, (panel.bottom - ev.clientY) / panel.height)); applyH(); };
      const up = () => { split.removeEventListener('pointermove', move); split.removeEventListener('pointerup', up); savePrefs(); };
      split.addEventListener('pointermove', move); split.addEventListener('pointerup', up);
    });
  }
}
const outlineSoon = debounce(renderOutline, 250);
bus.on('cache', outlineSoon); bus.on('settings', outlineSoon); bus.on('edit', outlineSoon);

// ---------- project search / replace ----------
const sOpt = { regex: false, caseSensitive: false, wholeWord: false };
let lastMatches = [];
async function runSearch() {
  const q = $('searchQ').value; const out = $('searchRes'); $('replaceAllBtn').disabled = true;
  if (!q) { out.innerHTML = ''; $('searchCount').textContent = ''; lastMatches = []; return; }
  try { await saveDirty(); } catch {}
  let r; try { r = await api(`${P()}/search`, { json: { query: q, ...sOpt } }); } catch (e) { out.innerHTML = `<div class="empty err">${esc(e.message)}</div>`; $('searchCount').textContent = ''; return; }
  lastMatches = r.matches;
  const byFile = new Map(); for (const m of r.matches) { if (!byFile.has(m.file)) byFile.set(m.file, []); byFile.get(m.file).push(m); }
  $('searchCount').textContent = r.matches.length ? `${r.matches.length}${r.truncated ? '+' : ''} in ${byFile.size} file${byFile.size > 1 ? 's' : ''}` : 'no results';
  $('replaceAllBtn').disabled = !r.matches.length;
  out.innerHTML = '';
  for (const [f, ms] of byFile) {
    const h = document.createElement('div'); h.className = 'sr-file'; h.innerHTML = `<span>${esc(f)}</span><small>${ms.length}</small>`; out.appendChild(h);
    for (const m of ms) {
      const b = document.createElement('button'); b.className = 'sr-hit';
      const t = m.text, a = m.col - m.off;
      b.innerHTML = `<small>${m.line}</small><span>${esc(t.slice(Math.max(0, a - 40), a))}<mark>${esc(t.slice(a, a + m.len))}</mark>${esc(t.slice(a + m.len, a + m.len + 80))}</span>`;
      b.onclick = () => openFile(m.file, { line: m.line, col: m.col, len: m.len }); out.appendChild(b);
    }
  }
}
const searchSoon = debounce(runSearch, 300);
export function focusSearch(seed) { setSideTab('search'); const q = $('searchQ'); if (seed) q.value = seed; q.focus(); q.select(); if (seed) runSearch(); }
function initSearch() {
  $('searchQ').addEventListener('input', searchSoon);
  $('searchQ').addEventListener('keydown', (e) => { if (e.key === 'Enter') { searchSoon.cancel(); runSearch(); } });
  for (const [id, key] of [['optRe', 'regex'], ['optCase', 'caseSensitive'], ['optWord', 'wholeWord']]) $(id).onclick = () => { sOpt[key] = !sOpt[key]; $(id).classList.toggle('on', sOpt[key]); $(id).setAttribute('aria-pressed', sOpt[key]); runSearch(); };
  $('replaceAllBtn').onclick = async () => {
    const n = lastMatches.length, files = new Set(lastMatches.map((m) => m.file)).size;
    if (!(await confirmBox('Replace in project', `Replace ${n} match${n > 1 ? 'es' : ''} in ${files} file${files > 1 ? 's' : ''} with “${$('replaceQ').value}”? Previous versions are kept in History.`, { ok: 'Replace all', danger: true }))) return;
    try {
      await saveDirty();
      const r = await api(`${P()}/replace`, { json: { query: $('searchQ').value, ...sOpt, replacement: $('replaceQ').value } });
      await Promise.all(r.changed.map((c) => reloadFromDisk(c.file)));
      await refreshCache(); toast(`Replaced ${r.changed.reduce((a, c) => a + (c.count || 0), 0) || n} occurrences in ${r.changed.length} file(s)`, { kind: 'ok' });
      runSearch();
    } catch (e) { toast(e.message, { kind: 'error' }); }
  };
}

// ---------- history ----------
export function lineDiff(a, b) {
  const A = a.split('\n'), B = b.split('\n');
  let s = 0; while (s < A.length && s < B.length && A[s] === B[s]) s++;
  let e = 0; while (e < A.length - s && e < B.length - s && A[A.length - 1 - e] === B[B.length - 1 - e]) e++;
  const am = A.slice(s, A.length - e), bm = B.slice(s, B.length - e);
  const out = []; for (let i = Math.max(0, s - 2); i < s; i++) out.push({ t: ' ', s: A[i], n: i + 1 });
  if (am.length * bm.length > 4e6) { am.forEach((x) => out.push({ t: '-', s: x })); bm.forEach((x) => out.push({ t: '+', s: x })); }
  else {
    const n = am.length, m = bm.length, L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = am[i] === bm[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && am[i] === bm[j]) { out.push({ t: ' ', s: am[i] }); i++; j++; }
      else if (j < m && (i >= n || L[i][j + 1] >= L[i + 1][j])) out.push({ t: '+', s: bm[j++] });
      else out.push({ t: '-', s: am[i++] });
    }
  }
  for (let i = 0; i < Math.min(2, e); i++) out.push({ t: ' ', s: A[A.length - e + i] });
  return out;
}
let histSel = null;
export async function renderHistory() {
  const box = $('historyList'); if (!box || $('historyPanel').hidden) return;
  const path = S.current;
  box.innerHTML = '';
  if (path && /\.(tex|bib|sty|cls|txt|md|cfg|def)$/i.test(path)) {
    let r; try { r = await api(`${P()}/history?path=${encodeURIComponent(path)}`); } catch (e) { box.innerHTML = `<div class="empty err">${esc(e.message)}</div>`; return; }
    const h = document.createElement('div'); h.className = 'grp'; h.textContent = `Versions of ${fileName(path)}`; box.appendChild(h);
    if (!r.versions.length) box.insertAdjacentHTML('beforeend', '<div class="empty">No saved versions yet.<br><small>Versions are recorded as you edit.</small></div>');
    for (const v of r.versions) {
      const b = document.createElement('button'); b.className = 'hist-item' + (histSel === v.ts ? ' active' : '');
      b.innerHTML = `<span>${new Date(v.ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span><small>${timeAgo(v.ts)} · ${(v.size / 1024).toFixed(1)} KB</small>`;
      b.onclick = () => showDiff(path, v.ts); box.appendChild(b);
    }
  } else box.insertAdjacentHTML('beforeend', '<div class="empty">Open a text file to see its history.</div>');
  try {
    const d = await api(`${P()}/history/deleted`);
    if (d.files.length) {
      const h = document.createElement('div'); h.className = 'grp'; h.textContent = 'Deleted files'; box.appendChild(h);
      for (const f of d.files) {
        const b = document.createElement('button'); b.className = 'hist-item'; b.innerHTML = `<span>${esc(f.path)}</span><small>deleted ${timeAgo(f.ts)} · click to restore</small>`;
        b.onclick = async () => { try { await api(`${P()}/history/restore`, { json: { path: f.path, ts: f.ts } }); await loadTree(); await refreshCache(); toast(`Restored ${f.path}`, { kind: 'ok' }); openFile(f.path); renderHistory(); } catch (e) { toast(e.message, { kind: 'error' }); } };
        box.appendChild(b);
      }
    }
  } catch {}
}
async function showDiff(path, ts) {
  histSel = ts; renderHistory();
  const pane = $('diffPane'); pane.hidden = false;
  let old; try { old = await (await fetch(`${P()}/history/content?path=${encodeURIComponent(path)}&ts=${ts}`)).text(); } catch { return toast('Could not load version', { kind: 'error' }); }
  const cur = S.current === path && S.states.has(path) ? (await import('./editor.js')).view.state.doc.toString() : await fetchText(path);
  const d = lineDiff(old, cur); const adds = d.filter((x) => x.t === '+').length, dels = d.filter((x) => x.t === '-').length;
  pane.innerHTML = `<div class="diff-head"><b>${new Date(ts).toLocaleString()}</b> → current <span class="plus">+${adds}</span> <span class="minus">−${dels}</span><span class="grow"></span><button id="diffRestore" class="primary">Restore this version</button><button id="diffClose" class="icon" aria-label="Close">✕</button></div><pre class="diff">${d.length && (adds || dels) ? d.map((x) => `<div class="ln ${x.t === '+' ? 'add' : x.t === '-' ? 'del' : ''}"><i>${x.t === ' ' ? '' : x.t}</i>${esc(x.s) || ' '}</div>`).join('') : '<div class="ln">Identical to current version.</div>'}</pre>`;
  $('diffClose').onclick = () => { pane.hidden = true; histSel = null; renderHistory(); };
  $('diffRestore').onclick = async () => {
    try { await saveDirty(); await api(`${P()}/history/restore`, { json: { path, ts } }); await reloadFromDisk(path); toast('Version restored (previous content kept in history)', { kind: 'ok' }); pane.hidden = true; histSel = null; renderHistory(); } catch (e) { toast(e.message, { kind: 'error' }); }
  };
}
bus.on('current', () => { histSel = null; const p = $('diffPane'); if (p) p.hidden = true; if (prefs.sideTab === 'history') renderHistory(); });
bus.on('saved', debounce(() => { if (prefs.sideTab === 'history') renderHistory(); }, 600));

// Ctrl/⌘-click on an \input/\import chip in the Visual Editor opens that file
bus.on('open-include', ({ dir, file, cmd, from }) => {
  const importDir = dir ? normPath((cmd.startsWith('sub') ? dirOf(from || '') : '') + dir + '/') : '';
  const hit = findIncluded(file, from || '', importDir ? importDir + '/' : '');
  if (hit) bus.emit('goto-source', { file: hit, line: 1, column: 0 }); else toast(`Couldn't find “${file}” in the project`, { kind: 'warn' });
});

export function initPanels() {
  document.querySelectorAll('#sideTabs [data-side]').forEach((b) => (b.onclick = () => setSideTab(b.dataset.side)));
  initSearch(); setSideTab(prefs.sideTab || 'files');
}
bus.on('side-tab', (t) => setSideTab(t));
