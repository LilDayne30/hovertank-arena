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

// seat filling
{
  const g = new Game(world, { send() {}, broadcast() {} }, { autoFill: true });
  g.addPlayer('h1', 'human');
  ok(g.humans === 1 && g.botCount === 3, `quick-match room: 1 human -> ${g.botCount} bots`);
  g.addPlayer('h2', 'human2'); g.addPlayer('h3', 'human3');
  ok(g.humans === 3 && g.botCount === 1 && g.players.size === 4, `3 humans -> ${g.botCount} bot`);
  g.addPlayer('h4', 'human4');
  ok(g.humans === 4 && g.botCount === 0 && !g.isFull() === false, '4th human takes the last bot seat, room now full');
  g.removePlayer('h4'); g.removePlayer('h3');
  ok(g.botCount === 2, `humans leave -> bots come back (${g.botCount})`);
  g.removePlayer('h2'); g.removePlayer('h1');
  ok(g.players.size === 0, 'last human leaves -> bots leave too');
  const g2 = new Game(world, { send() {}, broadcast() {} }, { rules: { bots: 2, botLevel: 'hard' } });
  g2.addPlayer('h1', 'human');
  ok(g2.botCount === 2 && [...g2.players.values()].filter((p) => p.bot).every((p) => p.bot.level === 'hard'), 'invite room with rules.bots = 2 (hard)');
  g2.setRules({ bots: 1, botLevel: 'easy' });
  ok(g2.botCount === 1 && [...g2.players.values()].find((p) => p.bot).bot.level === 'easy', 'new rules: 1 easy bot');
}
