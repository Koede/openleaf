const express = require('express');
const multer = require('multer');
const AdmZip = require('adm-zip');
const fs = require('fs');
const path = require('path');
const U = require('./util');
const { USER_RE } = require('./accounts');
const { httpErr } = U;
const templates = require('./templates');
const history = require('./history');
const compiler = require('./compile');
const search = require('./search');
const { wordCount } = require('./wordcount');

module.exports = function routes({ root, hub, timeoutMs, stallMs, maxProjects = 200, accounts = null, shares = null }) {
  const r = express.Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });
  const wrap = (fn) => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);
  const rootOf = (req) => req.userRoot || root;
  const ownRoot = (req) => req.ownRoot || rootOf(req);     // the signed-in user's own folder, also while in a shared project
  const keyOf = (req, n) => (req.scope || '') + n;      // hub/compiler key; prefixed by the account in multi-user mode
  const pname = (req) => req.projectName || req.params.p;  // "thesis" for "alice/thesis" opened by a collaborator
  const countProjects = (dir) => fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && U.NAME_RE.test(e.name)).length;
  const checkQuota = (req) => { if (countProjects(ownRoot(req)) >= maxProjects) throw httpErr(403, `Project limit reached (${maxProjects}). Delete a project first.`); };
  const pdirOf = (req) => { const d = U.projectDir(rootOf(req), pname(req)); if (!fs.existsSync(d)) throw httpErr(404, 'Project not found'); return d; };
  // Every request that touches a project first writes out pending collaborative edits, so compiling,
  // downloading, searching and word counts always see what is on screen.
  const P = (req) => { const name = keyOf(req, pname(req)); const dir = pdirOf(req); if (hub.collab) hub.collab.flush(name); return { name, label: pname(req), dir }; };
  const ownerOnly = (req, what) => { if (req.role && req.role !== 'owner') throw httpErr(403, `Only the project's owner can ${what}`); };

  // Shared projects: a collaborator addresses one as "owner/project". Resolve it to the owner's folder and
  // check the role; viewers may read, compile and search, but not change anything.
  const VIEWER_OK = /\/(compile|compile\/stop|clean|search|share\/leave|copy|chat)$/;
  r.param('p', (req, res, next, p) => {
    if (req.ownRoot === undefined) { req.ownRoot = req.userRoot; req.ownScope = req.scope; }
    req.role = 'owner'; req.shared = false;
    if (shares && req.user && String(p).includes('/')) {
      const i = p.indexOf('/'), owner = p.slice(0, i), project = p.slice(i + 1);
      if (!USER_RE.test(owner) || !U.NAME_RE.test(project)) return next(httpErr(400, 'Invalid project name'));
      const role = accounts.users[owner] ? shares.roleOf(req.user, owner, project) : null;
      if (!role) return next(httpErr(404, 'Project not found'));
      Object.assign(req, { userRoot: accounts.root_(owner), scope: owner + '/', projectName: project, role, shared: role !== 'owner' });
    }
    if (req.role === 'view' && req.method !== 'GET' && !(req.method === 'POST' && VIEWER_OK.test(req.path))) return next(httpErr(403, 'You can view this project but not change it'));
    next();
  });
  const clientId = (req) => String(req.get('x-client-id') || '').slice(0, 40);

  // ---------- projects ----------
  r.get('/projects', wrap((req, res) => {
    const list = fs.readdirSync(rootOf(req), { withFileTypes: true }).filter((e) => e.isDirectory() && U.NAME_RE.test(e.name))
      .map((e) => ({ name: e.name, mtime: fs.statSync(path.join(rootOf(req), e.name)).mtimeMs })).sort((a, b) => a.name.localeCompare(b.name));
    const shared = shares && req.user ? shares.sharedWith(req.user).filter((x) => fs.existsSync(path.join(accounts.root_(x.owner), x.project))) : [];
    res.json({ projects: list.map((p) => p.name), details: list, shared, user: req.user || null, synctex: compiler.HAVE.synctex, latexmk: compiler.HAVE.latexmk, templates: templates.list.map(({ id, name, description }) => ({ id, name, description })) });
  }));

  r.post('/projects', wrap((req, res) => {
    checkQuota(req);
    const d = U.projectDir(rootOf(req), req.body.name);
    if (fs.existsSync(d)) throw httpErr(409, 'A project with that name already exists');
    const t = templates.list.find((x) => x.id === req.body.template) || templates.list.find((x) => x.id === 'blank');
    fs.mkdirSync(d, { recursive: true });
    for (const [f, c] of Object.entries(t.files)) U.atomicWrite(path.join(d, f), c);
    res.json({ ok: true });
  }));

  r.post('/projects/:p/rename', wrap((req, res) => {
    ownerOnly(req, 'rename it');
    const d = pdirOf(req); const to = U.projectDir(rootOf(req), req.body.to);
    if (fs.existsSync(to)) throw httpErr(409, 'A project with that name already exists');
    compiler.cancel(keyOf(req, pname(req))); hub.gc(keyOf(req, pname(req)), true);
    fs.renameSync(d, to); if (shares && req.user) shares.rename(req.user, pname(req), req.body.to);
    res.json({ ok: true });
  }));

  r.post('/projects/:p/copy', wrap((req, res) => {
    checkQuota(req);
    const d = pdirOf(req); const to = U.projectDir(ownRoot(req), req.body.to);   // a copy of a shared project is your own
    if (fs.existsSync(to)) throw httpErr(409, 'A project with that name already exists');
    fs.cpSync(d, to, { recursive: true, filter: (src) => path.basename(src) !== U.BUILD });
    res.json({ ok: true });
  }));

  r.delete('/projects/:p', wrap((req, res) => {
    ownerOnly(req, 'delete it');
    const d = pdirOf(req); compiler.cancel(keyOf(req, pname(req))); hub.gc(keyOf(req, pname(req)), true);
    fs.rmSync(d, { recursive: true, force: true }); if (shares && req.user) shares.drop(req.user, pname(req));
    res.json({ ok: true });
  }));

  // ---------- project chat ----------
  const chatFile = (dir) => path.join(dir, U.CHAT);
  const readChat = (dir) => { try { return JSON.parse(fs.readFileSync(chatFile(dir), 'utf8')); } catch { return []; } };
  r.get('/p/:p/chat', wrap((req, res) => { const { dir } = P(req); res.json({ messages: readChat(dir).slice(-300), me: req.user || null }); }));
  r.post('/p/:p/chat', wrap((req, res) => {
    const { name, dir } = P(req);
    const text = String(req.body.text || '').replace(/\r\n?/g, '\n').trim().slice(0, 4000);
    if (!text) throw httpErr(400, 'Empty message');
    const all = readChat(dir); const message = { id: require('crypto').randomBytes(5).toString('hex'), user: req.user || null, text, ts: Date.now() };
    all.push(message); U.atomicWrite(chatFile(dir), JSON.stringify(all.slice(-2000)));
    hub.broadcast(name, { type: 'chat', message });
    res.json({ ok: true, message });
  }));

  // ---------- sharing (accounts mode) ----------
  const needShares = () => { if (!shares) throw httpErr(404, 'Sharing needs accounts (ACCOUNTS=1)'); };
  const ownerOf = (req) => req.scope.slice(0, -1);
  r.get('/p/:p/share', wrap((req, res) => { needShares(); pdirOf(req); res.json({ role: req.role, me: req.user, ...shares.info(ownerOf(req), pname(req), req.role === 'owner') }); }));
  r.post('/p/:p/share/invite', wrap((req, res) => {
    needShares(); ownerOnly(req, 'share it'); pdirOf(req);
    const u = String(req.body.user || '').trim().toLowerCase();
    if (!accounts.users[u]) throw httpErr(404, `There is no account called "${u}" on this server`);
    shares.invite(req.user, pname(req), u, req.body.role); res.json({ ok: true });
  }));
  r.post('/p/:p/share/remove', wrap((req, res) => { needShares(); ownerOnly(req, 'change who it is shared with'); shares.remove(req.user, pname(req), String(req.body.user || '')); res.json({ ok: true }); }));
  r.post('/p/:p/share/leave', wrap((req, res) => { needShares(); if (!req.shared) throw httpErr(400, 'You own this project'); shares.remove(ownerOf(req), pname(req), req.user); res.json({ ok: true }); }));
  r.post('/p/:p/share/link', wrap((req, res) => { needShares(); ownerOnly(req, 'change its share links'); pdirOf(req); res.json({ token: shares.setLink(req.user, pname(req), req.body.role, !!req.body.on) }); }));
  r.post('/share/join', wrap((req, res) => { needShares(); res.json(shares.join(req.user, String(req.body.token || ''))); }));

  // ---------- settings ----------
  r.get('/p/:p/settings', wrap((req, res) => {
    const { dir } = P(req); const s = U.readSettings(dir); const det = U.detectMain(dir);
    res.json({ main: s.main && fs.existsSync(path.join(dir, s.main)) ? s.main : det.main, engine: s.engine || 'pdflatex', haltOnError: !!s.haltOnError, draft: !!s.draft, trackChanges: !!s.trackChanges, candidates: det.candidates });
  }));
  r.put('/p/:p/settings', wrap((req, res) => {
    const { dir } = P(req); const s = U.readSettings(dir); const b = req.body || {};
    if (b.main !== undefined) { if (b.main) { const { rel } = U.resolveIn(dir, b.main); if (!/\.tex$/i.test(rel)) throw httpErr(400, 'Main file must be .tex'); s.main = rel; } else delete s.main; }
    if (b.engine !== undefined) { if (!compiler.ENGINES[b.engine]) throw httpErr(400, 'Unknown engine'); s.engine = b.engine; }
    if (b.haltOnError !== undefined) s.haltOnError = !!b.haltOnError;
    if (b.draft !== undefined) s.draft = !!b.draft;
    if (b.trackChanges !== undefined) s.trackChanges = !!b.trackChanges;
    fs.writeFileSync(path.join(dir, U.SETTINGS), JSON.stringify(s, null, 2));
    hub.broadcast(P(req).name, { type: 'settings' });   // e.g. track changes switched on for everyone
    res.json({ ok: true });
  }));

  // ---------- files ----------
  r.get('/p/:p/tree', wrap((req, res) => { const { dir } = P(req); res.json({ tree: U.listTree(dir), ...U.detectMain(dir) }); }));

  r.get('/p/:p/raw', wrap((req, res) => {
    const { dir } = P(req); const { abs } = U.resolveIn(dir, req.query.path);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw httpErr(404, 'Not found');
    res.set('Cache-Control', 'no-store');
    if (req.query.download) res.attachment(path.basename(abs));
    res.sendFile(abs);
  }));

  r.put('/p/:p/file', wrap((req, res) => {
    const { name, dir } = P(req); const { abs, rel } = U.resolveIn(dir, req.body.path);
    if (!rel) throw httpErr(400, 'Invalid path');
    if (typeof req.body.content !== 'string') throw httpErr(400, 'content required');
    let old = null; try { old = fs.readFileSync(abs); } catch {}
    if (old) history.baseline(dir, rel, old);
    const buf = Buffer.from(req.body.content, 'utf8');
    U.atomicWrite(abs, buf);
    hub.noteWrite(name, rel, buf);
    history.snapshot(dir, rel, buf);
    res.json({ ok: true });
  }));

  r.post('/p/:p/ops', wrap((req, res) => {
    const { name, dir } = P(req); const { op, path: p, to } = req.body;
    const { abs, rel } = U.resolveIn(dir, p);
    if (!rel) throw httpErr(400, 'Invalid path');
    if (op === 'create') {
      if (fs.existsSync(abs)) throw httpErr(409, 'Already exists');
      U.atomicWrite(abs, ''); hub.noteWrite(name, rel, Buffer.alloc(0));
    } else if (op === 'mkdir') fs.mkdirSync(abs, { recursive: true });
    else if (op === 'rename') {
      const dst = U.resolveIn(dir, to);
      if (!dst.rel) throw httpErr(400, 'Invalid target');
      if (fs.existsSync(dst.abs)) throw httpErr(409, 'Target already exists');
      if (dst.abs.startsWith(abs + path.sep)) throw httpErr(400, 'Cannot move a folder into itself');
      fs.mkdirSync(path.dirname(dst.abs), { recursive: true });
      fs.renameSync(abs, dst.abs); hub.noteRemove(name, rel);
    } else if (op === 'delete') {
      const files = fs.existsSync(abs) && fs.statSync(abs).isDirectory() ? U.walkFiles(abs).map((f) => rel + '/' + f) : [rel];
      for (const f of files) { try { const b = fs.readFileSync(path.join(dir, f)); history.baseline(dir, f, b); history.snapshot(dir, f, b, { force: true }); } catch {} }
      fs.rmSync(abs, { recursive: true, force: true }); hub.noteRemove(name, rel);
    } else throw httpErr(400, 'Unknown op');
    res.json({ ok: true });
  }));

  r.post('/p/:p/upload', upload.array('files'), wrap((req, res) => {
    const { name, dir } = P(req);
    const paths = [].concat(req.body.paths || []); const base = U.cleanRel(req.body.dir || '');
    let n = 0;
    (req.files || []).forEach((file, i) => {
      const { abs, rel } = U.resolveIn(dir, (base ? base + '/' : '') + (paths[i] || file.originalname));
      if (!rel) return;
      let old = null; try { old = fs.readFileSync(abs); } catch {}
      if (old) history.baseline(dir, rel, old);
      U.atomicWrite(abs, file.buffer); hub.noteWrite(name, rel, file.buffer); n++;
    });
    res.json({ ok: true, count: n });
  }));

  r.post('/import', upload.single('zip'), wrap((req, res) => {
    checkQuota(req);
    const d = U.projectDir(rootOf(req), req.body.name);
    if (fs.existsSync(d)) throw httpErr(409, 'A project with that name already exists');
    if (!req.file) throw httpErr(400, 'No zip uploaded');
    let zip; try { zip = new AdmZip(req.file.buffer); } catch { throw httpErr(400, 'Not a valid zip file'); }
    const entries = zip.getEntries().filter((e) => {
      if (e.isDirectory || e.entryName.startsWith('__MACOSX/')) return false;
      const n = path.posix.normalize(e.entryName.replace(/\\/g, '/'));
      return !n.startsWith('../') && !n.startsWith('/') && !U.HIDDEN.has(n.split('/')[0]);
    });
    const tops = new Set(entries.map((e) => e.entryName.split('/')[0]));
    const strip = tops.size === 1 && entries.every((e) => e.entryName.includes('/')) ? [...tops][0] + '/' : '';
    fs.mkdirSync(d, { recursive: true });
    let n = 0;
    for (const e of entries) {
      let abs; try { abs = U.resolveIn(d, e.entryName.slice(strip.length)).abs; } catch { continue; }
      U.atomicWrite(abs, e.getData()); n++;
    }
    res.json({ ok: true, count: n });
  }));

  r.get('/p/:p/download.zip', wrap((req, res) => {
    const { label, dir } = P(req); const zip = new AdmZip();
    for (const f of U.walkFiles(dir)) { const d = path.posix.dirname(f); zip.addFile(f, fs.readFileSync(path.join(dir, f))); void d; }
    res.attachment(label + '.zip'); res.type('application/zip').send(zip.toBuffer());
  }));

  // ---------- history ----------
  r.get('/p/:p/history', wrap((req, res) => { const { dir } = P(req); const { rel } = U.resolveIn(dir, req.query.path); res.json({ versions: history.list(dir, rel) }); }));
  r.get('/p/:p/history/deleted', wrap((req, res) => { const { dir } = P(req); res.json({ files: history.deleted(dir) }); }));
  r.get('/p/:p/history/content', wrap((req, res) => {
    const { dir } = P(req); const { rel } = U.resolveIn(dir, req.query.path);
    const t = history.read(dir, rel, req.query.ts); if (t === null) throw httpErr(404, 'Version not found');
    res.type('text/plain').send(t);
  }));
  r.post('/p/:p/history/restore', wrap((req, res) => {
    const { name, dir } = P(req); const { abs, rel } = U.resolveIn(dir, req.body.path);
    const t = history.read(dir, rel, req.body.ts); if (t === null) throw httpErr(404, 'Version not found');
    try { history.snapshot(dir, rel, fs.readFileSync(abs), { force: true }); } catch {}
    const buf = Buffer.from(t, 'utf8'); U.atomicWrite(abs, buf); hub.noteWrite(name, rel, buf);
    res.json({ ok: true, content: t });
  }));

  // ---------- search / replace / word count ----------
  r.post('/p/:p/search', wrap((req, res) => { const { dir } = P(req); res.json(search.search(dir, req.body)); }));
  r.post('/p/:p/replace', wrap((req, res) => {
    const { name, dir } = P(req);
    const out = search.replaceAll(dir, req.body, String(req.body.replacement ?? ''), req.body.files);
    for (const c of out.changed) { try { hub.noteWrite(name, c.file, fs.readFileSync(path.join(dir, c.file))); } catch {} }
    res.json(out);
  }));
  r.get('/p/:p/wordcount', wrap((req, res) => {
    const { dir } = P(req); const s = U.readSettings(dir);
    const main = req.query.main ? U.resolveIn(dir, req.query.main).rel : s.main || U.detectMain(dir).main;
    if (!main || !fs.existsSync(path.join(dir, main))) return res.json({ words: 0, noMain: true });   // nothing to count yet
    res.json(wordCount(dir, main));
  }));

  // ---------- compile ----------
  r.post('/p/:p/compile', wrap(async (req, res) => {
    const { name, dir } = P(req);
    if (!compiler.HAVE.latexmk) throw httpErr(500, 'latexmk is not installed on the server (install TeX Live / MacTeX)');
    const s = U.readSettings(dir); const b = req.body || {};
    const main = b.main ? U.resolveIn(dir, b.main).rel : (s.main && fs.existsSync(path.join(dir, s.main)) ? s.main : U.detectMain(dir).main);
    if (!main) throw httpErr(400, 'No main .tex file found (it needs \\documentclass and \\begin{document})');
    if (!/\.tex$/i.test(main)) throw httpErr(400, 'Main file must be a .tex file');
    const by = clientId(req);
    hub.broadcast(name, { type: 'compile-start', by });
    const result = await compiler.compile({
      name, pdir: dir, main, engine: b.engine || s.engine || 'pdflatex', haltOnError: b.haltOnError ?? s.haltOnError, draft: b.draft ?? s.draft, timeoutMs, stallMs,
      onOutput: (chunk) => hub.broadcast(name, { type: 'compile-log', chunk, by }),
    });
    if (!result.superseded) hub.broadcast(name, { type: 'compiled', by, result });
    res.json(result);
  }));

  // Stop a running compile; the previous PDF stays.
  r.post('/p/:p/compile/stop', wrap((req, res) => { const { name } = P(req); res.json({ ok: true, stopped: compiler.stop(name) }); }));

  r.post('/p/:p/clean', wrap((req, res) => { const { name, dir } = P(req); compiler.cancel(name); fs.rmSync(path.join(dir, U.BUILD), { recursive: true, force: true }); res.json({ ok: true }); }));

  r.get('/p/:p/output.pdf', wrap((req, res) => {
    const { label, dir } = P(req); const f = path.join(dir, U.BUILD, 'output.pdf');
    if (!fs.existsSync(f)) throw httpErr(404, 'No PDF yet');
    res.set('Cache-Control', 'no-store');
    if (req.query.download) res.attachment(label + '.pdf');
    res.sendFile(f, { dotfiles: 'allow' });
  }));
  r.get('/p/:p/build-log', wrap((req, res) => {
    const { dir } = P(req); const bdir = path.join(dir, U.BUILD);
    const logs = fs.existsSync(bdir) ? fs.readdirSync(bdir).filter((f) => f.endsWith('.log')) : [];
    if (!logs.length) throw httpErr(404, 'No log yet');
    res.type('text/plain').sendFile(path.join(bdir, logs[0]), { dotfiles: 'allow' });
  }));

  r.get('/p/:p/synctex/edit', wrap((req, res) => {
    const { dir } = P(req); const n = (k) => Number(req.query[k]);
    if (![n('page'), n('x'), n('y')].every(Number.isFinite)) throw httpErr(400, 'bad coordinates');
    res.json(compiler.syncEdit(dir, String(req.query.pdf || ''), n('page'), n('x'), n('y')));
  }));
  r.get('/p/:p/synctex/view', wrap((req, res) => {
    const { dir } = P(req); const { rel } = U.resolveIn(dir, req.query.file);
    res.json(compiler.syncView(dir, String(req.query.pdf || ''), rel, Number(req.query.line) || 1, Number(req.query.col) || 0));
  }));

  return r;
};
