// CPU players fighting each other in the real game logic (no server needed).
//   node test/bots-ai.mjs
// Checks they actually fight (shots, hits, kills), don't get stuck, use drift/heal, and that the
// strength levels differ (hard beats easy).
import { readFileSync } from 'node:fs';
import { makeWorld, DT } from '../shared/sim.js';
import { SPAWNS, applyObstacles } from '../shared/arena.js';
import { Game } from '../shared/game.js';

const meta = JSON.parse(readFileSync('public/assets/arena_hf.json'));
const buf = readFileSync('public/assets/arena_hf.bin');
const world = makeWorld(meta, new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4));
world.spawns = SPAWNS; applyObstacles(world);
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) process.exitCode = 1; };

function run(levels, seconds, rules = {}) {
  const g = new Game(world, { send() {}, broadcast() {} }, { matchSeconds: 9999, rules });
  const bots = levels.map((l) => g.addBot(l));
  const st = new Map(bots.map((b) => [b.id, { stuck: 0, still: 0, boosts: 0, heals: 0, shots: 0, maxCorner: 0 }]));
  const ticks = Math.round(seconds / DT);
  for (let i = 0; i < ticks; i++) {
    g.step();
    for (const b of bots) {
      const s = st.get(b.id);
      if (!b.alive) continue;
      const sp = Math.hypot(b.tank.vx, b.tank.vz);
      if (sp < 1.0) s.still++; else s.still = 0;
      if (s.still > 90) { s.stuck++; s.still = 0; }   // 3 s without moving
    }
  }
  return { g, bots, st, ticks };
}

// strength by level (quick match): Lv1 weaker than Lv50
{
  const { skillForLevel, botParams } = await import('../shared/bot.js');
  const lo = botParams(skillForLevel(1)), mid = botParams(skillForLevel(25)), hi = botParams(skillForLevel(50));
  ok(lo.aimErr > mid.aimErr && mid.aimErr > hi.aimErr, `aim spread by level: Lv1 ${lo.aimErr.toFixed(2)} m, Lv25 ${mid.aimErr.toFixed(2)} m, Lv50 ${hi.aimErr.toFixed(2)} m`);
}

// 4 normal bots, 3 minutes
{
  const { bots, st } = run(['normal', 'normal', 'normal', 'normal'], 180);
  const k = bots.map((b) => b.m.kills), sh = bots.map((b) => b.m.shots), hits = bots.map((b) => b.m.hits);
  const acc = hits.reduce((a, b) => a + b, 0) / Math.max(1, sh.reduce((a, b) => a + b, 0));
  console.log('      kills', k, 'shots', sh, 'hits', hits, `accuracy ${(acc * 100).toFixed(0)}%`, 'turbos', bots.map((b) => b.m.turbo), 'heals', bots.map((b) => b.m.heals), 'jumps', bots.map((b) => b.m.jumps));
  ok(k.reduce((a, b) => a + b, 0) >= 12, `4 normal bots fight: ${k.reduce((a, b) => a + b, 0)} kills in 3 min`);
  ok(acc > 0.1 && acc < 0.7, `accuracy is human-like (${(acc * 100).toFixed(0)}%)`);
  ok(bots.every((b) => b.m.moved > 400), `all bots keep moving (${bots.map((b) => Math.round(b.m.moved)).join(', ')} m)`);
  ok([...st.values()].every((s) => s.stuck <= 2), `no bot stood still for 3 s more than twice (${[...st.values()].map((s) => s.stuck).join(', ')})`);
  ok(bots.some((b) => b.m.turbo > 0), 'normal bots use drift turbo');
}

// hard vs easy, 1v1, several runs
{
  let hard = 0, easy = 0;
  for (let r = 0; r < 4; r++) {
    const { bots } = run(['hard', 'easy'], 90);
    hard += bots[0].m.kills; easy += bots[1].m.kills;
  }
  ok(hard > easy * 1.5, `hard beats easy (kills over 4 x 90 s: hard ${hard}, easy ${easy})`);
}

// team mode: no friendly fire, teams fight each other
{
  const { bots, g } = run(['normal', 'normal', 'normal', 'normal'], 120, { mode: 'team' });
  const teams = bots.map((b) => b.team);
  ok(teams.filter((t) => t === 0).length === 2, `team mode: bots split 2 v 2 (${teams})`);
  ok(g.teamKills().reduce((a, b) => a + b, 0) >= 6, `team mode kills ${JSON.stringify(g.teamKills())}`);
}

// seat filling (quick match): wait for people, then bots fill; nobody joins a match in progress
{
  const steps = (g, sec) => { for (let i = 0; i < sec / DT; i++) g.step(); };
  const g = new Game(world, { send() {}, broadcast() {} }, { autoFill: true, matchSeconds: 20 });
  g.addPlayer('h1', 'human');
  ok(g.phase === 'wait' && g.botCount === 0 && g.open, `fresh quick-match room waits for people first (phase ${g.phase}, open ${g.open})`);
  g.addPlayer('h2', 'human2');
  steps(g, 5.2);
  ok(g.phase === 'play' && g.humans === 2 && g.botCount === 2, `after the ${g.waitSeconds} s wait: 2 people + ${g.botCount} bots, match started`);
  ok(!g.open, 'room is closed to quick match while the match is on');
  g.removePlayer('h2');
  ok(g.botCount === 2 && g.players.size === 3, 'a person leaving mid-match: seat stays empty (no bot pops in)');
  steps(g, 20.5);
  ok(g.phase === 'end' && g.open, 'between matches the room opens again');
  g.addPlayer('h3', 'newcomer');
  ok(g.humans === 2 && g.players.size <= 4, `newcomer joins during the result screen (${g.humans} people, ${g.botCount} bots)`);
  steps(g, 10.5);
  ok(g.phase === 'play' && g.players.size === 4 && g.botCount === 2, `next match starts full: ${g.humans} people + ${g.botCount} bots`);
  g.removePlayer('h1'); g.removePlayer('h3');
  ok(g.players.size === 0, 'last person leaves -> bots leave too');

  // full of people during the wait: starts at once
  const gf = new Game(world, { send() {}, broadcast() {} }, { autoFill: true, rules: { size: 2 } });
  gf.addPlayer('a', 'a'); gf.addPlayer('b', 'b');
  ok(gf.phase === 'play' && gf.botCount === 0, '2 people for a 1対1: starts immediately without bots');

  // quick match with a chosen size; bots look like players and follow the people's level
  let roster = null;
  const g3 = new Game(world, { send() {}, broadcast: (t, d) => { if (t === 'roster') roster = d; } }, { autoFill: true, rules: { size: 2 } });
  g3.addPlayer('h1', 'human');
  g3.setProfile('h1', { key: 'x', lv: 45, look: null });
  steps(g3, 5.2);
  ok(g3.players.size === 2 && g3.botCount === 1, `quick match size 2 (1対1): ${g3.humans} human + ${g3.botCount} bot`);
  const rb = roster.players.find((p) => p.id !== 'h1');
  ok(rb.bot === undefined && rb.lv >= 1 && !/CPU/.test(rb.name), `quick-match bot is not labelled as CPU (name ${rb.name}, Lv${rb.lv})`);
  const bot = [...g3.players.values()].find((p) => p.bot);
  ok(bot.bot.skill > 0.7 && Math.abs(bot.prof.lv - 45) <= 3, `bot matches a Lv45 player: skill ${bot.bot.skill.toFixed(2)} (shown as Lv${bot.prof.lv})`);
  const g4 = new Game(world, { send() {}, broadcast() {} }, { autoFill: true, rules: { size: 3 } });
  g4.addPlayer('h1', 'a'); steps(g4, 5.2);
  ok(g4.players.size === 3, `quick match size 3: ${g4.players.size} tanks`);
  const g2 = new Game(world, { send() {}, broadcast() {} }, { rules: { bots: 2, botLevel: 'hard' } });
  g2.addPlayer('h1', 'human');
  ok(g2.botCount === 2 && [...g2.players.values()].filter((p) => p.bot).every((p) => p.bot.level === 'hard'), 'invite room with rules.bots = 2 (hard)');
  g2.setRules({ bots: 1, botLevel: 'easy' });
  ok(g2.botCount === 1 && [...g2.players.values()].find((p) => p.bot).bot.level === 'easy', 'new rules: 1 easy bot');
  ok([...g2.players.values()].find((p) => p.bot).prof.bot === true, 'private-room bots keep the CPU label');
}
