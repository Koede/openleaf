const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { progressTracker, compile, HAVE } = require('../server/compile');

function clock() { let t = 0; const f = () => t; f.add = (ms) => { t += ms; }; return f; }

test('progress: new pages and files count, repeats and plain messages do not', () => {
  const c = clock(); const p = progressTracker(c);
  p.feed('This is pdfTeX, Version 3.14\n(./main.tex (./chapters/a.tex');
  c.add(5000); assert.strictEqual(p.idleMs, 5000);
  p.feed(' [1] [2{/var/fonts/x.map}]'); assert.strictEqual(p.idleMs, 0); assert.strictEqual(p.page, 2);
  c.add(3000); p.feed('Package foo Info: something\nLaTeX Warning: x\n'); assert.strictEqual(p.idleMs, 3000);
  p.feed(' [2]'); assert.strictEqual(p.idleMs, 3000, 'a page already seen is not progress');
  p.feed(' <./figs/plot.pdf>'); assert.strictEqual(p.idleMs, 0, 'an included image is progress');
  c.add(1000); p.feed('(./chapters/a.tex'); assert.strictEqual(p.idleMs, 1000, 'a file already opened is not progress');
});

test('progress: a new pass restarts page counting; split chunks are handled', () => {
  const c = clock(); const p = progressTracker(c);
  p.feed('This is pdfTeX\n [1] [2] [3]'); c.add(2000);
  p.feed('Latexmk: applying rule \'pdflatex\'...\nThis is pdfTeX\n'); assert.strictEqual(p.idleMs, 0);
  c.add(2000); p.feed(' [1'); assert.strictEqual(p.idleMs, 0, 'page 1 of the new pass is progress');
  c.add(2000); p.feed(' [1'); p.feed('0]'); // "[10]" split across two chunks
  assert.strictEqual(p.page, 10);
});

test('progress: biber/bibtex output counts as progress', () => {
  const c = clock(); const p = progressTracker(c); c.add(9000);
  p.feed('INFO - This is Biber 2.19\n'); assert.strictEqual(p.idleMs, 0);
});

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'olc-'));
const doc = (body) => `\\documentclass{article}\\begin{document}${body}\\end{document}\n`;

test('compile: a silent infinite loop is stopped as stalled', { skip: !HAVE.latexmk, timeout: 60000 }, async () => {
  const d = tmp(); fs.writeFileSync(path.join(d, 'main.tex'), doc('x\\def\\a{\\a}\\a'));
  const t0 = Date.now();
  const r = await compile({ name: 'stall-' + Date.now(), pdir: d, main: 'main.tex', engine: 'pdflatex', timeoutMs: 60000, stallMs: 3000 });
  assert.ok(Date.now() - t0 < 20000, 'stopped well before the hard limit');
  assert.match(r.issues[0].message, /no progress for 3 s/);
});

test('compile: a slow document that keeps producing pages runs past the stall time', { skip: !HAVE.latexmk, timeout: 120000 }, async () => {
  // Each page busy-waits ~0.3-1 s; the whole run takes far longer than the 2.5 s stall limit.
  const page = '\\count255=0 \\loop\\advance\\count255 1 \\ifnum\\count255<1500000 \\repeat x\\newpage ';
  const d = tmp(); fs.writeFileSync(path.join(d, 'main.tex'), doc(page.repeat(12)));
  const t0 = Date.now();
  const r = await compile({ name: 'slow-' + Date.now(), pdir: d, main: 'main.tex', engine: 'pdflatex', timeoutMs: 110000, stallMs: 2500 });
  const took = Date.now() - t0;
  assert.ok(r.hasPdf, 'produced a PDF: ' + JSON.stringify(r.issues.slice(0, 2)));
  assert.strictEqual(r.pages, 12);
  assert.ok(took > 2500, `took ${took} ms, longer than the stall limit`);
});

test('compile: the hard limit still applies to a document that never ends', { skip: !HAVE.latexmk, timeout: 60000 }, async () => {
  const d = tmp(); fs.writeFileSync(path.join(d, 'main.tex'), doc('\\loop x\\newpage\\iftrue\\repeat'));
  const r = await compile({ name: 'cap-' + Date.now(), pdir: d, main: 'main.tex', engine: 'pdflatex', timeoutMs: 4000, stallMs: 3000 });
  assert.match(r.issues[0].message, /limit while still making progress \(page \d+\)/);
});

test('compile: "../" paths that stay inside the project work under paranoid file access', { skip: !HAVE.latexmk || !HAVE.dotdot, timeout: 60000 }, async () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, 'chapters/a'), { recursive: true }); fs.mkdirSync(path.join(d, 'chapters/b'), { recursive: true });
  fs.writeFileSync(path.join(d, 'chapters/b/x.tex'), 'Reached via dotdot.\n');
  fs.writeFileSync(path.join(d, 'chapters/a/y.tex'), '\\subimport{../b/}{x.tex}\n');
  fs.writeFileSync(path.join(d, 'main.tex'), '\\documentclass{article}\\usepackage{import}\\begin{document}\\import{chapters/a/}{y.tex}\\end{document}\n');
  const r = await compile({ name: 'dd-' + Date.now(), pdir: d, main: 'main.tex', engine: 'pdflatex', timeoutMs: 60000, stallMs: 30000 });
  assert.ok(r.ok, JSON.stringify(r.issues.filter((i) => i.type === 'error')));
});

test('compile: "../" that climbs out of the project is still refused, with a clear hint', { skip: !HAVE.latexmk || !HAVE.dotdot, timeout: 60000 }, async () => {
  const d = tmp(); fs.mkdirSync(path.join(d, 'sub'));
  fs.writeFileSync(path.join(path.dirname(d), 'outside-' + path.basename(d) + '.tex'), 'SECRET\n');
  fs.writeFileSync(path.join(d, 'main.tex'), `\\documentclass{article}\\begin{document}\\input{sub/../../outside-${path.basename(d)}.tex}\\end{document}\n`);
  const r = await compile({ name: 'ddout-' + Date.now(), pdir: d, main: 'main.tex', engine: 'pdflatex', timeoutMs: 60000, stallMs: 30000 });
  const e = r.issues.find((i) => i.type === 'error' && /not found/.test(i.message));
  assert.ok(e, 'the file outside the project was not read');
  assert.match(e.hint, /climb out of the project/);
  assert.ok(!/SECRET/.test(r.log.split('Output written')[0].replace(/outside-[^ ]*/g, '')) || !r.hasPdf);
});

test('compile: Fast [draft] mode draws images as boxes', { skip: !HAVE.latexmk, timeout: 60000 }, async () => {
  const d = tmp();
  // a 1x1 PNG
  fs.writeFileSync(path.join(d, 'img.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64'));
  fs.writeFileSync(path.join(d, 'main.tex'), '\\documentclass{article}\\usepackage{graphicx}\\begin{document}x\\includegraphics[width=2cm]{img.png}\\end{document}\n');
  const imgs = () => fs.readFileSync(path.join(d, '.build', 'output.pdf')).toString('latin1').split('/Subtype /Image').length - 1;
  let r = await compile({ name: 'draft-' + Date.now(), pdir: d, main: 'main.tex', engine: 'pdflatex', timeoutMs: 60000, stallMs: 30000, draft: true });
  assert.ok(r.ok, JSON.stringify(r.issues)); assert.strictEqual(imgs(), 0, 'no image in draft mode');
  r = await compile({ name: 'draft2-' + Date.now(), pdir: d, main: 'main.tex', engine: 'pdflatex', timeoutMs: 60000, stallMs: 30000, draft: false });
  assert.ok(r.ok); assert.ok(imgs() >= 1, 'image back in normal mode');
});

test('compile: Stop compilation ends a running compile', { skip: !HAVE.latexmk, timeout: 60000 }, async () => {
  const { stop } = require('../server/compile');
  const page = '\\count255=0 \\loop\\advance\\count255 1 \\ifnum\\count255<1500000 \\repeat x\\newpage ';
  const d = tmp(); fs.writeFileSync(path.join(d, 'main.tex'), doc(page.repeat(40)));
  const name = 'stop-' + Date.now(); const t0 = Date.now();
  const p = compile({ name, pdir: d, main: 'main.tex', engine: 'pdflatex', timeoutMs: 60000, stallMs: 30000 });
  await new Promise((r) => setTimeout(r, 1500));
  assert.strictEqual(stop(name), true);
  const r = await p;
  assert.strictEqual(r.stopped, true); assert.ok(Date.now() - t0 < 10000, 'stopped promptly');
  assert.strictEqual(stop(name), false, 'nothing left to stop');
});
