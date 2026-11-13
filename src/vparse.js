// LaTeX → "visual items" for the Visual Editor. Pure functions (no DOM), so they can be tested in Node.
// An item describes a piece of source that the editor shows differently: a heading, bold text, a formula,
// a figure… Positions are offsets into the text; the source itself is never changed.

export const HEAD = { part: 0, chapter: 1, section: 2, subsection: 3, subsubsection: 4, paragraph: 5, subparagraph: 5 };
const FMT = {
  textbf: 'b', textit: 'i', emph: 'i', textsl: 'i', underline: 'u', uline: 'u', underbar: 'u', texttt: 'tt', textsc: 'sc', textsf: 'sf',
  textrm: 'rm', textmd: 'rm', textup: 'rm', textnormal: 'rm', sout: 's', st: 's', hl: 'hl', textsuperscript: 'sup', textsubscript: 'sub',
  footnote: 'fn', caption: 'cap', subcaption: 'cap', title: 'title', author: 'author', date: 'date', mbox: 'rm', text: 'rm', enquote: 'q',
  textcolor: 'color', colorbox: 'hl', href: 'link',
};
const SYM = {
  '%': '%', '&': '&', '_': '_', '#': '#', $: '$', '{': '{', '}': '}', ',': '\u2009', ' ': ' ', '@': '', '/': '',
  ldots: '…', dots: '…', textellipsis: '…', textbackslash: '\\', LaTeX: 'LaTeX', TeX: 'TeX', LaTeXe: 'LaTeX2ε', textendash: '–', textemdash: '—',
  S: '§', P: '¶', copyright: '©', textdegree: '°', textregistered: '®', texttrademark: '™', textbar: '|', textless: '<', textgreater: '>',
  ss: 'ß', ae: 'æ', AE: 'Æ', oe: 'œ', OE: 'Œ', o: 'ø', O: 'Ø', aa: 'å', AA: 'Å', l: 'ł', L: 'Ł', i: 'ı', quad: '\u2003', qquad: '\u2003\u2003',
  textasciitilde: '~', textasciicircum: '^', textunderscore: '_', euro: '€', pounds: '£', checkmark: '✓', ding: '',
};
// accents: \'e → é etc.
const ACCENT = { "'": '\u0301', '`': '\u0300', '^': '\u0302', '"': '\u0308', '~': '\u0303', '=': '\u0304', '.': '\u0307', u: '\u0306', v: '\u030C', H: '\u030B', c: '\u0327', k: '\u0328', r: '\u030A' };
export const MATH_ENV = /^(equation|align|gather|multline|eqnarray|displaymath|math|flalign|alignat|dmath|dgroup)\*?$/;
const LIST_ENV = /^(itemize|enumerate|description|compactitem|compactenum|inparaenum|tasks)$/;
const VERB_ENV = /^(verbatim|Verbatim|BVerbatim|lstlisting|minted|comment|tikzpicture|forest|filecontents|pgfpicture|circuitikz|feynman|alltt)\*?$/;
const CODE_ENV = /^(tabular|tabularx|tabulary|longtable|xltabular|tblr|longtblr|array|NiceTabular)\*?$/;
const FLOAT_ENV = /^(figure|table|algorithm|wrapfigure|wraptable|subfigure|subtable|sidewaysfigure|sidewaystable|listing|marginfigure|margintable)\*?$/;
const ALIGN_ENV = { center: 'center', flushright: 'right', flushleft: 'left', quote: 'quote', quotation: 'quote', verse: 'quote', abstract: 'quote' };
const THM_ENV = /^(theorem|lemma|proposition|corollary|definition|remark|example|proof|note|claim|conjecture|exercise|solution|assumption|observation|notation|fact|problem|question|answer)\*?$/;
const HIDE_LINE_CMD = /^(centering|raggedright|raggedleft|noindent|indent|medskip|bigskip|smallskip|clearpage|newpage|cleardoublepage|pagebreak|linebreak|nopagebreak|par|vfill|hfill|FloatBarrier|protect|relax|null|leavevmode|phantomsection|justifying)$/;
const CITE = /^(no)?cite[a-zA-Z]*$|^(paren|text|foot|auto|super|full|smart)cites?$|^(Cite|Parencite|Textcite|Autocite)s?$/;
const REF = /^(ref|eqref|cref|Cref|autoref|Autoref|pageref|nameref|vref|Vref|cpageref|Cpageref|crefrange|Crefrange|labelcref|subref|figref|tabref|secref|eqnref)\*?$/;
const INCLUDE = /^(input|include|subfile|import|subimport|includefrom|subincludefrom|inputfrom|subinputfrom|InputIfFileExists)\*?$/;
const LABELS = { tableofcontents: 'Table of contents', listoffigures: 'List of figures', listoftables: 'List of tables', appendix: 'Appendix', printbibliography: 'Bibliography', bibliography: 'Bibliography', printindex: 'Index', maketitle: null, frontmatter: 'Front matter', mainmatter: 'Main matter', backmatter: 'Back matter' };

const isLetter = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 64;   // A-Z a-z @

// Index after the brace group starting at i (after optional spaces), or -1.
export function group(t, i, limit = 20000) {
  while (t[i] === ' ' || t[i] === '\t' || (t[i] === '\n' && t[i + 1] !== '\n')) i++;
  if (t[i] !== '{') return -1;
  let depth = 0; const end = Math.min(t.length, i + limit);
  for (let k = i; k < end; k++) {
    const c = t[k];
    if (c === '\\') { k++; continue; }
    if (c === '%') { const e = t.indexOf('\n', k); if (e < 0) return -1; k = e; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return k + 1;
  }
  return -1;
}
// Index after an optional [..] argument starting at i (after spaces), or i itself.
export function optArg(t, i) {
  let k = i; while (t[k] === ' ' || t[k] === '\t') k++;
  if (t[k] !== '[') return i;
  let depth = 0;
  for (let j = k; j < Math.min(t.length, k + 2000); j++) {
    const c = t[j];
    if (c === '\\') { j++; continue; }
    if (c === '{') depth++; else if (c === '}') depth--;
    else if (c === ']' && depth === 0) return j + 1;
    else if (c === '\n' && t[j + 1] === '\n') return i;
  }
  return i;
}
const groupStart = (t, i) => { while (t[i] !== '{') i++; return i; };
const lineStart = (t, i) => t.lastIndexOf('\n', i - 1) + 1;
const lineEnd = (t, i) => { const e = t.indexOf('\n', i); return e < 0 ? t.length : e; };
const blank = (s) => !/\S/.test(s);
// The construct [a,b) is alone on its line(s) (apart from whitespace)?
const aloneOnLine = (t, a, b) => blank(t.slice(lineStart(t, a), a)) && blank(t.slice(b, lineEnd(t, b)));

// Closing $ of inline math opened just before i (same paragraph), or -1.
function closeDollar(t, i) {
  for (let k = i, n = Math.min(t.length, i + 4000); k < n; k++) {
    const c = t[k];
    if (c === '\\') { k++; continue; }
    if (c === '$') return k === i ? -1 : k;
    if (c === '%') { const e = t.indexOf('\n', k); if (e < 0) return -1; k = e - 1; continue; }
    if (c === '\n' && /^[ \t]*\n/.test(t.slice(k + 1, k + 80))) return -1;
  }
  return -1;
}
function findEnd(t, name, from) {
  const re = new RegExp(String.raw`\\(begin|end)\s*\{${name.replace(/[*]/g, '\\*')}\}`, 'g'); re.lastIndex = from;
  let depth = 1, m;
  while ((m = re.exec(t))) {
    const ls = lineStart(t, m.index); if (/(^|[^\\])%/.test(t.slice(ls, m.index))) continue;   // commented out
    if (m[1] === 'begin') depth++; else if (--depth === 0) return { at: m.index, end: m.index + m[0].length };
  }
  return null;
}

// Where the body starts: the line after \begin{document} (if any).
export function preambleEnd(t) {
  const re = /\\begin\s*\{document\}/g; let m;
  while ((m = re.exec(t))) { const ls = lineStart(t, m.index); if (!/(^|[^\\])%/.test(t.slice(ls, m.index))) return lineEnd(t, m.index); }
  return -1;
}

// Plain-text version of a short LaTeX snippet (for titles, chips…)
export const plain = (s) => s
  .replace(/%[^\n]*/g, '').replace(/\\(?:label|index|footnote|thanks)\{[^{}]*\}/g, '')
  .replace(/\\(?:and|AND)\b/g, ' · ').replace(/\\\\(\[[^\]]*\])?/g, ' ').replace(/~/g, ' ')
  .replace(/\\[a-zA-Z@]+\*?(\[[^\]]*\])?/g, '').replace(/[{}$]/g, '').replace(/\s+/g, ' ').trim();

export function parse(t) {
  const items = [];
  let i = 0;
  const pe = preambleEnd(t);
  const meta = {};
  if (pe >= 0) {
    items.push({ k: 'pre', from: 0, to: pe, lines: t.slice(0, pe).split('\n').length });
    for (const key of ['title', 'author', 'date']) {
      const re = new RegExp(String.raw`\\${key}\s*(\[[^\]]*\])?\s*\{`, 'g'); let m;
      while ((m = re.exec(t.slice(0, pe)))) { const ls = lineStart(t, m.index); if (/(^|[^\\])%/.test(t.slice(ls, m.index))) continue; const e = group(t, m.index + m[0].length - 1); if (e > 0) meta[key] = t.slice(m.index + m[0].length, e - 1); }
    }
    i = pe;
  }
  const N = t.length;
  const env = [];                 // open environments: { name, kind, n }
  const sym = (from, to, s) => items.push({ k: 'sym', from, to, t: s });
  const hide = (from, to) => { const line = aloneOnLine(t, from, to); items.push(line ? { k: 'hide', from: lineStart(t, from), to: lineEnd(t, to), line: true } : { k: 'hide', from, to }); };
  const label = (from, to, s, cls = '') => { const line = aloneOnLine(t, from, to); items.push({ k: 'label', from: line ? lineStart(t, from) : from, to: line ? lineEnd(t, to) : to, t: s, cls, line }); };
  const listDepth = () => env.filter((e) => e.kind === 'list').length;

  while (i < N) {
    const c = t.charCodeAt(i);
    if (c === 37) { const e = lineEnd(t, i); items.push({ k: 'cm', from: i, to: e }); i = e; continue; }   // %
    if (c === 36) {                                                                                        // $
      if (t[i + 1] === '$') {
        const e = t.indexOf('$$', i + 2);
        if (e > 0) { items.push({ k: 'math', d: true, from: i, to: e + 2, sf: i + 2, st: e, src: t.slice(i + 2, e) }); i = e + 2; continue; }
        i += 2; continue;
      }
      const e = closeDollar(t, i + 1);
      if (e > 0) { items.push({ k: 'math', d: false, from: i, to: e + 1, sf: i + 1, st: e, src: t.slice(i + 1, e) }); i = e + 1; continue; }
      i++; continue;
    }
    if (c === 45 && t[i + 1] === '-') { if (t[i + 2] === '-') { sym(i, i + 3, '—'); i += 3; } else { sym(i, i + 2, '–'); i += 2; } continue; }
    if (c === 96) { if (t[i + 1] === '`') { sym(i, i + 2, '“'); i += 2; } else { sym(i, i + 1, '‘'); i++; } continue; }
    if (c === 39 && t[i + 1] === "'") { sym(i, i + 2, '”'); i += 2; continue; }
    if (c === 126) { sym(i, i + 1, '\u00a0'); i++; continue; }
    if (c !== 92) { i++; continue; }

    // ---- a backslash ----
    let j = i + 1;
    while (j < N && isLetter(t.charCodeAt(j))) j++;
    if (j === i + 1) {                                  // control symbol: \( \[ \\ \% …
      const ch = t[i + 1];
      if (ch === '(') { const e = t.indexOf('\\)', i + 2); if (e > 0) { items.push({ k: 'math', d: false, from: i, to: e + 2, sf: i + 2, st: e, src: t.slice(i + 2, e) }); i = e + 2; continue; } }
      else if (ch === '[') { const e = t.indexOf('\\]', i + 2); if (e > 0) { items.push({ k: 'math', d: true, from: i, to: e + 2, sf: i + 2, st: e, src: t.slice(i + 2, e) }); i = e + 2; continue; } }
      else if (ch === '\\') { const e = optArg(t, i + 2); items.push({ k: 'mark', cls: 'cmd', from: i, to: e }); i = e; continue; }
      else if (ACCENT[ch] && /[A-Za-z]/.test(t[i + 2] || '')) { sym(i, i + 3, (t[i + 2] + ACCENT[ch]).normalize('NFC')); i += 3; continue; }
      else if (ACCENT[ch] && t[i + 2] === '{' && t[i + 4] === '}') { sym(i, i + 5, (t[i + 3] + ACCENT[ch]).normalize('NFC')); i += 5; continue; }
      else if (ch in SYM) { sym(i, i + 2, SYM[ch]); i += 2; continue; }
      i += 2; continue;
    }
    let name = t.slice(i + 1, j);
    let star = false; if (t[j] === '*') { star = true; j++; }
    const from = i;

    if (name === 'begin' || name === 'end') {
      const g = group(t, j, 200); if (g < 0) { i = j; continue; }
      const en = t.slice(groupStart(t, j) + 1, g - 1).trim();
      if (name === 'end') {
        const k = env.length ? env.findLastIndex((e) => e.name === en) : -1;
        const open = k >= 0 ? env.splice(k)[0] : null;
        if ((open && open.hidden) || en === 'document') hide(from, g); else items.push({ k: 'mark', cls: 'cmd', from, to: g });
        i = g; continue;
      }
      if (MATH_ENV.test(en)) {
        let s = g; if (/^alignat/.test(en)) { const g2 = group(t, g, 20); if (g2 > 0) s = g2; }
        const e = findEnd(t, en, g);
        if (e) { items.push({ k: 'math', d: true, env: en, arg: t.slice(g, s).replace(/[{}\s]/g, ''), from, to: e.end, sf: s, st: e.at, src: t.slice(s, e.at) }); i = e.end; continue; }
      }
      if (VERB_ENV.test(en)) { const e = findEnd(t, en, g); const to = e ? e.end : N; items.push({ k: 'mono', from, to }); i = to; continue; }
      const oa = optArg(t, g);
      if (LIST_ENV.test(en)) {
        env.push({ name: en, kind: 'list', type: en === 'enumerate' || en === 'compactenum' || en === 'inparaenum' ? 'enum' : en === 'description' ? 'desc' : 'bullet', n: 0, hidden: true });
        const e = findEnd(t, en, g); if (e) items.push({ k: 'block', cls: 'list', depth: listDepth(), from: lineEnd(t, oa), to: lineStart(t, e.at) });
        hide(from, oa); i = oa; continue;
      }
      if (CODE_ENV.test(en)) { const e = findEnd(t, en, g); if (e) items.push({ k: 'mono', from, to: e.end }); env.push({ name: en, kind: 'code' }); i = g; continue; }
      if (FLOAT_ENV.test(en)) {
        env.push({ name: en, kind: 'float', hidden: true });
        label(from, oa, en.replace(/\*$/, '').replace(/^(sideways|wrap|sub|margin)/, '').replace(/^\w/, (x) => x.toUpperCase()), 'float'); i = oa; continue;
      }
      if (ALIGN_ENV[en]) {
        env.push({ name: en, kind: 'align', hidden: true });
        const e = findEnd(t, en, g); if (e) items.push({ k: 'block', cls: ALIGN_ENV[en], from: lineEnd(t, oa), to: lineStart(t, e.at) });
        if (en === 'abstract') label(from, oa, 'Abstract', 'abs'); else hide(from, oa);
        i = oa; continue;
      }
      if (THM_ENV.test(en)) {
        env.push({ name: en, kind: 'thm', hidden: true });
        const oe = optArg(t, g); const note = oe > g ? plain(t.slice(t.indexOf('[', g) + 1, oe - 1)) : '';
        label(from, oe, en.replace(/\*$/, '').replace(/^\w/, (x) => x.toUpperCase()) + (note ? ` (${note})` : ''), 'thm'); i = oe; continue;
      }
      if (en === 'document') { env.push({ name: en, hidden: true }); hide(from, g); i = g; continue; }
      env.push({ name: en });
      items.push({ k: 'mark', cls: 'cmd', from, to: oa }); i = oa; continue;
    }

    if (name in HEAD) {
      const oa = optArg(t, j); const g = group(t, oa);
      if (g > 0) { const open = groupStart(t, oa) + 1; items.push({ k: 'head', lvl: HEAD[name], from, open, close: g - 1, to: g, star }); i = open; continue; }
    }
    if (name in FMT) {
      let a = j, style = '';
      if (name === 'caption' || name === 'footnote') a = optArg(t, j);
      if (name === 'textcolor' || name === 'colorbox') {
        const m = optArg(t, j); const model = m > j ? t.slice(t.indexOf('[', j) + 1, m - 1).trim() : '';
        const g1 = group(t, m, 100); if (g1 < 0) { i = j; continue; }
        const col = t.slice(groupStart(t, m) + 1, g1 - 1).trim();
        style = model === 'HTML' && /^[0-9a-f]{6}$/i.test(col) ? '#' + col : /^[a-z]+$/i.test(col) ? col.toLowerCase() : '';
        a = g1;
      }
      if (name === 'href') { const g1 = group(t, j, 2000); if (g1 < 0) { i = j; continue; } a = g1; }
      const g = group(t, a);
      if (g > 0) { const open = groupStart(t, a) + 1; items.push({ k: 'fmt', cls: FMT[name], style, from, open, close: g - 1, to: g }); i = open; continue; }
    }
    if (name === 'subfloat' || name === 'subcaptionbox') {   // \subfloat[caption]{body} / \subcaptionbox{caption}{body}
      let capFrom, capTo, a;
      if (name === 'subfloat') { const oa = optArg(t, j); if (oa > j) { capFrom = t.indexOf('[', j) + 1; capTo = oa - 1; } a = oa; }
      else { const g1 = group(t, j, 2000); if (g1 < 0) { i = j; continue; } capFrom = groupStart(t, j) + 1; capTo = g1 - 1; a = g1; }
      const g = group(t, a);
      if (g > 0) {
        const open = groupStart(t, a) + 1;
        items.push({ k: 'sub', from, capFrom: capFrom ?? open, capTo: capTo ?? open, open, close: g - 1, to: g, cap: capFrom !== undefined });
        i = capFrom ?? open; continue;
      }
    }
    if (name === 'url' || name === 'nolinkurl' || name === 'path') {
      const g = group(t, j, 2000); if (g > 0) { items.push({ k: 'chip', cls: 'link', from, to: g, t: t.slice(groupStart(t, j) + 1, g - 1) }); i = g; continue; }
    }
    if (CITE.test(name) || REF.test(name) || name === 'label') {
      let a = optArg(t, j); a = optArg(t, a);
      const g = group(t, a, 2000);
      if (g > 0) {
        const keys = t.slice(groupStart(t, a) + 1, g - 1).split(',').map((s) => s.trim()).filter(Boolean);
        const kind = name === 'label' ? 'lbl' : REF.test(name) ? 'ref' : 'cite';
        items.push({ k: 'chip', cls: kind, from, to: g, keys, t: kind === 'cite' ? `[${keys.join(', ')}]` : kind === 'ref' && /eq/.test(name) ? `(${keys.join(', ')})` : keys.join(', ') });
        i = g; continue;
      }
    }
    if (name === 'includegraphics') {
      const oa = optArg(t, j); const g = group(t, oa, 1000);
      if (g > 0) { items.push({ k: 'img', from, to: g, path: t.slice(groupStart(t, oa) + 1, g - 1).trim(), opts: oa > j ? t.slice(t.indexOf('[', j) + 1, oa - 1) : '', alone: aloneOnLine(t, from, g) }); i = g; continue; }
    }
    if (INCLUDE.test(name)) {
      const g = group(t, j, 1000);
      if (g > 0) {
        let to = g, file = t.slice(groupStart(t, j) + 1, g - 1).trim(), dir = '';
        if (/import|from/.test(name)) { const g2 = group(t, g, 1000); if (g2 > 0) { dir = file; file = t.slice(groupStart(t, g) + 1, g2 - 1).trim(); to = g2; } }
        items.push({ k: 'chip', cls: 'file', from, to, cmd: name, dir, file, t: (dir ? dir.replace(/\/?$/, '/') : '') + file });
        i = to; continue;
      }
    }
    if (name === 'item') {
      const top = env.findLast((e) => e.kind === 'list');
      const oa = optArg(t, j);
      let to = oa; while (t[to] === ' ' || t[to] === '\t') to++;
      if (top) {
        top.n++;
        const term = oa > j ? plain(t.slice(t.indexOf('[', j) + 1, oa - 1)) : '';
        const ls = lineStart(t, from); const atStart = blank(t.slice(ls, from));
        items.push({ k: 'item', from: atStart ? ls : from, to, depth: listDepth(), mark: term || (top.type === 'enum' ? top.n + '.' : top.type === 'desc' ? '' : ['•', '◦', '▪', '·'][(listDepth() - 1) % 4]), term: !!term, atStart });
      } else items.push({ k: 'mark', cls: 'cmd', from, to: oa });
      i = to; continue;
    }
    if (name === 'maketitle') { items.push({ k: 'title', from, to: j, meta, line: aloneOnLine(t, from, j) }); i = j; continue; }
    if (name in LABELS && LABELS[name]) { let e = j; if (name === 'bibliography') { const g = group(t, j, 500); if (g > 0) e = g; } label(from, e, LABELS[name], 'sec'); i = e; continue; }
    if (HIDE_LINE_CMD.test(name)) { hide(from, j); i = j; continue; }
    if (name === 'verb' || name === 'lstinline' || name === 'mintinline') {
      let a = name === 'mintinline' ? group(t, j, 100) : optArg(t, j); if (a < 0) a = j;
      const d = t[a]; if (d === '{') { const g = group(t, a, 2000); if (g > 0) { items.push({ k: 'mono', from, to: g }); i = g; continue; } }
      else if (d && d !== '\n') { const e = t.indexOf(d, a + 1); if (e > 0 && !t.slice(a, e).includes('\n')) { items.push({ k: 'mono', from, to: e + 1 }); i = e + 1; continue; } }
    }
    if (name in SYM) {
      let to = j;
      if (/^[A-Za-z]+$/.test(name)) { if (t[to] === '{' && t[to + 1] === '}') to += 2; else if (t[to] === ' ' && name !== 'quad' && name !== 'qquad') to++; }   // \LaTeX{} or "\ldots "
      if (ACCENT[name] && t[j] === '{') { const g = group(t, j, 10); if (g > 0) { sym(from, g, (t.slice(j + 1, g - 1) + ACCENT[name]).normalize('NFC')); i = g; continue; } }
      if (name === 'ding') { const g = group(t, j, 10); if (g > 0) { sym(from, g, { 51: '✓', 52: '✔', 55: '✗', 56: '✘' }[t.slice(j + 1, g - 1)] || '•'); i = g; continue; } }
      sym(from, to, SYM[name]); i = to; continue;
    }
    if (ACCENT[name] && t[j] === '{') { const g = group(t, j, 10); if (g > 0) { sym(from, g, (t.slice(j + 1, g - 1) + ACCENT[name]).normalize('NFC')); i = g; continue; } }
    items.push({ k: 'mark', cls: 'cmd', from, to: j });
    i = j;
  }
  return items;
}

// ---------- math ----------
const ENV_MAP = { align: 'aligned', flalign: 'aligned', eqnarray: 'aligned', gather: 'gathered', multline: 'gathered', alignat: 'alignedat', dgroup: 'gathered' };
// KaTeX-ready source for a math item + the first \label inside it (shown as a tag).
export function mathSource(item) {
  let src = item.src, tag = '';
  src = src.replace(/\\label\s*\{([^{}]*)\}/g, (_, l) => { if (!tag) tag = l; return ''; }).replace(/\\(nonumber|notag)\b/g, '');
  const base = (item.env || '').replace(/\*$/, '');
  if (ENV_MAP[base]) src = `\\begin{${ENV_MAP[base]}}${base === 'alignat' && item.arg ? `{${item.arg}}` : ''}${src}\\end{${ENV_MAP[base]}}`;
  return { src, tag };
}

// Macros KaTeX lacks but documents commonly use (physics, siunitx, ATLAS-style units). Project definitions win.
export const BASE_MACROS = {
  '\\ensuremath': '#1', '\\xspace': '', '\\mbox': '\\text{#1}', '\\bm': '\\boldsymbol{#1}', '\\mathbbm': '\\mathbb{#1}', '\\textsuperscript': '^{\\text{#1}}',
  '\\abs': '\\left\\lvert #1\\right\\rvert', '\\norm': '\\left\\lVert #1\\right\\rVert', '\\order': '\\mathcal{O}\\left(#1\\right)', '\\dd': '\\mathrm{d}',
  '\\dv': '\\frac{\\mathrm{d}#1}{\\mathrm{d}#2}', '\\pdv': '\\frac{\\partial #1}{\\partial #2}', '\\expval': '\\left\\langle #1\\right\\rangle',
  '\\SI': '#1\\,\\mathrm{#2}', '\\si': '\\mathrm{#1}', '\\num': '#1', '\\qty': '#1\\,\\mathrm{#2}', '\\unit': '\\mathrm{#1}', '\\ang': '#1^\\circ', '\\percent': '\\%',
  '\\eV': '\\mathrm{eV}', '\\keV': '\\mathrm{keV}', '\\MeV': '\\mathrm{MeV}', '\\GeV': '\\mathrm{GeV}', '\\TeV': '\\mathrm{TeV}',
  '\\ns': '\\mathrm{ns}', '\\ps': '\\mathrm{ps}', '\\mus': '\\mu\\mathrm{s}', '\\ms': '\\mathrm{ms}', '\\mm': '\\mathrm{mm}', '\\cm': '\\mathrm{cm}',
  '\\MHz': '\\mathrm{MHz}', '\\GHz': '\\mathrm{GHz}', '\\kHz': '\\mathrm{kHz}', '\\Gbps': '\\mathrm{Gb/s}', '\\fb': '\\mathrm{fb}', '\\pb': '\\mathrm{pb}', '\\ifb': '\\mathrm{fb}^{-1}', '\\ipb': '\\mathrm{pb}^{-1}',
  '\\pT': 'p_{\\mathrm{T}}', '\\pt': 'p_{\\mathrm{T}}', '\\ET': 'E_{\\mathrm{T}}', '\\Et': 'E_{\\mathrm{T}}', '\\MET': 'E_{\\mathrm{T}}^{\\mathrm{miss}}', '\\met': 'E_{\\mathrm{T}}^{\\mathrm{miss}}',
  '\\sqrts': '\\sqrt{s}', '\\micro': '\\mu', '\\degree': '^\\circ', '\\tightlist': '', '\\textmu': '\\mu',
};

// User macros from LaTeX source: \newcommand, \renewcommand, \providecommand, \def, \DeclareMathOperator
const CORE = /^(mathrm|mathbf|mathit|mathsf|mathtt|mathcal|mathbb|text|textrm|textbf|textit|texttt|textsf|emph|frac|sqrt|left|right|begin|end|label|ref|cite|hbox|mbox|operatorname|_|,)$/;
export function extractMacros(t, into = {}, isDefined = null) {
  // bookmark-only definitions (\pdfstringdefDisableCommands{…}) are not what the document typesets
  if (t.includes('pdfstringdefDisableCommands')) {
    const rp = /\\pdfstringdefDisableCommands\s*\{/g; let out = '', last = 0, mm;
    while ((mm = rp.exec(t))) { const e = group(t, mm.index + mm[0].length - 1, 20000); if (e < 0) continue; out += t.slice(last, mm.index) + ' '.repeat(e - mm.index); last = e; rp.lastIndex = e; }
    t = out + t.slice(last);
  }
  const re = /\\(?:(?:re|provide)?newcommand|DeclareRobustCommand)\*?\s*\{?\s*\\([A-Za-z@]+)\s*\}?\s*(?:\[(\d)\])?\s*(?:\[([^\]]*)\])?\s*(?=\{)|\\[gex]?def\s*\\([A-Za-z@]+)((?:#\d)*)\s*(?=\{)|\\DeclareMathOperator(\*?)\s*\{\s*\\([A-Za-z@]+)\s*\}\s*(?=\{)/g;
  let m;
  while ((m = re.exec(t))) {
    const ls = t.lastIndexOf('\n', m.index - 1) + 1; if (/(^|[^\\])%/.test(t.slice(ls, m.index))) continue;
    const s = m.index + m[0].length; const e = group(t, s, 4000); if (e < 0) continue;
    let body = t.slice(s + 1, e - 1);
    if (m[7]) { into['\\' + m[7]] = `\\operatorname${m[6] ? '*' : ''}{${body}}`; continue; }
    const name = m[1] || m[4];
    if (CORE.test(name)) continue;
    if (/^\\providecommand/.test(m[0]) && isDefined && isDefined('\\' + name)) continue;   // \providecommand never replaces an existing command
    if (m[3] !== undefined) {   // optional first argument with a default: drop it, renumber the rest
      body = body.replace(/#1/g, m[3]).replace(/#(\d)/g, (_, d) => '#' + (d - 1));
    }
    into['\\' + name] = body;
  }
  return into;
}
