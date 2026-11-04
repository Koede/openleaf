// Browser smoke test for the formatting toolbar. Needs a running server (PORT=4177 PROJECTS_DIR=$(mktemp -d) node server.js)
// and Playwright:  PLAYWRIGHT_PATH=/path/to/node_modules/playwright node test/e2e/format.e2e.js
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1500, height: 900 } });
  const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  await p.goto(process.env.URL || 'http://localhost:4177/'); await p.waitForSelector('#fmtPill', { timeout: 15000 }); await p.waitForTimeout(1500);
  const closed = await p.isVisible('#fmtTools'); await p.screenshot({ path: '/tmp/fmt-closed.png' });
  await p.click('#fmtPill'); const opened = await p.isVisible('#fmtTools') && !(await p.isVisible('#editorTools')); await p.screenshot({ path: '/tmp/fmt-open.png' });
  const doc = () => p.evaluate(() => document.querySelector('.cm-content').innerText.replace(/ /g, ' '));
  const clear = async () => { await p.click('.cm-content'); await p.keyboard.press('Control+A'); await p.keyboard.press('Delete'); };
  await p.screenshot({ path: '/tmp/fmt0.png' });
  const out = {};
  // 1. size: click select, type next -> formatted
  await clear(); await p.selectOption('#fmtSize', 'Large'); await p.keyboard.type('Big text'); out.size = await doc();
  await clear(); await p.selectOption('#fmtSize', 'LARGE'); await p.keyboard.type('Huge'); await p.keyboard.press('Tab'); await p.keyboard.type(' after'); out.sizeTab = await doc();
  await clear(); await p.click('#fmtTools .menubtn.ins'); await p.click('.fmt-menu:not([hidden]) .menu-item:has-text("Footnote")'); await p.keyboard.type('note'); await p.keyboard.press('Tab'); await p.keyboard.type('X'); out.footTab = await doc();
  // 2. center
  await clear(); await p.click('#fmtTools button[title^="Centre"]'); await p.keyboard.type('Middle'); out.center = await doc();
  // 3. heading from plain line
  await clear(); await p.keyboard.type('Introduction'); await p.selectOption('#fmtStyle', 'section'); out.heading = await doc();
  await p.selectOption('#fmtStyle', 'subsection'); out.heading2 = await doc(); out.styleVal = await p.inputValue('#fmtStyle');
  await p.selectOption('#fmtStyle', ''); out.heading3 = await doc();
  // 4. empty line heading, bold, list w/ enter
  await clear(); await p.selectOption('#fmtStyle', 'section'); await p.keyboard.type('Title here'); out.headingEmpty = await doc();
  await clear(); await p.click('#fmtTools button[title^="Bulleted"]'); await p.keyboard.type('one'); await p.keyboard.press('Enter'); await p.keyboard.type('two'); await p.keyboard.press('Enter'); await p.keyboard.press('Enter'); out.list = await doc();
  // 5. selection wrap + colour
  await clear(); await p.keyboard.type('hello world'); await p.keyboard.press('Control+A'); await p.click('#fmtTools button[title^="Bold"]'); out.bold = await doc();
  await p.keyboard.press('Control+A'); await p.click('#fmtTools button[title^="Underline"]'); out.under = await doc();
  await clear(); await p.click('#fmtTools .menubtn.color'); await p.click('.swatch[title="Red"]'); await p.keyboard.type('red'); out.color = await doc();
  // 6. table 2x3
  await clear(); await p.click('#fmtTools .menubtn.tbl'); await p.hover('.tcell[data-r="2"][data-c="3"]'); await p.click('.tcell[data-r="2"][data-c="3"]'); await p.keyboard.type('a'); await p.keyboard.press('Tab'); await p.keyboard.type('b'); out.table = await doc();
  // 7. insert menu link with selection
  await clear(); await p.keyboard.type('click me'); await p.keyboard.press('Control+A'); await p.click('#fmtTools .menubtn.ins'); await p.click('.fmt-menu:not([hidden]) .menu-item:has-text("Link")'); await p.keyboard.press('Tab'); await p.keyboard.type('https://x.org'); out.link = await doc();
  // 8. shortcut ctrl+shift+e
  await clear(); await p.keyboard.press('Control+Shift+E'); await p.keyboard.type('sc'); out.shortcut = await doc();
  await p.screenshot({ path: '/tmp/fmt1.png' });
  console.log(JSON.stringify(out, null, 1)); console.log('ERRORS', JSON.stringify(errs));
  const want = { size: '{\\Large Big text}', sizeTab: '{\\LARGE Huge} after', footTab: '\\footnote{note}X', heading: '\\section{Introduction}', heading2: '\\subsection{Introduction}', styleVal: 'subsection', heading3: 'Introduction', headingEmpty: '\\section{Title here}', bold: '\\textbf{hello world}', color: '\\textcolor{red}{red}', link: '\\href{https://x.org}{click me}' };
  await p.click('#fmtTools .pill'); const back = await p.isVisible('#editorTools') && !(await p.isVisible('#fmtTools'));
  if (closed || !opened || !back) { console.error('FAILED pill toggle', { closed, opened, back }); process.exitCode = 1; }
  const bad = Object.entries(want).filter(([k, v]) => out[k] !== v);
  if (bad.length || /\\begin\{center\}\n  Middle/.test(out.center) === false || !/\\item one\n  \\item two/.test(out.list) || errs.some((e) => !/404/.test(e))) { console.error('FAILED', bad.map(([k]) => k), errs); process.exitCode = 1; } else console.log('format e2e OK');
  await b.close();
})();
