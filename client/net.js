// Minimal room client for the Cloudflare Durable Object server (worker/room.js).
// Messages are JSON arrays: [type, data].
export class RoomError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

export async function createRoom(base, rules) {
  const r = await fetch(`${base}/api/rooms`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rules }) });
  if (!r.ok) throw new RoomError('create_failed', `部屋を作れませんでした (${r.status})`);
  return (await r.json()).id;
}

// quick match: returns the id of a public room with a free seat (created on demand)
export async function quickMatch(base, mode, exclude = [], size = 4) {
  const r = await fetch(`${base}/api/quickmatch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode, size, exclude }) });
  if (!r.ok) throw new RoomError('match_failed', `マッチングに失敗しました (${r.status})`);
  return (await r.json()).id;
}

export async function stats(base) {
  const r = await fetch(`${base}/api/stats`, { cache: 'no-store' });
  return r.ok ? r.json() : null;
}

export async function roomInfo(base, id) {
  const r = await fetch(`${base}/api/rooms/${encodeURIComponent(id)}`, { cache: 'no-store' });
  if (r.status === 404) return { exists: false };
  if (!r.ok) throw new RoomError('info_failed', `サーバーエラー (${r.status})`);
  return r.json();
}

const RECONNECT_WINDOW_MS = 18000;

export class Room {
  constructor(base, roomId) {
    this.base = base;
    this.roomId = roomId;
    this.reconnectionToken = null;
    this.handlers = new Map();
    this.cb = { drop: [], reconnect: [], leave: [] };
    this.ws = null;
    this.left = false;
    this.welcomed = false;
  }

  onMessage(type, fn) { this.handlers.set(type, fn); }
  onDrop(fn) { this.cb.drop.push(fn); }
  onReconnect(fn) { this.cb.reconnect.push(fn); }
  onLeave(fn) { this.cb.leave.push(fn); }
  emit(kind, ...a) { for (const f of this.cb[kind]) f(...a); }

  send(type, data) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify([type, data]));
  }

  wsUrl(name) {
    const u = new URL(`${this.base}/api/rooms/${encodeURIComponent(this.roomId)}/ws`);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    if (name) u.searchParams.set('name', name);
    if (this.reconnectionToken) u.searchParams.set('token', this.reconnectionToken);
    return u.toString();
  }

  // resolves after the server's welcome; rejects with RoomError('full' | 'notfound' | ...)
  connect(name, token) {
    if (token) this.reconnectionToken = token;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl(name));
      this.ws = ws;
      let settled = false;
      const timer = setTimeout(() => { if (!settled) { settled = true; ws.close(); reject(new RoomError('timeout', '接続がタイムアウトしました')); } }, 15000);
      ws.onmessage = (ev) => {
        let msg; try { msg = JSON.parse(ev.data); } catch { return; }
        const [type, data] = msg;
        if (type === 'error') {
          if (!settled) { settled = true; clearTimeout(timer); reject(new RoomError(data.code, data.message)); }
          return;
        }
        if (type === 'welcome') {
          this.reconnectionToken = data.token;
          this.welcomed = true;
          if (!settled) { settled = true; clearTimeout(timer); resolve(this); }
        }
        const h = this.handlers.get(type);
        if (h) h(data);
      };
      ws.onclose = (ev) => {
        if (!settled) { settled = true; clearTimeout(timer); reject(new RoomError('closed', `接続できませんでした (${ev.code})`)); return; }
        if (ws !== this.ws) return;
        if (this.left) return;
        if (ev.code === 4001 || ev.code === 4004) { this.emit('leave', ev.code); return; }   // full / not found
        this.retry();
      };
    });
  }

  async retry() {
    this.emit('drop');
    const until = Date.now() + RECONNECT_WINDOW_MS;
    let delay = 300;
    while (!this.left && Date.now() < until) {
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 1.6, 2500);
      try {
        await this.connect(null, this.reconnectionToken);
        this.emit('reconnect');
        return;
      } catch (e) {
        if (e.code === 'notfound' || e.code === 'expired' || e.code === 'full') break;
      }
    }
    if (!this.left) this.emit('leave', 4003);
  }

  async leave() {
    this.left = true;
    this.send('leave', 1);
    try { this.ws?.close(1000, 'leave'); } catch { /* ignore */ }
  }
}
