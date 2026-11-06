// New stages in the real game logic (no server): fair spawns, jump pads, shutters, switches,
// CPU tanks finding their way (terraces, trenches, vault), random stage per match.
//   node test/stages.mjs
import { readFileSync } from 'node:fs';
import { DT, C, heightAt, newTank, stepTank, depenetrate } from '../shared/sim.js';
import { buildStageWorld, STAGE_IDS, findPath } from '../shared/stages.js';
import { Game } from '../shared/game.js';

const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) process.exitCode = 1; };
const buf = readFileSync('public/assets/arena_hf.bin');
const BASE = { meta: JSON.parse(readFileSync('public/assets/arena_hf.json')), heights: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) };
const worldFor = (id) => buildStageWorld(id, BASE);

for (const id of STAGE_IDS) {
  const w = worldFor(id);
  // every spawn: on open ground, the tank fits, faces the middle
  const bad = w.spawns.filter((s) => { const t = newTank(s.x, s.z, s.yaw, heightAt(w, s.x, s.z)); const x0 = t.x, z0 = t.z; depenetrate(t, w); return Math.hypot(t.x - x0, t.z - z0) > 0.01; });
  ok(bad.length === 0 && w.spawns.length >= 8, `${id}: ${w.spawns.length} spawns, all clear`);
  ok(w.teamSpawns[0].length === w.teamSpawns[1].length && w.teamSpawns[0].length >= 2, `${id}: team spawns ${w.teamSpawns[0].length} v ${w.teamSpawns[1].length}`);
  // every spawn can reach the heal (with gates open)
  if (id !== 'desert') {
    for (let i = 0; i < w.gates.length; i++) { w.gates[i].open = false; }
    const g2 = worldFor(id); for (let i = 0; i < g2.gates.length; i++) { const { setGate } = await import('../shared/stages.js'); setGate(g2, i, true); }
    const unreach = g2.spawns.filter((s) => !findPath(g2, s.x, s.z, g2.heal.x, g2.heal.z)?.length);
    ok(unreach.length === 0, `${id}: the heal can be reached from every spawn (path graph)`);
  }
}

// jump pads land where they say
{
  const w = worldFor('quarry'), inp = { mx: 0, mz: 0, ay: 0, ap: 0 };
  const res = w.zones.map((z) => {
    const t = newTank(z.x, z.z, 0, heightAt(w, z.x, z.z));
    for (let i = 0; i < 120; i++) { const e = stepTank(t, inp, w); if (e.landed && i > 2) break; }
    return Math.hypot(t.x - z.tx, t.z - z.tz) < 2.5 && Math.abs(t.y - C.hoverHeight - heightAt(w, z.tx, z.tz)) < 0.3;
  });
  ok(res.every(Boolean), `quarry: all ${res.length} jump pads land on their target`);
}
// conveyor
{
  const w = worldFor('foundry'), t = newTank(-40, -28.5, 0, 0);
  for (let i = 0; i < 60; i++) stepTank(t, { mx: 0, mz: 0, ay: 0, ap: 0 }, w);
  ok(t.x > -30, `foundry: the belt carries an idle tank towards the middle (x ${t.x.toFixed(1)} after 2 s)`);
}

// shutters and switches in a match
{
  const events = [];
  const g = new Game(worldFor('desert'), { send() {}, broadcast(t, d) { if (t === 's') events.push(...d.e); } }, { worldFor, matchSeconds: 9999, rules: { stage: 'foundry', bots: 0 } });
  ok(g.world.stage === 'foundry', 'a private room with stage "foundry" starts on it');
  g.join?.('A', { name: 'A' });
  const timeTo = (s) => { while (g.time - g.matchStart < s) g.step(); };
  timeTo(10);
  ok(g.world.gates.every((x) => !x.open) && heightAt(g.world, 0, -5.8) > 5, 'shutters closed at 10 s (vault wall solid)');
  // shoot the north switch
  g.shells.push({ id: 999, owner: 'nobody', seq: 1, x: 36, y: 2.1, z: -16.5, vx: 0, vy: 0, vz: 0.1, life: 1, kind: 'shell', g: 0 });
  g.step(); g.step();
  const n = g.world.gates.find((x) => x.id === 'n'), s = g.world.gates.find((x) => x.id === 's');
  ok(n.open && !s.open && heightAt(g.world, 0, -5.8) < 0.5 && events.some((e) => e.t === 'switch'), 'switch shot: the north shutter opens, the south one stays shut');
  timeTo(17.5);
  ok(!n.open, 'north shutter shut again after 6 s');
  timeTo(36);
  ok(g.world.gates.every((x) => x.open) && g.heal.active, 'at 35 s all four shutters open and the heal appears');
  timeTo(51);
  ok(g.world.gates.every((x) => !x.open), 'shut again after 15 s');
  ok(events.filter((e) => e.t === 'gate').length >= 3, 'gate events sent to the clients');
}

// CPU tanks on the new stages: they fight, move about, reach the high ground / the vault, use pads
for (const id of ['quarry', 'foundry']) {
  const g = new Game(worldFor('desert'), { send() {}, broadcast() {} }, { worldFor, matchSeconds: 9999, rules: { stage: id } });
  const bots = ['normal', 'normal', 'hard', 'easy'].map((l) => g.addBot(l));
  let still = 0, maxY = 0, pads = 0, inVault = 0, heals = 0;
  const T = Math.round(180 / DT);
  for (let i = 0; i < T; i++) {
    const before = bots.map((b) => b.tank && b.tank.grounded);
    g.step();
    bots.forEach((b, k) => {
      if (!b.alive) return;
      if (Math.hypot(b.tank.vx, b.tank.vz) < 1) still++;
      maxY = Math.max(maxY, b.tank.y - C.hoverHeight);
      if (before[k] && !b.tank.grounded && b.tank.vy > 15) pads++;
      if (id === 'foundry' && Math.abs(b.tank.x) < 7 && Math.abs(b.tank.z) < 4.5) inVault++;
    });
  }
  heals = bots.reduce((a, b) => a + b.m.heals, 0);
  const kills = bots.reduce((a, b) => a + b.kills, 0);
  const stillPct = (100 * still) / (T * bots.length);
  ok(kills >= 6, `${id}: CPU tanks fight (${kills} kills in 3 min)`);
  ok(stillPct < 25, `${id}: CPU tanks keep moving (still ${stillPct.toFixed(0)}% of the time)`);
  ok(heals >= 1, `${id}: CPU tanks take the heal (${heals} times)`);
  if (id === 'quarry') ok(maxY > 7.5 && pads > 0, `quarry: CPUs reach the 8 m plateau (max ${maxY.toFixed(1)} m) and use jump pads (${pads})`);
  if (id === 'foundry') ok(inVault > 0, `foundry: CPUs get into the vault when it opens (${(inVault * DT).toFixed(0)} tank-seconds)`);
}

// random stage per match
{
  const g = new Game(worldFor('desert'), { send() {}, broadcast() {} }, { worldFor, matchSeconds: 9999, autoFill: true, rules: { stage: 'random' } });
  const seen = [];
  for (let i = 0; i < 9; i++) { g.resetMatch(); seen.push(g.world.stage); }
  ok(new Set(seen).size === 3 && seen.every((s, i) => i === 0 || s !== seen[i - 1]), `random stage each match, never the same twice in a row: ${seen.join(' ')}`);
}
