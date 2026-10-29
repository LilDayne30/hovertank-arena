// Browser test: two players type the same passphrase in the lobby and meet in one room; quick-match win condition picker.
const { chromium } = require('playwright');
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) process.exitCode = 1; };
(async () => {
  const URL = process.env.URL;
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const errors = [];
  const mk = async (vp = { width: 800, height: 450 }) => {
    const p = await (await b.newContext({ viewport: vp })).newPage();
    await p.addInitScript(() => { try { localStorage.setItem('ht-quality', 'low'); } catch {} });
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(URL + '/?debug', { waitUntil: 'domcontentloaded' });
    await p.waitForFunction(() => document.getElementById('loading').classList.contains('hidden'));
    return p;
  };
  const A = await mk();
  // quick match: win condition picker is remembered
  await A.click('#btn-qm-opts'); await A.click('#qm-goal [data-g="kills"]'); await A.selectOption('#qm-goal select', '15');
  ok(await A.evaluate(() => localStorage.getItem('ht-qm-goal') === 'kills' && localStorage.getItem('ht-qm-target') === '15'), 'quick-match win condition saved (first to 15 kills)');
  await A.evaluate(() => document.getElementById('qm-goal').scrollIntoView({ block: 'center' }));
  await A.screenshot({ path: 'scratch/shots/ph-qm.png' });
  ok((await A.textContent('#qm-sum-text')).includes('15キル先取'), `summary chip shows it: ${await A.textContent('#qm-sum-text')}`);
  await A.click('#qm-goal [data-g="time"]'); await A.click('#btn-qm-close');

  const word = `ねこじゃらし${Math.floor(Math.random() * 90 + 10)}`;
  await A.click('#tab-btn-phrase'); await A.fill('#name', 'Alice'); await A.fill('#phrase', word);
  await A.click('#lobby-rules [data-k="bots"][data-v="1"]');
  await A.evaluate(() => document.getElementById('phrase').scrollIntoView({ block: 'center' }));
  await A.screenshot({ path: 'scratch/shots/ph-lobby.png' });
  await A.click('#btn-create');
  await A.waitForFunction(() => !document.getElementById('invite').classList.contains('hidden'), null, { timeout: 8000 });
  const shown = await A.textContent('#invite-phrase');
  ok(shown === word, `creator sees the passphrase (${shown})`);
  await A.screenshot({ path: 'scratch/shots/ph-invite.png' });
  await A.click('#btn-invite-close');

  const B = await mk({ width: 844, height: 390 });
  await B.click('#tab-btn-phrase'); await B.fill('#name', 'Bob'); await B.fill('#phrase', word.replace('ねこ', 'ネコ'));   // katakana still matches
  await B.click('#btn-create');
  await B.waitForFunction(() => window.__ht.room && document.getElementById('lobby').classList.contains('hidden'), null, { timeout: 8000 });
  await B.waitForTimeout(1500);
  const ra = await A.evaluate(() => window.__ht.room.roomId), rb = await B.evaluate(() => window.__ht.room.roomId);
  const board = await A.evaluate(() => document.getElementById('board').innerText);
  ok(ra === rb, `same room (${ra}); board: ${board.replace(/\n/g, ' | ')}`);
  ok(/Bob/.test(board) && /CPU/.test(board), 'Alice sees Bob and the CPU she asked for');
  const notice = await B.textContent('#notice');
  ok(/参加しました/.test(notice), `joiner notice: ${notice}`);
  await B.screenshot({ path: 'scratch/shots/ph-joined.png' });
  await B.evaluate(() => document.getElementById('btn-invite').click());
  ok((await B.textContent('#invite-phrase')) === word.replace('ねこ', 'ネコ'), 'joiner can show the passphrase too');
  ok(errors.length === 0, `no page errors ${errors.slice(0, 3).join(' / ')}`);
  await b.close();
})();
