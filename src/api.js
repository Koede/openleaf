import { S } from './state.js';

export async function api(url, opts = {}) {
  const o = { ...opts, headers: { 'x-client-id': S.clientId, ...(opts.headers || {}) } };
  if (o.json !== undefined) { o.method = o.method || 'POST'; o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(o.json); delete o.json; }
  let r;
  try { r = await fetch(url, o); } catch (e) { throw new Error('Cannot reach the server — is it still running?'); }
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : await r.text();
  if (!r.ok) throw new Error((data && data.error) || r.statusText || 'Request failed');
  return data;
}
export const P = () => `/api/p/${encodeURIComponent(S.project)}`;
export const rawUrl = (path, extra = '') => `${P()}/raw?path=${encodeURIComponent(path)}${extra}`;
export const fetchText = async (path) => {
  const r = await fetch(rawUrl(path, `&t=${Date.now()}`));
  if (!r.ok) throw new Error('Could not read ' + path);
  return r.text();
};
