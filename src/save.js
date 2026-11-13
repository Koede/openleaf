// Save a file for the user. Inside a claude.ai artifact, pages may not download directly: the
// viewer's "downloads" capability shows a confirmation and saves the file. Elsewhere (the page
// opened as a plain file, or the normal app) an ordinary browser download is used.
import { toast } from './ui.js';

let dl; // undefined: not asked yet; null: not available
async function downloads() {
  if (dl !== undefined) return dl;
  dl = window.claude && typeof window.claude.use === 'function' ? await window.claude.use('downloads').catch(() => null) : null;
  return dl;
}

export async function saveFile(filename, data) {
  const d = await downloads();
  if (d) {
    try { await d.save({ filename, data }); }
    catch (e) { if (e && e.code !== 'declined') toast('Could not save ' + filename + (e.message ? ': ' + e.message : ''), { kind: 'error' }); }
    return;
  }
  const url = URL.createObjectURL(data instanceof Blob ? data : new Blob([data]));
  const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
