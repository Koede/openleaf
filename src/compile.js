// Compile orchestration, issue list, streaming log, word count, SyncTeX forward search.
import { S, bus, prefs, esc, debounce } from './state.js';
import { api, P } from './api.js';
import * as pdf from './pdf.js';
import { saveDirty, openFile, stashState, isCompileInput } from './files.js';
import { setDiagnosticsForCurrent, view } from './editor.js';
import { toast } from './ui.js';

const $ = (id) => document.getElementById(id);
let seq = 0, logBuf = '';

function setStatus(text, cls = '', title = '') { const s = $('status'); s.textContent = text; s.className = 'status ' + cls; s.title = title; }
function setBusy(b) { $('compileBtn').classList.toggle('busy', b); $('compileBtn').querySelector('.lbl').textContent = b ? 'Compiling…' : 'Recompile'; S.compiling = b; }

export async function stopCompile() {
  if (!S.project || !S.compiling) return;
  try { await api(`${P()}/compile/stop`, { json: {} }); } catch (e) { toast(e.message, { kind: 'error' }); }
}

export async function recompileFromScratch() {
  if (!S.project) return;
  try { await api(`${P()}/clean`, { method: 'POST', json: {} }); } catch (e) { toast(e.message, { kind: 'error' }); return; }
  return compile();
}

export async function compile() {
  if (!S.project) return;
  if (!S.server.latexmk) return toast('latexmk was not found on the server. Install TeX Live (or MacTeX/MiKTeX).', { kind: 'error', ms: 8000 });
  const my = ++seq; setBusy(true); setStatus('Compiling…', 'busy');
  try {
    await saveDirty(); if (my !== seq) return;
    const r = await api(`${P()}/compile`, { json: {} });
    if (r.superseded || my !== seq) return;
    await applyResult(r);
  } catch (e) { if (my === seq) { setBusy(false); setStatus('Error', 'fail', e.message); toast(e.message, { kind: 'error', ms: 7000 }); } }
}

export async function applyResult(r) {
  if (r.stopped) { // stopped from the Recompile menu: keep the previous PDF and result
    setBusy(false); setStatus('Stopped', 'warn', 'Compilation was stopped; the previous PDF is still shown');
    if (S.lastResult) bus.emit('compiled', S.lastResult);
    return;
  }
  setBusy(false); S.lastResult = r; S.issues = r.issues || [];
  renderIssues(r); setDiagnosticsForCurrent();
  const errs = S.issues.filter((i) => i.type === 'error').length, warns = S.issues.filter((i) => i.type === 'warning').length;
  const secs = (r.ms / 1000).toFixed(1) + 's';
  if (!r.hasPdf) setStatus(`Failed · ${errs} error${errs === 1 ? '' : 's'}`, 'fail', 'No PDF was produced');
  else if (errs) setStatus(`${errs} error${errs === 1 ? '' : 's'} · ${secs}`, 'fail', 'PDF built despite errors');
  else setStatus((warns ? `OK · ${warns} warning${warns === 1 ? '' : 's'} · ${secs}` : `Compiled · ${secs}`) + (S.settings.draft ? ' · draft' : ''), 'ok', S.settings.draft ? 'Fast (draft) mode: images are shown as boxes' : '');
  $('rawLog').textContent = r.log || logBuf;
  $('pdfEmpty').textContent = r.hasPdf ? '' : 'No PDF was produced — see the Issues panel.';
  if (!r.hasPdf) $('pdfEmpty').classList.remove('hidden');
  if (r.hasPdf) await pdf.load(`${P()}/output.pdf?v=${r.pdfVersion}`, r.pdfVersion, r.mainPdf);
  if (errs && !$('logBody').classList.contains('open-once')) { $('logBody').classList.add('open-once'); showLog(true); }
  bus.emit('compiled', r);
  if (r.hasPdf) api(`${P()}/wordcount`).then((w) => ($('statWords').textContent = `${w.words.toLocaleString()} words`)).catch(() => {});
}

function showLog(open) { const l = $('logBody'); l.classList.toggle('collapsed', !open); $('logToggle').textContent = open ? '▾' : '▴'; $('logToggle').setAttribute('aria-expanded', open); }
$('logToggle').onclick = () => showLog($('logBody').classList.contains('collapsed'));

export function renderIssues(r) {
  const box = $('issues'); box.innerHTML = '';
  const order = { error: 0, warning: 1, badbox: 2 };
  const list = [...(r.issues || [])].sort((a, b) => order[a.type] - order[b.type]);
  const e = list.filter((i) => i.type === 'error').length, w = list.filter((i) => i.type === 'warning').length, bb = list.filter((i) => i.type === 'badbox').length;
  $('issueCount').textContent = e || w ? `${e ? e + ' ✕' : ''}${e && w ? ' · ' : ''}${w ? w + ' ⚠' : ''}` : '';
  $('issueCount').className = e ? 'err' : w ? 'warn' : '';
  if (!list.length) { box.innerHTML = '<div class="noissues">✓ No errors or warnings.</div>'; return; }
  let boxesShown = false;
  for (const i of list) {
    if (i.type === 'badbox' && !boxesShown) { boxesShown = true; const t = document.createElement('button'); t.className = 'toggle-boxes'; t.textContent = `Show ${bb} layout warning${bb === 1 ? '' : 's'} (over/underfull boxes)`; t.onclick = () => { box.classList.toggle('show-boxes'); t.textContent = box.classList.contains('show-boxes') ? 'Hide layout warnings' : `Show ${bb} layout warning${bb === 1 ? '' : 's'} (over/underfull boxes)`; }; box.appendChild(t); }
    const d = document.createElement('div'); d.className = 'issue ' + i.type; d.tabIndex = 0;
    d.innerHTML = `<span class="badge ${i.type}">${i.type === 'badbox' ? 'box' : i.type}</span><span class="loc">${esc(i.file || '')}${i.line ? ':' + i.line : ''}</span><span class="msg">${esc(i.message)}${i.context ? `<div class="ctx">${esc(i.context)}</div>` : ''}${i.hint ? `<div class="hint">💡 ${esc(i.hint)}</div>` : ''}</span>`;
    const go = () => { if (i.file && S.tree && (S.cache.has(i.file) || true)) { stashState(); openFile(i.file, { line: i.line || 1 }); } };
    d.onclick = go; d.onkeydown = (ev) => { if (ev.key === 'Enter') go(); };
    box.appendChild(d);
  }
}

// log tabs
document.querySelectorAll('#logHead [data-tab]').forEach((b) => (b.onclick = () => {
  document.querySelectorAll('#logHead [data-tab]').forEach((x) => { x.classList.toggle('active', x === b); x.setAttribute('aria-selected', x === b); });
  $('issues').hidden = b.dataset.tab !== 'issues'; $('rawLog').hidden = b.dataset.tab !== 'log'; showLog(true);
}));

// requests
const compileSoon = debounce(() => compile(), 120);
bus.on('compile-request', ({ force } = {}) => (force ? compile() : compileSoon()));
bus.on('saved', ({ paths }) => { if (prefs.autoCompile && paths.some(isCompileInput)) compileSoon(); });
bus.on('external-change', ({ path }) => { if (prefs.autoCompile && isCompileInput(path)) compileSoon(); });
bus.on('settings', () => compileSoon());

// events from other tabs / the server
bus.on('ws-compile-start', ({ by }) => { logBuf = ''; livePage = 0; liveStep = ''; if (by !== S.clientId && !S.compiling) { setBusy(true); setStatus('Compiling…', 'busy'); } });
// Live progress while compiling: the highest page TeX has shipped out in the current pass,
// and which step latexmk is on (a 160-page document can take a minute or more).
let livePage = 0, liveStep = '';
bus.on('ws-compile-log', ({ chunk }) => {
  logBuf = (logBuf + chunk).slice(-200000);
  if (!S.compiling) return;
  $('rawLog').textContent = logBuf;
  if (/This is (?:pdfTeX|XeTeX|LuaHBTeX|LuaTeX)/.test(chunk)) { livePage = 0; liveStep = liveStep ? 'rerun' : 'pass'; }
  if (/This is (?:biber|BibTeX)|INFO - This is Biber/i.test(chunk)) liveStep = 'bib';
  for (const m of chunk.matchAll(/\[(\d+)(?=[\]{<\s.]|$)/g)) if (+m[1] > livePage && +m[1] < livePage + 50) livePage = +m[1];
  const what = liveStep === 'bib' ? 'bibliography' : livePage ? `page ${livePage}` : '';
  setStatus(`Compiling…${what ? ' ' + what + (liveStep === 'rerun' ? ' (rerun)' : '') : ''}`, 'busy');
});
bus.on('ws-compiled', ({ by, result }) => { if (by !== S.clientId) applyResult(result); });

// SyncTeX
bus.on('goto-source', ({ file, line, column }) => { stashState(); openFile(file, { line, col: column }); });
bus.on('forward-sync', async () => {
  if (!S.current || !pdf.hasDoc()) return toast('Compile first to jump to the PDF', { kind: 'warn' });
  if (!S.server.synctex) return toast('SyncTeX is not installed on the server', { kind: 'warn' });
  const h = view.state.selection.main.head; const l = view.state.doc.lineAt(h);
  try {
    const q = new URLSearchParams({ pdf: pdf.currentName(), file: S.current, line: l.number, col: h - l.from });
    const r = await api(`${P()}/synctex/view?${q}`);
    if (!pdf.showSource(r)) toast('No PDF location for this line (is it in the compiled document?)', { kind: 'warn' });
  } catch (e) { toast(e.message, { kind: 'error' }); }
});
