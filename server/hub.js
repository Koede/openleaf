// WebSocket hub + per-project file watcher. Pushes live events to every open browser tab:
//   fs        – files changed outside the editor (VS Code, git pull, ...) or by another tab
//   compiled / compile-start / compile-log – compile progress shared between tabs
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { HIDDEN, sha, NAME_RE } = require('./util');

class Hub {
  // resolve(ok, name): hub key for project `name` as asked by a connection (ok = what verify returned), or null
  constructor(root, verify, resolve = (ok, name) => (NAME_RE.test(name) ? ((ok && ok.scope) || '') + name : null)) {
    this.root = root; this.verify = verify; this.resolve = resolve;
    this.wss = new WebSocketServer({ noServer: true });
    this.clients = new Set();      // { ws, project, id }
    this.watchers = new Map();     // project -> { w, known:Map, pending:Map }
  }

  attach(server) {
    server.on('upgrade', (req, socket, head) => {
      const ok = req.url.startsWith('/ws') && this.verify(req);
      if (!ok) { socket.destroy(); return; }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, ok));
    });
  }

  onConnection(ws, ok = true) {
    // project = hub key ("<owner>/<name>" in account mode), name = what this client calls it
    const c = { ws, project: null, name: null, id: null, ok };
    this.clients.add(c);
    ws.on('message', (data) => {
      let m; try { m = JSON.parse(data.toString()); } catch { return; }
      if (typeof m.type === 'string' && m.type.startsWith('y-')) { if (this.collab) this.collab.onMessage(c, m); return; }
      const res = m.type === 'watch' && typeof m.project === 'string' ? this.resolve(ok, m.project) : null;
      const key = res && (typeof res === 'string' ? res : res.key);
      if (key) {
        const prev = c.project;
        c.project = key; c.name = m.project; c.role = (res && res.role) || 'owner'; c.id = String(m.clientId || '').slice(0, 40);
        if (this.collab && prev && prev !== key) this.collab.switched(c);
        this.ensureWatcher(c.project);
        if (prev && prev !== c.project) this.gc(prev);
      }
    });
    ws.on('close', () => { this.clients.delete(c); if (this.collab) this.collab.closed(c); if (c.project) this.gc(c.project); });
    ws.on('error', () => {});
    ws.send(JSON.stringify({ type: 'hello' }));
  }

  broadcast(project, msg, exceptId) {
    for (const c of this.clients) {
      if (c.project !== project || c.ws.readyState !== 1 || (exceptId && c.id === exceptId)) continue;
      c.ws.send(JSON.stringify({ project: c.name, ...msg }));      // each client sees the project under the name it uses
    }
  }

  // Every write the server makes goes through here; the collaboration layer merges writes that did not come from it.
  noteWrite(project, rel, buf, opts = {}) {
    const w = this.watchers.get(project); if (w) w.known.set(rel, sha(buf));
    if (this.collab && !opts.fromCollab) this.collab.diskChanged(project, rel, buf);
  }
  noteRemove(project, rel) {
    const w = this.watchers.get(project); if (w) for (const k of [...w.known.keys()]) if (k === rel || k.startsWith(rel + '/')) w.known.delete(k);
    if (this.collab) this.collab.removed(project, rel);
  }

  ensureWatcher(project) {
    if (this.watchers.has(project)) return;
    const dir = path.join(this.root, project);
    if (!fs.existsSync(dir)) return;
    const st = { w: null, known: new Map(), pending: new Map() };
    try {
      st.w = fs.watch(dir, { recursive: true }, (ev, filename) => {
        if (!filename) return;
        const rel = filename.split(path.sep).join('/');
        if (HIDDEN.has(rel.split('/')[0]) || rel.endsWith('.tmp')) return;
        clearTimeout(st.pending.get(rel));
        st.pending.set(rel, setTimeout(() => { st.pending.delete(rel); this.check(project, st, rel); }, 120));
      });
      st.w.on('error', () => this.gc(project, true));
    } catch { return; }
    this.watchers.set(project, st);
  }

  check(project, st, rel) {
    const abs = path.join(this.root, project, rel);
    let stat = null; try { stat = fs.statSync(abs); } catch {}
    if (stat && stat.isFile()) {
      let buf; try { buf = fs.readFileSync(abs); } catch { return; }
      const h = sha(buf);
      if (st.known.get(rel) === h) return;       // our own write
      st.known.set(rel, h);
      if (this.collab) this.collab.diskChanged(project, rel, buf);   // changed outside the app: merge into live documents
      this.broadcast(project, { type: 'fs', path: rel, kind: 'change' });
    } else if (stat && stat.isDirectory()) {
      this.broadcast(project, { type: 'fs', path: rel, kind: 'dir' });
    } else {
      st.known.delete(rel);
      if (this.collab) this.collab.removed(project, rel);
      this.broadcast(project, { type: 'fs', path: rel, kind: 'remove' });
    }
  }

  gc(project, force) {
    const st = this.watchers.get(project);
    if (!st) return;
    if (!force && [...this.clients].some((c) => c.project === project)) return;
    try { st.w && st.w.close(); } catch {}
    for (const t of st.pending.values()) clearTimeout(t);
    this.watchers.delete(project);
  }
}

module.exports = { Hub };
