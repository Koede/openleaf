const fs = require('fs');
const path = require('path');
const { walkFiles, isTextFile, httpErr, atomicWrite } = require('./util');
const history = require('./history');

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function build({ query, regex, caseSensitive, wholeWord }) {
  if (!query) throw httpErr(400, 'Empty search');
  let src = regex ? query : escRe(query);
  if (wholeWord) src = `\\b(?:${src})\\b`;
  try { return new RegExp(src, caseSensitive ? 'g' : 'gi'); } catch (e) { throw httpErr(400, 'Invalid regular expression: ' + e.message); }
}
const textFiles = (pdir) => walkFiles(pdir).filter((f) => isTextFile(f) && fs.statSync(path.join(pdir, f)).size < 2 * 1024 * 1024);

function search(pdir, opts, limit = 500) {
  const re = build(opts);
  const matches = []; let truncated = false;
  outer: for (const f of textFiles(pdir)) {
    const lines = fs.readFileSync(path.join(pdir, f), 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      re.lastIndex = 0;
      for (const m of lines[i].matchAll(re)) {
        if (!m[0]) continue;
        if (matches.length >= limit) { truncated = true; break outer; }
        matches.push({ file: f, line: i + 1, col: m.index, len: m[0].length, text: lines[i].length > 300 ? lines[i].slice(Math.max(0, m.index - 100), m.index + 200) : lines[i], off: lines[i].length > 300 ? Math.max(0, m.index - 100) : 0 });
      }
    }
  }
  return { matches, truncated };
}

function replaceAll(pdir, opts, replacement, files) {
  const re = build(opts);
  const rep = opts.regex ? replacement : String(replacement).replace(/\$/g, '$$$$');
  const only = files ? new Set(files) : null;
  const changed = [];
  for (const f of textFiles(pdir)) {
    if (only && !only.has(f)) continue;
    const abs = path.join(pdir, f);
    const old = fs.readFileSync(abs);
    const text = old.toString('utf8');
    let n = 0;
    text.replace(re, (m) => { if (m) n++; return m; });
    const out = text.replace(re, rep);
    if (n && out !== text) { history.baseline(pdir, f, old); atomicWrite(abs, out); history.snapshot(pdir, f, Buffer.from(out), { force: true }); changed.push({ file: f, count: n }); }
  }
  return { changed };
}

module.exports = { search, replaceAll };
