// Browser test: the tutorial from the lobby suggestion to the reward.
//   scratch/with-server.sh 8881 node test/tutorial-ui.cjs     (LANG_EN=1 for the English pass)
const { chromium } = require('playwright');
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) process.exitCode = 1; };
const EN = !!process.env.LANG_EN;
(async () => {
  const URL = process.env.URL;
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const errors = [];
  const c = await b.newContext({ viewport: { width: 1280, height: 720 }, locale: EN ? 'en-US' : 'ja-JP' });
  const p = await c.newPage();
  await p.addInitScript(() => { try { localStorage.setItem('ht-quality', 'low'); localStorage.setItem('ht-mute', '1'); } catch {} });
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(URL + '/?debug', { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => document.getElementById('loading')?.classList.contains('hidden') && !document.getElementById('prof-bar').classList.contains('hidden'), null, { timeout: 90000 });
  await p.waitForTimeout(800);
  ok(await p.isVisible('#tut-pop'), 'first visit: a popup suggests the tutorial');
  ok((await p.$$('#tut-pop-rew .rw-card')).length === 3 && (await p.$$('#tut-pop-rew img')).length === 2 && await p.evaluate(() => [...document.querySelectorAll('#tut-pop-rew img')].every((i) => i.complete && i.naturalWidth > 0)), `reward cards with pictures: ${await p.textContent('#tut-pop-rew')}`);
  ok(/報酬|Reward/.test(await p.textContent('#tut-pop .rw-ribbon')), `labelled as a reward: ${await p.textContent('#tut-pop .rw-ribbon')}`);
  ok(await p.isVisible('#tut-badge'), 'tutorial button carries the reward badge');
  await p.screenshot({ path: `scratch/shots/tut-lobby${EN ? '-en' : ''}.png` });

  // garage: the reward items are shown locked with how to get them
  await p.evaluate(() => document.getElementById('tut-pop').classList.add('hidden'));
  await p.click('#btn-garage'); await p.waitForTimeout(300);
  const lockTxt = await p.evaluate(() => [...document.querySelectorAll('#garage .it.locked small')].map((e) => e.textContent).find((t) => /チュートリアル|tutorial/i.test(t)) || '');
  ok(!!lockTxt, `garage shows the unlock condition: ${lockTxt}`);
  await p.evaluate(() => document.querySelector('#garage button[id*="close"], #garage .x-close, #g-close')?.click());
  await p.keyboard.press('Escape'); await p.waitForTimeout(300);
  await p.evaluate(() => { for (const id of ['garage']) document.getElementById(id).classList.add('hidden'); document.getElementById('lobby').classList.remove('hidden'); });

  await p.click('#btn-tutorial');
  ok(await p.isVisible('#tut-pop'), 'the 🎓 button shows the rewards first');
  await p.click('#btn-tut-start');
  await p.waitForFunction(() => window.__ht.room && window.__ht.local.alive && !document.getElementById('tut-panel').classList.contains('hidden'), null, { timeout: 30000 });
  await p.evaluate(() => { Object.defineProperty(document, 'pointerLockElement', { get: () => document.getElementById('game'), configurable: true }); window.__ht.input.enabled = true; });
  ok((await p.textContent('#tut-no')) === '1/6', `step panel: ${await p.textContent('#tut-no')} ${await p.textContent('#tut-title')} — ${await p.textContent('#tut-text')}`);
  ok(await p.evaluate(() => getComputedStyle(document.getElementById('board')).display === 'none' && document.body.classList.contains('tutorial')), 'scoreboard and timer hidden in the tutorial');
  await p.screenshot({ path: `scratch/shots/tut-step1${EN ? '-en' : ''}.png` });

  // a tiny autopilot: drive, then aim at the nearest target and fire; jump / sidearm / special when asked
  const stepNo = () => p.evaluate(() => (!document.getElementById('tut-done').classList.contains('hidden') ? 7 : Number(document.getElementById('tut-no').textContent.split('/')[0]) || 0));
  const drive = (on) => p.evaluate((v) => { window.__ht.input.moveY = v ? 1 : 0; }, on);
  const aimFire = (fire) => p.evaluate((f) => {
    const h = window.__ht, me = h.local.t, s = h.snaps[h.snaps.length - 1];
    if (!me || !s) return;
    let best = null, bd = 1e9;
    for (const o of s.players.values()) { if (!o.alive) continue; const d = Math.hypot(o.x - me.x, o.z - me.z); if (d > 1 && d < bd) { bd = d; best = o; } }
    if (!best) return;
    const dx = best.x - me.x, dz = best.z - me.z, d = Math.hypot(dx, dz);
    h.setCam(Math.atan2(-dx, -dz), Math.atan2(best.y + 0.9 - (me.y + 3.2), d + 8.5));
    h.input.fire = f;
  }, fire);
  const shots = {};
  await drive(true);
  for (let i = 0; i < 400; i++) {
    const n = await stepNo();
    if (n >= 7 || n === 0 && i > 5) break;
    shots[n] = (shots[n] || 0) + 1;
    if (n === 1) { await p.evaluate(() => { window.__ht.input.moveX = Math.sin(Date.now() / 600) * 0.5; }); }
    if (n === 2) { await drive(false); await aimFire(true); }
    if (n === 3) { await aimFire(false); await p.evaluate(() => { window.__ht.input.jumpQueued = true; }); }
    if (n === 4) { if (!shots.glow) shots.glow = await p.evaluate(() => document.getElementById('ab-side').classList.contains('tut-glow')); await p.evaluate(() => { window.__ht.input.sideQueued = true; }); }
    if (n === 5) { await aimFire(false); await p.evaluate(() => { window.__ht.input.ultQueued = true; }); }
    if (n === 6) await aimFire(true);
    if (n !== shots.lastN) { shots.lastN = n; if (n >= 2 && n <= 6) await p.screenshot({ path: `scratch/shots/tut-step${n}${EN ? '-en' : ''}.png` }); }
    await p.waitForTimeout(150);
  }
  await aimFire(false); await drive(false);
  console.log('      events:', await p.evaluate(() => { const c = {}; for (const e of window.__ev || []) { const k = e.split(':')[0]; c[k] = (c[k] || 0) + 1; } return JSON.stringify(c); }));
  ok(await p.isVisible('#tut-done'), `all steps cleared -> reward dialog (${JSON.stringify(shots)})`);
  ok((await p.$$('#tut-done-rew .rw-card')).length === 3, `rewards: ${await p.textContent('#tut-done-rew')}`);
  ok(shots.glow === true, 'PC: the E icon glows on the sidearm step');
  ok(await p.evaluate(() => !document.querySelector('.tut-glow')), 'no glow left after the tutorial');
  await p.screenshot({ path: `scratch/shots/tut-done${EN ? '-en' : ''}.png` });
  const view = await p.evaluate(() => fetch('/api/profile', { headers: { authorization: `Bearer ${localStorage.getItem('ht-pid')}` } }).then((r) => r.json()));
  ok(view.tut === true && ['paint:cadet', 'rear:booster', 'title:cadet'].every((k) => view.owned.includes(k)), 'profile: tutorial done, the three items owned');

  // equip and go to quick match
  await p.click('#btn-tut-equip');
  await p.waitForFunction(() => window.__ht.room?.quick && document.getElementById('lobby').classList.contains('hidden'), null, { timeout: 30000 }).catch(() => {});
  const v2 = await p.evaluate(() => fetch('/api/profile', { headers: { authorization: `Bearer ${localStorage.getItem('ht-pid')}` } }).then((r) => r.json()));
  ok(v2.look.paint === 'cadet' && v2.look.rear === 'booster' && v2.look.title === 'cadet', `equipped: ${v2.look.paint} / ${v2.look.rear} / ${v2.look.title}`);
  ok(await p.evaluate(() => !!window.__ht.room?.quick && !document.body.classList.contains('tutorial')), 'went on to a quick match');
  await p.waitForTimeout(2500);
  await p.screenshot({ path: `scratch/shots/tut-after${EN ? '-en' : ''}.png` });
  // back in the lobby: no more suggestion, no badge
  await p.evaluate(async () => { window.__noReload = 1; });
  await p.evaluate(() => document.getElementById('btn-settings').click());
  await p.goto(URL + '/?debug', { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => document.getElementById('loading')?.classList.contains('hidden') && !document.getElementById('prof-bar').classList.contains('hidden'), null, { timeout: 90000 });
  await p.waitForTimeout(800);
  ok(!(await p.isVisible('#tut-pop')) && !(await p.isVisible('#tut-badge')) && (await p.isVisible('#btn-tutorial')), 'after finishing: no popup, no badge, button still there');

  // a second visitor who taps "later" does not see the card again
  const c2 = await b.newContext({ viewport: { width: 844, height: 390 }, locale: 'ja-JP', isMobile: true, hasTouch: true });
  const q = await c2.newPage();
  q.on('pageerror', (e) => errors.push(e.message));
  await q.goto(URL + '/?debug', { waitUntil: 'domcontentloaded' });
  await q.waitForFunction(() => document.getElementById('loading')?.classList.contains('hidden') && !document.getElementById('prof-bar').classList.contains('hidden'), null, { timeout: 90000 });
  await q.waitForTimeout(800);
  await q.screenshot({ path: 'scratch/shots/tut-lobby-phone.png' });
  ok(await q.isVisible('#tut-pop'), 'phone: popup shown');
  await q.click('#btn-tut-start');
  await q.waitForFunction(() => window.__ht.room && !document.getElementById('tut-panel').classList.contains('hidden'), null, { timeout: 30000 });
  ok(/画面の左側/.test(await q.textContent('#tut-text')), `phone: touch wording: ${await q.textContent('#tut-text')}`);
  ok(await q.isVisible('#tut-hint-move'), 'phone: a finger hint shows where to drive from');
  await q.screenshot({ path: 'scratch/shots/tut-phone-step1.png' });
  // drive (touch input through the debug hook) until the shooting step: FIRE glows
  await q.evaluate(() => { window.__ht.input.enabled = true; window.__ht.input.moveY = 1; });
  await q.waitForFunction(() => document.getElementById('tut-no').textContent.startsWith('2/'), null, { timeout: 30000 }).catch(() => {});
  await q.evaluate(() => { window.__ht.input.moveY = 0; });
  ok(await q.evaluate(() => document.getElementById('btn-fire').classList.contains('tut-glow') && !document.getElementById('tut-hint-aim').classList.contains('hidden')), 'phone: FIRE glows on the shooting step, with an aiming hint');
  await q.waitForTimeout(400);
  await q.screenshot({ path: 'scratch/shots/tut-phone-step2.png' });
  await q.click('#btn-tut-quit'); await q.waitForTimeout(600);
  ok(!(await q.isVisible('#tut-pop')) && (await q.isVisible('#tut-badge')) && await q.evaluate(() => !document.querySelector('.tut-glow')), 'quit -> lobby (no popup again this visit, badge stays, no glow left)');
  await q.click('#btn-tutorial'); await q.waitForTimeout(300);
  await q.screenshot({ path: 'scratch/shots/tut-pop-phone.png' });
  await q.click('#btn-tut-later'); await q.waitForTimeout(200);
  await q.reload({ waitUntil: 'domcontentloaded' });
  await q.waitForFunction(() => document.getElementById('loading')?.classList.contains('hidden') && !document.getElementById('prof-bar').classList.contains('hidden'), null, { timeout: 90000 });
  await q.waitForTimeout(800);
  ok(!(await q.isVisible('#tut-pop')) && (await q.isVisible('#tut-badge')), '"later": popup gone for good, the button keeps its badge');
  ok(errors.length === 0, `no page errors ${errors.slice(0, 3).join(' / ')}`);
  await b.close();
})();
