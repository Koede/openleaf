// File tree: nested folders, context menu, drag & drop (move files, upload from OS), keyboard navigation.
import { S, bus, esc, flatFiles, fileName, dirName, IMG_EXT } from './state.js';
import { api, P, rawUrl } from './api.js';
import { contextMenu, promptText, confirmBox, toast } from './ui.js';
import { openFile, loadTree, remapPaths, dropPaths, saveDirty, refreshCache, saveSettings, stashState } from './files.js';

const $ = (id) => document.getElementById(id);
let focusPath = null;

const icon = (n) => n.type === 'dir' ? '' : /\.tex$/i.test(n.name) ? '📄' : /\.bib$/i.test(n.name) ? '📚' : IMG_EXT.test(n.name) ? '🖼' : /\.pdf$/i.test(n.name) ? '📕' : /\.(sty|cls)$/i.test(n.name) ? '🧩' : '▫️';

export function renderTree() {
  const root = $('tree'); const keepScroll = root.scrollTop; root.innerHTML = '';
  const draw = (nodes, depth) => {
    for (const n of nodes) {
      const open = !S.collapsed.has(n.path);
      const row = document.createElement('div');
      row.className = 'node' + (n.path === S.current ? ' active' : '') + (n.path === S.settings.main ? ' main' : '') + (n.type === 'dir' ? ' dir' : '');
      row.dataset.path = n.path; row.dataset.type = n.type; row.draggable = true;
      row.setAttribute('role', 'treeitem'); if (n.type === 'dir') row.setAttribute('aria-expanded', open);
      row.tabIndex = n.path === (focusPath || S.current) ? 0 : -1;
      row.style.paddingLeft = 6 + depth * 14 + 'px';
      row.innerHTML = `<span class="ico">${n.type === 'dir' ? (open ? '▾' : '▸') : icon(n)}</span><span class="name">${esc(n.name)}</span>${S.dirty.has(n.path) ? '<span class="dirty" title="Unsaved">●</span>' : ''}${n.path === S.settings.main ? '<span class="star" title="Main document">★</span>' : ''}<button class="more" tabindex="-1" aria-label="Actions for ${esc(n.name)}">⋯</button>`;
      root.appendChild(row);
      if (n.type === 'dir' && open) draw(n.children, depth + 1);
    }
  };
  draw(S.tree, 0);
  if (!S.tree.length) root.innerHTML = '<div class="empty">No files yet.<br>Create or upload some →</div>';
  else if (!root.querySelector('[tabindex="0"]')) root.querySelector('.node')?.setAttribute('tabindex', '0');
  root.scrollTop = keepScroll;
}
bus.on('tree', renderTree); bus.on('current', renderTree); bus.on('settings', renderTree); bus.on('saved', renderTree); bus.on('edit', () => { /* dirty dots are cheap to refresh */ requestAnimationFrame(renderTree); });

const nodeOf = (p) => { const f = (nodes) => { for (const n of nodes) { if (n.path === p) return n; if (n.type === 'dir') { const r = f(n.children); if (r) return r; } } return null; }; return f(S.tree); };
const targetDir = (n) => (!n ? '' : n.type === 'dir' ? n.path : dirName(n.path));
const join = (d, n) => (d ? d + '/' : '') + n;

// ---------- actions ----------
export async function newFile(dir = '') {
  const name = await promptText('New file', `Name${dir ? ' (in ' + dir + ')' : ''}`, 'section.tex', { hint: 'Use / to create subfolders, e.g. chapters/intro.tex' });
  if (!name) return;
  try { const path = join(dir, name.replace(/^\/+/, '')); await api(`${P()}/ops`, { json: { op: 'create', path } }); await loadTree(); await refreshCache([path]); S.collapsed.delete(dir); await openFile(path); } catch (e) { toast(e.message, { kind: 'error' }); }
}
export async function newFolder(dir = '') {
  const name = await promptText('New folder', `Name${dir ? ' (in ' + dir + ')' : ''}`, 'figures');
  if (!name) return;
  try { await api(`${P()}/ops`, { json: { op: 'mkdir', path: join(dir, name) } }); await loadTree(); } catch (e) { toast(e.message, { kind: 'error' }); }
}
async function rename(n) {
  const to = await promptText('Rename / move', 'New path', n.path, { hint: 'Change the folder part to move it.' });
  if (!to || to === n.path) return;
  try {
    await saveDirty();
    const wasMain = S.settings.main === n.path;
    await api(`${P()}/ops`, { json: { op: 'rename', path: n.path, to } });
    remapPaths(n.path, to);
    if (wasMain) await saveSettings({ main: to });
    await loadTree(); await refreshCache(); bus.emit('compile-request', {});
  } catch (e) { toast(e.message, { kind: 'error' }); }
}
async function remove(n) {
  const ok = await confirmBox(`Delete ${n.type === 'dir' ? 'folder' : 'file'}`, `“${n.path}” will be removed from the project. Text files can be restored from the History tab.`, { ok: 'Delete', danger: true });
  if (!ok) return;
  try { await api(`${P()}/ops`, { json: { op: 'delete', path: n.path } }); dropPaths(n.path); await loadTree(); await refreshCache(); bus.emit('compile-request', {}); toast(`Deleted ${fileName(n.path)}`); } catch (e) { toast(e.message, { kind: 'error' }); }
}
async function move(from, toDir) {
  const to = join(toDir, fileName(from));
  if (to === from || toDir === dirName(from)) return;
  if (toDir === from || toDir.startsWith(from + '/')) return toast('Cannot move a folder into itself', { kind: 'warn' });
  try {
    await saveDirty(); const wasMain = S.settings.main === from;
    await api(`${P()}/ops`, { json: { op: 'rename', path: from, to } });
    remapPaths(from, to); if (wasMain) await saveSettings({ main: to });
    S.collapsed.delete(toDir); await loadTree(); await refreshCache(); bus.emit('compile-request', {});
  } catch (e) { toast(e.message, { kind: 'error' }); }
}

function menuFor(n) {
  const dir = targetDir(n);
  const items = [];
  if (n.type === 'file') items.push({ label: 'Open', run: () => { stashState(); openFile(n.path); } });
  if (n.type === 'file' && /\.tex$/i.test(n.path)) items.push({ label: S.settings.main === n.path ? '★ Main document' : 'Set as main document', disabled: S.settings.main === n.path, run: async () => { await saveSettings({ main: n.path }); bus.emit('compile-request', { force: true }); } });
  items.push({ sep: true }, { label: 'New file…', run: () => newFile(dir) }, { label: 'New folder…', run: () => newFolder(dir) }, { label: 'Upload here…', run: () => bus.emit('upload-request', { dir }) });
  items.push({ sep: true }, { label: 'Rename / move…', hint: 'F2', run: () => rename(n) });
  if (n.type === 'file') items.push({ label: 'Download', run: () => (location.href = rawUrl(n.path, '&download=1')) });
  items.push({ label: 'Delete', hint: 'Del', danger: true, run: () => remove(n) });
  return items;
}

// ---------- events ----------
const tree = $('tree');
tree.addEventListener('click', (e) => {
  const row = e.target.closest('.node'); if (!row) return;
  const n = nodeOf(row.dataset.path); if (!n) return;
  focusPath = n.path;
  if (e.target.closest('.more')) { const r = e.target.getBoundingClientRect(); return contextMenu(r.left, r.bottom, menuFor(n)); }
  if (n.type === 'dir') { S.collapsed.has(n.path) ? S.collapsed.delete(n.path) : S.collapsed.add(n.path); renderTree(); tree.querySelector(`[data-path="${CSS.escape(n.path)}"]`)?.focus(); }
  else { stashState(); openFile(n.path); }
});
tree.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const row = e.target.closest('.node'); const n = row ? nodeOf(row.dataset.path) : null;
  contextMenu(e.clientX, e.clientY, n ? menuFor(n) : [{ label: 'New file…', run: () => newFile('') }, { label: 'New folder…', run: () => newFolder('') }, { label: 'Upload…', run: () => bus.emit('upload-request', { dir: '' }) }]);
});
tree.addEventListener('keydown', (e) => {
  const rows = [...tree.querySelectorAll('.node')]; const row = e.target.closest('.node'); if (!row) return;
  const i = rows.indexOf(row); const n = nodeOf(row.dataset.path);
  const go = (r) => { if (r) { focusPath = r.dataset.path; rows.forEach((x) => (x.tabIndex = -1)); r.tabIndex = 0; r.focus(); } };
  if (e.key === 'ArrowDown') { go(rows[i + 1]); e.preventDefault(); }
  else if (e.key === 'ArrowUp') { go(rows[i - 1]); e.preventDefault(); }
  else if (e.key === 'Home') { go(rows[0]); e.preventDefault(); } else if (e.key === 'End') { go(rows[rows.length - 1]); e.preventDefault(); }
  else if (e.key === 'ArrowRight' && n.type === 'dir') { if (S.collapsed.has(n.path)) { S.collapsed.delete(n.path); renderTree(); tree.querySelector(`[data-path="${CSS.escape(n.path)}"]`)?.focus(); } else go(rows[i + 1]); e.preventDefault(); }
  else if (e.key === 'ArrowLeft') { if (n.type === 'dir' && !S.collapsed.has(n.path)) { S.collapsed.add(n.path); renderTree(); tree.querySelector(`[data-path="${CSS.escape(n.path)}"]`)?.focus(); } else go(rows.find((r) => r.dataset.path === dirName(n.path))); e.preventDefault(); }
  else if (e.key === 'Enter' || e.key === ' ') { row.click(); e.preventDefault(); }
  else if (e.key === 'F2') { rename(n); e.preventDefault(); }
  else if (e.key === 'Delete') { remove(n); e.preventDefault(); }
  else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { const r = row.getBoundingClientRect(); contextMenu(r.left + 30, r.bottom, menuFor(n)); e.preventDefault(); }
});

// internal drag (move) and external drop (upload)
tree.addEventListener('dragstart', (e) => { const row = e.target.closest('.node'); if (!row) return; e.dataTransfer.setData('application/x-ls-path', row.dataset.path); e.dataTransfer.effectAllowed = 'move'; });
const clearDrop = () => { tree.classList.remove('dropping'); tree.querySelectorAll('.drop-target').forEach((x) => x.classList.remove('drop-target')); };
const dropTarget = (e) => { const row = e.target.closest('.node'); const n = row ? nodeOf(row.dataset.path) : null; return { row, dir: targetDir(n) }; };
tree.addEventListener('dragover', (e) => {
  e.preventDefault(); clearDrop();
  const { row, dir } = dropTarget(e);
  if (dir && row) (row.dataset.type === 'dir' ? row : tree.querySelector(`[data-path="${CSS.escape(dir)}"]`))?.classList.add('drop-target'); else tree.classList.add('dropping');
});
tree.addEventListener('dragleave', (e) => { if (!tree.contains(e.relatedTarget)) clearDrop(); });
tree.addEventListener('drop', async (e) => {
  e.preventDefault(); const { dir } = dropTarget(e); clearDrop();
  const internal = e.dataTransfer.getData('application/x-ls-path');
  if (internal) return move(internal, dir);
  try { const entries = await entriesFromDrop(e.dataTransfer); if (entries.length) await uploadEntries(entries, dir); } catch (x) { toast(x.message, { kind: 'error' }); }
});
tree.addEventListener('dragend', clearDrop);

export async function entriesFromDrop(dt) {
  const out = [];
  const walk = async (entry, prefix) => {
    if (entry.isFile) await new Promise((res) => entry.file((file) => { out.push({ file, rel: prefix + file.name }); res(); }, res));
    else if (entry.isDirectory) {
      const reader = entry.createReader(); let batch;
      do { batch = await new Promise((res) => reader.readEntries(res, () => res([]))); for (const c of batch) await walk(c, prefix + entry.name + '/'); } while (batch.length);
    }
  };
  const items = [...(dt.items || [])].map((i) => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
  if (items.length) for (const it of items) await walk(it, ''); else for (const f of dt.files || []) out.push({ file: f, rel: f.name });
  return out;
}

export async function uploadEntries(entries, dir = '') {
  const skip = entries.filter(({ rel }) => /(^|\/)(\.git|node_modules|\.DS_Store)(\/|$)/.test(rel));
  entries = entries.filter((e) => !skip.includes(e));
  if (!entries.length) return toast('Nothing to upload', { kind: 'warn' });
  const tooBig = entries.filter(({ file }) => file.size > 100 * 1024 * 1024); if (tooBig.length) toast(`${tooBig.length} file(s) over 100 MB skipped`, { kind: 'warn' });
  entries = entries.filter((e) => !tooBig.includes(e));
  const t = toast(`Uploading ${entries.length} file(s)…`, { ms: 60000 });
  try {
    await saveDirty();
    for (let i = 0; i < entries.length; i += 40) {   // batches keep requests small
      const fd = new FormData(); fd.append('dir', dir);
      for (const { file, rel } of entries.slice(i, i + 40)) { fd.append('paths', rel); fd.append('files', file, file.name); }
      await api(`${P()}/upload`, { method: 'POST', body: fd });
    }
    for (const { rel } of entries) { const p = join(dir, rel); S.states.delete(p); S.dirty.delete(p); }
    t.remove(); await loadTree(); await refreshCache();
    if (S.current && S.open.includes(S.current)) { const c = S.current; S.open = S.open.filter((x) => x !== c); S.states.delete(c); await openFile(c, { focus: false }); }
    toast(`Uploaded ${entries.length} file(s)`, { kind: 'ok' }); bus.emit('compile-request', {});
  } catch (e) { t.remove(); toast('Upload failed: ' + e.message, { kind: 'error', ms: 6000 }); }
}
