// Run the server with MATCH_SECONDS=8 to check the end-of-match flow:  play -> result (10 s) -> play
import { Client } from '@colyseus/sdk';
const c = new Client(process.env.URL || 'http://localhost:2567');
const r = await c.create('battle', { name: 'm' });
const phases = []; let result = null; const t0 = Date.now();
r.onMessage('s', (m) => { if (phases[phases.length - 1]?.ph !== m.ph) phases.push({ ph: m.ph, at: ((Date.now() - t0) / 1000).toFixed(1), tl: m.tl }); });
r.onMessage('result', (m) => { result = m; });
r.onMessage('welcome', () => {}); r.onMessage('roster', () => {});
await new Promise((res) => setTimeout(res, 21000));
console.log('phase changes:', JSON.stringify(phases));
console.log('result message:', JSON.stringify(result));
await r.leave(); process.exit(0);
