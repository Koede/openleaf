const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Directories/files inside a project that belong to the app, never to the user's tree.
const BUILD = '.build';
const HISTORY = '.history';
const SETTINGS = '.studio.json';
const REVIEW = '.review';       // comments and tracked changes, one JSON per file
const CHAT = '.chat.json';
const HIDDEN = new Set([BUILD, HISTORY, SETTINGS, REVIEW, CHAT]);

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _.\-]{0,63}$/;
const TEXT_EXT = /\.(tex|sty|cls|bib|bst|bbl|txt|md|cfg|def|clo|dtx|ins|csv|json|tikz|pgf|ist|lbx|cbx|bbx|latexmkrc|py|sh)$/i;
const isTextFile = (p) => TEXT_EXT.test(p) || /(^|\/)\.?latexmkrc$/.test(p) || !/\.[^/.]+$/.test(path.basename(p));

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const httpErr = (status, message) => new HttpError(status, message);

function projectDir(root, name) {
  if (!NAME_RE.test(name || '')) throw httpErr(400, 'Invalid project name');
  return path.join(root, name);
}

// Normalise a project-relative path. Rejects absolute paths, "..", NULs and app-private names.
function cleanRel(rel) {
  rel = String(rel ?? '').replace(/\\/g, '/');
  if (rel.includes('\0')) throw httpErr(400, 'Invalid path');
  const parts = rel.split('/').filter((s) => s && s !== '.');
  if (parts.some((s) => s === '..')) throw httpErr(400, 'Invalid path');
  if (parts.length && HIDDEN.has(parts[0])) throw httpErr(400, 'Invalid path');
  return parts.join('/');
}

// Resolve to an absolute path that is guaranteed (after following symlinks) to be inside the project.
function resolveIn(pdir, rel) {
  const clean = cleanRel(rel);
  const abs = path.join(pdir, ...clean.split('/').filter(Boolean));
  const realRoot = fs.realpathSync(pdir);
  let probe = abs;
  while (!fs.existsSync(probe) && probe !== pdir) probe = path.dirname(probe);
  const realProbe = fs.realpathSync(probe);
  if (realProbe !== realRoot && !realProbe.startsWith(realRoot + path.sep)) throw httpErr(400, 'Invalid path');
  return { abs, rel: clean };
}

function walkFiles(dir, base = '') {
  let out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!base && HIDDEN.has(ent.name)) continue;
    const rel = base ? base + '/' + ent.name : ent.name;
    if (ent.isDirectory()) out = out.concat(walkFiles(path.join(dir, ent.name), rel));
    else if (ent.isFile()) out.push(rel); // symlinks are intentionally ignored
  }
  return out;
}

function listTree(dir, base = '') {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!base && HIDDEN.has(ent.name)) continue;
    const rel = base ? base + '/' + ent.name : ent.name;
    if (ent.isDirectory()) out.push({ name: ent.name, path: rel, type: 'dir', children: listTree(path.join(dir, ent.name), rel) });
    else if (ent.isFile()) out.push({ name: ent.name, path: rel, type: 'file', size: fs.statSync(path.join(dir, ent.name)).size });
  }
  out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.type === 'dir' ? -1 : 1));
  return out;
}

function detectMain(pdir) {
  const tex = walkFiles(pdir).filter((f) => /\.tex$/i.test(f));
  const roots = tex.filter((f) => {
    try { const s = fs.readFileSync(path.join(pdir, f), 'utf8'); return /\\documentclass/.test(s) && /\\begin\{document\}/.test(s); } catch { return false; }
  });
  roots.sort((a, b) => (a === 'main.tex' ? -1 : b === 'main.tex' ? 1 : a.split('/').length - b.split('/').length || a.localeCompare(b)));
  return { main: roots[0] || null, candidates: roots };
}

const sha = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

const readSettings = (pdir) => {
  try { return JSON.parse(fs.readFileSync(path.join(pdir, SETTINGS), 'utf8')); } catch { return {}; }
};

module.exports = { BUILD, HISTORY, SETTINGS, REVIEW, CHAT, HIDDEN, NAME_RE, TEXT_EXT, isTextFile, HttpError, httpErr, projectDir, cleanRel, resolveIn, walkFiles, listTree, detectMain, sha, atomicWrite, readSettings };
