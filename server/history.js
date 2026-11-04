// Lightweight per-file version history: .history/<encoded path>/<timestamp>.snap
const fs = require('fs');
const path = require('path');
const { HISTORY, isTextFile, walkFiles } = require('./util');

const MAX_SNAPS = 100, MIN_GAP_MS = 30000, MAX_SIZE = 2 * 1024 * 1024;
const dirOf = (pdir, rel) => path.join(pdir, HISTORY, encodeURIComponent(rel));
const stamps = (d) => { try { return fs.readdirSync(d).filter((f) => f.endsWith('.snap')).map((f) => Number(f.slice(0, -5))).filter(Number.isFinite).sort((a, b) => a - b); } catch { return []; } };

function snapshot(pdir, rel, buf, { force = false } = {}) {
  if (!isTextFile(rel) || buf.length > MAX_SIZE) return false;
  const d = dirOf(pdir, rel);
  const ts = stamps(d);
  if (ts.length) {
    const last = ts[ts.length - 1];
    try { if (fs.readFileSync(path.join(d, last + '.snap')).equals(buf)) return false; } catch {}
    if (!force && Date.now() - last < MIN_GAP_MS) return false;
  }
  fs.mkdirSync(d, { recursive: true });
  let t = Date.now();
  if (ts.length && t <= ts[ts.length - 1]) t = ts[ts.length - 1] + 1;
  fs.writeFileSync(path.join(d, t + '.snap'), buf);
  for (const old of ts.slice(0, Math.max(0, ts.length + 1 - MAX_SNAPS))) fs.rmSync(path.join(d, old + '.snap'), { force: true });
  return true;
}

// Call before overwriting/deleting: guarantees a baseline exists, then (after write) call again for the new content.
const baseline = (pdir, rel, oldBuf) => { if (oldBuf && !stamps(dirOf(pdir, rel)).length) snapshot(pdir, rel, oldBuf, { force: true }); };
const list = (pdir, rel) => stamps(dirOf(pdir, rel)).reverse().map((ts) => ({ ts, size: fs.statSync(path.join(dirOf(pdir, rel), ts + '.snap')).size }));
const read = (pdir, rel, ts) => { const f = path.join(dirOf(pdir, rel), Number(ts) + '.snap'); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null; };

// Files that have history but no longer exist in the project
function deleted(pdir) {
  const base = path.join(pdir, HISTORY);
  if (!fs.existsSync(base)) return [];
  const live = new Set(walkFiles(pdir));
  const out = [];
  for (const enc of fs.readdirSync(base)) {
    let rel; try { rel = decodeURIComponent(enc); } catch { continue; }
    if (live.has(rel)) continue;
    const ts = stamps(path.join(base, enc));
    if (ts.length) out.push({ path: rel, ts: ts[ts.length - 1] });
  }
  return out.sort((a, b) => b.ts - a.ts);
}

module.exports = { snapshot, baseline, list, read, deleted };
