// Quick match by size (2 / 3 / 4 tanks) against wrangler dev.   URL=http://localhost:8787 node test/quickmatch-size.mjs
const URL = process.env.URL || 'http://localhost:8787';
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) process.exitCode = 1; };
const socks = [];
async function join(mode, size, name, goal, target) {
  const { id } = await (await fetch(`${URL}/api/quickmatch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode, size, goal, target }) })).json();
  const ws = new WebSocket(`${URL.replace(/^http/, 'ws')}/api/rooms/${id}/ws?name=${name}`);
  const st = { id, ws, roster: null };
  ws.onmessage = (e) => { const [t, d] = JSON.parse(e.data); if (t === 'roster') st.roster = d; };
  await new Promise((r) => { ws.onopen = r; });
  await new Promise((r) => setTimeout(r, 400));
  socks.push(st);
  return st;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const a = await join('ffa', 2, 'a');
ok(a.roster.players.length === 1, 'size 2: alone at first (gathering players for 5 s)');
const b = await join('ffa', 2, 'b');
ok(b.id === a.id, 'second size-2 player arriving during the wait joins the same room');
await wait(400);
ok(a.roster.players.length === 2 && a.roster.players.every((p) => ['a', 'b'].includes(p.name)), `1対1 filled by people -> starts at once: ${a.roster.players.map((p) => p.name).join(', ')}`);
const c = await join('ffa', 2, 'c');
ok(c.id !== a.id, 'third size-2 player gets a new room');
await wait(5600);
ok(c.roster.players.length === 2 && c.roster.players.every((p) => !p.bot), `after the wait a bot fills the seat, not marked as CPU (${c.roster.players.map((p) => p.name).join(', ')})`);
const c2 = await join('ffa', 2, 'c2');
ok(c2.id !== c.id, 'no joining a match in progress: next size-2 player gets another room');
const d = await join('ffa', 3, 'd');
ok(![a.id, c.id, c2.id].includes(d.id), 'size 3 is a separate room');
const f = await join('team', 2, 'f');
ok(f.roster.rules.mode === 'team' && f.roster.rules.size === 4, 'team battle is always 2 v 2 (size request ignored)');
// win condition: only people who picked the same one meet
const q1 = await join('ffa', 4, 'q1', 'kills', 10), q2 = await join('any', 4, 'q2', 'kills', 10), q3 = await join('ffa', 4, 'q3', 'kills', 5), t1 = await join('ffa', 4, 't1');
ok(q1.id === q2.id, 'two players who chose "first to 10 kills" meet in the same room');
ok(q1.roster.rules.goal === 'kills' && q1.roster.rules.target === 10, `that room's rules: ${JSON.stringify(q1.roster.rules)}`);
ok(q3.id !== q1.id && q3.roster.rules.target === 5, '"first to 5 kills" is a separate room');
ok(t1.id !== q1.id && t1.roster.rules.goal === 'time', '5-minute players do not land in the kill-target room');
await wait(5600);
ok(d.roster.players.length === 3 && f.roster.players.length === 4, `after the wait: size-3 room ${d.roster.players.length} tanks, team room ${f.roster.players.length}`);
for (const s of socks) { s.ws.send(JSON.stringify(['leave', 1])); s.ws.close(); }
await new Promise((r) => setTimeout(r, 800));
console.log('stats after leaving', await (await fetch(`${URL}/api/stats`)).json());
process.exit();
