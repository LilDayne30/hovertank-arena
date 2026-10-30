// After a match: no automatic restart. Private rooms start when every person is ready; the ready
// ones get "free fire" that counts for nothing. Quick-match rooms stay finished.   node test/result-flow.mjs
import { readFileSync } from 'node:fs';
import { makeWorld, DT, C } from '../shared/sim.js';
import { SPAWNS, applyObstacles } from '../shared/arena.js';
import { Game } from '../shared/game.js';
const meta = JSON.parse(readFileSync('public/assets/arena_hf.json'));
const buf = readFileSync('public/assets/arena_hf.bin');
const world = makeWorld(meta, new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4));
world.spawns = SPAWNS; applyObstacles(world);
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) process.exitCode = 1; };
const run = (g, sec, inputs = {}) => { const seq = {}; for (let i = 0; i < sec / DT; i++) { for (const [id, f] of Object.entries(inputs)) { seq[id] = (seq[id] || 0) + 1; g.onInput(id, [{ seq: g.players.get(id).lastQueued + 1, mx: 0, mz: 0, ay: 0, ap: 0, ...f(i) }]); } for (const p of g.players.values()) if (!p.bot && !inputs[p.id]) g.onInput(p.id, [{ seq: p.lastQueued + 1, mx: 0, mz: 0, ay: 0, ap: 0 }]); g.step(); } };

{
  const evs = [];
  const g = new Game(world, { send() {}, broadcast: (t, d) => { if (t === 's') evs.push(...d.e); } }, { matchSeconds: 2, rules: { bots: 1 } });
  const A = g.addPlayer('A', 'a'), B = g.addPlayer('B', 'b');
  g.setRules({ bots: 1 }); g.syncBots();
  run(g, 2.2);
  ok(g.phase === 'end', 'match over -> result phase');
  run(g, 30);
  ok(g.phase === 'end', 'still on the result screen 30 s later (no automatic next match)');
  const killsBefore = A.kills;
  g.onReady('A'); run(g, 0.2);
  ok(A.ready && !B.ready && g.phase === 'end', 'A ready, B not: waiting');
  // A fires during free fire; B (on the result screen) cannot be hurt
  const shots0 = g.shellId;
  run(g, 1.5, { A: () => ({ f: true }) });
  ok(g.shellId > shots0, `ready player can fire in free-fire time (${g.shellId - shots0} shells)`);
  ok(g.time < B.invulnUntil && B.hp === C.maxHp, 'player still on the result screen is untouchable');
  ok(A.kills === killsBefore && A.m.shots === 0, 'free fire counts for nothing (kills / stats unchanged)');
  // rules change for the next match: everyone confirms again
  g.onNextRules('B', { mode: 'team', bots: 2, botLevel: 'hard' }); run(g, 0.1);
  ok(!A.ready && g.rules.mode === 'team' && g.botCount === 2 && evs.some((e) => e.t === 'rules'), `rules changed for the next match (${g.rules.mode}, ${g.botCount} CPUs), ready reset`);
  g.onReady('A'); g.onReady('B'); run(g, 0.1);
  ok(g.phase === 'play' && A.kills === 0 && evs.some((e) => e.t === 'start'), 'everyone ready -> next match starts with the new rules');
}
{
  const g = new Game(world, { send() {}, broadcast() {} }, { matchSeconds: 2 });
  g.addPlayer('A', 'a'); g.addPlayer('B', 'b');
  run(g, 2.2);
  g.onReady('A'); g.setConnected('B', false); run(g, 0.1);
  ok(g.phase === 'play', 'the last not-ready person leaving lets the others start');
}
{
  const g = new Game(world, { send() {}, broadcast() {} }, { matchSeconds: 2 });
  g.autoFill = true; g.setRules({ size: 2 });
  g.addPlayer('A', 'a'); run(g, 6); run(g, 2.2);
  ok(g.phase === 'end' && !g.open, 'quick match: finished room stays finished and takes no one new');
  g.onReady('A'); run(g, 1);
  ok(g.phase === 'end', 'quick match: "ready" does not restart the old room (players re-match instead)');
}
