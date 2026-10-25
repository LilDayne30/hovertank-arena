// Cloudflare Worker entry: serves the built client (static assets) and routes room traffic
// to one Durable Object per room.
export { BattleRoom } from './room.js';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no 0/O/1/I
function roomCode() {
  const b = crypto.getRandomValues(new Uint8Array(6));
  return [...b].map((v) => ALPHABET[v % ALPHABET.length]).join('');
}
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/health') return json({ ok: true });

    if (url.pathname === '/api/rooms' && request.method === 'POST') {
      const id = roomCode();
      let rules = null;
      try { rules = (await request.json())?.rules ?? null; } catch { /* no body: default rules */ }
      const stub = env.ROOMS.get(env.ROOMS.idFromName(id));
      await stub.fetch('https://room/init', { method: 'POST', headers: { 'x-room-id': id, 'content-type': 'application/json' }, body: JSON.stringify({ rules }) });
      return json({ id });
    }

    const m = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9]{4,12})(\/ws)?$/);
    if (m) {
      const id = m[1].toUpperCase();
      const stub = env.ROOMS.get(env.ROOMS.idFromName(id));
      const fwd = new URL(request.url);
      fwd.pathname = m[2] ? '/ws' : '/info';
      const headers = new Headers(request.headers);
      headers.set('x-room-id', id);
      return stub.fetch(new Request(fwd.toString(), { method: request.method, headers }));
    }
    if (url.pathname.startsWith('/api/')) return json({ error: 'not found' }, 404);
    return env.ASSETS.fetch(request);
  },
};
