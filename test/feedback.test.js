const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { start } = require('../server/index');

let srv, base, root;
const call = async (p, { json, cookie, method } = {}) => {
  const r = await fetch(base + p, { method: method || (json ? 'POST' : 'GET'), headers: { ...(json ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: json ? JSON.stringify(json) : undefined });
  const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = t; }
  return { status: r.status, data: d, cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
};
let admin, user;
test.before(async () => {
  delete process.env.ADMIN_USERS;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-fb-')); srv = await start({ port: 0, root, quiet: true, accounts: true }); base = `http://127.0.0.1:${srv.port}`;
  admin = (await call('/api/auth/register', { json: { username: 'first', password: 'correct horse' } })).cookie;  // first account = admin
  user = (await call('/api/auth/register', { json: { username: 'second', password: 'battery staple' } })).cookie;
});
test.after(async () => { await srv.close(); fs.rmSync(root, { recursive: true, force: true }); });

test('feedback needs a session', async () => {
  assert.strictEqual((await call('/api/feedback')).status, 401);
  assert.strictEqual((await call('/api/feedback', { json: { kind: 'bug', title: 'x' } })).status, 401);
});

test('input is validated', async () => {
  assert.strictEqual((await call('/api/feedback', { json: { kind: 'spam', title: 'x' }, cookie: user })).status, 400);
  assert.strictEqual((await call('/api/feedback', { json: { kind: 'bug', title: '   ' }, cookie: user })).status, 400);
  const long = await call('/api/feedback', { json: { kind: 'feature', title: 'T'.repeat(500), body: 'B'.repeat(50000) }, cookie: user });
  assert.strictEqual(long.status, 200); assert.strictEqual(long.data.item.title.length, 200); assert.strictEqual(long.data.item.body.length, 20000);
});

test('a user sees only their own; the first account sees all and can set a status', async () => {
  const a = await call('/api/feedback', { json: { kind: 'bug', title: 'PDF does not refresh', body: 'steps', diag: 'openleaf 1.0.0' }, cookie: user });
  assert.strictEqual(a.status, 200); assert.strictEqual(a.data.item.user, 'second'); assert.strictEqual(a.data.item.status, 'open');
  await call('/api/feedback', { json: { kind: 'feature', title: 'Admin idea' }, cookie: admin });

  const mine = await call('/api/feedback', { cookie: user });
  assert.strictEqual(mine.data.admin, false); assert.ok(mine.data.items.every((i) => i.user === 'second'));
  const all = await call('/api/feedback', { cookie: admin });
  assert.strictEqual(all.data.admin, true); assert.ok(all.data.items.some((i) => i.user === 'first') && all.data.items.some((i) => i.user === 'second'));
  assert.ok(all.data.server && 'version' in all.data.server);

  const id = a.data.item.id;
  assert.strictEqual((await call('/api/feedback/' + id, { method: 'PATCH', json: { status: 'done' }, cookie: user })).status, 403);
  assert.strictEqual((await call('/api/feedback/' + id, { method: 'PATCH', json: { status: 'bogus' }, cookie: admin })).status, 400);
  const p = await call('/api/feedback/' + id, { method: 'PATCH', json: { status: 'planned' }, cookie: admin });
  assert.strictEqual(p.data.item.status, 'planned');
  assert.strictEqual((await call('/api/feedback', { cookie: user })).data.items.find((i) => i.id === id).status, 'planned');
});

test('delete: own items only, admin any', async () => {
  const theirs = (await call('/api/feedback', { json: { kind: 'bug', title: 'mine' }, cookie: user })).data.item.id;
  const adminItem = (await call('/api/feedback', { cookie: admin })).data.items.find((i) => i.user === 'first').id;
  assert.strictEqual((await call('/api/feedback/' + adminItem, { method: 'DELETE', cookie: user })).status, 403);
  assert.strictEqual((await call('/api/feedback/' + theirs, { method: 'DELETE', cookie: user })).status, 200);
  assert.strictEqual((await call('/api/feedback/' + adminItem, { method: 'DELETE', cookie: admin })).status, 200);
});

test('stored outside every project and every account folder', async () => {
  assert.ok(fs.existsSync(path.join(root, '.openleaf', 'feedback.json')));
  const list = await call('/api/projects', { cookie: admin });
  assert.ok(!list.data.projects.some((n) => n.startsWith('.')));
});

test('ADMIN_USERS overrides the first-account rule', async () => {
  process.env.ADMIN_USERS = 'second';
  try {
    assert.strictEqual((await call('/api/feedback', { cookie: user })).data.admin, true);
    assert.strictEqual((await call('/api/feedback', { cookie: admin })).data.admin, false);
  } finally { delete process.env.ADMIN_USERS; }
});

test('rate limit per user', async () => {
  let last;
  for (let i = 0; i < 20; i++) last = await call('/api/feedback', { json: { kind: 'bug', title: 'flood ' + i }, cookie: user });
  assert.strictEqual(last.status, 429);
});
