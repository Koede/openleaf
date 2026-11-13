const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const WebSocket = require('ws');
const Y = require('yjs');
const { start } = require('../server/index');
const { applyDiff } = require('../server/collab');

let srv, base, root, alice, bob;
const call = async (p, { json, cookie, method } = {}) => {
  const r = await fetch(base + p, { method: method || (json ? 'POST' : 'GET'), headers: { ...(json ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: json ? JSON.stringify(json) : undefined });
  const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = t; }
  return { status: r.status, data: d, cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await wait(40); } return false; };
const b64 = (u) => Buffer.from(u).toString('base64');

// A minimal collaborative client: the same messages the browser sends.
function client(cookie, project, file) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace('http', 'ws') + '/ws', { headers: { cookie, origin: base } });
    const doc = new Y.Doc(); const text = doc.getText('t'); const c = { ws, doc, text, msgs: [] };
    doc.on('update', (u, origin) => { if (origin !== 'remote' && ws.readyState === 1) ws.send(JSON.stringify({ type: 'y-update', path: file, update: b64(u) })); });
    ws.on('message', (d) => {
      const m = JSON.parse(d); c.msgs.push(m);
      if (m.type === 'y-sync' && m.path === file) { Y.applyUpdate(doc, new Uint8Array(Buffer.from(m.state, 'base64')), 'remote'); c.epoch = m.epoch; c.readOnly = m.readOnly; resolve(c); }
      if (m.type === 'y-update' && m.path === file) Y.applyUpdate(doc, new Uint8Array(Buffer.from(m.update, 'base64')), 'remote');
    });
    ws.on('open', () => { ws.send(JSON.stringify({ type: 'watch', project, clientId: Math.random().toString(36) })); ws.send(JSON.stringify({ type: 'y-join', path: file, aw: doc.clientID })); });
    ws.on('error', reject); setTimeout(() => reject(new Error('no y-sync')), 4000);
  });
}

test.before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-collab-')); srv = await start({ port: 0, root, quiet: true, accounts: true }); base = `http://127.0.0.1:${srv.port}`;
  alice = (await call('/api/auth/register', { json: { username: 'alice', password: 'long password a' } })).cookie;
  bob = (await call('/api/auth/register', { json: { username: 'bob', password: 'long password b' } })).cookie;
  await call('/api/projects', { json: { name: 'paper', template: 'blank' }, cookie: alice });
  await call('/api/p/paper/file', { method: 'PUT', json: { path: 'main.tex', content: 'Hello world.\n' }, cookie: alice });
  await call('/api/p/paper/share/invite', { json: { user: 'bob', role: 'edit' }, cookie: alice });
});
test.after(async () => { await srv.close(); fs.rmSync(root, { recursive: true, force: true }); });
const disk = () => fs.readFileSync(path.join(root, 'alice', 'paper', 'main.tex'), 'utf8');

test('applyDiff turns one text into another with a minimal edit', () => {
  const d = new Y.Doc(); const t = d.getText('t'); t.insert(0, 'abcXYZdef');
  applyDiff(t, 'abc12def'); assert.strictEqual(t.toString(), 'abc12def');
  applyDiff(t, ''); assert.strictEqual(t.toString(), ''); applyDiff(t, 'new'); assert.strictEqual(t.toString(), 'new');
});

test('two people editing one file see each other\'s typing, and it is saved', async () => {
  const a = await client(alice, 'paper', 'main.tex'), b = await client(bob, 'alice/paper', 'main.tex');
  assert.strictEqual(a.text.toString(), 'Hello world.\n'); assert.strictEqual(b.text.toString(), 'Hello world.\n');
  a.text.insert(5, ', dear');
  assert.ok(await until(() => b.text.toString() === 'Hello, dear world.\n'), 'bob sees alice\'s edit');
  assert.ok(await until(() => disk() === 'Hello, dear world.\n'), 'saved to disk');
  a.ws.close(); b.ws.close();
});

test('simultaneous edits in different places both survive', async () => {
  const a = await client(alice, 'paper', 'main.tex'), b = await client(bob, 'alice/paper', 'main.tex');
  a.text.insert(0, 'A: '); b.text.insert(b.text.length, 'B was here.\n');   // at the same moment
  assert.ok(await until(() => a.text.toString() === b.text.toString() && a.text.toString().startsWith('A: ') && a.text.toString().endsWith('B was here.\n')), `converged: ${JSON.stringify([a.text.toString(), b.text.toString()])}`);
  assert.ok(await until(() => disk() === a.text.toString()));
  a.ws.close(); b.ws.close();
});

test('a request right after typing sees the new text (pending saves are flushed)', async () => {
  const a = await client(alice, 'paper', 'main.tex');
  a.text.insert(0, '%flush\n'); await wait(60);
  assert.ok((await call('/api/p/paper/raw?path=main.tex', { cookie: alice })).data.startsWith('%flush\n'));
  a.ws.close();
});

test('a save that does not come through Yjs is merged into the live document', async () => {
  const a = await client(alice, 'paper', 'main.tex');
  await call('/api/p/alice%2Fpaper/file', { method: 'PUT', json: { path: 'main.tex', content: 'Replaced by an old tab.\n' }, cookie: bob });
  assert.ok(await until(() => a.text.toString() === 'Replaced by an old tab.\n'), 'alice sees it live');
  fs.writeFileSync(path.join(root, 'alice', 'paper', 'main.tex'), 'Edited in another program.\n');
  assert.ok(await until(() => a.text.toString() === 'Edited in another program.\n', 4000), 'and edits made outside the app');
  a.ws.close();
});

test('viewers follow along but cannot change the document', async () => {
  await call('/api/p/paper/share/invite', { json: { user: 'bob', role: 'view' }, cookie: alice });
  const a = await client(alice, 'paper', 'main.tex'), b = await client(bob, 'alice/paper', 'main.tex');
  assert.strictEqual(b.readOnly, true);
  const before = a.text.toString();
  b.text.insert(0, 'VIEWER ');
  await wait(500);
  assert.strictEqual(a.text.toString(), before, 'the viewer\'s change went nowhere'); assert.strictEqual(disk(), before);
  a.text.insert(0, 'ok ');
  assert.ok(await until(() => b.text.toString().includes('ok ')), 'the viewer still gets updates');
  a.ws.close(); b.ws.close();
  await call('/api/p/paper/share/invite', { json: { user: 'bob', role: 'edit' }, cookie: alice });
});

test('paths are checked and projects that are not shared are out of reach', async () => {
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws', { headers: { cookie: alice, origin: base } }); const got = [];
  ws.on('message', (d) => got.push(JSON.parse(d)));
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'watch', project: 'paper', clientId: 'x' }));
  ws.send(JSON.stringify({ type: 'y-join', path: '../../.accounts/users.json', aw: 1 }));
  await wait(300);
  assert.ok(got.some((m) => m.type === 'y-error') && !got.some((m) => m.type === 'y-sync'));
  ws.close();
  const carol = (await call('/api/auth/register', { json: { username: 'carol', password: 'long password c' } })).cookie;
  await assert.rejects(client(carol, 'alice/paper', 'main.tex'));
});

test('comments and tracked changes live in the shared document, follow edits, and survive a restart', async () => {
  await call('/api/p/paper/file', { method: 'PUT', json: { path: 'main.tex', content: 'The quick brown fox.\n' }, cookie: alice });
  const a = await client(alice, 'paper', 'main.tex');
  const rp = (i, assoc) => Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(a.text, i, assoc));
  a.doc.transact(() => {
    const m = new Y.Map(); const th = new Y.Array(); th.push([{ user: 'alice', text: 'colour?', ts: 1 }]);
    m.set('from', rp(10, 0)); m.set('to', rp(15, -1)); m.set('resolved', false); m.set('by', 'alice'); m.set('ts', 1); m.set('thread', th);
    a.doc.getMap('comments').set('c1', m);
    a.doc.getMap('changes').set('x1', { kind: 'del', user: 'alice', ts: 2, from: rp(4, 0), to: rp(4, -1), text: 'very ' });
  });
  a.text.insert(0, 'Hi. ');   // moves everything 4 characters to the right
  const file = path.join(root, 'alice', 'paper', '.review', 'main.tex.json');
  assert.ok(await until(() => { try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return j.comments[0].from === 14 && j.comments[0].to === 19 && j.changes[0].from === 8; } catch { return false; } }), 'saved with offsets that followed the edit');
  assert.ok(!(await call('/api/p/paper/tree', { cookie: alice })).data.tree.some((n) => n.name === '.review'), 'not shown as a project file');
  a.ws.close();
  // restart the server on the same folder: the review data comes back at the right place
  await srv.close(); srv = await start({ port: 0, root, quiet: true, accounts: true }); base = `http://127.0.0.1:${srv.port}`;
  alice = (await call('/api/auth/login', { json: { username: 'alice', password: 'long password a' } })).cookie;
  bob = (await call('/api/auth/login', { json: { username: 'bob', password: 'long password b' } })).cookie;
  const b2 = await client(alice, 'paper', 'main.tex');
  const c = b2.doc.getMap('comments').get('c1');
  const absPos = (j) => Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(j), b2.doc).index;
  assert.strictEqual(b2.text.toString().slice(absPos(c.get('from')), absPos(c.get('to'))), 'brown');
  assert.deepStrictEqual(c.get('thread').toArray(), [{ user: 'alice', text: 'colour?', ts: 1 }]);
  assert.strictEqual(b2.doc.getMap('changes').get('x1').text, 'very ');
  b2.ws.close();
});

test('project chat: members (viewers too) post, everyone in the project hears it', async () => {
  await call('/api/p/paper/share/invite', { json: { user: 'bob', role: 'view' }, cookie: alice });
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws', { headers: { cookie: alice, origin: base } }); const got = [];
  ws.on('message', (d) => got.push(JSON.parse(d))); await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'watch', project: 'paper', clientId: 'chat' })); await wait(150);
  assert.strictEqual((await call('/api/p/alice%2Fpaper/chat', { json: { text: '  Looks good!  ' }, cookie: bob })).status, 200);
  assert.strictEqual((await call('/api/p/alice%2Fpaper/chat', { json: { text: '   ' }, cookie: bob })).status, 400);
  assert.ok(await until(() => got.some((m) => m.type === 'chat' && m.message.text === 'Looks good!' && m.message.user === 'bob')));
  const list = await call('/api/p/paper/chat', { cookie: alice });
  assert.deepStrictEqual(list.data.messages.map((m) => [m.user, m.text]), [['bob', 'Looks good!']]);
  ws.close();
  await call('/api/p/paper/share/invite', { json: { user: 'bob', role: 'edit' }, cookie: alice });
});

test('track changes is a project setting that reaches everyone', async () => {
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws', { headers: { cookie: bob, origin: base } }); const got = [];
  ws.on('message', (d) => got.push(JSON.parse(d))); await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'watch', project: 'alice/paper', clientId: 'tc' })); await wait(150);
  await call('/api/p/paper/settings', { method: 'PUT', json: { trackChanges: true }, cookie: alice });
  assert.ok(await until(() => got.some((m) => m.type === 'settings')));
  assert.strictEqual((await call('/api/p/alice%2Fpaper/settings', { cookie: bob })).data.trackChanges, true);
  ws.close();
});
