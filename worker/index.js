// Cloudflare Worker entry: serves the built client (static assets) and routes room traffic
// to one Durable Object per room.
export { BattleRoom } from './room.js';
export { Matchmaker } from './matchmaker.js';
export { PlayerProfile, TransferCodes } from './profile.js';
import { roomCode } from './codes.js';
import { TOKEN_RE, profileKey, profileStub, newToken } from './profile.js';

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
    if (url.pathname.startsWith('/api/profile')) return profileApi(request, env, url.pathname.slice('/api/profile'.length));

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

// ------------------------------------------------------------------ progression (levels, looks, missions)
// The device keeps a random secret token; requests carry it as "Authorization: Bearer <token>".
//   POST /api/profile/new       -> { token, profile }   (first launch)
//   GET  /api/profile           -> profile
//   POST /api/profile/look      { look }   -> profile  (only owned items are kept)
//   POST /api/profile/reroll    { index }  -> profile  (one daily mission swap per day)
//   POST /api/profile/transfer  -> { code, expiresAt }  (one-time code, 24 h)
//   POST /api/profile/redeem    { code }   -> { token, profile }
async function profileApi(request, env, path) {
  const codes = env.CODES.get(env.CODES.idFromName('global'));
  const post = (stub, p, body) => stub.fetch(`https://profile${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  if (path === '/new' && request.method === 'POST') {
    const token = newToken();
    const profile = await (await profileStub(env, await profileKey(token)).fetch('https://profile/view')).json();
    return json({ token, profile });
  }
  if (path === '/redeem' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const r = await codes.fetch('https://codes/redeem', { method: 'POST', headers: { 'content-type': 'application/json', 'x-ip': request.headers.get('cf-connecting-ip') || '' }, body: JSON.stringify({ code: body.code }) });
    if (!r.ok) return json(await r.json(), r.status);
    const { token } = await r.json();
    const profile = await (await profileStub(env, await profileKey(token)).fetch('https://profile/view')).json();
    return json({ token, profile });
  }
  const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!TOKEN_RE.test(token)) return json({ error: 'no profile' }, 401);
  const stub = profileStub(env, await profileKey(token));
  if (path === '' && request.method === 'GET') return stub.fetch('https://profile/view');
  if (request.method !== 'POST') return json({ error: 'not found' }, 404);
  const body = await request.json().catch(() => ({}));
  if (path === '/look') return post(stub, '/look', { look: body.look });
  if (path === '/reroll') return post(stub, '/reroll', { index: body.index });
  if (path === '/transfer') return post(codes, '/issue', { token });
  return json({ error: 'not found' }, 404);
}
