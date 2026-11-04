// Application boot + chrome (toolbar, project menu, settings, splitters, status bar).
import { S, bus, prefs, savePrefs, esc, flatFiles, fileName } from './state.js';
import { api, P } from './api.js';
import { toast, modal, promptText, confirmBox, dropdown, timeAgo } from './ui.js';
import * as ed from './editor.js';
import * as files from './files.js';
import * as pdf from './pdf.js';
import { compile } from './compile.js';
import { renderTree, newFile, newFolder, entriesFromDrop, uploadEntries } from './tree.js';
import { initPanels, focusSearch } from './panels.js';
import { connect, watch } from './ws.js';
import './symbols.js';
import './format.js';
import { ensureSignedIn, signOut, changePassword } from './auth.js';

const $ = (id) => document.getElementById(id);
const mac = /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = mac ? '⌘' : 'Ctrl';

// ---------- theme ----------
const mq = matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  const dark = prefs.theme === 'dark' || (prefs.theme === 'system' && mq.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const inv = prefs.pdfInvert === 'on' || (prefs.pdfInvert === 'auto' && dark);
  document.documentElement.dataset.pdfInvert = inv ? '1' : '0';
  try { ed.applyPrefs(); } catch {}
}
mq.addEventListener('change', applyTheme);
bus.on('prefs', applyTheme);

// ---------- layout ----------
function applyLayout() {
  const l = prefs.layout; const w = $('work');
  w.dataset.layout = l;
  for (const [id, v] of [['layEditor', 'editor'], ['laySplit', 'split'], ['layPdf', 'pdf']]) { $(id).classList.toggle('on', l === v); $(id).setAttribute('aria-pressed', l === v); }
  $('sidebar').style.width = prefs.sidebarW + 'px';
  if (prefs.pdfW) $('pdfPane').style.flex = `0 0 ${prefs.pdfW}px`; else $('pdfPane').style.flex = '1 1 0';
  setTimeout(() => pdf.resizeNow(), 30);
}
for (const [id, v] of [['layEditor', 'editor'], ['laySplit', 'split'], ['layPdf', 'pdf']]) $(id).onclick = () => { prefs.layout = v; savePrefs(); applyLayout(); };

function splitter(el, onMove) {
  el.addEventListener('pointerdown', (e) => {
    el.setPointerCapture(e.pointerId); document.body.classList.add('resizing');
    const mv = (ev) => onMove(ev);
    const up = () => { el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); document.body.classList.remove('resizing'); savePrefs(); pdf.resizeNow(); };
    el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up); e.preventDefault();
  });
  el.addEventListener('keydown', (e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { onMove({ key: e.key === 'ArrowLeft' ? -20 : 20 }); savePrefs(); applyLayout(); } });
}
splitter($('splitL'), (e) => { prefs.sidebarW = Math.max(150, Math.min(600, e.key !== undefined ? prefs.sidebarW + e.key : e.clientX)); $('sidebar').style.width = prefs.sidebarW + 'px'; });
splitter($('splitR'), (e) => { const r = $('work').getBoundingClientRect(); prefs.pdfW = Math.max(200, Math.min(r.width - 300, e.key !== undefined ? (prefs.pdfW || r.width / 2) - e.key : r.right - e.clientX)); $('pdfPane').style.flex = `0 0 ${prefs.pdfW}px`; });
$('splitR').addEventListener('dblclick', () => { prefs.pdfW = 0; savePrefs(); applyLayout(); });

// ---------- toolbar: compile ----------
$('compileBtn').onclick = () => compile();
$('autoBtn').onclick = () => { prefs.autoCompile = !prefs.autoCompile; savePrefs(); syncAuto(); toast(prefs.autoCompile ? 'Auto-compile on' : 'Auto-compile off', { ms: 1500 }); };
const syncAuto = () => { $('autoBtn').classList.toggle('on', prefs.autoCompile); $('autoBtn').setAttribute('aria-pressed', prefs.autoCompile); };
$('engineSel').onchange = (e) => files.saveSettings({ engine: e.target.value });
$('mainSel').onchange = (e) => files.saveSettings({ main: e.target.value });
function syncSettingsUi() {
  const sel = $('mainSel'); const opts = new Set(S.candidates || []); if (S.settings.main) opts.add(S.settings.main);
  sel.innerHTML = [...opts].map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('') || '<option value="">(no .tex file)</option>';
  if (S.settings.main) sel.value = S.settings.main;
  $('engineSel').value = S.settings.engine;
}
bus.on('tree', syncSettingsUi); bus.on('settings', syncSettingsUi);

// ---------- editor toolbar ----------
$('tbUndo').onclick = ed.doUndo; $('tbRedo').onclick = ed.doRedo;
$('tbBold').onclick = () => { ed.cmdBold(ed.view); ed.view.focus(); };
$('tbItalic').onclick = () => { ed.cmdItalic(ed.view); ed.view.focus(); };
$('tbMath').onclick = () => { ed.cmdInlineMath(ed.view); ed.view.focus(); };
$('tbComment').onclick = () => { ed.cmdToggleComment(ed.view); ed.view.focus(); };
$('tbFind').onclick = ed.doFind;
$('tbSync').onclick = () => bus.emit('forward-sync');
document.querySelectorAll('#editorTools button:not(#symBtn)').forEach((b) => b.addEventListener('mousedown', (e) => e.preventDefault()));

// ---------- PDF toolbar ----------
$('zoomIn').onclick = () => pdf.zoomBy(1.2); $('zoomOut').onclick = () => pdf.zoomBy(1 / 1.2);
$('fitW').onclick = () => pdf.setMode('width'); $('fitP').onclick = () => pdf.setMode('page');
$('pageNum').onchange = (e) => pdf.gotoPage(Number(e.target.value) || 1);
$('pdfFind').oninput = (e) => pdf.find(e.target.value);
$('pdfFind').onkeydown = (e) => { if (e.key === 'Enter') pdf.findStep(e.shiftKey ? -1 : 1); if (e.key === 'Escape') { e.target.value = ''; pdf.find(''); } };
$('findNext').onclick = () => pdf.findStep(1); $('findPrev').onclick = () => pdf.findStep(-1);

// ---------- status bar ----------
bus.on('cursor', ({ line, col, sel, math }) => { $('statCursor').textContent = `Ln ${line}, Col ${col}${sel ? ` (${sel} selected)` : ''}`; $('statMode').textContent = math ? 'math mode' : ''; });
bus.on('edit', () => ($('statSave').textContent = '● unsaved'));
bus.on('saved', () => { $('statSave').textContent = 'saved'; setTimeout(() => !S.dirty.size && ($('statSave').textContent = ''), 1500); });

// ---------- projects ----------
let projDD, dlDD;
async function listProjects() { const r = await api('/api/projects'); S.server = { synctex: r.synctex, latexmk: r.latexmk, templates: r.templates }; return r; }

async function buildProjMenu() {
  const m = $('projMenu'); const r = await listProjects();
  m.innerHTML = '<div class="menu-h">Projects</div>';
  for (const p of r.details) {
    const b = document.createElement('button'); b.className = 'menu-item' + (p.name === S.project ? ' cur' : '');
    b.innerHTML = `<span>${esc(p.name)}</span><small>${timeAgo(p.mtime)}</small>`; b.onclick = () => { projDD.close(); if (p.name !== S.project) openProject(p.name); }; m.appendChild(b);
  }
  m.insertAdjacentHTML('beforeend', '<hr>');
  const add = (label, fn, cls = '') => { const b = document.createElement('button'); b.className = 'menu-item ' + cls; b.textContent = label; b.onclick = () => { projDD.close(); fn(); }; m.appendChild(b); };
  add('＋ New project…', newProject); add('⬆ Import .zip…', () => $('zipInput').click());
  m.insertAdjacentHTML('beforeend', '<hr>');
  add('Rename current…', renameProject); add('Duplicate current…', copyProject); add('Delete current…', deleteProject, 'danger');
  if (S.user) { m.insertAdjacentHTML('beforeend', '<hr>'); add('Change password…', changePassword); add(`Sign out (${S.user})`, signOut); }
}
projDD = dropdown($('projBtn'), $('projMenu'), { onOpen: buildProjMenu });

async function newProject() {
  const tpls = S.server.templates;
  const v = await modal({ title: 'New project', fields: [{ name: 'name', label: 'Name', value: 'untitled', hint: 'Letters, numbers, dashes, underscores, spaces' }, { name: 'template', label: 'Template', type: 'select', options: tpls.map((t) => ({ value: t.id, label: `${t.name} — ${t.description}` })) }], ok: 'Create' });
  if (!v || !v.name.trim()) return;
  try { await api('/api/projects', { json: { name: v.name.trim(), template: v.template } }); await openProject(v.name.trim()); } catch (e) { toast(e.message, { kind: 'error' }); }
}
async function renameProject() {
  const to = await promptText('Rename project', 'New name', S.project); if (!to || to === S.project) return;
  try { await api(`/api/projects/${encodeURIComponent(S.project)}/rename`, { json: { to } }); await openProject(to); } catch (e) { toast(e.message, { kind: 'error' }); }
}
async function copyProject() {
  const to = await promptText('Duplicate project', 'Name for the copy', S.project + '-copy'); if (!to) return;
  try { await files.saveDirty(); await api(`/api/projects/${encodeURIComponent(S.project)}/copy`, { json: { to } }); await openProject(to); } catch (e) { toast(e.message, { kind: 'error' }); }
}
async function deleteProject() {
  if (!(await confirmBox('Delete project', `Permanently delete “${S.project}” and all its files? This cannot be undone.`, { ok: 'Delete', danger: true }))) return;
  const name = S.project;
  try {
    await api(`/api/projects/${encodeURIComponent(name)}`, { method: 'DELETE' });
    const r = await listProjects(); const next = r.projects[0];
    if (next) await openProject(next); else { await api('/api/projects', { json: { name: 'untitled', template: 'article' } }); await openProject('untitled'); }
  } catch (e) { toast(e.message, { kind: 'error' }); }
}
$('zipInput').onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  const name = await promptText('Import project', 'Project name', f.name.replace(/\.zip$/i, '')); if (!name) return;
  const fd = new FormData(); fd.append('name', name); fd.append('zip', f);
  try { await api('/api/import', { method: 'POST', body: fd }); await openProject(name); toast('Project imported', { kind: 'ok' }); } catch (err) { toast(err.message, { kind: 'error' }); }
};

export async function openProject(name) {
  if (S.project) { try { await files.saveDirty(); } catch {} }
  S.project = name; S.open = []; S.current = null; S.states.clear(); S.dirty.clear(); S.cache.clear(); S.issues = []; S.lastResult = null; S.conflicts.clear();
  try { localStorage.setItem('ls-last', name); } catch {}
  try { history.replaceState(null, '', '#' + encodeURIComponent(name)); } catch {}
  $('projName').textContent = name; document.title = name + ' — LaTeX Studio';
  ed.setViewState(ed.mkState('', 'x.tex')); files.renderTabs();
  $('issues').innerHTML = ''; $('issueCount').textContent = ''; $('rawLog').textContent = ''; $('statWords').textContent = '';
  $('pdfEmpty').classList.remove('hidden'); $('pdfPages').innerHTML = ''; $('pageTotal').textContent = '0';
  watch();
  await files.loadTree(); await files.refreshCache();
  const first = S.settings.main || flatFiles().find((p) => p.endsWith('.tex'));
  if (first) await files.openFile(first, { focus: false });
  bus.emit('current', { path: S.current });
  // show an existing PDF immediately, then recompile
  if (!window.__DEMO) pdf.load(`${P()}/output.pdf?t=${Date.now()}`, Date.now(), S.settings.main && S.settings.main.replace(/\.tex$/, '.pdf')).catch(() => {});
  if (prefs.autoCompile) bus.emit('compile-request', { force: true });
}

// ---------- download menu ----------
dlDD = dropdown($('dlBtn'), $('dlMenu'), {
  onOpen: () => {
    const m = $('dlMenu'); m.innerHTML = '';
    const a = (label, href, extra = {}) => { const e = document.createElement('a'); e.className = 'menu-item'; e.textContent = label; e.href = href; e.download = ''; e.onclick = () => dlDD.close(); Object.assign(e, extra); m.appendChild(e); };
    const b = (label, fn) => { const e = document.createElement('button'); e.className = 'menu-item'; e.textContent = label; e.onclick = () => { dlDD.close(); fn(); }; m.appendChild(e); };
    a('PDF', `${P()}/output.pdf?download=1`); a('Project (.zip)', `${P()}/download.zip`); a('Compile log', `${P()}/build-log`);
    m.insertAdjacentHTML('beforeend', '<hr>');
    b('Clean build files', async () => { try { await api(`${P()}/clean`, { method: 'POST', json: {} }); toast('Build files removed', { kind: 'ok' }); bus.emit('compile-request', { force: true }); } catch (e) { toast(e.message, { kind: 'error' }); } });
  },
});

// ---------- settings + help ----------
$('settingsBtn').onclick = async () => {
  const v = await modal({
    title: 'Settings', ok: 'Save', fields: [
      { name: 'theme', label: 'Theme', type: 'select', value: prefs.theme, options: [{ value: 'system', label: 'Match system' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }] },
      { name: 'fontSize', label: 'Editor font size (px)', value: String(prefs.fontSize) },
      { name: 'wrap', label: 'Wrap long lines', type: 'checkbox', value: prefs.wrap },
      { name: 'spellcheck', label: 'Browser spell-check in editor', type: 'checkbox', value: prefs.spellcheck },
      { name: 'fold', label: 'Code folding (sections, environments)', type: 'checkbox', value: prefs.fold },
      { name: 'pdfInvert', label: 'Dark PDF pages', type: 'select', value: prefs.pdfInvert, options: [{ value: 'auto', label: 'Automatic (in dark theme)' }, { value: 'on', label: 'Always' }, { value: 'off', label: 'Never' }] },
      { name: 'haltOnError', label: 'Stop at first error (this project)', type: 'checkbox', value: S.settings.haltOnError },
    ],
  });
  if (!v) return;
  const fs_ = Math.max(9, Math.min(32, parseInt(v.fontSize, 10) || 14));
  Object.assign(prefs, { theme: v.theme, fontSize: fs_, wrap: v.wrap, spellcheck: v.spellcheck, fold: v.fold, pdfInvert: v.pdfInvert }); savePrefs();
  if (v.haltOnError !== S.settings.haltOnError) files.saveSettings({ haltOnError: v.haltOnError });
};
$('helpBtn').onclick = () => modal({
  title: 'Keyboard shortcuts', cancel: '', ok: 'Close', width: '460px',
  html: `<table class="keys">${[
    [`${MOD}+Enter`, 'Recompile'], [`${MOD}+S`, 'Save now (and compile)'], [`${MOD}+Shift+K`, 'Symbols & templates palette'], ['Tab / Shift+Tab', 'Next / previous template box; Tab also steps out of a closing brace'], [`${MOD}+B / I / M`, 'Bold / italic / inline math'], [`${MOD}+U`, 'Underline'], [`${MOD}+Shift+E / L / R / J`, 'Centre / left / right / justify'], [`${MOD}+Shift+7 / 8`, 'Numbered / bulleted list'], [`${MOD}+Alt+0 / 1 / 2 / 3`, 'Normal text / section / subsection / subsubsection'], [`${MOD}+/`, 'Toggle comment'], [`${MOD}+F`, 'Find in file'], [`${MOD}+Shift+F`, 'Search project'], [`${MOD}+Alt+J`, 'Jump from source to PDF'], ['Double-click PDF', 'Jump from PDF to source'], [`${MOD}+Space`, 'Autocomplete'],
  ].map(([k, d]) => `<tr><td><kbd>${k}</kbd></td><td>${d}</td></tr>`).join('')}</table>`,
});

// ---------- file tree buttons / uploads ----------
$('newFileBtn').onclick = () => newFile(''); $('newFolderBtn').onclick = () => newFolder('');
let uploadDir = '';
$('uploadBtn').onclick = () => { uploadDir = ''; $('fileInput').click(); };
bus.on('upload-request', ({ dir = '', folder } = {}) => { uploadDir = dir; (folder ? $('folderInput') : $('fileInput')).click(); });
$('fileInput').onchange = (e) => { const list = [...e.target.files].map((file) => ({ file, rel: file.name })); e.target.value = ''; if (list.length) uploadEntries(list, uploadDir); };
$('folderInput').onchange = (e) => { const list = [...e.target.files].map((file) => ({ file, rel: file.webkitRelativePath || file.name })); e.target.value = ''; if (list.length) uploadEntries(list, uploadDir); };
let dragDepth = 0;
const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
window.addEventListener('dragenter', (e) => { if (hasFiles(e)) { dragDepth++; document.body.classList.add('dropping'); } });
window.addEventListener('dragleave', (e) => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dropping'); } });
window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('drop', async (e) => {
  dragDepth = 0; document.body.classList.remove('dropping');
  if (!hasFiles(e) || e.target.closest?.('#tree .node')) return;       // tree handles drops on specific folders itself
  e.preventDefault(); const entries = await entriesFromDrop(e.dataTransfer); if (entries.length) uploadEntries(entries, '');
});

// ---------- global shortcuts ----------
window.addEventListener('keydown', (e) => {
  const mod = mac ? e.metaKey : e.ctrlKey; if (!mod) return;
  const k = e.key.toLowerCase();
  if (k === 'enter') { e.preventDefault(); bus.emit('save-request', { compile: true }); bus.emit('compile-request', { force: true }); }
  else if (k === 's') { e.preventDefault(); bus.emit('save-request', { compile: true }); }
  else if (k === 'k' && e.shiftKey) { e.preventDefault(); bus.emit('toggle-palette'); }
  else if (k === 'f' && e.shiftKey) { e.preventDefault(); const s = ed.view.state.sliceDoc(ed.view.state.selection.main.from, ed.view.state.selection.main.to); focusSearch(s && !s.includes('\n') ? s : ''); }
  else if (k === 'j' && e.altKey) { e.preventDefault(); bus.emit('forward-sync'); }
}, true);
window.addEventListener('beforeunload', (e) => { if (S.dirty.size) { e.preventDefault(); e.returnValue = ''; } });
window.addEventListener('resize', () => pdf.resizeNow());

// ---------- boot ----------
async function boot() {
  applyTheme(); applyLayout(); syncAuto();
  if (!(await ensureSignedIn()) && S.accounts) return;
  initPanels(); connect(); renderTree();
  if (S.user) { $('projBtn').title = `Signed in as ${S.user}`; }
  let r; try { r = await listProjects(); } catch (e) { toast(e.message, { kind: 'error', ms: 10000 }); return; }
  if (!r.latexmk) toast('latexmk not found — install TeX Live to compile.', { kind: 'warn', ms: 10000 });
  let name = decodeURIComponent(location.hash.slice(1)); try { name = name || localStorage.getItem('ls-last') || ''; } catch {}
  if (!r.projects.includes(name)) name = r.projects[0];
  if (!name) { await api('/api/projects', { json: { name: 'my-first-project', template: 'article' } }); name = 'my-first-project'; }
  await openProject(name);
}
window.addEventListener('hashchange', () => { const n = decodeURIComponent(location.hash.slice(1)); if (n && n !== S.project) openProject(n).catch(() => {}); });
boot();
window.__studio = { S, bus, prefs, ed, files, pdf };   // handy for debugging and e2e tests
