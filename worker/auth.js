// Sign in with Google / Apple (optional; guests keep playing without it).
// A sign-in links a Google or Apple account to a profile, so the same progress (and later season
// passes and purchases) can be restored on any device by signing in again.
//
//   GET  /api/auth/config                  -> { google: { web, ios }, apple: { web } }  (public client IDs)
//   POST /api/auth/nonce                   -> { nonce }   (one-time, 10 min; goes into the ID token)
//   POST /api/auth/google | /api/auth/apple { idToken, nonce, code? }   (+ Authorization: Bearer <profile token>)
//        -> { status: 'linked', view }                     the account now belongs to this profile
//        -> { status: 'signedin', token, profile }         switched to the profile the account belongs to
//        -> 409 { status: 'conflict', ticket, current, other }   both have progress: ask the player
//   POST /api/auth/switch  { ticket }      -> { status: 'signedin', token, profile }
//   POST /api/profile/unlink { provider }  -> view
//
// Configuration (Cloudflare → Workers → hovertank-arena → Settings → Variables; plain text, not secret):
//   GOOGLE_WEB_CLIENT_ID   OAuth client "Web application" (also used by Android as the server client ID)
//   GOOGLE_IOS_CLIENT_ID   OAuth client "iOS" (bundle com.lildayne.hovertank)
//   APPLE_WEB_CLIENT_ID    Services ID for the web (default com.lildayne.hovertank.web)
// Secrets (only to revoke Apple tokens when a player deletes their data, which Apple requires):
//   APPLE_TEAM_ID, APPLE_SIGNIN_KEY_ID, APPLE_SIGNIN_PRIVATE_KEY (a "Sign in with Apple" key, .p8)
// Local tests only: AUTH_MOCK=1 accepts unsigned tokens whose header has "alg":"mock".
import { DurableObject } from 'cloudflare:workers';
import { signJwt } from './jwt.js';
import { BUNDLE_ID } from './iap.js';

export class AuthError extends Error { constructor(code, status = 400) { super(code); this.code = code; this.status = status; } }

const b64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), (c) => c.charCodeAt(0));
const dec = (s) => JSON.parse(new TextDecoder().decode(b64url(s)));
const sha256hex = async (s) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('');

export const PROVIDERS = {
  google: { jwks: 'https://www.googleapis.com/oauth2/v3/certs', iss: ['accounts.google.com', 'https://accounts.google.com'] },
  apple: { jwks: 'https://appleid.apple.com/auth/keys', iss: ['https://appleid.apple.com'] },
};
export function audiences(env, provider) {
  if (provider === 'google') return [env.GOOGLE_WEB_CLIENT_ID, env.GOOGLE_IOS_CLIENT_ID].filter(Boolean);
  return [BUNDLE_ID, env.APPLE_WEB_CLIENT_ID || `${BUNDLE_ID}.web`];
}
export const authConfig = (env) => ({
  google: { web: env.GOOGLE_WEB_CLIENT_ID || '', ios: env.GOOGLE_IOS_CLIENT_ID || '' },
  apple: { web: env.APPLE_WEB_CLIENT_ID || '' },   // empty until the Services ID is set up: no Apple button on the web
});

// signing keys of each provider, kept for an hour
const jwksCache = new Map();
async function keyFor(provider, kid) {
  const url = PROVIDERS[provider].jwks;
  let c = jwksCache.get(url);
  if (!c || c.exp < Date.now() || !c.keys.some((k) => k.kid === kid)) {
    const r = await fetch(url);
    if (!r.ok) throw new AuthError(`${provider}_keys_${r.status}`, 502);
    c = { keys: (await r.json()).keys || [], exp: Date.now() + 3600e3 };
    jwksCache.set(url, c);
  }
  const jwk = c.keys.find((k) => k.kid === kid);
  if (!jwk) throw new AuthError('unknown_key', 401);
  return crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
}

// Check an ID token: signature, issuer, audience, expiry. Returns its claims.
export async function verifyIdToken(env, provider, idToken) {
  if (!PROVIDERS[provider]) throw new AuthError('bad_provider');
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3 || idToken.length > 4096) throw new AuthError('bad_token');
  let head, claims;
  try { head = dec(parts[0]); claims = dec(parts[1]); } catch { throw new AuthError('bad_token'); }
  if (head.alg === 'mock' && env.AUTH_MOCK === '1') { /* local tests */ }
  else {
    if (head.alg !== 'RS256') throw new AuthError('bad_token');
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', await keyFor(provider, head.kid), b64url(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    if (!ok) throw new AuthError('bad_signature', 401);
  }
  const now = Date.now() / 1000;
  if (!PROVIDERS[provider].iss.includes(claims.iss)) throw new AuthError('wrong_issuer', 401);
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.some((a) => audiences(env, provider).includes(a))) throw new AuthError('wrong_audience', 401);
  if (!(claims.exp > now - 60) || (claims.iat && claims.iat > now + 300)) throw new AuthError('expired', 401);
  if (typeof claims.sub !== 'string' || !claims.sub) throw new AuthError('bad_token');
  return { ...claims, aud: aud.find((a) => audiences(env, provider).includes(a)) };
}
// the token must carry a nonce we issued (as is, or SHA-256 of it: Apple's native sign-in hashes it)
export const nonceForms = async (raw) => [raw, await sha256hex(raw)];

// ------------------------------------------------------------------ Apple token revocation
const appleSecret = (env, clientId) => {
  const now = Math.floor(Date.now() / 1000);
  return signJwt({ alg: 'ES256', kid: env.APPLE_SIGNIN_KEY_ID }, { iss: env.APPLE_TEAM_ID, iat: now, exp: now + 300, aud: 'https://appleid.apple.com', sub: clientId }, env.APPLE_SIGNIN_PRIVATE_KEY, 'ES256');
};
const appleReady = (env) => !!(env.APPLE_TEAM_ID && env.APPLE_SIGNIN_KEY_ID && env.APPLE_SIGNIN_PRIVATE_KEY);
// authorization code (from the sign-in) -> refresh token, kept only so it can be revoked later
export async function appleRefreshToken(env, clientId, code) {
  if (!appleReady(env) || !code) return null;
  const r = await fetch('https://appleid.apple.com/auth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: await appleSecret(env, clientId), code, grant_type: 'authorization_code' }) });
  if (!r.ok) { console.warn('apple token exchange', r.status); return null; }
  return (await r.json()).refresh_token || null;
}
export async function appleRevoke(env, clientId, refreshToken) {
  if (!appleReady(env) || !refreshToken) return false;
  const r = await fetch('https://appleid.apple.com/auth/revoke', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: await appleSecret(env, clientId), token: refreshToken, token_type_hint: 'refresh_token' }) });
  return r.ok;
}

// ------------------------------------------------------------------ the account directory
// id:<provider>:<sub> -> { token, pkey, at, aud, rt? }   (the profile token is needed to sign in on a new device,
//                                                       like a transfer code that never expires)
// p:<pkey>            -> [ids]
// n:<nonce>           -> expiry          t:<ticket> -> { id, token, exp }  (pending switch)
const TTL = 10 * 60e3;
const rand = (n = 18) => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(n)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export class Accounts extends DurableObject {
  async fetch(request) {
    const path = new URL(request.url).pathname, b = await request.json().catch(() => ({})), st = this.ctx.storage, now = Date.now();
    const J = (d, s = 200) => Response.json(d, { status: s });
    if (path === '/nonce') {
      const n = rand();
      await st.put(`n:${n}`, now + TTL);
      if (!(await st.getAlarm())) await st.setAlarm(now + TTL);
      return J({ nonce: n });
    }
    if (path === '/use-nonce') {   // body.forms: the token's nonce and what it could be the hash of
      for (const n of b.raw || []) { const exp = await st.get(`n:${n}`); if (exp && exp > now) { await st.delete(`n:${n}`); return J({ ok: true }); } }
      return J({ ok: false });
    }
    if (path === '/find') return J((await st.get(`id:${b.id}`)) || {});
    if (path === '/link') {
      const have = await st.get(`id:${b.id}`);
      if (have && have.pkey !== b.pkey) return J({ error: 'taken' }, 409);
      const ids = (await st.get(`p:${b.pkey}`)) || [];
      const prov = b.id.split(':')[0];
      if (ids.some((x) => x !== b.id && x.startsWith(`${prov}:`))) return J({ error: 'other_account' }, 409);
      await st.put({ [`id:${b.id}`]: { token: b.token, pkey: b.pkey, at: have?.at || now, aud: b.aud, ...(b.rt ? { rt: b.rt } : have?.rt ? { rt: have.rt } : {}) }, [`p:${b.pkey}`]: [...new Set([...ids, b.id])] });
      return J({ ok: true });
    }
    if (path === '/unlink') {   // { pkey, provider } or { pkey, all: true } -> the removed records
      const ids = (await st.get(`p:${b.pkey}`)) || [];
      const gone = ids.filter((x) => b.all || x.startsWith(`${b.provider}:`));
      const recs = [];
      for (const id of gone) { recs.push({ id, ...((await st.get(`id:${id}`)) || {}) }); await st.delete(`id:${id}`); }
      const left = ids.filter((x) => !gone.includes(x));
      if (left.length) await st.put(`p:${b.pkey}`, left); else await st.delete(`p:${b.pkey}`);
      return J({ removed: recs.map(({ id, aud, rt }) => ({ id, aud, rt })), left: left.map((x) => x.split(':')[0]) });
    }
    if (path === '/ticket') {
      const t = rand();
      await st.put(`t:${t}`, { id: b.id, token: b.token, exp: now + TTL });
      if (!(await st.getAlarm())) await st.setAlarm(now + TTL);
      return J({ ticket: t });
    }
    if (path === '/use-ticket') {
      const t = await st.get(`t:${b.ticket}`);
      if (!t || t.exp < now) return J({ error: 'expired' }, 404);
      await st.delete(`t:${b.ticket}`);
      return J(t);
    }
    return J({ error: 'not found' }, 404);
  }
  async alarm() {
    const now = Date.now();
    for (const [k, v] of await this.ctx.storage.list({ prefix: 'n:' })) if (v < now) await this.ctx.storage.delete(k);
    for (const [k, v] of await this.ctx.storage.list({ prefix: 't:' })) if (v.exp < now) await this.ctx.storage.delete(k);
  }
}
