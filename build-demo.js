// Builds dist/standalone.html: one self-contained page (no server, no network).
const esbuild = require('esbuild'); const fs = require('fs'); const path = require('path');
// Generated inputs for the demo bundle (kept out of git)
{
  const t = require('./server/templates');
  fs.writeFileSync('src/demo-data.json', JSON.stringify(t.list.map(({ id, name, description, files }) => ({ id, name, description, files }))));
  fs.copyFileSync('public/symbols/symbols.json', 'src/demo-symbols.json');
  const b = (f) => 'data:image/png;base64,' + fs.readFileSync(f).toString('base64');
  fs.writeFileSync('src/demo-assets.js', 'export const spriteUrl=' + JSON.stringify(b('public/symbols/sprite.png')) + ';\nexport const tplUrl=' + JSON.stringify(b('public/symbols/templates.png')) + ';\n');
}
// Optional private default project (kept out of git): GFEX_DIR=/path/to/project node build-demo.js
{
  const dir = process.env.GFEX_DIR, extra = { name: process.env.GFEX_NAME || '00-project', main: process.env.GFEX_MAIN || 'main.tex', files: {} };
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(tex|sty|cls|bib|bst|bbx|cbx|def|lbx|cfg|ist)$/i.test(e.name)) extra.files[path.relative(dir, p).split(path.sep).join('/')] = fs.readFileSync(p, 'utf8'); } };
  if (dir) walk(dir);
  fs.writeFileSync('src/demo-extra.json', JSON.stringify(dir ? extra : null));
}
const r = esbuild.buildSync({ entryPoints: ['src/demo.js'], bundle: true, format: 'esm', write: false, minify: true, target: 'es2022', loader: { '.json': 'json' }, logLevel: 'warning' });
const js = r.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
let html = fs.readFileSync('public/index.html', 'utf8');
const css = fs.readFileSync('public/style.css', 'utf8') + '\n#uploadBtn{display:none!important}';
html = html.replace(/<link rel="stylesheet" href="\/pdf_viewer.css">\n/, '').replace('<link rel="stylesheet" href="/style.css">', `<style>${css}</style>`).replace('<script type="module" src="/app.js"></script>', () => `<script type="module">${js}</script>`);
fs.mkdirSync('dist', { recursive: true }); fs.writeFileSync('dist/standalone.html', html);
console.log('dist/standalone.html', (html.length / 1024).toFixed(0) + ' KB');
