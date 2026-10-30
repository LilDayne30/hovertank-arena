// Sidearms and specials in the real game logic (no server needed).   node test/abilities.mjs
import { readFileSync } from 'node:fs';
import { makeWorld, DT, C, heightAt } from '../shared/sim.js';
import { SPAWNS, applyObstacles } from '../shared/arena.js';
import { Game } from '../shared/game.js';
import { SIDE, ULT } from '../shared/abilities.js';

const meta = JSON.parse(readFileSync('public/assets/arena_hf.json'));
const buf = readFileSync('public/assets/arena_hf.bin');
const world = makeWorld(meta, new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4));
world.spawns = SPAWNS; applyObstacles(world);
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) process.exitCode = 1; };

// two players facing each other on flat ground; A at (ax, az) looking +x at B
function setup({ ax = 14, az = -32, bx = 34, bz = -32, loadA, loadB } = {}) {
  let evs = [];
  const g = new Game(world, { send() {}, broadcast: (t, d) => { if (t === 's') evs.push(...d.e); } }, { matchSeconds: 999 });
  const A = g.addPlayer('A', 'a'), B = g.addPlayer('B', 'b');
  for (const [p, x, z, l] of [[A, ax, az, loadA], [B, bx, bz, loadB]]) {
    if (l) g.onLoadout(p.id, l);
    const t = p.tank; t.x = x; t.z = z; t.y = heightAt(world, x, z) + C.hoverHeight; t.vx = t.vz = 0; t.grounded = true;
    p.invulnUntil = 0;
  }
  A.tank.yaw = -Math.PI / 2; B.tank.yaw = Math.PI / 2;   // A faces +x, B faces -x
  const seq = { A: 0, B: 0 };
  const step = (n, inA = {}, inB = {}) => {
    for (let i = 0; i < n; i++) {
      const base = (p) => ({ seq: ++seq[p], mx: 0, mz: 0, ay: p === 'A' ? -Math.PI / 2 : Math.PI / 2, ap: 0.03 });
      g.onInput('A', [{ ...base('A'), ...(typeof inA === 'function' ? inA(i) : inA) }]);
      g.onInput('B', [{ ...base('B'), ...(typeof inB === 'function' ? inB(i) : inB) }]);
      g.step();
    }
  };
  const take = () => { const e = evs; evs = []; return e; };
  return { g, A, B, step, take };
}

// ---------------------------------------------------------------- dash
{
  const { A, step, take } = setup({ loadA: { side: 'dash' } });
  step(1, { a: true, mx: 0, mz: 1 });
  const sp = Math.hypot(A.tank.vx, A.tank.vz);
  ok(sp > 18 && A.tank.vz > 15, `dash: ${sp.toFixed(1)} m/s towards the stick (+z) from standing`);
  ok(take().some((e) => e.t === 'side' && e.k === 'dash'), 'dash event sent');
  step(1, { a: true });
  ok(Math.abs(A.tank.sideCd - (SIDE.dash.cd - 2 * DT)) < 0.05, `cooldown ${A.tank.sideCd.toFixed(2)} s (second press ignored)`);
}

// ---------------------------------------------------------------- shield: block and perfect reflect
{
  const { A, B, step, take } = setup({ loadB: { side: 'shield' } });
  step(1, { f: true });                   // A fires at B (20 m, ~0.29 s flight)
  step(2); step(1, {}, { a: true });      // B raises the shield ~0.1 s before impact
  step(30);
  const e = take();
  ok(e.some((x) => x.t === 'reflect' && x.v === 'B'), 'perfect guard (shield raised just before impact) reflects the shell');
  ok(B.hp === 100 && A.hp < 100, `reflected shell hit the shooter: A ${A.hp} HP, B ${B.hp} HP`);
}
{
  const { B, step, take } = setup({ loadB: { side: 'shield' } });
  step(1, {}, { a: true });               // shield raised early
  step(14); step(1, { f: true }); step(30);
  const e = take();
  ok(e.some((x) => x.t === 'block' && x.v === 'B') && !e.some((x) => x.t === 'reflect') && B.hp === 100, 'late shell (shield already up 0.5 s) is blocked, not reflected');
}

// ---------------------------------------------------------------- mine
{
  const { A, B, step, take } = setup({ ax: 14, bx: 30, loadA: { side: 'mine' } });
  step(1, { a: true });                   // mine 2.8 m behind A (A faces +x -> mine at x ~ 11.2)
  const mineX = 14 - 2.8;
  step(40);                                // arm
  // B drives over it (towards -x)
  step(140, {}, { mx: -1 });
  const e = take();
  const boom = e.find((x) => x.t === 'mineboom');
  ok(!!boom && Math.abs(boom.x - mineX) < 0.6, `mine exploded where it was placed (x ${boom?.x})`);
  ok(B.hp < 100 || !B.alive, `B damaged by the mine (${B.hp} HP)`);
}

// ---------------------------------------------------------------- bounce shell
{
  // A in front of the east edge wall (x 25..26.5, z -3..3), shooting at it
  const { step, take } = setup({ ax: 18, az: 0, bx: 34, bz: -34, loadA: { side: 'bounce' } });
  step(1, { a: true }); step(60);
  const e = take();
  const r = e.filter((x) => x.t === 'rico');
  ok(r.length >= 1 && r[0].x > 23, `bounce shell ricochets off the wall (${r.length} bounce(s), first at x ${r[0]?.x})`);
}

// ---------------------------------------------------------------- overdrive
{
  const { A, step, take } = setup({ loadA: { ult: 'overdrive' } });
  A.tank.ult = 100;
  step(1, { u: true });
  ok(A.tank.odT > 5.9 && A.tank.ult === 0 || A.tank.ult < 1, `overdrive on for ${A.tank.odT.toFixed(2)} s, meter emptied`);
  step(1, { f: true });
  ok(A.tank.cooldown < C.fireCooldown * 0.5, `fire cooldown in overdrive ${A.tank.cooldown.toFixed(2)} s (normal ${C.fireCooldown})`);
  ok(take().some((x) => x.t === 'ult' && x.k === 'overdrive'), 'special event sent');
  const { A: A2, step: s2 } = setup({});
  A2.tank.ult = 50; s2(1, { u: true });
  ok(A2.tank.odT === 0, 'special does nothing until the meter is full');
}

// ---------------------------------------------------------------- mega cannon
{
  const { B, step, take } = setup({ ax: 14, bx: 40, loadA: { ult: 'mega' } });
  const { A } = { A: null };
  step(0);
}
{
  const s = setup({ ax: 14, bx: 40, loadA: { ult: 'mega' } });
  s.A.tank.ult = 100;
  s.step(1, { u: true }); s.step(30);
  const e = s.take();
  ok(s.B.hp === 100 - ULT.mega.direct, `mega cannon direct hit at 26 m: B ${s.B.hp} HP (-${ULT.mega.direct})`);
  ok(e.some((x) => x.t === 'mega'), 'mega blast event');
}

// ---------------------------------------------------------------- air strike
{
  const s = setup({ ax: 4, az: -32, bx: 34, bz: -32, loadA: { ult: 'strike' } });
  s.A.tank.ult = 100;
  // aim pitch that lands a normal shell on B (~30 m)
  const { solveAim } = await import('../shared/sim.js');
  const [ay, ap] = solveAim(s.A.tank, { x: 34, y: s.B.tank.y, z: -32 });
  s.step(1, { u: true, ay, ap });
  const st = s.take().find((x) => x.t === 'strike');
  ok(!!st && Math.hypot(st.x - 34, st.z + 32) < 3, `air strike marker lands near the crosshair point (${st?.x}, ${st?.z})`);
  s.step(Math.ceil((ULT.strike.delay + ULT.strike.span + 0.3) / DT));
  const bombs = s.take().filter((x) => x.t === 'bomb').length;
  ok(bombs === ULT.strike.bombs && s.B.hp < 100, `${bombs} bombs fell, B (standing still) ${s.B.alive ? `${s.B.hp} HP` : 'destroyed'}`);
}

// ---------------------------------------------------------------- ground slam
{
  const s = setup({ ax: 14, bx: 19, loadA: { ult: 'slam' } });
  s.A.tank.ult = 100;
  s.step(1, { u: true });
  ok(!s.A.tank.grounded && s.A.tank.slam === 1, 'slam: jumps up first');
  let landed = false;
  for (let i = 0; i < 90 && !landed; i++) { s.step(1); landed = s.A.tank.grounded; }
  const e = s.take(), sl = e.find((x) => x.t === 'slam');
  ok(!!sl, 'slam shock-wave on landing');
  ok(s.B.hp < 100 && s.B.hp >= 100 - ULT.slam.damage[0], `B 5 m away: ${s.B.hp} HP, knocked back to ${Math.hypot(s.B.tank.vx, s.B.tank.vz).toFixed(1)} m/s`);
}

// ---------------------------------------------------------------- meter gain
{
  const s = setup({});
  s.A.tank.ult = 0;
  s.step(1, { f: true }); s.step(20);
  ok(s.A.tank.ult > 9.5 && s.A.tank.ult < 13, `meter after one hit + 0.7 s: ${s.A.tank.ult.toFixed(1)} (hit +10, +1.5/s)`);
}

// ---------------------------------------------------------------- bounce shell rework: stronger after each ricochet, splash
{
  const { bounceDamage } = await import('../shared/game.js');
  const B = SIDE.bounce;
  ok([3, 2, 1, 0].map((b) => bounceDamage({ bounce: b })).join('/') === '30/50/70/90', `bounce damage by ricochets: ${[3, 2, 1, 0].map((b) => bounceDamage({ bounce: b })).join(' / ')}`);
  // straight shot at a tank 20 m away: direct hit with no bounce = 30
  const s = setup({ ax: 14, bx: 34, loadA: { side: 'bounce' } });
  s.step(1, { a: true }); s.step(30);
  ok(s.B.hp === 100 - B.damage, `direct bounce-shell hit (no ricochet): B ${s.B.hp} HP`);
  // bank shot: A behind the east wall (x 25..26.5) shoots at it; B stands where the ricochet goes
  const s2 = setup({ ax: 18, az: 0, bx: 34, bz: -34, loadA: { side: 'bounce' } });
  s2.step(1, { a: true });
  let hit = null;
  for (let i = 0; i < 60 && !hit; i++) { s2.step(1); hit = s2.take().find((e) => e.t === 'rico'); }
  ok(!!hit, `banked off the wall at x ${hit?.x}`);
}
// ---------------------------------------------------------------- slam: untouchable in the air
{
  const s = setup({ ax: 14, bx: 34, loadA: { ult: 'slam' } });
  s.A.tank.ult = 100;
  s.step(1, { u: true });
  s.step(1, {}, { f: true });           // B shoots at the slamming A
  let shield = false, landedHp = null;
  for (let i = 0; i < 60; i++) { s.step(1); if (s.take().some((e) => e.t === 'shield' && e.v === 'A')) shield = true; if (s.A.tank.grounded && landedHp === null) landedHp = s.A.hp; }
  ok(shield && s.A.hp === 100, `slam: shells bounce off while airborne (A ${s.A.hp} HP)`);
}
// ---------------------------------------------------------------- mines: two per player, your third sets off your oldest
{
  const s = setup({ ax: 14, bx: 30, loadA: { side: 'mine' }, loadB: { side: 'mine' } });
  s.step(1, { a: true });                                   // A #1
  s.A.tank.sideCd = 0; s.step(1, { a: true, mx: 0, mz: 1 });   // A #2
  s.step(1, {}, { a: true });                               // B #1
  s.take();
  ok(s.g.mines.length === 3 && !s.take().some((x) => x.t === 'mineboom'), 'B\'s mine does not count against A (3 on the field)');
  s.A.tank.sideCd = 0; s.step(1, { a: true, mx: 1, mz: 0 });   // A #3
  const e = s.take(), own = s.g.mines.filter((m) => m.owner === 'A');
  ok(own.length === 2 && s.g.mines.length === 3 && e.some((x) => x.t === 'mineboom' && x.o === 'A'), `A's third mine: A's oldest exploded (A ${own.length}, total ${s.g.mines.length})`);
}
