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
    this.queue = [];       // delayed effects [{t, fn}] (secondary explosions etc.)
    this.lightOn = true;   // dynamic flash light (off on the low quality setting)
    // one pooled point light for explosion flashes
    this.light = new pc.Entity('fxLight');
    this.light.addComponent('light', { type: 'omni', color: new pc.Color(1, 0.7, 0.35), intensity: 0, range: 30, castShadows: false });
    this.light.enabled = false;
    parent.addChild(this.light);
    this.lightT = 0; this.lightLife = 1; this.lightI = 0;
  }

  // a bright flash that lights up the ground and nearby tanks for a moment
  flash(x, y, z, rgb = [1, 0.7, 0.35], intensity = 5, life = 0.35, range = 30) {
    if (!this.lightOn) return;
    const l = this.light;
    l.setPosition(x, y + 2, z);
    l.light.color = new pc.Color(...rgb); l.light.range = range;
    this.lightT = 0; this.lightLife = life; this.lightI = intensity;
    l.light.intensity = intensity; l.enabled = true;
  }
  later(delay, fn) { this.queue.push({ t: delay, fn }); }

  setQuality(q) {
    this.scale = q === 'low' ? 0.35 : q === 'mid' ? 0.7 : 1;
    this.max = q === 'low' ? 90 : q === 'mid' ? 220 : 380;
    this.lightOn = q !== 'low';
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
      flashGlow: glow(1, 0.75, 0.4, 0.55), whiteGlow: glow(1, 0.95, 0.85, 0.9), ember: glow(1, 0.55, 0.15, 1),
      smokeDark: flat(0.17, 0.15, 0.14), scorch: this.scorchMat(),
    };
  }

  // dark burnt patch left on the ground (radial gradient, generated at runtime)
  scorchMat() {
    const cv = document.createElement('canvas'); cv.width = cv.height = 64;
    const g = cv.getContext('2d'), gr = g.createRadialGradient(32, 32, 3, 32, 32, 31);
    gr.addColorStop(0, 'rgba(0,0,0,0.75)'); gr.addColorStop(0.6, 'rgba(10,6,3,0.45)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
    const tex = new pc.Texture(this.app.graphicsDevice, { width: 64, height: 64, format: pc.PIXELFORMAT_RGBA8, mipmaps: true });
    tex.setSource(cv);
    const m = new pc.StandardMaterial();
    m.diffuse = new pc.Color(0, 0, 0); m.opacityMap = tex; m.opacityMapChannel = 'a';
    m.blendType = pc.BLEND_NORMAL; m.depthWrite = false; m.useLighting = false; m.update();
    return m;
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
      align: !!o.align, spin: o.spin || 0, curve: o.curve || 'lin', floor: o.floor, emit: o.emit, emitEvery: o.emitEvery || 0.05, emitT: 0 };
    this.live.push(p);
    this.place(p, 0);
    return p;
  }

  place(p, k) {
    let s;
    if (p.curve === 'pop') s = p.s0 + (p.s1 - p.s0) * Math.sin(Math.min(1, k) * Math.PI * 0.5);      // fast grow
    else if (p.curve === 'puff') s = p.s1 * Math.sin(Math.min(1, k * 1.6) * Math.PI * 0.5) * (1 - k * 0.7);
    else if (p.curve === 'hold') s = k < 0.75 ? p.s0 : p.s0 + (p.s1 - p.s0) * ((k - 0.75) / 0.25);         // stays, then fades out
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
      if (p.emit && (p.emitT -= dt) <= 0) { p.emitT = p.emitEvery; (this.emits ??= []).push(p); }   // trails behind flying debris
    }
    if (this.emits?.length) { const list = this.emits; this.emits = []; for (const p of list) p.emit(p); }
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const q = this.queue[i];
      if ((q.t -= dt) <= 0) { this.queue.splice(i, 1); q.fn(); }
    }
    if (this.light.enabled) {
      this.lightT += dt;
      const k = this.lightT / this.lightLife;
      if (k >= 1) { this.light.enabled = false; this.light.light.intensity = 0; } else this.light.light.intensity = this.lightI * (1 - k) * (1 - k);
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
    this.add({ mat: m.flashGlow, x, y, z, life: 0.12, s0: 2.2, s1: 3.6, curve: 'pop' });
    this.add({ shape: 'torus', mat: m.ring, x: x + dx * 0.5, y: y + dy * 0.5, z: z + dz * 0.5, life: 0.16, s0: 0.4, s1: 2.6, sy: 0.12, rx: 90, ry: Math.atan2(dx, dz) * 57.3, curve: 'pop' });
    this.add({ mat: m.orange, x: x + dx * 0.6, y: y + dy * 0.6, z: z + dz * 0.6, life: 0.12, s0: 1.3, s1: 0.2, sx: 0.7, sy: 0.7, sz: 1.8, ry: Math.atan2(dx, dz) * 57.3 });
    for (let i = 0; i < this.n(6); i++) {
      const sp = rnd(14, 30);
      this.add({ shape: 'box', mat: m.yellow, x, y, z, vx: (dx + rnd(-0.25, 0.25)) * sp, vy: (dy + rnd(-0.15, 0.3)) * sp, vz: (dz + rnd(-0.25, 0.25)) * sp, g: 12, life: rnd(0.12, 0.22), s0: 0.12, s1: 0.04, align: true });
    }
    this.add({ mat: m.smokeLight, x: x + dx, y, z: z + dz, vx: dx * 3, vy: 1.2, vz: dz * 3, drag: 2, life: 0.6, s0: 0, s1: 1.1, curve: 'puff' });
  }

  trail(x, y, z, big, mat) {
    if (Math.random() > this.scale) return;
    this.add({ mat: mat || (big ? this.m.orange : this.m.yellow), x, y, z, vy: 0.3, life: big ? 0.22 : 0.14, s0: big ? 0.55 : 0.4, s1: 0 });
  }

  // cached flat / additive colour materials for cosmetic variants
  col(rgb, additive = false, opacity = 1) {
    const k = `${rgb.map((v) => v.toFixed(2))}:${additive}:${opacity}`;
    this.cols ??= new Map();
    let m = this.cols.get(k);
    if (!m) {
      m = new pc.StandardMaterial();
      m.diffuse = new pc.Color(0, 0, 0); m.emissive = new pc.Color(...rgb); m.useLighting = false;
      if (additive) { m.blendType = pc.BLEND_ADDITIVE; m.depthWrite = false; m.opacity = opacity; }
      m.update(); this.cols.set(k, m);
    }
    return m;
  }

  // Tank destroyed: a multi-stage explosion in the killer's style
  // ('std' | 'plasma' | 'firework' | 'confetti' | 'blackflame').
  // opts: { groundY, big } — big = you scored it or it was you (more intense, closer to the camera)
  killStyle(x, y, z, color, style = 'std', opts = {}) {
    const m = this.m, gy = opts.groundY ?? y - 0.6, cy = y + 1;
    const P = {
      std: { fire: [m.core, m.yellow, m.orange, m.red], glow: [1, 0.65, 0.3], light: [1, 0.6, 0.25] },
      plasma: { fire: [[1, 1, 1], [0.55, 0.95, 1], [0.4, 0.7, 1], [0.75, 0.45, 1]], glow: [0.45, 0.85, 1], light: [0.4, 0.75, 1] },
      firework: { fire: [m.core, [1, 0.5, 0.6], [1, 0.85, 0.3], [0.5, 0.7, 1]], glow: [1, 0.6, 0.8], light: [1, 0.7, 0.8] },
      confetti: { fire: [m.core, m.yellow, [1, 0.6, 0.75], [0.5, 0.85, 1]], glow: [1, 0.85, 0.5], light: [1, 0.85, 0.6] },
      blackflame: { fire: [[0.85, 0.5, 1], [0.45, 0.1, 0.6], [0.2, 0.05, 0.3], [0.08, 0.03, 0.1]], glow: [0.6, 0.2, 0.9], light: [0.7, 0.3, 1] },
    }[style] || null;
    const pal = P || { fire: [m.core, m.yellow, m.orange, m.red], glow: [1, 0.65, 0.3], light: [1, 0.6, 0.25] };
    const fire = pal.fire.map((c) => (Array.isArray(c) ? this.col(c) : c));
    const glow = this.col(pal.glow, true, 0.75), glowSoft = this.col(pal.glow, true, 0.2);
    const k = opts.big ? 1.15 : 1;

    // 1. blinding core + light flash
    this.flash(x, y, z, pal.light, opts.big ? 9 : 6, 0.55, 34);
    this.add({ mat: m.whiteGlow, x, y: cy, z, life: 0.12, s0: 3 * k, s1: 6.5 * k, curve: 'pop' });
    this.add({ mat: glowSoft, x, y: cy, z, life: 0.3, s0: 3, s1: 11 * k, curve: 'pop' });
    this.add({ mat: fire[0], x, y: cy, z, life: 0.18, s0: 2.5, s1: 6 * k, curve: 'pop' });
    // 2. rolling fireball (toon puffs, rising)
    for (let i = 0; i < this.n(10); i++) {
      const a = rnd(0, 6.283), r = rnd(0.3, 2.2);
      this.add({ mat: fire[1 + (i % 3)], x: x + Math.cos(a) * r, y: cy + rnd(-0.3, 1.8), z: z + Math.sin(a) * r, vx: Math.cos(a) * rnd(1, 4), vy: rnd(2, 7), vz: Math.sin(a) * rnd(1, 4), drag: 1.4, life: rnd(0.5, 1.0), s0: 0, s1: rnd(2.6, 4.6) * k, curve: 'puff' });
    }
    // 3. shockwaves: bright ring, dust ring, a second ring a beat later, a vertical pillar
    this.add({ shape: 'torus', mat: glow, x, y: gy + 0.4, z, life: 0.5, s0: 1, s1: 24 * k, sy: 0.05, curve: 'pop' });
    this.add({ shape: 'torus', mat: m.dustRing, x, y: gy + 0.15, z, life: 0.9, s0: 1, s1: 14, sy: 0.16, curve: 'pop' });
    this.later(0.09, () => this.add({ shape: 'torus', mat: m.ring, x, y: gy + 0.3, z, life: 0.45, s0: 1, s1: 16, sy: 0.05, curve: 'pop' }));
    this.add({ shape: 'cylinder', mat: glow, x, y: gy + 7, z, life: 0.35, s0: 2.6 * k, s1: 0, sy: 7 });
    // 4. spark fountain
    for (let i = 0; i < this.n(28); i++) {
      const a = rnd(0, 6.283), up = rnd(0.25, 1), sp = rnd(16, 36);
      this.add({ shape: 'box', mat: i % 3 ? fire[1] : fire[0], x, y: cy, z, vx: Math.cos(a) * sp * (1 - up * 0.45), vy: up * sp, vz: Math.sin(a) * sp * (1 - up * 0.45), g: 22, drag: 0.6, life: rnd(0.5, 1.1), s0: 0.22, s1: 0.04, align: true, floor: gy + 0.05 });
    }
    // 5. debris chunks trailing smoke, and the turret flying high in the victim's colour
    const smokeTrail = (p) => this.add({ mat: m.smokeLight, x: p.x, y: p.y, z: p.z, vy: 0.5, drag: 1, life: 0.6, s0: 0, s1: 1.1 + p.s0, curve: 'puff' });
    const fireTrail = (p) => this.add({ mat: fire[2], x: p.x, y: p.y, z: p.z, life: 0.22, s0: 0.7, s1: 0 });
    for (let i = 0; i < this.n(14); i++) {
      const a = rnd(0, 6.283), sp = rnd(6, 15);
      this.add({ shape: 'box', mat: i % 3 === 0 && color ? color : m.debris, x, y: cy, z, vx: Math.cos(a) * sp, vy: rnd(8, 17), vz: Math.sin(a) * sp, g: 26, life: rnd(1.2, 1.9), s0: rnd(0.35, 0.75), s1: 0.25, spin: rnd(4, 12), floor: gy + 0.15, emit: i % 2 ? smokeTrail : null, emitEvery: 0.06 });
    }
    const ta = rnd(0, 6.283);
    this.add({ shape: 'box', mat: color || m.debris, x, y: cy + 0.6, z, vx: Math.cos(ta) * 4, vy: 19, vz: Math.sin(ta) * 4, g: 24, life: 2.0, s0: 1.3, s1: 0.9, sx: 1, sy: 0.6, sz: 1.2, spin: 9, floor: gy + 0.3, emit: (p) => { fireTrail(p); smokeTrail(p); }, emitEvery: 0.04 });
    // 6. secondary blasts around the wreck
    for (let i = 0; i < 3; i++) {
      this.later(0.14 + i * 0.16 + rnd(0, 0.06), () => {
        const a = rnd(0, 6.283), r = rnd(1, 2.6);
        this.explosion(x + Math.cos(a) * r, cy + rnd(-0.4, 0.8), z + Math.sin(a) * r, 1.3 + i * 0.25);
        this.addShake(0.25, x, y, z);
      });
    }
    // 7. smoke column, embers, scorch mark
    for (let i = 0; i < this.n(7); i++) {
      this.later(0.1 + i * 0.12, () => this.add({ mat: i % 2 ? m.smoke : m.smokeDark, x: x + rnd(-1, 1), y: cy + 0.5, z: z + rnd(-1, 1), vy: rnd(2.5, 4.5), vx: rnd(-0.6, 0.6), drag: 0.45, life: rnd(2.2, 3.2), s0: 0, s1: rnd(2.6, 4), curve: 'puff' }));
    }
    for (let i = 0; i < this.n(14); i++) {
      const a = rnd(0, 6.283), r = rnd(0, 2.5);
      this.add({ mat: m.ember, x: x + Math.cos(a) * r, y: cy + rnd(0, 1.5), z: z + Math.sin(a) * r, vx: rnd(-1, 1), vy: rnd(1.5, 4), vz: rnd(-1, 1), drag: 0.8, life: rnd(1.2, 2.2), s0: 0.2, s1: 0, spin: 4 });
    }
    this.add({ shape: 'plane', mat: m.scorch, x, y: gy + 0.05, z, life: 6, s0: 7.5, s1: 7.5, curve: 'hold', ry: rnd(0, 360) });

    // style extras
    const mats = pal.fire.map((c) => (Array.isArray(c) ? this.col(c) : c));
    if (style === 'plasma') {
      this.add({ mat: glow, x, y: cy + 0.2, z, life: 0.6, s0: 1, s1: 9, curve: 'pop' });
      this.add({ shape: 'cylinder', mat: glow, x, y: gy + 14, z, life: 0.8, s0: 1.6, s1: 0, sy: 14 });
      for (let i = 0; i < this.n(30); i++) {
        const a = rnd(0, 6.283), sp = rnd(18, 36);
        this.add({ shape: 'box', mat: mats[i % 4], x, y: cy, z, vx: Math.cos(a) * sp, vy: rnd(-2, 6), vz: Math.sin(a) * sp, drag: 2.5, life: rnd(0.4, 0.9), s0: 0.24, s1: 0.03, align: true });
      }
      for (let r = 0; r < 3; r++) this.later(r * 0.08, () => this.add({ shape: 'torus', mat: glow, x, y: cy + r * 0.8, z, life: 0.4, s0: 1, s1: 10 + r * 3, sy: 0.08, rx: rnd(-20, 20), curve: 'pop' }));
    } else if (style === 'firework') {
      const shells = [[1, 0.3, 0.35], [0.35, 1, 0.5], [0.4, 0.6, 1], [1, 0.9, 0.3], [1, 0.5, 1]];
      for (let b = 0; b < 4; b++) {
        this.later(0.25 + b * 0.22, () => {
          const bx = x + rnd(-4, 4), by = y + 8 + rnd(0, 5), bz = z + rnd(-4, 4), c = shells[(b * 2) % shells.length], mm = this.col(c), gg = this.col(c, true, 0.8);
          this.flash(bx, by - 2, bz, c, 3, 0.35, 26);
          this.add({ mat: gg, x: bx, y: by, z: bz, life: 0.2, s0: 2, s1: 5, curve: 'pop' });
          for (let i = 0; i < this.n(26); i++) {
            const a = rnd(0, 6.283), e = rnd(-1, 1), sp = rnd(10, 15);
            this.add({ shape: 'box', mat: i % 4 ? mm : m.white, x: bx, y: by, z: bz, vx: Math.cos(a) * sp * Math.sqrt(1 - e * e), vy: e * sp, vz: Math.sin(a) * sp * Math.sqrt(1 - e * e), g: 5, drag: 1.6, life: rnd(0.9, 1.4), s0: 0.24, s1: 0.04, align: true });
          }
        });
      }
    } else if (style === 'confetti') {
      const cols = [[1, 0.35, 0.4], [1, 0.85, 0.25], [0.35, 0.8, 1], [0.5, 1, 0.5], [1, 1, 1], [1, 0.55, 0.9]].map((c) => this.col(c));
      for (let i = 0; i < this.n(60); i++) {
        const a = rnd(0, 6.283), sp = rnd(3, 11);
        this.add({ shape: 'box', mat: cols[i % cols.length], x, y: cy + 0.5, z, vx: Math.cos(a) * sp, vy: rnd(12, 22), vz: Math.sin(a) * sp, g: 8, drag: 1.5, life: rnd(1.8, 2.8), s0: 0.34, s1: 0.24, sy: 0.12, spin: rnd(6, 14), floor: gy + 0.1 });
      }
    } else if (style === 'blackflame') {
      for (let i = 0; i < this.n(12); i++) {
        this.later(i * 0.05, () => this.add({ mat: mats[1 + (i % 3)], x: x + rnd(-1.6, 1.6), y: cy + rnd(0, 2.5), z: z + rnd(-1.6, 1.6), vy: rnd(3, 8), drag: 0.8, life: rnd(1, 1.7), s0: 0, s1: rnd(2.6, 4.4), curve: 'puff' }));
      }
      this.add({ shape: 'torus', mat: this.col([0.5, 0.15, 0.8], true, 0.8), x, y: gy + 0.3, z, life: 1.2, s0: 16, s1: 1, sy: 0.05 });   // implodes
    }
    this.addShake(opts.big ? 1.1 : 0.85, x, y, z);
  }
  bigKill(x, y, z, color) { this.killStyle(x, y, z, color, 'std'); }

  explosion(x, y, z, size = 1.6) {
    const m = this.m;
    this.add({ mat: m.core, x, y, z, life: 0.1, s0: size * 0.9, s1: size * 1.6, curve: 'pop' });
    this.add({ mat: m.flashGlow, x, y, z, life: 0.18, s0: size * 1.1, s1: size * 2.6, curve: 'pop' });
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
    this.explosion(x, y, z, 2.2);
    this.flash(x, y, z, [1, 0.8, 0.5], 2.5, 0.2, 18);
    this.add({ mat: this.m.whiteGlow, x, y, z, life: 0.08, s0: 2.5, s1: 4, curve: 'pop' });
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
  driftSparks(x, y, z, yaw, level, baseMat) {
    // level colours (blue / orange) tell everyone the boost charge; only the base colour is cosmetic
    const mat = level >= 2 ? this.m.orange : level >= 1 ? this.m.blue : baseMat || this.m.white;
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

  // ------------------------------------------------------------------ sidearms / specials
  dashBurst(x, y, z, dx, dz) {
    const m = this.m, a = Math.atan2(dx, dz) * 57.3;
    this.add({ shape: 'torus', mat: m.cyan, x, y: y + 0.9, z, life: 0.25, s0: 2, s1: 6, sy: 0.1, rx: 90, ry: a, curve: 'pop' });
    this.add({ mat: m.cyan, x, y: y + 0.9, z, life: 0.18, s0: 2.5, s1: 4, curve: 'pop' });
    for (let i = 0; i < this.n(14); i++) {
      const sp = rnd(14, 28);
      this.add({ shape: 'box', mat: i % 3 ? m.blue : m.white, x: x + rnd(-1, 1), y: y + rnd(0.3, 1.6), z: z + rnd(-1, 1), vx: (-dx + rnd(-0.3, 0.3)) * sp, vy: rnd(-1, 2), vz: (-dz + rnd(-0.3, 0.3)) * sp, drag: 3, life: rnd(0.2, 0.35), s0: 0.22, s1: 0.03, align: true });
    }
    this.dust(x, y, z, 4, 1.2);
  }
  // after-images while the dash lasts (called per frame)
  dashTrail(x, y, z) {
    if (Math.random() > this.scale) return;
    this.add({ mat: this.m.cyan, x: x + rnd(-0.6, 0.6), y: y + rnd(0.5, 1.5), z: z + rnd(-0.6, 0.6), life: 0.18, s0: 1.2, s1: 0 });
  }
  shieldUp(x, y, z) {
    this.add({ mat: this.m.cyan, x, y: y + 1, z, life: 0.25, s0: 2, s1: 7, curve: 'pop' });
    this.add({ shape: 'torus', mat: this.m.cyan, x, y: y + 0.3, z, life: 0.35, s0: 2, s1: 8, sy: 0.08, curve: 'pop' });
  }
  reflectBurst(x, y, z) {
    const m = this.m;
    this.flash(x, y, z, [0.6, 0.9, 1], 4, 0.3, 20);
    this.add({ mat: m.whiteGlow, x, y, z, life: 0.14, s0: 2, s1: 5, curve: 'pop' });
    this.add({ shape: 'torus', mat: m.cyan, x, y, z, life: 0.3, s0: 1, s1: 8, sy: 0.1, rx: rnd(60, 120), ry: rnd(0, 360), curve: 'pop' });
    for (let i = 0; i < this.n(16); i++) {
      const a = rnd(0, 6.283), e = rnd(-0.6, 1), sp = rnd(12, 26);
      this.add({ shape: 'box', mat: i % 2 ? m.white : m.blue, x, y, z, vx: Math.cos(a) * sp, vy: e * sp, vz: Math.sin(a) * sp, g: 10, life: rnd(0.25, 0.45), s0: 0.16, s1: 0.03, align: true });
    }
  }
  rico(x, y, z) {
    this.add({ mat: this.m.core, x, y, z, life: 0.08, s0: 1, s1: 2, curve: 'pop' });
    for (let i = 0; i < this.n(8); i++) {
      const a = rnd(0, 6.283), sp = rnd(8, 18);
      this.add({ shape: 'box', mat: this.m.yellow, x, y, z, vx: Math.cos(a) * sp, vy: rnd(2, 9), vz: Math.sin(a) * sp, g: 20, life: rnd(0.2, 0.35), s0: 0.12, s1: 0.02, align: true });
    }
  }
  megaMuzzle(x, y, z, dx, dy, dz) {
    const m = this.m, pink = this.col([1, 0.45, 1], true, 0.45);
    this.muzzle(x, y, z, dx, dy, dz);
    this.flash(x, y, z, [1, 0.8, 0.95], 1.6, 0.2, 14);
    this.add({ mat: pink, x: x + dx * 1.5, y: y + dy * 1.5, z: z + dz * 1.5, life: 0.16, s0: 1.2, s1: 2.6, curve: 'pop' });
    for (let r = 0; r < 3; r++) this.later(r * 0.04, () => this.add({ shape: 'torus', mat: pink, x: x + dx * (2 + r * 2.2), y: y + dy * (2 + r * 2.2), z: z + dz * (2 + r * 2.2), life: 0.22, s0: 0.8, s1: 2.6 - r * 0.5, sy: 0.1, rx: 90 - Math.asin(dy) * 57.3, ry: Math.atan2(dx, dz) * 57.3, curve: 'pop' }));
    this.add({ mat: m.smokeLight, x: x + dx * 2, y, z: z + dz * 2, vx: dx * 4, vy: 1, vz: dz * 4, drag: 2, life: 0.9, s0: 0, s1: 2, curve: 'puff' });
    this.addShake(0.35);
  }
  megaTrail(x, y, z) {
    this.add({ mat: this.col([1, 0.45, 1], true, 0.5), x, y, z, life: 0.22, s0: 0.9, s1: 0 });
    if (Math.random() < this.scale) this.add({ mat: this.m.core, x, y, z, life: 0.12, s0: 0.7, s1: 0 });
  }
  megaBlast(x, y, z, gy) {
    const m = this.m, pink = this.col([1, 0.45, 1], true, 0.75);
    this.flash(x, y, z, [1, 0.55, 0.9], 8, 0.5, 34);
    this.explosion(x, y, z, 3.6);
    this.add({ mat: m.whiteGlow, x, y, z, life: 0.12, s0: 3, s1: 7, curve: 'pop' });
    this.add({ mat: pink, x, y, z, life: 0.35, s0: 2, s1: 10, curve: 'pop' });
    this.add({ shape: 'torus', mat: pink, x, y: gy + 0.4, z, life: 0.45, s0: 1, s1: 12, sy: 0.06, curve: 'pop' });
    this.add({ shape: 'plane', mat: m.scorch, x, y: gy + 0.05, z, life: 5, s0: 6, s1: 6, curve: 'hold', ry: rnd(0, 360) });
    this.addShake(0.7, x, y, z);
  }
  // air strike: a target circle on the ground for the whole strike (red = danger for you)
  strikeMarker(x, gy, z, radius, life, enemy) {
    const c = enemy ? [1, 0.25, 0.15] : [1, 0.75, 0.2], ring = this.col(c, true, 0.85), soft = this.col(c, true, 0.25);
    this.add({ shape: 'torus', mat: ring, x, y: gy + 0.25, z, life, s0: radius * 2.1, s1: radius * 2.1, sy: 0.03, curve: 'hold' });
    this.add({ shape: 'cylinder', mat: soft, x, y: gy + 0.1, z, life, s0: radius * 2, s1: radius * 2, sy: 0.004, curve: 'hold' });
    this.add({ shape: 'cylinder', mat: soft, x, y: gy + 20, z, life, s0: 0.5, s1: 0.5, sy: 20, curve: 'hold' });
    // shrinking pulse rings = "it is coming"
    for (let t = 0; t < life - 0.3; t += 0.45) this.later(t, () => this.add({ shape: 'torus', mat: ring, x, y: gy + 0.3, z, life: 0.45, s0: radius * 2.4, s1: radius * 0.4, sy: 0.03 }));
  }
  bombFall(x, gy, z, dur) {
    const sp = 70, y0 = gy + sp * dur;
    this.add({ shape: 'box', mat: this.m.core, x, y: y0, z, vy: -sp, life: dur, s0: 0.4, s1: 0.4, sz: 3, align: true });
    this.add({ mat: this.m.orange, x, y: y0, z, vy: -sp, life: dur, s0: 0.8, s1: 0.8, emit: (p) => this.add({ mat: this.m.smokeLight, x: p.x, y: p.y, z: p.z, life: 0.5, s0: 0.8, s1: 0, drag: 1 }), emitEvery: 0.03 });
  }
  bombBlast(x, gy, z) {
    this.explosion(x, gy + 0.8, z, 2.6);
    this.flash(x, gy, z, [1, 0.6, 0.25], 4, 0.3, 24);
    this.add({ shape: 'torus', mat: this.m.ring, x, y: gy + 0.3, z, life: 0.4, s0: 1, s1: 7, sy: 0.05, curve: 'pop' });
    this.add({ shape: 'plane', mat: this.m.scorch, x, y: gy + 0.05, z, life: 4, s0: 4.5, s1: 4.5, curve: 'hold', ry: rnd(0, 360) });
  }
  mineBlast(x, gy, z) {
    this.explosion(x, gy + 0.6, z, 2.8);
    this.flash(x, gy, z, [1, 0.5, 0.2], 5, 0.35, 24);
    this.add({ shape: 'cylinder', mat: this.m.flashGlow, x, y: gy + 3, z, life: 0.3, s0: 2.2, s1: 0, sy: 3 });
    this.add({ shape: 'plane', mat: this.m.scorch, x, y: gy + 0.05, z, life: 5, s0: 5, s1: 5, curve: 'hold', ry: rnd(0, 360) });
  }
  slamWave(x, gy, z, radius) {
    const m = this.m;
    this.flash(x, gy, z, [1, 0.75, 0.45], 7, 0.45, 30);
    this.add({ shape: 'torus', mat: m.dustRing, x, y: gy + 0.2, z, life: 0.6, s0: 2, s1: radius * 2.4, sy: 0.25, curve: 'pop' });
    this.add({ shape: 'torus', mat: m.ring, x, y: gy + 0.4, z, life: 0.4, s0: 2, s1: radius * 2.1, sy: 0.06, curve: 'pop' });
    this.later(0.08, () => this.add({ shape: 'torus', mat: m.cyan, x, y: gy + 0.3, z, life: 0.45, s0: 1, s1: radius * 1.8, sy: 0.05, curve: 'pop' }));
    this.add({ mat: m.whiteGlow, x, y: gy + 0.8, z, life: 0.12, s0: 3, s1: 6, curve: 'pop' });
    for (let i = 0; i < this.n(16); i++) {
      const a = rnd(0, 6.283), r = rnd(1, radius * 0.8);
      this.add({ mat: m.dust, x: x + Math.cos(a) * r, y: gy + 0.3, z: z + Math.sin(a) * r, vx: Math.cos(a) * 8, vy: rnd(1, 4), vz: Math.sin(a) * 8, drag: 2.5, life: rnd(0.6, 1.0), s0: 0, s1: rnd(1.6, 2.6), curve: 'puff' });
    }
    for (let i = 0; i < this.n(14); i++) {
      const a = rnd(0, 6.283), sp = rnd(6, 14);
      this.add({ shape: 'box', mat: m.debris, x, y: gy + 0.3, z, vx: Math.cos(a) * sp, vy: rnd(7, 14), vz: Math.sin(a) * sp, g: 26, life: rnd(0.8, 1.3), s0: rnd(0.25, 0.5), s1: 0.15, spin: 8, floor: gy + 0.1 });
    }
    this.add({ shape: 'plane', mat: m.scorch, x, y: gy + 0.05, z, life: 5, s0: radius * 1.3, s1: radius * 1.3, curve: 'hold', ry: rnd(0, 360) });
    this.addShake(0.9, x, gy, z);
  }
  // overdrive aura: rising sparks around the hull (per frame)
  overdriveAura(x, y, z) {
    if (Math.random() > 0.6 * this.scale + 0.15) return;
    const a = rnd(0, 6.283), r = rnd(1.2, 2.2);
    this.add({ shape: 'box', mat: Math.random() < 0.5 ? this.m.yellow : this.m.orange, x: x + Math.cos(a) * r, y: y + rnd(0, 1.2), z: z + Math.sin(a) * r, vy: rnd(3, 6), life: rnd(0.3, 0.5), s0: 0.18, s1: 0.02, align: true });
  }
  overdriveStart(x, y, z, own) {
    this.flash(x, y, z, [1, 0.8, 0.3], own ? 2 : 4, 0.4, 20);
    if (!own) this.add({ shape: 'cylinder', mat: this.m.flashGlow, x, y: y + 5, z, life: 0.45, s0: 3, s1: 0, sy: 6 });
    for (let i = 0; i < this.n(14); i++) {
      const a = rnd(0, 6.283), sp = rnd(5, 10);
      this.add({ shape: 'box', mat: i % 2 ? this.m.yellow : this.m.orange, x, y: y + 0.6, z, vx: Math.cos(a) * sp, vy: rnd(3, 8), vz: Math.sin(a) * sp, g: 12, life: rnd(0.35, 0.6), s0: 0.2, s1: 0.03, align: true });
    }
    this.add({ shape: 'torus', mat: this.m.ring, x, y: y + 0.4, z, life: 0.4, s0: 8, s1: 1.5, sy: 0.08 });
  }

  respawnBeam(x, y, z, colorMat) {
    this.add({ shape: 'cylinder', mat: colorMat || this.m.cyan, x, y: y + 12, z, life: 0.9, s0: 3.2, s1: 0, sy: 8 });
    this.add({ shape: 'cylinder', mat: this.m.core, x, y: y + 12, z, life: 0.4, s0: 0.5, s1: 0, sy: 48 });
    this.add({ shape: 'torus', mat: colorMat || this.m.cyan, x, y: y + 0.2, z, life: 0.6, s0: 6, s1: 1, sy: 0.1 });
  }
}
