// Measures transfer size and load time of the public page (cold cache and warm cache),
// optionally with a throttled "4G" network.  URL=https://... node test/measure.cjs
const { chromium } = require('playwright');
const URL = process.env.URL;
(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  for (const profile of [{ name: 'no throttling', net: null }, { name: 'throttled 4G (9 Mbps down, 1.5 Mbps up, 150 ms RTT)', net: { offline: false, downloadThroughput: 9e6 / 8, uploadThroughput: 1.5e6 / 8, latency: 150 } }]) {
    const ctx = await b.newContext({ viewport: { width: 1280, height: 720 } });
    const p = await ctx.newPage();
    const cdp = await ctx.newCDPSession(p);
    await cdp.send('Network.enable');
    if (profile.net) await cdp.send('Network.emulateNetworkConditions', profile.net);
    let bytes = 0; const per = {};
    cdp.on('Network.loadingFinished', (e) => { bytes += e.encodedDataLength; });
    cdp.on('Network.responseReceived', (e) => { per[e.requestId] = e.response.url.replace(URL, ''); });
    cdp.on('Network.loadingFinished', (e) => { if (per[e.requestId]) per[e.requestId] += ` ${(e.encodedDataLength / 1024).toFixed(1)} KB`; });
    for (const run of ['cold', 'warm']) {
      bytes = 0;
      const t0 = Date.now();
      await p.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
      await p.waitForFunction(() => document.getElementById('loading').classList.contains('hidden') && window.__ht, null, { timeout: 120000 });
      const ms = Date.now() - t0;
      await p.waitForTimeout(500);
      console.log(`[${profile.name}] ${run}: ready in ${ms} ms, transferred ${(bytes / 1024).toFixed(0)} KB`);
      if (run === 'cold' && !profile.net) console.log('  files:', Object.values(per).filter((s) => / KB$/.test(s)).join(' | '));
    }
    await ctx.close();
  }
  await b.close();
})();
