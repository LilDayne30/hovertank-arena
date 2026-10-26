// Quick match by size (2 / 3 / 4 tanks) against wrangler dev.   URL=http://localhost:8787 node test/quickmatch-size.mjs
const URL = process.env.URL || 'http://localhost:8787';
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) process.exitCode = 1; };
const socks = [];
async function join(mode, size, name) {
  const { id } = await (await fetch(`${URL}/api/quickmatch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode, size }) })).json();
  const ws = new WebSocket(`${URL.replace(/^http/, 'ws')}/api/rooms/${id}/ws?name=${name}`);
  const st = { id, ws, roster: null };
  ws.onmessage = (e) => { const [t, d] = JSON.parse(e.data); if (t === 'roster') st.roster = d; };
  await new Promise((r) => { ws.onopen = r; });
  await new Promise((r) => setTimeout(r, 400));
  socks.push(st);
  return st;
}
const a = await join('ffa', 2, 'a');
ok(a.roster.players.length === 2 && a.roster.rules.size === 2, `size 2: alone -> ${a.roster.players.length} tanks (${a.roster.players.map((p) => p.name).join(', ')})`);
ok(a.roster.players.every((p) => !p.bot), 'quick-match roster does not mark anyone as CPU');
const b = await join('ffa', 2, 'b');
ok(b.id === a.id, 'second size-2 player joins the same room (takes the bot seat)');
await new Promise((r) => setTimeout(r, 300));
ok(a.roster.players.length === 2 && a.roster.players.every((p) => ['a', 'b'].includes(p.name)), `room now: ${a.roster.players.map((p) => p.name).join(', ')}`);
const c = await join('ffa', 2, 'c');
ok(c.id !== a.id, 'third size-2 player gets a new room (1対1 is full)');
const d = await join('ffa', 3, 'd');
ok(d.id !== a.id && d.id !== c.id && d.roster.players.length === 3, `size 3 is a separate room with ${d.roster.players.length} tanks`);
const e = await join('any', 4, 'e');
ok(![a.id, c.id, d.id].includes(e.id) && e.roster.players.length === 4, `size 4 ("どちらでも") -> its own 4-tank room`);
const f = await join('team', 2, 'f');
ok(f.roster.rules.mode === 'team' && f.roster.rules.size === 4 && f.roster.players.length === 4, 'team battle is always 2 v 2 (size request ignored)');
for (const s of socks) { s.ws.send(JSON.stringify(['leave', 1])); s.ws.close(); }
await new Promise((r) => setTimeout(r, 800));
console.log('stats after leaving', await (await fetch(`${URL}/api/stats`)).json());
process.exit();
