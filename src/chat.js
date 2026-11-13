// Project chat (as in Overleaf): messages for everyone in the project, live over the websocket.
import { S, bus, esc } from './state.js';
import { api, P } from './api.js';
import { toast, timeAgo } from './ui.js';

const $ = (id) => document.getElementById(id);
let messages = [], unread = 0, loadedFor = null;
const hue = (name) => { let h = 0; for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; };
const shown = () => !$('chatPanel').hidden;

function badge() { const b = document.querySelector('#sideTabs [data-side=chat] .tab-badge'); if (b) { b.textContent = unread ? String(unread) : ''; b.hidden = !unread; } }
function render() {
  const box = $('chatList'); if (!box) return;
  if (!messages.length) { box.innerHTML = '<div class="empty">No messages yet.<br><small>Everyone with access to this project sees this chat.</small></div>'; return; }
  box.innerHTML = messages.map((m) => {
    const who = m.user || 'Someone', mine = m.user && m.user === S.user;
    return `<div class="chat-msg${mine ? ' mine' : ''}"><div class="chat-meta"><b style="color:hsl(${hue(who)} 65% 38%)">${esc(mine ? 'You' : who)}</b> <span class="muted" title="${esc(new Date(m.ts).toLocaleString())}">${esc(timeAgo(m.ts))}</span></div><div class="chat-text">${esc(m.text)}</div></div>`;
  }).join('');
  box.scrollTop = box.scrollHeight;
}
async function load() {
  if (!S.project || window.__DEMO) return;
  loadedFor = S.project;
  try { messages = (await api(`${P()}/chat`)).messages; } catch { messages = []; }
  render();
}
bus.on('ws-chat', ({ message }) => {
  if (loadedFor !== S.project) return;
  if (messages.some((m) => m.id === message.id)) return;
  messages.push(message); render();
  if (!shown() && message.user !== S.user) { unread++; badge(); }
});
bus.on('side-tab-shown', (t) => { if (t === 'chat') { unread = 0; badge(); if (loadedFor !== S.project) load(); else render(); setTimeout(() => $('chatInput')?.focus(), 0); } });
bus.on('project-opened', () => { messages = []; unread = 0; badge(); loadedFor = null; load(); });

export function initChat() {
  $('chatForm').onsubmit = async (e) => {
    e.preventDefault();
    const t = $('chatInput').value.trim(); if (!t) return;
    $('chatInput').value = '';
    try { const r = await api(`${P()}/chat`, { json: { text: t } }); if (!messages.some((m) => m.id === r.message.id)) { messages.push(r.message); render(); } }
    catch (err) { $('chatInput').value = t; toast(err.message, { kind: 'error' }); }
  };
  $('chatInput').onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('chatForm').requestSubmit(); } };
}
