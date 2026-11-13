// Bug reports and feature requests sent from the app ("Feedback" in the top bar).
// Stored on the server in <PROJECTS_DIR>/.openleaf/feedback.json. Everyone sees what they sent;
// admins see everything and can set a status. Admins: the users in ADMIN_USERS (comma-separated),
// or, if that is not set, the first account that was created. Without accounts (a single-user
// server) the one user is the admin.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const U = require('./util');

const KINDS = ['bug', 'feature'];
const STATUSES = ['open', 'planned', 'in progress', 'done', 'won’t do'];
const MAX_ITEMS = 5000, PER_HOUR = 15;
const httpErr = (status, message) => Object.assign(new Error(message), { status });
const str = (v, max) => String(v ?? '').replace(/\r\n?/g, '\n').slice(0, max);

function feedbackRouter({ root, accounts, info = {} }) {
  const r = express.Router();
  const dir = path.join(root, '.openleaf'), file = path.join(dir, 'feedback.json');
  const load = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; } };
  const save = (items) => { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); U.atomicWrite(file, JSON.stringify(items, null, 1)); };
  const recent = new Map(); // user -> timestamps of recent submissions

  const admins = () => {
    const list = String(process.env.ADMIN_USERS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (list.length || !accounts) return list;
    const first = Object.entries(accounts.users).sort((a, b) => (a[1].created || 0) - (b[1].created || 0))[0];
    return first ? [first[0]] : [];
  };
  const who = (req) => req.user || null;
  const isAdmin = (req) => !accounts || admins().includes(who(req));

  r.get('/feedback', (req, res) => {
    const admin = isAdmin(req), me = who(req);
    const items = load().filter((it) => admin || it.user === me).sort((a, b) => b.created - a.created);
    res.json({ items, admin, statuses: STATUSES, github: process.env.FEEDBACK_GITHUB ?? 'Koede/openleaf', server: info });
  });

  r.post('/feedback', (req, res) => {
    const b = req.body || {};
    const kind = KINDS.includes(b.kind) ? b.kind : null;
    const title = str(b.title, 200).trim(), body = str(b.body, 20000).trim(), diag = str(b.diag, 20000).trim();
    if (!kind) throw httpErr(400, 'Choose "Bug" or "Feature request"');
    if (!title) throw httpErr(400, 'Add a short title');
    const me = who(req) || '';
    const now = Date.now(), times = (recent.get(me) || []).filter((t) => now - t < 3600e3);
    if (times.length >= PER_HOUR) throw httpErr(429, 'That is a lot of feedback for one hour. Please try again later.');
    recent.set(me, [...times, now]);
    const items = load();
    if (items.length >= MAX_ITEMS) throw httpErr(507, 'The feedback list is full. An admin needs to clear old items.');
    const it = { id: crypto.randomBytes(5).toString('hex'), kind, title, body, diag, user: who(req), created: now, updated: now, status: 'open' };
    items.push(it); save(items);
    res.json({ ok: true, item: it });
  });

  r.patch('/feedback/:id', (req, res) => {
    if (!isAdmin(req)) throw httpErr(403, 'Only an admin can change the status');
    const items = load(); const it = items.find((x) => x.id === req.params.id);
    if (!it) throw httpErr(404, 'Not found');
    if (req.body.status !== undefined) { if (!STATUSES.includes(req.body.status)) throw httpErr(400, 'Unknown status'); it.status = req.body.status; }
    if (req.body.note !== undefined) it.note = str(req.body.note, 4000);
    it.updated = Date.now(); save(items); res.json({ ok: true, item: it });
  });

  r.delete('/feedback/:id', (req, res) => {
    const items = load(); const i = items.findIndex((x) => x.id === req.params.id);
    if (i < 0) throw httpErr(404, 'Not found');
    if (!isAdmin(req) && items[i].user !== who(req)) throw httpErr(403, 'You can only delete your own feedback');
    items.splice(i, 1); save(items); res.json({ ok: true });
  });
  return r;
}

module.exports = { feedbackRouter, STATUSES };
