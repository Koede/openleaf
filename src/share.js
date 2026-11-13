// Share dialog (accounts mode), as in Overleaf: invite accounts as editors or viewers, turn share
// links on or off, see who has access, leave a project someone shared with you.
import { S, esc } from './state.js';
import { api, P } from './api.js';
import { toast, confirmBox } from './ui.js';

const $ = (id) => document.getElementById(id);
const linkUrl = (token) => `${location.origin}${location.pathname}#join=${token}`;
const ROLE = { edit: 'Can edit', view: 'Can view', owner: 'Owner' };

// A share link (#join=<token>) adds the signed-in user to the project; returns the name to open.
export async function joinFromHash() {
  const m = /^#join=([A-Za-z0-9_-]{16,})$/.exec(location.hash);
  if (!m) return null;
  try { const r = await api('/api/share/join', { json: { token: m[1] } }); toast(r.role === 'owner' ? 'This is your own project' : `You now have access (${ROLE[r.role].toLowerCase()})`, { kind: 'ok' }); return r.name; }
  catch (e) { toast(e.message, { kind: 'error', ms: 8000 }); return null; }
  finally { try { history.replaceState(null, '', location.pathname); } catch {} }
}

export async function openShare({ onLeave } = {}) {
  if (!S.project) return;
  let info;
  try { info = await api(`${P()}/share`); } catch (e) { toast(e.message, { kind: 'error' }); return; }
  const owner = info.role === 'owner';
  const prev = document.activeElement;
  const back = document.createElement('div'); back.className = 'modal-back';
  const box = document.createElement('div'); box.className = 'modal share'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-label', 'Share project');
  back.appendChild(box); document.body.appendChild(back);
  const close = () => { document.removeEventListener('keydown', onKey, true); back.remove(); if (prev && prev.focus) prev.focus(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });

  const reload = async () => { info = await api(`${P()}/share`); render(); };
  const act = async (fn) => { try { await fn(); await reload(); } catch (e) { toast(e.message, { kind: 'error' }); } };

  function render() {
    const name = S.project.includes('/') ? S.project.slice(S.project.indexOf('/') + 1) : S.project;
    box.innerHTML = `<h3>Share “${esc(name)}”</h3>
      ${owner ? `
      <form class="sh-invite" autocomplete="off">
        <input type="text" name="user" placeholder="Username of someone with an account here" aria-label="Username" spellcheck="false" required>
        <select name="role" aria-label="Role"><option value="edit">Can edit</option><option value="view">Can view</option></select>
        <button type="submit" class="primary">Invite</button>
      </form>` : ''}
      <div class="sh-list" role="list">
        <div class="sh-row" role="listitem"><span class="sh-user">${esc(info.owner)}${info.owner === S.user ? ' (you)' : ''}</span><span class="sh-role">Owner</span></div>
        ${info.members.map((m) => `<div class="sh-row" role="listitem"><span class="sh-user">${esc(m.user)}${m.user === S.user ? ' (you)' : ''}</span>
          ${owner ? `<select class="sh-chg" data-user="${esc(m.user)}" aria-label="Role of ${esc(m.user)}"><option value="edit"${m.role === 'edit' ? ' selected' : ''}>Can edit</option><option value="view"${m.role === 'view' ? ' selected' : ''}>Can view</option></select>
          <button type="button" class="sh-rm danger" data-user="${esc(m.user)}" title="Remove access" aria-label="Remove ${esc(m.user)}">✕</button>` : `<span class="sh-role">${ROLE[m.role]}</span>`}</div>`).join('')}
      </div>
      ${owner ? `
      <h4>Link sharing</h4>
      <p class="muted sh-note">Anyone with an account on this server who opens a link gets that access. Turning a link off or making a new one stops the old link working.</p>
      ${['edit', 'view'].map((r) => `<div class="sh-link"><label class="sh-toggle"><input type="checkbox" data-link="${r}"${info.links[r] ? ' checked' : ''}> ${r === 'edit' ? 'Edit link' : 'View-only link'}</label>
        ${info.links[r] ? `<input type="text" readonly value="${esc(linkUrl(info.links[r]))}" aria-label="${r} link"><button type="button" data-copy="${r}">Copy</button><button type="button" data-renew="${r}" title="Make a new link; the old one stops working">New link</button>` : ''}</div>`).join('')}
      ` : `<p class="muted sh-note">You ${info.role === 'edit' ? 'can edit' : 'can view'} this project. Only the owner can change who has access.</p>`}
      <div class="modal-actions">${owner ? '' : '<button type="button" class="danger sh-leave">Leave project</button>'}<span class="grow"></span><button type="button" class="primary sh-close">Done</button></div>`;
    box.querySelector('.sh-close').onclick = close;
    const inv = box.querySelector('.sh-invite');
    if (inv) {
      inv.onsubmit = (e) => { e.preventDefault(); const user = inv.elements.user.value.trim().toLowerCase(); if (!user) return; act(async () => { await api(`${P()}/share/invite`, { json: { user, role: inv.elements.role.value } }); toast(`Shared with ${user}`, { kind: 'ok' }); }); };
      setTimeout(() => inv.elements.user.focus(), 0);
    }
    box.querySelectorAll('.sh-chg').forEach((s) => (s.onchange = () => act(() => api(`${P()}/share/invite`, { json: { user: s.dataset.user, role: s.value } }))));
    box.querySelectorAll('.sh-rm').forEach((b) => (b.onclick = () => act(() => api(`${P()}/share/remove`, { json: { user: b.dataset.user } }))));
    box.querySelectorAll('[data-link]').forEach((c) => (c.onchange = () => act(() => api(`${P()}/share/link`, { json: { role: c.dataset.link, on: c.checked } }))));
    box.querySelectorAll('[data-renew]').forEach((b) => (b.onclick = () => act(() => api(`${P()}/share/link`, { json: { role: b.dataset.renew, on: true } }))));
    box.querySelectorAll('[data-copy]').forEach((b) => (b.onclick = async () => {
      const url = linkUrl(info.links[b.dataset.copy]);
      try { await navigator.clipboard.writeText(url); toast('Link copied', { kind: 'ok', ms: 1500 }); } catch { const i = b.previousElementSibling.previousElementSibling; i.select(); toast('Press Ctrl+C to copy', { ms: 2000 }); }
    }));
    const leave = box.querySelector('.sh-leave');
    if (leave) leave.onclick = async () => {
      if (!(await confirmBox('Leave project', `You will lose access to “${name}” until the owner shares it again.`, { ok: 'Leave', danger: true }))) return;
      try { await api(`${P()}/share/leave`, { json: {} }); close(); onLeave && onLeave(); } catch (e) { toast(e.message, { kind: 'error' }); }
    };
  }
  render();
}
