const express = require('express');
const multer = require('multer');
const AdmZip = require('adm-zip');
const fs = require('fs');
const path = require('path');
const U = require('./util');
const { httpErr } = U;
const templates = require('./templates');
const history = require('./history');
const compiler = require('./compile');
const search = require('./search');
const { wordCount } = require('./wordcount');

module.exports = function routes({ root, hub, timeoutMs }) {
  const r = express.Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });
  const wrap = (fn) => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);
  const pdirOf = (req) => { const d = U.projectDir(root, req.params.p); if (!fs.existsSync(d)) throw httpErr(404, 'Project not found'); return d; };
  const P = (req) => ({ name: req.params.p, dir: pdirOf(req) });
  const clientId = (req) => String(req.get('x-client-id') || '').slice(0, 40);

  // ---------- projects ----------
  r.get('/projects', wrap((req, res) => {
    const list = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && U.NAME_RE.test(e.name))
      .map((e) => ({ name: e.name, mtime: fs.statSync(path.join(root, e.name)).mtimeMs })).sort((a, b) => a.name.localeCompare(b.name));
    res.json({ projects: list.map((p) => p.name), details: list, synctex: compiler.HAVE.synctex, latexmk: compiler.HAVE.latexmk, templates: templates.list.map(({ id, name, description }) => ({ id, name, description })) });
  }));

  r.post('/projects', wrap((req, res) => {
    const d = U.projectDir(root, req.body.name);
    if (fs.existsSync(d)) throw httpErr(409, 'A project with that name already exists');
    const t = templates.list.find((x) => x.id === req.body.template) || templates.list.find((x) => x.id === 'blank');
    fs.mkdirSync(d, { recursive: true });
    for (const [f, c] of Object.entries(t.files)) U.atomicWrite(path.join(d, f), c);
    res.json({ ok: true });
  }));

  r.post('/projects/:p/rename', wrap((req, res) => {
    const d = pdirOf(req); const to = U.projectDir(root, req.body.to);
    if (fs.existsSync(to)) throw httpErr(409, 'A project with that name already exists');
    compiler.cancel(req.params.p); hub.gc(req.params.p, true);
    fs.renameSync(d, to); res.json({ ok: true });
  }));

  r.post('/projects/:p/copy', wrap((req, res) => {
    const d = pdirOf(req); const to = U.projectDir(root, req.body.to);
    if (fs.existsSync(to)) throw httpErr(409, 'A project with that name already exists');
    fs.cpSync(d, to, { recursive: true, filter: (src) => path.basename(src) !== U.BUILD });
    res.json({ ok: true });
  }));

  r.delete('/projects/:p', wrap((req, res) => {
    const d = pdirOf(req); compiler.cancel(req.params.p); hub.gc(req.params.p, true);
    fs.rmSync(d, { recursive: true, force: true }); res.json({ ok: true });
  }));

  // ---------- settings ----------
  r.get('/p/:p/settings', wrap((req, res) => {
    const { dir } = P(req); const s = U.readSettings(dir); const det = U.detectMain(dir);
    res.json({ main: s.main && fs.existsSync(path.join(dir, s.main)) ? s.main : det.main, engine: s.engine || 'pdflatex', haltOnError: !!s.haltOnError, candidates: det.candidates });
  }));
  r.put('/p/:p/settings', wrap((req, res) => {
    const { dir } = P(req); const s = U.readSettings(dir); const b = req.body || {};
    if (b.main !== undefined) { if (b.main) { const { rel } = U.resolveIn(dir, b.main); if (!/\.tex$/i.test(rel)) throw httpErr(400, 'Main file must be .tex'); s.main = rel; } else delete s.main; }
    if (b.engine !== undefined) { if (!compiler.ENGINES[b.engine]) throw httpErr(400, 'Unknown engine'); s.engine = b.engine; }
    if (b.haltOnError !== undefined) s.haltOnError = !!b.haltOnError;
    fs.writeFileSync(path.join(dir, U.SETTINGS), JSON.stringify(s, null, 2));
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
    const d = U.projectDir(root, req.body.name);
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
    const { name, dir } = P(req); const zip = new AdmZip();
    for (const f of U.walkFiles(dir)) { const d = path.posix.dirname(f); zip.addFile(f, fs.readFileSync(path.join(dir, f))); void d; }
    res.attachment(name + '.zip'); res.type('application/zip').send(zip.toBuffer());
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
    if (!main) throw httpErr(400, 'No main file');
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
      name, pdir: dir, main, engine: b.engine || s.engine || 'pdflatex', haltOnError: b.haltOnError ?? s.haltOnError, timeoutMs,
      onOutput: (chunk) => hub.broadcast(name, { type: 'compile-log', chunk, by }),
    });
    if (!result.superseded) hub.broadcast(name, { type: 'compiled', by, result });
    res.json(result);
  }));

  r.post('/p/:p/clean', wrap((req, res) => { const { name, dir } = P(req); compiler.cancel(name); fs.rmSync(path.join(dir, U.BUILD), { recursive: true, force: true }); res.json({ ok: true }); }));

  r.get('/p/:p/output.pdf', wrap((req, res) => {
    const { name, dir } = P(req); const f = path.join(dir, U.BUILD, 'output.pdf');
    if (!fs.existsSync(f)) throw httpErr(404, 'No PDF yet');
    res.set('Cache-Control', 'no-store');
    if (req.query.download) res.attachment(name + '.pdf');
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
