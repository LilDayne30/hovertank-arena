// Headless protocol test: N SDK clients join one room, drive & shoot, verify sync/hits/full-room.
import { Client } from '@colyseus/sdk';
const URL = process.env.URL || 'http://localhost:2567';
const N = 4;
const c = new Client(URL);
const rooms = [];
const stats = {};
const first = await c.create('battle', { name: 'bot0' });
rooms.push(first);
for (let i = 1; i < N; i++) rooms.push(await c.joinById(first.roomId, { name: 'bot' + i }));
let full = null;
try { await c.joinById(first.roomId, { name: 'extra' }); full = 'JOINED (unexpected)'; } catch (e) { full = `${e.code} ${e.message}`; }
rooms.forEach((r, i) => {
  stats[i] = { snaps: 0, hits: 0, kills: 0, last: null };
  r.onMessage('s', (m) => { stats[i].snaps++; stats[i].last = m; for (const e of m.e) { if (e.t === 'hit') stats[i].hits++; if (e.t === 'kill') stats[i].kills++; } });
  r.onMessage('welcome', () => {}); r.onMessage('roster', () => {}); r.onMessage('result', () => {});
});
// bots 1..3 sit still, bot 0 aims at bot 1 and fires
let seq = 0; const start = Date.now();
const iv = setInterval(() => {
  seq++;
  const s = stats[0].last; if (!s) return;
  const me = s.p.find((p) => p[0] === rooms[0].sessionId), tgt = s.p.find((p) => p[0] === rooms[1].sessionId);
  const ay = Math.atan2(-(tgt[1] - me[1]), -(tgt[3] - me[3]));
  rooms[0].send('i', [{ seq, mx: 0, mz: 0, ay, ap: 0.07, j: false, d: false, f: true }]);
  rooms.slice(1).forEach((r, k) => r.send('i', [{ seq, mx: k === 1 ? 1 : 0, mz: 0, ay: 0, ap: 0, j: seq % 40 === 0, d: k === 1, f: false }]));
}, 1000 / 30);
await new Promise((r) => setTimeout(r, 8000));
clearInterval(iv);
const s = stats[0].last;
console.log('room', first.roomId, 'full-room join ->', full);
console.log('snapshots per client', Object.values(stats).map((x) => x.snaps));
console.log('hit events seen by each client', Object.values(stats).map((x) => x.hits), 'kills', Object.values(stats).map((x) => x.kills));
console.log('players', JSON.stringify(s.p.map((p) => ({ x: p[1], y: p[2], z: p[3], hp: p[10], k: p[15], d: p[16], seq: p[12] }))));
// consistency: all clients' last snapshot tick close
console.log('last tick per client', Object.values(stats).map((x) => x.last.k));
// disconnect test
const drop = rooms[3]; const sid = drop.sessionId;
drop.connection.transport.ws?.close?.(); // abrupt (not consented)
await new Promise((r) => setTimeout(r, 1500));
const after = stats[0].last.p.find((p) => p[0] === sid);
console.log('after abrupt drop: still listed', !!after, 'connected flag', after ? !!(after[11] & 8) : null);
for (const r of rooms.slice(0, 3)) await r.leave();
process.exit(0);
