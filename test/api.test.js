const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const { start } = require('../server/index');

let srv, base, root;
const J = { 'content-type': 'application/json' };
const api = async (p, o = {}) => { const r = await fetch(base + p, { ...o, headers: { ...(o.json ? J : {}), ...(o.headers || {}) }, body: o.json ? JSON.stringify(o.json) : o.body }); const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = t; } return { status: r.status, data: d }; };
const put = (p, content, proj = 'demo') => api(`/api/p/${proj}/file`, { method: 'PUT', json: { path: p, content } });

test.before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-api-'));
  srv = await start({ port: 0, root, quiet: true });
  base = `http://127.0.0.1:${srv.port}`;
  await api('/api/projects', { method: 'POST', json: { name: 'demo', template: 'article' } });
});
test.after(async () => { await srv.close(); fs.rmSync(root, { recursive: true, force: true }); });

test('template project compiles; citations and cross-refs resolve; sub-file included', async () => {
  const { data: r } = await api('/api/p/demo/compile', { method: 'POST', json: {} });
  assert.ok(r.ok, JSON.stringify(r.issues));
  assert.strictEqual(r.main, 'main.tex'); assert.ok(r.pages >= 1);
  assert.deepStrictEqual(r.issues.filter((i) => i.type !== 'badbox'), []);
  const pdf = await fetch(base + '/api/p/demo/output.pdf'); assert.strictEqual(pdf.status, 200);
  assert.strictEqual((await pdf.arrayBuffer()).byteLength > 1000, true);
});

test('errors in a sub-file are reported with that file and line; last good PDF is kept', async () => {
  await put('chapters/02-methods.tex', '\\section{M}\nok\n\\oops\n');
  const { data: r } = await api('/api/p/demo/compile', { method: 'POST', json: {} });
  const e = r.issues.find((i) => i.type === 'error');
  assert.deepStrictEqual([e.file, e.line], ['chapters/02-methods.tex', 3]);
  assert.strictEqual((await fetch(base + '/api/p/demo/output.pdf')).status, 200);
  await put('chapters/02-methods.tex', '\\section{M}\nfixed\n');
});

test('warnings carry the right file (paren-stack attribution) end-to-end', async () => {
  await put('chapters/01-introduction.tex', '\\section{I}\nSee \\ref{nope}.\n');
  const { data: r } = await api('/api/p/demo/compile', { method: 'POST', json: {} });
  const w = r.issues.find((i) => i.type === 'warning' && /nope/.test(i.message));
  assert.deepStrictEqual([w.file, w.line], ['chapters/01-introduction.tex', 2]);
});

test('paranoid file access: \\input of a file outside the project is blocked', async () => {
  const secret = path.join(root, 'secret.tex'); fs.writeFileSync(secret, 'TOPSECRETVALUE');
  await put('main.tex', `\\documentclass{article}\\begin{document}\\input{${secret.replace(/\\/g, '/')}}\\end{document}`);
  const { data: r } = await api('/api/p/demo/compile', { method: 'POST', json: {} });
  assert.ok(r.issues.some((i) => i.type === 'error') || !r.log.includes('TOPSECRETVALUE'));
  const pdfTxt = r.hasPdf ? require('child_process').spawnSync('pdftotext', [path.join(root, 'demo/.build/main.pdf'), '-'], { encoding: 'utf8' }).stdout : '';
  assert.ok(!pdfTxt.includes('TOPSECRETVALUE'));
  await api('/api/projects/demo/../x', { method: 'DELETE' });
});

test('path traversal, hidden dirs and symlinks are rejected', async () => {
  for (const p of ['../../etc/passwd', '.build/main.log', '.history/x']) assert.strictEqual((await api('/api/p/demo/raw?path=' + encodeURIComponent(p))).status, 400, p);
  assert.notStrictEqual((await api('/api/p/demo/raw?path=' + encodeURIComponent('/etc/passwd'))).status, 200); // treated as project-relative
  assert.strictEqual((await put('../evil.txt', 'x')).status, 400);
  fs.symlinkSync('/etc', path.join(root, 'demo', 'etc-link'));
  assert.strictEqual((await api('/api/p/demo/raw?path=etc-link/passwd')).status, 400);
  const tree = await api('/api/p/demo/tree'); assert.ok(!JSON.stringify(tree.data.tree).includes('etc-link'));
});

test('DNS-rebinding (bad Host) and cross-origin writes are blocked', async () => {
  const get = (host) => new Promise((res) => http.get({ host: '127.0.0.1', port: srv.port, path: '/api/projects', headers: { host } }, (r) => { r.resume(); res(r.statusCode); }));
  assert.strictEqual(await get('evil.example.com'), 403);
  assert.strictEqual(await get(`localhost:${srv.port}`), 200);
  const r = await fetch(base + '/api/p/demo/file', { method: 'PUT', headers: { ...J, origin: 'http://evil.example.com' }, body: JSON.stringify({ path: 'a.tex', content: 'x' }) });
  assert.strictEqual(r.status, 403);
});

test('supersede: a newer compile cancels the running one', async () => {
  await put('main.tex', '\\documentclass{article}\\begin{document}' + 'word '.repeat(20000) + '\\end{document}');
  const a = api('/api/p/demo/compile', { method: 'POST', json: {} });
  await new Promise((r) => setTimeout(r, 400));
  await put('main.tex', '\\documentclass{article}\\begin{document}second\\end{document}');
  const b = await api('/api/p/demo/compile', { method: 'POST', json: {} });
  assert.strictEqual((await a).data.superseded, true); assert.ok(b.data.ok);
});

test('history: baseline + restore; deleted files are recoverable', async () => {
  await put('notes.tex', 'v1'); await put('notes.tex', 'v2');
  const h = await api('/api/p/demo/history?path=notes.tex');
  assert.ok(h.data.versions.length >= 1);
  const oldest = h.data.versions[h.data.versions.length - 1];
  assert.strictEqual((await api(`/api/p/demo/history/content?path=notes.tex&ts=${oldest.ts}`)).data, 'v1');
  await api('/api/p/demo/ops', { method: 'POST', json: { op: 'delete', path: 'notes.tex' } });
  const del = await api('/api/p/demo/history/deleted'); assert.ok(del.data.files.some((f) => f.path === 'notes.tex'));
  const rs = await api('/api/p/demo/history/restore', { method: 'POST', json: { path: 'notes.tex', ts: oldest.ts } });
  assert.strictEqual(rs.data.content, 'v1'); assert.strictEqual(fs.readFileSync(path.join(root, 'demo/notes.tex'), 'utf8'), 'v1');
});

test('search & replace across files (literal, regex, whole word)', async () => {
  await put('a.tex', 'foo Foo food\nfoo'); await put('b.tex', 'a.b a+b');
  let r = (await api('/api/p/demo/search', { method: 'POST', json: { query: 'foo', wholeWord: true, caseSensitive: true } })).data;
  assert.deepStrictEqual(r.matches.map((m) => [m.file, m.line, m.col]), [['a.tex', 1, 0], ['a.tex', 2, 0]]);
  r = (await api('/api/p/demo/search', { method: 'POST', json: { query: 'a.b' } })).data; assert.strictEqual(r.matches.length, 1); // literal dot
  r = (await api('/api/p/demo/search', { method: 'POST', json: { query: 'a.b', regex: true } })).data; assert.strictEqual(r.matches.length, 2); // '.' matches '+'
  assert.strictEqual((await api('/api/p/demo/search', { method: 'POST', json: { query: '(', regex: true } })).status, 400);
  await api('/api/p/demo/replace', { method: 'POST', json: { query: 'foo', replacement: 'bar$1', caseSensitive: true, wholeWord: true } });
  assert.strictEqual(fs.readFileSync(path.join(root, 'demo/a.tex'), 'utf8'), 'bar$1 Foo food\nbar$1');
});

test('zip import strips the top folder, ignores zip-slip entries; export round-trips', async () => {
  const AdmZip = require('adm-zip'); const z = new AdmZip();
  z.addFile('proj/main.tex', Buffer.from('\\documentclass{article}\\begin{document}\\include{sec/one}\\end{document}')); z.addFile('proj/sec/one.tex', Buffer.from('Hi'));
  z.addFile('zzzevil.txt', Buffer.from('x'));
  // AdmZip sanitises names on add, so craft the zip-slip entry by patching the name bytes (same length)
  const zipBuf = Buffer.from(z.toBuffer().toString('latin1').split('zzzevil.txt').join('../evil.txt'), 'latin1');
  const fd = new FormData(); fd.append('name', 'imp'); fd.append('zip', new Blob([zipBuf]), 'p.zip');
  const r = await fetch(base + '/api/import', { method: 'POST', body: fd }); assert.strictEqual(r.status, 200);
  assert.ok(fs.existsSync(path.join(root, 'imp/main.tex')) && fs.existsSync(path.join(root, 'imp/sec/one.tex')));
  assert.ok(!fs.existsSync(path.join(root, '../evil.txt')));
  const { data } = await api('/api/p/imp/compile', { method: 'POST', json: {} }); assert.ok(data.ok, JSON.stringify(data.issues));
  const out = await fetch(base + '/api/p/imp/download.zip'); const names = new AdmZip(Buffer.from(await out.arrayBuffer())).getEntries().map((e) => e.entryName).sort();
  assert.deepStrictEqual(names, ['main.tex', 'sec/one.tex']);
});

test('websocket: external edits are pushed, own saves are not echoed; compile events are shared', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`);
  const msgs = []; ws.on('message', (d) => msgs.push(JSON.parse(d.toString())));
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'watch', project: 'demo', clientId: 'tab1' }));
  await new Promise((r) => setTimeout(r, 300));
  await put('own.tex', 'saved through the API');
  fs.writeFileSync(path.join(root, 'demo/external.tex'), 'edited elsewhere');
  await new Promise((r) => setTimeout(r, 700));
  const paths = msgs.filter((m) => m.type === 'fs').map((m) => m.path);
  assert.ok(paths.includes('external.tex')); assert.ok(!paths.includes('own.tex'));
  await api('/api/p/demo/compile', { method: 'POST', json: {}, headers: { 'x-client-id': 'tab2' } });
  assert.ok(msgs.some((m) => m.type === 'compile-start')); assert.ok(msgs.some((m) => m.type === 'compiled' && m.by === 'tab2'));
  ws.close();
  const bad = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`, { headers: { origin: 'http://evil.example.com' } });
  await new Promise((r) => { bad.on('error', r); bad.on('close', r); });
});

test('synctex: forward and reverse', async () => {
  await put('main.tex', '\\documentclass{article}\\begin{document}\nHello synctex world.\n\\end{document}\n');
  const { data: c } = await api('/api/p/demo/compile', { method: 'POST', json: {} }); assert.ok(c.ok);
  const f = (await api('/api/p/demo/synctex/view?pdf=main.pdf&file=main.tex&line=2&col=0')).data; assert.ok(f.found && f.page === 1, JSON.stringify(f));
  const e = (await api(`/api/p/demo/synctex/edit?pdf=main.pdf&page=1&x=${f.h + 5}&y=${f.v - 2}`)).data; assert.ok(e.found && e.file === 'main.tex' && e.line === 2, JSON.stringify(e));
});
