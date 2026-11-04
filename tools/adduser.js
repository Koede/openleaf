#!/usr/bin/env node
// Create an account from the command line (useful when ALLOW_SIGNUP=0):
//   PROJECTS_DIR=/data node tools/adduser.js alice [--adopt]
// The password is read from the ADD_PASSWORD env var or prompted on stdin.
// --adopt moves existing top-level projects (from single-user mode) into the new account.
const path = require('path'); const fs = require('fs'); const readline = require('readline');
const { Accounts } = require('../server/accounts');
const { NAME_RE } = require('../server/util');
const root = path.resolve(process.env.PROJECTS_DIR || path.join(__dirname, '..', 'projects'));
const [name, ...flags] = process.argv.slice(2);
if (!name) { console.error('usage: node tools/adduser.js <username> [--adopt]'); process.exit(1); }
(async () => {
  let pw = process.env.ADD_PASSWORD;
  if (!pw) { const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); pw = await new Promise((r) => rl.question('Password (min. 8 chars, input is visible): ', (a) => { rl.close(); r(a); })); }
  fs.mkdirSync(root, { recursive: true });
  const acc = new Accounts(root, { allowSignup: false });
  const u = acc.register(name, pw, { force: true });
  console.log('Created account', u);
  if (flags.includes('--adopt')) {
    let n = 0;
    for (const e of fs.readdirSync(root, { withFileTypes: true })) if (e.isDirectory() && NAME_RE.test(e.name) && !acc.users[e.name] && e.name !== u) { fs.renameSync(path.join(root, e.name), path.join(root, u, e.name)); n++; }
    console.log(`Moved ${n} existing project(s) into ${u}'s account.`);
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
