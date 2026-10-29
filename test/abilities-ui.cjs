// Browser test: loadout picker, E / Q in a real room, HUD, effects (screenshots in scratch/shots/ab-*.png).
//   ULT_RATE=40 scratch/with-server.sh 8801 node test/abilities-ui.cjs
const { chromium } = require('playwright');
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) process.exitCode = 1; };
(async () => {
  const URL = process.env.URL;
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const errors = [];
  const mk = async (vp = { width: 800, height: 450 }) => {
    const c = await b.newContext({ viewport: vp });
    const p = await c.newPage();
    await p.addInitScript(() => { try { localStorage.setItem('ht-quality', 'low'); } catch {} });   // keep 3 software-rendered pages fast enough
    p.on('pageerror', (e) => errors.push(e.message));
    p.on('console', (m) => { if (m.type() === 'error' && !/favicon|WebSocket/.test(m.text())) errors.push(m.text()); });
    return p;
  };
  const ready = (P) => P.waitForFunction(() => document.getElementById('loading').classList.contains('hidden'));
  const A = await mk();
  await A.goto(URL + '/?debug', { waitUntil: 'domcontentloaded' }); await ready(A);

  // ---- lobby picker
  await A.click('#btn-loadout');
  await A.click('#loadout-picker [data-k="side"][data-v="shield"]');
  await A.click('#loadout-picker [data-k="ult"][data-v="strike"]');
  const lo = await A.evaluate(() => JSON.parse(localStorage.getItem('ht-loadout')));
  ok(lo.side === 'shield' && lo.ult === 'strike', `loadout saved: ${JSON.stringify(lo)}`);
  ok(await A.evaluate(() => document.querySelector('#btn-loadout').textContent.includes('リフレクトシールド') && document.querySelector('#btn-loadout2').textContent.includes('エアストライク')), 'lobby and settings summaries follow the picker');
  await A.screenshot({ path: 'scratch/shots/ab-lobby.png' });
  // back to dash + mega for the fight
  await A.click('#loadout-picker [data-k="side"][data-v="dash"]'); await A.click('#loadout-picker [data-k="ult"][data-v="mega"]'); await A.click('#btn-lo-close');

  await A.click('#tab-btn-phrase'); await A.click('#btn-create'); await A.waitForTimeout(1500); await A.click('#btn-invite-close');
  const inv = await A.inputValue('#invite-url');
  const B = await mk(); await B.goto(inv + '&debug', { waitUntil: 'domcontentloaded' }); await ready(B);
  await B.click('#btn-loadout'); await B.click('#loadout-picker [data-k="side"][data-v="shield"]'); await B.click('#btn-lo-close');
  await B.click('#btn-join');
  await A.waitForTimeout(2500);
  const roster = await A.evaluate(() => new Promise((r) => setTimeout(() => r(document.getElementById('board').innerText), 300)));
  console.log('      board:', roster.replace(/\n/g, ' | '));

  // drive both onto the central hill so they can see each other
  const dist = (P) => P.evaluate(() => { const t = window.__ht.local.t; return t ? Math.hypot(t.x, t.z) : 99; });
  const drive = async (P, stop = 3.5) => {
    await P.evaluate(() => { const t = window.__ht.local.t; window.__ht.setCam(Math.atan2(t.x, t.z), 0); });
    await P.keyboard.down('KeyW');
    let prev = await dist(P);
    for (let i = 0; i < 60; i++) {
      await P.waitForTimeout(60);
      await P.evaluate(() => { const t = window.__ht.local.t; window.__ht.setCam(Math.atan2(t.x, t.z), 0); });
      const d = await dist(P);
      if (d < stop || d > prev + 0.2) break;
      prev = d;
    }
    await P.keyboard.up('KeyW');
  };
  await drive(A, 6); await drive(B, 3.5); await A.waitForTimeout(1200);
  const aimAt = (P) => P.evaluate(() => { const h = window.__ht, s = h.snaps[h.snaps.length - 1]; const me = h.local.t; const o = [...s.players.values()].find((p) => Math.hypot(p.x - me.x, p.z - me.z) > 1);
    const d = Math.hypot(o.x - me.x, o.z - me.z) + 8.5; h.setCam(Math.atan2(-(o.x - me.x), -(o.z - me.z)), Math.atan2(o.y + 0.9 - (me.y + 3.2), d)); return Math.hypot(o.x - me.x, o.z - me.z); });
  const hpB = () => B.evaluate(() => window.__ht.local.hp);
  console.log('      distance A-B:', (await aimAt(A)).toFixed(1));

  // ---- sidearm E (dash) on A
  const sp0 = await A.evaluate(() => Math.hypot(window.__ht.local.t.vx, window.__ht.local.t.vz));
  await A.keyboard.down('KeyD'); await A.keyboard.press('KeyE');
  await A.waitForFunction(() => window.__ht.local.t.sideCd > 0, null, { timeout: 5000 }).catch(() => {});
  const d = await A.evaluate(() => ({ cd: window.__ht.local.t.sideCd, sp: Math.hypot(window.__ht.local.t.vx, window.__ht.local.t.vz), ring: getComputedStyle(document.getElementById('ab-side')).getPropertyValue('--cd') }));
  await A.screenshot({ path: 'scratch/shots/ab-dash.png' });
  await A.keyboard.up('KeyD');
  ok(d.cd > 5 && d.sp > sp0 + 10, `E = dash: ${sp0.toFixed(1)} -> ${d.sp.toFixed(1)} m/s, cooldown ${d.cd.toFixed(2)} s, HUD ring ${d.ring}`);
  await A.waitForTimeout(800);

  // ---- special Q (mega cannon) on A once the meter is full (ULT_RATE speeds it up)
  await A.waitForFunction(() => window.__ht.local.t?.ult >= 100, null, { timeout: 15000 });
  ok(await A.evaluate(() => document.getElementById('ab-ult').classList.contains('ready')), 'special button shows READY');
  await A.screenshot({ path: 'scratch/shots/ab-ready.png' });
  let h0 = await hpB();
  for (let i = 0; i < 3 && (await hpB()) >= h0; i++) {
    await A.waitForFunction(() => window.__ht.local.t?.ult >= 100, null, { timeout: 15000 });
    await aimAt(A); await A.waitForTimeout(150);
    await A.keyboard.press('KeyQ');
    await A.waitForTimeout(110); await A.screenshot({ path: 'scratch/shots/ab-mega.png' });
    await A.waitForTimeout(700);
    if ((await hpB()) < h0) break;
    h0 = await hpB();
  }
  const h1 = await hpB();
  if (h1 > h0 - 40) console.log('      B state:', JSON.stringify(await B.evaluate(() => ({ inv: window.__ht.local.invuln, left: window.__ht.local.invulnLeft, sh: window.__ht.local.t?.shieldT, alive: window.__ht.local.alive }))), 'A events:', JSON.stringify(await A.evaluate(() => (window.__ev || []).slice(-12))));
  ok(h1 <= h0 - 40 || !(await B.evaluate(() => window.__ht.local.alive)), `mega cannon hit B: ${h0} -> ${h1} HP`);
  await B.screenshot({ path: 'scratch/shots/ab-mega-victim.png' });

  // ---- B: reflect shield bubble
  await B.waitForTimeout(3500);
  await B.keyboard.press('KeyE');
  await B.waitForFunction(() => window.__ht.local.t?.shieldT > 0, null, { timeout: 5000 }).catch(() => {});
  const sh = await B.evaluate(() => window.__ht.local.t?.shieldT || 0);
  await A.waitForTimeout(150);
  await A.screenshot({ path: 'scratch/shots/ab-shield.png' });
  ok(sh > 1, `B raised the shield (${sh.toFixed(2)} s left)`);

  // ---- switch A to mine + strike in the room (settings picker -> 'loadout' message)
  await A.evaluate(() => document.getElementById('btn-settings').click()); await A.click('#btn-loadout2');
  await A.click('#loadout-picker [data-k="side"][data-v="mine"]'); await A.click('#loadout-picker [data-k="ult"][data-v="strike"]');
  await A.screenshot({ path: 'scratch/shots/ab-settings.png' }); await A.click('#btn-lo-close');
  await A.click('#btn-settings-close');
  await aimAt(B);
  await B.waitForFunction(() => [...document.querySelectorAll('.tag .lo')].some((e) => e.textContent === '✱✈'), null, { timeout: 5000 }).catch(() => {});
  const loA = await B.evaluate(() => [...document.querySelectorAll('.tag .lo')].map((e) => e.textContent).join(','));
  ok(loA.includes('✱✈'), `B sees A's new loadout icons on the name tag (${loA})`);
  await A.keyboard.press('KeyE'); await A.waitForTimeout(1200);
  const mines = await A.evaluate(() => window.__ht.snaps[window.__ht.snaps.length - 1].mines.length);
  ok(mines === 1, `mine placed (${mines} on the field)`);
  await A.waitForFunction(() => window.__ht.local.t?.ult >= 100, null, { timeout: 15000 });
  await aimAt(A); await A.waitForTimeout(150);
  h0 = await hpB();
  await A.keyboard.press('KeyQ'); await A.waitForTimeout(900);
  await A.screenshot({ path: 'scratch/shots/ab-strike-marker.png' });
  await B.screenshot({ path: 'scratch/shots/ab-strike-victim.png' });
  await A.waitForTimeout(700);
  await A.screenshot({ path: 'scratch/shots/ab-strike-bombs.png' });
  await A.waitForTimeout(800);
  console.log('      B after the strike:', h0, '->', await hpB());

  // ---- slam
  await A.evaluate(() => document.getElementById('btn-settings').click()); await A.click('#btn-loadout2');
  await A.click('#loadout-picker [data-k="ult"][data-v="slam"]'); await A.click('#btn-lo-close'); await A.click('#btn-settings-close');
  await A.waitForFunction(() => window.__ht.local.t?.ult >= 100, null, { timeout: 15000 });
  await A.keyboard.press('KeyQ');
  await A.waitForFunction(() => window.__ht.local.t.slam > 0, null, { timeout: 5000 }).catch(() => {});
  const up = await A.evaluate(() => window.__ht.local.t.slam);
  await A.waitForTimeout(500);
  await A.screenshot({ path: 'scratch/shots/ab-slam.png' });
  ok(up >= 1, `slam jumps (slam state ${up})`);

  // ---- overdrive aura
  await A.evaluate(() => document.getElementById('btn-settings').click()); await A.click('#btn-loadout2');
  await A.click('#loadout-picker [data-k="ult"][data-v="overdrive"]'); await A.click('#loadout-picker [data-k="side"][data-v="bounce"]'); await A.click('#btn-lo-close'); await A.click('#btn-settings-close');
  await A.waitForFunction(() => window.__ht.local.t?.ult >= 100, null, { timeout: 15000 });
  const pre = await A.evaluate(() => { const h = window.__ht, me = h.snaps.at(-1).players.get(h.room?.sessionId) || null; return { lu: h.local.t.ult, ul: h.local.t.ultK, alive: h.local.alive, slam: h.local.t.slam }; });
  await A.keyboard.press('KeyQ');
  await A.waitForFunction(() => window.__ht.local.t.odT > 0, null, { timeout: 5000 }).catch(() => {});
  const od = await A.evaluate(() => window.__ht.local.t.odT);
  if (od < 5) console.log('      before Q:', JSON.stringify(pre));
  ok(od > 5, `overdrive on (${od.toFixed(2)} s)`);
  await aimAt(A); await A.keyboard.press('KeyE'); await A.waitForTimeout(150);
  await A.screenshot({ path: 'scratch/shots/ab-overdrive.png' });

  ok(errors.length === 0, `no page errors${errors.length ? ': ' + errors.slice(0, 5).join(' / ') : ''}`);

  // ---- touch layout
  const T = await mk({ width: 844, height: 390 });
  await T.addInitScript(() => { Object.defineProperty(window, 'ontouchstart', { value: null }); });
  await T.goto(inv + '&debug', { waitUntil: 'domcontentloaded' }); await ready(T);
  await T.evaluate(() => document.getElementById('btn-join').click());
  await T.waitForTimeout(2500);
  await T.screenshot({ path: 'scratch/shots/ab-touch.png' });
  ok(await T.evaluate(() => getComputedStyle(document.getElementById('btn-ult')).display !== 'none' && document.body.classList.contains('touch')), 'touch: SUB / SP buttons shown');
  await b.close();
})();
