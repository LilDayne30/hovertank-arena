// Browser test: two players, one steps out of cover, the other aims (debug camera hook) and shoots until a kill.
const { chromium } = require('playwright');
(async () => {
  const URL = process.env.URL;
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const mk = async () => { const c = await b.newContext({ viewport: { width: 640, height: 360 } }); const p = await c.newPage(); return p; };
  const A = await mk();
  await A.goto(URL + '/?debug', { waitUntil: 'domcontentloaded' }); await A.waitForFunction(() => document.getElementById('loading').classList.contains('hidden'));
  await A.click('#btn-create'); await A.waitForTimeout(1500); await A.click('#btn-invite-close');
  const inv = await A.inputValue('#invite-url');
  const B = await mk(); await B.goto(inv, { waitUntil: 'domcontentloaded' }); await B.waitForFunction(() => document.getElementById('loading').classList.contains('hidden')); await B.click('#btn-join');
  await A.waitForTimeout(2500);
    // Bob spawns diagonally opposite (the hill is in between): he slides over towards the next corner
  await B.keyboard.down('KeyD'); await B.waitForTimeout(2200); await B.keyboard.up('KeyD'); await A.waitForTimeout(1200);
  // move Alice sideways until she has a clear line of fire to Bob (cover is in the way from the spawns)
  const clear = () => A.evaluate(() => { const h = window.__ht, s = h.snaps[h.snaps.length - 1], me = h.local.t;
    const o = [...s.players.values()].find((p) => Math.hypot(p.x - me.x, p.z - me.z) > 1);
    return o ? h.los(me.x, me.y + 1.5, me.z, o.x, o.y + 1, o.z) : false; });
  for (let k = 0; k < 12 && !(await clear()); k++) { await A.keyboard.down(k < 6 ? 'KeyD' : 'KeyA'); await A.waitForTimeout(350); await A.keyboard.up(k < 6 ? 'KeyD' : 'KeyA'); await A.waitForTimeout(250); }
  console.log('clear line of fire:', await clear());
  for (let round = 0; round < 6; round++) {
    // point Alice's camera at Bob
    await A.evaluate(() => { const h = window.__ht, s = h.snaps[h.snaps.length - 1]; const me = h.local.t; const o = [...s.players.values()].find((p) => Math.hypot(p.x - me.x, p.z - me.z) > 1);
      const d = Math.hypot(o.x - me.x, o.z - me.z) + 8.5; h.setCam(Math.atan2(-(o.x - me.x), -(o.z - me.z)), Math.atan2(o.y + 0.9 - (me.y + 3.2), d)); });
    await A.keyboard.down('KeyF'); await A.waitForTimeout(700); await A.keyboard.up('KeyF'); await A.waitForTimeout(500);
  }
  await A.waitForTimeout(1500);
  const r = await A.evaluate(() => ({ board: document.getElementById('board').innerText.replace(/\n/g,' | '), shots: window.__ht.local.t.shotSeq, aim: [window.__ht.aim.x, window.__ht.aim.y, window.__ht.aim.z].map(v=>+v.toFixed(1)) }));
  const rb = await B.evaluate(() => ({ board: document.getElementById('board').innerText.replace(/\n/g,' | '), hp: window.__ht.local.hp, alive: window.__ht.local.alive, feed: document.getElementById('feed').innerText }));
  console.log('Alice', r); console.log('Bob', rb);
  await A.screenshot({ path: 'scratch/shots/hitA.png' });
  await b.close();
})();
