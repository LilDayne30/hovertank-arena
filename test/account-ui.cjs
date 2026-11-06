// Browser test: "アカウント連携" with a stand-in for Google's button (mock tokens, AUTH_MOCK server).
//   AUTH_MOCK=1 IAP_MOCK=1 scratch/with-server.sh 8952 node test/account-ui.cjs
const { chromium } = require('playwright');
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) process.exitCode = 1; };
const URL = process.env.URL, SUB = `ui-${Date.now().toString(36)}`;
// pretend Google Identity Services: renderButton draws a button that "signs in" as window.__sub
const fakeGis = (sub) => {
  try { localStorage.setItem('ht-tut-later', '1'); localStorage.setItem('ht-mute', '1'); localStorage.setItem('ht-quality', 'low'); } catch {}
  const b64 = (o) => btoa(unescape(encodeURIComponent(JSON.stringify(o)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  let opts = null;
  window.google = { accounts: { id: {
    initialize: (o) => { opts = o; },
    renderButton: (el) => { const b = document.createElement('button'); b.id = 'fake-gsi'; b.textContent = 'Google'; b.onclick = () => opts.callback({ credential: `${b64({ alg: 'mock' })}.${b64({ iss: 'https://accounts.google.com', aud: opts.client_id, sub, exp: Math.floor(Date.now() / 1000) + 600, nonce: opts.nonce })}.x` }); el.appendChild(b); },
  } } };
  document.addEventListener('DOMContentLoaded', () => { const s = document.createElement('script'); s.src = 'https://accounts.google.com/gsi/client'; s.type = 'text/plain'; document.head.appendChild(s); });
};
(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const errors = [];
  const page = async () => {
    const c = await b.newContext({ locale: 'ja-JP', viewport: { width: 1280, height: 720 } });
    await c.addInitScript(fakeGis, SUB);
    await c.route('https://accounts.google.com/**', (r) => r.fulfill({ status: 200, body: '' }));
    const p = await c.newPage(); p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(URL + '/', { waitUntil: 'domcontentloaded' });
    await p.waitForFunction(() => document.getElementById('loading')?.classList.contains('hidden') && localStorage.getItem('ht-pid'), null, { timeout: 90000 });
    return p;
  };
  const openPanel = async (p) => { await p.evaluate(() => document.getElementById('btn-transfer').click()); await p.waitForSelector('#acct-sec:not(.hidden) #fake-gsi', { timeout: 20000 }); };

  // device A: link
  const A = await page();
  await openPanel(A);
  ok(/まだ連携していません/.test(await A.textContent('#acct-status')), 'not linked yet');
  await A.click('#fake-gsi');
  await A.waitForFunction(() => /Google/.test(document.getElementById('acct-status').textContent) && /連携しました/.test(document.getElementById('acct-msg').textContent), null, { timeout: 15000 });
  ok(await A.isHidden('#g-btn'), 'linked: status shows Google, the button is gone');
  const tokA = await A.evaluate(() => localStorage.getItem('ht-pid'));
  await A.screenshot({ path: 'scratch/shots/account-linked.png' });

  // device B: a fresh guest signs in -> switched to A's profile (nothing to lose, no question)
  const B = await page();
  ok((await B.evaluate(() => localStorage.getItem('ht-pid'))) !== tokA, 'device B starts with its own guest profile');
  await openPanel(B);
  await B.click('#fake-gsi');
  await B.waitForFunction((t) => localStorage.getItem('ht-pid') === t, tokA, { timeout: 15000 });
  await B.waitForLoadState('domcontentloaded');
  ok(true, 'device B signed in to the same profile');

  // device C has progress (gems): asked before switching
  const C = await page();
  await C.evaluate(async () => {
    const tok = localStorage.getItem('ht-pid');
    await fetch('/api/profile/iap', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` }, body: JSON.stringify({ platform: 'ios', productId: 'com.lildayne.hovertank.gem_pack_1', transactionId: `mock-ui-${Date.now()}` }) });
  });
  await C.reload({ waitUntil: 'domcontentloaded' });
  await C.waitForFunction(() => document.getElementById('loading')?.classList.contains('hidden'), null, { timeout: 90000 });
  await openPanel(C);
  await C.click('#fake-gsi');
  await C.waitForSelector('#acct-conflict:not(.hidden)', { timeout: 15000 });
  const q = await C.textContent('#acct-conflict-msg');
  ok(/ジェム100/.test(q) && /戻れなくなります/.test(q), `conflict question shown: ${q.slice(0, 60)}…`);
  await C.screenshot({ path: 'scratch/shots/account-conflict.png' });
  await C.click('#btn-acct-switch');
  await C.waitForFunction((t) => localStorage.getItem('ht-pid') === t, tokA, { timeout: 15000 });
  ok(true, 'switched after the player agreed');

  // unlink on A (two taps)
  await A.evaluate(() => document.querySelector('[data-unlink="google"]').click());
  await A.evaluate(() => document.querySelector('[data-unlink="google"]').click());
  await A.waitForFunction(() => /連携していません/.test(document.getElementById('acct-status').textContent), null, { timeout: 15000 });
  ok(await A.isVisible('#g-btn'), 'unlinked: the Google button is back');
  ok(errors.length === 0, `no page errors ${errors.slice(0, 2).join(' / ')}`);
  await b.close();
})();
