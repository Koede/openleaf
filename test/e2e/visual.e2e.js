// Browser smoke test for the Visual Editor. Needs a running server (PORT=4177 PROJECTS_DIR=$(mktemp -d) node server.js)
// and Playwright:  PLAYWRIGHT_PATH=/path/to/node_modules/playwright node test/e2e/visual.e2e.js
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const fs = require('fs'), path = require('path');
const BASE = process.env.URL || 'http://localhost:4177/';
const NAME = 'visual-e2e-' + Date.now().toString(36);
(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1500, height: 950 } });
  const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => { if (m.type() === 'error' && !/404|Failed to load resource/.test(m.text())) errs.push(m.text()); });
  await p.goto(BASE); await p.waitForSelector('#modeSwitch', { timeout: 15000 });
  // a project with the fixture document and a generated PNG figure
  const tex = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'visual.tex'), 'utf8');
  await p.evaluate(async ({ NAME, tex }) => {
    const j = (url, method, body) => fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
    await j('/api/projects', 'POST', { name: NAME, template: 'blank' });
    await j(`/api/p/${NAME}/file`, 'PUT', { path: 'main.tex', content: tex });
    const c = document.createElement('canvas'); c.width = 320; c.height = 200; const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 320, 200); g.strokeStyle = '#2050c0'; g.lineWidth = 4; g.beginPath(); g.moveTo(10, 190); g.lineTo(310, 10); g.stroke();
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    const fd = new FormData(); fd.append('files', blob, 'plot.png'); fd.append('dir', 'figs');
    await fetch(`/api/p/${NAME}/upload`, { method: 'POST', body: fd });
  }, { NAME, tex });
  await p.goto(BASE + '#' + NAME); await p.waitForTimeout(1500);
  await p.evaluate(() => [...document.querySelectorAll('#tree .node')].find((x) => x.dataset.path === 'main.tex')?.click());
  await p.waitForTimeout(800);
  const out = {};
  await p.click('#modeSwitch button[data-mode="visual"]'); await p.waitForTimeout(800);
  Object.assign(out, await p.evaluate(() => ({
    visual: document.querySelector('.cm-editor').classList.contains('cm-visual'),
    pressed: document.querySelector('#modeSwitch [data-mode="visual"]').getAttribute('aria-pressed'),
    preamble: document.querySelector('.cm-v-pre')?.textContent,
    title: document.querySelector('.cm-v-title .t')?.textContent,
    heading: !!document.querySelector('.cm-line.cm-v-h2'),
    bold: document.querySelector('.cm-v-b')?.textContent,
    katex: document.querySelectorAll('.katex').length,
    katexErr: document.querySelectorAll('.katex-error').length,
    chips: [...document.querySelectorAll('.cm-v-chip')].map((c) => c.textContent),
    bullets: [...document.querySelectorAll('.cm-v-bullet')].map((c) => c.textContent),
    fig: document.querySelector('.cm-v-fig img')?.complete && document.querySelector('.cm-v-fig img')?.naturalWidth,
    hiddenSource: !document.querySelector('.cm-content').innerText.includes('\\begin{itemize}'),
  })));
  await p.screenshot({ path: '/tmp/visual-e2e-1.png' });
  // clicking a display formula reveals its source with a live preview
  await p.click('.cm-v-dmath >> nth=0'); await p.waitForTimeout(250);
  out.reveal = await p.evaluate(() => !!document.querySelector('.cm-v-mathsrc') && !!document.querySelector('.cm-v-dmath.preview'));
  // typing inside bold text keeps it bold; Ctrl+B in visual mode writes \textbf
  const bb = await (await p.$('.cm-v-b')).boundingBox(); await p.mouse.click(bb.x + 8, bb.y + bb.height / 2); await p.keyboard.type('ZZ');
  out.boldTyped = await p.$eval('.cm-v-b', (e) => e.textContent);
  await p.keyboard.press('Control+End'); await p.keyboard.press('Enter'); await p.keyboard.press('Control+B'); await p.keyboard.type('fresh'); await p.keyboard.press('Tab'); await p.keyboard.type(' and $y$ done');
  // the preamble expands and collapses
  await p.click('.cm-v-pre'); await p.waitForTimeout(150); out.preOpen = await p.$eval('.cm-v-pre', (e) => e.textContent);
  await p.click('.cm-v-pre'); await p.waitForTimeout(150); out.preClosed = await p.$eval('.cm-v-pre', (e) => e.textContent);
  // the switch is also there with the formatting toolbar open
  await p.click('#fmtPill'); out.switchInFmt = await p.isVisible('#fmtTools #modeSwitch'); await p.click('#fmtTools .pill');
  // back to code: the file is plain LaTeX with the edits
  await p.click('#modeSwitch button[data-mode="code"]'); await p.waitForTimeout(2500);
  const saved = await p.evaluate(async (NAME) => (await fetch(`/api/p/${NAME}/raw?path=main.tex`)).text(), NAME);
  out.saved = saved.includes('\\textbf{bZZold and \\emph{it}}') && saved.includes('\\textbf{fresh} and $y$ done');
  out.codeMode = await p.evaluate(() => !document.querySelector('.cm-editor').classList.contains('cm-visual') && document.querySelector('.cm-content').innerText.includes('\\begin{itemize}'));
  await p.evaluate(async (NAME) => fetch(`/api/projects/${NAME}`, { method: 'DELETE' }), NAME);
  console.log(JSON.stringify(out, null, 1)); console.log('ERRORS', JSON.stringify(errs));
  const ok = out.visual && out.pressed === 'true' && /Preamble · 10 lines/.test(out.preamble || '') && out.title === 'On x2 and more' && out.heading && out.bold === 'bold and it'
    && out.katex >= 5 && !out.katexErr && out.chips.includes('[k1, k2]') && out.chips.includes('↗ sec:intro') && out.chips.includes('# sec:intro')
    && out.bullets.join(',') === '•,1.,2.,•' && out.fig > 0 && out.hiddenSource && out.reveal && out.boldTyped === 'bZZold and it'
    && /Hide preamble/.test(out.preOpen) && /Preamble/.test(out.preClosed) && out.switchInFmt && out.saved && out.codeMode && !errs.length;
  console.log(ok ? 'PASS' : 'FAIL'); await b.close(); process.exit(ok ? 0 : 1);
})();
