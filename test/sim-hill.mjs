// The central hill must be climbable from every direction (no server needed).
import fs from 'node:fs';
import { makeWorld, newTank, stepTank, heightAt } from '../shared/sim.js';
import { applyObstacles } from '../shared/arena.js';
const meta = JSON.parse(fs.readFileSync('public/assets/arena_hf.json'));
const b = fs.readFileSync('public/assets/arena_hf.bin');
const w = makeWorld(meta, new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)));
applyObstacles(w);
const res = [];
for (let i = 0; i < 24; i++) {
  const a = (i / 24) * Math.PI * 2, sx = Math.cos(a) * 15, sz = Math.sin(a) * 15;
  for (const speed of ['from standstill', 'slow']) {
    const t = newTank(sx, sz, Math.atan2(sx, sz), heightAt(w, sx, sz));
    let seq = 0;
    for (let k = 0; k < 90; k++) {
      const dx = -t.x, dz = -t.z, m = Math.hypot(dx, dz) || 1, g = speed === 'slow' ? 0.4 : 1;
      if (m < 1.5) break;
      stepTank(t, { seq: ++seq, mx: (dx / m) * g, mz: (dz / m) * g, ay: 0, ap: 0, j: false, d: false, f: false }, w);
    }
    res.push({ deg: Math.round((a * 180) / Math.PI), speed, top: Math.hypot(t.x, t.z) < 3.5 && t.y > 2.4 });
  }
}
const fails = res.filter((r) => !r.top);
console.log(`climbed to the top in ${res.length - fails.length}/${res.length} runs (24 directions x 2 speeds)`, fails.length ? fails : '');
