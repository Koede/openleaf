// Insert helpers like Overleaf's toolbar: cross-reference picker, citation picker, Insert figure dialog.
// Labels and bibliography entries come from the project files cached in S.cache.
import { S, esc, flatFiles, IMG_EXT } from './state.js';
import { view, insertTemplate } from './editor.js';
import { checkPackage } from './symbols.js';
import { plainTitle, headingIn } from './panels.js';
import { uploadEntries } from './tree.js';
import { toast } from './ui.js';

const anyFileUses = (re) => [...S.cache].some(([p, t]) => /\.(tex|sty|cls)$/i.test(p) && re.test(t));

// ---------- data ----------
export function collectLabels() {
  const out = [];
  for (const [path, text] of S.cache) {
    if (!/\.tex$/i.test(path)) continue;
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      for (const m of line.replace(/(^|[^\\])%.*/, '$1').matchAll(/\\label\{([^}]+)\}/g)) {
        let context = '', kind = '';
        for (let j = i; j >= Math.max(0, i - 12); j--) {
          const l = lines[j];
          const h = headingIn(l);
          const c = l.match(/\\caption(?:\[[^\]]*\])?\{(.*)/);
          const e = l.match(/\\begin\{(figure|table|equation|align|gather|multline|theorem|lemma|definition)\*?\}/);
          if (!context && h) { context = plainTitle(h[2]); kind = kind || h[1]; }
          if (!context && c) context = plainTitle(c[1].replace(/\}\s*$/, ''));
          if (!kind && e) kind = e[1];
          if (context && kind) break;
        }
        out.push({ key: m[1], context: context || plainTitle(line.trim()).slice(0, 90), kind: kind || (m[1].split(':')[0] || ''), file: path, line: i + 1 });
      }
    });
  }
  return out;
}

const field = (body, name) => {
  const m = new RegExp(`(?:^|[,\\s])${name}\\s*=\\s*`, 'i').exec(body); if (!m) return '';
  let i = m.index + m[0].length, open = body[i], depth = 0, s = '';
  if (open === '{') { for (i++; i < body.length; i++) { const ch = body[i]; if (ch === '{') depth++; else if (ch === '}') { if (!depth) break; depth--; } s += ch; } }
  else if (open === '"') { for (i++; i < body.length && body[i] !== '"'; i++) s += body[i]; }
  else s = (/^[^,\n]*/.exec(body.slice(i)) || [''])[0];
  return s.replace(/[{}]/g, '').replace(/\\["'`^~=.]\s*/g, '').replace(/\s+/g, ' ').trim();
};
export function collectBib() {
  const out = [], seen = new Set();
  for (const [path, text] of S.cache) {
    if (!/\.bib$/i.test(path)) continue;
    for (const m of text.matchAll(/@(\w+)\s*\{\s*([^,\s]+)\s*,/g)) {
      const type = m[1].toLowerCase(); if (type === 'comment' || type === 'string' || type === 'preamble' || seen.has(m[2])) continue;
      seen.add(m[2]);
      const body = text.slice(m.index + m[0].length, m.index + m[0].length + 4000).split(/\n@/)[0];
      const author = field(body, 'author') || field(body, 'editor');
      const first = author.split(/\s+and\s+/i)[0] || '';
      // "Aad, G." / "G. Aad" -> Aad; a group author ("ATLAS Collaboration") is kept whole
      const group = !first.includes(',') && /\b(collaboration|group|team|consortium|project|committee)\b/i.test(first);
      const last = group ? first : first.includes(',') ? first.split(',')[0] : first.split(' ').pop();
      const authors = author ? last + (/\s+and\s+/i.test(author) ? ' et al.' : '') : '';
      out.push({ key: m[2], type, title: field(body, 'title'), authors, year: field(body, 'year') || (field(body, 'date').match(/\d{4}/) || [''])[0], file: path });
    }
  }
  return out;
}

// ---------- inserting ----------
// Inside an existing \cite{a, | } or \ref{ | } only the key is added; otherwise the whole command.
function insertCommand(cmd, keys, argRe) {
  const st = view.state, sel = st.selection.main;
  const before = st.sliceDoc(Math.max(0, sel.from - 200), sel.from);
  let text;
  if (argRe.test(before)) text = (/[{,]\s*$/.test(before) ? '' : ', ') + keys.join(', ');
  else text = `\\${cmd}{${keys.join(', ')}}`;
  view.dispatch({ changes: { from: sel.from, to: sel.to, insert: text }, selection: { anchor: sel.from + text.length }, scrollIntoView: true, userEvent: 'input' });
  view.focus();
}

// ---------- picker dialog ----------
function picker({ title, placeholder, items, render, match, commands, multi, onPick, empty }) {
  const prev = document.activeElement;
  const back = document.createElement('div'); back.className = 'modal-back';
  const box = document.createElement('div'); box.className = 'modal picker'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-label', title);
  box.innerHTML = `<h3>${esc(title)}</h3>
    <div class="pk-row"><input type="search" class="pk-q" placeholder="${esc(placeholder)}" autocomplete="off" spellcheck="false" aria-label="Search">
    ${commands ? `<select class="pk-cmd" aria-label="Command">${commands.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('')}</select>` : ''}</div>
    <div class="pk-list" role="listbox" ${multi ? 'aria-multiselectable="true"' : ''}></div>
    <div class="pk-foot"><span class="muted pk-count"></span><span class="grow"></span>${multi ? '<span class="muted pk-hint">Space or Ctrl+click selects several</span>' : ''}<button type="button" class="pk-cancel">Cancel</button><button type="button" class="primary pk-ok">Insert</button></div>`;
  back.appendChild(box); document.body.appendChild(back);
  const q = box.querySelector('.pk-q'), list = box.querySelector('.pk-list'), cmdSel = box.querySelector('.pk-cmd');
  let shown = [], cur = 0; const chosen = new Set();
  const close = () => { document.removeEventListener('keydown', onEsc, true); back.remove(); if (prev && prev.focus) prev.focus(); };
  const onEsc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(); } };
  document.addEventListener('keydown', onEsc, true);
  const draw = () => {
    const words = q.value.toLowerCase().split(/\s+/).filter(Boolean);
    const all = items.filter((it) => words.every((w) => match(it).toLowerCase().includes(w)));
    shown = all.slice(0, 300); cur = Math.min(cur, Math.max(0, shown.length - 1));
    box.querySelector('.pk-count').textContent = items.length ? `${all.length} of ${items.length}${all.length > shown.length ? ` (first ${shown.length} shown)` : ''}${chosen.size ? ` · ${chosen.size} selected` : ''}` : '';
    if (!items.length) { list.innerHTML = `<div class="empty">${empty}</div>`; return; }
    list.innerHTML = shown.map((it, i) => `<div class="pk-item${i === cur ? ' cur' : ''}${chosen.has(it.key) ? ' on' : ''}" role="option" aria-selected="${chosen.has(it.key) || i === cur}" data-i="${i}">${render(it)}</div>`).join('') || '<div class="empty">No matches.</div>';
    list.querySelector('.pk-item.cur')?.scrollIntoView({ block: 'nearest' });
  };
  const commit = () => {
    const keys = multi && chosen.size ? [...chosen] : shown[cur] ? [shown[cur].key] : [];
    if (!keys.length) return;
    close(); onPick(keys, cmdSel ? cmdSel.value : null);
  };
  const toggle = (i) => { const k = shown[i]?.key; if (!k) return; chosen.has(k) ? chosen.delete(k) : chosen.add(k); draw(); };
  q.oninput = () => { cur = 0; draw(); };
  q.onkeydown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); cur = Math.min(shown.length - 1, cur + 1); draw(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); cur = Math.max(0, cur - 1); draw(); }
    else if (e.key === 'Enter') { e.preventDefault(); commit(); }
    else if (e.key === ' ' && multi && !q.value.endsWith(' ') && q.selectionStart === q.value.length && e.ctrlKey) { e.preventDefault(); toggle(cur); }
  };
  list.onkeydown = (e) => { if (e.key === ' ' && multi) { e.preventDefault(); toggle(cur); } };
  list.onclick = (e) => { const it = e.target.closest('.pk-item'); if (!it) return; cur = +it.dataset.i; if (multi && (e.ctrlKey || e.metaKey)) toggle(cur); else draw(); };
  list.ondblclick = (e) => { if (e.target.closest('.pk-item')) commit(); };
  box.querySelector('.pk-cancel').onclick = close; box.querySelector('.pk-ok').onclick = commit;
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  draw(); setTimeout(() => q.focus(), 0);
}

export function openRefPicker() {
  if (!S.current) return;
  const labels = collectLabels();
  // Offer \cref when cleveref is loaded (also through a class or style file) or already used, and
  // put first whichever command the document already uses most.
  const count = (re) => [...S.cache].reduce((n, [p, t]) => n + (/\.tex$/i.test(p) ? (t.match(re) || []).length : 0), 0);
  const uses = { cref: count(/\\cref\{/g), Cref: count(/\\Cref\{/g), ref: count(/\\ref\{/g), autoref: count(/\\autoref\{/g) };
  const clever = uses.cref + uses.Cref > 0 || anyFileUses(/\\(?:usepackage|RequirePackage)(?:\[[^\]]*\])?\{[^}]*\bcleveref\b/);
  let commands = [...(clever ? [['cref', '\\cref'], ['Cref', '\\Cref']] : []), ['ref', '\\ref'], ['eqref', '\\eqref'], ['autoref', '\\autoref'], ['pageref', '\\pageref'], ['nameref', '\\nameref']];
  const top = Object.entries(uses).filter(([k]) => commands.some(([c]) => c === k)).sort((a, b) => b[1] - a[1])[0];
  if (top && top[1] > 0) commands = [commands.find(([c]) => c === top[0]), ...commands.filter(([c]) => c !== top[0])];
  picker({
    title: 'Add a cross-reference', placeholder: 'Search labels, section titles, captions…', items: labels, commands,
    empty: 'No labels in this project yet. Add <code>\\label{…}</code> after a section, figure, table or equation.',
    match: (l) => `${l.key} ${l.context} ${l.kind} ${l.file}`,
    render: (l) => `<code class="pk-key">${esc(l.key)}</code><span class="pk-kind">${esc(l.kind)}</span><span class="pk-ctx">${esc(l.context)}</span><small>${esc(l.file.split('/').pop())}:${l.line}</small>`,
    onPick: (keys, cmd) => {
      if (cmd === 'cref' || cmd === 'Cref') checkPackage('cleveref', 'cross-reference');
      if (cmd === 'autoref' || cmd === 'nameref') checkPackage('hyperref', 'cross-reference');
      if (cmd === 'eqref') checkPackage('amsmath', 'equation reference');
      insertCommand(cmd, keys.slice(0, 1), /\\[a-zA-Z]*ref\{[^}]*$/);
    },
  });
}

export function openCitePicker() {
  if (!S.current) return;
  const entries = collectBib();
  const biblatex = anyFileUses(/\\usepackage(?:\[[^\]]*\])?\{biblatex\}/), natbib = anyFileUses(/\\usepackage(?:\[[^\]]*\])?\{natbib\}/);
  const commands = [['cite', '\\cite'], ...(natbib ? [['citep', '\\citep'], ['citet', '\\citet']] : []), ...(biblatex ? [['autocite', '\\autocite'], ['textcite', '\\textcite'], ['parencite', '\\parencite']] : [])];
  picker({
    title: 'Add a citation', placeholder: 'Search by key, author, title or year…', items: entries, commands, multi: true,
    empty: 'No bibliography entries found. Add a <code>.bib</code> file to the project.',
    match: (b) => `${b.key} ${b.authors} ${b.title} ${b.year}`,
    render: (b) => `<code class="pk-key">${esc(b.key)}</code><span class="pk-ctx"><b>${esc(b.authors || '—')}</b>${b.year ? ` (${esc(b.year)})` : ''} ${esc(b.title)}</span><small>${esc(b.type)}</small>`,
    onPick: (keys, cmd) => insertCommand(cmd, keys, /\\[a-zA-Z]*cite[a-zA-Z]*\*?(?:\[[^\]]*\])*\{[^}]*$/),
  });
}

// ---------- Insert figure ----------
export function openFigureDialog() {
  if (!S.current) return;
  const prev = document.activeElement;
  const images = () => flatFiles().filter((p) => IMG_EXT.test(p) || /\.(pdf|eps)$/i.test(p));
  const back = document.createElement('div'); back.className = 'modal-back';
  const box = document.createElement('div'); box.className = 'modal fig'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-label', 'Insert figure');
  box.innerHTML = `<h3>Insert figure</h3>
    <label class="field"><span>Image</span><span class="pk-row"><select name="img"></select><button type="button" class="fig-up">Upload…</button></span></label>
    <div class="fig-prev"></div>
    <label class="field"><span>Width</span><select name="w"><option value="0.25">¼ of the text width</option><option value="0.5">½ of the text width</option><option value="0.75">¾ of the text width</option><option value="0.8" selected>0.8 of the text width</option><option value="1">Full text width</option></select></label>
    <label class="field"><span>Caption</span><input type="text" name="cap" autocomplete="off"></label>
    <label class="field"><span>Label</span><input type="text" name="lab" autocomplete="off" spellcheck="false"></label>
    <label class="field check"><input type="checkbox" name="float" checked><span>Floating figure (with caption, placed by LaTeX)</span></label>
    <p class="fb-err" role="alert"></p>
    <div class="modal-actions"><button type="button" class="fig-cancel">Cancel</button><button type="button" class="primary fig-ok">Insert</button></div>
    <input type="file" class="fig-file" accept="image/*,.pdf,.eps" hidden>`;
  back.appendChild(box); document.body.appendChild(back);
  const sel = box.querySelector('[name=img]'), lab = box.querySelector('[name=lab]'), cap = box.querySelector('[name=cap]'), err = box.querySelector('.fb-err'), prevBox = box.querySelector('.fig-prev');
  // \includegraphics paths are relative to the main file's folder (and to \graphicspath, not handled here)
  const mainDir = (S.settings.main || '').includes('/') ? S.settings.main.slice(0, S.settings.main.lastIndexOf('/') + 1) : '';
  const rel = (p) => (mainDir && p.startsWith(mainDir) ? p.slice(mainDir.length) : p);
  let labelTouched = false;
  const fill = (pick) => {
    const list = images();
    sel.innerHTML = list.length ? list.map((p) => `<option value="${esc(p)}"${p === pick ? ' selected' : ''}>${esc(p)}</option>`).join('') : '<option value="">(no images in the project yet)</option>';
    update();
  };
  const update = () => {
    const p = sel.value;
    if (!labelTouched) lab.value = p ? 'fig:' + p.split('/').pop().replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_-]+/g, '-') : '';
    prevBox.innerHTML = p && IMG_EXT.test(p) && !/\.(pdf|eps)$/i.test(p) ? `<img alt="" src="/api/p/${encodeURIComponent(S.project)}/raw?path=${encodeURIComponent(p)}">` : '';
  };
  const close = () => { document.removeEventListener('keydown', onEsc, true); back.remove(); if (prev && prev.focus) prev.focus(); };
  const onEsc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(); } };
  document.addEventListener('keydown', onEsc, true);
  sel.onchange = update; lab.oninput = () => (labelTouched = true);
  const fileIn = box.querySelector('.fig-file');
  box.querySelector('.fig-up').onclick = () => fileIn.click();
  fileIn.onchange = async () => {
    const f = fileIn.files[0]; if (!f) return;
    const dir = 'figures';
    await uploadEntries([{ file: f, rel: f.name }], dir);
    fill(`${dir}/${f.name}`);
  };
  box.querySelector('.fig-cancel').onclick = close;
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  box.querySelector('.fig-ok').onclick = () => {
    const p = sel.value; if (!p) { err.textContent = 'Choose or upload an image first.'; return; }
    const w = box.querySelector('[name=w]').value, floating = box.querySelector('[name=float]').checked;
    const width = w === '1' ? '\\linewidth' : `${w}\\linewidth`;
    const gfx = `\\includegraphics[width=${width}]{${rel(p)}}`;
    const caption = cap.value.trim(), label = lab.value.trim();
    const tpl = floating
      ? `\\begin{figure}[htbp]\n  \\centering\n  ${gfx}\n  \\caption{${caption ? caption.replace(/[#]/g, '\\#') : '#{1}'}}\n${label ? `  \\label{${label}}\n` : ''}\\end{figure}\n`
      : `\\begin{center}\n  ${gfx}\n\\end{center}\n`;
    close();
    if (insertTemplate(tpl, { mode: 'text', pkg: 'graphicx' })) checkPackage('graphicx', 'Figure');
    else toast('Open a .tex file first', { kind: 'warn' });
  };
  fill(); setTimeout(() => sel.focus(), 0);
}
