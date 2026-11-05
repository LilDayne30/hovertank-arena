// Cloudflare Worker entry: serves the built client (static assets) and routes room traffic
// to one Durable Object per room.
export { BattleRoom } from './room.js';
export { Matchmaker } from './matchmaker.js';
export { PlayerProfile, TransferCodes } from './profile.js';
export { GameStats } from './stats.js';
export { PurchaseLedger } from './iap.js';
import { verifyPurchase, IapError, appleNotification, checkGoogleVoided, ledgerCall } from './iap.js';
import { accountToken, gemPack } from '../shared/shop.js';
import { statEvent, statsStub } from './stats.js';
import { roomCode, phraseRoomId } from './codes.js';
import { normPhrase } from '../shared/arena.js';
import { TOKEN_RE, profileKey, profileStub, newToken } from './profile.js';

const matchmaker = (env) => env.MATCH.get(env.MATCH.idFromName('global'));
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});

// the Android / iOS apps load the game from their own bundle (origin capacitor://localhost on iOS,
// https://localhost on Android) and call this server: allow exactly those origins on /api
const APP_ORIGINS = new Set(['capacitor://localhost', 'https://localhost', 'ionic://localhost']);
function withCors(res, origin) {
  if (!origin || !APP_ORIGINS.has(origin) || res.status === 101) return res;
  const r = new Response(res.body, res);
  r.headers.set('access-control-allow-origin', origin);
  r.headers.set('vary', 'origin');
  return r;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url), origin = request.headers.get('origin');
    if (url.pathname.startsWith('/api/')) {
      if (request.method === 'OPTIONS') {
        if (!APP_ORIGINS.has(origin)) return new Response(null, { status: 403 });
        return new Response(null, { status: 204, headers: {
          'access-control-allow-origin': origin, 'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-allow-headers': 'authorization, content-type, x-src', 'access-control-max-age': '86400', vary: 'origin' } });
      }
      return withCors(await this.route(request, env, ctx, url), origin);
    }
    return this.route(request, env, ctx, url);
  },

  async route(request, env, ctx, url) {
    if (url.pathname === '/api/health') return json({ ok: true });

    if (url.pathname === '/api/rooms' && request.method === 'POST') {
      const id = roomCode();
      let rules = null;
      try { rules = (await request.json())?.rules ?? null; } catch { /* no body: default rules */ }
      const stub = env.ROOMS.get(env.ROOMS.idFromName(id));
      await stub.fetch('https://room/init', { method: 'POST', headers: { 'x-room-id': id, 'content-type': 'application/json' }, body: JSON.stringify({ rules }) });
      return json({ id });
    }

    // tutorial: a private room of one's own with two target tanks (shared/tutorial.js)
    if (url.pathname === '/api/tutorial' && request.method === 'POST') {
      const id = roomCode();
      const stub = env.ROOMS.get(env.ROOMS.idFromName(id));
      await stub.fetch('https://room/init', { method: 'POST', headers: { 'x-room-id': id, 'content-type': 'application/json' }, body: JSON.stringify({ tutorial: true }) });
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
    if (url.pathname === '/api/admin/grant' && request.method === 'POST') return adminGrant(request, env);
    if (url.pathname === '/api/admin/iap-check' && request.method === 'POST') {   // run the Google refund check now
      if (!(await isAdmin(request, env))) return json({ error: 'unauthorized' }, 401);
      try { return json(await checkGoogleVoided(env, profileStub)); } catch (e) { return json({ error: e.code || e.message }, e.status || 500); }
    }
    // App Store Server Notifications V2 (refunds). Answer 200 once handled; anything else makes Apple retry.
    if (url.pathname === '/api/iap/apple' && request.method === 'POST') {
      try { return json(await appleNotification(env, await request.json().catch(() => null), profileStub)); }
      catch (e) { console.warn('apple notification', e?.message); return json({ error: e.code || 'server' }, e instanceof IapError && e.status < 500 ? 400 : 500); }
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

  // Cron Trigger (wrangler.jsonc): take back gems for Google Play purchases refunded since the last check
  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkGoogleVoided(env, profileStub).then((r) => console.log('google voided', JSON.stringify(r))).catch((e) => console.warn('google voided', e?.message)));
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
//   POST /api/profile/delete    -> { deleted: true }  (everything stored for this profile is erased)
//   POST /api/profile/iap       { platform, productId, transactionId | purchaseToken } -> { credited, view }
//   POST /api/profile/shop      { key }    -> { bought, view }   (spend gems on an item)
async function profileApi(request, env, path, ctx) {
  const src = /^[a-z0-9_-]{1,24}$/.test(request.headers.get('x-src') || '') ? request.headers.get('x-src') : undefined;   // ?s= tag of an X post etc.
  const codes = env.CODES.get(env.CODES.idFromName('global'));
  const post = (stub, p, body) => stub.fetch(`https://profile${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  if (path === '/new' && request.method === 'POST') {
    const token = newToken();
    const pkey = await profileKey(token);
    const profile = await (await profileStub(env, pkey).fetch('https://profile/view')).json();
    statEvent(env, ctx, { type: 'new' }); statEvent(env, ctx, { type: 'open', pkey, src, fresh: true });
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
  if (path === '' && request.method === 'GET') { statEvent(env, ctx, { type: 'open', pkey, src }); return stub.fetch('https://profile/view'); }
  if (request.method !== 'POST') return json({ error: 'not found' }, 404);
  const body = await request.json().catch(() => ({}));
  if (path === '/look') return post(stub, '/look', { look: body.look });
  if (path === '/reroll') return post(stub, '/reroll', { index: body.index });
  if (path === '/transfer') return post(codes, '/issue', { token });
  if (path === '/delete') return post(stub, '/delete', {});   // the player deletes their data (app store requirement)
  if (path === '/shop') {
    const r = await post(stub, '/shop', { key: body.key });
    if (!r.ok) return r;
    const j = await r.json();
    if (j.took?.paid) ctx.waitUntil(ledgerCall(env, '/spent', { paid: j.took.paid }).catch(() => {}));   // owner's unused-balance figure
    return json(j);
  }
  // in-app purchase: check it with the store, record it globally (once), then add the gems
  if (path === '/iap') {
    if (!gemPack(body.productId)) return json({ error: 'bad_product' }, 400);
    try {
      const acct = await accountToken(pkey);
      const v = await verifyPurchase(env, body, acct);
      const pack = gemPack(v.productId);
      const c = await ledgerCall(env, '/claim', { key: v.key, pkey, productId: v.productId, gems: pack.gems * v.quantity, jpy: pack.jpy * v.quantity, env: v.env });
      if (!c.ok) return json({ error: 'used' }, 409);
      return post(stub, '/credit', { key: v.key, productId: v.productId, quantity: v.quantity });
    } catch (e) {
      if (e instanceof IapError) return json({ error: e.code }, e.status);
      console.warn('iap', e?.message);
      return json({ error: 'server' }, 500);
    }
  }
  return json({ error: 'not found' }, 404);
}

// ------------------------------------------------------------------ owner's dashboard data
// Authorization: Bearer <admin key>. Only the SHA-256 of the key is in the config (ADMIN_KEY_HASH).
async function isAdmin(request, env) {
  const key = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!env.ADMIN_KEY_HASH || !key) return false;
  const h = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)))].map((b) => b.toString(16).padStart(2, '0')).join('');
  return h === env.ADMIN_KEY_HASH;
}
// make a player profile an admin profile (every item unlocked) or back: { token, on }
async function adminGrant(request, env) {
  if (!(await isAdmin(request, env))) return json({ error: 'unauthorized' }, 401);
  const body = await request.json().catch(() => ({}));
  if (!TOKEN_RE.test(body.token || '')) return json({ error: 'bad token' }, 400);
  const stub = profileStub(env, await profileKey(body.token));
  return stub.fetch('https://profile/admin', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ on: body.on !== false }) });
}
async function adminSummary(request, env, url) {
  if (!(await isAdmin(request, env))) return json({ error: 'unauthorized' }, 401);
  const days = url.searchParams.get('days') || '30';
  const [stats, sales] = await Promise.all([
    statsStub(env).fetch(`https://stats/summary?days=${encodeURIComponent(days)}`).then((r) => r.json()),
    ledgerCall(env, '/summary', { days }).catch(() => null),
  ]);
  return json({ ...stats, sales });
}
