// Benchmark data for the Detexify matcher: hand-drawn-style gestures (parametric, independent of the glyph data)
// and randomly distorted copies of the real glyph skeletons.
function rng(seed) { let a = (seed * 2654435761) >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

const line = (a, b, n = 24) => Array.from({ length: n + 1 }, (_, i) => ({ x: a[0] + (b[0] - a[0]) * i / n, y: a[1] + (b[1] - a[1]) * i / n }));
const arc = (cx, cy, rx, ry, t0, t1, n = 40) => Array.from({ length: n + 1 }, (_, i) => { const t = (t0 + (t1 - t0) * i / n) * Math.PI / 180; return { x: cx + rx * Math.cos(t), y: cy + ry * Math.sin(t) }; });
const poly = (...pts) => pts.slice(1).flatMap((p, i) => line(pts[i], p, 14));
const wave = (x0, x1, y, amp, n = 40) => Array.from({ length: n + 1 }, (_, i) => ({ x: x0 + (x1 - x0) * i / n, y: y - amp * Math.sin(i / n * Math.PI * 2) }));

// name -> [accepted commands, strokes]. y grows downwards, drawings are ~200px.
const G = {
  infty: [['\\infty'], [Array.from({ length: 81 }, (_, i) => { const t = i / 80 * 2 * Math.PI, d = 1 + Math.sin(t) ** 2; return { x: 100 * Math.cos(t) / d, y: 100 * Math.sin(t) * Math.cos(t) / d }; })]],
  sum: [['\\sum'], [poly([150, 0], [0, 0], [80, 100], [0, 200], [150, 200])]],
  alpha: [['\\alpha'], [[...arc(60, 60, 55, 50, -30, -330, 40), ...line([120, 120], [200, 60], 10)].reverse()]],
  rightarrow: [['\\rightarrow', '\\to'], [line([0, 100], [200, 100]), poly([150, 50], [200, 100], [150, 150])]],
  leftarrow: [['\\leftarrow', '\\gets'], [line([0, 100], [200, 100]), poly([50, 50], [0, 100], [50, 150])]],
  Rightarrow: [['\\Rightarrow', '\\implies'], [line([0, 80], [180, 80]), line([0, 120], [180, 120]), poly([140, 30], [200, 100], [140, 170])]],
  int: [['\\int'], [[...arc(95, 25, 35, 25, 0, -200, 14), ...line([95, 25], [55, 175], 28), ...arc(30, 175, 35, 25, 0, 200, 14)]]],
  forall: [['\\forall'], [poly([0, 0], [80, 200], [160, 0]), line([35, 90], [125, 90])]],
  exists: [['\\exists'], [poly([0, 0], [100, 0], [100, 200], [0, 200]), line([100, 100], [20, 100])]],
  in: [['\\in'], [[...arc(110, 100, 90, 100, -50, -310, 24).map((p) => ({ x: p.x, y: p.y }))], line([20, 100], [150, 100])]],
  cup: [['\\cup'], [[{ x: 0, y: 0 }, ...line([0, 0], [0, 110], 12), ...arc(90, 110, 90, 90, 180, 0, 24).map((p) => ({ x: p.x, y: p.y })), ...line([180, 110], [180, 0], 12)]]],
  cap: [['\\cap'], [[...line([0, 200], [0, 90], 12), ...arc(90, 90, 90, 90, 180, 360, 24), ...line([180, 90], [180, 200], 12)]]],
  pm: [['\\pm'], [line([100, 0], [100, 150]), line([30, 70], [170, 70]), line([30, 200], [170, 200])]],
  times: [['\\times'], [line([0, 0], [180, 180]), line([180, 0], [0, 180])]],
  nabla: [['\\nabla'], [poly([0, 0], [200, 0], [100, 190], [0, 0])]],
  emptyset: [['\\emptyset', '\\varnothing'], [arc(100, 100, 80, 80, 0, 360, 40), line([30, 190], [170, 10])]],
  approx: [['\\approx'], [wave(0, 200, 40, 20), wave(0, 200, 130, 20)]],
  neq: [['\\neq', '\\ne'], [line([0, 60], [200, 60]), line([0, 130], [200, 130]), line([150, 0], [50, 190])]],
  pi: [['\\pi'], [line([0, 30], [200, 30]), line([60, 30], [50, 180]), line([140, 30], [150, 180])]],
  theta: [['\\theta', '\\vartheta'], [arc(100, 100, 60, 100, 0, 360, 50), line([40, 100], [160, 100])]],
  leq: [['\\leq', '\\le', '\\leqslant'], [poly([180, 0], [0, 80], [180, 160]), line([0, 200], [180, 200])]],
  geq: [['\\geq', '\\ge', '\\geqslant'], [poly([0, 0], [180, 80], [0, 160]), line([0, 200], [180, 200])]],
  sqrt: [['\\surd', '\\sqrt'], [poly([0, 120], [30, 100], [70, 200], [140, 0], [300, 0])]],
  partial: [['\\partial'], [[...arc(90, 65, 70, 60, 20, -220, 26), ...line([20, 65], [20, 65], 1)].slice(0, 27), arc(90, 130, 70, 70, -90, 270, 40)]],
  sigma: [['\\sigma'], [[...arc(70, 100, 70, 80, 0, 360, 40)], poly([70, 20], [190, 20])]],
  lambda: [['\\lambda'], [line([0, 0], [140, 200]), line([60, 100], [0, 200])]],
  cdot: [['\\cdot'], [[{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 14, y: 12 }, { x: 0, y: 12 }].slice(0, 1).concat(line([0, 0], [14, 14], 6))]],
};
// two-stroke dot would be < 10px (rejected as "too small") -> drop it from the benchmark
delete G.cdot;

function jitterStrokes(strokes, seed, amount = 0.035) {
  const r = rng(seed); let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of strokes) for (const p of s) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  const span = Math.max(x1 - x0, y1 - y0), ang = (r() - 0.5) * 0.25, sx = 0.85 + r() * 0.3, sy = 0.85 + r() * 0.3, sh = (r() - 0.5) * 0.2;
  const ph = r() * 6, f1 = 2 + r() * 3, a1 = amount * span, ph2 = r() * 6;
  return strokes.map((s) => s.map((p, i) => {
    let x = (p.x - x0) * sx, y = (p.y - y0) * sy; x += sh * y;
    const c = Math.cos(ang), n = Math.sin(ang); const rx = x * c - y * n, ry = x * n + y * c;
    return { x: rx + a1 * Math.sin(i / f1 + ph) + (r() - 0.5) * a1 * 0.5, y: ry + a1 * Math.sin(i / f1 * 1.3 + ph2) + (r() - 0.5) * a1 * 0.5 };
  }));
}

// A distorted "hand drawn" version of a template skeleton (single-point strokes: the matcher resamples anyway).
function distortGlyph(sym, seed) {
  const pts = []; for (let i = 0; i < sym.p.length; i += 2) pts.push({ x: sym.p[i] * 3, y: sym.p[i + 1] * 3 });
  const r = rng(seed); const kept = pts.filter(() => r() > 0.15);
  return jitterStrokes([kept.map((p) => p)], seed + 7, 0.02).map((s) => s.map((p) => [p])).flat();
}

module.exports = { G, jitterStrokes, distortGlyph, rng };
