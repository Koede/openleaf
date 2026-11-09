const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { BUILD, walkFiles, atomicWrite } = require('./util');
const { parseLog, parseBlg } = require('./logparser');

const hasBin = (b) => spawnSync('which', [b]).status === 0;
const HAVE = { latexmk: hasBin('latexmk'), synctex: hasBin('synctex') };

const ENGINES = {
  pdflatex: { flag: '-pdf', opt: '-pdflatex', cmd: 'pdflatex' },
  xelatex: { flag: '-pdfxe', opt: '-xelatex', cmd: 'xelatex' },
  lualatex: { flag: '-pdflua', opt: '-lualatex', cmd: 'lualatex' },
};

const jobs = new Map(); // project name -> { proc, superseded, timedOut }

// Mirror the project's source files into the hidden build dir (aux files live there).
function syncToBuild(pdir, bdir) {
  fs.mkdirSync(bdir, { recursive: true });
  const src = new Set(walkFiles(pdir));
  for (const rel of src) {
    const s = path.join(pdir, rel), t = path.join(bdir, rel);
    const ss = fs.statSync(s);
    let copy = true;
    try { const ts = fs.statSync(t); copy = ts.size !== ss.size || Math.abs(ts.mtimeMs - ss.mtimeMs) > 1; } catch {}
    if (copy) {
      fs.mkdirSync(path.dirname(t), { recursive: true });
      fs.copyFileSync(s, t);
      fs.utimesSync(t, ss.atime, ss.mtime); // identical mtime -> latexmk sees real changes only
    }
  }
  const mf = path.join(bdir, '.manifest.json');
  try { for (const old of JSON.parse(fs.readFileSync(mf, 'utf8'))) if (!src.has(old)) fs.rmSync(path.join(bdir, old), { force: true }); } catch {}
  fs.writeFileSync(mf, JSON.stringify([...src]));
}

function cancel(name) {
  const j = jobs.get(name);
  if (j && j.proc) { j.superseded = true; try { process.kill(-j.proc.pid, 'SIGKILL'); } catch {} }
}

// Progress watchdog. A long compile is only stopped when it stops making progress, so a
// large document can take as long as it needs while a stuck one is caught quickly.
// Progress = TeX ships out a page it had not reached before in the current pass, opens a
// file it had not opened in this pass, or latexmk/biber/bibtex moves on to a new step.
// A silent loop (\def\a{\a}\a) or one that only repeats messages trips the stall timer;
// a runaway that keeps producing pages forever is caught by the hard limit.
function progressTracker(now = Date.now) {
  let maxPage = 0, files = new Set(), tail = '', last = now();
  const bump = () => { last = now(); };
  return {
    feed(chunk) {
      const s = tail + chunk; tail = s.slice(-80);
      if (/This is (?:pdfTeX|XeTeX|LuaHBTeX|LuaTeX|e?TeX)\b/.test(s)) { maxPage = 0; files = new Set(); }
      if (/Latexmk: applying rule|Run number \d+ of rule|^INFO - |This is (?:BibTeX|biber|pdfTeX|XeTeX|LuaHBTeX|LuaTeX)/m.test(chunk)) bump();
      for (const m of s.matchAll(/\[(\d+)(?=[\]{<\s.]|$)/g)) { const n = +m[1]; if (n > maxPage && n < maxPage + 50) { maxPage = n; bump(); } }
      for (const m of s.matchAll(/[(<]([^\s()<>]+\.(?:tex|sty|cls|bbl|aux|toc|lof|lot|out|cfg|def|fd|clo|ldf|pdf|png|jpe?g|eps|tikz))/gi)) if (!files.has(m[1])) { files.add(m[1]); bump(); }
    },
    get idleMs() { return now() - last; },
    get page() { return maxPage; },
  };
}

const OPENIN = process.env.TEX_OPENIN === 'r' ? 'r' : 'p';

async function compile({ name, pdir, main, engine, haltOnError, timeoutMs, stallMs, onOutput }) {
  const limitMs = timeoutMs || 20 * 60000, quietMs = stallMs || 120000;
  const eng = ENGINES[engine] || ENGINES.pdflatex;
  cancel(name);
  const job = { proc: null, superseded: false, timedOut: null };
  jobs.set(name, job);

  const bdir = path.join(pdir, BUILD);
  syncToBuild(pdir, bdir);
  const started = Date.now();
  const flags = ['-interaction=nonstopmode', '-file-line-error', '-synctex=1', '-no-shell-escape'];
  if (haltOnError) flags.push('-halt-on-error');
  const texCmd = `${eng.cmd} ${flags.join(' ')} %O %S`;
  const args = [eng.flag, `${eng.opt}=${texCmd}`, ...(haltOnError ? [] : ['-f']), '-interaction=nonstopmode', main];
  const proc = spawn('latexmk', args, {
    cwd: bdir, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    // Restricted file access: writes stay inside the build dir. Reads are 'p' (paranoid, the default: no
    // paths outside the project and TeX trees, and no '..') or 'r' (TEX_OPENIN=r: '..' allowed, only
    // dot-files blocked). Use 'r' on a single-user server whose documents \input{../other/file}.
    env: { ...process.env, openout_any: 'p', openin_any: OPENIN, max_print_line: '1000', error_line: '254', half_error_line: '238' },
  });
  job.proc = proc;
  let out = '';
  const progress = progressTracker();
  const feed = (b) => { const s = b.toString(); out += s; progress.feed(s); if (onOutput) onOutput(s); };
  proc.stdout.on('data', feed);
  proc.stderr.on('data', feed);
  const stop = (why) => { if (job.timedOut) return; job.timedOut = why; try { process.kill(-proc.pid, 'SIGKILL'); } catch {} };
  const timer = setInterval(() => {
    if (progress.idleMs > quietMs) stop('stalled');
    else if (Date.now() - started > limitMs) stop('limit');
  }, Math.min(1000, quietMs / 4));
  const code = await new Promise((r) => { proc.on('close', r); proc.on('error', () => r(-1)); });
  clearInterval(timer);
  if (jobs.get(name) === job) jobs.set(name, { proc: null });
  if (job.superseded) return { superseded: true };

  const base = path.basename(main).replace(/\.tex$/i, '');
  const read = (ext) => { try { return fs.readFileSync(path.join(bdir, base + ext), 'utf8'); } catch { return ''; } };
  const log = read('.log') || out;
  const pdfPath = path.join(bdir, base + '.pdf');
  const hasPdf = fs.existsSync(pdfPath);
  let issues = [...parseLog(log, main), ...parseBlg(read('.blg'))];
  const sec = (ms) => (ms >= 120000 ? `${Math.round(ms / 60000)} min` : `${Math.round(ms / 1000)} s`);
  const lastFile = (log.match(/\((\.\/[^\s()]+\.tex)/g) || []).pop();
  if (job.timedOut === 'stalled') issues.unshift({ type: 'error', file: main, line: null,
    message: `Compilation stopped: no progress for ${sec(quietMs)} (no new pages, files or steps). This is almost always an infinite loop${lastFile ? `; the last file opened was ${lastFile.slice(3)}` : ''}.` });
  if (job.timedOut === 'limit') issues.unshift({ type: 'error', file: main, line: null,
    message: `Compilation stopped at the ${sec(limitMs)} limit while still making progress${progress.page ? ` (page ${progress.page})` : ''}. If the document really needs longer, raise COMPILE_TIMEOUT_MS on the server.` });
  if (!hasPdf && !issues.some((i) => i.type === 'error')) issues.unshift({ type: 'error', file: main, line: null, message: 'Compilation failed: ' + (out.slice(-500) || 'latexmk produced no output') });
  let pdfVersion = null;
  if (hasPdf) {
    const dst = path.join(bdir, 'output.pdf');
    const tmp = dst + '.tmp';
    fs.copyFileSync(pdfPath, tmp); fs.renameSync(tmp, dst);
    pdfVersion = fs.statSync(dst).mtimeMs;
  }
  const pages = /Output written on .*?\((\d+) pages?/.exec(log);
  return {
    ok: code === 0 && hasPdf && !issues.some((i) => i.type === 'error'),
    hasPdf, pdfVersion, mainPdf: base + '.pdf', ms: Date.now() - started, main, engine: engine in ENGINES ? engine : 'pdflatex',
    pages: pages ? Number(pages[1]) : null, issues, log,
  };
}

// ---------- SyncTeX ----------
const record = (stdout, key) => { const m = new RegExp('^' + key + ':(.*)$', 'm').exec(stdout || ''); return m ? m[1].trim() : null; };
function syncEdit(pdir, pdfName, page, x, y) {
  if (!HAVE.synctex || !/^[\w.\- ]+\.pdf$/.test(pdfName)) return { found: false };
  const bdir = path.join(pdir, BUILD);
  const r = spawnSync('synctex', ['edit', '-o', `${page}:${x}:${y}:${pdfName}`], { cwd: bdir, encoding: 'utf8', timeout: 10000 });
  const input = record(r.stdout, 'Input');
  if (!input) return { found: false };
  const rel = path.relative(bdir, path.resolve(bdir, input)).split(path.sep).join('/');
  if (rel.startsWith('..')) return { found: false };
  return { found: true, file: rel, line: Number(record(r.stdout, 'Line')) || 1, column: Math.max(0, Number(record(r.stdout, 'Column')) || 0) };
}
function syncView(pdir, pdfName, file, line, col) {
  if (!HAVE.synctex || !/^[\w.\- ]+\.pdf$/.test(pdfName)) return { found: false };
  const bdir = path.join(pdir, BUILD);
  const r = spawnSync('synctex', ['view', '-i', `${line}:${col || 0}:${file}`, '-o', pdfName], { cwd: bdir, encoding: 'utf8', timeout: 10000 });
  const page = record(r.stdout, 'Page');
  if (!page) return { found: false };
  const n = (k) => Number(record(r.stdout, k));
  return { found: true, page: Number(page), x: n('x'), y: n('y'), h: n('h'), v: n('v'), W: n('W'), H: n('H') };
}

module.exports = { progressTracker, compile, cancel, syncEdit, syncView, HAVE, ENGINES, syncToBuild };
