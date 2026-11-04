// Approximate word count of the document body, following \input / \include.
const fs = require('fs');
const path = require('path');

const strip = (s) => s.replace(/(^|[^\\])%.*$/gm, '$1');

function expand(pdir, text, depth, seen) {
  if (depth > 12) return text;
  return text.replace(/\\(?:input|include)\{([^}]+)\}/g, (m, f) => {
    const rel = f.replace(/\\/g, '/').replace(/^\.\//, '');
    for (const cand of [rel, rel + '.tex']) {
      const abs = path.resolve(pdir, cand);
      if (!abs.startsWith(path.resolve(pdir) + path.sep) || seen.has(abs)) continue;
      try { if (fs.statSync(abs).isFile()) { const next = new Set(seen).add(abs); return '\n' + expand(pdir, strip(fs.readFileSync(abs, 'utf8')), depth + 1, next) + '\n'; } } catch {}
    }
    return m;
  });
}

function countText(tex) {
  let s = tex;
  const body = /\\begin\{document\}([\s\S]*?)(?:\\end\{document\}|$)/.exec(s);
  if (body) s = body[1];
  s = s.replace(/\\begin\{(equation|align|gather|multline|eqnarray|displaymath|math|flalign|alignat)\*?\}[\s\S]*?\\end\{\1\*?\}/g, ' ')
    .replace(/\$\$[\s\S]*?\$\$/g, ' ').replace(/\\\[[\s\S]*?\\\]/g, ' ').replace(/\\\([\s\S]*?\\\)/g, ' ').replace(/\$[^$]*\$/g, ' ')
    .replace(/\\begin\{(tikzpicture|lstlisting|verbatim|thebibliography)\}[\s\S]*?\\end\{\1\}/g, ' ')
    .replace(/\\(cite[a-z]*|ref|eqref|autoref|cref|pageref|label|includegraphics|usepackage|bibliography|bibliographystyle|input|include|url|documentclass|graphicspath|newcommand|renewcommand)\*?(\[[^\]]*\])*\{[^}]*\}/g, ' ')
    .replace(/\\[a-zA-Z@]+\*?/g, ' ').replace(/\\./g, ' ');
  const words = s.match(/[\p{L}\p{N}][\p{L}\p{N}'’\-]*/gu) || [];
  return { words: words.length, chars: words.join('').length };
}

function wordCount(pdir, main) {
  const abs = path.join(pdir, main);
  let text = strip(fs.readFileSync(abs, 'utf8'));
  text = expand(pdir, text, 0, new Set([abs]));
  return { ...countText(text), approximate: true };
}

module.exports = { wordCount, countText };
