// Bundles the frontend (CodeMirror + pdf.js) into public/
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');
esbuild.buildSync({ entryPoints: ['src/main.js'], bundle: true, format: 'esm', outfile: 'public/app.js', minify: !process.env.DEV, target: 'es2022', logLevel: 'info', loader: { '.css': 'text' } });
const nm = (p) => path.join(__dirname, 'node_modules', p);
fs.copyFileSync(nm('pdfjs-dist/build/pdf.worker.min.mjs'), path.join(__dirname, 'public/pdf.worker.mjs'));
fs.copyFileSync(nm('pdfjs-dist/web/pdf_viewer.css'), path.join(__dirname, 'public/pdf_viewer.css'));
// KaTeX (Visual Editor): stylesheet + fonts
fs.mkdirSync(path.join(__dirname, 'public/katex/fonts'), { recursive: true });
fs.copyFileSync(nm('katex/dist/katex.min.css'), path.join(__dirname, 'public/katex/katex.min.css'));
for (const f of fs.readdirSync(nm('katex/dist/fonts'))) if (/\.(woff2|woff|ttf)$/.test(f)) fs.copyFileSync(nm('katex/dist/fonts/' + f), path.join(__dirname, 'public/katex/fonts', f));
