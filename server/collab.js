// Real-time collaborative editing (several people typing in one file at once), with Yjs.
//
// The server keeps one Y.Doc per open text file and project. Clients join it over the existing
// websocket ("y-join"), get its full state ("y-sync"), and from then on exchange incremental updates
// ("y-update") and cursor/selection presence ("y-aw"), which the server relays to the other people in
// the same file. The server writes the file to disk itself (debounced, with history snapshots), so
// clients no longer PUT collaborative files.
//
// Changes that do not come through Yjs (another tab without collaboration, history restore, replace-all,
// an editor outside the app, git) are merged into the live document as a minimal diff, so nobody's
// view goes stale and nothing is overwritten. Each loaded document has an epoch; a client that comes
// back after the server dropped the document resyncs from scratch and re-applies its own text.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Y = require('yjs');
const U = require('./util');
const history = require('./history');

const b64 = (u8) => Buffer.from(u8).toString('base64');
const unb64 = (s) => new Uint8Array(Buffer.from(String(s || ''), 'base64'));
const SAVE_MS = 350, IDLE_MS = 10 * 60 * 1000, MAX_UPDATE = 4 * 1024 * 1024;

// Replace the differing middle of `ytext` so that it reads `next` (common prefix/suffix kept).
function applyDiff(ytext, next, origin) {
  const cur = ytext.toString(); if (cur === next) return false;
  let a = 0; const n = Math.min(cur.length, next.length);
  while (a < n && cur.charCodeAt(a) === next.charCodeAt(a)) a++;
  let b = 0; while (b < n - a && cur.charCodeAt(cur.length - 1 - b) === next.charCodeAt(next.length - 1 - b)) b++;
  ytext.doc.transact(() => { if (cur.length - a - b) ytext.delete(a, cur.length - a - b); if (next.length - a - b) ytext.insert(a, next.slice(a, next.length - b)); }, origin);
  return true;
}

class Collab {
  constructor(root, hub) { this.root = root; this.hub = hub; this.docs = new Map(); }
  k(project, rel) { return project + '\u0000' + rel; }

  // ---------- documents ----------
  load(project, rel) {
    const key = this.k(project, rel); let d = this.docs.get(key);
    if (d) { clearTimeout(d.idle); d.idle = null; return d; }
    const dir = path.join(this.root, project);
    const { abs } = U.resolveIn(dir, rel);
    if (!U.isTextFile(rel)) throw new Error('not a text file');
    const text = fs.readFileSync(abs, 'utf8');
    const ydoc = new Y.Doc(); ydoc.getText('t').insert(0, text);
    d = { key, project, rel, dir, abs, ydoc, text: ydoc.getText('t'), conns: new Map(), saved: text, timer: null, idle: null, epoch: crypto.randomBytes(6).toString('hex') };
    ydoc.on('update', (update, origin) => {
      for (const [c] of d.conns) if (c !== origin && c.ws.readyState === 1) c.ws.send(JSON.stringify({ type: 'y-update', project: c.name, path: rel, update: b64(update) }));
      if (origin !== 'disk') this.scheduleSave(d);
    });
    this.docs.set(key, d);
    return d;
  }
  scheduleSave(d) { clearTimeout(d.timer); d.timer = setTimeout(() => this.save(d), SAVE_MS); }
  save(d) {
    clearTimeout(d.timer); d.timer = null;
    const text = d.text.toString(); if (text === d.saved) return;
    if (!fs.existsSync(path.dirname(d.abs))) return;   // folder deleted meanwhile
    try {
      const old = fs.existsSync(d.abs) ? fs.readFileSync(d.abs) : null;
      if (old) history.baseline(d.dir, d.rel, old);
      const buf = Buffer.from(text, 'utf8');
      U.atomicWrite(d.abs, buf); d.saved = text;
      this.hub.noteWrite(d.project, d.rel, buf, { fromCollab: true });
      history.snapshot(d.dir, d.rel, buf);
    } catch {}
  }
  // write everything pending for a project (before a compile, a download, a search…)
  flush(project) { for (const d of this.docs.values()) if (d.project === project && d.timer) this.save(d); }

  // The file changed on disk outside Yjs: merge it into the live document.
  diskChanged(project, rel, buf) {
    const d = this.docs.get(this.k(project, rel)); if (!d) return;
    const next = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
    if (next === d.saved && next === d.text.toString()) return;
    if (d.timer) this.save(d);          // keep edits typed in the last few hundred ms
    d.saved = next;
    applyDiff(d.text, next, 'disk');
  }
  removed(project, rel) {
    for (const d of [...this.docs.values()]) {
      if (d.project !== project || !(d.rel === rel || d.rel.startsWith(rel + '/'))) continue;
      clearTimeout(d.timer); clearTimeout(d.idle);
      for (const [c] of d.conns) if (c.ws.readyState === 1) c.ws.send(JSON.stringify({ type: 'y-closed', project: c.name, path: d.rel }));
      this.docs.delete(d.key);
    }
  }

  // ---------- connections ----------
  onMessage(c, m) {
    if (!c.project || typeof m.path !== 'string') return;
    let d;
    try { d = m.type === 'y-join' ? this.load(c.project, U.cleanRel(m.path)) : this.docs.get(this.k(c.project, U.cleanRel(m.path))); } catch { return void c.ws.send(JSON.stringify({ type: 'y-error', project: c.name, path: m.path })); }
    if (!d) return;
    if (m.type === 'y-join') {
      d.conns.set(c, { aw: Number(m.aw) || 0 }); (c.ydocs ||= new Set()).add(d);
      c.ws.send(JSON.stringify({ type: 'y-sync', project: c.name, path: d.rel, epoch: d.epoch, state: b64(Y.encodeStateAsUpdate(d.ydoc)), readOnly: c.role === 'view' }));
    } else if (m.type === 'y-update') {
      if (!d.conns.has(c) || c.role === 'view' || typeof m.update !== 'string' || m.update.length > MAX_UPDATE) return;
      try { Y.applyUpdate(d.ydoc, unb64(m.update), c); } catch {}
    } else if (m.type === 'y-aw') {
      if (!d.conns.has(c) || typeof m.update !== 'string' || m.update.length > 64 * 1024) return;
      for (const [o] of d.conns) if (o !== c && o.ws.readyState === 1) o.ws.send(JSON.stringify({ type: 'y-aw', project: o.name, path: d.rel, update: m.update }));
    } else if (m.type === 'y-leave') this.leave(c, d);
  }
  leave(c, d) {
    const info = d.conns.get(c); if (!info) return;
    d.conns.delete(c); c.ydocs && c.ydocs.delete(d);
    if (info.aw) for (const [o] of d.conns) if (o.ws.readyState === 1) o.ws.send(JSON.stringify({ type: 'y-aw-gone', project: o.name, path: d.rel, ids: [info.aw] }));
    if (!d.conns.size) { this.save(d); d.idle = setTimeout(() => { if (!d.conns.size) { this.save(d); this.docs.delete(d.key); } }, IDLE_MS); }
  }
  closed(c) { for (const d of [...(c.ydocs || [])]) this.leave(c, d); }
  // switching project on a connection: leave that project's documents
  switched(c) { for (const d of [...(c.ydocs || [])]) if (d.project !== c.project) this.leave(c, d); }
  shutdown() { for (const d of this.docs.values()) { this.save(d); clearTimeout(d.idle); } }
}

module.exports = { Collab, applyDiff };
