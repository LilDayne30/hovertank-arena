const { chromium } = require('playwright');
const looks = [
  { paint: 'sand', pattern: 'desert', turret: 'long', rear: 'antenna', side: 'skirt' },
  { paint: 'red', pattern: 'stripe', turret: 'twin', rear: 'spoiler', side: 'none' },
  { paint: 'olive', pattern: 'tiger', turret: 'heavy', rear: 'fins', side: 'blade' },
  { paint: 'navy', pattern: 'digital', turret: 'rail', rear: 'exhaust', side: 'canard', glow: 'magenta' },
  { paint: 'matte', pattern: 'flame', turret: 'missile', rear: 'jet', side: 'pods', glow: 'gold' },
  { paint: 'gold', pattern: 'carbon', turret: 'king', rear: 'jet', side: 'skirt', glow: 'gold' },
  { paint: 'pearl', pattern: 'checker', turret: 'dome', rear: 'none', side: 'pods', glow: 'emerald' },
  { paint: 'crimson', pattern: 'hazard', turret: 'std', rear: 'exhaust', side: 'blade', glow: 'red' },
];
(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const p = await (await b.newContext({ viewport: { width: 640, height: 400 } })).newPage();
  const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.goto(process.env.URL + '/?debug'); await p.waitForFunction(() => window.__ht && window.__ht.readyAt, null, { timeout: 30000 });
  for (let i = 0; i < looks.length; i++) {
    await p.evaluate((l) => window.__ht.preview(l), looks[i]);
    await p.waitForTimeout(900);
    await p.screenshot({ path: `scratch/shots/look_${i}.png` });
  }
  console.log('errors', errs);
  await b.close();
})();
