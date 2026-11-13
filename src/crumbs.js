// Breadcrumbs above the editor (as in Overleaf): file › chapter › section › subsection at the cursor.
// Uses the whole-document outline, so a file pulled in with \input/\import shows the headings it sits under.
import { S, bus, prefs, esc, debounce } from './state.js';
import { outlineItems } from './panels.js';
import { openFile } from './files.js';
import { view } from './editor.js';

const $ = (id) => document.getElementById(id);
let items = [], line = 1;
const refresh = () => { try { items = outlineItems(); } catch { items = []; } render(); };
const refreshSoon = debounce(refresh, 300);

function chain() {
  if (!S.current) return [];
  let idx = -1;
  items.forEach((it, i) => { if (it.lvl < 8 && it.file === S.current && it.line <= line) idx = i; });
  if (idx < 0) { // cursor above the first heading of this file: use the headings the file is included under
    const inc = items.findIndex((it) => it.kind === 'input' && it.label === S.current);
    idx = inc - 1;
  }
  const out = [];
  let lvl = 99;
  for (let i = idx; i >= 0; i--) { const it = items[i]; if (it.lvl < 8 && it.lvl < lvl) { out.unshift(it); lvl = it.lvl; if (lvl <= 0) break; } }
  return out;
}

function render() {
  const nav = $('crumbs'); if (!nav) return;
  nav.hidden = prefs.crumbs === false || !S.current;
  if (nav.hidden) return;
  const parts = chain();
  const file = S.current.split('/').pop();
  nav.innerHTML = `<span class="cr-file" title="${esc(S.current)}">${esc(file)}</span>` + parts.map((it, i) =>
    `<span class="cr-sep" aria-hidden="true">›</span><button type="button" class="cr${i === parts.length - 1 ? ' last' : ''}" data-i="${items.indexOf(it)}" title="${esc(it.label)} (${esc(it.file)}:${it.line})">${esc(it.label || '(untitled)')}</button>`).join('');
}

$('crumbs')?.addEventListener('click', (e) => {
  const b = e.target.closest('button.cr'); if (!b) return;
  const it = items[+b.dataset.i]; if (it) openFile(it.file, { line: it.line, col: 0 });
});
bus.on('cursor', ({ line: l }) => { line = l; render(); });
bus.on('cache', refreshSoon); bus.on('edit', refreshSoon); bus.on('settings', refreshSoon); bus.on('current', () => { try { line = view.state.doc.lineAt(view.state.selection.main.head).number; } catch { line = 1; } render(); });
bus.on('prefs', render);
refreshSoon();
