// Browser test: create a team / first-to-5 room from the lobby, a second player joins via invite
// and sees the rules, team HUD and team colours; then rules are changed in-game with "new game".
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const mk = async () => { const p = await (await b.newContext({ locale: 'ja-JP', viewport: { width: 960, height: 540 } })).newPage({ locale: 'ja-JP' }); p.errs = []; p.on('pageerror', (e) => p.errs.push(e.message)); return p; };
  const A = await mk();
  await A.goto(process.env.URL, { waitUntil: 'domcontentloaded' });
  await A.waitForFunction(() => window.__ht && window.__ht.readyAt);
  await A.click('#tab-btn-phrase'); await A.click('#lobby-rules button[data-v="team"]');
  await A.selectOption('#lobby-rules select', '5');
  await A.screenshot({ path: 'scratch/shots/modes_lobby.png' });
  await A.click('#btn-create'); await A.waitForTimeout(1500); await A.click('#btn-invite-close');
  const inv = await A.inputValue('#invite-url');
  const B = await mk(); await B.goto(inv, { waitUntil: 'domcontentloaded' }); await B.waitForFunction(() => window.__ht && window.__ht.readyAt);
  await B.waitForTimeout(800);
  console.log('B lobby shows:', await B.textContent('#lobby-room-rules'));
  await B.click('#btn-join'); await A.waitForTimeout(2500);
  console.log('A timer:', await A.textContent('#timer'), '| team score:', await A.textContent('#teamscore'));
  console.log('A board:', (await A.innerText('#board')).replace(/\n/g, ' | '));
  await A.screenshot({ path: 'scratch/shots/modes_game.png' });
  // B switches to the red team, then A changes the rules to free-for-all / time with new game
  await B.click('#btn-settings'); await B.click('#btn-team'); await A.waitForTimeout(1200);
  console.log('after B switched team, A board:', (await A.innerText('#board')).replace(/\n/g, ' | '));
  await A.click('#btn-settings'); await A.click('#settings-rules button[data-v="ffa"]'); await A.click('#settings-rules button[data-v="time"]');
  await A.click('#btn-newgame'); await A.waitForTimeout(300); await A.click('#btn-newgame'); await B.waitForTimeout(1200);
  console.log('B after new game: notice:', await B.textContent('#notice'), '| timer:', await B.textContent('#timer'), '| team score hidden:', await B.evaluate(() => document.getElementById('teamscore').classList.contains('hidden')));
  console.log('B board:', (await B.innerText('#board')).replace(/\n/g, ' | '));
  console.log('errors:', A.errs, B.errs);
  await b.close();
})();
