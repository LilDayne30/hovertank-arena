// Progression end-to-end against wrangler dev (start it with a short match):
//   npx wrangler dev --var MATCH_SECONDS:12   then   URL=http://localhost:8787 node test/profile.mjs
// Two bot players with profiles play one match; checks XP/missions after the match, look validation
// (locked items are refused), roster carrying looks, daily reroll, transfer codes and auth errors.
const URL = process.env.URL || 'http://localhost:8787';
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) process.exitCode = 1; };
const api = async (path, { token, body, method } = {}) => {
  const r = await fetch(`${URL}/api/profile${path}`, {
    method: method || (body ? 'POST' : 'GET'),
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, data: await r.json().catch(() => null) };
};

const A = (await api('/new', { body: {} })).data, B = (await api('/new', { body: {} })).data;
ok(A.token && A.profile.level === 1 && A.profile.xp === 0, `new profile: Lv${A.profile.level}, ${A.profile.xp} XP, dailies ${A.profile.daily.ids.join(',')}`);
ok((await api('')).status === 401, 'no token -> 401');

// look: locked items are dropped, owned ones kept
let v = (await api('/look', { token: A.token, body: { look: { paint: 'red', turret: 'king', pattern: 'stripe', emblem: 'nope' } } })).data;
ok(v.look.paint === 'red' && v.look.turret === 'std' && v.look.pattern === 'none' && v.look.emblem === 'none', `look validated: ${JSON.stringify({ paint: v.look.paint, turret: v.look.turret, pattern: v.look.pattern })}`);

// reroll once
const r1 = (await api('/reroll', { token: A.token, body: { index: 0 } })).data;
const r2 = (await api('/reroll', { token: A.token, body: { index: 1 } })).data;
ok(r1.daily.rerolled && r1.daily.ids[0] !== A.profile.daily.ids[0] && JSON.stringify(r2.daily.ids) === JSON.stringify(r1.daily.ids), `reroll: ${A.profile.daily.ids[0]} -> ${r1.daily.ids[0]}, second reroll refused`);

// one match with two bots
const { id } = await (await fetch(`${URL}/api/rooms`, { method: 'POST' })).json();
const bot = (name, token, fire) => new Promise((resolve) => {
  const ws = new WebSocket(`${URL.replace(/^http/, 'ws')}/api/rooms/${id}/ws?name=${name}`);
  const st = { ws, prog: null, roster: null, result: null, seq: 0 };
  ws.onopen = () => { ws.send(JSON.stringify(['prof', token])); resolve(st); };
  ws.onmessage = (ev) => {
    const [t, d] = JSON.parse(ev.data);
    if (t === 'prog') st.prog = d;
    if (t === 'roster') st.roster = d;
    if (t === 'result') st.result = d;
  };
  st.timer = setInterval(() => {
    const batch = [0, 1].map(() => ({ seq: ++st.seq, mx: Math.sin(st.seq / 40), mz: -1, ay: 0, ap: 0, j: st.seq % 50 === 0, d: false, f: fire }));
    try { ws.send(JSON.stringify(['i', batch])); } catch { /* closed */ }
  }, 66);
});
const ba = await bot('alice', A.token, true), bb = await bot('bob', B.token, false);
await new Promise((r) => setTimeout(r, 1500));
const rp = bb.roster.players.find((p) => p.name === 'alice');
ok(rp && rp.lv === 1 && rp.look?.paint === 'red', `roster carries level + look (alice: Lv${rp?.lv}, paint ${rp?.look?.paint})`);
for (let i = 0; i < (Number(process.env.WAIT) || 20) * 2 && !(ba.prog && bb.prog); i++) await new Promise((r) => setTimeout(r, 500));
ok(!!ba.result, 'match ended');
ok(ba.prog && ba.prog.gained > 0, `alice earned ${ba.prog?.gained} XP: ${JSON.stringify(ba.prog?.lines)}`);
ok(bb.prog && bb.prog.gained > 0, `bob (only drove) earned ${bb.prog?.gained} XP (base XP): ${JSON.stringify(bb.prog?.lines)}`);
for (const s of [ba, bb]) { clearInterval(s.timer); s.ws.close(); }

const va = (await api('', { token: A.token })).data;
ok(va.xp === ba.prog.gained && va.stats.matches === 1 && va.ach.find((a) => a.id === 'play1').done, `saved: ${va.xp} XP, matches ${va.stats.matches}, title 新兵 unlocked, Lv${va.level} (${va.into}/${va.need})`);
ok(va.owned.includes('title:play1') && va.owned.includes('emblem:heart'), 'achievement rewards owned (title 新兵, emblem heart)');
const played = va.daily.ids.filter((x) => /^play/.test(x));
console.log('      daily progress:', JSON.stringify(va.daily.prog), played.length ? `(play mission ${played})` : '');

// transfer
const t = (await api('/transfer', { token: A.token, body: {} })).data;
ok(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(t.code), `transfer code issued: ${t.code.slice(0, 2)}**-****`);
const red = (await api('/redeem', { body: { code: t.code.toLowerCase().replace('-', ' ') } })).data;
ok(red.token === A.token && red.profile.xp === va.xp, 'code redeemed on "another device": same profile');
ok((await api('/redeem', { body: { code: t.code } })).status === 404, 'code is single-use');
process.exit();
