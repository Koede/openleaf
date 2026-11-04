const test = require('node:test');
const assert = require('node:assert');
const { parseLog, parseBlg } = require('../server/logparser');

const LOG = `This is pdfTeX
(./main.tex
LaTeX2e <2023-11-01>
(/usr/share/texlive/texmf-dist/tex/latex/base/article.cls
Document Class: article 2023/05/17 v1.4n Standard LaTeX document class
(/usr/share/texlive/texmf-dist/tex/latex/base/size11.clo))
(./preamble.tex)
(./chapters/01-introduction.tex
./chapters/01-introduction.tex:2: Undefined control sequence.
l.2 Hello \\badmacro
                   here.
LaTeX Warning: Reference \`eq:foo' on page 1 undefined on input line 4.
)
(./chapters/02-methods.tex
Overfull \\hbox (12.0pt too wide) in paragraph at lines 7--8
LaTeX Warning: Citation \`nokey' on page 1 undefined on input line 9.
)
! LaTeX Error: File \`nosuch.sty' not found.
LaTeX Warning: There were undefined references.
Output written on main.pdf (3 pages, 1234 bytes).
`;

test('file-line-error errors keep their file and line, with context', () => {
  const e = parseLog(LOG, 'main.tex').filter((i) => i.type === 'error');
  assert.strictEqual(e[0].file, 'chapters/01-introduction.tex');
  assert.strictEqual(e[0].line, 2);
  assert.match(e[0].message, /Undefined control sequence/);
  assert.ok(e[0].hint);
});

test('warnings are attributed to the file TeX was reading (paren stack)', () => {
  const w = parseLog(LOG, 'main.tex').filter((i) => i.type === 'warning');
  const ref = w.find((x) => /eq:foo/.test(x.message));
  const cite = w.find((x) => /nokey/.test(x.message));
  assert.deepStrictEqual([ref.file, ref.line], ['chapters/01-introduction.tex', 4]);
  assert.deepStrictEqual([cite.file, cite.line], ['chapters/02-methods.tex', 9]);
  assert.ok(!/on input line/.test(ref.message));
});

test('overfull boxes are located; system files are never blamed', () => {
  const b = parseLog(LOG, 'main.tex').find((i) => i.type === 'badbox');
  assert.deepStrictEqual([b.file, b.line], ['chapters/02-methods.tex', 7]);
});

test('missing package gets an install hint', () => {
  const e = parseLog(LOG, 'main.tex').find((i) => /nosuch/.test(i.message));
  assert.match(e.hint, /tlmgr install nosuch/);
});

test('identical issues are de-duplicated and TeX follow-up noise dropped', () => {
  const log = './a.tex:1: Boom.\nl.1 x\n./a.tex:1: Boom.\nl.1 x\n! Emergency stop.\n==> Fatal error occurred, no output PDF file produced!\n';
  const issues = parseLog(log, 'a.tex');
  assert.strictEqual(issues.filter((i) => i.type === 'error').length, 1);
});

test('bibtex warnings and errors', () => {
  const blg = 'Warning--I didn\'t find a database entry for "ghost"\nI was expecting a `,\' or a `}\'\n---line 5 of file refs.bib\n';
  const i = parseBlg(blg);
  assert.ok(i.some((x) => x.type === 'warning' && /ghost/.test(x.message)));
  assert.ok(i.some((x) => x.type === 'error' && x.file === 'refs.bib' && x.line === 5));
});
