// Visual Editor: the LaTeX → items parser, math preparation and macro extraction (src/vparse.js).
const test = require('node:test'), assert = require('node:assert/strict');

let V, katex;
test.before(async () => { V = await import('../src/vparse.js'); katex = (await import('katex')).default; });

const DOC = require('fs').readFileSync(require('path').join(__dirname, 'fixtures', 'visual.tex'), 'utf8');

const find = (items, k, pred = () => true) => items.filter((i) => i.k === k && pred(i));
const text = (it) => DOC.slice(it.from, it.to);

test('preamble, title and headings', () => {
  const items = V.parse(DOC);
  const pre = items[0];
  assert.equal(pre.k, 'pre'); assert.ok(text(pre).endsWith('\\begin{document}'));
  const title = find(items, 'title')[0];
  assert.equal(title.meta.title, 'On $x^2$ and \\emph{more}'); assert.ok(title.line);
  const h = find(items, 'head')[0];
  assert.equal(h.lvl, 2); assert.equal(DOC.slice(h.open, h.close), 'Intro $x^2$');
  assert.ok(find(items, 'math').some((m) => m.from >= h.open && m.to <= h.close), 'math inside the heading is found');
  assert.equal(find(items, 'chip', (c) => c.cls === 'lbl')[0].t, 'sec:intro');
});

test('inline formatting nests and chips carry their keys', () => {
  const items = V.parse(DOC);
  const [b, i] = find(items, 'fmt', (f) => f.cls === 'b' || f.cls === 'i');
  assert.equal(DOC.slice(b.open, b.close), 'bold and \\emph{it}');
  assert.ok(i.from >= b.open && i.to <= b.close);
  const cite = find(items, 'chip', (c) => c.cls === 'cite')[0]; assert.deepEqual(cite.keys, ['k1', 'k2']); assert.equal(cite.t, '[k1, k2]');
  assert.equal(find(items, 'chip', (c) => c.cls === 'ref')[0].t, 'sec:intro');
  assert.equal(find(items, 'chip', (c) => c.cls === 'link')[0].t, 'https://x.org');
  const syms = find(items, 'sym').map((s) => s.t).join('|');
  for (const s of ['–', 'é', '%', '“', '”', '$']) assert.ok(syms.split('|').includes(s), `symbol ${s}`);
});

test('lists: hidden begin/end lines, numbering and depth', () => {
  const items = V.parse(DOC);
  const its = find(items, 'item');
  assert.deepEqual(its.map((i) => [i.mark, i.depth]), [['•', 1], ['1.', 2], ['2.', 2], ['•', 1]]);
  const hidden = find(items, 'hide', (h) => h.line).map(text).map((s) => s.trim());
  for (const s of ['\\begin{itemize}', '\\end{itemize}', '\\begin{enumerate}', '\\end{enumerate}', '\\centering', '\\end{figure}', '\\end{document}']) assert.ok(hidden.includes(s), s);
  assert.ok(find(items, 'block', (b) => b.cls === 'list' && b.depth === 2).length === 1);
});

test('maths: environments map to KaTeX-friendly forms, labels become tags', () => {
  const items = V.parse(DOC);
  const al = find(items, 'math', (m) => m.env === 'align')[0];
  assert.equal(DOC.slice(al.sf, al.st), al.src);
  const { src, tag } = V.mathSource(al);
  assert.equal(tag, 'eq:a'); assert.ok(src.startsWith('\\begin{aligned}') && src.endsWith('\\end{aligned}'));
  assert.ok(!/label|nonumber/.test(src));
  assert.ok(find(items, 'math', (m) => !m.d && m.src === '\\R').length === 1, '\\( \\) is inline math');
  assert.equal(find(items, 'math', (m) => m.src.includes('not math')).length, 0, 'verbatim is skipped');
  assert.equal(find(items, 'fmt', (f) => DOC.slice(f.open, f.close) === 'not bold').length, 0);
  // \$ is a dollar sign, not math
  assert.ok(!find(items, 'math').some((m) => m.src.includes('5.')));
});

test('figures and subfloats', () => {
  const items = V.parse(DOC);
  const img = find(items, 'img')[0];
  assert.equal(img.path, 'figs/plot'); assert.equal(img.opts, 'width=0.4\\textwidth');
  const sub = find(items, 'sub')[0]; assert.equal(DOC.slice(sub.capFrom, sub.capTo), 'Left');
  assert.ok(img.from >= sub.open && img.to <= sub.close);
  assert.equal(find(items, 'label', (l) => l.cls === 'float')[0].t, 'Figure');
  assert.equal(find(items, 'fmt', (f) => f.cls === 'cap').length, 1);
});

test('macros: \\newcommand with defaults, operators, and no bookmark-only or provided definitions', () => {
  const m = V.extractMacros(DOC, {}, (name) => name === '\\checkmark');
  assert.equal(m['\\R'], '\\mathbb{R}');
  assert.equal(m['\\pair'], '(0,#1)');
  assert.equal(m['\\argmax'], '\\operatorname*{arg\\,max}');
  assert.equal(m['\\mathrm'], undefined); assert.equal(m['\\MET'], undefined); assert.equal(m['\\checkmark'], undefined);
});

test('every formula in the sample renders with KaTeX', () => {
  const macros = { ...V.BASE_MACROS, ...V.extractMacros(DOC) };
  for (const it of V.parse(DOC).filter((i) => i.k === 'math')) {
    const { src } = V.mathSource(it);
    assert.doesNotThrow(() => katex.renderToString(src, { displayMode: it.d, throwOnError: true, strict: 'ignore', macros: { ...macros } }), src);
  }
});

test('unbalanced input never hangs or throws', () => {
  for (const t of ['\\textbf{open', '$a', '\\begin{itemize}\n\\item x', '\\section{', '\\[ x', '\\includegraphics[', '``', '\\end{nothing}', '%', '\\', '{}}{', '\\subfloat[a']) {
    assert.doesNotThrow(() => V.parse(t), t);
  }
  const big = DOC.repeat(40); const t0 = Date.now(); V.parse(big); assert.ok(Date.now() - t0 < 2000);
});
