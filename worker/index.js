// Cloudflare Worker entry: serves the built client (static assets) and routes room traffic
// to one Durable Object per room.
export { BattleRoom } from './room.js';
export { Matchmaker } from './matchmaker.js';
import { roomCode } from './codes.js';

const matchmaker = (env) => env.MATCH.get(env.MATCH.idFromName('global'));
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

    // quick match: the matchmaker picks (or creates) a public room with a free seat
    if (url.pathname === '/api/quickmatch' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      return matchmaker(env).fetch('https://mm/match', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: body.mode, exclude: body.exclude }) });
    }
    if (url.pathname === '/api/stats') return matchmaker(env).fetch('https://mm/stats');

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
