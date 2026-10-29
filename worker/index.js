// Cloudflare Worker entry: serves the built client (static assets) and routes room traffic
// to one Durable Object per room.
export { BattleRoom } from './room.js';
export { Matchmaker } from './matchmaker.js';
export { PlayerProfile, TransferCodes } from './profile.js';
export { GameStats } from './stats.js';
import { statEvent, statsStub } from './stats.js';
import { roomCode, phraseRoomId } from './codes.js';
import { normPhrase } from '../shared/arena.js';
import { TOKEN_RE, profileKey, profileStub, newToken } from './profile.js';

const matchmaker = (env) => env.MATCH.get(env.MATCH.idFromName('global'));
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});

export default {
  async fetch(request, env, ctx) {
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

    // passphrase: the same phrase always leads to the same private room. If nobody is in it, it is
    // (re)made with the rules of the person arriving; otherwise they join with the room's rules.
    if (url.pathname === '/api/phrase' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const norm = normPhrase(body.phrase);
      if (!norm) return json({ error: 'bad_phrase' }, 400);
      const id = await phraseRoomId(norm);
      const stub = env.ROOMS.get(env.ROOMS.idFromName(id));
      const r = await stub.fetch('https://room/claim', { method: 'POST', headers: { 'x-room-id': id, 'content-type': 'application/json' }, body: JSON.stringify({ rules: body.rules ?? null, phrase: norm }) });
      return json({ id, ...(await r.json()) }, r.status);
    }

    // quick match: the matchmaker picks (or creates) a public room with a free seat
    if (url.pathname === '/api/quickmatch' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      return matchmaker(env).fetch('https://mm/match', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: body.mode, size: body.size, goal: body.goal, target: body.target, exclude: body.exclude }) });
    }
    if (url.pathname === '/api/stats') return matchmaker(env).fetch('https://mm/stats');
    if (url.pathname.startsWith('/api/profile')) return profileApi(request, env, url.pathname.slice('/api/profile'.length), ctx);
    if (url.pathname === '/api/admin/summary') return adminSummary(request, env, url);

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
async function profileApi(request, env, path, ctx) {
  const codes = env.CODES.get(env.CODES.idFromName('global'));
  const post = (stub, p, body) => stub.fetch(`https://profile${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  if (path === '/new' && request.method === 'POST') {
    const token = newToken();
    const pkey = await profileKey(token);
    const profile = await (await profileStub(env, pkey).fetch('https://profile/view')).json();
    statEvent(env, ctx, { type: 'new' }); statEvent(env, ctx, { type: 'open', pkey });
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
  const pkey = await profileKey(token);
  const stub = profileStub(env, pkey);
  if (path === '' && request.method === 'GET') { statEvent(env, ctx, { type: 'open', pkey }); return stub.fetch('https://profile/view'); }
  if (request.method !== 'POST') return json({ error: 'not found' }, 404);
  const body = await request.json().catch(() => ({}));
  if (path === '/look') return post(stub, '/look', { look: body.look });
  if (path === '/reroll') return post(stub, '/reroll', { index: body.index });
  if (path === '/transfer') return post(codes, '/issue', { token });
  return json({ error: 'not found' }, 404);
}

// ------------------------------------------------------------------ owner's dashboard data
// Authorization: Bearer <admin key>. Only the SHA-256 of the key is in the config (ADMIN_KEY_HASH).
async function adminSummary(request, env, url) {
  const key = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!env.ADMIN_KEY_HASH || !key) return json({ error: 'unauthorized' }, 401);
  const h = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)))].map((b) => b.toString(16).padStart(2, '0')).join('');
  if (h !== env.ADMIN_KEY_HASH) return json({ error: 'unauthorized' }, 401);
  const days = url.searchParams.get('days') || '30';
  return statsStub(env).fetch(`https://stats/summary?days=${encodeURIComponent(days)}`);
}
