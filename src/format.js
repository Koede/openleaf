// Google-Docs-style formatting toolbar. Every control inserts the LaTeX for that format at the caret with a blank
// box inside it (Tab/Esc leaves the box), so whatever is typed next comes out formatted. With text selected the
// selection is wrapped instead. Missing packages are offered through the same "Add it" toast as the symbol palette.
import { openRefPicker, openCitePicker, openFigureDialog } from './pickers.js';
import { nextSnippetField, completionStatus } from '@codemirror/autocomplete';
import { S, bus, prefs, savePrefs } from './state.js';
import * as ed from './editor.js';
import { checkPackage } from './symbols.js';
import { dropdown, promptText } from './ui.js';

const $ = (id) => document.getElementById(id);
const bar = $('fmtTools');

// text size names are LaTeX's own; the pt values are for the default 10pt document class
export const SIZES = [['Tiny', 'tiny', 5], ['Script', 'scriptsize', 7], ['Footnote', 'footnotesize', 8], ['Small', 'small', 9], ['Normal', 'normalsize', 10], ['Large', 'large', 12], ['Larger', 'Large', 14], ['Largest', 'LARGE', 17], ['Huge', 'huge', 20], ['Gigantic', 'Huge', 25]];
export const FONTS = [['Serif', 'textrm'], ['Sans-serif', 'textsf'], ['Monospace', 'texttt'], ['Small caps', 'textsc'], ['Slanted', 'textsl'], ['Emphasis', 'emph']];
export const STYLES = [['Normal text', ''], ['Chapter', 'chapter'], ['Section', 'section'], ['Subsection', 'subsection'], ['Subsubsection', 'subsubsection'], ['Paragraph', 'paragraph']];
export const COLORS = [['Black', 'black'], ['Gray', 'gray'], ['Red', 'red'], ['Orange', 'orange'], ['Green', 'green!50!black'], ['Blue', 'blue'], ['Purple', 'violet'], ['Brown', 'brown']];
export const SPACING = [['Single', '1'], ['1.15', '1.15'], ['1.5', '1.5'], ['Double', '2']];

const done = (ok, pkgs = [], label = '') => { if (ok) pkgs.forEach((p) => checkPackage(p, label)); return ok; };
const inline = (before, after, pkgs = [], label = '') => done(ed.formatInline(before, after, { pkg: pkgs[0] || '' }), pkgs, label);
const block = (env, arg = '', pkgs = [], label = '', body = '', perLine = null) => done(ed.formatBlock(`\\begin{${env}}${arg}`, `\\end{${env}}`, { pkg: pkgs[0] || '', body, perLine }), pkgs, label);
const tpl = (t, pkgs = [], label = '') => done(ed.insertTemplate(t, { mode: 'text', pkg: pkgs[0] || '' }), pkgs, label);

export const actions = {
  bold: () => ed.cmdBold(ed.view),
  italic: () => ed.cmdItalic(ed.view),
  underline: () => ed.cmdUnderline(ed.view),
  strike: () => inline('\\sout{', '}', ['ulem'], 'Strikethrough'),
  sup: () => inline('\\textsuperscript{', '}'),
  sub: () => inline('\\textsubscript{', '}'),
  mono: () => inline('\\texttt{', '}'),
  size: (cmd) => inline(`{\\${cmd} `, '}'),
  customSize: async () => { const v = await promptText('Custom font size', 'Size in points (line spacing becomes 1.2×)', '18', { type: 'number' }); const n = parseFloat(v); if (n > 0) inline(`{\\fontsize{${n}}{${+(n * 1.2).toFixed(1)}}\\selectfont `, '}'); },
  font: (cmd) => inline(`\\${cmd}{`, '}'),
  color: (c) => inline(`\\textcolor{${c}}{`, '}', ['xcolor'], 'Text colour'),
  customColor: async () => { const v = await promptText('Custom colour', 'Hex colour, e.g. FF8800', 'FF8800'); if (v && /^#?[0-9a-f]{6}$/i.test(v)) inline(`\\textcolor[HTML]{${v.replace('#', '').toUpperCase()}}{`, '}', ['xcolor'], 'Text colour'); },
  highlight: () => inline('\\hl{', '}', ['xcolor', 'soul'], 'Highlight'),
  heading: (cmd) => ed.formatHeading(cmd),
  left: () => block('flushleft'),
  center: () => block('center'),
  right: () => block('flushright'),
  justify: () => block('justify', '', ['ragged2e'], 'Justify'),
  bullets: () => block('itemize', '', [], '', '\\item #{1}', (l) => (l.trim() ? l.replace(/^(\s*)/, '$1\\item ') : l)),
  numbers: () => block('enumerate', '', [], '', '\\item #{1}', (l) => (l.trim() ? l.replace(/^(\s*)/, '$1\\item ') : l)),
  spacing: (n) => block('spacing', `{${n}}`, ['setspace'], 'Line spacing'),
  indent: () => block('quote'),
  columns: () => block('multicols', '{2}', ['multicol'], 'Columns'),
  link: () => tpl('\\href{#{2}}{#{1}}', ['hyperref'], 'Link'),
  image: () => openFigureDialog(),
  footnote: () => tpl('\\footnote{#{1}}'),
  cite: () => openCitePicker(),
  ref: () => openRefPicker(),
  label: () => tpl('\\label{#{1}}'),
  equation: () => tpl('\\begin{equation}\n  #{1}\n  \\label{eq:#{2}}\n\\end{equation}\n'),
  display: () => tpl('\\[\n  #{1}\n\\]\n'),
  quote: () => block('quote'),
  code: () => block('verbatim'),
  abstract: () => block('abstract'),
  pagebreak: () => tpl('\\newpage\n'),
  rule: () => tpl('\\noindent\\rule{\\linewidth}{0.4pt}\n'),
  toc: () => tpl('\\tableofcontents\n'),
  titleBlock: () => tpl('\\title{#{1}}\n\\author{#{2}}\n\\date{\\today}\n\\maketitle\n'),
  table: (rows, cols) => {
    let n = 0; const line = () => Array.from({ length: cols }, () => `#{${++n}}`).join(' & ') + ' \\\\';
    const body = Array.from({ length: rows }, () => `  ${line()}\n  \\hline`).join('\n');
    return tpl(`\\begin{center}\n\\begin{tabular}{|${'c|'.repeat(cols)}}\n  \\hline\n${body}\n\\end{tabular}\n\\end{center}\n`);
  },
};

// ---------- building the bar ----------
const ICONS = {
  left: '<path d="M2 3h12M2 6h8M2 9h12M2 12h8"/>', center: '<path d="M2 3h12M4 6h8M2 9h12M4 12h8"/>', right: '<path d="M2 3h12M6 6h8M2 9h12M6 12h8"/>', justify: '<path d="M2 3h12M2 6h12M2 9h12M2 12h12"/>',
  bullets: '<path d="M6 4h8M6 8h8M6 12h8"/><circle cx="3" cy="4" r=".9"/><circle cx="3" cy="8" r=".9"/><circle cx="3" cy="12" r=".9"/>', numbers: '<path d="M6 4h8M6 8h8M6 12h8"/><path d="M2 3l1-.6V6M2 7.5h2l-2 2.5h2.2M2 12h2l-1 1.5" stroke-width=".8"/>',
  indent: '<path d="M2 3h12M7 6.5h7M7 9.5h7M2 13h12M2 6l3 1.5L2 9z"/>', columns: '<path d="M2 3h5M2 6h5M2 9h5M2 12h5M9 3h5M9 6h5M9 9h5M9 12h5"/>',
};
const svg = (n) => `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round">${ICONS[n]}</svg>`;
const el = (tag, props = {}, html = '') => Object.assign(document.createElement(tag), props, html ? { innerHTML: html } : {});
const sep = () => el('span', { className: 'sep' });
// buttons must not steal focus/selection from the editor
const keepFocus = (b) => { b.addEventListener('mousedown', (e) => e.preventDefault()); return b; };
const btn = (html, title, fn, cls = '') => { const b = keepFocus(el('button', { title, className: cls, type: 'button' }, html)); b.setAttribute('aria-label', title); b.onclick = () => { fn(); }; return b; };
const sel = (id, title, first, options, fn) => {
  const s = el('select', { id, title }); s.setAttribute('aria-label', title);
  s.append(el('option', { value: '', textContent: first }), ...options.map(([label, val]) => el('option', { value: val, textContent: label })));
  s.onchange = () => { const v = s.value; if (v !== '') fn(v); s.value = ''; ed.view.focus(); };
  return s;
};
function menuButton(html, title, cls, build) {
  const b = keepFocus(el('button', { title, className: 'menubtn ' + cls, type: 'button' }, html)); b.setAttribute('aria-haspopup', 'true'); b.setAttribute('aria-expanded', 'false');
  const panel = el('div', { className: 'menu fmt-menu', hidden: true }); document.body.append(panel);
  const dd = dropdown(b, panel, { onOpen: () => build(panel, () => dd.close()) });
  return b;
}
const item = (panel, close, label, hint, fn) => { const b = el('button', { className: 'menu-item', type: 'button' }, `<span>${label}</span>${hint ? `<small>${hint}</small>` : ''}`); b.onclick = () => { close(); Promise.resolve(fn()).finally(() => ed.view.focus()); }; panel.append(b); };

const styleSel = el('select', { id: 'fmtStyle', title: 'Paragraph style (Ctrl+Alt+0…3)' }); styleSel.setAttribute('aria-label', 'Paragraph style');
STYLES.forEach(([l, v]) => styleSel.append(el('option', { value: v, textContent: l })));
styleSel.onchange = () => { actions.heading(styleSel.value); };

const fontSel = sel('fmtFont', 'Font family', 'Font', FONTS.map(([l, v]) => [l, v]), actions.font);
const sizeSel = sel('fmtSize', 'Font size (pt values assume a 10pt document)', 'Size', [...SIZES.map(([l, v, pt]) => [`${l} (${pt})`, v]), ['Custom…', '__custom']], (v) => (v === '__custom' ? actions.customSize() : actions.size(v)));
const spaceSel = sel('fmtSpace', 'Line spacing for the following paragraphs', 'Spacing', SPACING, actions.spacing);

const colorBtn = menuButton('<span class="fmt-A">A</span>', 'Text colour', 'color', (panel, close) => {
  panel.innerHTML = ''; const g = el('div', { className: 'swatches' });
  COLORS.forEach(([l, c]) => { const s = el('button', { className: 'swatch', title: l, type: 'button' }); s.style.background = c === 'green!50!black' ? '#007f00' : c === 'violet' ? '#800080' : c === 'orange' ? '#ff8000' : c === 'brown' ? '#bf8040' : c; s.onclick = () => { close(); actions.color(c); ed.view.focus(); }; g.append(s); });
  panel.append(g); item(panel, close, 'Custom colour…', '', actions.customColor);
});
const insertBtn = menuButton('Insert ▾', 'Insert link, image, equation, footnote…', 'ins', (panel, close) => {
  panel.innerHTML = '';
  [['Link', 'href', actions.link], ['Image', 'figure', actions.image], ['Footnote', '', actions.footnote], ['Citation', '\\cite', actions.cite], ['Cross-reference', '\\ref', actions.ref], ['Label', '\\label', actions.label], null,
    ['Equation (numbered)', '', actions.equation], ['Display math', '\\[ \\]', actions.display], null,
    ['Quote block', '', actions.quote], ['Code block', 'verbatim', actions.code], ['Abstract', '', actions.abstract], ['Two columns', 'multicol', actions.columns], null,
    ['Title block', '\\maketitle', actions.titleBlock], ['Table of contents', '', actions.toc], ['Page break', '', actions.pagebreak], ['Horizontal rule', '', actions.rule]]
    .forEach((it) => (it ? item(panel, close, it[0], it[1], it[2]) : panel.append(el('hr'))));
});
const tableBtn = menuButton('▦ Table ▾', 'Insert a table', 'tbl', (panel, close) => {
  panel.innerHTML = ''; const N = 8; const label = el('div', { className: 'menu-h', textContent: 'Insert table' }); const grid = el('div', { className: 'tgrid' });
  const cells = []; for (let r = 1; r <= N; r++) for (let c = 1; c <= N; c++) { const x = el('button', { type: 'button', className: 'tcell' }); x.dataset.r = r; x.dataset.c = c; cells.push(x); grid.append(x); }
  const paint = (r, c) => { cells.forEach((x) => x.classList.toggle('on', +x.dataset.r <= r && +x.dataset.c <= c)); label.textContent = r ? `${r} × ${c}` : 'Insert table'; };
  grid.onmouseover = (e) => { const x = e.target.closest('.tcell'); if (x) paint(+x.dataset.r, +x.dataset.c); };
  grid.onmouseleave = () => paint(0, 0);
  grid.onclick = (e) => { const x = e.target.closest('.tcell'); if (x) { close(); actions.table(+x.dataset.r, +x.dataset.c); ed.view.focus(); } };
  panel.append(label, grid);
});

// the pill in the main toolbar swaps the whole toolbar for this one; the pill on its left swaps back
const pane = $('editorPane'), pill = $('fmtPill');
function setOpen(open, focus = true) {
  pane.classList.toggle('fmt-open', open); pill.setAttribute('aria-expanded', String(open));
  (open ? bar : $('editorTools')).prepend($('modeSwitch'));   // the Code/Visual switch stays visible in both toolbars
  if (prefs.fmtOpen !== open) { prefs.fmtOpen = open; savePrefs(); }
  if (focus) ed.view.focus();
}
pill.onclick = () => setOpen(true);
const back = btn('<span class="aa">Aa</span> Format <span class="x">✕</span>', 'Close formatting and show the main toolbar', () => setOpen(false), 'pill');
bar.addEventListener('wheel', (e) => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { bar.scrollLeft += e.deltaY; e.preventDefault(); } }, { passive: false });

bar.append(
  back, styleSel, fontSel, sizeSel, sep(),
  btn('<b>B</b>', 'Bold (Ctrl+B)', actions.bold), btn('<i>I</i>', 'Italic (Ctrl+I)', actions.italic), btn('<u>U</u>', 'Underline (Ctrl+U)', actions.underline), btn('<s>S</s>', 'Strikethrough', actions.strike),
  btn('x<sup>2</sup>', 'Superscript', actions.sup), btn('x<sub>2</sub>', 'Subscript', actions.sub), btn('<code>tt</code>', 'Monospace', actions.mono), colorBtn, btn('<span class="fmt-hl">ab</span>', 'Highlight', actions.highlight), sep(),
  btn(svg('left'), 'Align left (Ctrl+Shift+L)', actions.left), btn(svg('center'), 'Centre (Ctrl+Shift+E)', actions.center), btn(svg('right'), 'Align right (Ctrl+Shift+R)', actions.right), btn(svg('justify'), 'Justify (Ctrl+Shift+J)', actions.justify), sep(),
  btn(svg('bullets'), 'Bulleted list (Ctrl+Shift+8)', actions.bullets), btn(svg('numbers'), 'Numbered list (Ctrl+Shift+7)', actions.numbers), btn(svg('indent'), 'Block quote / indent', actions.indent), btn(svg('columns'), 'Two columns', actions.columns), spaceSel, sep(),
  tableBtn, insertBtn,
);

setOpen(!!prefs.fmtOpen, false);

// ---------- keep the style box in sync with the line under the caret ----------
bus.on('cursor', () => { try { styleSel.value = ed.headingAt(ed.view.state); } catch {} });

// ---------- shortcuts (captured before CodeMirror so they win over its defaults, e.g. Ctrl+U) ----------
const KEYS = [
  [{ code: 'KeyU' }, actions.underline],
  [{ code: 'KeyE', shift: true }, actions.center], [{ code: 'KeyL', shift: true }, actions.left], [{ code: 'KeyR', shift: true }, actions.right], [{ code: 'KeyJ', shift: true }, actions.justify],
  [{ code: 'Digit7', shift: true }, actions.numbers], [{ code: 'Digit8', shift: true }, actions.bullets],
  [{ code: 'Digit0', alt: true }, () => actions.heading('')], [{ code: 'Digit1', alt: true }, () => actions.heading('section')], [{ code: 'Digit2', alt: true }, () => actions.heading('subsection')], [{ code: 'Digit3', alt: true }, () => actions.heading('subsubsection')],
];
ed.view.dom.addEventListener('keydown', (e) => {
  if (!S.current) return;
  const mod = e.ctrlKey || e.metaKey;
  // Tab: next template box; from the last box (or any spot right before a closing brace) step out of the group
  if (e.key === 'Tab' && !mod && !e.shiftKey && !e.altKey && !e.isComposing && completionStatus(ed.view.state) !== 'active') {
    const v = ed.view, h = v.state.selection.main;
    if (nextSnippetField(v)) { e.preventDefault(); e.stopPropagation(); return; }
    if (h.empty && /^[}\])]/.test(v.state.sliceDoc(h.head, h.head + 1))) { v.dispatch({ selection: { anchor: h.head + 1 }, scrollIntoView: true }); e.preventDefault(); e.stopPropagation(); return; }
  }
  if (mod) {
    const k = KEYS.find(([c]) => c.code === e.code && !!c.shift === e.shiftKey && !!c.alt === e.altKey);
    if (k) { e.preventDefault(); e.stopPropagation(); k[1](); return; }
  }
  // Enter inside a list starts the next \item; Enter on an empty \item ends the list item
  if (e.key === 'Enter' && !mod && !e.shiftKey && !e.altKey && !e.isComposing) {
    const v = ed.view, s = v.state.selection.main; if (!s.empty) return;
    const line = v.state.doc.lineAt(s.head), m = /^(\s*)\\item(?:\s+(.*))?$/.exec(line.text);
    if (!m || s.head !== line.to) return;
    e.preventDefault(); e.stopPropagation();
    if (!m[2] || !m[2].trim()) v.dispatch({ changes: { from: line.from, to: line.to, insert: m[1] }, selection: { anchor: line.from + m[1].length }, userEvent: 'delete' });
    else { const ins = `\n${m[1]}\\item `; v.dispatch({ changes: { from: s.head, insert: ins }, selection: { anchor: s.head + ins.length }, userEvent: 'input' }); }
  }
}, true);
