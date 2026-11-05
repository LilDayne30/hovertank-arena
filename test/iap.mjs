// Server: app origins (CORS), gem purchases (mock store), double-spend protection, shop, data deletion,
// name filter.   IAP_MOCK=1 scratch/with-server.sh 8930 node test/iap.mjs
import { spend, accountToken, GEM_PACKS } from '../shared/shop.js';
import { sanitizeName } from '../shared/game.js';
const URL = process.env.URL;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) process.exitCode = 1; };
const api = async (path, { token, body, origin, method } = {}) => {
  const r = await fetch(URL + path, { method: method || (body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(origin ? { origin } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, headers: r.headers, data: await r.json().catch(() => null) };
};
const P1 = GEM_PACKS[0], P2 = GEM_PACKS[1];
const RUN = Date.now().toString(36);   // the local server keeps its data between runs

// CORS for the apps
const pre = await fetch(URL + '/api/profile', { method: 'OPTIONS', headers: { origin: 'capacitor://localhost', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization, content-type' } });
ok(pre.status === 204 && pre.headers.get('access-control-allow-origin') === 'capacitor://localhost' && /authorization/.test(pre.headers.get('access-control-allow-headers')), 'iOS app origin: preflight allowed');
const a = await api('/api/profile/new', { body: {}, origin: 'https://localhost' });
ok(a.status === 200 && a.headers.get('access-control-allow-origin') === 'https://localhost', 'Android app origin: profile created, CORS header present');
const other = await fetch(URL + '/api/profile', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } });
ok(other.status === 403, 'other origins: preflight refused');
const A = a.data.token, B = (await api('/api/profile/new', { body: {} })).data.token;
ok(a.data.profile.gems?.total === 0, `new profile has 0 gems: ${JSON.stringify(a.data.profile.gems)}`);

// purchases (mock store)
let r = await api('/api/profile/iap', { token: A, body: { platform: 'ios', productId: P1.id, transactionId: `mock-${RUN}-1001` } });
ok(r.status === 200 && r.data.credited === P1.gems && r.data.view.gems.paid === P1.gems, `iOS purchase: +${r.data?.credited} paid gems`);
r = await api('/api/profile/iap', { token: A, body: { platform: 'ios', productId: P1.id, transactionId: `mock-${RUN}-1001` } });
ok(r.status === 200 && r.data.credited === 0 && r.data.view.gems.paid === P1.gems, 'same transaction again: no extra gems (retry after a lost reply is safe)');
r = await api('/api/profile/iap', { token: B, body: { platform: 'ios', productId: P1.id, transactionId: `mock-${RUN}-1001` } });
ok(r.status === 409 && r.data.error === 'used', 'another profile cannot redeem the same transaction');
r = await api('/api/profile/iap', { token: A, body: { platform: 'android', productId: P2.id, purchaseToken: `mock-tok-${RUN}` } });
ok(r.status === 200 && r.data.view.gems.paid === P1.gems + P2.gems, `Android purchase: balance ${r.data?.view?.gems?.total}`);
r = await api('/api/profile/iap', { token: A, body: { platform: 'ios', productId: 'com.lildayne.hovertank.free_money', transactionId: `mock-${RUN}-2` } });
ok(r.status === 400, 'unknown product refused');
r = await api('/api/profile/iap', { token: A, body: { platform: 'ios', productId: P1.id, transactionId: '2000000123' } });
ok(r.status === 503 && r.data.error === 'apple_not_configured', `real transaction without Apple keys: ${r.status} ${r.data?.error}`);
r = await api('/api/profile/iap', { body: { platform: 'ios', productId: P1.id, transactionId: `mock-${RUN}-3` } });
ok(r.status === 401, 'no profile token: refused');

// refunds: Apple notification (mock transaction) takes the gems back once; sales totals for the owner
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jws = (o) => `${b64({ alg: 'ES256' })}.${b64(o)}.sig`;
const before = (await api('/api/profile', { token: A })).data.gems.paid;
const note = { signedPayload: jws({ notificationType: 'REFUND', data: { bundleId: 'com.lildayne.hovertank', signedTransactionInfo: jws({ transactionId: `mock-${RUN}-1001` }) } }) };
r = await api('/api/iap/apple', { body: note });
ok(r.status === 200 && r.data.gems === P1.gems, `Apple refund notification: ${JSON.stringify(r.data)}`);
ok((await api('/api/profile', { token: A })).data.gems.paid === before - P1.gems, 'refunded gems taken back from the buyer');
r = await api('/api/iap/apple', { body: note });
ok(r.status === 200 && r.data.already, 'the same refund again: nothing more taken');
r = await api('/api/iap/apple', { body: { signedPayload: jws({ notificationType: 'TEST' }) } });
ok(r.status === 200 && r.data.ignored === 'TEST', 'other notification types are acknowledged and ignored');
r = await api('/api/iap/apple', { body: { signedPayload: 'garbage' } });
ok(r.status === 400, 'malformed notification refused');
r = await api('/api/iap/apple', { body: { signedPayload: jws({ notificationType: 'REFUND', data: { signedTransactionInfo: jws({ transactionId: 'mock-never-bought' }) } }) } });
ok(r.status === 200 && r.data.found === false, 'refund for an unknown purchase: nothing happens');
r = await api('/api/admin/summary?days=7', { token: 'local-test-key' });
ok(r.status === 200 && r.data.sales && r.data.sales.test.count >= 1 && r.data.sales.rows.length === 7 && 'unusedJpy' in r.data.sales, `owner dashboard has sales figures: test purchases ${r.data?.sales?.test?.count}`);
r = await api('/api/admin/iap-check', { token: 'local-test-key', body: {} });
ok(r.status === 200 && r.data.skipped === 'google_not_configured', 'Google refund check: skipped until the key is set');

// shop: nothing for sale yet
r = await api('/api/profile/shop', { token: A, body: { key: 'paint:gold' } });
ok(r.status === 400 && r.data.error === 'not_for_sale', 'shop: items that are not for sale cannot be bought with gems');
// spending order: free gems first
const s = spend({ paid: 100, free: 30 }, 50);
ok(s.wallet.free === 0 && s.wallet.paid === 80 && s.took.free === 30 && s.took.paid === 20, 'spending uses free gems first, then paid');
ok(spend({ paid: 10, free: 0 }, 50) === null, 'not enough gems: refused');
const t1 = await accountToken('abc'), t2 = await accountToken('abc');
ok(t1 === t2 && /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(t1), `account token is a stable UUID: ${t1}`);

// data deletion
r = await api('/api/profile/delete', { token: A, body: {} });
ok(r.status === 200 && r.data.deleted, 'delete: done');
r = await api('/api/profile', { token: A });
ok(r.status === 200 && r.data.gems.total === 0 && r.data.xp === 0, 'after deletion the old key only finds an empty profile');

// names
ok(sanitizeName('ふぁっく') === '' && sanitizeName('シネマ好き') === 'シネマ好き' && sanitizeName('HoverAce') === 'HoverAce', 'name filter: bad words refused, ordinary names kept');
