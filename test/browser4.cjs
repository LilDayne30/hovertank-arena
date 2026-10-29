// End-to-end test with real browsers: 4 independent browser contexts join one room through the
// invite URL, one drives/drifts/jumps, one shoots; then a 5th client must be refused (room full),
// and one client is closed abruptly to check the disconnect handling.
//   URL=https://your-app.onrender.com node test/browser4.cjs
const { chromium } = require('playwright');
const URL = process.env.URL || 'http://localhost:2567';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const errors = [];
  const open = async (name, url) => {
    const ctx = await b.newContext({ viewport: { width: 480, height: 270 } });   // separate storage = separate player
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
    const t0 = Date.now();
    await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await p.waitForFunction(() => document.getElementById('loading').classList.contains('hidden'), null, { timeout: 120000 });
    const loadMs = Date.now() - t0;
    await p.evaluate(() => { try { localStorage.setItem('ht-quality', 'low'); } catch {} });
    await p.fill('#name', name);
    return { ctx, p, name, loadMs };
  };
  const state = (c) => c.p.evaluate(() => {
    const h = window.__ht, s = h.snaps[h.snaps.length - 1];
    return { k: s?.k, n: s?.players.size, players: s ? [...s.players.values()].map((p) => [p.id, p.x, p.z, p.hp, p.kills]) : [], me: h.local.t && [h.local.t.x, h.local.t.z], board: document.getElementById('board').innerText.replace(/\n/g, ' | '), corr: h.stats.corrections };
  });

  const A = await open('Alice', URL);
  await A.p.click('#tab-btn-phrase'); await A.p.click('#btn-create');
  await A.p.waitForFunction(() => /[?&]r=/.test(location.search), null, { timeout: 60000 });
  const invite = await A.p.inputValue('#invite-url');
  await A.p.click('#btn-invite-close');
  console.log('invite URL:', invite);
  const others = [];
  for (const n of ['Bob', 'Carol', 'Dave']) { const c = await open(n, invite); await c.p.click('#btn-join'); others.push(c); }
  const all = [A, ...others];
  await sleep(4000);
  console.log('page load times (ms):', all.map((c) => `${c.name}=${c.loadMs}`).join(' '));
  const s1 = await Promise.all(all.map(state));
  console.log('players seen by each client:', s1.map((s) => s.n));
  console.log('scoreboards:', s1.map((s) => s.board));

  // Bob drives with drift + jump, Alice holds fire (her spawn faces Bob's diagonal spawn)
  const [B] = others;
  await B.p.keyboard.down('KeyD');
  await A.p.keyboard.down('KeyF');
  for (let i = 0; i < 6; i++) { await B.p.keyboard.down('ShiftLeft'); await sleep(400); await B.p.keyboard.press('Space'); await B.p.keyboard.up('ShiftLeft'); await sleep(400); }
  await B.p.keyboard.up('KeyD');
  await sleep(3000);
  await A.p.keyboard.up('KeyF');
  await sleep(1500);

  // compare the same server tick across clients
  const s2 = await Promise.all(all.map((c) => c.p.evaluate(() => {
    const h = window.__ht; return h.snaps.map((s) => [s.k, [...s.players.values()].map((p) => `${p.id}:${p.x},${p.z},${p.hp},${p.kills}`).join(';')]);
  })));
  const common = s2[0].map(([k]) => k).filter((k) => s2.every((list) => list.some(([kk]) => kk === k)));
  const k = common[common.length - 1];
  const same = s2.every((list) => list.find(([kk]) => kk === k)[1] === s2[0].find(([kk]) => kk === k)[1]);
  console.log(`tick ${k}: all 4 clients received identical player state ->`, same);
  const s3 = await Promise.all(all.map(state));
  console.log('scoreboards after shooting:', s3.map((s) => s.board));
  console.log('Bob local prediction corrections:', s3[1].corr, ' Alice:', s3[0].corr);
  const shotsHit = await A.p.evaluate(() => window.__ht.local.t?.shotSeq);
  console.log('Alice shots fired:', shotsHit);

  // 5th player must be refused
  const E = await open('Eve', invite);
  await E.p.click('#btn-join');
  await E.p.waitForFunction(() => document.getElementById('lobby-status').textContent.length > 0, null, { timeout: 30000 });
  console.log('5th client message:', await E.p.textContent('#lobby-status'));
  await E.ctx.close();

  // abrupt disconnect of Dave (close the browser context without leaving)
  const D = others[2];
  await D.ctx.close();
  await sleep(2500);
  console.log('after Dave closed his tab, Alice board:', (await state(A)).board);
  await sleep(21000);
  console.log('after the 20 s reconnection window, Alice board:', (await state(A)).board);

  // Carol reloads her tab -> should reconnect into the same seat via the stored token
  const C = others[1];
  const before = (await state(C)).players.length;
  await C.p.reload({ waitUntil: 'domcontentloaded' });
  await C.p.waitForFunction(() => window.__ht && window.__ht.room, null, { timeout: 60000 });
  await sleep(2500);
  console.log('Carol after reload: players in room', (await state(C)).n, '(before', before, ') board:', (await state(C)).board);

  console.log('page errors:', errors.length ? errors : 'none');
  await b.close();
})().catch((e) => { console.error(e); process.exit(1); });
