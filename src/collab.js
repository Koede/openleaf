// Real-time co-editing in the browser (see server/collab.js). Each open text file is a Y.Doc shared
// through the websocket; CodeMirror is bound to it with y-codemirror.next, which also draws the other
// people's cursors and selections with their names. Undo/redo only undoes your own changes.
import * as Y from 'yjs';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import { keymap } from '@codemirror/view';
import { Prec } from '@codemirror/state';
import { Awareness, encodeAwarenessUpdate, applyAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';
import { S, bus } from './state.js';

const docs = new Map();   // path -> entry
let wsOpen = false;
bus.on('ws-open', () => { wsOpen = true; for (const e of docs.values()) join(e); });
bus.on('ws-close', () => { wsOpen = false; });
const send = (m) => bus.emit('ws-send', m);

const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const hue = (name) => { let h = 0; for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; };
const colors = (name) => ({ color: `hsl(${hue(name)} 70% 42%)`, colorLight: `hsl(${hue(name)} 80% 42% / 0.22)` });

export const available = () => !window.__DEMO && wsOpen;
export const isCollab = (path) => docs.has(path) && docs.get(path).synced;
export const entryFor = (path) => docs.get(path);

function join(e) { if (wsOpen) send({ type: 'y-join', path: e.path, aw: e.ydoc.clientID }); }

// Join the shared document for `path`; resolves once it holds the server's text.
export function open(path) {
  let e = docs.get(path);
  if (e) return e.ready;
  const ydoc = new Y.Doc(), ytext = ydoc.getText('t'), awareness = new Awareness(ydoc);
  e = { path, ydoc, ytext, awareness, undo: new Y.UndoManager(ytext), synced: false, epoch: null };
  const name = S.user || 'Anonymous';
  awareness.setLocalStateField('user', { name, ...colors(name) });
  ydoc.on('update', (u, origin) => { if (origin !== 'remote') send({ type: 'y-update', path, update: b64(u) }); });
  awareness.on('update', ({ added, updated, removed }, origin) => {
    if (origin === 'remote') return;
    send({ type: 'y-aw', path, update: b64(encodeAwarenessUpdate(awareness, [...added, ...updated, ...removed])) });
  });
  e.ready = new Promise((resolve, reject) => { e.resolve = resolve; e.reject = reject; setTimeout(() => { if (!e.synced) { docs.delete(path); reject(new Error('no answer from the server')); } }, 5000); });
  docs.set(path, e); join(e);
  return e.ready;
}

export function extension(e) { return [yCollab(e.ytext, e.awareness, { undoManager: e.undo }), Prec.high(keymap.of(yUndoManagerKeymap))]; }

function drop(path) {
  const e = docs.get(path); if (!e) return;
  docs.delete(path);
  try { e.awareness.destroy(); e.undo.destroy(); e.ydoc.destroy(); } catch {}
}
export function close(path) { if (docs.has(path)) { send({ type: 'y-leave', path }); drop(path); } }
export function closeAll() { for (const p of [...docs.keys()]) close(p); }
export function undo(path) { const e = docs.get(path); if (e) e.undo.undo(); return !!e; }
export function redo(path) { const e = docs.get(path); if (e) e.undo.redo(); return !!e; }
// Set a co-edited file's text from code (not typing): a minimal edit on the shared document.
export function setText(path, next) {
  const e = docs.get(path); if (!e) return false;
  const cur = e.ytext.toString(); if (cur === next) return true;
  let a = 0; const n = Math.min(cur.length, next.length); while (a < n && cur.charCodeAt(a) === next.charCodeAt(a)) a++;
  let b = 0; while (b < n - a && cur.charCodeAt(cur.length - 1 - b) === next.charCodeAt(next.length - 1 - b)) b++;
  e.ydoc.transact(() => { if (cur.length - a - b) e.ytext.delete(a, cur.length - a - b); if (next.length - a - b) e.ytext.insert(a, next.slice(a, next.length - b)); });
  return true;
}
export const peopleIn = (path) => { const e = docs.get(path); if (!e) return []; return [...e.awareness.getStates().entries()].filter(([id]) => id !== e.ydoc.clientID).map(([, st]) => st.user).filter(Boolean); };

bus.on('ws-y', (m) => {
  const e = docs.get(m.path); if (!e) return;
  if (m.type === 'y-sync') {
    if (!e.synced) {
      Y.applyUpdate(e.ydoc, unb64(m.state), 'remote'); e.epoch = m.epoch; e.synced = true; e.readOnly = !!m.readOnly;
      e.resolve(e);
    } else if (m.epoch === e.epoch) {
      // back after a dropped connection: take what we missed, send what we typed meanwhile
      Y.applyUpdate(e.ydoc, unb64(m.state), 'remote');
      send({ type: 'y-update', path: e.path, update: b64(Y.encodeStateAsUpdate(e.ydoc)) });
      e.awareness.setLocalStateField('user', e.awareness.getLocalState()?.user);
    } else {
      // the server started over (restart): rebuild from its copy and re-apply our text
      const text = e.ytext.toString(); drop(e.path); bus.emit('collab-reset', { path: m.path, text });
    }
  } else if (m.type === 'y-update') Y.applyUpdate(e.ydoc, unb64(m.update), 'remote');
  else if (m.type === 'y-aw') applyAwarenessUpdate(e.awareness, unb64(m.update), 'remote');
  else if (m.type === 'y-aw-gone') removeAwarenessStates(e.awareness, m.ids || [], 'remote');
  else if (m.type === 'y-closed') { drop(m.path); bus.emit('collab-closed', { path: m.path }); }
  else if (m.type === 'y-error') { if (!e.synced) { docs.delete(m.path); e.reject(new Error('cannot open this file for co-editing')); } }
  bus.emit('collab-people', { path: m.path });
});
