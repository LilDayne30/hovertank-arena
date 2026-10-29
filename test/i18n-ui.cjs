// Browser test: English / Japanese switch. Checks that no Japanese is left on screen in English
// (lobby, sheets, loadout, garage, missions, in a room, settings) and that switching back works.
//   scratch/with-server.sh 8860 node test/i18n-ui.cjs      (screenshots: scratch/shots/en-*.png)
const { chromium } = require('playwright');
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) process.exitCode = 1; };
const JA = /[぀-ヿ一-鿿]/;
(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const errors = [];
  const c = await b.newContext({ viewport: { width: 1280, height: 720 }, locale: 'ja-JP' });
  const p = await c.newPage();
  p.on('pageerror', (e) => errors.push(e.message));
  await p.addInitScript(() => { try { localStorage.setItem('ht-quality', 'low'); } catch {} });
  await p.goto(process.env.URL + '/?debug', { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => document.getElementById('loading')?.classList.contains('hidden') && !document.getElementById('prof-bar').classList.contains('hidden'));
  ok((await p.textContent('#btn-lang')).includes('English'), 'Japanese browser starts in Japanese; button offers English');
  // Japanese left in visible text (the language button itself and the player's name are allowed)
  const leftover = () => p.evaluate((src) => {
    const re = new RegExp(src);
    const out = [];
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const el = n.parentElement;
      if (!el || !n.nodeValue.trim() || !re.test(n.nodeValue) || el.closest('.lang-btn')) continue;
      const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
      if (r.width && r.height && cs.visibility !== 'hidden' && el.offsetParent !== null) out.push(n.nodeValue.trim().slice(0, 60));
    }
    for (const el of document.querySelectorAll('input[placeholder]')) if (el.offsetParent && re.test(el.placeholder)) out.push(`placeholder: ${el.placeholder}`);
    return out;
  }, JA.source);

  await p.click('#btn-lang');
  ok(await p.evaluate(() => document.documentElement.lang === 'en' && localStorage.getItem('ht-lang') === 'en'), 'switched to English (remembered)');
  ok((await p.textContent('#btn-quick')).trim() === 'Quick Match' && (await p.textContent('#btn-loadout')).includes('Boost Dash'), `lobby in English: "${(await p.textContent('#btn-quick')).trim()}", "${(await p.textContent('#btn-loadout')).trim()}"`);
  let left = await leftover();
  ok(left.length === 0, `lobby: no Japanese left ${left.join(' | ')}`);
  await p.screenshot({ path: 'scratch/shots/en-lobby.png' });
  for (const [btn, sheet, shot] of [['#btn-qm-opts', 'qm-sheet', 'qm'], ['#tab-btn-phrase', 'phrase-sheet', 'phrase'], ['#btn-lo-ult', 'loadout', 'loadout']]) {
    await p.click(btn); await p.waitForTimeout(150);
    left = await leftover();
    ok(left.length === 0, `${sheet}: no Japanese left ${left.join(' | ')}`);
    await p.screenshot({ path: `scratch/shots/en-${shot}.png` });
    await p.keyboard.press('Escape');
  }
  await p.click('#btn-garage'); await p.waitForTimeout(300);
  for (const k of ['paint', 'turret', 'title']) { await p.click(`#g-tabs [data-k="${k}"]`); left = await leftover(); ok(left.length === 0, `garage / ${k}: no Japanese left ${left.join(' | ')}`); }
  await p.screenshot({ path: 'scratch/shots/en-garage.png' });
  await p.click('#btn-g-close');
  await p.click('#btn-missions'); await p.waitForTimeout(200);
  for (const k of ['daily', 'ach', 'lv']) { await p.click(`#m-tabs [data-t="${k}"]`); left = await leftover(); ok(left.length === 0, `missions / ${k}: no Japanese left ${left.join(' | ')}`); }
  await p.screenshot({ path: 'scratch/shots/en-missions.png' });
  await p.click('#btn-m-close');
  await p.click('#btn-transfer'); left = await leftover(); ok(left.length === 0, `transfer: no Japanese left ${left.join(' | ')}`); await p.click('#btn-tr-close');

  // a private room with CPUs, in English
  await p.click('#tab-btn-phrase'); await p.fill('#phrase', `english${Date.now() % 1000}`);
  await p.click('#lobby-rules [data-k="bots"][data-v="2"]');
  await p.click('#btn-create');
  await p.waitForFunction(() => window.__ht.room && document.getElementById('lobby').classList.contains('hidden'), null, { timeout: 10000 });
  await p.waitForTimeout(2500);
  await p.click('#btn-invite-close').catch(() => {});
  left = (await leftover()).filter((s) => !/^(レイ|ガロ|ミナ|ジン|ルカ|ソラ|ハク|ユズ)$/.test(s));
  ok(left.length === 0, `in the room (HUD, board, tags): no Japanese left ${left.join(' | ')}`);
  ok(/CPU ×2 \(Normal\)/.test(await p.textContent('#board')) && /Rei|Garo|Mina/.test(await p.textContent('#board')), `board: ${(await p.textContent('#board')).replace(/\s+/g, ' ').slice(0, 120)}`);
  await p.screenshot({ path: 'scratch/shots/en-room.png' });
  await p.evaluate(() => document.getElementById('btn-settings').click()); await p.waitForTimeout(200);
  left = await leftover(); ok(left.length === 0, `settings: no Japanese left ${left.join(' | ')}`);
  await p.screenshot({ path: 'scratch/shots/en-settings.png' });
  // back to Japanese from settings, live
  await p.click('#btn-lang2');
  ok((await p.textContent('#btn-leave')).trim() === '退出' && (await p.textContent('#board')).includes('個人戦'), 'switched back to Japanese inside the room');
  ok(errors.length === 0, `no page errors ${errors.slice(0, 3).join(' / ')}`);
  // an English browser starts in English
  const c2 = await b.newContext({ viewport: { width: 844, height: 390 }, locale: 'en-US', hasTouch: true, isMobile: true });
  const p2 = await c2.newPage();
  await p2.addInitScript(() => { try { localStorage.setItem('ht-quality', 'low'); } catch {} });
  await p2.goto(process.env.URL + '/', { waitUntil: 'domcontentloaded' });
  await p2.waitForFunction(() => document.getElementById('loading')?.classList.contains('hidden'));
  ok((await p2.textContent('#btn-quick')).trim() === 'Quick Match', 'English browser starts in English');
  await p2.waitForTimeout(1000);
  await p2.screenshot({ path: 'scratch/shots/en-phone.png' });
  await b.close();
})();
