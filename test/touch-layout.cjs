// Browser test (phone): JUMP / DRIFT at the top right by default, moving buttons in settings
// (kept across reloads, reset to default), and auto fire (on by default on touch, off on PC).
//   scratch/with-server.sh 8911 node test/touch-layout.cjs
const { chromium, devices } = require('playwright');
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) process.exitCode = 1; };
(async () => {
  const URL = process.env.URL;
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const errors = [];
  const W = 844, H = 390;
  const ctx = await b.newContext({ locale: 'ja-JP', viewport: { width: W, height: H }, isMobile: true, hasTouch: true, userAgent: devices['iPhone 13'].userAgent });
  await ctx.addInitScript(() => { try { localStorage.setItem('ht-quality', 'low'); localStorage.setItem('ht-mute', '1'); localStorage.setItem('ht-tut-later', '1'); } catch {} });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(e.message));
  const boot = async () => {
    await p.goto(URL + '/?debug', { waitUntil: 'domcontentloaded' });
    await p.waitForFunction(() => document.getElementById('loading')?.classList.contains('hidden') && !document.getElementById('prof-bar').classList.contains('hidden'), null, { timeout: 90000 });
    await p.waitForTimeout(500);
    await p.evaluate(() => { document.getElementById('btn-tutorial').click(); document.getElementById('btn-tut-start').click(); });   // the tutorial room: two targets that never shoot
    await p.waitForFunction(() => window.__ht.room && window.__ht.local.alive, null, { timeout: 30000 });
    await p.waitForTimeout(800);
  };
  const box = (id) => p.evaluate((i) => { const r = document.getElementById(i).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, id);
  await boot();
  const jump = await box('btn-jump'), drift = await box('btn-drift'), fire = await box('btn-fire');
  ok(jump.y < H * 0.4 && drift.y < H * 0.4 && jump.x > W * 0.7 && drift.x > W * 0.7, `JUMP / DRIFT at the top right by default (jump ${Math.round(jump.x)},${Math.round(jump.y)} drift ${Math.round(drift.x)},${Math.round(drift.y)})`);
  ok(fire.y > H * 0.6 && fire.x > W * 0.8, 'FIRE stays bottom right');
  const overlap = await p.evaluate(() => {
    const ids = ['btn-fire', 'btn-jump', 'btn-drift', 'btn-side', 'btn-ult', 'topright', 'tut-panel'].map((i) => document.getElementById(i)).filter((e) => e && e.offsetParent);
    const rs = ids.map((e) => [e.id, e.getBoundingClientRect()]);
    const bad = [];
    for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) { const [a, A] = rs[i], [c, B] = rs[j]; if (A.left < B.right && B.left < A.right && A.top < B.bottom && B.top < A.bottom) bad.push(`${a}/${c}`); }
    return bad;
  });
  ok(overlap.length === 0, `no buttons overlap each other or the top bar ${overlap.join(', ')}`);
  await p.screenshot({ path: 'scratch/shots/touch-default.png' });

  // settings: auto fire defaults to on with a touch screen; layout editor
  await p.evaluate(() => document.getElementById('btn-settings').click());
  ok(await p.evaluate(() => document.querySelector('#autofire-row [data-a="1"]').getAttribute('aria-pressed') === 'true'), 'touch: auto fire on by default');
  ok(await p.isVisible('#btn-layout'), 'touch: "move the buttons" in settings');
  await p.evaluate(() => document.getElementById('btn-layout').click());
  ok(await p.isVisible('#layout-bar') && await p.evaluate(() => document.body.classList.contains('layout-edit') && !window.__ht.input.enabled), 'layout editor open (game input paused)');
  await p.screenshot({ path: 'scratch/shots/touch-edit.png' });
  // drag JUMP to the left middle with the mouse (pointer events)
  await p.mouse.move(jump.x, jump.y); await p.mouse.down();
  for (let k = 1; k <= 8; k++) await p.mouse.move(jump.x + (220 - jump.x) * k / 8, jump.y + (230 - jump.y) * k / 8);
  await p.mouse.up();
  const moved = await box('btn-jump');
  ok(Math.abs(moved.x - 220) < 6 && Math.abs(moved.y - 230) < 6, `JUMP dragged to ${Math.round(moved.x)},${Math.round(moved.y)}`);
  await p.click('#btn-layout-done');
  ok(!(await p.isVisible('#layout-bar')) && await p.evaluate(() => window.__ht.input.enabled), 'done: editor closed, controls back');
  // kept after a reload
  await p.evaluate(() => { sessionStorage.clear(); });
  await boot();
  const again = await box('btn-jump');
  ok(Math.abs(again.x - 220) < 8 && Math.abs(again.y - 230) < 8, `position kept after a reload (${Math.round(again.x)},${Math.round(again.y)})`);
  // the moved button still works: tapping it jumps
  const j0 = await p.evaluate(() => window.__ht.local.t.y);
  await p.touchscreen.tap(again.x, again.y);
  await p.waitForTimeout(250);
  ok((await p.evaluate(() => window.__ht.local.t.y)) > j0 + 0.3, 'tapping the moved JUMP button jumps');
  // reset to default
  await p.evaluate(() => document.getElementById('btn-settings').click());
  await p.evaluate(() => document.getElementById('btn-layout').click());
  await p.click('#btn-layout-reset'); await p.click('#btn-layout-done');
  const back = await box('btn-jump');
  ok(Math.abs(back.x - jump.x) < 2 && Math.abs(back.y - jump.y) < 2 && await p.evaluate(() => !localStorage.getItem('ht-touch-layout')), 'reset: back to the default place');

  // auto fire: aim at a target without touching FIRE -> shots go out; off -> nothing
  const aimAtTarget = () => p.evaluate(() => {
    const h = window.__ht, me = h.local.t, s = h.snaps[h.snaps.length - 1];
    let best = null, bd = 1e9;
    for (const o of s.players.values()) { if (!o.alive) continue; const d = Math.hypot(o.x - me.x, o.z - me.z); if (d > 1 && d < bd) { bd = d; best = o; } }
    if (!best) return;   // both targets down for a moment
    const dx = best.x - me.x, dz = best.z - me.z, d = Math.hypot(dx, dz);
    h.setCam(Math.atan2(-dx, -dz), Math.atan2(best.y + 0.9 - (me.y + 3.2), d + 8.5));
  });
  await p.waitForTimeout(2500);   // spawn shields gone
  const s0 = await p.evaluate(() => window.__ht.local.t.shotSeq);
  for (let i = 0; i < 20; i++) { await aimAtTarget(); await p.waitForTimeout(100); }
  const s1 = await p.evaluate(() => window.__ht.local.t.shotSeq);
  ok(s1 > s0, `auto fire: ${s1 - s0} shots while the crosshair was on a target (FIRE not touched)`);
  await p.screenshot({ path: 'scratch/shots/touch-autofire.png' });
  await p.evaluate(() => { document.getElementById('btn-settings').click(); document.querySelector('#autofire-row [data-a="0"]').click(); document.getElementById('btn-settings-close').click(); });
  const s2 = await p.evaluate(() => window.__ht.local.t.shotSeq);
  for (let i = 0; i < 15; i++) { await aimAtTarget(); await p.waitForTimeout(100); }
  ok((await p.evaluate(() => window.__ht.local.t.shotSeq)) === s2, 'auto fire off: no shots');
  // looking at the sky / ground: no shots even when on
  await p.evaluate(() => { document.getElementById('btn-settings').click(); document.querySelector('#autofire-row [data-a="1"]').click(); document.getElementById('btn-settings-close').click(); window.__ht.setCam(0, -0.6); });
  const s3 = await p.evaluate(() => window.__ht.local.t.shotSeq);
  await p.waitForTimeout(1500);
  ok((await p.evaluate(() => window.__ht.local.t.shotSeq)) === s3, 'auto fire does not shoot at nothing');

  // PC: auto fire off by default, no layout button
  const pc = await (await b.newContext({ locale: 'ja-JP', viewport: { width: 1280, height: 720 } })).newPage();
  await pc.addInitScript(() => { try { localStorage.setItem('ht-tut-later', '1'); } catch {} });
  await pc.goto(URL + '/?debug', { waitUntil: 'domcontentloaded' });
  await pc.waitForFunction(() => document.getElementById('loading')?.classList.contains('hidden'), null, { timeout: 90000 });
  ok(await pc.evaluate(() => document.querySelector('#autofire-row [data-a="0"]').getAttribute('aria-pressed') === 'true' && getComputedStyle(document.getElementById('btn-layout').parentElement).display === 'none'), 'PC: auto fire off by default, no button-layout row');
  ok(errors.length === 0, `no page errors ${errors.slice(0, 3).join(' / ')}`);
  await b.close();
})();
