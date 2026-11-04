// Optional accounts: login / register screen, sign-out, change password.
import { S, bus } from './state.js';
import { api } from './api.js';
import { modal, toast } from './ui.js';

const $ = (id) => document.getElementById(id);
S.user = null; S.accounts = false;

export async function ensureSignedIn() {
  let me; try { me = await api('/api/auth/me'); } catch { me = { accounts: false }; }
  S.accounts = !!me.accounts; S.user = me.user || null;
  if (!S.accounts || S.user) return S.user;
  return showAuth(me.signup !== false);
}

function showAuth(canRegister) {
  return new Promise((resolve) => {
    const box = $('authScreen'); box.hidden = false;
    let mode = 'login';
    const sync = () => {
      $('authTitle').textContent = mode === 'login' ? 'Sign in' : 'Create your account';
      $('authSubmit').textContent = mode === 'login' ? 'Sign in' : 'Create account';
      $('authSwitch').textContent = mode === 'login' ? 'No account? Create one' : 'Have an account? Sign in';
      $('authSwitch').hidden = !canRegister; $('authPw').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
      $('authHint').textContent = mode === 'login' ? '' : '3–32 characters (letters, digits, - and _). Password: at least 8 characters.';
      $('authErr').textContent = '';
    };
    $('authSwitch').onclick = () => { mode = mode === 'login' ? 'register' : 'login'; sync(); };
    $('authForm').onsubmit = async (e) => {
      e.preventDefault(); $('authSubmit').disabled = true; $('authErr').textContent = '';
      try {
        const r = await api(`/api/auth/${mode}`, { json: { username: $('authUser').value, password: $('authPw').value } });
        S.user = r.user; $('authPw').value = ''; box.hidden = true; resolve(r.user);
      } catch (err) { $('authErr').textContent = err.message; }
      $('authSubmit').disabled = false;
    };
    sync(); setTimeout(() => $('authUser').focus(), 30);
  });
}

export async function signOut() { try { await api('/api/auth/logout', { json: {} }); } catch {} location.hash = ''; location.reload(); }

export async function changePassword() {
  const v = await modal({ title: 'Change password', ok: 'Change', fields: [
    { name: 'o', label: 'Current password', type: 'password' }, { name: 'n', label: 'New password (min. 8 characters)', type: 'password' }, { name: 'n2', label: 'Repeat new password', type: 'password' }] });
  if (!v) return;
  if (v.n !== v.n2) return toast('The new passwords do not match', { kind: 'error' });
  try { await api('/api/auth/password', { json: { oldPassword: v.o, newPassword: v.n } }); toast('Password changed. Other devices were signed out.', { kind: 'ok' }); } catch (e) { toast(e.message, { kind: 'error' }); }
}

let reloading = false;
bus.on('auth-required', () => { if (S.accounts && !reloading) { reloading = true; toast('Your session expired — signing in again…', { kind: 'warn' }); setTimeout(() => location.reload(), 1200); } });
