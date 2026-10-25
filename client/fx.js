// Lightweight pooled particle effects. Every particle is a primitive mesh with an unlit (mostly
// additive) material; nothing needs textures or post-processing. The amount scales with quality.
import * as pc from 'playcanvas';

const rnd = (a, b) => a + Math.random() * (b - a);

export class Fx {
  constructor(app, parent) {
    this.app = app;
    this.parent = parent;
    this.live = [];
    this.pools = new Map();
    this.scale = 1;        // particle count multiplier (quality)
    this.max = 220;        // hard cap of live particles
    this.shake = 0;        // camera shake amplitude (m), read by the camera code
    this.listener = null;  // camera position for distance-based shake
    this.m = this.makeMaterials();
  }

  setQuality(q) {
    this.scale = q === 'low' ? 0.35 : q === 'mid' ? 0.7 : 1;
    this.max = q === 'low' ? 70 : q === 'mid' ? 150 : 230;
  }

  makeMaterials() {
    const glow = (r, g, b, opacity = 1) => {
      const m = new pc.StandardMaterial();
      m.diffuse = new pc.Color(0, 0, 0); m.emissive = new pc.Color(r, g, b); m.useLighting = false;
      m.blendType = pc.BLEND_ADDITIVE; m.depthWrite = false; m.opacity = opacity;
      m.update(); return m;
    };
    const flat = (r, g, b) => {
      const m = new pc.StandardMaterial();
      m.diffuse = new pc.Color(0, 0, 0); m.emissive = new pc.Color(r, g, b); m.useLighting = false;
      m.update(); return m;
    };
    const lit = (r, g, b) => { const m = new pc.StandardMaterial(); m.diffuse = new pc.Color(r, g, b); m.update(); return m; };
    return {
      // solid "toon" fire reads much better than additive glow against the bright desert floor
      core: flat(1, 0.96, 0.75), yellow: flat(1, 0.82, 0.25), orange: flat(1, 0.5, 0.1), red: flat(0.85, 0.2, 0.05),
      blue: flat(0.35, 0.75, 1), cyan: glow(0.35, 0.9, 1, 0.5), white: flat(1, 1, 0.92),
      ring: glow(1, 0.8, 0.5, 0.7), dustRing: flat(0.78, 0.64, 0.46),
      smoke: flat(0.30, 0.27, 0.24), smokeLight: flat(0.62, 0.57, 0.50), dust: flat(0.80, 0.66, 0.48),
      debris: lit(0.12, 0.11, 0.1), shell: glow(1, 0.85, 0.45), shellCore: glow(1, 1, 0.9),
      green: flat(0.35, 1, 0.45), greenGlow: glow(0.3, 1, 0.45, 0.6), white2: flat(0.9, 1, 0.92),
    };
  }

  entity(shape) {
    let pool = this.pools.get(shape);
    if (!pool) { pool = []; this.pools.set(shape, pool); }
    let e = pool.pop();
    if (!e) {
      e = new pc.Entity(shape);
      e.addComponent('render', { type: shape, castShadows: false, receiveShadows: false });
      this.parent.addChild(e);
    }
    e.enabled = true;
    return e;
  }

  release(p) { p.e.enabled = false; this.pools.get(p.shape).push(p.e); }

  /**
   * spawn one particle
   * o: { shape, mat, x,y,z, vx,vy,vz, g, drag, life, s0, s1, sx,sy,sz (axis multipliers),
   *      align (stretch along velocity), spin, grow ('out' = grow then fade, default linear s0->s1) }
   */
  add(o) {
    if (this.live.length >= this.max) this.release(this.live.shift());
    const shape = o.shape || 'sphere';
    const e = this.entity(shape);
    e.render.material = o.mat;
    e.setPosition(o.x, o.y, o.z);
    e.setEulerAngles(o.rx || 0, o.ry || 0, o.rz || 0);
    const p = { e, shape, t: 0, life: o.life, x: o.x, y: o.y, z: o.z, vx: o.vx || 0, vy: o.vy || 0, vz: o.vz || 0,
      g: o.g || 0, drag: o.drag || 0, s0: o.s0, s1: o.s1 ?? 0, sx: o.sx || 1, sy: o.sy || 1, sz: o.sz || 1,
      align: !!o.align, spin: o.spin || 0, curve: o.curve || 'lin', floor: o.floor };
    this.live.push(p);
    this.place(p, 0);
    return p;
  }

  place(p, k) {
    let s;
    if (p.curve === 'pop') s = p.s0 + (p.s1 - p.s0) * Math.sin(Math.min(1, k) * Math.PI * 0.5);      // fast grow
    else if (p.curve === 'puff') s = p.s1 * Math.sin(Math.min(1, k * 1.6) * Math.PI * 0.5) * (1 - k * 0.7);
    else s = p.s0 + (p.s1 - p.s0) * k;
    s = Math.max(0.001, s);
    if (p.align) {
      const sp = Math.hypot(p.vx, p.vy, p.vz) || 1;
      p.e.lookAt(p.x + p.vx / sp, p.y + p.vy / sp, p.z + p.vz / sp);
      p.e.setLocalScale(s * p.sx, s * p.sy, s * p.sz * Math.min(4, 0.4 + sp * 0.08));
    } else p.e.setLocalScale(s * p.sx, s * p.sy, s * p.sz);
  }

  update(dt) {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const p = this.live[i];
      p.t += dt;
      const k = p.t / p.life;
      if (k >= 1) { this.release(p); this.live.splice(i, 1); continue; }
      if (p.drag) { const f = Math.exp(-p.drag * dt); p.vx *= f; p.vy *= f; p.vz *= f; }
      p.vy -= p.g * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      if (p.floor !== undefined && p.y < p.floor) { p.y = p.floor; p.vy = Math.abs(p.vy) * 0.35; p.vx *= 0.6; p.vz *= 0.6; }
      p.e.setPosition(p.x, p.y, p.z);
      if (p.spin) p.e.rotateLocal(p.spin * dt, p.spin * 0.7 * dt, 0);
      this.place(p, k);
    }
    this.shake *= Math.exp(-7 * dt);
  }

  n(count) { return Math.max(1, Math.round(count * this.scale)); }

  addShake(amount, x, y, z) {
    let a = amount;
    if (this.listener && x !== undefined) {
      const d = Math.hypot(x - this.listener.x, y - this.listener.y, z - this.listener.z);
      a = amount * Math.max(0, 1 - d / 45);
    }
    this.shake = Math.min(1.2, this.shake + a);
  }

  // ------------------------------------------------------------------ recipes
  muzzle(x, y, z, dx, dy, dz) {
    const m = this.m;
    this.add({ mat: m.core, x, y, z, life: 0.09, s0: 1.6, s1: 0.3 });
    this.add({ mat: m.orange, x: x + dx * 0.6, y: y + dy * 0.6, z: z + dz * 0.6, life: 0.12, s0: 1.3, s1: 0.2, sx: 0.7, sy: 0.7, sz: 1.8, ry: Math.atan2(dx, dz) * 57.3 });
    for (let i = 0; i < this.n(6); i++) {
      const sp = rnd(14, 30);
      this.add({ shape: 'box', mat: m.yellow, x, y, z, vx: (dx + rnd(-0.25, 0.25)) * sp, vy: (dy + rnd(-0.15, 0.3)) * sp, vz: (dz + rnd(-0.25, 0.25)) * sp, g: 12, life: rnd(0.12, 0.22), s0: 0.12, s1: 0.04, align: true });
    }
    this.add({ mat: m.smokeLight, x: x + dx, y, z: z + dz, vx: dx * 3, vy: 1.2, vz: dz * 3, drag: 2, life: 0.6, s0: 0, s1: 1.1, curve: 'puff' });
  }

  trail(x, y, z, big) {
    if (Math.random() > this.scale) return;
    this.add({ mat: big ? this.m.orange : this.m.yellow, x, y, z, vy: 0.3, life: big ? 0.22 : 0.14, s0: big ? 0.55 : 0.4, s1: 0 });
  }

  explosion(x, y, z, size = 1.6) {
    const m = this.m;
    this.add({ mat: m.core, x, y, z, life: 0.1, s0: size * 0.9, s1: size * 1.6, curve: 'pop' });
    for (let i = 0; i < this.n(3); i++) {
      this.add({ mat: i % 2 ? m.orange : m.yellow, x: x + rnd(-0.5, 0.5) * size, y: y + rnd(0, 0.6) * size, z: z + rnd(-0.5, 0.5) * size, vy: rnd(1, 3), drag: 1.5, life: rnd(0.3, 0.5), s0: 0, s1: size * rnd(1.1, 1.7), curve: 'puff' });
    }
    for (let i = 0; i < this.n(10); i++) {
      const a = rnd(0, 6.283), up = rnd(0.2, 1), sp = rnd(8, 20) * Math.sqrt(size / 1.6);
      this.add({ shape: 'box', mat: i % 3 ? m.yellow : m.core, x, y, z, vx: Math.cos(a) * sp * (1 - up * 0.5), vy: up * sp, vz: Math.sin(a) * sp * (1 - up * 0.5), g: 22, drag: 0.8, life: rnd(0.35, 0.7), s0: 0.16, s1: 0.05, align: true, floor: 0.05 });
    }
    this.add({ shape: 'torus', mat: m.dustRing, x, y: y + 0.1, z, life: 0.5, s0: size * 0.6, s1: size * 3.2, sy: 0.12, curve: 'pop' });
    for (let i = 0; i < this.n(2); i++) {
      this.add({ mat: m.smoke, x: x + rnd(-0.4, 0.4) * size, y: y + 0.3, z: z + rnd(-0.4, 0.4) * size, vy: rnd(1.5, 3), drag: 1.2, life: rnd(1.0, 1.5), s0: 0, s1: size * rnd(1.0, 1.5), curve: 'puff' });
    }
    this.addShake(0.12 * size, x, y, z);
  }

  hitSpark(x, y, z) {
    this.explosion(x, y, z, 2.0);
    for (let i = 0; i < this.n(8); i++) {
      const a = rnd(0, 6.283), sp = rnd(12, 26);
      this.add({ shape: 'box', mat: this.m.white, x, y, z, vx: Math.cos(a) * sp, vy: rnd(2, 10), vz: Math.sin(a) * sp, g: 25, life: rnd(0.2, 0.4), s0: 0.14, s1: 0.03, align: true });
    }
  }

  shieldSpark(x, y, z) {
    this.add({ mat: this.m.cyan, x, y, z, life: 0.2, s0: 1.2, s1: 3.2, curve: 'pop' });
    for (let i = 0; i < this.n(8); i++) {
      const a = rnd(0, 6.283), sp = rnd(8, 16);
      this.add({ shape: 'box', mat: this.m.blue, x, y, z, vx: Math.cos(a) * sp, vy: rnd(0, 8), vz: Math.sin(a) * sp, g: 15, life: 0.3, s0: 0.12, s1: 0.02, align: true });
    }
  }

  bigKill(x, y, z, color) {
    const m = this.m;
    this.add({ mat: m.core, x, y: y + 1, z, life: 0.16, s0: 2.5, s1: 5.5, curve: 'pop' });
    for (let i = 0; i < this.n(6); i++) {
      this.add({ mat: [m.orange, m.yellow, m.red][i % 3], x: x + rnd(-1.5, 1.5), y: y + rnd(0.5, 2.5), z: z + rnd(-1.5, 1.5), vy: rnd(2, 6), drag: 1.2, life: rnd(0.5, 0.9), s0: 0, s1: rnd(2.5, 4), curve: 'puff' });
    }
    this.add({ shape: 'torus', mat: m.ring, x, y: y + 0.3, z, life: 0.55, s0: 1, s1: 18, sy: 0.06, curve: 'pop' });
    this.add({ shape: 'torus', mat: m.dustRing, x, y: y + 0.1, z, life: 0.8, s0: 1, s1: 11, sy: 0.15, curve: 'pop' });
    for (let i = 0; i < this.n(12); i++) {
      const a = rnd(0, 6.283), sp = rnd(5, 13);
      this.add({ shape: 'box', mat: i % 3 === 0 && color ? color : m.debris, x, y: y + 1, z, vx: Math.cos(a) * sp, vy: rnd(7, 15), vz: Math.sin(a) * sp, g: 26, life: rnd(1.0, 1.6), s0: rnd(0.35, 0.7), s1: 0.2, spin: rnd(4, 12), floor: 0.15 });
    }
    for (let i = 0; i < this.n(16); i++) {
      const a = rnd(0, 6.283), up = rnd(0.3, 1), sp = rnd(14, 30);
      this.add({ shape: 'box', mat: i % 2 ? m.yellow : m.orange, x, y: y + 1, z, vx: Math.cos(a) * sp * (1 - up * 0.4), vy: up * sp, vz: Math.sin(a) * sp * (1 - up * 0.4), g: 20, drag: 0.6, life: rnd(0.5, 1.0), s0: 0.2, s1: 0.05, align: true, floor: 0.05 });
    }
    for (let i = 0; i < this.n(5); i++) {
      this.add({ mat: m.smoke, x: x + rnd(-1, 1), y: y + 1 + i * 0.5, z: z + rnd(-1, 1), vy: rnd(2, 4), drag: 0.6, life: rnd(1.6, 2.4), s0: 0, s1: rnd(2.2, 3.2), curve: 'puff' });
    }
    this.addShake(0.8, x, y, z);
  }

  dust(x, y, z, count, size) {
    for (let i = 0; i < this.n(count); i++) {
      const a = rnd(0, 6.283), r = rnd(0.5, 2);
      this.add({ mat: this.m.dust, x: x + Math.cos(a) * r, y: y + 0.2, z: z + Math.sin(a) * r, vx: Math.cos(a) * 3, vy: rnd(0.5, 1.5), vz: Math.sin(a) * 3, drag: 3, life: rnd(0.4, 0.7), s0: 0, s1: size * rnd(0.7, 1.2), curve: 'puff' });
    }
  }

  landRing(x, y, z, strength = 1) {
    this.add({ shape: 'torus', mat: this.m.dustRing, x, y: y + 0.1, z, life: 0.45, s0: 1, s1: 5 * strength, sy: 0.12, curve: 'pop' });
    this.dust(x, y, z, 5 * strength, 1.2);
    this.addShake(0.08 * strength, x, y, z);
  }

  jumpRing(x, y, z) {
    this.add({ shape: 'torus', mat: this.m.cyan, x, y: y + 0.2, z, life: 0.35, s0: 1.5, s1: 4.5, sy: 0.1, curve: 'pop' });
    this.dust(x, y, z, 3, 0.9);
  }

  // sparks off the back of the tracks while sliding; colour shows the drift charge level
  driftSparks(x, y, z, yaw, level) {
    const mat = level >= 2 ? this.m.orange : level >= 1 ? this.m.blue : this.m.white;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw);
    for (const side of [-1, 1]) {
      if (Math.random() > 0.75 * this.scale + 0.2) continue;
      const px = x - fx * 1.9 + rx * side * 1.35, pz = z - fz * 1.9 + rz * side * 1.35;
      const sp = rnd(4, 9);
      this.add({ shape: 'box', mat, x: px, y: y + 0.05, z: pz, vx: (-fx + rx * side * rnd(0.2, 0.8)) * sp, vy: rnd(1.5, 5), vz: (-fz + rz * side * rnd(0.2, 0.8)) * sp, g: 18, life: rnd(0.2, 0.35), s0: level ? 0.16 : 0.1, s1: 0.02, align: true, floor: y });
    }
    if (Math.random() < 0.35 * this.scale) this.add({ mat: this.m.dust, x: x - fx * 2, y: y + 0.3, z: z - fz * 2, vy: 0.8, drag: 2, life: 0.5, s0: 0, s1: 1.1, curve: 'puff' });
  }

  boostBurst(x, y, z, yaw, level) {
    const mat = level >= 2 ? this.m.orange : this.m.blue;
    this.add({ shape: 'torus', mat, x, y: y + 0.6, z, life: 0.25, s0: 1.5, s1: 3.5 + level * 1.5, sy: 0.08, curve: 'pop' });
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    for (let i = 0; i < this.n(10); i++) {
      const sp = rnd(10, 22);
      this.add({ shape: 'box', mat: i % 2 ? mat : this.m.core, x: x - fx * 2, y: y + 0.8, z: z - fz * 2, vx: (-fx + rnd(-0.4, 0.4)) * sp, vy: rnd(0, 4), vz: (-fz + rnd(-0.4, 0.4)) * sp, g: 8, life: rnd(0.25, 0.4), s0: 0.2, s1: 0.04, align: true });
    }
  }

  // exhaust flame behind the hull while boosting (called every frame)
  exhaust(x, y, z, yaw, level) {
    const mat = level >= 2 ? this.m.orange : this.m.blue;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw);
    for (const side of [-1, 1]) {
      const px = x - fx * 2.2 + rx * side * 0.8, pz = z - fz * 2.2 + rz * side * 0.8;
      this.add({ mat, x: px, y: y + 0.9, z: pz, vx: -fx * 9, vy: 0.5, vz: -fz * 9, life: 0.16, s0: 0.8, s1: 0.1 });
      if (Math.random() < 0.5) this.add({ mat: this.m.core, x: px, y: y + 0.9, z: pz, vx: -fx * 6, vz: -fz * 6, life: 0.08, s0: 0.45, s1: 0.1 });
    }
  }

  damageSmoke(x, y, z, heavy) {
    this.add({ mat: heavy ? this.m.smoke : this.m.smokeLight, x: x + rnd(-0.4, 0.4), y: y + 1.9, z: z + rnd(-0.4, 0.4), vy: rnd(2, 3.5), drag: 0.8, life: rnd(0.9, 1.4), s0: 0, s1: heavy ? rnd(1.2, 1.8) : rnd(0.7, 1.1), curve: 'puff' });
    if (heavy && Math.random() < 0.3) this.add({ mat: this.m.orange, x, y: y + 1.7, z, vy: 2, life: 0.25, s0: 0.6, s1: 0 });
  }

  healBurst(x, y, z) {
    const m = this.m;
    this.add({ mat: m.white2, x, y, z, life: 0.15, s0: 1.5, s1: 3.5, curve: 'pop' });
    this.add({ shape: 'torus', mat: m.greenGlow, x, y: y - 1, z, life: 0.6, s0: 1, s1: 9, sy: 0.08, curve: 'pop' });
    this.add({ shape: 'cylinder', mat: m.greenGlow, x, y: y + 6, z, life: 0.7, s0: 2.2, s1: 0, sy: 7 });
    for (let i = 0; i < this.n(18); i++) {
      const a = rnd(0, 6.283), sp = rnd(3, 9);
      this.add({ shape: 'box', mat: i % 2 ? m.green : m.white2, x, y, z, vx: Math.cos(a) * sp, vy: rnd(4, 12), vz: Math.sin(a) * sp, g: 9, drag: 1.2, life: rnd(0.6, 1.1), s0: 0.3, s1: 0.05, spin: 8 });
    }
  }

  healSpawn(x, y, z) {
    this.add({ shape: 'cylinder', mat: this.m.greenGlow, x, y: y + 15, z, life: 1.0, s0: 1.6, s1: 0, sy: 20 });
    this.add({ shape: 'torus', mat: this.m.greenGlow, x, y: y + 0.2, z, life: 0.8, s0: 10, s1: 2, sy: 0.08 });
  }

  respawnBeam(x, y, z, colorMat) {
    this.add({ shape: 'cylinder', mat: colorMat || this.m.cyan, x, y: y + 12, z, life: 0.9, s0: 3.2, s1: 0, sy: 8 });
    this.add({ shape: 'cylinder', mat: this.m.core, x, y: y + 12, z, life: 0.4, s0: 0.5, s1: 0, sy: 48 });
    this.add({ shape: 'torus', mat: colorMat || this.m.cyan, x, y: y + 0.2, z, life: 0.6, s0: 6, s1: 1, sy: 0.1 });
  }
}
