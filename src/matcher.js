// Pure hand-drawing matcher used by the Detexify tab (no DOM, so it can be unit-tested and tuned in node).
// A drawing is reduced to a normalised skeleton point set and compared with the point sets that
// tools/gen-symbols.py extracted from the rendered glyphs.
export const GRID = 20;
const HB = 6; // coarse density histogram resolution

// Weights tuned with tools/tune-matcher.js on a synthetic + parametric drawing benchmark.
export const WEIGHTS = { aspect: 0.05, ink: 0.05, hist: 0, orient: 0.6 };

export function histogram(f) {
  const h = new Float32Array(HB * HB), n = f.length / 2;
  for (let i = 0; i < n; i++) {
    const x = Math.min(HB - 1, Math.floor(f[2 * i] * HB)), y = Math.min(HB - 1, Math.floor(f[2 * i + 1] * HB));
    h[x * HB + y] += 1 / n;
  }
  return h;
}

// Local stroke direction at every skeleton point (doubled-angle encoding so 0° and 180° agree) + how line-like it is.
const ORIENT_R = 0.13;
export function orientations(f) {
  const n = f.length / 2, o = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    let c = 0, mx = 0, my = 0;
    for (let j = 0; j < n; j++) { const dx = f[2 * j] - f[2 * i], dy = f[2 * j + 1] - f[2 * i + 1]; if (dx * dx + dy * dy <= ORIENT_R * ORIENT_R) { c++; mx += f[2 * j]; my += f[2 * j + 1]; } }
    mx /= c; my /= c; let sxx = 0, sxy = 0, syy = 0;
    for (let j = 0; j < n; j++) { const dx = f[2 * j] - f[2 * i], dy = f[2 * j + 1] - f[2 * i + 1]; if (dx * dx + dy * dy <= ORIENT_R * ORIENT_R) { const ax = f[2 * j] - mx, ay = f[2 * j + 1] - my; sxx += ax * ax; sxy += ax * ay; syy += ay * ay; } }
    const a = sxx - syy, b = 2 * sxy, m = Math.hypot(a, b), tr = sxx + syy;
    if (c < 3 || tr < 1e-9) { o[3 * i + 2] = 0; continue; }
    o[3 * i] = a / (m || 1); o[3 * i + 1] = b / (m || 1); o[3 * i + 2] = m / tr; // cos2θ, sin2θ, coherence
  }
  return o;
}

// Convert strokes ([{x,y}…][]) to a normalised point set, exactly like the generator does for rendered glyphs.
export function strokesToPoints(strokes) {
  const pts = [];
  for (const s of strokes) {
    if (!s.length) continue;
    for (let i = 1; i < s.length; i++) {
      const a = s[i - 1], b = s[i];
      const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 2));
      for (let k = 0; k < n; k++) pts.push({ x: a.x + (b.x - a.x) * k / n, y: a.y + (b.y - a.y) * k / n });
    }
    pts.push(s[s.length - 1]);
  }
  if (!pts.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  const w = x1 - x0, h = y1 - y0, span = Math.max(w, h);
  if (span < 10) return null;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2; const cells = new Map();
  for (const p of pts) {
    const u = (p.x - cx) / span + 0.5, v = (p.y - cy) / span + 0.5;
    const key = Math.min(GRID - 1, Math.floor(u * GRID)) * 100 + Math.min(GRID - 1, Math.floor(v * GRID));
    const c = cells.get(key); if (c) { c.u += u; c.v += v; c.n++; } else cells.set(key, { u, v, n: 1 });
  }
  const arr = []; for (const c of cells.values()) arr.push(c.u / c.n, c.v / c.n);
  const f = Float32Array.from(arr);
  return { f, o: orientations(f), aspect: (w + 1) / (h + 1), h: histogram(f) };
}

// Oriented chamfer distance between two point sets {f,o}: nearest neighbour under position + stroke-direction cost, both ways.
export function chamfer(A, B, mu = WEIGHTS.orient) {
  const a = A.f, b = B.f, oa = A.o, ob = B.o, na = a.length / 2, nb = b.length / 2; let s1 = 0, s2 = 0; const mb = new Float32Array(nb).fill(1e9);
  for (let i = 0; i < na; i++) {
    const ax = a[2 * i], ay = a[2 * i + 1], ac = oa[3 * i], as = oa[3 * i + 1], ak = oa[3 * i + 2]; let best = 1e9;
    for (let j = 0; j < nb; j++) {
      const dx = ax - b[2 * j], dy = ay - b[2 * j + 1];
      let d = Math.sqrt(dx * dx + dy * dy);
      if (mu) { const k = Math.min(ak, ob[3 * j + 2]); if (k > 0) d += mu * k * (1 - ac * ob[3 * j] - as * ob[3 * j + 1]) * 0.5; }
      if (d < best) best = d; if (d < mb[j]) mb[j] = d;
    }
    s1 += best;
  }
  for (let j = 0; j < nb; j++) s2 += mb[j];
  s1 /= na; s2 /= nb;
  return 0.5 * (s1 + s2) + 0.25 * Math.max(s1, s2);
}

// Adds the typed-array fields the matcher needs to each symbol of symbols.json.
export function prepareSymbols(symbols) {
  for (const s of symbols) { s.f = Float32Array.from(s.p, (v) => v / 100); s.o = orientations(s.f); s.h = histogram(s.f); s.n = s.f.length / 2; }
  return symbols;
}

export function score(u, s, w = WEIGHTS) {
  let hd = 0; for (let i = 0; i < u.h.length; i++) hd += Math.abs(u.h[i] - s.h[i]);
  return chamfer(u, s, w.orient)
    + Math.min(1.2, Math.abs(Math.log(u.aspect / s.a))) * w.aspect
    + Math.min(1.5, Math.abs(Math.log((u.f.length / 2) / s.n))) * w.ink
    + hd * w.hist * 0.1;
}

export function classify(strokes, symbols, w = WEIGHTS, limit = 12) {
  const u = strokesToPoints(strokes); if (!u || !symbols) return null;
  const res = symbols.map((s) => ({ s, d: score(u, s, w) }));
  res.sort((a, b) => a.d - b.d);
  const seen = new Set(), out = [];
  for (const r of res) { const k = r.s.c; if (seen.has(k)) continue; seen.add(k); out.push(r); if (out.length >= limit) break; }
  return out;
}
