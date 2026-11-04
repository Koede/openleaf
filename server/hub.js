// WebSocket hub + per-project file watcher. Pushes live events to every open browser tab:
//   fs        – files changed outside the editor (VS Code, git pull, ...) or by another tab
//   compiled / compile-start / compile-log – compile progress shared between tabs
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { HIDDEN, sha, NAME_RE } = require('./util');

class Hub {
  constructor(root, verify) {
    this.root = root; this.verify = verify;
    this.wss = new WebSocketServer({ noServer: true });
    this.clients = new Set();      // { ws, project, id }
    this.watchers = new Map();     // project -> { w, known:Map, pending:Map }
  }

  attach(server) {
    server.on('upgrade', (req, socket, head) => {
      const ok = req.url.startsWith('/ws') && this.verify(req);
      if (!ok) { socket.destroy(); return; }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, ok && ok.scope ? ok.scope : ''));
    });
  }

  onConnection(ws, scope = '') {
    const c = { ws, project: null, id: null, scope };      // scope = "<user>/" in account mode, so users never share watchers
    this.clients.add(c);
    ws.on('message', (data) => {
      let m; try { m = JSON.parse(data.toString()); } catch { return; }
      if (m.type === 'watch' && NAME_RE.test(m.project || '')) {
        const prev = c.project;
        c.project = scope + m.project; c.id = String(m.clientId || '').slice(0, 40);
        this.ensureWatcher(c.project);
        if (prev && prev !== c.project) this.gc(prev);
      }
    });
    ws.on('close', () => { this.clients.delete(c); if (c.project) this.gc(c.project); });
    ws.on('error', () => {});
    ws.send(JSON.stringify({ type: 'hello' }));
  }

  broadcast(project, msg, exceptId) {
    for (const c of this.clients) {
      if (c.project !== project || c.ws.readyState !== 1 || (exceptId && c.id === exceptId)) continue;
      c.ws.send(JSON.stringify({ project: project.slice(c.scope.length), ...msg }));      // clients only ever see plain project names
    }
  }

  noteWrite(project, rel, buf) { const w = this.watchers.get(project); if (w) w.known.set(rel, sha(buf)); }
  noteRemove(project, rel) { const w = this.watchers.get(project); if (w) for (const k of [...w.known.keys()]) if (k === rel || k.startsWith(rel + '/')) w.known.delete(k); }

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
      let h; try { h = sha(fs.readFileSync(abs)); } catch { return; }
      if (st.known.get(rel) === h) return;       // our own write
      st.known.set(rel, h);
      this.broadcast(project, { type: 'fs', path: rel, kind: 'change' });
    } else if (stat && stat.isDirectory()) {
      this.broadcast(project, { type: 'fs', path: rel, kind: 'dir' });
    } else {
      st.known.delete(rel);
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
