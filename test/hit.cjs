// Browser test (positional, may need a re-run if a tank stops behind a wall): two players, one steps out of cover, the other aims (debug camera hook) and shoots until a kill.
const { chromium } = require('playwright');
(async () => {
  const URL = process.env.URL;
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const mk = async () => { const c = await b.newContext({ viewport: { width: 640, height: 360 } }); const p = await c.newPage(); return p; };
  const A = await mk();
  await A.goto(URL + '/?debug', { waitUntil: 'domcontentloaded' }); await A.waitForFunction(() => document.getElementById('loading').classList.contains('hidden'));
  await A.click('#tab-btn-phrase'); await A.click('#btn-create'); await A.waitForTimeout(1500); await A.click('#btn-invite-close');
  const inv = await A.inputValue('#invite-url');
  const B = await mk(); await B.goto(inv + '&debug', { waitUntil: 'domcontentloaded' }); await B.waitForFunction(() => document.getElementById('loading').classList.contains('hidden')); await B.click('#btn-join');
  await A.waitForTimeout(2500);
    // Bob spawns diagonally opposite, with the central hill in between: both drive up onto the hill
  const dist = (P) => P.evaluate(() => { const t = window.__ht.local.t; return t ? Math.hypot(t.x, t.z) : 99; });
  const drive = async (P) => {
    await P.evaluate(() => { const t = window.__ht.local.t; window.__ht.setCam(Math.atan2(t.x, t.z), 0); });   // face the centre
    await P.keyboard.down('KeyW');
    let prev = await dist(P);
    for (let i = 0; i < 60; i++) {
      await P.waitForTimeout(60);
      await P.evaluate(() => { const t = window.__ht.local.t; window.__ht.setCam(Math.atan2(t.x, t.z), 0); });
      const d = await dist(P);
      if (d < 3.5 || d > prev + 0.2) break;      // on the top, or already past the centre
      prev = d;
    }
    await P.keyboard.up('KeyW');
  };
  await drive(A); await drive(B);
  await A.keyboard.up('KeyW'); await B.keyboard.up('KeyW'); await A.waitForTimeout(1500);
  const clear = () => A.evaluate(() => { const h = window.__ht, s = h.snaps[h.snaps.length - 1], me = h.local.t;
    const o = [...s.players.values()].find((p) => Math.hypot(p.x - me.x, p.z - me.z) > 1);
    return o ? h.los(me.x, me.y + 1.5, me.z, o.x, o.y + 1, o.z) : false; });
  console.log('clear line of fire:', await clear(), await A.evaluate(() => { const h = window.__ht, s = h.snaps[h.snaps.length - 1]; return [...s.players.values()].map((p) => [p.x.toFixed(1), p.y.toFixed(1), p.z.toFixed(1)].join(',')).join(' | '); }));
  for (let round = 0; round < 10; round++) {
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
