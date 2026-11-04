#!/usr/bin/env node
// Grid-searches the matcher weights (src/matcher.js WEIGHTS) against the benchmark in test/drawings.js.
// Usage: node tools/tune-matcher.js [--glyphs N]
const fs = require('fs'), path = require('path');
const { G, jitterStrokes, distortGlyph } = require('../test/drawings.js');

(async () => {
  const M = await import('../src/matcher.js');
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'symbols', 'symbols.json'), 'utf8'));
  const syms = M.prepareSymbols(data.symbols);
  const gi = process.argv.indexOf('--glyphs'), nGlyph = gi < 0 ? 160 : +process.argv[gi + 1];

  // queries: [{name, accept:Set, strokes, kind}]
  const Q = [];
  for (const [name, [acc, strokes]] of Object.entries(G)) for (let k = 0; k < 4; k++) Q.push({ kind: 'gesture', name, accept: new Set(acc), strokes: k ? jitterStrokes(strokes, 100 + k) : strokes });
  const step = Math.max(1, Math.floor(syms.length / nGlyph));
  for (let i = 0; i < syms.length; i += step) Q.push({ kind: 'glyph', name: syms[i].c, accept: new Set([syms[i].c]), strokes: distortGlyph(syms[i], i + 1) });

  // raw feature matrices; the chamfer term depends on the orientation weight, so they are rebuilt per value of it
  let feats = null;
  const build = (mu) => { feats = Q.map((q) => {
    const u = M.strokesToPoints(q.strokes); if (!u) return null;
    return syms.map((s) => {
      let hd = 0; for (let i = 0; i < u.h.length; i++) hd += Math.abs(u.h[i] - s.h[i]);
      return [M.chamfer(u, s, mu), Math.min(1.2, Math.abs(Math.log(u.aspect / s.a))), Math.min(1.5, Math.abs(Math.log((u.f.length / 2) / s.n))), hd * 0.1];
    });
  }); };

  function evaluate(w) {
    const r = { gesture: { n: 0, t1: 0, t3: 0, t5: 0, mrr: 0 }, glyph: { n: 0, t1: 0, t3: 0, t5: 0, mrr: 0 } };
    Q.forEach((q, qi) => {
      const F = feats[qi]; if (!F) return;
      const best = new Map();
      F.forEach((f, i) => { const d = f[0] + f[1] * w.aspect + f[2] * w.ink + f[3] * w.hist; const c = syms[i].c; if (!best.has(c) || d < best.get(c)) best.set(c, d); });
      const order = [...best.entries()].sort((a, b) => a[1] - b[1]).map((e) => e[0]);
      const rank = order.findIndex((c) => q.accept.has(c)) + 1; const t = r[q.kind];
      t.n++; if (rank === 1) t.t1++; if (rank && rank <= 3) t.t3++; if (rank && rank <= 5) t.t5++; t.mrr += rank ? 1 / rank : 0;
    });
    for (const k of Object.keys(r)) { const t = r[k]; for (const m of ['t1', 't3', 't5', 'mrr']) t[m] = +(t[m] / t.n).toFixed(3); }
    return r;
  }

  const show = (label, w) => { const r = evaluate(w); console.log(label.padEnd(10), JSON.stringify(w), 'gesture', JSON.stringify(r.gesture), 'glyph', JSON.stringify(r.glyph)); return r; };
  build(0); show('baseline', { aspect: 0.05, ink: 0, hist: 0, orient: 0 });
  let best = null;
  for (const orient of [0.6, 1, 1.5, 2.5]) {
    build(orient);
    for (const aspect of [0, 0.05, 0.1]) for (const ink of [0, 0.05, 0.1]) for (const hist of [0, 0.5, 1.5]) {
      const w = { aspect, ink, hist, orient }; const r = evaluate(w);
      const obj = r.gesture.mrr * 0.6 + r.glyph.mrr * 0.4;
      if (!best || obj > best.obj) best = { obj, w, r };
    }
    const wo = { aspect: 0.05, ink: 0, hist: 0, orient }; const r0 = evaluate(wo); console.log('orient', orient, 'gesture', JSON.stringify(r0.gesture), 'glyph', JSON.stringify(r0.glyph));
  }
  build(best.w.orient);
  console.log('\nbest', JSON.stringify(best.w), 'obj', best.obj.toFixed(4), '\n  gesture', JSON.stringify(best.r.gesture), '\n  glyph  ', JSON.stringify(best.r.glyph));

  // per-gesture ranks at the best weights, to spot specific failures
  const w = best.w; const rows = [];
  Q.forEach((q, qi) => {
    if (q.kind !== 'gesture' || !feats[qi]) return;
    const bestD = new Map(); feats[qi].forEach((f, i) => { const d = f[0] + f[1] * w.aspect + f[2] * w.ink + f[3] * w.hist; const c = syms[i].c; if (!bestD.has(c) || d < bestD.get(c)) bestD.set(c, d); });
    const order = [...bestD.entries()].sort((a, b) => a[1] - b[1]).map((e) => e[0]);
    rows.push([q.name, order.findIndex((c) => q.accept.has(c)) + 1, order.slice(0, 3).join(' ')]);
  });
  const agg = {}; rows.forEach(([n, r, top]) => { (agg[n] ||= { ranks: [], top }).ranks.push(r); });
  for (const [n, a] of Object.entries(agg)) console.log(n.padEnd(11), 'ranks', a.ranks.join(','), '  top3(first):', a.top);
})();
