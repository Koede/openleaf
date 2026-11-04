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
test.before(async () => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-auth-')); srv = await start({ port: 0, root, quiet: true, accounts: true }); base = `http://127.0.0.1:${srv.port}`; });
test.after(async () => { await srv.close(); fs.rmSync(root, { recursive: true, force: true }); });

test('API is closed without a session; /auth/me says accounts are on', async () => {
  assert.strictEqual((await call('/api/projects')).status, 401);
  const me = await call('/api/auth/me'); assert.deepStrictEqual([me.data.accounts, me.data.user], [true, null]);
});
test('register validates input, stores a hash (not the password), logs in', async () => {
  assert.strictEqual((await call('/api/auth/register', { json: { username: 'a', password: 'longenough' } })).status, 400);
  assert.strictEqual((await call('/api/auth/register', { json: { username: 'alice', password: 'short' } })).status, 400);
  assert.strictEqual((await call('/api/auth/register', { json: { username: '../etc', password: 'longenough' } })).status, 400);
  const r = await call('/api/auth/register', { json: { username: 'Alice', password: 'correct horse' } });
  assert.strictEqual(r.status, 200); assert.strictEqual(r.data.user, 'alice'); assert.match(r.cookie, /^ls_session=/);
  const raw = fs.readFileSync(path.join(root, '.accounts', 'users.json'), 'utf8'); assert.ok(!raw.includes('correct horse'));
  assert.strictEqual((await call('/api/auth/register', { json: { username: 'alice', password: 'another pass' } })).status, 409);
});
test('wrong password is rejected; right one works; /me reflects the session', async () => {
  assert.strictEqual((await call('/api/auth/login', { json: { username: 'alice', password: 'nope nope nope' } })).status, 401);
  assert.strictEqual((await call('/api/auth/login', { json: { username: 'ghost', password: 'nope nope nope' } })).status, 401);
  const r = await call('/api/auth/login', { json: { username: 'alice', password: 'correct horse' } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await call('/api/auth/me', { cookie: r.cookie })).data.user, 'alice');
});
test('files are saved per account and invisible to other users', async () => {
  const a = (await call('/api/auth/login', { json: { username: 'alice', password: 'correct horse' } })).cookie;
  const b = (await call('/api/auth/register', { json: { username: 'bob', password: 'battery staple' } })).cookie;
  assert.strictEqual((await call('/api/projects', { json: { name: 'thesis', template: 'article' }, cookie: a })).status, 200);
  assert.strictEqual((await call('/api/p/thesis/file', { method: 'PUT', json: { path: 'main.tex', content: '\\documentclass{article}\\begin{document}ALICE\\end{document}' }, cookie: a })).status, 200);
  assert.ok(fs.existsSync(path.join(root, 'alice', 'thesis', 'main.tex')));
  assert.deepStrictEqual((await call('/api/projects', { cookie: b })).data.projects, []);
  assert.strictEqual((await call('/api/p/thesis/raw?path=main.tex', { cookie: b })).status, 404);
  assert.deepStrictEqual((await call('/api/projects', { cookie: a })).data.projects, ['thesis']);
  // same project name for bob is independent
  assert.strictEqual((await call('/api/projects', { json: { name: 'thesis', template: 'blank' }, cookie: b })).status, 200);
  assert.ok(!(await call('/api/p/thesis/raw?path=main.tex', { cookie: b })).data.includes('ALICE'));
});
test('traversal through project names or the accounts folder is impossible', async () => {
  const a = (await call('/api/auth/login', { json: { username: 'alice', password: 'correct horse' } })).cookie;
  assert.strictEqual((await call('/api/p/..%2Fbob/tree', { cookie: a })).status, 400);
  assert.strictEqual((await call('/api/p/.accounts/tree', { cookie: a })).status, 400);
  assert.strictEqual((await call('/api/projects', { json: { name: '../bob/x', template: 'blank' }, cookie: a })).status, 400);
});
test('logout kills the session; password change signs out other devices', async () => {
  const s1 = (await call('/api/auth/login', { json: { username: 'bob', password: 'battery staple' } })).cookie;
  const s2 = (await call('/api/auth/login', { json: { username: 'bob', password: 'battery staple' } })).cookie;
  assert.strictEqual((await call('/api/auth/password', { json: { oldPassword: 'wrong wrong', newPassword: 'new password 1' }, cookie: s1 })).status, 403);
  assert.strictEqual((await call('/api/auth/password', { json: { oldPassword: 'battery staple', newPassword: 'new password 1' }, cookie: s1 })).status, 200);
  assert.strictEqual((await call('/api/projects', { cookie: s2 })).status, 401);
  assert.strictEqual((await call('/api/projects', { cookie: s1 })).status, 200);
  await call('/api/auth/logout', { json: {}, cookie: s1 });
  assert.strictEqual((await call('/api/projects', { cookie: s1 })).status, 401);
});
test('compile works inside an account, and live events only reach the owner', async () => {
  const a = (await call('/api/auth/login', { json: { username: 'alice', password: 'correct horse' } })).cookie;
  const c = (await call('/api/auth/login', { json: { username: 'bob', password: 'new password 1' } })).cookie;
  const open = (cookie) => new Promise((res, rej) => { const ws = new WebSocket(base.replace('http', 'ws') + '/ws', { headers: { cookie, origin: base } }); const got = []; ws.on('message', (d) => got.push(JSON.parse(d))); ws.on('open', () => { ws.send(JSON.stringify({ type: 'watch', project: 'thesis', clientId: 'x' })); setTimeout(() => res({ ws, got }), 150); }); ws.on('error', rej); });
  const wa = await open(a), wb = await open(c);
  const r = await call('/api/p/thesis/compile', { json: {}, cookie: a }); assert.ok(r.data.ok, JSON.stringify(r.data.issues));
  await new Promise((r2) => setTimeout(r2, 300));
  const ev = wa.got.find((m) => m.type === 'compiled'); assert.ok(ev); assert.strictEqual(ev.project, 'thesis');   // plain name, no "alice/"
  assert.ok(!wb.got.some((m) => m.type === 'compiled'));
  wa.ws.close(); wb.ws.close();
  await assert.rejects(new Promise((res, rej) => { const w = new WebSocket(base.replace('http', 'ws') + '/ws', { headers: { origin: base } }); w.on('open', res); w.on('error', rej); }));
});
test('login attempts are rate-limited', async () => {
  let last; for (let i = 0; i < 12; i++) last = await call('/api/auth/login', { json: { username: 'victim', password: 'guess number ' + i } });
  assert.strictEqual(last.status, 429);
});
test('signup can be disabled; the project quota is enforced', async () => {
  const r2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-auth2-'));
  const s = await start({ port: 0, root: r2, quiet: true, accounts: true, allowSignup: false, maxProjects: 1 });
  try {
    const b = `http://127.0.0.1:${s.port}`;
    const r = await fetch(b + '/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'carol', password: 'long enough pw' }) });
    assert.strictEqual(r.status, 403);
    const { Accounts } = require('../server/accounts'); const acc = new Accounts(r2, {}); acc.register('dave', 'long enough pw', { force: true });
  } finally { await s.close(); fs.rmSync(r2, { recursive: true, force: true }); }
});
