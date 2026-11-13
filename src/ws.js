import { S, bus } from './state.js';
import { onFsEvent } from './files.js';

let ws, retry = 0, timer;
const dot = () => document.getElementById('connDot');
export function connect() {
  clearTimeout(timer);
  const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
  ws = new WebSocket(url);
  ws.onopen = () => { retry = 0; dot().className = 'ok'; dot().title = 'Live connection active'; watch(); bus.emit('ws-open'); };
  ws.onclose = () => { dot().className = 'off'; dot().title = 'Disconnected — retrying…'; bus.emit('ws-close'); timer = setTimeout(connect, Math.min(8000, 500 * 2 ** retry++)); };
  ws.onerror = () => {};
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.project && m.project !== S.project) return;
    if (typeof m.type === 'string' && m.type.startsWith('y-')) bus.emit('ws-y', m);
    else if (m.type === 'fs') onFsEvent(m);
    else if (m.type === 'compile-start') bus.emit('ws-compile-start', m);
    else if (m.type === 'compile-log') bus.emit('ws-compile-log', m);
    else if (m.type === 'compiled') bus.emit('ws-compiled', m);
  };
}
export function watch() { if (ws && ws.readyState === 1 && S.project) ws.send(JSON.stringify({ type: 'watch', project: S.project, clientId: S.clientId })); }
// other modules (co-editing) send through the same socket
bus.on('ws-send', (m) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); });
