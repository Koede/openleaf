// Shared application state + a tiny event bus.
const loadPrefs = () => { try { return JSON.parse(localStorage.getItem('ls-prefs') || '{}'); } catch { return {}; } };

export const defaults = { theme: 'system', fontSize: 14, wrap: true, autoCompile: true, spellcheck: false, pdfInvert: 'auto', layout: 'split', sidebarW: 250, pdfW: 0, sideTab: 'files', fold: true, pinPalette: false, recents: [] };
export const prefs = { ...defaults, ...loadPrefs() };
export const savePrefs = () => { try { localStorage.setItem('ls-prefs', JSON.stringify(prefs)); } catch {} bus.emit('prefs'); };

export const S = {
  project: null, tree: [], candidates: [],
  settings: { main: null, engine: 'pdflatex', haltOnError: false },
  open: [], current: null,
  states: new Map(),            // path -> EditorState (undo history lives here)
  dirty: new Set(),
  cache: new Map(),             // path -> text of .tex/.bib/... files (autocomplete, outline)
  collapsed: new Set(),
  issues: [], lastResult: null,
  server: { synctex: false, latexmk: true, templates: [] },
  clientId: (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2)),
};

class Bus extends EventTarget {
  emit(name, detail) { this.dispatchEvent(new CustomEvent(name, { detail })); }
  on(name, fn) { this.addEventListener(name, (e) => fn(e.detail)); }
}
export const bus = new Bus();

export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const debounce = (fn, ms) => { let t; const f = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; f.flush = (...a) => { clearTimeout(t); fn(...a); }; f.cancel = () => clearTimeout(t); return f; };
export const IMG_EXT = /\.(png|jpe?g|gif|svg|webp|bmp)$/i;
export const TEXT_EXT = /\.(tex|sty|cls|bib|bst|bbl|txt|md|cfg|def|clo|dtx|ins|csv|json|tikz|pgf|ist|lbx|cbx|bbx|py|sh)$/i;
export const isText = (p) => TEXT_EXT.test(p) || /(^|\/)\.?latexmkrc$/.test(p) || !/\.[^/.]+$/.test(p.split('/').pop());
export const flatFiles = (nodes = S.tree, out = []) => { for (const n of nodes) n.type === 'dir' ? flatFiles(n.children, out) : out.push(n.path); return out; };
export const fileName = (p) => p.split('/').pop();
export const dirName = (p) => p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
