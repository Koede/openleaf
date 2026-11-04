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
const r = esbuild.buildSync({ entryPoints: ['src/demo.js'], bundle: true, format: 'esm', write: false, minify: true, target: 'es2022', loader: { '.json': 'json' }, logLevel: 'warning' });
const js = r.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
let html = fs.readFileSync('public/index.html', 'utf8');
const css = fs.readFileSync('public/style.css', 'utf8') + '\n#dlBtn,#uploadBtn{display:none!important}';
html = html.replace(/<link rel="stylesheet" href="\/pdf_viewer.css">\n/, '').replace('<link rel="stylesheet" href="/style.css">', `<style>${css}</style>`).replace('<script type="module" src="/app.js"></script>', () => `<script type="module">${js}</script>`);
fs.mkdirSync('dist', { recursive: true }); fs.writeFileSync('dist/standalone.html', html);
console.log('dist/standalone.html', (html.length / 1024).toFixed(0) + ' KB');
