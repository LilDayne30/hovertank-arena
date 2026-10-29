// Browser test: two players press "quick match" and land in the same public room; the invite
// button still works for that room and the settings lock the rules.
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const mk = async () => { const p = await (await b.newContext({ locale: 'ja-JP', viewport: { width: 960, height: 540 } })).newPage({ locale: 'ja-JP' }); p.errs = []; p.on('pageerror', (e) => p.errs.push(e.message)); await p.goto(process.env.URL, { waitUntil: 'domcontentloaded' }); await p.waitForFunction(() => window.__ht && window.__ht.readyAt); return p; };
  const A = await mk();
  await A.waitForTimeout(800);
  await A.screenshot({ path: 'scratch/shots/qm_lobby.png' });
  await A.click('#btn-qm-opts'); await A.click('#qm-mode button[data-v="ffa"]'); await A.click('#btn-qm-close');
  await A.click('#btn-quick'); await A.waitForTimeout(1500);
  console.log('A notice:', await A.textContent('#notice'));
  const B = await mk();
  await B.click('#btn-qm-opts'); await B.click('#qm-mode button[data-v="any"]'); await B.click('#btn-qm-close');
  await B.click('#btn-quick'); await B.waitForTimeout(2000);
  const ra = await A.evaluate(() => window.__ht.room.roomId), rb = await B.evaluate(() => window.__ht.room.roomId);
  console.log('same room:', ra === rb, ra, '| B board:', (await B.innerText('#board')).replace(/\n/g, ' | '));
  await A.click('#btn-settings');
  console.log('settings: rule picker hidden =', await A.evaluate(() => document.getElementById('settings-rules').classList.contains('hidden')), '| note:', await A.textContent('#public-note'), '| button:', await A.textContent('#btn-newgame'));
  await A.click('#btn-settings-close'); await A.click('#btn-invite');
  console.log('invite URL for the public room:', (await A.inputValue('#invite-url')).replace(/^.*\?/, '?'));
  console.log('errors:', A.errs, B.errs);
  await b.close();
})();
