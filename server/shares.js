// Project sharing between accounts (as in Overleaf's Share dialog).
// The owner invites other accounts as editors or viewers, or turns on a link (edit or view) that adds
// whoever opens it, while signed in, with that role. Stored in <PROJECTS_DIR>/.openleaf/shares.json:
//   { "alice/thesis": { members: { bob: "edit", carol: "view" }, links: { edit: "<token>"|null, view: "<token>"|null } } }
// A shared project is addressed by its collaborators as "owner/project".
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const U = require('./util');

const ROLES = ['edit', 'view'];
const rank = { view: 1, edit: 2, owner: 3 };
const httpErr = (status, message) => Object.assign(new Error(message), { status });

class Shares {
  constructor(root) {
    this.dir = path.join(root, '.openleaf'); this.file = path.join(this.dir, 'shares.json');
    this.data = (() => { try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return {}; } })();
  }
  save() { fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 }); U.atomicWrite(this.file, JSON.stringify(this.data, null, 1)); }
  entry(owner, project, create = false) {
    const k = `${owner}/${project}`;
    if (!this.data[k] && create) this.data[k] = { members: {}, links: { edit: null, view: null } };
    return this.data[k] || null;
  }

  // 'owner' | 'edit' | 'view' | null
  roleOf(user, owner, project) {
    if (!user) return null;
    if (user === owner) return 'owner';
    const e = this.entry(owner, project); return (e && e.members[user]) || null;
  }
  sharedWith(user) {
    return Object.entries(this.data).flatMap(([k, e]) => (e.members[user] ? [{ name: k, owner: k.split('/')[0], project: k.slice(k.indexOf('/') + 1), role: e.members[user] }] : []));
  }
  info(owner, project, asOwner) {
    const e = this.entry(owner, project) || { members: {}, links: { edit: null, view: null } };
    return { owner, members: Object.entries(e.members).map(([user, role]) => ({ user, role })).sort((a, b) => a.user.localeCompare(b.user)), links: asOwner ? { ...e.links } : undefined };
  }
  invite(owner, project, user, role) {
    if (!ROLES.includes(role)) throw httpErr(400, 'Role must be "edit" or "view"');
    if (user === owner) throw httpErr(400, 'You own this project already');
    this.entry(owner, project, true).members[user] = role; this.save();
  }
  remove(owner, project, user) { const e = this.entry(owner, project); if (e && e.members[user]) { delete e.members[user]; this.save(); } }
  setLink(owner, project, role, on) {
    if (!ROLES.includes(role)) throw httpErr(400, 'Role must be "edit" or "view"');
    const e = this.entry(owner, project, true);
    e.links[role] = on ? crypto.randomBytes(18).toString('base64url') : null; this.save();
    return e.links[role];
  }
  join(user, token) {
    for (const [k, e] of Object.entries(this.data)) for (const role of ROLES) {
      if (!token || e.links[role] !== token) continue;
      const owner = k.split('/')[0], project = k.slice(owner.length + 1);
      if (user !== owner) { const cur = e.members[user]; if (!cur || rank[role] > rank[cur]) { e.members[user] = role; this.save(); } } // a link never downgrades
      return { name: user === owner ? project : k, role: this.roleOf(user, owner, project) };
    }
    throw httpErr(404, 'This share link is not valid any more. Ask the owner for a new one.');
  }
  // keep shares in step with the owner renaming or deleting the project
  rename(owner, from, to) { const a = `${owner}/${from}`; if (this.data[a]) { this.data[`${owner}/${to}`] = this.data[a]; delete this.data[a]; this.save(); } }
  drop(owner, project) { const k = `${owner}/${project}`; if (this.data[k]) { delete this.data[k]; this.save(); } }
}

module.exports = { Shares, ROLES, rank };
