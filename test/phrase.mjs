// Private rooms by passphrase (合言葉) against wrangler dev.   URL=http://localhost:8787 node test/phrase.mjs
const URL = process.env.URL || 'http://localhost:8787';
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) process.exitCode = 1; };
const socks = [];
const claim = async (phrase, rules) => { const r = await fetch(`${URL}/api/phrase`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phrase, rules }) }); return { status: r.status, ...(await r.json()) }; };
async function join(id, name) {
  const ws = new WebSocket(`${URL.replace(/^http/, 'ws')}/api/rooms/${id}/ws?name=${name}`);
  const st = { ws, roster: null, welcome: null };
  ws.onmessage = (e) => { const [t, d] = JSON.parse(e.data); if (t === 'roster') st.roster = d; if (t === 'welcome') st.welcome = d; };
  await new Promise((r) => { ws.onopen = r; });
  await new Promise((r) => setTimeout(r, 400));
  socks.push(st); return st;
}
const tag = Math.random().toString(36).slice(2, 6);
const a = await claim(`たこやき${tag}`, { mode: 'team', goal: 'kills', target: 5, bots: 1, botLevel: 'hard' });
ok(a.status === 200 && a.created && /^P[A-Z2-9]{9}$/.test(a.id), `new phrase makes a room (${a.id})`);
const A = await join(a.id, 'Alice');
ok(A.welcome?.phrase === `たこやき${tag}` && A.roster.rules.mode === 'team' && A.roster.rules.target === 5, `room has the first person's rules (${JSON.stringify(A.roster.rules)}) and knows its phrase`);
const b = await claim(` タコヤキ${tag.toUpperCase()} `, { mode: 'ffa' });
ok(b.id === a.id && !b.created && b.rules.mode === 'team', 'same phrase (katakana / upper case / spaces) -> same room, keeps its rules');
const c = await claim(`ﾀｺﾔｷ${tag}`, null);
ok(c.id === a.id, 'half-width katakana also matches');
const d = await claim(`たこやき${tag}!`, null);
ok(d.id !== a.id && d.created, 'a different phrase is a different room');
ok((await claim('あ', null)).status === 400 && (await claim('x'.repeat(17), null)).status === 400, 'too short / too long phrases are refused');
// fill the room: Alice + 1 hard bot; 3 more people -> 4 humans (bot leaves), 5th is refused
for (const n of ['B', 'C', 'D']) await join(a.id, n);
await new Promise((r) => setTimeout(r, 500));
ok(A.roster.players.length === 4 && A.roster.players.every((p) => !p.bot), `4 people inside, the CPU gave up its seat (${A.roster.players.map((p) => p.name).join(', ')})`);
const e = await claim(`たこやき${tag}`, null);
ok(e.status === 409 && e.error === 'full', 'fifth person: room full');
// everyone leaves -> the phrase can be used again with new rules
for (const s of socks) { s.ws.send(JSON.stringify(['leave', 1])); s.ws.close(); }
await new Promise((r) => setTimeout(r, 16000));   // the 15 s "someone is on the way" hold has passed
const f = await claim(`たこやき${tag}`, { mode: 'ffa', goal: 'time' });
ok(f.id === a.id && f.created && f.rules.mode === 'ffa', 'empty room is remade with the next person\'s rules');
process.exit();
