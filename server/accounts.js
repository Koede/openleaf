// Optional multi-user mode (ACCOUNTS=1): username/password accounts, cookie sessions, one private project folder per user.
//   <PROJECTS_DIR>/.accounts/users.json     scrypt password hashes
//   <PROJECTS_DIR>/.accounts/sessions.json  sha256(session token) -> { user, exp }
//   <PROJECTS_DIR>/<username>/<project>/    that user's files
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { httpErr } = require('./util');

const USER_RE = /^[a-z0-9][a-z0-9_-]{2,31}$/;
const COOKIE = 'ls_session';
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const KEYLEN = 64;
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, KEYLEN, { N: 16384, r: 8, p: 1 });

class Accounts {
  constructor(root, { allowSignup = true, sessionDays = 30, secureCookie = false } = {}) {
    this.root = root; this.allowSignup = allowSignup; this.ttl = sessionDays * 86400e3; this.secureCookie = secureCookie;
    this.dir = path.join(root, '.accounts'); fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.usersFile = path.join(this.dir, 'users.json'); this.sessFile = path.join(this.dir, 'sessions.json');
    this.users = this.load(this.usersFile); this.sessions = this.load(this.sessFile);
    this.attempts = new Map();
    this.dummy = { salt: crypto.randomBytes(16), hash: hashPw('dummy', Buffer.alloc(16)) };
    this.prune();
  }
  load(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } }
  save(f, obj) { const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(obj), { mode: 0o600 }); fs.renameSync(t, f); }
  prune() { const now = Date.now(); let ch = false; for (const [k, v] of Object.entries(this.sessions)) if (v.exp < now) { delete this.sessions[k]; ch = true; } if (ch) this.save(this.sessFile, this.sessions); }

  static validName(u) { return USER_RE.test(u); }
  root_(user) { return path.join(this.root, user); }

  register(username, password, { force = false } = {}) {
    if (!this.allowSignup && !force) throw httpErr(403, 'Registration is disabled on this server');
    const u = String(username || '').trim().toLowerCase();
    if (!USER_RE.test(u)) throw httpErr(400, 'Username must be 3–32 characters: letters, digits, "_" or "-"');
    this.checkPassword(password);
    if (this.users[u]) throw httpErr(409, 'That username is taken');
    const salt = crypto.randomBytes(16);
    this.users[u] = { salt: salt.toString('hex'), hash: hashPw(password, salt).toString('hex'), created: Date.now() };
    this.save(this.usersFile, this.users);
    fs.mkdirSync(this.root_(u), { recursive: true });
    return u;
  }
  checkPassword(pw) {
    if (typeof pw !== 'string' || pw.length < 8) throw httpErr(400, 'Password must be at least 8 characters');
    if (pw.length > 200) throw httpErr(400, 'Password is too long');
  }
  verify(username, password) {
    const u = String(username || '').trim().toLowerCase(); const rec = this.users[u];
    const salt = rec ? Buffer.from(rec.salt, 'hex') : this.dummy.salt;     // same work whether or not the user exists
    const got = hashPw(String(password || '').slice(0, 200), salt);
    const want = rec ? Buffer.from(rec.hash, 'hex') : this.dummy.hash;
    return rec && crypto.timingSafeEqual(got, want) ? u : null;
  }
  throttle(key) {
    const now = Date.now(); const a = (this.attempts.get(key) || []).filter((t) => now - t < 15 * 60e3);
    if (a.length >= 10) { this.attempts.set(key, a); throw httpErr(429, 'Too many attempts. Try again in a few minutes.'); }
    a.push(now); this.attempts.set(key, a);
    if (this.attempts.size > 5000) for (const [k, v] of this.attempts) if (!v.some((t) => now - t < 15 * 60e3)) this.attempts.delete(k);
  }
  clearAttempts(key) { this.attempts.delete(key); }

  createSession(user) {
    const token = crypto.randomBytes(32).toString('base64url');
    this.sessions[sha256(token)] = { user, exp: Date.now() + this.ttl };
    this.save(this.sessFile, this.sessions); return token;
  }
  userFor(token) {
    if (!token) return null; const s = this.sessions[sha256(token)];
    if (!s || s.exp < Date.now() || !this.users[s.user]) return null; return s.user;
  }
  destroy(token) { if (token && this.sessions[sha256(token)]) { delete this.sessions[sha256(token)]; this.save(this.sessFile, this.sessions); } }
  changePassword(user, oldPw, newPw, keepToken) {
    if (!this.verify(user, oldPw)) throw httpErr(403, 'Current password is incorrect');
    this.checkPassword(newPw);
    const salt = crypto.randomBytes(16);
    this.users[user] = { ...this.users[user], salt: salt.toString('hex'), hash: hashPw(newPw, salt).toString('hex') };
    this.save(this.usersFile, this.users);
    for (const [k, v] of Object.entries(this.sessions)) if (v.user === user && k !== sha256(keepToken || '')) delete this.sessions[k];   // sign out other devices
    this.save(this.sessFile, this.sessions);
  }

  tokenOf(req) { const m = new RegExp('(?:^|;\\s*)' + COOKIE + '=([A-Za-z0-9_-]+)').exec(req.headers.cookie || ''); return m && m[1]; }
  userOf(req) { return this.userFor(this.tokenOf(req)); }
  setCookie(res, token) { res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'strict', secure: this.secureCookie, maxAge: this.ttl, path: '/' }); }

  // Express: /api/auth/* endpoints, then a gate that scopes every other /api request to the signed-in user's folder.
  mount(app) {
    const ip = (req) => req.socket.remoteAddress || '?';
    const me = (req) => ({ accounts: true, user: this.userOf(req), signup: this.allowSignup });
    app.get('/api/auth/me', (req, res) => res.json(me(req)));
    app.post('/api/auth/register', (req, res, next) => { try {
      this.throttle('reg|' + ip(req));
      const u = this.register(req.body.username, req.body.password);
      this.setCookie(res, this.createSession(u)); res.json({ ok: true, user: u });
    } catch (e) { next(e); } });
    app.post('/api/auth/login', (req, res, next) => { try {
      const key = ip(req) + '|' + String(req.body.username || '').toLowerCase().slice(0, 40);
      this.throttle(key);
      const u = this.verify(req.body.username, req.body.password);
      if (!u) throw httpErr(401, 'Wrong username or password');
      this.clearAttempts(key); this.setCookie(res, this.createSession(u)); res.json({ ok: true, user: u });
    } catch (e) { next(e); } });
    app.post('/api/auth/logout', (req, res) => { this.destroy(this.tokenOf(req)); res.clearCookie(COOKIE, { path: '/' }); res.json({ ok: true }); });
    app.post('/api/auth/password', (req, res, next) => { try {
      const u = this.userOf(req); if (!u) throw httpErr(401, 'Sign in required');
      this.throttle('pw|' + u);
      this.changePassword(u, req.body.oldPassword, req.body.newPassword, this.tokenOf(req)); res.json({ ok: true });
    } catch (e) { next(e); } });
    app.use('/api', (req, res, next) => {
      const u = this.userOf(req);
      if (!u) return res.status(401).json({ error: 'Sign in required', auth: true });
      req.user = u; req.userRoot = this.root_(u); req.scope = u + '/';
      fs.mkdirSync(req.userRoot, { recursive: true });
      next();
    });
  }
  // WebSocket handshake: returns { scope } or false
  verifyWs(req) { const u = this.userOf(req); return u ? { scope: u + '/' } : false; }
}

module.exports = { Accounts, USER_RE };
