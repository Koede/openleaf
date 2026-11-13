// Visual Editor: the LaTeX source shown as formatted text — headings, bold/italic, lists, rendered math,
// figure previews, reference/citation chips. The document itself stays plain LaTeX (so co-editing,
// review and compiling are unaffected); markup reappears where the cursor is.
import { StateField, StateEffect } from '@codemirror/state';
import { EditorView, Decoration, WidgetType, ViewPlugin } from '@codemirror/view';
import katex from 'katex';
import * as pdfjsLib from 'pdfjs-dist/build/pdf.mjs';
import { S, bus, esc, flatFiles } from './state.js';
import { rawUrl } from './api.js';
import { parse, mathSource, extractMacros, BASE_MACROS, group, plain } from './vparse.js';

// ---------- macros from the project (\newcommand & co), re-read only when a file's text changes ----------
const perFile = new Map();         // path -> { text, json }
let macroSig = '', macroObj = { ...BASE_MACROS };
const mathCache = new Map();
function macros() {
  let changed = false; const seen = new Set();
  for (const [p, text] of S.cache) {
    if (!/\.(tex|sty|cls|def|ltx)$/i.test(p)) continue;
    seen.add(p);
    const old = perFile.get(p); if (old && old.text === text) continue;
    const json = /\\(newcommand|renewcommand|providecommand|def|gdef|DeclareMathOperator|DeclareRobustCommand)/.test(text) ? JSON.stringify(extractMacros(text, {}, katexKnows)) : '{}';
    if (!old || old.json !== json) changed = true;
    perFile.set(p, { text, json });
  }
  for (const p of perFile.keys()) if (!seen.has(p)) { perFile.delete(p); changed = true; }
  if (changed) {
    const sig = [...perFile.values()].map((v) => v.json).join('');
    if (sig !== macroSig) { macroSig = sig; macroObj = { ...BASE_MACROS }; for (const v of perFile.values()) Object.assign(macroObj, JSON.parse(v.json)); mathCache.clear(); }
  }
  return macroObj;
}
const known = new Map();
function katexKnows(name) {
  if (!known.has(name)) { let ok = true; try { katex.renderToString(name + '{x}', { throwOnError: true, strict: 'ignore', macros: { ...BASE_MACROS } }); } catch (e) { ok = !/Undefined control sequence/.test(e.message); } known.set(name, ok); }
  return known.get(name);
}
function renderMath(src, display) {
  const m = macros(); const key = (display ? 'D' : 'I') + src;
  let html = mathCache.get(key);
  if (html === undefined) {
    try { html = katex.renderToString(src, { displayMode: display, throwOnError: false, strict: 'ignore', trust: false, output: 'html', macros: { ...m }, maxExpand: 500, maxSize: 40, errorColor: '#d0443e' }); }
    catch { html = `<span class="cm-v-matherr">${esc(src)}</span>`; }
    if (mathCache.size > 4000) mathCache.clear();
    mathCache.set(key, html);
  }
  return html;
}

// ---------- figures ----------
const dirOf = (p) => (p && p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '');
const normPath = (p) => { const out = []; for (const seg of p.split('/')) { if (seg === '..') out.pop(); else if (seg && seg !== '.') out.push(seg); } return out.join('/'); };
let gpSig = null, gpDirs = [];
function graphicsPaths() {
  const sig = S.cache.size + ':' + S.project; if (sig === gpSig) return gpDirs;
  gpSig = sig; gpDirs = [];
  for (const t of S.cache.values()) for (const m of t.matchAll(/\\graphicspath\s*\{((?:\s*\{[^{}]*\})+)\s*\}/g)) for (const d of m[1].matchAll(/\{([^{}]*)\}/g)) gpDirs.push(d[1]);
  return gpDirs;
}
let figTree = null; const figMemo = new Map();
export function resolveFigure(p, from) {
  if (figTree !== S.tree) { figTree = S.tree; figMemo.clear(); }
  const key = from + '\n' + p; if (figMemo.has(key)) return figMemo.get(key);
  const r = findFigure(p, from); figMemo.set(key, r); return r;
}
function findFigure(p, from) {
  const files = new Set(flatFiles()); const q0 = p.replace(/^\.\//, '');
  const exts = /\.(pdf|png|jpe?g|gif|svg|eps|webp)$/i.test(q0) ? [''] : ['', '.pdf', '.png', '.jpg', '.jpeg', '.eps'];
  for (const d of [dirOf(from), '', ...graphicsPaths()]) for (const e of exts) { const q = normPath(d + q0 + e); if (files.has(q)) return q; }
  for (const e of exts) { const suf = '/' + normPath(q0 + e); for (const f of files) if (f.endsWith(suf)) return f; }
  return null;
}
const thumbs = new Map();          // project/path -> Promise<dataURL>
function pdfThumb(path) {
  const key = S.project + '\n' + path;
  if (!thumbs.has(key)) {
    thumbs.set(key, (async () => {
      const doc = await pdfjsLib.getDocument({ url: rawUrl(path) }).promise;
      try {
        const page = await doc.getPage(1); const v0 = page.getViewport({ scale: 1 });
        const scale = Math.min(3, 900 / Math.max(v0.width, 1)); const vp = page.getViewport({ scale });
        const c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
        await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
        return c.toDataURL('image/png');
      } finally { doc.destroy(); }
    })());
    if (thumbs.size > 200) thumbs.delete(thumbs.keys().next().value);
  }
  return thumbs.get(key);
}
bus.on('ws-fs', (e) => { if (e && e.path) for (const k of thumbs.keys()) if (k.endsWith('\n' + e.path)) thumbs.delete(k); });

// \title/\author/\date for \maketitle, also when they live in a file \input from the preamble
let metaSig = null, metaVal = {};
function docMeta(preamble) {
  let sig = S.project + ':' + preamble.length + ':' + S.cache.size; for (const v of S.cache.values()) sig += ':' + v.length;
  if (sig === metaSig) return metaVal;
  metaSig = sig; metaVal = {};
  const here = dirOf(S.current || ''), order = [];
  for (const m of preamble.matchAll(/\\(?:input|include)\s*\{([^{}]+)\}/g)) for (const c of [m[1], m[1] + '.tex']) for (const d of ['', here]) { const q = normPath(d + c.trim()); if (S.cache.has(q) && !order.includes(q)) order.push(q); }
  for (const p of S.cache.keys()) if (/\.tex$/i.test(p) && !order.includes(p) && p !== S.current) order.push(p);
  for (const p of order) {
    const t = S.cache.get(p);
    for (const m of t.matchAll(/\\(title|AtlasTitle|author|date)\s*(?:\[[^\]]*\])?\s*\{/g)) {
      const key = m[1] === 'AtlasTitle' ? 'title' : m[1]; if (metaVal[key]) continue;
      const ls = t.lastIndexOf('\n', m.index - 1) + 1; if (/(^|[^\\])%/.test(t.slice(ls, m.index))) continue;
      const s = m.index + m[0].length - 1, e = group(t, s, 4000); if (e > 0) metaVal[key] = t.slice(s + 1, e - 1);
    }
  }
  return metaVal;
}

// A short piece of LaTeX (title, author) as HTML: formulas and the project's math macros rendered, other markup dropped
function richText(src) {
  const m = macros();
  src = src.replace(/(^|[^\\])%[^\n]*/g, '$1').replace(/\\(thanks|footnote|AtlasOrcid|orcid|inst|affil|affiliation|email|institute|label)\s*\{[^{}]*\}/g, '');
  const text = (q) => esc(q.replace(/\\\\(\[[^\]]*\])?/g, ' ').replace(/~/g, '\u00a0').replace(/[{}]/g, '').replace(/\s+/g, ' '));
  return src.split(/(\$[^$]*\$)/).map((p, i) => i % 2 ? renderMath(p.slice(1, -1), false) : p.split(/(\\[A-Za-z@]+\*?(?:\{\})?(?:\\ )?)/).map((q, j) => {
    if (!(j % 2)) return text(q);
    const name = /^\\[A-Za-z@]+/.exec(q)[0];
    if (name === '\\and' || name === '\\AND') return ' · ';
    return m[name] !== undefined ? renderMath(name, false) + (/\\ $/.test(q) ? ' ' : '') : '';
  }).join('')).join('').trim();
}

// ---------- widgets ----------
class MathWidget extends WidgetType {
  constructor(src, display, block, tag, preview = false) { super(); this.src = src; this.display = display; this.block = block; this.tag = tag; this.preview = preview; }
  eq(o) { return o.src === this.src && o.display === this.display && o.block === this.block && o.tag === this.tag && o.preview === this.preview; }
  toDOM() {
    const el = document.createElement(this.block ? 'div' : 'span');
    el.className = (this.display ? 'cm-v-dmath' : 'cm-v-math') + (this.preview ? ' preview' : '');
    el.innerHTML = renderMath(this.src, this.display);
    if (this.tag) { const t = document.createElement('span'); t.className = 'cm-v-tag'; t.textContent = this.tag; el.append(t); }
    el.setAttribute('aria-label', this.src);
    return el;
  }
  get estimatedHeight() { return this.block ? 48 : -1; }
  ignoreEvent() { return false; }
}
class TextWidget extends WidgetType {
  constructor(text, cls = '', title = '', block = false) { super(); this.text = text; this.cls = cls; this.title = title; this.block = block; }
  eq(o) { return o.text === this.text && o.cls === this.cls && o.title === this.title && o.block === this.block; }
  toDOM() { const s = document.createElement(this.block ? 'div' : 'span'); s.className = this.cls; s.textContent = this.text; if (this.title) s.title = this.title; return s; }
  ignoreEvent() { return false; }
}
class ChipWidget extends WidgetType {
  constructor(it) { super(); this.cls = it.cls; this.text = it.t; this.data = JSON.stringify(it.keys || [it.dir || '', it.file || '', it.cmd || '']); }
  eq(o) { return o.cls === this.cls && o.text === this.text && o.data === this.data; }
  toDOM() {
    const s = document.createElement('span'); s.className = `cm-v-chip cm-v-${this.cls}`; s.dataset.v = this.data;
    s.textContent = ({ ref: '↗ ', lbl: '# ', file: '📄 ' }[this.cls] || '') + this.text;
    s.title = { ref: 'Reference — Ctrl/⌘-click to go to the label', cite: 'Citation', lbl: 'Label', file: 'Included file — Ctrl/⌘-click to open', link: 'Link' }[this.cls] || '';
    return s;
  }
  ignoreEvent() { return false; }
}
class ImgWidget extends WidgetType {
  constructor(path, raw, block) { super(); this.path = path; this.raw = raw; this.block = block; }
  eq(o) { return o.path === this.path && o.raw === this.raw && o.block === this.block; }
  toDOM() {
    const box = document.createElement(this.block ? 'div' : 'span'); box.className = 'cm-v-fig';
    if (!this.path || window.__DEMO) { box.classList.add('missing'); box.textContent = this.path ? `🖼 ${this.path}` : `🖼 ${this.raw} — not found in the project`; return box; }
    const img = document.createElement('img'); img.alt = this.raw; img.title = this.path; img.decoding = 'async';
    const fail = () => { box.classList.add('missing'); box.textContent = `🖼 ${this.path}`; };
    img.onerror = fail;
    if (/\.pdf$/i.test(this.path)) { box.classList.add('loading'); pdfThumb(this.path).then((u) => { box.classList.remove('loading'); img.src = u; }, fail); }
    else if (/\.eps$/i.test(this.path)) { fail(); return box; }
    else img.src = rawUrl(this.path);
    box.append(img);
    return box;
  }
  get estimatedHeight() { return this.block ? 260 : -1; }
  ignoreEvent() { return false; }
}
class PreambleWidget extends WidgetType {
  constructor(lines, open) { super(); this.lines = lines; this.open = open; }
  eq(o) { return o.lines === this.lines && o.open === this.open; }
  toDOM(view) {
    const d = document.createElement('div'); d.className = 'cm-v-pre' + (this.open ? ' open' : '');
    d.textContent = this.open ? '▴ Hide preamble' : `▸ Preamble · ${this.lines} lines`; d.title = this.open ? 'Collapse the preamble' : 'Show the preamble (document class, packages, macros)';
    d.addEventListener('mousedown', (e) => { e.preventDefault(); view.dispatch({ effects: togglePre.of(!this.open) }); });
    return d;
  }
  ignoreEvent() { return true; }
}
class TitleWidget extends WidgetType {
  constructor(meta, block) { super(); this.meta = JSON.stringify(meta || {}); this.block = block; }
  eq(o) { return o.meta === this.meta && o.block === this.block; }
  toDOM() {
    const m = JSON.parse(this.meta); const d = document.createElement(this.block ? 'div' : 'span'); d.className = 'cm-v-title';
    d.innerHTML = `<div class="t">${m.title ? richText(m.title) : 'Title'}</div>${m.author ? `<div class="a">${richText(m.author)}</div>` : ''}${m.date ? `<div class="d">${richText(m.date)}</div>` : ''}`;
    return d;
  }
  ignoreEvent() { return false; }
}
const HIDDEN_LINE = new (class extends WidgetType { toDOM() { const d = document.createElement('div'); d.className = 'cm-v-gone'; return d; } eq() { return true; } ignoreEvent() { return false; } })();

// ---------- decorations ----------
// Block widgets and replacements that span lines must come from a state field; everything else is built
// by a view plugin for the visible part of the document only (cheap on long files).
const togglePre = StateEffect.define();
const reparsed = StateEffect.define();
const BIG = 60000;                 // above this many characters, re-parse after a short pause instead of per keystroke
const BLOCKISH = new Set(['pre', 'math', 'img', 'hide', 'label', 'title']);

function collect(state, items, preOpen, wantField, range) {
  const doc = state.doc, heads = state.selection.ranges.map((r) => r.head);
  const on = (a, b) => heads.some((h) => h >= a && h <= b);       // cursor on/at the construct
  const inn = (a, b) => heads.some((h) => h > a && h < b);         // cursor strictly inside
  const out = []; const lines = new Map();                          // line start -> { cls:Set, pad, hang }
  const L = (pos) => { const l = doc.lineAt(pos); let o = lines.get(l.from); if (!o) lines.set(l.from, (o = { cls: new Set(), pad: 0, hang: false })); return o; };
  // field decorations: block ones and replacements across a line break; view decorations: the rest
  const put = (deco, field) => { if (field === wantField) out.push(deco); };
  const rep = (a, b, widget, block = false) => {
    if (!(b > a || widget)) return;
    put(Decoration.replace(widget ? { widget, block } : {}).range(a, b), block || (b > a && doc.lineAt(a).to < b));
  };
  const mark = (a, b, cls, attrs) => { if (b > a) put(Decoration.mark(attrs ? { class: cls, attributes: attrs } : { class: cls }).range(a, b), false); };
  const path = S.current;
  for (const it of items) {
    if (range ? it.to < range.from || it.from > range.to : !(BLOCKISH.has(it.k) || it.ml)) continue;
    switch (it.k) {
      case 'pre':
        if (preOpen) put(Decoration.widget({ widget: new PreambleWidget(it.lines, true), block: true, side: 1 }).range(it.to), true);
        else if (!inn(it.from, it.to)) rep(it.from, it.to, new PreambleWidget(it.lines, false), true);
        break;
      case 'cm': mark(it.from, it.to, 'cm-v-comment'); break;
      case 'mark': mark(it.from, it.to, 'cm-v-cmd'); break;
      case 'mono': mark(it.from, it.to, 'cm-v-mono'); break;
      case 'math': {
        const ls = doc.lineAt(it.from), le = doc.lineAt(it.to);
        const alone = it.d && !/\S/.test(doc.sliceString(ls.from, it.from)) && !/\S/.test(doc.sliceString(it.to, le.to));
        if (wantField && !alone && ls.number === le.number) break;
        const { src, tag } = mathSource({ ...it, src: doc.sliceString(it.sf, it.st) });
        if (alone ? on(ls.from, le.to) : on(it.from, it.to)) {
          mark(it.from, it.to, 'cm-v-mathsrc');
          if (it.d) put(Decoration.widget({ widget: new MathWidget(src, true, true, tag, true), block: true, side: 1 }).range(le.to), true);   // live preview
          break;
        }
        if (alone) rep(ls.from, le.to, new MathWidget(src, true, true, tag), true);
        else rep(it.from, it.to, new MathWidget(src, it.d, false, tag));
        break;
      }
      case 'head':
        L(it.from).cls.add('cm-v-h' + it.lvl);
        if (!inn(it.from, it.open) && !inn(it.close, it.to)) { rep(it.from, it.open); rep(it.close, it.to); }
        break;
      case 'fmt': {
        const attrs = it.style ? { style: (it.cls === 'hl' ? 'background-color:' : 'color:') + it.style } : null;
        mark(it.open, it.close, 'cm-v-' + it.cls, attrs);
        if (inn(it.from, it.open) || inn(it.close, it.to)) break;
        if (it.cls === 'cap') rep(it.from, it.open, new TextWidget('Caption: ', 'cm-v-caplabel'));
        else if (it.cls === 'fn') rep(it.from, it.open, new TextWidget('note', 'cm-v-fnmark', 'Footnote'));
        else if (it.cls === 'q') rep(it.from, it.open, new TextWidget('“', ''));
        else rep(it.from, it.open);
        if (it.cls === 'q') rep(it.close, it.to, new TextWidget('”', '')); else rep(it.close, it.to);
        break;
      }
      case 'sub':
        if (it.cap) mark(it.capFrom, it.capTo, 'cm-v-cap');
        if (inn(it.from, it.capFrom) || inn(it.capTo, it.open) || inn(it.close, it.to)) break;
        rep(it.from, it.capFrom, it.cap ? new TextWidget('Subfigure: ', 'cm-v-caplabel') : null); if (it.cap) rep(it.capTo, it.open); rep(it.close, it.to);
        break;
      case 'chip': if (!on(it.from, it.to)) rep(it.from, it.to, new ChipWidget(it)); break;
      case 'img': {
        const a = it.alone ? doc.lineAt(it.from).from : it.from, b = it.alone ? doc.lineAt(it.to).to : it.to;
        if (on(a, b)) break;
        rep(a, b, new ImgWidget(resolveFigure(it.path, path), it.path, it.alone), it.alone);
        break;
      }
      case 'sym': if (!inn(it.from, it.to)) rep(it.from, it.to, it.t ? new TextWidget(it.t, 'cm-v-sym') : null); break;
      case 'item':
        if (it.atStart) { const o = L(it.from); o.pad = Math.max(o.pad, it.depth); o.hang = true; }
        if (!inn(it.from, it.to)) rep(it.from, it.to, new TextWidget(it.mark, it.term ? 'cm-v-term' : 'cm-v-bullet'));
        break;
      case 'block': {
        if (it.to <= it.from || wantField) break;
        const lo = Math.max(it.from + 1, range.from), hi = Math.min(it.to, range.to);
        for (let pos = doc.lineAt(Math.min(doc.length, lo)).from; pos < hi; ) {
          const l = doc.lineAt(pos); const o = L(l.from);
          if (it.cls === 'list') o.pad = Math.max(o.pad, it.depth); else o.cls.add('cm-v-' + it.cls);
          if (l.to + 1 > doc.length) break; pos = l.to + 1;
        }
        break;
      }
      case 'hide':
        if (it.line ? on(it.from, it.to) : inn(it.from, it.to)) { mark(it.from, it.to, 'cm-v-cmd'); break; }
        if (it.line) rep(it.from, it.to, HIDDEN_LINE, true); else rep(it.from, it.to);
        break;
      case 'label':
        if (on(it.from, it.to)) { mark(it.from, it.to, 'cm-v-cmd'); break; }
        rep(it.from, it.to, new TextWidget(it.t, 'cm-v-label ' + it.cls, '', it.line), it.line);
        break;
      case 'title':
        if (on(it.from, it.to)) break;
        rep(it.line ? doc.lineAt(it.from).from : it.from, it.line ? doc.lineAt(it.to).to : it.to, new TitleWidget({ ...docMeta(items[0] && items[0].k === 'pre' ? doc.sliceString(0, items[0].to) : ''), ...it.meta }, it.line), it.line);
        break;
    }
  }
  if (!wantField) for (const [from, o] of lines) {
    const style = (o.pad ? `padding-left:${o.pad * 1.6}em;` : '') + (o.hang ? 'text-indent:-1.3em;' : '');
    const spec = {}; if (o.cls.size) spec.class = [...o.cls].join(' '); if (style) spec.attributes = { style };
    if (spec.class || spec.attributes) out.push(Decoration.line(spec).range(from));
  }
  try { return Decoration.set(out, true); } catch (e) { console.warn('visual editor:', e); return Decoration.none; }
}

// A cheap fingerprint of which constructs the cursor reveals: if it is unchanged, so are the decorations.
function revealKey(state, items) {
  const heads = state.selection.ranges.map((r) => r.head); let k = '';
  for (let n = 0; n < items.length; n++) { const it = items[n]; if (heads.some((h) => h >= it.from && h <= it.to)) k += n + (heads.some((h) => h > it.from && h < it.to) ? 'i,' : ','); }
  return k;
}

// Long documents: shift the old items through an edit (dropping the ones it breaks) until the re-parse lands.
const INNER = { fmt: ['open', 'close'], head: ['open', 'close'], sub: ['open', 'close'], math: ['sf', 'st'], block: ['from', 'to'], pre: ['from', 'to'], cm: ['from', 'to'], mono: ['from', 'to'] };
function mapItems(items, changes) {
  const ranges = []; changes.iterChangedRanges((a, b) => ranges.push([a, b]));
  const out = []; const first = ranges.length ? ranges[0][0] : Infinity;
  for (const it of items) {
    if (it.to < first) { out.push(it); continue; }       // before the edit: unchanged
    let keep = true;
    for (const [a, b] of ranges) {
      if (b < it.from || a > it.to) continue;
      const inner = INNER[it.k];
      if (inner && a >= it[inner[0]] && b <= it[inner[1]]) continue;       // edit inside the content
      if (b === it.from || a === it.to) continue;                           // only touches the edge
      keep = false; break;
    }
    if (!keep) continue;
    const n = { ...it, from: changes.mapPos(it.from, 1), to: changes.mapPos(it.to, -1) };
    for (const [x, y] of [['open', 'close'], ['sf', 'st'], ['capFrom', 'capTo']]) if (it[x] !== undefined) { n[x] = changes.mapPos(it[x], -1); n[y] = changes.mapPos(it[y], 1); }
    if (n.k === 'block' || n.k === 'pre' || n.k === 'cm' || n.k === 'mono') { n.from = changes.mapPos(it.from, -1); n.to = changes.mapPos(it.to, 1); }
    if (n.to >= n.from) { n.ml = n.ml || changes.mapPos(it.to) - changes.mapPos(it.from) !== it.to - it.from; out.push(n); }
  }
  return out;
}

// parse + flag the items that span a line break (only those can need field decorations)
function parseDoc(doc) {
  const t = doc.toString(), items = parse(t);
  for (const it of items) { const nl = t.indexOf('\n', it.from); it.ml = nl >= 0 && nl < it.to; }
  return items;
}
const field = StateField.define({
  create(state) { const items = parseDoc(state.doc); return { items, pre: false, stale: false, key: revealKey(state, items), deco: collect(state, items, false, true) }; },
  update(v, tr) {
    let pre = v.pre, items = v.items, stale = v.stale;
    for (const e of tr.effects) { if (e.is(togglePre)) pre = e.value; if (e.is(reparsed) && e.value.doc === tr.state.doc) { items = e.value.items; stale = false; } }
    if (tr.docChanged) {
      if (tr.state.doc.length > BIG) { items = mapItems(items, tr.changes); stale = true; } else { items = parseDoc(tr.state.doc); stale = false; }
    }
    if (items === v.items && pre === v.pre && !tr.selection) return v;
    const key = revealKey(tr.state, items);
    if (items === v.items && pre === v.pre && key === v.key) return v;
    return { items, pre, stale, key, deco: collect(tr.state, items, pre, true) };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

const inline = ViewPlugin.fromClass(class {
  constructor(view) { this.view = view; this.timer = 0; this.make(view); }
  make(view) {
    const f = view.state.field(field); this.src = f; this.vp = view.viewport;
    this.decorations = collect(view.state, f.items, f.pre, false, view.viewport);
  }
  update(u) {
    const f = u.state.field(field);
    if (f.stale && u.docChanged) { clearTimeout(this.timer); this.timer = setTimeout(() => this.reparse(), 350); }
    const vp = u.view.viewport;
    if (f.items === this.src.items && f.key === this.src.key && f.pre === this.src.pre && !u.docChanged && vp.from === this.vp.from && vp.to === this.vp.to) return;
    this.make(u.view);
  }
  reparse() {
    const v = this.view, doc = v.state.doc;
    if (!v.state.field(field, false)?.stale) return;
    const items = parseDoc(doc);
    if (v.state.doc === doc) v.dispatch({ effects: reparsed.of({ doc, items }) });
  }
  destroy() { clearTimeout(this.timer); }
}, { decorations: (p) => p.decorations });

function jumpToLabel(key) {
  const re = new RegExp(String.raw`\\label\s*\{${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\}`);
  for (const [file, text] of S.cache) { const m = re.exec(text); if (m) { const before = text.slice(0, m.index); const line = before.split('\n').length; bus.emit('goto-source', { file, line, column: m.index - before.lastIndexOf('\n') - 1 }); return true; } }
  return false;
}
const events = EditorView.domEventHandlers({
  mousedown(e, view) {
    const chip = e.target.closest('.cm-v-chip');
    if (chip && (e.ctrlKey || e.metaKey)) {
      const v = JSON.parse(chip.dataset.v || '[]');
      if (chip.classList.contains('cm-v-ref') && v[0]) { e.preventDefault(); jumpToLabel(v[0]); return true; }
      if (chip.classList.contains('cm-v-file')) { e.preventDefault(); bus.emit('open-include', { dir: v[0], file: v[1], cmd: v[2], from: S.current }); return true; }
    }
    return false;
  },
});

// Whole extension (constant, so reconfiguring the compartment with it keeps the field's state)
export const visualExtension = [field, inline, events, EditorView.lineWrapping, EditorView.editorAttributes.of({ class: 'cm-visual' })];
export const isVisualPath = (p) => /\.(tex|ltx)$/i.test(p || '');
