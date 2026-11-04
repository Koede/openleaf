// LaTeX Studio server.   node server.js   ->   http://127.0.0.1:3000
const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Hub } = require('./hub');
const makeRoutes = require('./routes');
const compiler = require('./compile');

function start(opts = {}) {
  const PORT = Number(opts.port ?? process.env.PORT ?? 3000);
  const HOST = opts.host ?? process.env.HOST ?? '127.0.0.1';
  const ROOT = path.resolve(opts.root ?? process.env.PROJECTS_DIR ?? path.join(__dirname, '..', 'projects'));
  const TOKEN = opts.token ?? process.env.AUTH_TOKEN ?? '';
  const TIMEOUT = Number(opts.timeoutMs ?? process.env.COMPILE_TIMEOUT_MS ?? 90000);
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(HOST);
  if (!loopback && !TOKEN) {
    console.error(`Refusing to listen on ${HOST} without AUTH_TOKEN: LaTeX compilation executes code.\nSet AUTH_TOKEN=<secret> (and ideally put it behind HTTPS), or use HOST=127.0.0.1.`);
    process.exit(1);
  }
  fs.mkdirSync(ROOT, { recursive: true });

  const allowedHosts = new Set(['localhost', '127.0.0.1', '[::1]', ...(process.env.ALLOWED_HOSTS || '').split(',').map((s) => s.trim()).filter(Boolean)]);
  if (!loopback) allowedHosts.add(HOST);
  const hostOk = (h) => allowedHosts.has(String(h || '').replace(/:\d+$/, '').toLowerCase());
  const cookieVal = TOKEN ? crypto.createHash('sha256').update('ls:' + TOKEN).digest('hex') : '';
  const cookieOf = (req) => /(?:^|;\s*)ls_auth=([a-f0-9]+)/.exec(req.headers.cookie || '')?.[1];
  const authed = (req) => !TOKEN || cookieOf(req) === cookieVal;

  // WebSocket handshakes get the same Host/Origin/auth checks as HTTP requests
  const hub = new Hub(ROOT, (req) => {
    if (!hostOk(req.headers.host)) return false;
    if (req.headers.origin) { try { if (new URL(req.headers.origin).host !== req.headers.host) return false; } catch { return false; } }
    return authed(req);
  });

  const app = express();
  app.disable('x-powered-by');
  // DNS-rebinding + CSRF protection: only our own host name, and same-origin for anything that changes state
  app.use((req, res, next) => {
    if (!hostOk(req.headers.host)) return res.status(403).type('text').send('Forbidden host');
    const o = req.headers.origin;
    if (o && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      let same = false; try { same = new URL(o).host === req.headers.host; } catch {}
      if (!same) return res.status(403).type('text').send('Cross-origin request blocked');
    }
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'SAMEORIGIN' });
    next();
  });
  if (TOKEN) {
    app.use((req, res, next) => {
      if (authed(req)) return next();
      const t = String(req.query.token || '');
      const a = Buffer.from(t), b = Buffer.from(TOKEN);
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
        res.cookie('ls_auth', cookieVal, { httpOnly: true, sameSite: 'strict', maxAge: 30 * 86400e3 });
        return res.redirect(req.path);
      }
      res.status(401).type('text').send('Unauthorized. Open the app once with ?token=<AUTH_TOKEN>.');
    });
  }
  app.use(express.json({ limit: '25mb' }));
  app.get('/favicon.ico', (q, r) => r.status(204).end());
  app.use('/api', makeRoutes({ root: ROOT, hub, timeoutMs: TIMEOUT }));
  app.use(express.static(path.join(__dirname, '..', 'public'), { etag: true, maxAge: 0 }));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err.status || (err.type === 'entity.too.large' ? 413 : err.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
    if (status === 500) console.error(err);
    res.status(status).json({ error: status === 500 ? 'Internal error: ' + err.message : err.message });
  });

  const server = http.createServer(app);
  hub.attach(server);
  return new Promise((resolve) => server.listen(PORT, HOST, () => {
    const port = server.address().port;
    if (!opts.quiet) {
      console.log(`LaTeX Studio running at http://${HOST === '::1' ? '[::1]' : HOST}:${port}   (projects in ${ROOT})`);
      console.log(`latexmk: ${compiler.HAVE.latexmk ? 'found' : 'MISSING — install TeX Live/MacTeX'} · synctex: ${compiler.HAVE.synctex ? 'found' : 'not found (PDF↔source jumping disabled)'}${TOKEN ? ' · auth token required' : ''}`);
    }
    resolve({ server, hub, port, root: ROOT, close: () => new Promise((r) => { hub.wss.close(); for (const c of hub.clients) c.ws.terminate(); [...hub.watchers.keys()].forEach((p) => hub.gc(p, true)); server.close(() => r()); }) });
  }));
}

module.exports = { start };
if (require.main === module) start();
