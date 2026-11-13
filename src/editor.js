// CodeMirror 6 editor: LaTeX language support, folding, linting, auto-\end, Mathematica-style template insertion.
import { EditorState, EditorSelection, Annotation, Compartment, Prec } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, dropCursor } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab, undo, redo } from '@codemirror/commands';
import { StreamLanguage, syntaxHighlighting, defaultHighlightStyle, bracketMatching, foldGutter, foldService, foldKeymap, foldAll, unfoldAll, indentUnit } from '@codemirror/language';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { search, searchKeymap, highlightSelectionMatches, openSearchPanel } from '@codemirror/search';
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, snippet, clearSnippet } from '@codemirror/autocomplete';
import { lintGutter, setDiagnostics } from '@codemirror/lint';
import { oneDark } from '@codemirror/theme-one-dark';
import { S, bus, prefs, flatFiles, IMG_EXT } from './state.js';
import * as collab from './collab.js';
import { ySyncAnnotation } from 'y-codemirror.next';
import { visualExtension, isVisualPath } from './visual.js';

export const External = Annotation.define();       // transactions that come from disk, not from typing

// ---------- BibTeX (tiny stream mode) ----------
const bib = StreamLanguage.define({
  token(stream) {
    if (stream.eatSpace()) return null;
    if (stream.peek() === '%') { stream.skipToEnd(); return 'comment'; }
    if (stream.match(/@\w+/)) return 'keyword';
    if (stream.match(/[\w\-:.\/]+(?=\s*=)/)) return 'propertyName';
    if (stream.match(/"[^"]*"/) || stream.match(/\{[^{}]*\}/)) return 'string';
    if (stream.match(/\d+/)) return 'number';
    stream.next(); return null;
  },
});
const langFor = (path) => (/\.bib$/i.test(path) ? bib : /\.(tex|sty|cls|def|clo|cfg|dtx|ins|ltx|tikz|pgf|bbl|bst)$/i.test(path) ? StreamLanguage.define(stex) : []);

// ---------- math context detection ----------
const MATH_ENVS = 'equation|align|gather|multline|eqnarray|displaymath|math|flalign|alignat|split|cases|aligned|gathered';
export function inMath(state, pos) {
  const from = Math.max(0, pos - 4000);
  let text = state.doc.sliceString(from, pos);
  const para = text.lastIndexOf('\n\n');
  if (para >= 0) text = text.slice(para + 2);
  const re = new RegExp(String.raw`(\\\\)|(\\[$%&_#{}])|(%[^\n]*)|(\$\$)|(\$)|(\\\()|(\\\))|(\\\[)|(\\\])|\\begin\{(?:${MATH_ENVS})\*?\}|\\end\{(?:${MATH_ENVS})\*?\}`, 'g');
  let inline = false, display = false, paren = false, bracket = false, env = 0, m;
  while ((m = re.exec(text))) {
    if (m[1] || m[2] || m[3]) continue;
    if (m[4]) display = !display; else if (m[5]) { if (!display) inline = !inline; }
    else if (m[6]) paren = true; else if (m[7]) paren = false; else if (m[8]) bracket = true; else if (m[9]) bracket = false;
    else if (m[0].startsWith('\\begin')) env++; else env = Math.max(0, env - 1);
  }
  return inline || display || paren || bracket || env > 0;
}

// ---------- completion ----------
const COMMANDS = 'section subsection subsubsection paragraph chapter part textbf textit texttt textsf textrm textsc emph underline cite citep citet ref eqref autoref label input include includegraphics usepackage documentclass begin end caption footnote frac dfrac sqrt sum int oint partial nabla infty alpha beta gamma delta epsilon varepsilon zeta eta theta lambda mu nu xi pi rho sigma tau phi varphi chi psi omega Gamma Delta Theta Lambda Xi Pi Sigma Phi Psi Omega mathrm mathbf mathcal mathbb mathfrak mathsf mathtt boldsymbol newcommand renewcommand DeclareMathOperator bibliography bibliographystyle tableofcontents maketitle title author date item hline centering newpage clearpage vspace hspace url href text left right cdot times infty langle rangle hbar bar hat vec dot ddot tilde widehat overline underline overbrace underbrace newtheorem setlength geometry tikz draw node'.split(' ');
const ENVS = ['document', 'equation', 'equation*', 'align', 'align*', 'gather', 'multline', 'figure', 'table', 'tabular', 'itemize', 'enumerate', 'description', 'abstract', 'verbatim', 'center', 'minipage', 'tikzpicture', 'theorem', 'lemma', 'proof', 'cases', 'matrix', 'pmatrix', 'bmatrix', 'vmatrix', 'array', 'lstlisting', 'frame', 'subequations', 'split', 'thebibliography'];
const PACKAGES = 'amsmath amssymb amsthm mathtools graphicx hyperref geometry xcolor tikz pgfplots booktabs array longtable multirow subcaption caption float listings minted siunitx natbib cleveref enumitem fancyhdr setspace microtype babel inputenc fontenc lmodern times physics cancel bm braket algorithm2e algorithmicx todonotes appendix titlesec etoolbox xspace url csquotes'.split(' ');
let extraCommands = [];
export const setExtraCommands = (list) => { extraCommands = list; };

const scan = (re) => { const out = new Set(); for (const t of S.cache.values()) for (const m of t.matchAll(re)) out.add(m[1]); return [...out]; };
function latexComplete(ctx) {
  const before = ctx.state.sliceDoc(Math.max(0, ctx.pos - 100), ctx.pos);
  let m;
  const opt = (arr, type) => arr.map((label) => ({ label, type }));
  if ((m = /\\(?:ref|eqref|autoref|cref|Cref|pageref|nameref)\{([^}]*)$/.exec(before))) return { from: ctx.pos - m[1].length, options: opt(scan(/\\label\{([^}]+)\}/g), 'variable') };
  if ((m = /\\(?:no)?cite[a-zA-Z]*(?:\[[^\]]*\])*\{(?:[^}]*,)?\s*([^},]*)$/.exec(before))) return { from: ctx.pos - m[1].length, options: opt(scan(/@\w+\s*\{\s*([^,\s]+)\s*,/g), 'constant') };
  if ((m = /\\(?:begin|end)\{([^}]*)$/.exec(before))) return { from: ctx.pos - m[1].length, options: opt([...new Set([...ENVS, ...scan(/\\newenvironment\{([^}]+)\}/g)])], 'keyword') };
  if ((m = /\\usepackage(?:\[[^\]]*\])?\{(?:[^}]*,)?([^},]*)$/.exec(before))) return { from: ctx.pos - m[1].length, options: opt(PACKAGES, 'class') };
  if ((m = /\\(?:input|include|subfile)\{([^}]*)$/.exec(before))) return { from: ctx.pos - m[1].length, options: opt([...S.cache.keys()].filter((p) => p.endsWith('.tex')).map((p) => p.replace(/\.tex$/, '')), 'file') };
  if ((m = /\\includegraphics(?:\[[^\]]*\])?\{([^}]*)$/.exec(before))) return { from: ctx.pos - m[1].length, options: opt(flatFiles().filter((p) => IMG_EXT.test(p) || /\.pdf$/i.test(p)), 'file') };
  if ((m = /\\bibliography\{([^}]*)$/.exec(before))) return { from: ctx.pos - m[1].length, options: opt(flatFiles().filter((p) => p.endsWith('.bib')).map((p) => p.replace(/\.bib$/, '')), 'file') };
  if ((m = /\\([A-Za-z]*)$/.exec(before))) {
    const mine = scan(/\\(?:re)?newcommand\*?\{?\\([A-Za-z]+)\}?/g).concat(scan(/\\(?:DeclareMathOperator|def)\*?\{?\\([A-Za-z]+)\}?/g));
    return { from: ctx.pos - m[1].length, options: opt([...new Set([...mine, ...COMMANDS, ...extraCommands])], 'function'), validFor: /^[A-Za-z]*$/ };
  }
  return null;
}

// ---------- folding ----------
const SECTIONS = ['part', 'chapter', 'section', 'subsection', 'subsubsection', 'paragraph'];
const texFold = foldService.of((state, from) => {
  const line = state.doc.lineAt(from);
  let m = /\\begin\{([^}]+)\}/.exec(line.text);
  if (m && !/\\end\{/.test(line.text.slice(m.index))) {
    const open = `\\begin{${m[1]}}`, close = `\\end{${m[1]}}`;
    let depth = 0;
    for (let n = line.number; n <= state.doc.lines && n < line.number + 2000; n++) {
      const t = state.doc.line(n).text;
      depth += t.split(open).length - 1; depth -= t.split(close).length - 1;
      if (depth <= 0) return n > line.number ? { from: line.to, to: state.doc.line(n - 1).to >= line.to ? state.doc.line(n - 1).to : line.to } : null;
    }
  }
  m = /^\s*\\(part|chapter|section|subsection|subsubsection)\*?\s*[\[{]/.exec(line.text);
  if (m) {
    const lvl = SECTIONS.indexOf(m[1]);
    let last = line.number;
    for (let n = line.number + 1; n <= state.doc.lines; n++) {
      const t = state.doc.line(n).text;
      const h = /^\s*\\(part|chapter|section|subsection|subsubsection)\*?\s*[\[{]/.exec(t);
      if ((h && SECTIONS.indexOf(h[1]) <= lvl) || /\\end\{document\}|\\bibliography\{|\\appendix/.test(t)) break;
      last = n;
    }
    while (last > line.number && !state.doc.line(last).text.trim()) last--;
    return last > line.number ? { from: line.to, to: state.doc.line(last).to } : null;
  }
  return null;
});

// ---------- editor commands ----------
function wrapSelection(v, before, after) {
  v.dispatch(v.state.changeByRange((r) => {
    const sel = v.state.sliceDoc(r.from, r.to);
    return { changes: { from: r.from, to: r.to, insert: before + sel + after }, range: EditorSelection.range(r.from + before.length, r.from + before.length + sel.length) };
  }));
  v.focus();
  return true;
}
export const cmdBold = (v) => wrapSelection(v, inMath(v.state, v.state.selection.main.from) ? '\\mathbf{' : '\\textbf{', '}');
export const cmdItalic = (v) => wrapSelection(v, inMath(v.state, v.state.selection.main.from) ? '\\mathit{' : '\\textit{', '}');
export const cmdUnderline = (v) => wrapSelection(v, '\\underline{', '}');
export const cmdInlineMath = (v) => wrapSelection(v, '$', '$');
export function cmdToggleComment(v) {
  const { state } = v; const lines = new Set();
  for (const r of state.selection.ranges) for (let n = state.doc.lineAt(r.from).number; n <= state.doc.lineAt(r.to).number; n++) lines.add(n);
  const ls = [...lines].map((n) => state.doc.line(n));
  const allCommented = ls.every((l) => !l.text.trim() || /^\s*%/.test(l.text));
  const changes = [];
  for (const l of ls) {
    if (!l.text.trim()) continue;
    if (allCommented) { const m = /^(\s*)%\s?/.exec(l.text); changes.push({ from: l.from + m[1].length, to: l.from + m[0].length }); }
    else { const ind = /^\s*/.exec(l.text)[0].length; changes.push({ from: l.from + ind, insert: '% ' }); }
  }
  v.dispatch({ changes });
  return true;
}

// Typing `\begin{name}` completes the matching `\end{name}` (like Overleaf).
const autoEnd = EditorView.inputHandler.of((v, from, to, text) => {
  if (text !== '}') return false;
  const line = v.state.doc.lineAt(from);
  const before = line.text.slice(0, from - line.from);
  const m = /\\begin\{([A-Za-z@]+\*?)$/.exec(before);
  if (!m) return false;
  let after = line.text.slice(to - line.from);
  let end = to;
  if (after.startsWith('}')) { after = after.slice(1); end = to + 1; }   // brace auto-inserted by closeBrackets
  if (after.trim()) return false;
  for (let n = line.number + 1; n <= Math.min(v.state.doc.lines, line.number + 3); n++) if (v.state.doc.line(n).text.includes(`\\end{${m[1]}}`)) return false;
  const indent = /^\s*/.exec(line.text)[0];
  const unit = v.state.facet(indentUnit);
  const ins = `}\n${indent}${unit}\n${indent}\\end{${m[1]}}`;
  v.dispatch({ changes: { from, to: end, insert: ins }, selection: { anchor: from + 2 + indent.length + unit.length }, userEvent: 'input.complete', scrollIntoView: true });
  return true;
});

// ---------- compartments / state factory ----------
const comp = { theme: new Compartment(), wrap: new Compartment(), spell: new Compartment(), fold: new Compartment(), ro: new Compartment(), visual: new Compartment() };
// Visual Editor (formatted view of .tex files); the document stays LaTeX
const visualExt = (path) => (prefs.visual && isVisualPath(path) ? visualExtension : []);
// Viewers of a shared project get a read-only editor
const roExt = () => (S.role === 'view' ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []);
export const isDark = () => document.documentElement.dataset.theme === 'dark';
const themeExt = () => (isDark() ? oneDark : syntaxHighlighting(defaultHighlightStyle, { fallback: true }));
const wrapExt = () => (prefs.wrap ? EditorView.lineWrapping : []);
const spellExt = () => EditorView.contentAttributes.of({ spellcheck: prefs.spellcheck ? 'true' : 'false', autocapitalize: 'off', autocorrect: 'off' });
const foldExt = () => (prefs.fold ? foldGutter() : []);

const baseTheme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'var(--editor-bg)', color: 'var(--text)' },
  '.cm-scroller': { fontFamily: 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace', lineHeight: '1.55' },
  '.cm-gutters': { backgroundColor: 'var(--gutter-bg)', color: 'var(--muted)', border: 'none' },
  '.cm-activeLine': { backgroundColor: 'var(--active-line)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--active-line)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-content': { caretColor: 'var(--text)' },
  '.cm-panels': { backgroundColor: 'var(--panel)', color: 'var(--text)', borderColor: 'var(--border)' },
  '.cm-foldPlaceholder': { backgroundColor: 'var(--accent-soft)', border: '1px solid var(--accent)', color: 'var(--accent)', padding: '0 6px', borderRadius: '4px' },
});

const emit = EditorView.updateListener.of((u) => {
  if (u.docChanged && !u.transactions.some((tr) => tr.annotation(External))) {
    const p = S.current;
    // remote: the change came from someone else through the shared document
    const remote = u.transactions.some((tr) => tr.annotation(ySyncAnnotation));
    if (p) { if (!S.collab.has(p)) S.dirty.add(p); S.cache.set(p, u.state.doc.toString()); bus.emit('edit', { path: p, remote, collab: S.collab.has(p) }); }
  }
  if (u.selectionSet || u.docChanged) {
    const h = u.state.selection.main; const l = u.state.doc.lineAt(h.head);
    bus.emit('cursor', { line: l.number, col: h.head - l.from + 1, sel: Math.abs(h.to - h.from), math: inMath(u.state, h.head) });
  }
});

const keys = [
  { key: 'Mod-Enter', run: () => (bus.emit('compile-request', { force: true }), true) },
  { key: 'Mod-s', run: () => (bus.emit('save-request', { compile: true }), true) },
  { key: 'Mod-b', run: cmdBold }, { key: 'Mod-i', run: cmdItalic }, { key: 'Mod-u', run: cmdUnderline },
  { key: 'Mod-/', run: cmdToggleComment },
  { key: 'Mod-Shift-m', run: cmdInlineMath },
  { key: 'Mod-Alt-j', run: (v) => (bus.emit('forward-sync', null), true) },
  { key: 'Alt-s', run: () => (bus.emit('toggle-palette'), true) },
  { key: 'Mod-Shift-[', run: foldAll }, { key: 'Mod-Shift-]', run: unfoldAll },
  { key: 'Escape', run: (v) => { clearSnippet(v); return false; } },
];

// opts.collab: the Yjs binding (co-editing); it brings its own undo history
export function mkState(doc, path, opts = {}) {
  return EditorState.create({
    doc,
    extensions: [
      lineNumbers(), highlightActiveLineGutter(), highlightActiveLine(), drawSelection(), dropCursor(), opts.collab ? [] : history(), bracketMatching(),
      closeBrackets(), highlightSelectionMatches(), search({ top: true }), texFold, lintGutter(), indentUnit.of('  '),
      EditorState.languageData.of(() => [{ closeBrackets: { brackets: ['(', '[', '{', '$'] } }]),
      langFor(path), baseTheme,
      comp.theme.of(themeExt()), comp.wrap.of(wrapExt()), comp.spell.of(spellExt()), comp.fold.of(foldExt()), comp.ro.of(roExt()), comp.visual.of(visualExt(path)),
      autocompletion({ override: [latexComplete], icons: false }),
      Prec.high(autoEnd),
      emit,
      opts.collab || [],
      keymap.of([...keys, ...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...(opts.collab ? [] : historyKeymap), ...foldKeymap, ...completionKeymap, indentWithTab]),
    ],
  });
}

export const view = new EditorView({ parent: document.getElementById('editorHost'), state: mkState('', 'x.tex') });
export const doUndo = () => { if (!(S.collab.has(S.current) && collab.undo(S.current))) undo(view); view.focus(); };
export const doRedo = () => { if (!(S.collab.has(S.current) && collab.redo(S.current))) redo(view); view.focus(); };
export const doFind = () => { openSearchPanel(view); };

// Re-apply preferences that live in compartments (theme, wrapping, spellcheck, folding, font size)
export function applyPrefs() {
  document.getElementById('editorHost').style.setProperty('--cm-font', prefs.fontSize + 'px');
  view.dispatch({ effects: [comp.theme.reconfigure(themeExt()), comp.wrap.reconfigure(wrapExt()), comp.spell.reconfigure(spellExt()), comp.fold.reconfigure(foldExt()), comp.ro.reconfigure(roExt()), comp.visual.reconfigure(visualExt(S.current))] });
}
export function setViewState(state) { view.setState(state); applyPrefs(); setDiagnosticsForCurrent(); }

// ---------- diagnostics from compile issues ----------
export function setDiagnosticsForCurrent() {
  const p = S.current; if (!p) return;
  const doc = view.state.doc; const diags = [];
  for (const i of S.issues) {
    if (i.file !== p || !i.line || i.line < 1 || i.line > doc.lines || i.type === 'badbox') continue;
    const l = doc.line(i.line); const first = /\S/.exec(l.text);
    diags.push({ from: l.from + (first ? first.index : 0), to: Math.max(l.to, l.from + (first ? first.index : 0) + 1), severity: i.type === 'error' ? 'error' : 'warning', message: i.message + (i.hint ? '\n💡 ' + i.hint : ''), source: 'LaTeX' });
  }
  view.dispatch(setDiagnostics(view.state, diags));
}

export function gotoPosition(line, col = 0, len = 0) {
  const doc = view.state.doc; const l = doc.line(Math.min(Math.max(1, line), doc.lines));
  const from = Math.min(l.to, l.from + Math.max(0, col));
  view.dispatch({ selection: { anchor: from, head: Math.min(l.to, from + len) }, effects: EditorView.scrollIntoView(from, { y: 'center' }) });
  view.focus();
}

// Replace the whole document with text from disk, keeping caret and scroll (not marked dirty).
export function replaceDocExternal(text) {
  const cur = view.state.doc.toString(); if (cur === text) return;
  // minimal diff window so that cursor/folds survive
  let a = 0; const max = Math.min(cur.length, text.length);
  while (a < max && cur[a] === text[a]) a++;
  let b = 0; while (b < max - a && cur[cur.length - 1 - b] === text[text.length - 1 - b]) b++;
  view.dispatch({ changes: { from: a, to: cur.length - b, insert: text.slice(a, text.length - b) }, annotations: [External.of(true)] });
}

// ---------- Mathematica-style insertion ----------
// A template contains blank boxes written as #{1} #{2} … (same number = mirrored). The caret lands in box 1,
// typing fills it, Tab jumps to the next box, Esc leaves. If text was selected it moves into box 1.
const protect = (t) => t.replace(/\\([{}])/g, '\\\\$1');      // LaTeX \{ \} must survive snippet un-escaping

export function insertTemplate(tpl, { mode = 'math', pkg = '' } = {}) {
  const v = view;
  if (!S.current) return false;
  const sel = v.state.selection.main;
  const selected = v.state.sliceDoc(sel.from, sel.to);
  let t = tpl;
  if (mode === 'math' && !inMath(v.state, sel.from)) t = '$' + t + '$';
  const hasBox = /#\{1\}/.test(t);
  snippet(protect(t))(v, null, sel.from, sel.to);
  if (selected && hasBox) {
    const pos = v.state.selection.main.from;
    v.dispatch({ changes: { from: pos, insert: selected }, selection: { anchor: pos + selected.length } });
  }
  v.focus();
  bus.emit('inserted', { pkg });
  return true;
}

// ---------- Google-Docs-style formatting ----------
// Each helper either wraps the selection or drops in a blank box, so whatever is typed next gets the format.
export function formatInline(before, after, { pkg = '' } = {}) {
  const v = view; if (!S.current) return false;
  const sel = v.state.selection.main;
  if (sel.empty) return insertTemplate(before + '#{1}' + after, { mode: 'text', pkg });
  wrapSelection(v, before, after); bus.emit('inserted', { pkg }); return true;
}
// Block environments (center, itemize…): start on a fresh line; wrap whole selected lines, else open a blank body.
export function formatBlock(begin, end, { pkg = '', body = '', perLine = null } = {}) {
  const v = view; if (!S.current) return false;
  const sel = v.state.selection.main, doc = v.state.doc;
  if (!sel.empty) {
    const a = doc.lineAt(sel.from), b = doc.lineAt(sel.to); const text = doc.sliceString(a.from, b.to);
    const ins = begin + '\n' + (perLine ? text.split('\n').map(perLine).join('\n') : text) + '\n' + end;
    v.dispatch({ changes: { from: a.from, to: b.to, insert: ins }, selection: { anchor: a.from + ins.length }, userEvent: 'input' });
    v.focus(); bus.emit('inserted', { pkg }); return true;
  }
  const line = doc.lineAt(sel.from); const lead = line.text.slice(0, sel.from - line.from).trim() ? '\n' : '';
  return insertTemplate(lead + begin + '\n  ' + (body || '#{1}') + '\n' + end + '\n', { mode: 'text', pkg });
}
const HEADING = /^(\s*)\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)(\*?)\{(.*)\}\s*$/;
export function headingAt(state, pos = state.selection.main.head) { const m = HEADING.exec(state.doc.lineAt(pos).text); return m ? m[2] : ''; }
// Paragraph style: turns the current line into \section{…} etc., swaps an existing heading, or '' turns it back into text.
export function formatHeading(cmd) {
  const v = view; if (!S.current) return false;
  const line = v.state.doc.lineAt(v.state.selection.main.head), m = HEADING.exec(line.text);
  const put = (text) => { v.dispatch({ changes: { from: line.from, to: line.to, insert: text }, selection: { anchor: line.from + text.length }, userEvent: 'input' }); v.focus(); return true; };
  if (m) return put(cmd ? `${m[1]}\\${cmd}${m[3]}{${m[4]}}` : `${m[1]}${m[4]}`);
  if (!cmd) { v.focus(); return true; }
  const t = line.text.trim();
  if (t && !/^[\\%]/.test(t)) return put(`\\${cmd}{${t}}`);
  return insertTemplate(`\\${cmd}{#{1}}`, { mode: 'text' });
}

export function insertSymbol(sym) {
  const v = view; if (!S.current) return false;
  let text = sym.i;
  if (text.includes('‸')) { let n = 0; text = text.replace(/‸/g, () => `#{${++n}}`); return insertTemplate(text, { mode: sym.m === 'math' ? 'math' : 'text', pkg: sym.pkg }); }
  const sel = v.state.selection.main;
  if (sym.m === 'math' && !inMath(v.state, sel.from)) text = '$' + text + '$';
  v.dispatch({ changes: { from: sel.from, to: sel.to, insert: text }, selection: { anchor: sel.from + text.length }, userEvent: 'input' });
  v.focus();
  bus.emit('inserted', { pkg: sym.pkg });
  return true;
}
