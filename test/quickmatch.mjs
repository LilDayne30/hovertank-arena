// Quick match: players are packed into public rooms (fullest first), a 5th player gets a new
// room, mode preference is respected, private rooms are never matched, and an emptied room
// disappears from the list.
const URL = process.env.URL || 'http://localhost:8787';
const ws = URL.replace(/^http/, 'ws');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const qm = async (mode, exclude = []) => (await (await fetch(`${URL}/api/quickmatch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode, exclude }) })).json()).id;
const join = (id, name) => new Promise((res, rej) => {
  const s = new WebSocket(`${ws}/api/rooms/${id}/ws?name=${name}`);
  s.onmessage = (e) => { const [t, d] = JSON.parse(e.data); if (t === 'welcome') res({ s, id, d }); if (t === 'error') rej(Object.assign(new Error(d.code), { code: d.code })); };
});
const quickJoin = async (mode, name) => {
  const tried = [];
  for (let i = 0; i < 4; i++) { const id = await qm(mode, tried); try { return await join(id, name); } catch (e) { if (e.code !== 'full') throw e; tried.push(id); } }
  throw new Error('no room');
};
const stats = async () => (await fetch(`${URL}/api/stats`)).json();

const before = await stats();
// a private room with free seats must not receive quick-match players
const priv = (await (await fetch(`${URL}/api/rooms`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json()).id;
const owner = await join(priv, 'owner');

const ffa = [];
for (let i = 0; i < 5; i++) ffa.push(await quickJoin('ffa', `f${i}`));
const rooms = [...new Set(ffa.map((c) => c.id))];
console.log('5 free-for-all players ->', rooms.length, 'rooms; first room has', ffa.filter((c) => c.id === rooms[0]).length, 'players | public flag:', ffa[0].d.public, '| private room used:', rooms.includes(priv));
const team = [await quickJoin('team', 't0'), await quickJoin('team', 't1')];
console.log('2 team-mode players -> same room:', team[0].id === team[1].id, '| room rules:', team[0].d.rules.mode, '| separate from ffa rooms:', !rooms.includes(team[0].id));
const any = await quickJoin('any', 'a0');
console.log('"any" player joined an existing room (fullest with space):', [...rooms, team[0].id].includes(any.id), any.id === team[0].id ? '(team room, 2 players)' : '(ffa room)');
console.log('stats:', JSON.stringify(await stats()), 'before:', JSON.stringify(before));

// parallel rush: 8 players at once must never overfill a room
const rush = await Promise.all(Array.from({ length: 8 }, (_, i) => quickJoin('ffa', `r${i}`).catch((e) => ({ err: e.message }))));
const counts = {}; for (const c of rush) if (c.id) counts[c.id] = (counts[c.id] || 0) + 1;
console.log('8 players at the same time:', rush.filter((c) => c.err).length, 'failed | per-room joins', JSON.stringify(counts));

// everyone leaves -> rooms vanish from the list
for (const c of [...ffa, ...team, any, ...rush.filter((c) => c.s), owner]) { c.s.send(JSON.stringify(['leave', 1])); c.s.close(); }
await sleep(1500);
console.log('after everyone left:', JSON.stringify(await stats()));
process.exit(0);
