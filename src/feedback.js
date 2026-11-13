// Feedback: bug reports and feature requests from inside the app.
// "Send" stores the report on this server (server/feedback.js), where the admin can review it
// and set a status. "Open on GitHub" opens a prefilled public issue on the project's repository.
import { S, prefs, esc } from './state.js';
import { api } from './api.js';
import { toast, confirmBox, timeAgo } from './ui.js';

const $ = (id) => document.getElementById(id);
const TEMPLATES = {
  bug: 'What happened?\n\n\nWhat did you expect to happen?\n\n\nSteps to reproduce:\n1. \n',
  feature: 'What would you like to be able to do?\n\n\nWhat is it for (the problem it solves)?\n\n',
};
const TITLE_HINT = { bug: 'e.g. The PDF does not refresh after a compile', feature: 'e.g. Comments on a selection of text' };
const LABEL = { bug: 'Bug', feature: 'Feature request' };

let info = null; // GET /api/feedback: { items, admin, statuses, github, server }
async function load() {
  try { info = await api('/api/feedback'); info.available = true; }
  catch { info = { items: [], admin: false, statuses: [], github: 'Koede/openleaf', server: {}, available: false }; }
  updateBadge();
  return info;
}

// Admins see how many reports are still open on the top-bar button.
function updateBadge() {
  const b = $('fbBtn'); if (!b) return;
  const open = info && info.admin ? info.items.filter((i) => i.status === 'open').length : 0;
  b.dataset.count = open ? String(open) : '';
  b.title = 'Report a bug or request a feature' + (open ? ` (${open} open)` : '');
}

// What is attached to a report: versions, browser, settings and the last compile's errors.
// Never the document's text or the project's name.
function diagnostics() {
  const r = S.lastResult, srv = (info && info.server) || {};
  const errs = (S.issues || []).filter((i) => i.type === 'error').slice(0, 8)
    .map((i) => `- ${i.file ? i.file + (i.line ? ':' + i.line : '') + '  ' : ''}${i.message}`);
  return [
    `openleaf ${srv.version || '?'}${srv.tex ? ' · TeX: ' + srv.tex : ''}`,
    `Browser: ${navigator.userAgent}`,
    `Window: ${innerWidth}×${innerHeight} · theme ${prefs.theme} · layout ${prefs.layout}`,
    `Engine: ${S.settings.engine || 'pdflatex'}${S.settings.main ? ' · main file ' + S.settings.main : ''}`,
    r ? `Last compile: ${r.ok ? 'OK' : r.hasPdf ? 'PDF with errors' : 'failed'}${r.pages ? ` · ${r.pages} pages` : ''}${r.ms ? ` · ${(r.ms / 1000).toFixed(1)} s` : ''}` : 'Last compile: none in this session',
    ...(errs.length ? ['Errors:', ...errs] : []),
  ].join('\n');
}

function githubUrl(kind, title, body, diag) {
  let text = body.trim();
  if (diag) text += `\n\n<details><summary>Diagnostics</summary>\n\n\`\`\`\n${diag}\n\`\`\`\n</details>\n`;
  if (text.length > 6000) text = text.slice(0, 6000) + '\n\n(truncated)';
  const q = new URLSearchParams({ title, body: text, labels: kind === 'bug' ? 'bug' : 'enhancement' });
  return `https://github.com/${info.github}/issues/new?${q}`;
}

export async function openFeedback(startOn = 'new') {
  await load();
  const prev = document.activeElement;
  const back = document.createElement('div'); back.className = 'modal-back';
  const box = document.createElement('div'); box.className = 'modal fb'; box.style.width = 'min(620px, 94vw)';
  box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-label', 'Feedback');
  box.innerHTML = `
    <h3>Feedback</h3>
    <div class="fb-tabs" role="tablist">
      <button type="button" role="tab" data-tab="new">Report or request</button>
      <button type="button" role="tab" data-tab="list">${info.admin ? 'All feedback' : 'Sent by you'} <span class="fb-n">${info.items.length || ''}</span></button>
    </div>
    <form class="fb-new" novalidate>
      <div class="seg fb-kind" role="radiogroup" aria-label="Kind">
        <button type="button" role="radio" data-k="bug">🐞 Bug</button><button type="button" role="radio" data-k="feature">✨ Feature request</button>
      </div>
      <label class="field"><span>Title</span><input type="text" name="title" maxlength="200" autocomplete="off" required></label>
      <label class="field"><span>Details</span><textarea name="body" rows="9" spellcheck="true"></textarea></label>
      <label class="field check"><input type="checkbox" name="diag" checked><span>Include diagnostics (versions, browser, last compile's errors; no document text)</span></label>
      <details class="fb-diag"><summary>Show what gets attached</summary><pre></pre></details>
      <p class="fb-err" role="alert"></p>
      <div class="modal-actions">
        <button type="button" data-act="cancel">Cancel</button>
        ${info.github ? '<button type="button" data-act="github" title="Opens a prefilled public issue on GitHub. You review it there before posting.">Open on GitHub ↗</button>' : ''}
        ${info.available ? '<button type="submit" class="primary">Send</button>' : ''}
      </div>
      <p class="fb-note">${info.available ? '<b>Send</b> saves it on this server for the admin.' : 'Sending needs the openleaf server.'}${info.github ? ' <b>Open on GitHub</b> creates a public issue: check it holds nothing private before posting.' : ''}</p>
    </form>
    <div class="fb-list" hidden></div>`;
  back.appendChild(box); document.body.appendChild(back);

  const form = box.querySelector('.fb-new'), list = box.querySelector('.fb-list'), err = box.querySelector('.fb-err');
  const title = form.elements.title, body = form.elements.body, diagBox = form.elements.diag, diagPre = box.querySelector('.fb-diag pre');
  let kind = 'bug';
  const setKind = (k) => {
    if (!body.value.trim() || body.value === TEMPLATES[kind]) body.value = TEMPLATES[k];
    kind = k; title.placeholder = TITLE_HINT[k];
    box.querySelectorAll('.fb-kind button').forEach((b) => { const on = b.dataset.k === k; b.classList.toggle('on', on); b.setAttribute('aria-checked', on); });
  };
  const refreshDiag = () => { diagPre.textContent = diagnostics(); box.querySelector('.fb-diag').hidden = !diagBox.checked; };
  const tab = (t) => {
    form.hidden = t !== 'new'; list.hidden = t !== 'list';
    box.querySelectorAll('.fb-tabs button').forEach((b) => b.setAttribute('aria-selected', b.dataset.tab === t));
    if (t === 'list') renderList(list); else setTimeout(() => title.focus(), 0);
  };
  const onKey = (e) => { if (e.key === 'Escape' && !e.defaultPrevented) { e.stopPropagation(); close(); } };
  const close = () => { document.removeEventListener('keydown', onKey, true); back.remove(); if (prev && prev.focus) prev.focus(); };
  document.addEventListener('keydown', onKey, true);
  const body_ = () => (body.value === TEMPLATES[kind] ? '' : body.value);

  box.querySelectorAll('.fb-kind button').forEach((b) => (b.onclick = () => setKind(b.dataset.k)));
  box.querySelectorAll('.fb-tabs button').forEach((b) => (b.onclick = () => tab(b.dataset.tab)));
  diagBox.onchange = refreshDiag;
  box.querySelector('[data-act=cancel]').onclick = close;
  const gh = box.querySelector('[data-act=github]');
  if (gh) gh.onclick = () => {
    if (!title.value.trim()) { err.textContent = 'Add a short title first.'; title.focus(); return; }
    window.open(githubUrl(kind, title.value.trim(), body_(), diagBox.checked ? diagnostics() : ''), '_blank', 'noopener');
  };
  form.onsubmit = async (e) => {
    e.preventDefault(); err.textContent = '';
    if (!title.value.trim()) { err.textContent = 'Add a short title.'; title.focus(); return; }
    const btn = form.querySelector('[type=submit]'); btn.disabled = true;
    try {
      await api('/api/feedback', { json: { kind, title: title.value.trim(), body: body_(), diag: diagBox.checked ? diagnostics() : '' } });
      toast(kind === 'bug' ? 'Bug report sent. Thank you.' : 'Feature request sent. Thank you.');
      title.value = ''; body.value = TEMPLATES[kind];
      await load(); box.querySelector('.fb-n').textContent = info.items.length || ''; tab('list');
    } catch (ex) { err.textContent = ex.message; } finally { btn.disabled = false; }
  };
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });

  setKind('bug'); refreshDiag(); tab(startOn);
}

function renderList(el) {
  const items = info.items;
  if (!items.length) { el.innerHTML = `<p class="muted">${info.available ? 'Nothing yet.' : 'The list needs the openleaf server.'}</p>`; return; }
  el.innerHTML = items.map((it) => `
    <div class="fb-item" data-id="${esc(it.id)}">
      <div class="fb-head">
        <span class="fb-badge ${esc(it.kind)}">${esc(LABEL[it.kind] || it.kind)}</span>
        <b class="fb-title">${esc(it.title)}</b>
        <span class="grow"></span>
        ${info.admin
          ? `<select class="fb-status" aria-label="Status">${info.statuses.map((s) => `<option${s === it.status ? ' selected' : ''}>${esc(s)}</option>`).join('')}</select>`
          : `<span class="fb-chip s-${esc(it.status.replace(/\W+/g, '-'))}">${esc(it.status)}</span>`}
        <button type="button" class="fb-del" title="Delete" aria-label="Delete">✕</button>
      </div>
      <div class="fb-meta">${it.user ? esc(it.user) + ' · ' : ''}${esc(timeAgo(it.created))}${it.updated > it.created + 1000 ? ' · updated ' + esc(timeAgo(it.updated)) : ''}</div>
      ${it.body || it.diag ? `<details><summary>Details</summary>${it.body ? `<pre>${esc(it.body)}</pre>` : ''}${it.diag ? `<pre class="fb-diagtext">${esc(it.diag)}</pre>` : ''}</details>` : ''}
    </div>`).join('');
  el.querySelectorAll('.fb-item').forEach((row) => {
    const id = row.dataset.id;
    const sel = row.querySelector('.fb-status');
    if (sel) sel.onchange = async () => {
      try { await api('/api/feedback/' + encodeURIComponent(id), { method: 'PATCH', json: { status: sel.value } }); await load(); toast('Status: ' + sel.value); }
      catch (e) { toast(e.message, { kind: 'error' }); }
    };
    row.querySelector('.fb-del').onclick = async () => {
      if (!(await confirmBox('Delete this feedback?', `"${info.items.find((x) => x.id === id)?.title}" will be removed for everyone.`, { ok: 'Delete', danger: true }))) return;
      try { await api('/api/feedback/' + encodeURIComponent(id), { method: 'DELETE' }); await load(); renderList(el); }
      catch (e) { toast(e.message, { kind: 'error' }); }
    };
  });
}

// Top-bar button; the badge is filled once the user is signed in.
export function initFeedback() {
  const b = $('fbBtn'); if (!b) return;
  b.onclick = () => openFeedback('new');
  load();
}
