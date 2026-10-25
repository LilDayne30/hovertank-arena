// Browser test: emulated phone (landscape, multi-touch) - stick + fire-drag aim + jump at once, release/cancel clears input.
const { chromium, devices } = require('playwright');
(async () => {
  const URL = process.env.URL;
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await b.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: devices['iPhone 13'].userAgent });
  const p = await ctx.newPage();
  const logs = []; p.on('pageerror', e => logs.push('PAGEERROR ' + e.message));
  await p.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await p.waitForFunction(() => document.getElementById('loading').classList.contains('hidden'), null, { timeout: 60000 });
  await p.tap('#btn-create'); await p.waitForTimeout(2000); await p.tap('#btn-invite-close');
  const cdp = await ctx.newCDPSession(p);
  const T = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y, id]) => ({ x, y, id })) });
  const st = () => p.evaluate(() => { const i = window.__ht; const t = i.local.t; return { pos: t && [+t.x.toFixed(1), +t.z.toFixed(1)], v: t && +Math.hypot(t.vx, t.vz).toFixed(1), shot: t && t.shotSeq, scrollY: window.scrollY, quality: devicePixelRatio }; });
  const inp = () => p.evaluate(() => { const g = document.querySelector('#touch-layer'); return getComputedStyle(g).display; });
  console.log('touch layer display', await inp(), await st());
  // finger 1: joystick (left), finger 2: fire button held and dragged (aim)
  const fire = await p.locator('#btn-fire').boundingBox();
  const fx = fire.x + fire.width / 2, fy = fire.y + fire.height / 2;
  await T('touchStart', [[150, 250, 1]]);
  await T('touchMove', [[150, 190, 1]]);                       // push stick up = forward
  await T('touchStart', [[150, 190, 1], [fx, fy, 2]]);         // press fire with 2nd finger
  for (let i = 0; i < 10; i++) { await T('touchMove', [[150, 190, 1], [fx - i * 6, fy, 2]]); await p.waitForTimeout(60); }
  await p.waitForTimeout(800);
  const mid = await st();
  const look = await p.evaluate(() => [window.__ht.local.t.aimYaw]);
  await p.screenshot({ path: 'scratch/shots/mobile.png' });
  console.log('while holding stick+fire(drag)', mid, 'aimYaw', look);
  // jump with a 3rd finger while the others stay down
  const jb = await p.locator('#btn-jump').boundingBox();
  await T('touchStart', [[150, 190, 1], [fx - 54, fy, 2], [jb.x + 30, jb.y + 30, 3]]);
  await T('touchEnd', [[150, 190, 1], [fx - 54, fy, 2]]);
  await p.waitForTimeout(250);
  const air = await p.evaluate(() => ({ y: window.__ht.local.t.y.toFixed(2), g: window.__ht.local.t.grounded }));
  console.log('3rd finger jump', air);
  // release all
  await T('touchEnd', []);
  await p.waitForTimeout(1500);
  const after = await st();
  const flags = await p.evaluate(() => ({ fireDown: document.querySelector('#btn-fire').classList.contains('down') }));
  console.log('after release', after, flags);
  await p.waitForTimeout(1000);
  const after2 = await st();
  console.log('1s later (should be slowing, not firing)', after2);
  // touchcancel path
  await T('touchStart', [[150, 250, 4]]); await T('touchMove', [[220, 250, 4]]); await T('touchCancel', []);
  await p.waitForTimeout(1200);
  console.log('after cancel', await st());
  console.log(logs.join('\n'));
  await b.close();
})();
