const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const A = await (await b.newContext({ viewport: { width: 960, height: 540 } })).newPage();
  const errs = []; A.on('pageerror', (e) => errs.push(e.message));
  await A.goto(process.env.URL + '/?debug'); await A.waitForFunction(() => window.__ht && window.__ht.readyAt, null, { timeout: 30000 }); await A.waitForSelector('#prof-bar:not(.hidden)');
  await A.fill('#name', 'Alice'); await A.click('#btn-create'); await A.waitForTimeout(1200);
  const rid = await A.evaluate(() => window.__ht.room.roomId);
  await A.click('#btn-invite-close').catch(() => {});
  // bot opponent
  const ws = new WebSocket(`${process.env.URL.replace(/^http/, 'ws')}/api/rooms/${rid}/ws?name=Bot`);
  let seq = 0; const timer = setInterval(() => { try { ws.send(JSON.stringify(['i', [{ seq: ++seq, mx: 0, mz: 0, ay: 0, ap: 0, j: false, d: false, f: false }, { seq: ++seq, mx: 0, mz: 0, ay: 0, ap: 0, j: false, d: false, f: false }]])); } catch {} }, 66);
  await A.bringToFront();
  let last;
  for (let i = 0; i < 6; i++) { const k = i % 2 ? 'KeyS' : 'KeyW'; await A.keyboard.down(k); await A.waitForTimeout(1400); await A.keyboard.up(k); last = await A.evaluate(() => { const s = window.__ht.snaps.at(-1); const me = s.players.get([...s.players.keys()].find((k) => window.__ht.local.t && Math.abs(s.players.get(k).x - window.__ht.local.t.x) < 3)); return me && [me.x.toFixed(1), me.z.toFixed(1)]; }); console.log('server pos', last); }
  await A.waitForSelector('#result:not(.hidden)', { timeout: 30000 });
  await A.waitForFunction(() => document.getElementById('result-xp').textContent.length > 0, null, { timeout: 10000 });
  await A.waitForTimeout(400);
  await A.screenshot({ path: 'scratch/shots/xp_result.png' });
  console.log('xp text:', (await A.innerText('#result-xp')).replace(/\n/g, ' | '));
  console.log('bar:', (await A.innerText('#prof-bar').catch(() => '')).replace(/\n/g, ' | '));
  clearInterval(timer); ws.close();
  console.log('errors', errs);
  await b.close();
})();
