const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const WebSocket = require('ws');
const { start } = require('../server/index');

let srv, base, root;
const call = async (p, { json, cookie, method } = {}) => {
  const r = await fetch(base + p, { method: method || (json ? 'POST' : 'GET'), headers: { ...(json ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: json ? JSON.stringify(json) : undefined });
  const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = t; }
  return { status: r.status, data: d, cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
};
const reg = async (u) => (await call('/api/auth/register', { json: { username: u, password: 'long password ' + u } })).cookie;
const S = '/api/p/alice%2Fthesis';
let alice, bob, carol, dave;

test.before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-share-')); srv = await start({ port: 0, root, quiet: true, accounts: true }); base = `http://127.0.0.1:${srv.port}`;
  [alice, bob, carol, dave] = await Promise.all(['alice', 'bob', 'carol', 'dave'].map(reg));
  assert.strictEqual((await call('/api/projects', { json: { name: 'thesis', template: 'article' }, cookie: alice })).status, 200);
});
test.after(async () => { await srv.close(); fs.rmSync(root, { recursive: true, force: true }); });

test('a project is private until it is shared', async () => {
  assert.strictEqual((await call(S + '/tree', { cookie: bob })).status, 404);
  assert.strictEqual((await call('/api/p/..%2Falice/tree', { cookie: bob })).status, 400);
});

test('only the owner invites; unknown accounts and self are refused', async () => {
  assert.strictEqual((await call('/api/p/thesis/share/invite', { json: { user: 'nobody', role: 'edit' }, cookie: alice })).status, 404);
  assert.strictEqual((await call('/api/p/thesis/share/invite', { json: { user: 'alice', role: 'edit' }, cookie: alice })).status, 400);
  assert.strictEqual((await call('/api/p/thesis/share/invite', { json: { user: 'bob', role: 'admin' }, cookie: alice })).status, 400);
  assert.strictEqual((await call('/api/p/thesis/share/invite', { json: { user: 'bob', role: 'edit' }, cookie: alice })).status, 200);
  assert.strictEqual((await call('/api/p/thesis/share/invite', { json: { user: 'carol', role: 'view' }, cookie: alice })).status, 200);
  assert.strictEqual((await call(S + '/share/invite', { json: { user: 'dave', role: 'edit' }, cookie: bob })).status, 403);
  const info = await call('/api/p/thesis/share', { cookie: alice });
  assert.deepStrictEqual(info.data.members, [{ user: 'bob', role: 'edit' }, { user: 'carol', role: 'view' }]);
  assert.ok(info.data.links, 'the owner sees the links');
  assert.strictEqual((await call(S + '/share', { cookie: bob })).data.links, undefined, 'collaborators do not');
});

test('editors read and write; the shared project is listed', async () => {
  const list = await call('/api/projects', { cookie: bob });
  assert.deepStrictEqual(list.data.shared, [{ name: 'alice/thesis', owner: 'alice', project: 'thesis', role: 'edit' }]);
  assert.strictEqual((await call(S + '/tree', { cookie: bob })).status, 200);
  assert.strictEqual((await call(S + '/file', { method: 'PUT', json: { path: 'notes.tex', content: 'from bob' }, cookie: bob })).status, 200);
  assert.strictEqual(fs.readFileSync(path.join(root, 'alice', 'thesis', 'notes.tex'), 'utf8'), 'from bob', 'written into the owner\'s project');
});

test('viewers read, search and compile, but cannot change anything', async () => {
  assert.strictEqual((await call(S + '/raw?path=notes.tex', { cookie: carol })).data, 'from bob');
  assert.strictEqual((await call(S + '/search', { json: { query: 'bob' }, cookie: carol })).status, 200);
  assert.strictEqual((await call(S + '/file', { method: 'PUT', json: { path: 'notes.tex', content: 'x' }, cookie: carol })).status, 403);
  assert.strictEqual((await call(S + '/ops', { json: { op: 'delete', path: 'notes.tex' }, cookie: carol })).status, 403);
  assert.strictEqual((await call(S + '/settings', { method: 'PUT', json: { engine: 'xelatex' }, cookie: carol })).status, 403);
  assert.strictEqual((await call(S + '/replace', { json: { query: 'bob', replacement: 'x' }, cookie: carol })).status, 403);
  assert.notStrictEqual((await call(S + '/compile/stop', { json: {}, cookie: carol })).status, 403);
});

test('rename and delete are for the owner; anyone can copy into their own projects', async () => {
  assert.strictEqual((await call('/api/projects/alice%2Fthesis/rename', { json: { to: 'mine' }, cookie: bob })).status, 403);
  assert.strictEqual((await call('/api/projects/alice%2Fthesis', { method: 'DELETE', cookie: bob })).status, 403);
  assert.strictEqual((await call('/api/projects/alice%2Fthesis/copy', { json: { to: 'thesis-copy' }, cookie: carol })).status, 200);
  assert.ok(fs.existsSync(path.join(root, 'carol', 'thesis-copy', 'notes.tex')));
  assert.ok(!fs.existsSync(path.join(root, 'alice', 'thesis-copy')));
});

test('share links add the person who opens them; turning a link off revokes it; links never downgrade', async () => {
  const view = (await call('/api/p/thesis/share/link', { json: { role: 'view', on: true }, cookie: alice })).data.token;
  assert.ok(view && view.length >= 20);
  const j = await call('/api/share/join', { json: { token: view }, cookie: dave });
  assert.deepStrictEqual(j.data, { name: 'alice/thesis', role: 'view' });
  assert.strictEqual((await call('/api/share/join', { json: { token: view }, cookie: bob })).data.role, 'edit', 'bob keeps edit');
  const edit = (await call('/api/p/thesis/share/link', { json: { role: 'edit', on: true }, cookie: alice })).data.token;
  assert.strictEqual((await call('/api/share/join', { json: { token: edit }, cookie: dave })).data.role, 'edit', 'upgraded by the edit link');
  await call('/api/p/thesis/share/link', { json: { role: 'view', on: false }, cookie: alice });
  assert.strictEqual((await call('/api/share/join', { json: { token: view }, cookie: carol })).status, 404);
  assert.strictEqual((await call('/api/share/join', { json: { token: 'made-up' }, cookie: carol })).status, 404);
});

test('live updates reach collaborators under the name they use', async () => {
  const open = (cookie, project) => new Promise((res, rej) => { const ws = new WebSocket(base.replace('http', 'ws') + '/ws', { headers: { cookie, origin: base } }); const got = []; ws.on('message', (d) => got.push(JSON.parse(d))); ws.on('open', () => { ws.send(JSON.stringify({ type: 'watch', project, clientId: 'c-' + project })); setTimeout(() => res({ ws, got }), 200); }); ws.on('error', rej); });
  const wa = await open(alice, 'thesis'), wb = await open(bob, 'alice/thesis'), wx = await open(carol, 'alice/nope');
  fs.writeFileSync(path.join(root, 'alice', 'thesis', 'outside.tex'), 'edited outside the app');
  await new Promise((r) => setTimeout(r, 900));
  const fa = wa.got.find((m) => m.type === 'fs' && m.path === 'outside.tex'), fb = wb.got.find((m) => m.type === 'fs' && m.path === 'outside.tex');
  assert.ok(fa && fb, 'both the owner and the editor hear about the change');
  assert.strictEqual(fa.project, 'thesis'); assert.strictEqual(fb.project, 'alice/thesis');
  assert.ok(!wx.got.some((m) => m.type === 'fs'), 'no events for a project that is not shared with you');
  for (const w of [wa, wb, wx]) w.ws.close();
});

test('removing and leaving end access; renaming and deleting keep shares in step', async () => {
  await call('/api/p/thesis/share/remove', { json: { user: 'bob' }, cookie: alice });
  assert.strictEqual((await call(S + '/tree', { cookie: bob })).status, 404);
  assert.strictEqual((await call(S + '/share/leave', { json: {}, cookie: carol })).status, 200);
  assert.strictEqual((await call(S + '/tree', { cookie: carol })).status, 404);
  assert.strictEqual((await call('/api/projects/thesis/rename', { json: { to: 'thesis2' }, cookie: alice })).status, 200);
  assert.strictEqual((await call('/api/p/alice%2Fthesis2/tree', { cookie: dave })).status, 200, 'dave follows the rename');
  assert.strictEqual((await call('/api/projects/thesis2', { method: 'DELETE', cookie: alice })).status, 200);
  assert.deepStrictEqual((await call('/api/projects', { cookie: dave })).data.shared, []);
  assert.ok(!JSON.parse(fs.readFileSync(path.join(root, '.openleaf', 'shares.json'), 'utf8'))['alice/thesis2']);
});
