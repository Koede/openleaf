// Regression benchmark for the Detexify matcher (see tools/tune-matcher.js for how the weights were chosen).
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('fs'), path = require('path');
const { G, jitterStrokes, distortGlyph } = require('./drawings.js');

let M, syms;
test.before(async () => {
  M = await import('../src/matcher.js');
  syms = M.prepareSymbols(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'symbols', 'symbols.json'), 'utf8')).symbols);
});
const rank = (strokes, accept) => { const r = M.classify(strokes, syms, M.WEIGHTS, 600); const i = r.findIndex((x) => accept.includes(x.s.c)); return i < 0 ? 999 : i + 1; };

test('clean hand-drawn gestures land in the top results', () => {
  for (const name of ['infty', 'pm', 'times', 'forall', 'exists', 'cup', 'cap', 'approx', 'leq', 'geq', 'Rightarrow', 'in'])
    assert.ok(rank(G[name][1], G[name][0]) <= 3, `${name} should be in the top 3`);
});

test('wobbly, rotated and sheared gestures still mostly match (top 5)', () => {
  let n = 0, hit = 0;
  for (const [name, [acc, strokes]] of Object.entries(G)) for (let k = 1; k <= 3; k++) { n++; if (rank(jitterStrokes(strokes, 100 + k), acc) <= 5) hit++; }
  assert.ok(hit / n >= 0.75, `top-5 rate ${(hit / n).toFixed(2)} fell below 0.75`);
});

test('distorted copies of the real glyphs are recognised', () => {
  let n = 0, top1 = 0, top5 = 0;
  for (let i = 0; i < syms.length; i += 4) { n++; const r = rank(distortGlyph(syms[i], i + 1), [syms[i].c]); if (r === 1) top1++; if (r <= 5) top5++; }
  assert.ok(top1 / n >= 0.82, `top-1 ${(top1 / n).toFixed(2)} fell below 0.82`);
  assert.ok(top5 / n >= 0.96, `top-5 ${(top5 / n).toFixed(2)} fell below 0.96`);
});

test('tiny scribbles are rejected and results are de-duplicated by command', () => {
  assert.equal(M.classify([[{ x: 0, y: 0 }, { x: 3, y: 3 }]], syms), null);
  const r = M.classify(G.sum[1], syms, M.WEIGHTS, 12); assert.equal(new Set(r.map((x) => x.s.c)).size, r.length);
});
