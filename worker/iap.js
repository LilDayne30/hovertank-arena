// Store purchase verification (server side). The app sends what the store gave it after a purchase;
// we ask Apple / Google directly whether that purchase is real, for this app, this product and this
// player, before any gems are given.
//
// Secrets (Cloudflare dashboard → Workers → hovertank-arena → Settings → Variables and secrets, or
// `npx wrangler secret put NAME`):
//   APPLE_IAP_ISSUER_ID, APPLE_IAP_KEY_ID, APPLE_IAP_PRIVATE_KEY   App Store Connect → Users and Access →
//       Integrations → In-App Purchase key (.p8 file contents, including the BEGIN / END lines)
//   GOOGLE_SERVICE_ACCOUNT   the JSON key of a Google Cloud service account that has access to the app
//       in Play Console (Users and permissions → financial data / manage orders)
// Local tests only: IAP_MOCK=1 accepts transaction IDs that start with "mock-" (never set it in production).
import { DurableObject } from 'cloudflare:workers';

export const BUNDLE_ID = 'com.lildayne.hovertank';

import { signJwt, jwsPayload } from './jwt.js';

export class IapError extends Error { constructor(code, status = 400) { super(code); this.code = code; this.status = status; } }

// ------------------------------------------------------------------ Apple (App Store Server API)
async function appleTransaction(env, transactionId) {
  if (!env.APPLE_IAP_ISSUER_ID || !env.APPLE_IAP_KEY_ID || !env.APPLE_IAP_PRIVATE_KEY) throw new IapError('apple_not_configured', 503);
  const now = Math.floor(Date.now() / 1000);
  const jwt = await signJwt({ alg: 'ES256', kid: env.APPLE_IAP_KEY_ID, typ: 'JWT' },
    { iss: env.APPLE_IAP_ISSUER_ID, iat: now, exp: now + 1200, aud: 'appstoreconnect-v1', bid: BUNDLE_ID }, env.APPLE_IAP_PRIVATE_KEY, 'ES256');
  // production first; a sandbox purchase (TestFlight / review) answers 404 there
  for (const host of ['api.storekit.itunes.apple.com', 'api.storekit-sandbox.itunes.apple.com']) {
    const r = await fetch(`https://${host}/inApps/v1/transactions/${encodeURIComponent(transactionId)}`, { headers: { authorization: `Bearer ${jwt}` } });
    if (r.status === 404) continue;
    if (!r.ok) throw new IapError(`apple_${r.status}`, 502);
    const { signedTransactionInfo } = await r.json();
    return jwsPayload(signedTransactionInfo);   // fetched from Apple over TLS with our key: trusted as is
  }
  throw new IapError('not_found', 404);
}

// ------------------------------------------------------------------ Google (Android Publisher API)
let googleToken = null;
async function googleAccess(env) {
  if (googleToken && googleToken.exp > Date.now() + 60e3) return googleToken.value;
  if (!env.GOOGLE_SERVICE_ACCOUNT) throw new IapError('google_not_configured', 503);
  const sa = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT);
  const now = Math.floor(Date.now() / 1000);
  const assertion = await signJwt({ alg: 'RS256', typ: 'JWT' },
    { iss: sa.client_email, scope: 'https://www.googleapis.com/auth/androidpublisher', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }, sa.private_key, 'RS256');
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${assertion}` });
  if (!r.ok) throw new IapError(`google_auth_${r.status}`, 502);
  const j = await r.json();
  googleToken = { value: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return googleToken.value;
}
async function googlePurchase(env, productId, purchaseToken) {
  const at = await googleAccess(env);
  const r = await fetch(`https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${BUNDLE_ID}/purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}`,
    { headers: { authorization: `Bearer ${at}` } });
  if (r.status === 404 || r.status === 410) throw new IapError('not_found', 404);
  if (!r.ok) throw new IapError(`google_${r.status}`, 502);
  return r.json();
}

// Check one purchase. Returns { key, productId, quantity, env } (key = the purchase's unique id) or throws.
export async function verifyPurchase(env, { platform, productId, transactionId, purchaseToken }, acct) {
  if (platform === 'ios') {
    if (typeof transactionId !== 'string' || !/^[\w-]{1,64}$/.test(transactionId)) throw new IapError('bad_request');
    const t = env.IAP_MOCK === '1' && transactionId.startsWith('mock-')
      ? { transactionId, bundleId: BUNDLE_ID, productId, appAccountToken: acct, quantity: 1, environment: 'Mock' }
      : await appleTransaction(env, transactionId);
    if (t.bundleId !== BUNDLE_ID) throw new IapError('wrong_app');
    if (t.productId !== productId) throw new IapError('wrong_product');
    if (t.revocationDate) throw new IapError('refunded');
    if (t.appAccountToken && t.appAccountToken.toLowerCase() !== acct) throw new IapError('other_player', 403);
    return { key: `ios:${t.transactionId}`, productId, quantity: Math.max(1, Math.min(10, t.quantity || 1)), env: t.environment };
  }
  if (platform === 'android') {
    if (typeof purchaseToken !== 'string' || purchaseToken.length > 1000) throw new IapError('bad_request');
    const p = env.IAP_MOCK === '1' && purchaseToken.startsWith('mock-')
      ? { purchaseState: 0, orderId: `GPA.${purchaseToken}`, obfuscatedExternalAccountId: acct, quantity: 1, purchaseType: 0 }
      : await googlePurchase(env, productId, purchaseToken);
    if (p.purchaseState !== 0) throw new IapError(p.purchaseState === 2 ? 'pending' : 'not_purchased');
    if (p.obfuscatedExternalAccountId && p.obfuscatedExternalAccountId !== acct) throw new IapError('other_player', 403);
    return { key: `android:${p.orderId || purchaseToken.slice(0, 64)}`, productId, quantity: Math.max(1, Math.min(10, p.quantity || 1)), env: p.purchaseType === 0 ? 'Test' : 'Production' };
  }
  throw new IapError('bad_platform');
}

// ------------------------------------------------------------------ refunds
// A refunded purchase takes its gems back from the profile that got them (the paid balance can go below
// zero when the gems were already spent; later purchases fill it up first).
//   Apple:  App Store Server Notifications V2 → POST /api/iap/apple (set this URL in App Store Connect →
//           the app → App Information → App Store Server Notifications, production and sandbox)
//   Google: no push needed; the voided purchases list is checked every 6 hours (Cron Trigger)
const tryPayload = (jws) => { try { return jwsPayload(String(jws)); } catch { return null; } };
const ledger = (env) => env.PURCHASES.get(env.PURCHASES.idFromName('global'));
const call = async (stub, path, body) => (await stub.fetch(`https://iap${path}`, { method: 'POST', body: JSON.stringify(body || {}) })).json();
export const ledgerCall = (env, path, body) => call(ledger(env), path, body);

export async function revokePurchase(env, key, reason, profileStub) {
  const t = await ledgerCall(env, '/find', { key });
  if (!t.found) return { found: false };
  if (t.revoked) return { found: true, already: true };
  const r = await profileStub(env, t.pkey).fetch('https://profile/revoke', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, gems: t.gems }) });
  if (!r.ok) throw new Error(`profile revoke ${r.status}`);
  await ledgerCall(env, '/revoked', { key, reason });
  return { found: true, gems: t.gems };
}

// Apple's notification body: { signedPayload }. Its contents are only a hint: the transaction is fetched
// again from Apple with our key, and only a revocation Apple itself reports is acted on.
export async function appleNotification(env, body, profileStub) {
  const n = tryPayload(body?.signedPayload || '');
  if (!n?.notificationType) throw new IapError('bad_request');
  if (!['REFUND', 'REVOKE'].includes(n.notificationType)) return { ignored: n.notificationType };
  const hint = tryPayload(n.data?.signedTransactionInfo || '');
  if (!hint?.transactionId || (n.data?.bundleId && n.data.bundleId !== BUNDLE_ID)) throw new IapError('bad_request');
  const id = String(hint.transactionId);
  const t = env.IAP_MOCK === '1' && id.startsWith('mock-') ? { transactionId: id, bundleId: BUNDLE_ID, revocationDate: Date.now() } : await appleTransaction(env, id);
  if (t.bundleId !== BUNDLE_ID || !t.revocationDate) return { ignored: 'not_revoked' };
  return revokePurchase(env, `ios:${t.transactionId}`, `apple:${n.notificationType}`, profileStub);
}

// Google: purchases refunded / charged back / cancelled since the last check (the API keeps 30 days)
export async function checkGoogleVoided(env, profileStub) {
  if (!env.GOOGLE_SERVICE_ACCOUNT) return { skipped: 'google_not_configured' };
  const at = await googleAccess(env);
  const { since } = await ledgerCall(env, '/google-since', {});
  const start = Math.max(since || 0, Date.now() - 29 * 864e5), now = Date.now();
  let token = '', done = 0, seen = 0;
  for (let page = 0; page < 20; page++) {
    const q = new URLSearchParams({ startTime: String(start), endTime: String(now), maxResults: '1000', type: '0' });
    if (token) q.set('token', token);
    const r = await fetch(`https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${BUNDLE_ID}/purchases/voidedpurchases?${q}`, { headers: { authorization: `Bearer ${at}` } });
    if (!r.ok) throw new IapError(`google_${r.status}`, 502);
    const j = await r.json();
    for (const v of j.voidedPurchases || []) {
      seen++;
      const res = await revokePurchase(env, `android:${v.orderId || String(v.purchaseToken).slice(0, 64)}`, `google:${v.voidedReason ?? ''}`, profileStub);
      if (res.gems) done++;
    }
    token = j.tokenPagination?.nextPageToken || '';
    if (!token) break;
  }
  await ledgerCall(env, '/google-since', { set: now - 3600e3 });   // overlap one hour; revoking twice is a no-op
  return { seen, revoked: done };
}

// ------------------------------------------------------------------ the ledger
// One global record of every purchase already turned into gems, so the same purchase can never be
// redeemed twice (or by two profiles). Keeps only the hashed profile key and the product, plus the
// owner's totals: sales, refunds, and paid gems not used yet (資金決済法: the unused balance of paid
// currency on 3/31 and 9/30; over ¥10M needs a filing).
const jstDay = (t = Date.now()) => new Date(t + 9 * 3600e3).toISOString().slice(0, 10);
const blank = () => ({ count: 0, gems: 0, jpy: 0 });
const isTest = (e) => e !== 'Production';   // Apple: Sandbox / Xcode; Google: Test; local: Mock

export class PurchaseLedger extends DurableObject {
  async sum() { return (await this.ctx.storage.get('sum')) || { sold: blank(), test: blank(), refunded: blank(), spentPaid: 0 }; }
  async fetch(request) {
    const path = new URL(request.url).pathname, body = await request.json().catch(() => ({}));
    const st = this.ctx.storage;
    if (path === '/claim') {
      const { key, pkey, productId } = body;
      const k = `tx:${key}`, have = await st.get(k);
      if (have) return Response.json({ ok: have.pkey === pkey, again: true });
      const gems = Number(body.gems) || 0, jpy = Number(body.jpy) || 0, test = isTest(body.env);
      await st.put(k, { pkey, productId, gems, jpy, env: body.env || '', at: Date.now() });
      const s = await this.sum(), b = test ? s.test : s.sold;
      b.count++; b.gems += gems; b.jpy += jpy;
      await st.put('sum', s);
      if (!test) { const dk = `day:${jstDay()}`, d = (await st.get(dk)) || { count: 0, jpy: 0, refunds: 0, refundJpy: 0 }; d.count++; d.jpy += jpy; await st.put(dk, d); }
      return Response.json({ ok: true, again: false });
    }
    if (path === '/find') {
      const t = await st.get(`tx:${body.key}`);
      return Response.json(t ? { found: true, ...t } : { found: false });
    }
    if (path === '/revoked') {
      const k = `tx:${body.key}`, t = await st.get(k);
      if (!t || t.revoked) return Response.json({ ok: !!t });
      t.revoked = Date.now(); t.reason = String(body.reason || '').slice(0, 40);
      await st.put(k, t);
      const s = await this.sum();
      if (!isTest(t.env)) {
        s.refunded.count++; s.refunded.gems += t.gems; s.refunded.jpy += t.jpy;
        const dk = `day:${jstDay()}`, d = (await st.get(dk)) || { count: 0, jpy: 0, refunds: 0, refundJpy: 0 }; d.refunds++; d.refundJpy += t.jpy; await st.put(dk, d);
      } else { s.test.count--; s.test.gems -= t.gems; s.test.jpy -= t.jpy; }
      await st.put('sum', s);
      return Response.json({ ok: true });
    }
    if (path === '/spent') {   // paid gems used in the shop (any profile)
      const s = await this.sum(); s.spentPaid += Math.max(0, Number(body.paid) || 0); await st.put('sum', s);
      return Response.json({ ok: true });
    }
    if (path === '/google-since') {
      if (body.set) await st.put('googleSince', body.set);
      return Response.json({ since: (await st.get('googleSince')) || 0 });
    }
    if (path === '/summary') {
      const s = await this.sum(), days = Math.max(1, Math.min(120, Number(body.days) || 30));
      const rows = [];
      for (let i = days - 1; i >= 0; i--) { const day = jstDay(Date.now() - i * 864e5); rows.push({ day, ...((await st.get(`day:${day}`)) || { count: 0, jpy: 0, refunds: 0, refundJpy: 0 }) }); }
      // unused paid gems = bought − refunded − spent; valued at the average price paid per gem
      const issued = s.sold.gems - s.refunded.gems;   // test purchases left out
      const unusedGems = Math.max(0, issued - s.spentPaid);
      const perGem = s.sold.gems ? s.sold.jpy / s.sold.gems : 0;
      return Response.json({ ...s, rows, unusedGems, unusedJpy: Math.round(unusedGems * perGem), googleSince: (await st.get('googleSince')) || 0 });
    }
    return Response.json({ error: 'not found' }, { status: 404 });
  }
}
