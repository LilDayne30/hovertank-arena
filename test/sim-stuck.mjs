// Fuzz test for getting stuck on walls (no server needed).
// 1) random driving / jumping / drifting next to every wall, then check the tank can still drive away
// 2) tanks placed overlapping a wall (what a tank-vs-tank shove can cause) must work their way out
import fs from 'node:fs';
import { makeWorld, newTank, stepTank, heightAt, C } from '../shared/sim.js';
import { applyObstacles, OBSTACLES } from '../shared/arena.js';
const meta = JSON.parse(fs.readFileSync('public/assets/arena_hf.json'));
const b = fs.readFileSync('public/assets/arena_hf.bin');
const w = makeWorld(meta, new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)));
applyObstacles(w);
let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
let seq = 0;
const inp = (mx, mz, o = {}) => ({ seq: ++seq, mx, mz, ay: 0, ap: 0, j: !!o.j, d: !!o.d, f: false });

function canEscape(t0) {
  // from this state, can the tank move at least 2 m in some direction within 1.5 s?
  for (let k = 0; k < 8; k++) {
    const t = structuredClone(t0), a = (k / 8) * Math.PI * 2;
    for (let i = 0; i < 45; i++) stepTank(t, inp(Math.cos(a), Math.sin(a)), w);
    if (Math.hypot(t.x - t0.x, t.z - t0.z) > 2) return true;
  }
  return false;
}
const boxes = OBSTACLES.filter((o) => o.type === 'box');
let stuck = 0, runs = 0; const examples = [];
for (const o of boxes) {
  for (let r = 0; r < 40; r++) {
    runs++;
    // start somewhere around the wall
    const a = rnd() * Math.PI * 2, d = 4 + rnd() * 4;
    let x = o.cx + Math.cos(a) * (o.hx + d), z = o.cz + Math.sin(a) * (o.hz + d);
    if (heightAt(w, x, z) > 0.5 || Math.abs(x) > 37 || Math.abs(z) > 37) { runs--; continue; }
    const t = newTank(x, z, rnd() * 6.28, heightAt(w, x, z));
    for (let i = 0; i < 150; i++) {
      // steer roughly towards the wall with noise; jump and drift at random
      const tx = o.cx - t.x + (rnd() - 0.5) * 6, tz = o.cz - t.z + (rnd() - 0.5) * 6, m = Math.hypot(tx, tz) || 1;
      stepTank(t, inp(tx / m, tz / m, { j: rnd() < 0.06, d: rnd() < 0.4 }), w);
    }
    // let it come to rest (keep holding into the wall) then test escape
    for (let i = 0; i < 30; i++) stepTank(t, inp(0, 0), w);
    if (!canEscape(t)) { stuck++; if (examples.length < 3) examples.push({ x: +t.x.toFixed(2), y: +t.y.toFixed(2), z: +t.z.toFixed(2), wall: [o.cx, o.cz] }); }
  }
}
// the outer arena wall (irregular mesh edge) and its corners
for (let r = 0; r < 160; r++) {
  runs++;
  const a = rnd() * Math.PI * 2, x = Math.cos(a) * 30, z = Math.sin(a) * 30;
  if (heightAt(w, x, z) > 0.5) { runs--; continue; }
  const t = newTank(x, z, rnd() * 6.28, heightAt(w, x, z));
  const o = { cx: Math.sign(Math.cos(a)) * 40 * (rnd() < 0.7 ? 1 : 0), cz: Math.sign(Math.sin(a)) * 40 };
  for (let i = 0; i < 150; i++) {
    const tx = o.cx - t.x + (rnd() - 0.5) * 20, tz = o.cz - t.z + (rnd() - 0.5) * 20, m = Math.hypot(tx, tz) || 1;
    stepTank(t, inp(tx / m, tz / m, { j: rnd() < 0.06, d: rnd() < 0.4 }), w);
  }
  for (let i = 0; i < 30; i++) stepTank(t, inp(0, 0), w);
  if (!canEscape(t)) { stuck++; if (examples.length < 3) examples.push({ x: +t.x.toFixed(2), y: +t.y.toFixed(2), z: +t.z.toFixed(2), wall: 'outer' }); }
}
console.log(`random play next to cover walls and the outer arena wall: stuck in ${stuck}/${runs} runs`, examples);

// overlap test
let trapped = 0, cases = 0;
for (const o of boxes) {
  for (const [sx, sz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    cases++;
    const x = o.cx + sx * (o.hx + C.radius * 0.5), z = o.cz + sz * (o.hz + C.radius * 0.5);   // ring overlaps the wall
    const t = newTank(x, z, 0, heightAt(w, x, z));
    if (!canEscape(t)) trapped++;
  }
}
console.log(`tank overlapping a wall can drive away: ${cases - trapped}/${cases}`);

// tunnelling test: ram every wall at boost speed from all four sides; the tank must never pass
// through or end up with its centre inside the wall
let through = 0, rams = 0;
for (const o of boxes) {
  for (const [sx, sz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    rams++;
    const x = o.cx + sx * (o.hx + 6), z = o.cz + sz * (o.hz + 6);
    if (Math.abs(x) > 37 || Math.abs(z) > 37) { rams--; continue; }
    const t = newTank(x, z, Math.atan2(sx, sz), heightAt(w, x, z));
    t.vx = -sx * 27; t.vz = -sz * 27; t.boost = 1; t.boostLvl = 2;
    let bad = false;
    for (let i = 0; i < 60; i++) {
      stepTank(t, inp(-sx, -sz), w);
      const inside = heightAt(w, t.x, t.z) - (t.y - C.hoverHeight) > C.stepMax;
      const passed = sx ? Math.sign(t.x - o.cx) !== sx : Math.sign(t.z - o.cz) !== sz;
      if (inside || passed) bad = true;
    }
    if (bad) through++;
  }
}
console.log(`ramming walls at boost speed: passed through / ended inside in ${through}/${rams} cases`);
process.exit(stuck + trapped + through ? 1 : 0);
