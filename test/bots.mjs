// Protocol test with 4 raw WebSocket clients (no browser):
// join one room, drive/jump/shoot, check identical snapshots, hits/kills, full room, reconnection.
//   URL=http://localhost:8787 node test/bots.mjs
const URL = process.env.URL || 'http://localhost:8787';
const wsBase = URL.replace(/^http/, 'ws');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(roomId, name, token) {
  return new Promise((resolve, reject) => {
    const q = new URLSearchParams(); if (name) q.set('name', name); if (token) q.set('token', token);
    const ws = new WebSocket(`${wsBase}/api/rooms/${roomId}/ws?${q}`);
    const c = { ws, name, snaps: [], hits: 0, kills: 0, unshield: [], welcome: null, last: null, roster: [] };
    ws.onmessage = (ev) => {
      const [t, d] = JSON.parse(ev.data);
      if (t === 'error') { reject(Object.assign(new Error(d.code), { code: d.code })); ws.close(); }
      if (t === 'welcome') { c.welcome = d; resolve(c); }
      if (t === 'roster') c.roster = d.players || d;
      if (t === 's') { c.snaps.push(d.k); c.last = d; for (const e of d.e) { if (e.t === 'hit') c.hits++; if (e.t === 'kill') c.kills++; if (e.t === 'unshield') c.unshield.push(e.v); } }
    };
    ws.onerror = () => reject(new Error('ws error'));
  });
}

const { id: roomId } = await (await fetch(`${URL}/api/rooms`, { method: 'POST' })).json();
const bots = [];
for (let i = 0; i < 4; i++) bots.push(await connect(roomId, `bot${i}`));
let full; try { await connect(roomId, 'extra'); full = 'JOINED (unexpected)'; } catch (e) { full = e.code; }
const info = await (await fetch(`${URL}/api/rooms/${roomId}`)).json();
let nf; try { await connect('NOSUCH', 'x'); nf = 'JOINED (unexpected)'; } catch (e) { nf = e.code; }

let seq = 0;
const iv = setInterval(() => {
  seq++;
  const s = bots[0].last; if (!s) return;
  const me = s.p.find((p) => p[0] === bots[0].welcome.id), tgt = s.p.find((p) => p[0] === bots[3].welcome.id);   // clear line of fire (the centre mesa blocks the diagonal)
  const ay = Math.atan2(-(tgt[1] - me[1]), -(tgt[3] - me[3]));
  bots[0].ws.send(JSON.stringify(['i', [{ seq, mx: 0, mz: 0, ay, ap: 0.07, j: false, d: false, f: true }]]));
  bots.slice(1).forEach((b, k) => b.ws.readyState === 1 && b.ws.send(JSON.stringify(['i', [{ seq, mx: k === 1 ? 1 : 0, mz: 0, ay: 0, ap: 0, j: seq % 40 === 0, d: k === 1, f: false }]])));
}, 1000 / 30);
await sleep(8000);
clearInterval(iv);

const common = bots[0].snaps.filter((k) => bots.every((b) => b.snaps.includes(k)));
console.log('room', roomId, '| info', JSON.stringify(info));
console.log('5th client ->', full, '| unknown room ->', nf);
console.log('snapshots received per client in 8 s:', bots.map((b) => b.snaps.length), '(30/s expected)');
console.log('ticks received by all 4:', common.length);
console.log('hit events per client', bots.map((b) => b.hits), 'kills', bots.map((b) => b.kills));
console.log('spawn shield removed because the shooter fired:', bots[1].unshield.includes(bots[0].welcome.id) ? 'yes (bot0)' : 'NO', '| non-shooters kept their shield:', !bots[1].unshield.some((id) => id !== bots[0].welcome.id));
console.log('players', JSON.stringify(bots[0].last.p.map((p) => ({ x: p[1], z: p[3], hp: p[10], k: p[15], d: p[16], seq: p[12] }))));

// abrupt disconnect + reconnect with the seat token
const d = bots[3]; const token = d.welcome.token; const id = d.welcome.id;
d.ws.close(3000, 'simulated drop');
await sleep(1000);
const r0 = bots[0].roster.find((p) => p.id === id);
const back = await connect(roomId, null, token);
await sleep(500);
console.log('after drop: listed', !!r0, 'connected', r0?.connected, '| reconnect same id:', back.welcome.id === id, 'reconnected flag', back.welcome.reconnected);
for (const b of [...bots.slice(0, 3), back]) { b.ws.send(JSON.stringify(['leave', 1])); b.ws.close(); }
await sleep(500);
const info2 = await (await fetch(`${URL}/api/rooms/${roomId}`)).json();
console.log('after everyone left:', JSON.stringify(info2));
process.exit(0);
