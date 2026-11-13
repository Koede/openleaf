// Parses a TeX .log (and BibTeX .blg) into structured issues.
// Tracks TeX's "(file ... )" nesting so that warnings that only say "on input line N"
// can be attributed to the file that was actually being read.

const FILE_EXT = /\.(tex|sty|cls|bbl|bib|def|cfg|clo|fd|aux|out|toc|lof|lot|ldf|tikz|pgf|code\.tex|dtx|lbx|cbx|bbx)$/i;
const MSG_LINE = /^(!|l\.\d+|\(\S+\)\s|LaTeX |Package[: ]|Class |Overfull|Underfull|Missing|Runaway|Output written|Transcript|\*\*|Document Class|For additional information|\.\.\.|<[^>]*>)/;

const normFile = (f) => f.replace(/^\.\//, '');
const isProjectFile = (f) => !!f && !f.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(f);

function hintFor(msg) {
  let m = /File `([^']+?)(?:\.sty|\.cls)?' not found/.exec(msg);
  if (m && /\.(sty|cls)'/.test(msg)) return `Package/class "${m[1]}" is not installed. With TeX Live try: tlmgr install ${m[1]}`;
  m = /File `([^']+)' not found/.exec(msg);
  if (m && /(^|\/)\.\.(\/|$)/.test(m[1]) && process.env.TEX_OPENIN !== 'r' && process.env.OPENLEAF_DOTDOT === '1') return `File "${m[1]}" uses ".." to climb out of the project, which is not allowed. Paths with ".." work as long as they stay inside the project; check how many "../" the path has, and that the folder exists.`;
  if (m && /(^|\/)\.\.(\/|$)/.test(m[1]) && process.env.TEX_OPENIN !== 'r') return `File "${m[1]}" uses ".." (a parent directory). The compiler runs with paranoid file access, which rejects such paths even inside the project. Either refer to the file from the project root, or have the server admin set TEX_OPENIN=r.`;
  if (m) return `File "${m[1]}" was not found. Check the path (it is relative to the project root) and that it was uploaded.`;
  if (/Undefined control sequence/.test(msg)) return 'A command is misspelled or its package is not loaded (\\usepackage{...}).';
  if (/Missing \$ inserted/.test(msg)) return 'Math-only symbol used outside math mode. Wrap it in $...$.';
  if (/Missing \\begin\{document\}/.test(msg)) return 'Text or an undefined command appears before \\begin{document}.';
  if (/Runaway argument|File ended while scanning/.test(msg)) return 'A brace { } is probably unbalanced.';
  return undefined;
}

function parseLog(log, main) {
  const lines = String(log || '').split('\n');
  const issues = [];
  const seen = new Set();
  const stack = [];
  const top = () => {
    for (let i = stack.length - 1; i >= 0; i--) if (isProjectFile(stack[i])) return normFile(stack[i]);
    return main || null;
  };
  const push = (iss) => {
    const key = [iss.type, iss.file, iss.line, iss.message].join('\u0001');
    if (seen.has(key)) return;
    seen.add(key);
    issues.push(iss);
  };

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let m;

    // file:line:error (from -file-line-error)
    if ((m = /^(.+?):(\d+): (.*)$/.exec(l)) && FILE_EXT.test(m[1])) {
      let msg = m[3];
      const ctxLines = [];
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) { if (/^l\.\d+/.test(lines[j])) { ctxLines.push(lines[j]); if (lines[j + 1] && !/^\s*$/.test(lines[j + 1]) && !/^(!|l\.)/.test(lines[j + 1])) ctxLines.push(lines[j + 1].trim()); break; } }
      push({ type: 'error', file: normFile(m[1]), line: Number(m[2]), message: msg, context: ctxLines.join(' ⏎ ') || undefined, hint: hintFor(msg) });
      continue;
    }
    // plain "! message" (only when file-line-error format did not already report it)
    if ((m = /^! (.*)$/.exec(l))) {
      const msg = m[1];
      if (!issues.some((x) => x.type === 'error' && (x.message === msg || x.message.startsWith(msg)))) {
        const ln = lines.slice(i + 1, i + 8).map((x) => /^l\.(\d+)/.exec(x)).find(Boolean);
        push({ type: 'error', file: top(), line: ln ? Number(ln[1]) : null, message: msg, hint: hintFor(msg) });
      }
      continue;
    }
    // warnings
    if ((m = /^(LaTeX Font|LaTeX|Package \S+|Class \S+) Warning: (.*)$/.exec(l))) {
      let msg = m[2];
      for (let j = i + 1; j < lines.length && /^\(\S+\)\s/.test(lines[j]); j++) msg += ' ' + lines[j].replace(/^\(\S+\)\s+/, '');
      const ln = /on input line (\d+)/.exec(msg);
      push({ type: 'warning', file: ln ? top() : null, line: ln ? Number(ln[1]) : null, message: `${m[1]}: ${msg.replace(/\s+/g, ' ').replace(/ on input line \d+\.?$/, '')}` });
      continue;
    }
    // bad boxes
    if ((m = /^(Overfull|Underfull) \\[hv]box \((.*?)\) .*? at lines? (\d+)/.exec(l)) || (m = /^(Overfull|Underfull) \\[hv]box \((.*?)\) detected at line (\d+)/.exec(l))) {
      push({ type: 'badbox', file: top(), line: Number(m[3]), message: l.trim() });
      continue;
    }
    if (/^(Overfull|Underfull) /.test(l)) { push({ type: 'badbox', file: top(), line: null, message: l.trim() }); continue; }

    // update the open-file stack
    if (MSG_LINE.test(l)) continue;
    const re = /\(([^\s()]*)|\)/g;
    let t;
    while ((t = re.exec(l))) {
      if (t[0] === ')') stack.pop();
      else stack.push(t[1] && (FILE_EXT.test(t[1]) || t[1].includes('/')) ? t[1] : null);
    }
  }

  // drop TeX's follow-up noise when a real error already exists
  const hasReal = issues.some((x) => x.type === 'error' && !/^(Emergency stop|==> Fatal error)/.test(x.message));
  return hasReal ? issues.filter((x) => !(x.type === 'error' && /^(Emergency stop\.?|==> Fatal error occurred)/.test(x.message.trim()))) : issues;
}

function parseBlg(blg) {
  const issues = [];
  const lines = String(blg || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let m;
    if ((m = /^Warning--(.*)$/.exec(l))) issues.push({ type: 'warning', file: null, line: null, message: 'BibTeX: ' + m[1].trim() });
    else if ((m = /^---line (\d+) of file (\S+)/.exec(l))) {
      const msg = (lines[i - 1] || '').trim();
      issues.push({ type: 'error', file: normFile(m[2]), line: Number(m[1]), message: 'BibTeX: ' + msg });
    } else if (/^I couldn't open (database|style) file/.test(l)) issues.push({ type: 'error', file: null, line: null, message: 'BibTeX: ' + l.trim() });
    else if (/^I found no \\(citation|bibdata|bibstyle) command/.test(l)) issues.push({ type: 'warning', file: null, line: null, message: 'BibTeX: ' + l.trim() });
  }
  return issues;
}

module.exports = { parseLog, parseBlg, hintFor };
