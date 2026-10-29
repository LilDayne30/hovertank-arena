// Renders every sound effect (and a few bars of each music mode) with an OfflineAudioContext in
// headless Chromium, reports loudness per effect, and writes a demo WAV.
//   node test/audio-render.cjs [out.wav]
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..', 'client');
const srv = http.createServer((q, r) => { const f = path.join(root, q.url === '/' ? 'x' : q.url); if (q.url === '/') { r.setHeader('content-type', 'text/html'); r.end('<!doctype html><title>a</title>'); return; } fs.readFile(f, (e, d) => { if (e) { r.statusCode = 404; r.end(); } else { r.setHeader('content-type', 'text/javascript'); r.end(d); } }); }).listen(0, async () => {
  const port = srv.address().port;
  const b = await chromium.launch();
  const p = await b.newPage({ locale: 'ja-JP' });
  const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.goto(`http://localhost:${port}/`);
  const res = await p.evaluate(async () => {
    const { Sound } = await import('/audio.js');
    const SR = 44100;
    const list = [
      ['fire (own)', (s) => s.fire({ x: 0, y: 0, z: 0 }, true)],
      ['fire (enemy 20 m right)', (s) => s.fire({ x: 20, y: 0, z: 0 }, false)],
      ['explosion 15 m', (s) => s.boom({ x: 0, y: 0, z: -15 }, 1)],
      ['hit confirm', (s) => s.hitConfirm()],
      ['you got hit', (s) => s.hurt()],
      ['kill (yours)', (s) => s.kill({ x: 0, y: 0, z: -20 }, true, false)],
      ['you were destroyed', (s) => s.kill({ x: 0, y: 0, z: 0 }, false, true)],
      ['shield', (s) => s.shield({ x: 5, y: 0, z: -5 })],
      ['jump', (s) => s.jump(null, true)], ['land', (s) => s.land(null, true)],
      ['turbo blue', (s) => s.boost(null, true, 1)], ['turbo orange', (s) => s.boost(null, true, 2)],
      ['charge ting 1', (s) => s.chargeTing(1)], ['charge ting 2', (s) => s.chargeTing(2)],
      ['heal appears', (s) => s.healSpawn()], ['heal (you)', (s) => s.heal(null, true)],
      ['respawn', (s) => s.respawn(null, true)], ['ui click', (s) => s.click()], ['match start horn', (s) => s.horn()],
      ['win', (s) => s.matchEnd('win')], ['lose', (s) => s.matchEnd('lose')], ['level up', (s) => s.levelUp()],
      ['dash', (s) => s.dash(null, true)], ['shield up', (s) => s.shieldUp(null, true)], ['reflect', (s) => s.reflect(null, true)],
      ['ricochet 10 m', (s) => s.rico({ x: 0, y: 0, z: -10 })], ['mine place', (s) => s.minePlace(null, true)],
      ['mega fire', (s) => s.megaFire(null, true)], ['mega blast 20 m', (s) => s.bigBoom({ x: 0, y: 0, z: -20 }, 1.8)],
      ['overdrive', (s) => s.overdrive(null, true)], ['strike call (enemy)', (s) => s.strikeCall(null, false, true)],
      ['bomb whistle 10 m', (s) => s.bombWhistle({ x: 0, y: 0, z: -10 }, 0.6)], ['slam jump', (s) => s.slamJump(null, true)],
      ['slam', (s) => s.slam(null, true)], ['ready side', (s) => s.readyPing('side')], ['ready ult', (s) => s.readyPing('ult')],
    ];
    const gap = 1.6, musicStart = list.length * gap + 0.5, bars = 2;
    const musicModes = [['lobby', false], ['battle', false], ['battle', true]];
    const sdOf = (m, i) => 60 / (m === 'lobby' ? 100 : i ? 152 : 136) / 4;
    const musicLen = musicModes.reduce((a, [m, i]) => a + sdOf(m, i) * 16 * bars, 0) + 1;
    const len = musicStart + musicLen;
    const ctx = new OfflineAudioContext(2, Math.ceil(SR * len), SR);
    const s = new Sound(); s.init(ctx, true);
    list.forEach(([, fn], i) => { s.at = i * gap + 0.2; fn(s); });
    s.at = 0;
    let t = musicStart;
    for (const [mode, intense] of musicModes) {
      s.music.mode = mode; s.music.intense = intense;
      const sd = sdOf(mode, intense);
      for (let st = 0; st < 16 * bars; st++) s.playStep(st, t + st * sd, sd);
      t += sd * 16 * bars;
    }
    // engine sweep while the music plays: idle -> full speed -> boost -> drift
    const e = s.eng; const at = (x) => musicStart + x;
    e.out.gain.setValueAtTime(0.1, at(0)); e.out.gain.setValueAtTime(0.0, at(0) + 0.01);
    const buf = await ctx.startRendering();
    const L = buf.getChannelData(0), R = buf.getChannelData(1);
    const seg = (a, d) => { let pk = 0, sq = 0, n = 0; for (let i = Math.floor(a * SR); i < Math.min(L.length, (a + d) * SR); i++) { const v = Math.max(Math.abs(L[i]), Math.abs(R[i])); pk = Math.max(pk, v); sq += L[i] * L[i] + R[i] * R[i]; n += 2; } return { peak: pk, rms: Math.sqrt(sq / Math.max(1, n)) }; };
    const report = list.map(([name], i) => ({ name, ...seg(i * gap + 0.2, gap - 0.2) }));
    let mt = musicStart; const music = musicModes.map(([m, i]) => { const d = sdOf(m, i) * 16 * bars; const r = { name: `music ${m}${i ? ' (last 30 s)' : ''}`, ...seg(mt, d) }; mt += d; return r; });
    // 16-bit PCM for the WAV
    const pcm = new Int16Array(L.length * 2);
    for (let i = 0; i < L.length; i++) { pcm[i * 2] = Math.max(-1, Math.min(1, L[i])) * 32767; pcm[i * 2 + 1] = Math.max(-1, Math.min(1, R[i])) * 32767; }
    let bin = ''; const u8 = new Uint8Array(pcm.buffer); for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return { report: [...report, ...music], pcm: btoa(bin), len, gap, list: list.map((x) => x[0]) };
  });
  const db = (v) => (v > 0 ? (20 * Math.log10(v)).toFixed(1) : '-inf');
  for (const r of res.report) console.log(`${r.name.padEnd(26)} peak ${db(r.peak).padStart(6)} dBFS   rms ${db(r.rms).padStart(6)} dBFS${r.peak < 0.01 ? '   <-- SILENT' : ''}`);
  const out = process.argv[2] || 'scratch/audio/demo.wav';
  const data = Buffer.from(res.pcm, 'base64'), h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22);
  h.writeUInt32LE(44100, 24); h.writeUInt32LE(44100 * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(out, Buffer.concat([h, data]));
  console.log(`wrote ${out} (${res.len.toFixed(1)} s); effects every ${res.gap} s in this order: ${res.list.join(' / ')}`);
  console.log('errors', errs);
  await b.close(); srv.close();
});
