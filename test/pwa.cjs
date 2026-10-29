// PWA check: manifest + icons, installability (Chrome's own check via CDP), service worker
// registration and precache, offline relaunch from cache, and that online play still works with
// the service worker in control (it must not touch /api or the WebSocket).
const { chromium } = require('playwright');
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) process.exitCode = 1; };
(async () => {
  const base = process.env.URL;
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await b.newContext({ locale: 'ja-JP', viewport: { width: 960, height: 540 } });
  const p = await ctx.newPage({ locale: 'ja-JP' });
  const errs = []; p.on('pageerror', (e) => errs.push(e.message));

  // manifest and icons
  const man = await p.request.get(`${base}/manifest.webmanifest`);
  const mj = await man.json();
  ok(man.ok(), `manifest ${man.status()} ${man.headers()['content-type']}`);
  for (const ic of mj.icons) { const r = await p.request.get(base + ic.src); ok(r.ok() && /png/.test(r.headers()['content-type']), `icon ${ic.src} ${ic.sizes} ${ic.purpose} -> ${r.status()}`); }

  await p.goto(base, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => window.__ht && window.__ht.readyAt, null, { timeout: 30000 });
  const reg = await p.evaluate(async () => { const r = await navigator.serviceWorker.ready; return r.active && r.active.scriptURL; });
  ok(!!reg, `service worker active: ${reg}`);

  // Chrome's installability verdict
  const cdp = await ctx.newCDPSession(p);
  const am = await cdp.send('Page.getAppManifest');
  ok(!am.errors.length, `manifest parsed by Chrome (errors: ${JSON.stringify(am.errors)})`);
  const ie = await cdp.send('Page.getInstallabilityErrors');
  ok(!ie.installabilityErrors.length, `installable (errors: ${JSON.stringify(ie.installabilityErrors.map((e) => e.errorId))})`);

  // precache contents
  await p.waitForTimeout(1500);
  const cached = await p.evaluate(async () => { const out = {}; for (const k of await caches.keys()) out[k] = (await (await caches.open(k)).keys()).length; return out; });
  console.log('      caches:', JSON.stringify(cached));
  ok(Object.values(cached).some((n) => n >= 10), 'build precached');

  // warm start: reload while controlled -> assets come from the SW, not the network
  const net = [];
  const onReq = (r) => net.push(r);
  p.on('request', onReq);
  const t0 = Date.now();
  await p.reload({ waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => window.__ht && window.__ht.readyAt, null, { timeout: 30000 });
  p.off('request', onReq);
  const fromSw = (await Promise.all(net.map(async (r) => { const res = await r.response(); return res && res.fromServiceWorker(); }))).filter(Boolean).length;
  ok(fromSw >= 5, `warm start: ${fromSw}/${net.length} requests answered by the service worker, ready in ${Date.now() - t0} ms`);
  ok(await p.evaluate(() => !!navigator.serviceWorker.controller), 'page controlled by the service worker');

  // offline relaunch
  await ctx.setOffline(true);
  await p.reload({ waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => window.__ht && window.__ht.readyAt, null, { timeout: 30000 });
  await p.waitForTimeout(800);
  const off = await p.evaluate(() => ({ msg: !document.getElementById('offline').classList.contains('hidden'), dis: document.getElementById('btn-quick').disabled }));
  ok(off.msg && off.dis, `offline: page + 3D stage loaded from cache, offline notice shown, match buttons disabled`);
  await p.screenshot({ path: 'scratch/shots/pwa_offline.png' });
  await ctx.setOffline(false);
  await p.evaluate(() => window.dispatchEvent(new Event('online')));   // emulation does not fire it reliably
  await p.waitForTimeout(1000);
  ok(await p.evaluate(() => document.getElementById('offline').classList.contains('hidden') && !document.getElementById('btn-quick').disabled), 'back online: notice hidden, buttons enabled');

  // online play through the controlled page
  await p.click('#btn-quick');
  await p.waitForFunction(() => window.__ht.room && window.__ht.room.roomId && window.__ht.local && window.__ht.snaps.length > 5, null, { timeout: 15000 }).catch(() => {});
  ok(await p.evaluate(() => !!(window.__ht.room && window.__ht.snaps.length > 5)), `quick match joined with SW in control (room ${await p.evaluate(() => window.__ht.room && window.__ht.room.roomId)})`);
  await p.screenshot({ path: 'scratch/shots/pwa_lobby_online.png' });
  ok(!errs.length, `no page errors ${JSON.stringify(errs)}`);
  await b.close();
})();
