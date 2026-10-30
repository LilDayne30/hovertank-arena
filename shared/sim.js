import { SIDE, ULT, ULT_MAX, ULT_GAIN, SIDEARMS, ULTS } from './abilities.js';

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
  shellSpeed: 70,       // 1.2x the original 58 m/s
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
  // drift mini-turbo: slide with DRIFT held to charge, release to boost
  driftMinSpeed: 7,      // must be moving at least this fast...
  driftMinSlide: 2.2,    // ...and sliding sideways at least this fast to charge
  charge1: 0.55,         // seconds of sliding for a level-1 boost
  charge2: 1.3,          // seconds of sliding for a level-2 boost
  boostTime: [0, 0.6, 1.0],
  boostKick: [0, 6, 9.5],      // instant speed added along the hull on release (m/s)
  boostSpeed: [0, 23, 27],     // speed cap while boosting
  boostAccel: 22,              // extra thrust while boosting
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

// ---------------------------------------------------------------- wall collision
// The tank is a disc of radius C.radius. Terrain more than C.stepMax above the hull bottom is wall.
// penetration() samples the disc (centre + two rings) and reports how many samples are inside a
// wall and the average direction towards them, so moves can be judged as "into" or "out of" a wall.
const DIRS = Array.from({ length: 16 }, (_, i) => [Math.cos((i / 16) * Math.PI * 2), Math.sin((i / 16) * Math.PI * 2)]);
function penetration(w, x, z, footY) {
  let n = 0, px = 0, pz = 0;
  if (heightAt(w, x, z) - footY > C.stepMax) n += 2;
  for (const f of [1, 0.6]) {
    const r = C.radius * f;
    for (const [dx, dz] of DIRS) {
      if (heightAt(w, x + dx * r, z + dz * r) - footY > C.stepMax) { n++; px += dx; pz += dz; }
    }
  }
  return { n, px, pz };
}

// Try to move by (mx, mz). A move is accepted when it does not end in a wall, or when the tank is
// already overlapping a wall and the move does not make that worse (so it can always back out).
function tryMove(t, w, footY, mx, mz) {
  const cur = penetration(w, t.x, t.z, footY);
  const nxt = penetration(w, t.x + mx, t.z + mz, footY);
  const ok = nxt.n === 0 || nxt.n < cur.n || (cur.n > 0 && nxt.n <= cur.n && mx * cur.px + mz * cur.pz <= 0);
  if (ok) { t.x += mx; t.z += mz; }
  return ok;
}

// If the tank overlaps a wall (landing next to one after a jump, being shoved by another tank...),
// push it out a little every tick and cancel the velocity that points into the wall.
export function depenetrate(t, w) {
  const footY = t.y - C.hoverHeight;
  let p = penetration(w, t.x, t.z, footY);
  for (let iter = 0; iter < 4 && p.n > 0; iter++) {
    let dx = -p.px, dz = -p.pz, m = Math.hypot(dx, dz);
    let best = null;
    if (m > 1e-6) {
      dx /= m; dz /= m;
      for (const step of [0.12, 0.25, 0.4]) {
        const q = penetration(w, t.x + dx * step, t.z + dz * step, footY);
        if (q.n < p.n) { best = { x: t.x + dx * step, z: t.z + dz * step, q }; break; }
      }
    }
    if (!best) {
      // symmetric overlap (e.g. centre inside a thin wall): pick whichever direction helps most
      for (const [ex, ez] of DIRS) {
        for (const step of [0.25, 0.5]) {
          const q = penetration(w, t.x + ex * step, t.z + ez * step, footY);
          if (q.n < p.n && (!best || q.n < best.q.n)) best = { x: t.x + ex * step, z: t.z + ez * step, q };
        }
      }
    }
    if (!best) break;
    t.x = best.x; t.z = best.z;
    if (m > 1e-6) { const into = t.vx * -dx + t.vz * -dz; if (into > 0) { t.vx += dx * into; t.vz += dz * into; } }
    p = best.q;
  }
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
    charge: 0,           // drift charge (s)
    boost: 0,            // remaining boost time (s)
    boostLvl: 0,
    drifting: false,     // DRIFT was held last tick (release detection)
    // abilities (see shared/abilities.js)
    side: 'dash', ultK: 'overdrive',   // loadout
    sideCd: 0,           // sidearm cooldown left (s)
    ult: 0,              // special meter 0..ULT_MAX
    dashT: 0,            // dash speed-cap window (s)
    shieldT: 0, shieldAge: 9,   // reflect shield time left / time since raised
    odT: 0,              // overdrive time left
    slam: 0,             // 0 none, 1 rising, 2 diving
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
    a: !!i.a, u: !!i.u,   // sidearm / special (pressed this tick)
  };
}

// Advance one tank by one tick. Returns {fired:boolean, jumped:boolean, landed:boolean}.
export function stepTank(t, inp, w, dt = DT) {
  const ev = { fired: false, jumped: false, landed: false, boost: 0, sliding: false, side: null, ult: null, slam: false };
  t.aimYaw = inp.ay; t.aimPitch = inp.ap;
  const OD = t.odT > 0 ? ULT.overdrive : null;
  t.odT = Math.max(0, t.odT - dt);
  t.sideCd = Math.max(0, t.sideCd - dt);
  t.dashT = Math.max(0, t.dashT - dt);
  if (t.shieldT > 0) { t.shieldT = Math.max(0, t.shieldT - dt); t.shieldAge += dt; }
  t.ult = Math.min(ULT_MAX, t.ult + ULT_GAIN.perSec * dt);

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
    const a = C.accel * (OD ? OD.accelMul : 1) * mag * align * (t.grounded ? 1 : C.airControl) * dt;
    // blend thrust toward the stick direction a little so it feels responsive
    t.vx += (fwdX * 0.75 + dirX * 0.25) * a;
    t.vz += (fwdZ * 0.75 + dirZ * 0.25) * a;
  }

  // damping split into hull-forward and lateral components (the drift)
  let vf = t.vx * fwdX + t.vz * fwdZ;
  let vl = t.vx * rightX + t.vz * rightZ;
  if (t.grounded) {
    vf *= Math.exp(-C.dragFwd * dt);
    vl *= Math.exp(-(inp.d || t.dashT > 0 ? C.gripDrift : C.gripSide) * dt);   // a dash slides sideways too
  } else {
    vf *= Math.exp(-C.airDrag * dt);
    vl *= Math.exp(-C.airDrag * dt);
  }
  t.vx = fwdX * vf + rightX * vl;
  t.vz = fwdZ * vf + rightZ * vl;

  // drift mini-turbo: charge while actually sliding, fire the boost when DRIFT is released
  const speed = Math.hypot(t.vx, t.vz);
  ev.sliding = inp.d && t.grounded && speed > C.driftMinSpeed && Math.abs(vl) > C.driftMinSlide;
  if (ev.sliding) t.charge = Math.min(C.charge2 + 0.2, t.charge + dt * (OD ? OD.chargeMul : 1));
  if (!inp.d && t.drifting) {
    const lvl = t.charge >= C.charge2 ? 2 : t.charge >= C.charge1 ? 1 : 0;
    if (lvl) {
      t.boostLvl = lvl; t.boost = C.boostTime[lvl]; ev.boost = lvl;
      // the kick goes where the hull points, so drift-turning lets you redirect your momentum
      // most of the sideways momentum is redirected forward as well
      const keep = Math.max(t.vx * fwdX + t.vz * fwdZ, speed * 0.85);
      t.vx = fwdX * (keep + C.boostKick[lvl]) + rightX * vl * 0.15;
      t.vz = fwdZ * (keep + C.boostKick[lvl]) + rightZ * vl * 0.15;
    }
    t.charge = 0;
  }
  if (!inp.d && !t.drifting) t.charge = 0;
  t.drifting = inp.d;
  let cap = C.maxSpeed * (OD ? OD.speedMul : 1);
  if (t.boost > 0) {
    t.boost = Math.max(0, t.boost - dt);
    cap = C.boostSpeed[t.boostLvl] * (OD ? OD.speedMul : 1);
    t.vx += fwdX * C.boostAccel * dt; t.vz += fwdZ * C.boostAccel * dt;
    if (t.boost === 0) t.boostLvl = 0;
  }
  // ---- sidearm (press)
  if (inp.a && t.sideCd <= 0) {
    const S = SIDE[t.side] || SIDEARMS[0];
    t.sideCd = S.cd; ev.side = S.id;
    if (S.id === 'dash') {
      // burst towards the stick (or hull forward), keeps most of the current momentum
      let dx = inp.mx, dz = inp.mz; const m2 = Math.hypot(dx, dz);
      if (m2 < 0.3) { dx = fwdX; dz = fwdZ; } else { dx /= m2; dz /= m2; }
      const along = t.vx * dx + t.vz * dz;
      t.vx = t.vx * 0.35 + dx * (Math.max(0, along) * 0.65 + S.speed);
      t.vz = t.vz * 0.35 + dz * (Math.max(0, along) * 0.65 + S.speed);
      if (!t.grounded && t.vy < 2) t.vy = 2;   // an air dash floats you a little
      t.dashT = S.time;
    } else if (S.id === 'shield') { t.shieldT = S.dur; t.shieldAge = 0; }
    else if (S.id === 'bounce') { t.shotSeq++; ev.sideSeq = t.shotSeq; }   // a projectile (spawned by the caller)
    // mine: placed by the caller (server) behind the hull
  }
  // ---- special (press, meter full)
  if (inp.u && t.ult >= ULT_MAX) {
    const U = ULT[t.ultK] || ULTS[0];
    t.ult = 0; ev.ult = U.id;
    if (U.id === 'overdrive') t.odT = U.dur;
    else if (U.id === 'mega') { t.shotSeq++; ev.ultSeq = t.shotSeq; }
    else if (U.id === 'slam') {
      if (t.grounded) { t.vy = U.jump; t.grounded = false; t.slam = 1; ev.jumped = true; }
      else { t.slam = 2; t.vy = Math.min(t.vy, U.dive); }
    }
  }
  if (t.dashT > 0) cap = Math.max(cap, SIDE.dash.cap);

  const hs = Math.hypot(t.vx, t.vz);
  if (hs > cap) {
    // above the cap (e.g. just after a boost ends): bleed speed off smoothly instead of clamping
    const target = Math.max(cap, hs * Math.exp(-2.5 * dt));
    t.vx *= target / hs; t.vz *= target / hs;
  }

  // jump
  if (inp.j && t.grounded) { t.vy = C.jumpVel; t.grounded = false; ev.jumped = true; }

  // horizontal move with wall sliding (axis separated)
  const footY = t.y - C.hoverHeight;
  if (!tryMove(t, w, footY, t.vx * dt, 0)) t.vx *= -0.2;
  if (!tryMove(t, w, footY, 0, t.vz * dt)) t.vz *= -0.2;
  depenetrate(t, w);

  // vertical
  const ground = heightAt(w, t.x, t.z) + C.hoverHeight;
  if (t.grounded) {
    if (t.y - ground > 0.6) { t.grounded = false; }        // drove off a ledge
    else { t.y = ground; t.vy = 0; }
  }
  if (!t.grounded) {
    // ground slam: after the top of the jump (or straight away when used in the air) it dives hard
    if (t.slam === 1 && t.vy <= 0) t.slam = 2;
    t.vy -= C.gravity * (t.slam === 2 ? ULT.slam.fallG : 1) * dt;
    t.y += t.vy * dt;
    if (t.y <= ground) {
      t.y = ground; t.vy = 0; t.grounded = true; ev.landed = true;
      if (t.slam) { t.slam = 0; ev.slam = true; }
    }
  } else if (t.slam && !ev.jumped) t.slam = 0;
  // safety: never sink below the floor
  if (t.y < (w.floor ?? -10) - 5) { t.y = ground; t.vy = 0; }

  // firing
  t.cooldown = Math.max(0, t.cooldown - dt);
  if (inp.f && t.cooldown <= 0) { t.cooldown = C.fireCooldown * (OD ? OD.fireMul : 1); t.shotSeq++; ev.fired = true; ev.fireSeq = t.shotSeq; }
  return ev;
}

// projectile spawn for the main gun ('shell'), the bounce sidearm and the mega cannon
export function projectile(t, kind = 'shell') {
  const m = muzzle(t);
  if (kind === 'bounce') {
    // fast and flat (easy to bank off walls); gets stronger with every ricochet (see game.js)
    const B = SIDE.bounce, cp = Math.cos(t.aimPitch);
    const dx = -Math.sin(t.aimYaw) * cp, dy = Math.sin(t.aimPitch), dz = -Math.cos(t.aimYaw) * cp;
    return { ...m, vx: dx * B.speed, vy: dy * B.speed + 0.8, vz: dz * B.speed, kind, bounce: B.bounces, g: B.gravity, life: B.life };
  }
  if (kind === 'mega') {
    const U = ULT.mega, cp = Math.cos(t.aimPitch);
    const dx = -Math.sin(t.aimYaw) * cp, dy = Math.sin(t.aimPitch), dz = -Math.cos(t.aimYaw) * cp;
    return { ...m, vx: dx * U.speed, vy: dy * U.speed + 0.5, vz: dz * U.speed, kind, g: U.gravity, hr: U.hitR, life: U.life };
  }
  return { ...m, kind: 'shell', life: C.shellLife };
}
export const SHELL_KINDS = ['shell', 'bounce', 'mega'];

// ---------------------------------------------------------------- shells
export function muzzle(t) {
  const cp = Math.cos(t.aimPitch);
  const dx = -Math.sin(t.aimYaw) * cp, dy = Math.sin(t.aimPitch), dz = -Math.cos(t.aimYaw) * cp;
  return {
    x: t.x + dx * C.muzzleForward, y: t.y + C.muzzleUp + dy * C.muzzleForward, z: t.z + dz * C.muzzleForward,
    vx: dx * C.shellSpeed, vy: dy * C.shellSpeed + 2.0, vz: dz * C.shellSpeed,
  };
}

// aim yaw/pitch that lands a shell on target {x,y,z} (gravity compensated; used by the client
// crosshair and by the CPU players)
export function solveAim(t, target) {
  const bx = t.x, by = t.y + C.muzzleUp, bz = t.z;
  const dx = target.x - bx, dz = target.z - bz;
  const ay = Math.atan2(-dx, -dz);
  const d = Math.max(1, Math.hypot(dx, dz) - C.muzzleForward);
  const v = C.shellSpeed, g = C.shellGravity;
  const yAt = (th) => { const tt = d / (v * Math.cos(th)); return by + C.muzzleForward * Math.sin(th) + (v * Math.sin(th) + 2) * tt - 0.5 * g * tt * tt; };
  let lo = C.aimPitchMin, hi = C.aimPitchMax;
  if (yAt(hi) < target.y) return [ay, hi];
  if (yAt(lo) > target.y) return [ay, lo];
  for (let i = 0; i < 14; i++) { const mid = (lo + hi) / 2; if (yAt(mid) < target.y) lo = mid; else hi = mid; }
  return [ay, (lo + hi) / 2];
}


// Step a shell; returns {hitGround:boolean}. Tank hits are checked by caller with segmentHitsTank.
export function stepShell(s, w, dt = DT) {
  s.px = s.x; s.py = s.y; s.pz = s.z;
  s.vy -= (s.g ?? C.shellGravity) * dt;
  s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt;
  s.life -= dt;
  // sample terrain along the segment (a shell moves 2-5 m per tick)
  const n = s.kind === 'mega' || s.kind === 'bounce' ? 8 : 4;
  let lx = s.px, ly = s.py, lz = s.pz;
  for (let k = 1; k <= n; k++) {
    const f = k / n;
    const x = s.px + (s.x - s.px) * f, y = s.py + (s.y - s.py) * f, z = s.pz + (s.z - s.pz) * f;
    if (y <= heightAt(w, x, z)) {
      if (s.bounce > 0) {
        // ricochet: reflect off the terrain normal (walls are steep, so they reflect sideways)
        const e = 0.5, h0 = heightAt(w, lx, lz);
        const nx = -(heightAt(w, x + e, z) - heightAt(w, x - e, z)) / (2 * e), nz = -(heightAt(w, x, z + e) - heightAt(w, x, z - e)) / (2 * e);
        let gx = nx, gy = 1, gz = nz;
        if (ly > h0 + 0.05 && Math.abs(nx) + Math.abs(nz) < 0.05) { gx = 0; gy = 1; gz = 0; }
        const gl = Math.hypot(gx, gy, gz); gx /= gl; gy /= gl; gz /= gl;
        const vn = s.vx * gx + s.vy * gy + s.vz * gz;
        const r = SIDE.bounce.restitution;
        s.vx = (s.vx - 2 * vn * gx) * r; s.vy = (s.vy - 2 * vn * gy) * r; s.vz = (s.vz - 2 * vn * gz) * r;
        s.x = lx; s.y = Math.max(ly, heightAt(w, lx, lz) + 0.15); s.z = lz;
        s.bounce--;
        return { hitGround: false, bounced: true };
      }
      s.x = x; s.y = y; s.z = z; return { hitGround: true };
    }
    lx = x; ly = y; lz = z;
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
  const r = C.hitRadius + C.shellRadius + (s.hr || 0);
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
