// Browser-only build: the real UI running against an in-memory "server" (no TeX, so no compiling).
import { toast } from './ui.js';
import templates from './demo-data.json';
import extra from './demo-extra.json';
import symbolsJson from './demo-symbols.json';
import { spriteUrl, tplUrl } from './demo-assets.js';

window.__DEMO = true;
window.__symUrl = (n) => (n === 'templates' ? tplUrl : spriteUrl);

const projects = new Map();   // name -> {files:Map, settings, hist:Map, mtime}
const mkProject = (tid) => { const t = templates.find((x) => x.id === tid) || templates.find((x) => x.id === 'blank'); return { files: new Map(Object.entries(t.files)), settings: { main: 'main.tex', engine: 'pdflatex', haltOnError: false }, hist: new Map(), mtime: Date.now() }; };
projects.set('my-first-project', mkProject('article'));
if (extra) projects.set(extra.name, { files: new Map(Object.entries(extra.files)), settings: { main: extra.main, engine: 'pdflatex', haltOnError: false }, hist: new Map(), mtime: Date.now() });

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
const err = (m, s = 400) => json({ error: m }, s);
const text = (t) => new Response(t, { headers: { 'content-type': 'text/plain' } });
const isTex = (f) => /\.tex$/.test(f);
function tree(P) {
  const root = [];
  const dir = (parts, nodes, base = '') => { const n = parts[0]; const path = base ? base + '/' + n : n; let d = nodes.find((x) => x.name === n && x.type === 'dir'); if (!d) { d = { name: n, path, type: 'dir', children: [] }; nodes.push(d); } return parts.length > 1 ? dir(parts.slice(1), d.children, path) : d; };
  for (const [f, c] of P.files) { const parts = f.split('/'); const nm = parts.pop(); const nodes = parts.length ? dir(parts, root).children : root; nodes.push({ name: nm, path: f, type: 'file', size: c.length }); }
  for (const d of P.dirs || []) dir(d.split('/'), root);
  const sort = (a) => { a.sort((x, y) => (x.type === y.type ? x.name.localeCompare(y.name, undefined, { numeric: true }) : x.type === 'dir' ? -1 : 1)); a.forEach((n) => n.children && sort(n.children)); };
  sort(root); return root;
}
const candidates = (P) => [...P.files].filter(([f, c]) => isTex(f) && /\\begin\{document\}/.test(c)).map(([f]) => f);
const snap = (P, f, c, force) => { const l = P.hist.get(f) || []; if (l.length && l[0].c === c) return; if (!force && l.length && Date.now() - l[0].ts < 30000) return; l.unshift({ ts: Math.max(Date.now(), (l[0]?.ts || 0) + 1), c }); P.hist.set(f, l.slice(0, 60)); };
function build({ query, regex, caseSensitive, wholeWord }) { if (!query) throw new Error('Empty search'); let src = regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); if (wholeWord) src = `\\b(?:${src})\\b`; return new RegExp(src, caseSensitive ? 'g' : 'gi'); }
function wc(P, main) {
  const seen = new Set(); let w = 0;
  const go = (f) => { if (seen.has(f) || !P.files.has(f)) return; seen.add(f); let t = P.files.get(f).replace(/(^|[^\\])%.*$/gm, '$1'); for (const m of t.matchAll(/\\(?:input|include)\{([^}]+)\}/g)) go(m[1].endsWith('.tex') ? m[1] : m[1] + '.tex'); const b = t.split('\\begin{document}')[1] ?? t; w += (b.replace(/\\[a-zA-Z]+\*?(\[[^\]]*\])?/g, ' ').replace(/[{}$&_^~\\]/g, ' ').match(/[A-Za-z]{2,}/g) || []).length; };
  go(main); return { words: w, files: [...seen] };
}

async function handle(url, init = {}) {
  const u = new URL(url, location.href); const path = u.pathname; const q = u.searchParams; const method = (init.method || 'GET').toUpperCase();
  let body = {}; if (typeof init.body === 'string') { try { body = JSON.parse(init.body); } catch {} }
  if (path === '/symbols/symbols.json') return json(symbolsJson);
  if (!path.startsWith('/api/')) return null;
  const parts = path.slice(5).split('/').map(decodeURIComponent);
  if (parts[0] === 'feedback') return err('Sending feedback needs the openleaf server; use "Open on GitHub" instead.', 503);
  if (parts[0] === 'projects') {
    if (parts.length === 1 && method === 'GET') return json({ projects: [...projects.keys()].sort(), details: [...projects].map(([name, p]) => ({ name, mtime: p.mtime })), synctex: false, latexmk: true, templates: templates.map(({ id, name, description }) => ({ id, name, description })) });
    if (parts.length === 1 && method === 'POST') { if (projects.has(body.name)) return err('A project with that name already exists', 409); projects.set(body.name, mkProject(body.template)); return json({ ok: true }); }
    const name = parts[1], P = projects.get(name); if (!P) return err('Project not found', 404);
    if (parts[2] === 'rename') { if (projects.has(body.to)) return err('A project with that name already exists', 409); projects.delete(name); projects.set(body.to, P); return json({ ok: true }); }
    if (parts[2] === 'copy') { if (projects.has(body.to)) return err('A project with that name already exists', 409); projects.set(body.to, { ...P, files: new Map(P.files), hist: new Map(), settings: { ...P.settings } }); return json({ ok: true }); }
    if (method === 'DELETE') { projects.delete(name); return json({ ok: true }); }
  }
  if (parts[0] === 'p') {
    const P = projects.get(parts[1]); if (!P) return err('Project not found', 404); const act = parts.slice(2).join('/');
    if (act === 'settings') { if (method === 'PUT') { Object.assign(P.settings, body); return json({ ok: true }); } const c = candidates(P); const main = P.settings.main && P.files.has(P.settings.main) ? P.settings.main : c[0] || null; return json({ ...P.settings, main, candidates: c }); }
    if (act === 'tree') return json({ tree: tree(P), main: candidates(P)[0] || null, candidates: candidates(P) });
    if (act === 'raw') { const f = q.get('path'); return P.files.has(f) ? text(P.files.get(f)) : err('Not found', 404); }
    if (act === 'file') { const old = P.files.get(body.path); if (old != null) snap(P, body.path, old, true); P.files.set(body.path, body.content); snap(P, body.path, body.content); P.mtime = Date.now(); return json({ ok: true }); }
    if (act === 'ops') {
      const { op, path: p, to } = body;
      if (op === 'create') { if (P.files.has(p)) return err('Already exists', 409); P.files.set(p, ''); }
      else if (op === 'mkdir') { (P.dirs ||= new Set()).add(p); }
      else if (op === 'rename') { if (P.files.has(to)) return err('Target already exists', 409); for (const [f, c] of [...P.files]) if (f === p || f.startsWith(p + '/')) { P.files.delete(f); P.files.set(to + f.slice(p.length), c); } }
      else if (op === 'delete') { for (const [f, c] of [...P.files]) if (f === p || f.startsWith(p + '/')) { snap(P, f, c, true); P.files.delete(f); (P.deleted ||= new Map()).set(f, Date.now()); } }
      return json({ ok: true });
    }
    if (act === 'upload') { return err('Uploading is disabled in this standalone page — run the server to use it.', 400); }
    if (act === 'history') return json({ versions: (P.hist.get(q.get('path')) || []).map((v) => ({ ts: v.ts, size: v.c.length })) });
    if (act === 'history/deleted') return json({ files: [...(P.deleted || [])].filter(([f]) => !P.files.has(f)).map(([f]) => ({ path: f, ts: (P.hist.get(f) || [{ ts: Date.now() }])[0].ts })) });
    if (act === 'history/content') { const v = (P.hist.get(q.get('path')) || []).find((x) => x.ts === Number(q.get('ts'))); return v ? text(v.c) : err('Version not found', 404); }
    if (act === 'history/restore') { const v = (P.hist.get(body.path) || []).find((x) => x.ts === Number(body.ts)); if (!v) return err('Version not found', 404); if (P.files.has(body.path)) snap(P, body.path, P.files.get(body.path), true); P.files.set(body.path, v.c); return json({ ok: true, content: v.c }); }
    if (act === 'search' || act === 'replace') {
      let re; try { re = build(body); } catch (e) { return err(e.message); }
      if (act === 'search') { const matches = []; for (const [f, c] of P.files) { if (!/\.(tex|bib|sty|cls|txt|md)$/.test(f)) continue; c.split('\n').forEach((l, i) => { re.lastIndex = 0; for (const m of l.matchAll(re)) if (m[0] && matches.length < 500) matches.push({ file: f, line: i + 1, col: m.index, len: m[0].length, text: l, off: 0 }); }); } return json({ matches, truncated: matches.length >= 500 }); }
      const rep = body.regex ? String(body.replacement ?? '') : String(body.replacement ?? '').replace(/\$/g, '$$$$'); const changed = [];
      for (const [f, c] of P.files) { if (!/\.(tex|bib|sty|cls|txt|md)$/.test(f)) continue; let n = 0; re.lastIndex = 0; const out = c.replace(re, (...a) => { n++; return a[0] ? rep.replace(/\$(\d)/g, (_, d) => a[Number(d)] ?? '') : a[0]; }); if (n) { snap(P, f, c, true); P.files.set(f, body.regex ? out : c.replace(re, rep)); changed.push({ file: f, count: n }); } }
      return json({ ok: true, changed });
    }
    if (act === 'wordcount') return json(wc(P, q.get('main') || P.settings.main || candidates(P)[0]));
    if (act === 'compile') return json({ superseded: true });
    if (act === 'clean') return json({ ok: true });
  }
  return err('Not available in the standalone page', 404);
}
const realFetch = window.fetch.bind(window);
window.fetch = async (url, init) => { const r = await handle(typeof url === 'string' ? url : url.url, init); return r || realFetch(url, init); };

class FakeWS { constructor() { this.readyState = 1; setTimeout(() => this.onopen && this.onopen(), 0); } send() {} close() {} }
window.WebSocket = FakeWS;

await import('./main.js');
document.getElementById('pdfEmpty').innerHTML = '<div><b>PDF preview needs the server</b><br>Browsers can’t run LaTeX, so this page is the editor half: files, symbols &amp; templates, Detexify, outline, search and history.<br>Run the LaTeX Studio server for live compiling.</div>';
document.getElementById('dlBtn').hidden = true;
document.getElementById('uploadBtn').hidden = true;

const note = () => toast('Compiling needs the LaTeX Studio server — this page is the editor, symbol palette and Detexify.', { ms: 4500 });
document.getElementById('compileBtn').addEventListener('click', note);
document.getElementById('tbSync').addEventListener('click', note);
