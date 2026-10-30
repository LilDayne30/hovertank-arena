// Browser test: ?s= source tags (X post links) are counted per tag on the owner's dashboard.
//   MATCH_SECONDS=6 ADMIN_KEY_HASH=<sha256 of local-test-key> scratch/with-server.sh 8872 node test/sources.cjs
const { chromium } = require('playwright');
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) process.exitCode = 1; };
(async () => {
  const URL = process.env.URL, KEY = 'local-test-key';
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const errors = [];
  const tag = `t${Date.now() % 100000}`;
  const open = async (ctx, q) => {
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(URL + '/' + q, { waitUntil: 'domcontentloaded' });
    await p.waitForFunction(() => document.getElementById('loading')?.classList.contains('hidden') && localStorage.getItem('ht-pid'), null, { timeout: 60000 });
    await p.waitForTimeout(800);
    return p;
  };
  const mk = () => b.newContext({ viewport: { width: 800, height: 450 }, locale: 'ja-JP' });
  const summary = async (p) => p.evaluate(async (k) => (await fetch('/api/admin/summary?days=7', { headers: { authorization: `Bearer ${k}` } })).json(), KEY);
  const row = (s, src) => (s.sources || []).find((r) => r.src === src);

  // A arrives through the "a" link, B through the "b" link, C through a junk tag
  const cA = await mk(), cB = await mk(), cC = await mk();
  const A = await open(cA, `?s=${tag}a&debug`);
  ok(!(await A.evaluate(() => location.search.includes('s='))) && (await A.evaluate(() => location.search)) === '?debug', `tag removed from the address bar, other params kept: "${await A.evaluate(() => location.search)}"`);
  const B = await open(cB, `?s=${tag}B`);   // upper case is folded to lower case
  await open(cC, '?s=<script>');
  let s = await summary(A);
  ok(row(s, `${tag}a`)?.visits === 1 && row(s, `${tag}a`)?.fresh === 1 && row(s, `${tag}a`)?.players === 0, `A counted as a first-time visit for ${tag}a: ${JSON.stringify(row(s, `${tag}a`))}`);
  ok(row(s, `${tag}b`)?.visits === 1, `B counted for ${tag}b`);
  ok(!(s.sources || []).some((r) => /script/.test(r.src)), 'junk tag ignored');

  // A opens the same link again: still one device
  await A.goto(URL + `/?s=${tag}a`, { waitUntil: 'domcontentloaded' });
  await A.waitForFunction(() => document.getElementById('loading')?.classList.contains('hidden'));
  await A.waitForTimeout(800);
  s = await summary(A);
  ok(row(s, `${tag}a`).visits === 1 && row(s, `${tag}a`).fresh === 1, 'reopening the same link does not count twice');

  // A plays one match (private room with a CPU) -> counted as "played" for its tag
  await A.click('#tab-btn-phrase'); await A.fill('#phrase', `src${tag}`);
  await A.click('#lobby-rules [data-k="bots"][data-v="1"]');
  await A.click('#btn-create'); await A.waitForTimeout(1200); await A.click('#btn-invite-close').catch(() => {});
  await A.waitForFunction(() => !document.getElementById('result').classList.contains('hidden'), null, { timeout: 40000 });
  await A.waitForTimeout(1500);
  s = await summary(A);
  ok(row(s, `${tag}a`).players === 1 && row(s, `${tag}a`).matches === 1, `after one match: ${JSON.stringify(row(s, `${tag}a`))}`);
  ok(row(s, `${tag}b`).players === 0, 'B (no match) still 0 players');

  // the dashboard shows the table
  const D = await cA.newPage();
  await D.addInitScript((k) => { try { localStorage.setItem('ht-admin-key', k); } catch {} }, KEY);
  await D.goto(URL + '/admin.html');
  await D.waitForFunction((t) => document.getElementById('sources')?.innerText.includes(t), `${tag}a`, { timeout: 15000 });
  const txt = await D.textContent('#sources');
  ok(txt.includes(`${tag}a`) && txt.includes(`${tag}b`) && txt.includes('100%'), 'dashboard lists both tags with the played rate');
  await D.setViewportSize({ width: 1100, height: 900 });
  await D.waitForTimeout(500); await D.screenshot({ path: 'scratch/shots/admin-sources.png', fullPage: true });
  ok(errors.length === 0, `no page errors ${errors.slice(0, 3).join(' / ')}`);
  await b.close();
})();
