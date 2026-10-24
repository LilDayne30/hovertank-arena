// Shared deterministic-ish simulation used by both server (authoritative) and client (prediction).
// Units: metres, seconds, radians. Y is up. Yaw 0 faces -Z (PlayCanvas forward).

export const TICK_RATE = 30;
export const DT = 1 / TICK_RATE;

export const C = {
  hoverHeight: 0.55,     // hull bottom floats this far above terrain
  radius: 1.5,           // tank collision radius (tank-vs-wall / tank-vs-tank)
  hitRadius: 1.9,        // shell-vs-tank hit sphere radius
  hitCenterY: 0.9,       // hit sphere centre above tank origin
  accel: 30,             // thrust m/s^2
  airControl: 0.3,       // thrust multiplier in air
  maxSpeed: 17,          // horizontal speed cap
  dragFwd: 0.9,          // longitudinal damping (1/s) on ground
  gripSide: 5.5,         // lateral damping (1/s) on ground – "normal" grip
  gripDrift: 0.55,       // lateral damping while drifting
  airDrag: 0.08,         // damping in air (horizontal momentum mostly preserved)
  turnRate: 4.2,         // hull yaw rate toward move direction (rad/s)
  turnRateDrift: 7.0,
  gravity: 30,
  jumpVel: 11.5,         // ~2.2 m apex, ~0.77 s airtime
  stepMax: 0.9,          // terrain rise that can be climbed; more = wall
  shellSpeed: 58,
  shellGravity: 9,
  shellLife: 2.4,
  shellRadius: 0.25,
  fireCooldown: 0.55,
  muzzleForward: 2.3,
  muzzleUp: 1.5,
  damage: 34,
  maxHp: 100,
  respawnTime: 3,
  spawnInvuln: 2,
  aimPitchMin: -0.30,
  aimPitchMax: 0.45,
};

// ---------------------------------------------------------------- world (heightfield)
// world = { minX, minZ, cell, nx, nz, h: Float32Array(nx*nz), floor, spawns:[{x,z,yaw}] }
export function makeWorld(meta, heights) {
  return { ...meta, h: heights };
}

function cellH(w, ix, iz) {
  if (ix < 0 || iz < 0 || ix >= w.nx || iz >= w.nz) return w.outside ?? 50; // outside = wall
  return w.h[iz * w.nx + ix];
}

// Bilinear terrain height.
export function heightAt(w, x, z) {
  const fx = (x - w.minX) / w.cell, fz = (z - w.minZ) / w.cell;
  const ix = Math.floor(fx), iz = Math.floor(fz);
  const tx = fx - ix, tz = fz - iz;
  const h00 = cellH(w, ix, iz), h10 = cellH(w, ix + 1, iz);
  const h01 = cellH(w, ix, iz + 1), h11 = cellH(w, ix + 1, iz + 1);
  // avoid smearing cliffs: if cells differ a lot, use nearest instead of blend
  const mx = Math.max(h00, h10, h01, h11), mn = Math.min(h00, h10, h01, h11);
  if (mx - mn > C.stepMax) return cellH(w, Math.round(fx), Math.round(fz));
  return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
}

// Max terrain height under a disc (used for wall tests).
const RING = [[1, 0], [0.707, 0.707], [0, 1], [-0.707, 0.707], [-1, 0], [-0.707, -0.707], [0, -1], [0.707, -0.707]];
function blocked(w, x, z, footY, r) {
  for (const [dx, dz] of RING) {
    if (heightAt(w, x + dx * r, z + dz * r) - footY > C.stepMax) return true;
  }
  return false;
}

// ---------------------------------------------------------------- tanks
export function newTank(x, z, yaw, groundY) {
  return {
    x, y: groundY + C.hoverHeight, z,
    vx: 0, vy: 0, vz: 0,
    yaw,                 // hull yaw
    aimYaw: yaw, aimPitch: 0,
    grounded: true,
    cooldown: 0,
    shotSeq: 0,
  };
}

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const wrapPi = (a) => { a = (a + Math.PI) % (Math.PI * 2); if (a < 0) a += Math.PI * 2; return a - Math.PI; };

// Sanitise an input received over the network.
export function cleanInput(i) {
  let mx = +i.mx || 0, mz = +i.mz || 0;
  const m = Math.hypot(mx, mz);
  if (m > 1) { mx /= m; mz /= m; }
  return {
    seq: i.seq | 0,
    mx, mz,
    ay: wrapPi(+i.ay || 0),
    ap: clamp(+i.ap || 0, C.aimPitchMin, C.aimPitchMax),
    j: !!i.j, d: !!i.d, f: !!i.f,
  };
}

// Advance one tank by one tick. Returns {fired:boolean, jumped:boolean, landed:boolean}.
export function stepTank(t, inp, w, dt = DT) {
  const ev = { fired: false, jumped: false, landed: false };
  t.aimYaw = inp.ay; t.aimPitch = inp.ap;

  const mag = Math.hypot(inp.mx, inp.mz);
  const fwdX = -Math.sin(t.yaw), fwdZ = -Math.cos(t.yaw);
  const rightX = Math.cos(t.yaw), rightZ = -Math.sin(t.yaw);

  // hull turns toward desired move direction
  if (mag > 0.15) {
    const want = Math.atan2(-inp.mx, -inp.mz);
    const diff = wrapPi(want - t.yaw);
    const rate = (inp.d ? C.turnRateDrift : C.turnRate) * (t.grounded ? 1 : 0.5) * dt;
    t.yaw = wrapPi(t.yaw + clamp(diff, -rate, rate));
  }

  // thrust along hull forward, weaker while the hull still faces away from the stick
  if (mag > 0.05) {
    const dirX = inp.mx / mag, dirZ = inp.mz / mag;
    const align = Math.max(0.2, dirX * fwdX + dirZ * fwdZ);
    const a = C.accel * mag * align * (t.grounded ? 1 : C.airControl) * dt;
    // blend thrust toward the stick direction a little so it feels responsive
    t.vx += (fwdX * 0.75 + dirX * 0.25) * a;
    t.vz += (fwdZ * 0.75 + dirZ * 0.25) * a;
  }

  // damping split into hull-forward and lateral components (the drift)
  let vf = t.vx * fwdX + t.vz * fwdZ;
  let vl = t.vx * rightX + t.vz * rightZ;
  if (t.grounded) {
    vf *= Math.exp(-C.dragFwd * dt);
    vl *= Math.exp(-(inp.d ? C.gripDrift : C.gripSide) * dt);
  } else {
    vf *= Math.exp(-C.airDrag * dt);
    vl *= Math.exp(-C.airDrag * dt);
  }
  t.vx = fwdX * vf + rightX * vl;
  t.vz = fwdZ * vf + rightZ * vl;
  const hs = Math.hypot(t.vx, t.vz);
  if (hs > C.maxSpeed) { t.vx *= C.maxSpeed / hs; t.vz *= C.maxSpeed / hs; }

  // jump
  if (inp.j && t.grounded) { t.vy = C.jumpVel; t.grounded = false; ev.jumped = true; }

  // horizontal move with wall sliding (axis separated)
  const footY = t.y - C.hoverHeight;
  const nx = t.x + t.vx * dt, nz = t.z + t.vz * dt;
  if (!blocked(w, nx, t.z, footY, C.radius)) t.x = nx; else t.vx *= -0.2;
  if (!blocked(w, t.x, nz, footY, C.radius)) t.z = nz; else t.vz *= -0.2;

  // vertical
  const ground = heightAt(w, t.x, t.z) + C.hoverHeight;
  if (t.grounded) {
    if (t.y - ground > 0.6) { t.grounded = false; }        // drove off a ledge
    else { t.y = ground; t.vy = 0; }
  }
  if (!t.grounded) {
    t.vy -= C.gravity * dt;
    t.y += t.vy * dt;
    if (t.y <= ground) { t.y = ground; t.vy = 0; t.grounded = true; ev.landed = true; }
  }
  // safety: never sink below the floor
  if (t.y < (w.floor ?? -10) - 5) { t.y = ground; t.vy = 0; }

  // firing
  t.cooldown = Math.max(0, t.cooldown - dt);
  if (inp.f && t.cooldown <= 0) { t.cooldown = C.fireCooldown; t.shotSeq++; ev.fired = true; }
  return ev;
}

// ---------------------------------------------------------------- shells
export function muzzle(t) {
  const cp = Math.cos(t.aimPitch);
  const dx = -Math.sin(t.aimYaw) * cp, dy = Math.sin(t.aimPitch), dz = -Math.cos(t.aimYaw) * cp;
  return {
    x: t.x + dx * C.muzzleForward, y: t.y + C.muzzleUp + dy * C.muzzleForward, z: t.z + dz * C.muzzleForward,
    vx: dx * C.shellSpeed, vy: dy * C.shellSpeed + 2.0, vz: dz * C.shellSpeed,
  };
}

// Step a shell; returns {hitGround:boolean}. Tank hits are checked by caller with segmentHitsTank.
export function stepShell(s, w, dt = DT) {
  s.px = s.x; s.py = s.y; s.pz = s.z;
  s.vy -= C.shellGravity * dt;
  s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt;
  s.life -= dt;
  // sample terrain along the segment (shell moves ~2m per tick)
  for (let k = 1; k <= 3; k++) {
    const f = k / 3;
    const x = s.px + (s.x - s.px) * f, y = s.py + (s.y - s.py) * f, z = s.pz + (s.z - s.pz) * f;
    if (y <= heightAt(w, x, z)) { s.x = x; s.y = y; s.z = z; return { hitGround: true }; }
  }
  return { hitGround: false };
}

// segment (px,py,pz)->(x,y,z) vs sphere around tank
export function segmentHitsTank(s, t) {
  const cx = t.x, cy = t.y + C.hitCenterY, cz = t.z;
  const dx = s.x - s.px, dy = s.y - s.py, dz = s.z - s.pz;
  const fx = s.px - cx, fy = s.py - cy, fz = s.pz - cz;
  const a = dx * dx + dy * dy + dz * dz;
  let u = a > 0 ? -(fx * dx + fy * dy + fz * dz) / a : 0;
  u = clamp(u, 0, 1);
  const qx = fx + dx * u, qy = fy + dy * u, qz = fz + dz * u;
  const r = C.hitRadius + C.shellRadius;
  return qx * qx + qy * qy + qz * qz <= r * r;
}

// push two tanks apart (server side)
export function separateTanks(a, b) {
  const dx = b.x - a.x, dz = b.z - a.z;
  const d = Math.hypot(dx, dz), min = C.radius * 2;
  if (d >= min || d === 0 || Math.abs(a.y - b.y) > 2.2) return;
  const push = (min - d) / 2, nx = dx / d, nz = dz / d;
  a.x -= nx * push; a.z -= nz * push; b.x += nx * push; b.z += nz * push;
  const rel = (b.vx - a.vx) * nx + (b.vz - a.vz) * nz;
  if (rel < 0) { a.vx += nx * rel * 0.6; a.vz += nz * rel * 0.6; b.vx -= nx * rel * 0.6; b.vz -= nz * rel * 0.6; }
}

export { wrapPi, clamp };
