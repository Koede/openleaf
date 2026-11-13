// Review: comments and track changes (as in Overleaf). Both live in the shared Yjs document of a file
// (maps "comments" and "changes"), anchored with relative positions so they move with the text, and
// the server saves them beside the file. Decorations show them in the editor; the Review tab lists them.
import * as Y from 'yjs';
import { ViewPlugin, Decoration, WidgetType, EditorView } from '@codemirror/view';
import { StateEffect } from '@codemirror/state';
import { ySyncAnnotation } from 'y-codemirror.next';
import { S, bus, esc, debounce } from './state.js';
import * as collab from './collab.js';
import { toast, confirmBox, timeAgo } from './ui.js';

const $ = (id) => document.getElementById(id);
const refresh = StateEffect.define();
const me = () => S.user || 'you';
const canEdit = () => S.role !== 'view';
const hue = (name) => { let h = 0; for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; };
const color = (name) => `hsl(${hue(name)} 70% 40%)`;
const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

// ---------- positions ----------
const rel = (e, i, assoc) => Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(e.ytext, Math.max(0, Math.min(e.ytext.length, i)), assoc));
const abs = (e, j) => { try { const a = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(j), e.ydoc); return a ? a.index : null; } catch { return null; } };
export function itemsOf(e, { resolved = false } = {}) {
  if (!e) return [];
  const out = [];
  for (const [id, c] of e.ydoc.getMap('changes').entries()) {
    const from = abs(e, c.from); if (from == null) continue;
    const to = c.kind === 'del' ? from : abs(e, c.to);
    out.push({ type: 'change', id, kind: c.kind, user: c.user, ts: c.ts, from, to: Math.max(from, to ?? from), text: c.kind === 'del' ? c.text : e.ytext.toString().slice(from, to ?? from) });
  }
  for (const [id, m] of e.ydoc.getMap('comments').entries()) {
    if (m.get('resolved') && !resolved) continue;
    const from = abs(e, m.get('from')), to = abs(e, m.get('to')); if (from == null) continue;
    out.push({ type: 'comment', id, from, to: Math.max(from, to ?? from), resolved: !!m.get('resolved'), by: m.get('by'), ts: m.get('ts'), thread: m.get('thread') ? m.get('thread').toArray() : [], quote: e.ytext.toString().slice(from, Math.max(from, to ?? from)) });
  }
  return out.sort((a, b) => a.from - b.from || (a.type === 'comment') - (b.type === 'comment'));
}

// ---------- editor decorations + recording tracked changes ----------
class DelWidget extends WidgetType {
  constructor(text, user) { super(); this.text = text; this.user = user; }
  eq(o) { return o.text === this.text && o.user === this.user; }
  toDOM() { const s = document.createElement('span'); s.className = 'cm-tc-del'; s.textContent = this.text.length > 60 ? this.text.slice(0, 57) + '…' : this.text; s.title = `Deleted by ${this.user}: ${this.text}`; s.style.setProperty('--c', color(this.user)); return s; }
  ignoreEvent() { return false; }
}

export function extension(e) {
  const plugin = ViewPlugin.fromClass(class {
    constructor(view) {
      this.view = view; this.mine = { ins: [], del: [] }; this.build();
      this.obs = () => { if (this.pending) return; this.pending = true; requestAnimationFrame(() => { this.pending = false; try { view.dispatch({ effects: refresh.of(null) }); } catch {} }); };
      e.ydoc.getMap('comments').observeDeep(this.obs); e.ydoc.getMap('changes').observe(this.obs);
    }
    build() {
      const decos = [], len = this.view.state.doc.length;
      this.mine = { ins: [], del: [] };
      for (const it of itemsOf(e)) {
        const from = Math.min(it.from, len), to = Math.min(it.to, len);
        if (it.type === 'comment') { if (to > from) decos.push(Decoration.mark({ class: 'cm-comment', attributes: { 'data-comment': it.id, title: `${it.thread[0]?.user || ''}: ${it.thread[0]?.text || ''}` } }).range(from, to)); }
        else if (it.kind === 'ins') { if (to > from) decos.push(Decoration.mark({ class: 'cm-tc-ins', attributes: { style: `--c:${color(it.user)}`, title: `Added by ${it.user}`, 'data-change': it.id } }).range(from, to)); if (it.user === me()) this.mine.ins.push([from, to, it.id]); }
        else { decos.push(Decoration.widget({ widget: new DelWidget(it.text, it.user), side: -1 }).range(from)); if (it.user === me()) this.mine.del.push([from, it.id]); }
      }
      this.decorations = Decoration.set(decos, true);
    }
    update(u) {
      if (u.docChanged && S.settings.trackChanges && canEdit()) for (const tr of u.transactions) if (tr.docChanged && !tr.annotation(ySyncAnnotation)) this.record(tr);
      if (u.docChanged || u.transactions.some((t) => t.effects.some((x) => x.is(refresh)))) { this.build(); bus.emit('review-changed', { path: e.path }); }
    }
    // One user's typing: grow their insertion at its end; deletions of their own insertions just shrink it.
    record(tr) {
      const changes = e.ydoc.getMap('changes'), user = me(), now = Date.now();
      const ownIns = this.mine.ins, ownDel = this.mine.del;   // positions in the document before this edit
      e.ydoc.transact(() => {
        tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
          if (toA > fromA) {
            // the parts of the deleted range that were not this person's own pending insertions
            let segs = [[fromA, toA]];
            for (const [a, b] of ownIns) segs = segs.flatMap(([x, y]) => (b <= x || a >= y ? [[x, y]] : [[x, Math.max(x, a)], [Math.min(y, b), y]].filter(([p, q]) => q > p)));
            const text = segs.map(([x, y]) => tr.startState.sliceDoc(x, y)).join('');
            if (text) {
              const prev = ownDel.find(([p]) => p === toA || p === fromA);
              if (prev) { const c = changes.get(prev[1]); changes.set(prev[1], { ...c, ts: now, text: prev[0] === toA ? text + c.text : c.text + text, from: rel(e, fromB, 0), to: rel(e, fromB, -1) }); }
              else changes.set(newId(), { kind: 'del', user, ts: now, from: rel(e, fromB, 0), to: rel(e, fromB, -1), text });
            }
          }
          if (toB > fromB) {
            const prev = ownIns.find(([, b]) => b === fromA);
            if (prev && changes.get(prev[2])) changes.set(prev[2], { ...changes.get(prev[2]), ts: now, to: rel(e, toB, -1) });
            else changes.set(newId(), { kind: 'ins', user, ts: now, from: rel(e, fromB, 0), to: rel(e, toB, -1) });
          }
        });
      }, 'review');
    }
    destroy() { e.ydoc.getMap('comments').unobserveDeep(this.obs); e.ydoc.getMap('changes').unobserve(this.obs); }
  }, { decorations: (v) => v.decorations });
  const clicks = EditorView.domEventHandlers({
    click(ev) { const t = ev.target.closest && ev.target.closest('[data-comment],[data-change]'); if (t) { showReview(t.dataset.comment || t.dataset.change); } return false; },
  });
  return [plugin, clicks];
}

// ---------- actions ----------
const entry = () => (S.current && collab.isCollab(S.current) ? collab.entryFor(S.current) : null);
export function accept(e, id) { e.ydoc.getMap('changes').delete(id); }
export function reject(e, id) {
  const c = e.ydoc.getMap('changes').get(id); if (!c) return;
  e.ydoc.transact(() => {
    const from = abs(e, c.from);
    if (c.kind === 'ins') { const to = abs(e, c.to); if (from != null && to > from) e.ytext.delete(from, to - from); }
    else if (from != null) e.ytext.insert(from, c.text);
    e.ydoc.getMap('changes').delete(id);
  }, 'review');
}
export async function addComment() {
  const e = entry(); if (!e) return toast(S.current ? 'Comments need the live connection to the server' : 'Open a file first', { kind: 'warn' });
  if (!canEdit()) return toast('You can view this project but not comment', { kind: 'warn' });
  const v = (await import('./editor.js')).view, sel = v.state.selection.main;
  if (sel.empty) return toast('Select the text you want to comment on', { kind: 'warn' });
  const text = await askText('Add comment', `“${v.state.sliceDoc(sel.from, Math.min(sel.to, sel.from + 80))}${sel.to - sel.from > 80 ? '…' : ''}”`);
  if (!text) return;
  const id = newId();
  e.ydoc.transact(() => {
    const m = new Y.Map(), th = new Y.Array(); th.push([{ user: me(), text, ts: Date.now() }]);
    m.set('from', rel(e, sel.from, 0)); m.set('to', rel(e, sel.to, -1)); m.set('resolved', false); m.set('by', me()); m.set('ts', Date.now()); m.set('thread', th);
    e.ydoc.getMap('comments').set(id, m);
  });
  showReview(id);
}
function askText(title, quote) {
  return new Promise((resolve) => {
    const back = document.createElement('div'); back.className = 'modal-back';
    back.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}" style="width:min(520px,94vw)"><h3>${esc(title)}</h3><p class="muted rv-quote">${esc(quote)}</p><textarea class="rv-input" rows="4" placeholder="Write a comment… (Ctrl+Enter to post)"></textarea><div class="modal-actions"><button type="button" class="c">Cancel</button><button type="button" class="primary o">Comment</button></div></div>`;
    document.body.appendChild(back);
    const ta = back.querySelector('textarea'), done = (v) => { back.remove(); resolve(v); };
    back.querySelector('.c').onclick = () => done(null); back.querySelector('.o').onclick = () => done(ta.value.trim() || null);
    ta.onkeydown = (ev) => { if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) done(ta.value.trim() || null); if (ev.key === 'Escape') { ev.stopPropagation(); done(null); } };
    setTimeout(() => ta.focus(), 0);
  });
}

// ---------- Review panel ----------
let focusId = null, showResolved = false;
export function showReview(id) { focusId = id || null; bus.emit('side-tab', 'review'); renderSoon(); }
async function goTo(from) { const { view } = await import('./editor.js'); view.dispatch({ selection: { anchor: Math.min(from, view.state.doc.length) }, scrollIntoView: true }); view.focus(); }

function render() {
  const box = $('reviewList'); if (!box || $('reviewPanel').hidden) return;
  const e = entry();
  $('tcToggle').checked = !!S.settings.trackChanges; $('tcToggle').disabled = !canEdit();
  if (!e) { box.innerHTML = `<div class="empty">${S.current ? 'Review needs the live connection to the server.' : 'Open a file to see its comments and changes.'}</div>`; $('rvAll').hidden = true; return; }
  const items = itemsOf(e, { resolved: showResolved });
  const changes = items.filter((i) => i.type === 'change');
  $('rvAll').hidden = !changes.length || !canEdit();
  $('rvCount').textContent = changes.length ? `${changes.length} change${changes.length === 1 ? '' : 's'}` : '';
  if (!items.length) { box.innerHTML = `<div class="empty">No comments or tracked changes in this file.<br><small>${canEdit() ? 'Select text and press 💬 to comment; switch on Track changes to record edits.' : ''}</small></div>`; return; }
  box.innerHTML = items.map((it) => it.type === 'change' ? `
    <div class="rv-item rv-change${it.id === focusId ? ' focus' : ''}" data-id="${esc(it.id)}" data-from="${it.from}">
      <div class="rv-head"><span class="rv-user" style="--c:${color(it.user)}">${esc(it.user)}</span><span class="muted">${it.kind === 'ins' ? 'added' : 'deleted'} · ${esc(timeAgo(it.ts))}</span><span class="grow"></span>
      ${canEdit() ? `<button type="button" class="rv-acc" title="Accept">✓</button><button type="button" class="rv-rej" title="Reject">✕</button>` : ''}</div>
      <div class="rv-text ${it.kind}">${esc(it.text.length > 200 ? it.text.slice(0, 197) + '…' : it.text) || '<i>(empty)</i>'}</div>
    </div>` : `
    <div class="rv-item rv-comment${it.resolved ? ' resolved' : ''}${it.id === focusId ? ' focus' : ''}" data-id="${esc(it.id)}" data-from="${it.from}">
      <div class="rv-quote">“${esc(it.quote.length > 90 ? it.quote.slice(0, 87) + '…' : it.quote)}”</div>
      ${it.thread.map((t) => `<div class="rv-msg"><span class="rv-user" style="--c:${color(t.user)}">${esc(t.user)}</span> <span class="muted">${esc(timeAgo(t.ts))}</span><div>${esc(t.text)}</div></div>`).join('')}
      ${canEdit() ? `<div class="rv-actions"><input type="text" class="rv-reply" placeholder="Reply…" aria-label="Reply"><button type="button" class="rv-res">${it.resolved ? 'Reopen' : 'Resolve'}</button>${it.by === me() || S.role === 'owner' ? '<button type="button" class="rv-del" title="Delete comment">🗑</button>' : ''}</div>` : ''}
    </div>`).join('');
  box.querySelectorAll('.rv-item').forEach((row) => {
    const id = row.dataset.id;
    row.addEventListener('click', (ev) => { if (!ev.target.closest('button,input')) goTo(+row.dataset.from); });
    row.querySelector('.rv-acc')?.addEventListener('click', () => accept(e, id));
    row.querySelector('.rv-rej')?.addEventListener('click', () => reject(e, id));
    row.querySelector('.rv-res')?.addEventListener('click', () => { const m = e.ydoc.getMap('comments').get(id); if (m) m.set('resolved', !m.get('resolved')); });
    row.querySelector('.rv-del')?.addEventListener('click', async () => { if (await confirmBox('Delete comment', 'Delete this comment and its replies?', { ok: 'Delete', danger: true })) e.ydoc.getMap('comments').delete(id); });
    const rp = row.querySelector('.rv-reply');
    if (rp) rp.onkeydown = (ev) => { if (ev.key === 'Enter' && rp.value.trim()) { const m = e.ydoc.getMap('comments').get(id); m && m.get('thread').push([{ user: me(), text: rp.value.trim(), ts: Date.now() }]); rp.value = ''; } };
  });
  const f = focusId && box.querySelector(`.rv-item[data-id="${CSS.escape(focusId)}"]`); if (f) { f.scrollIntoView({ block: 'nearest' }); focusId = null; }
}
const renderSoon = debounce(render, 120);
bus.on('review-changed', renderSoon); bus.on('current', renderSoon); bus.on('settings', renderSoon);
bus.on('side-tab-shown', (t) => { if (t === 'review') render(); });

export function initReview() {
  $('tcToggle').onchange = async () => {
    const v = $('tcToggle').checked;
    try { await (await import('./api.js')).api(`${(await import('./api.js')).P()}/settings`, { method: 'PUT', json: { trackChanges: v } }); S.settings.trackChanges = v; toast(v ? 'Track changes is on for everyone in this project' : 'Track changes is off', { ms: 2200 }); bus.emit('settings'); }
    catch (err) { $('tcToggle').checked = !v; toast(err.message, { kind: 'error' }); }
  };
  $('rvShowResolved').onchange = () => { showResolved = $('rvShowResolved').checked; render(); };
  $('rvAcceptAll').onclick = () => { const e = entry(); if (e) e.ydoc.transact(() => { for (const id of [...e.ydoc.getMap('changes').keys()]) accept(e, id); }); };
  $('rvRejectAll').onclick = async () => { const e = entry(); if (!e || !(await confirmBox('Reject all changes', 'Undo every tracked change in this file?', { ok: 'Reject all', danger: true }))) return; e.ydoc.transact(() => { for (const id of [...e.ydoc.getMap('changes').keys()]) reject(e, id); }); };
  $('tbCommentAdd').onclick = addComment;
}
