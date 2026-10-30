// Browser test: the result screen (no auto next match, next / rules / lobby / loadout buttons,
// ready-up with free fire in a private room, quick match "next" re-matches at once).
//   MATCH_SECONDS=8 scratch/with-server.sh 8871 node test/result-ui.cjs
const { chromium } = require('playwright');
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) process.exitCode = 1; };
(async () => {
  const URL = process.env.URL;
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const errors = [];
  const mk = async (name) => {
    const c = await b.newContext({ viewport: { width: 800, height: 450 }, locale: 'ja-JP' });
    const p = await c.newPage();
    await p.addInitScript(() => { try { localStorage.setItem('ht-quality', 'low'); } catch {} });
    p.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
    await p.goto(URL + '/?debug', { waitUntil: 'domcontentloaded' });
    await p.waitForFunction(() => document.getElementById('loading')?.classList.contains('hidden'));
    await p.fill('#name', name);
    return p;
  };
  const word = `kekka${Date.now() % 10000}`;
  const A = await mk('Alice'), B = await mk('Bob');
  for (const P of [A, B]) { await P.click('#tab-btn-phrase'); await P.fill('#phrase', word); }
  await A.click('#lobby-rules [data-k="bots"][data-v="1"]');
  await A.click('#btn-create'); await A.waitForTimeout(1200); await A.click('#btn-invite-close').catch(() => {});
  await B.click('#btn-create');
  await A.waitForFunction(() => !document.getElementById('result').classList.contains('hidden'), null, { timeout: 30000 });
  await B.waitForFunction(() => !document.getElementById('result').classList.contains('hidden'), null, { timeout: 30000 });
  const btns = await A.evaluate(() => [...document.querySelectorAll('#result .res-actions button')].filter((x) => x.offsetParent).map((x) => x.textContent));
  ok(['次の試合', '装備を変える', 'ルール変更', 'ロビーへ戻る'].every((t) => btns.includes(t)), `result buttons: ${btns.join(' / ')}`);
  await A.screenshot({ path: 'scratch/shots/res-private.png' });
  await A.waitForTimeout(13000);
  ok(await A.evaluate(() => window.__ht.room && !document.getElementById('result').classList.contains('hidden')), 'no automatic next match (still on the result screen 13 s later)');
  // loadout from the result screen
  await A.click('#btn-res-loadout');
  ok(await A.evaluate(() => !document.getElementById('loadout').classList.contains('hidden') && getComputedStyle(document.querySelector('#loadout .grp-ult')).display !== 'none'), 'loadout button opens the picker (both slots)');
  await A.screenshot({ path: 'scratch/shots/res-loadout.png' });
  await A.click('#btn-lo-close');
  // A is ready -> free fire while B is still on the result screen
  await A.click('#btn-res-next');
  await A.waitForTimeout(800);
  ok(await A.evaluate(() => document.getElementById('result').classList.contains('hidden') && !document.getElementById('ready-bar').classList.contains('hidden')), `A ready: ready bar "${await A.textContent('#ready-text')}"`);
  const s0 = await A.evaluate(() => window.__ht.local.t.shotSeq);
  await A.keyboard.down('KeyF'); await A.waitForTimeout(4000); await A.keyboard.up('KeyF');
  ok((await A.evaluate(() => window.__ht.local.t.shotSeq)) > s0, 'free fire: A can shoot while waiting');
  await A.screenshot({ path: 'scratch/shots/res-freefire.png' });
  ok((await B.textContent('#result-next')).includes('1/2'), `B sees: ${await B.textContent('#result-next')}`);
  // B changes the rules for the next match -> both have to confirm again
  await B.click('#btn-res-rules');
  await B.click('#result-rules [data-k="mode"][data-v="team"]');
  await B.screenshot({ path: 'scratch/shots/res-rules.png' });
  await B.click('#btn-res-rules-ok');
  await A.waitForTimeout(1200);
  ok((await A.textContent('#ready-text')).includes('0/2') && !(await A.evaluate(() => document.getElementById('btn-ready').classList.contains('hidden'))), `rules changed -> A must confirm again: "${await A.textContent('#ready-text')}"`);
  await A.click('#btn-ready'); await B.click('#btn-res-next');
  await A.waitForFunction(() => window.__ht.snaps.at(-1)?.ph === 'play', null, { timeout: 8000 }).catch(() => {});
  ok(await A.evaluate(() => window.__ht.snaps.at(-1)?.ph === 'play' && document.getElementById('board').innerText.includes('チーム戦')), 'everyone ready -> next match with the new rules (team battle)');
  // wait for this match to end, then back to the lobby without a reload
  await A.waitForFunction(() => !document.getElementById('result').classList.contains('hidden'), null, { timeout: 30000 });
  await A.evaluate(() => { window.__noReload = 1; });
  await A.click('#btn-res-lobby');
  await A.waitForTimeout(800);
  ok(await A.evaluate(() => window.__noReload === 1 && !window.__ht.room && !document.getElementById('lobby').classList.contains('hidden')), 'back to the lobby (no page reload)');
  // quick match: "next match" goes straight to a new match
  await A.click('#btn-quick');
  await A.waitForFunction(() => window.__ht.room && document.getElementById('lobby').classList.contains('hidden'), null, { timeout: 15000 });
  const r1 = await A.evaluate(() => window.__ht.room.roomId);
  await A.waitForFunction(() => !document.getElementById('result').classList.contains('hidden'), null, { timeout: 40000 });
  ok((await A.textContent('#result-next')).includes('次の対戦相手'), `quick match result: ${await A.textContent('#result-next')}`);
  await A.screenshot({ path: 'scratch/shots/res-quick.png' });
  await A.click('#btn-res-next');
  await A.waitForFunction((r) => window.__ht.room && window.__ht.room.roomId !== r && window.__ht.myIdSet !== false, r1, { timeout: 15000 }).catch(() => {});
  const r2 = await A.evaluate(() => window.__ht.room?.roomId);
  if (!r2) console.log('      lobby status:', await A.textContent('#lobby-status'), '| loading:', await A.evaluate(() => document.getElementById('loading').className + ' ' + document.getElementById('loading-text').textContent), '| lobby hidden:', await A.evaluate(() => document.getElementById('lobby').classList.contains('hidden')));
  ok(r2 && r2 !== r1 && await A.evaluate(() => document.getElementById('result').classList.contains('hidden')), `quick match "next match" re-matched at once (${r1} -> ${r2})`);
  // quick match rule change -> lobby with the conditions sheet
  await A.waitForFunction(() => !document.getElementById('result').classList.contains('hidden'), null, { timeout: 40000 });
  await A.click('#btn-res-rules'); await A.waitForTimeout(600);
  ok(await A.evaluate(() => !window.__ht.room && !document.getElementById('qm-sheet').classList.contains('hidden')), 'quick match "change rules" -> lobby with the quick-match options open');
  ok(errors.length === 0, `no page errors ${errors.slice(0, 3).join(' / ')}`);
  await b.close();
})();
