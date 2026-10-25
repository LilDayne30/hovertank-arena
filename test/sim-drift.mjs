// Unit check of the drift mini-turbo in shared/sim.js (no server needed).
import fs from 'node:fs';
import { makeWorld, newTank, stepTank, C, DT } from '../shared/sim.js';
import { applyObstacles } from '../shared/arena.js';
const meta = JSON.parse(fs.readFileSync('public/assets/arena_hf.json'));
const b = fs.readFileSync('public/assets/arena_hf.bin');
const w = makeWorld(meta, new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)));
applyObstacles(w);
const run = (driftTicks, label) => {
  const t = newTank(-27, -26, -Math.PI / 2, 0);   // open lane along the north wall, facing +x
  let seq = 0, maxSpeed = 0, boostLvl = 0;
  const inp = (mx, mz, d) => ({ seq: ++seq, mx, mz, ay: 0, ap: 0, j: false, d, f: false });
  for (let i = 0; i < 40; i++) stepTank(t, inp(1, 0, false), w);          // accelerate towards +x
  const s0 = Math.hypot(t.vx, t.vz);
  for (let i = 0; i < driftTicks; i++) stepTank(t, inp(0.3, 1, true), w);   // hold DRIFT while steering hard to one side
  const charge = t.charge;
  const ev = stepTank(t, inp(0.3, 1, false), w);                            // release (stick still held the same way)
  boostLvl = ev.boost;
  for (let i = 0; i < 25; i++) { stepTank(t, inp(0.3, 1, false), w); maxSpeed = Math.max(maxSpeed, Math.hypot(t.vx, t.vz)); }
  console.log(`${label}: speed before drift ${s0.toFixed(1)} | charge ${charge.toFixed(2)} s | boost level ${boostLvl} | top speed after release ${maxSpeed.toFixed(1)} (normal cap ${C.maxSpeed})`);
};
run(8, 'short tap (0.27 s)');
run(24, 'drift 0.8 s');
run(45, 'drift 1.5 s');
