const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const U = require('../server/util');
const { countText } = require('../server/wordcount');

test('cleanRel rejects traversal, NULs and app-private names', () => {
  for (const bad of ['../x', 'a/../../x', '.build/x', '.history/a', '.studio.json', 'a\0b']) assert.throws(() => U.cleanRel(bad), /Invalid path/, bad);
  assert.strictEqual(U.cleanRel('/a//b/./c.tex'), 'a/b/c.tex');
  assert.strictEqual(U.cleanRel('a\\b.tex'), 'a/b.tex');
});

test('resolveIn blocks symlink escapes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-')); const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-out-'));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'x');
  fs.symlinkSync(outside, path.join(root, 'link'));
  assert.throws(() => U.resolveIn(root, 'link/secret.txt'), /Invalid path/);
  assert.throws(() => U.resolveIn(root, 'link/new.txt'), /Invalid path/);
  assert.doesNotThrow(() => U.resolveIn(root, 'ok/new.txt'));
});

test('project names are validated', () => {
  for (const bad of ['', '../x', 'a/b', '.hidden', 'x'.repeat(65)]) assert.throws(() => U.projectDir('/r', bad));
  assert.ok(U.projectDir('/r', 'My Project-1.2'));
});

test('word count ignores math, commands and comments', () => {
  const { words } = countText('\\documentclass{article}\\begin{document}Hello \\textbf{brave} world $x^2$ \\cite{a} and \\begin{equation}y=1\\end{equation} done\\end{document}');
  assert.strictEqual(words, 5); // Hello brave world and done
});
