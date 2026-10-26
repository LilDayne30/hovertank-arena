// Cosmetics: builds a tank entity from a "look" (shared/progress.js), procedural pattern textures,
// the red/blue outline shell, and coloured materials for trails / sparks / glow.
// Everything is generated at runtime from the one tank.glb kit: no extra downloads.
import * as pc from 'playcanvas';
import { item, DEFAULT_LOOK } from '../shared/progress.js';
import { PLAYER_COLORS } from '../shared/arena.js';

const UV_SPAN = 8, TILE_M = 2.4;                 // see tools/build_parts.py
const TILING = UV_SPAN / TILE_M;
export const OUTLINE = { enemy: [1, 0.16, 0.12], ally: [0.2, 0.55, 1] };

const OUTLINE_VS = `
attribute vec3 aPosition;
attribute vec3 aNormal;
uniform mat4 matrix_model;
uniform mat4 matrix_viewProjection;
uniform mat3 matrix_normal;
uniform vec3 view_position;
uniform float uWidth;
void main(void) {
  vec4 wp = matrix_model * vec4(aPosition, 1.0);
  vec3 n = normalize(matrix_normal * aNormal);
  // constant on-screen thickness: grows with distance so far-away tanks stay readable
  float d = distance(wp.xyz, view_position);
  wp.xyz += n * clamp(d * uWidth, 0.05, 0.9);
  gl_Position = matrix_viewProjection * wp;
}`;
const OUTLINE_FS = `
uniform vec3 uColor;
void main(void) { gl_FragColor = vec4(uColor, 1.0); }`;

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const css = (c) => `rgb(${c.map((v) => Math.round(clamp01(v) * 255)).join(',')})`;

export class Looks {
  constructor(app, device, tankAsset) {
    this.app = app; this.device = device; this.asset = tankAsset;
    this.tex = new Map(); this.mats = new Map();
    this.outline = {};
    for (const [k, c] of Object.entries(OUTLINE)) {
      const m = new pc.ShaderMaterial({
        uniqueName: 'tankOutline', vertexGLSL: OUTLINE_VS, fragmentGLSL: OUTLINE_FS,
        attributes: { aPosition: pc.SEMANTIC_POSITION, aNormal: pc.SEMANTIC_NORMAL },
      });
      m.setParameter('uColor', c);
      m.setParameter('uWidth', 0.0065);
      m.cull = pc.CULLFACE_FRONT;
      m.update();
      this.outline[k] = m;
    }
  }

  paintColor(look, slot) {
    const c = item('paint', look.paint)?.color;
    return c || PLAYER_COLORS[slot % PLAYER_COLORS.length];
  }
  glowColor(look) { return item('glow', look.glow)?.color || [0.3, 0.8, 1]; }

  // ------------------------------------------------------------------ materials
  emissiveMat(key, rgb, { additive = false, opacity = 1 } = {}) {
    const k = `${key}:${rgb.join(',')}:${additive}:${opacity}`;
    let m = this.mats.get(k);
    if (!m) {
      m = new pc.StandardMaterial();
      m.diffuse = new pc.Color(0, 0, 0); m.emissive = new pc.Color(...rgb); m.useLighting = false;
      if (additive) { m.blendType = pc.BLEND_ADDITIVE; m.depthWrite = false; m.opacity = opacity; }
      m.update(); this.mats.set(k, m);
    }
    return m;
  }
  trailMats(look) {
    const c = item('trail', look.trail)?.color || [1, 0.82, 0.25];
    return { shell: this.emissiveMat('shell', c, { additive: true }), puff: this.emissiveMat('trail', c) };
  }
  sparkMat(look) {
    const it = item('spark', look.spark);
    if (it?.rainbow) return this.emissiveMat('spark', hsv(Math.random(), 0.75, 1));
    return this.emissiveMat('spark', it?.color || [1, 1, 0.92]);
  }
  hoverMat(look, base) {
    const c = this.glowColor(look);
    const k = `hover:${c}`;
    let m = this.mats.get(k);
    if (!m) { m = base.clone(); m.emissive = new pc.Color(...c); m.update(); this.mats.set(k, m); }
    return m;
  }

  patternTexture(paint, pattern) {
    const k = `${paint.join(',')}:${pattern}`;
    if (this.tex.has(k)) return this.tex.get(k);
    const N = 256, cv = document.createElement('canvas'); cv.width = cv.height = N;
    const g = cv.getContext('2d');
    drawPattern(g, N, pattern, paint);
    const t = new pc.Texture(this.device, { width: N, height: N, format: pc.PIXELFORMAT_RGBA8, mipmaps: true, addressU: pc.ADDRESS_REPEAT, addressV: pc.ADDRESS_REPEAT, anisotropy: 4 });
    t.setSource(cv);
    this.tex.set(k, t);
    return t;
  }

  // ------------------------------------------------------------------ tank
  /**
   * @returns {{ e, turret, paintMats, glowMats, outlines }} – e is not yet added to the scene
   */
  build(look, slot) {
    look = { ...DEFAULT_LOOK, ...(look || {}) };
    const e = this.asset.resource.instantiateRenderEntity();
    const keep = new Set([`T_${look.turret}`, `R_${look.rear}`, `S_${look.side}`]);
    for (const c of [...e.children]) {
      if (/^[TRS]_/.test(c.name) && !keep.has(c.name)) c.destroy();
    }
    const turret = e.findByName(`T_${look.turret}`) || e.findByName('T_std');
    const paint = this.paintColor(look, slot);
    const glow = this.glowColor(look);
    const tex = look.pattern !== 'none' ? this.patternTexture(paint, look.pattern) : null;
    const cache = new Map(), paintMats = [], glowMats = [], outlines = [];
    for (const r of e.findComponents('render')) {
      const isOutline = /_ol$/.test(r.entity.name);
      if (isOutline) { outlines.push(r); r.castShadows = false; continue; }
      for (const mi of r.meshInstances) {
        const m = mi.material;
        if (!cache.has(m)) {
          const c = m.clone();
          const name = m.name;
          if (name === 'Glow') {
            c.diffuse = new pc.Color(0, 0, 0); c.emissive = new pc.Color(...glow); c.useLighting = false;
            glowMats.push(c);
          } else if (name === 'Gold') {
            // fixed colour
          } else {
            const shade = { Main: 0.92, Main_Dark: 0.62, Main_Light: 1.18, Main_Details: 0.32, Wheels: 0.16 }[name] ?? 0.9;
            const patterned = tex && (name === 'Main' || name === 'Main_Dark');
            const base = patterned ? [1, 1, 1] : paint;
            c.diffuse = new pc.Color(...base.map((v) => Math.min(1, v * shade)));
            if (patterned) {
              c.diffuseMap = tex;
              c.diffuseMapTiling = new pc.Vec2(TILING, TILING);
              c.diffuseMapOffset = new pc.Vec2(0.5 - ((0.5 * TILING) % 1), -((0.5 * TILING) % 1));
            }
            paintMats.push(c);
          }
          c.update();
          cache.set(m, c);
        }
        mi.material = cache.get(m);
      }
    }
    return { e, turret, paintMats, glowMats, outlines };
  }

  // 'enemy' (red) | 'ally' (blue) | 'none' (own tank)
  setRelation(v, rel) {
    if (v.rel === rel) return;
    v.rel = rel;
    for (const r of v.outlines) {
      r.enabled = rel !== 'none';
      if (rel !== 'none') for (const mi of r.meshInstances) mi.material = this.outline[rel];
    }
  }
}

export function hsv(h, s, v) {
  const i = Math.floor(h * 6), f = h * 6 - i, p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  return [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6];
}

// ------------------------------------------------------------------ pattern drawing (tileable)
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function wrapDraw(g, N, fn) { for (const dx of [-N, 0, N]) for (const dy of [-N, 0, N]) { g.save(); g.translate(dx, dy); fn(); g.restore(); } }

export function drawPattern(g, N, id, paint) {
  g.fillStyle = css(paint); g.fillRect(0, 0, N, N);
  const dark = mix(paint, [0.05, 0.05, 0.05], 0.55), light = mix(paint, [1, 1, 1], 0.45);
  const r = rng(id.length * 7919 + 17);
  // stripes / checks: white on dark paint, near-black on light paint
  const lum = 0.3 * paint[0] + 0.59 * paint[1] + 0.11 * paint[2];
  const contrast = lum > 0.62 ? '#24211d' : '#f4f1ea';
  if (id === 'stripe') {
    // two racing stripes through the middle of the tile (= the tank's centre line)
    g.fillStyle = contrast;
    for (const x of [0.43, 0.53]) g.fillRect(x * N, 0, 0.045 * N, N);
    g.fillStyle = css(dark);
    for (const x of [0.425, 0.575]) g.fillRect(x * N, 0, 0.008 * N, N);
  } else if (id === 'desert') {
    const cols = [mix(paint, [0.82, 0.7, 0.48], 0.6), mix(paint, [0.45, 0.33, 0.2], 0.6), mix(paint, [0.95, 0.88, 0.7], 0.5)];
    for (let i = 0; i < 26; i++) {
      const x = r() * N, y = r() * N, rx = 14 + r() * 30, ry = 10 + r() * 22, rot = r() * Math.PI;
      g.fillStyle = css(cols[i % 3]);
      wrapDraw(g, N, () => { g.beginPath(); g.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2); g.fill(); });
    }
  } else if (id === 'tiger') {
    g.fillStyle = css(mix(dark, [0, 0, 0], 0.5));
    for (let i = 0; i < 9; i++) {
      const y = (i / 9) * N + r() * 10, len = 0.35 + r() * 0.45, x0 = r() * N;
      wrapDraw(g, N, () => {
        g.beginPath();
        g.moveTo(x0, y);
        g.quadraticCurveTo(x0 + N * len * 0.5, y - 18 - r() * 10, x0 + N * len, y + 4);
        g.quadraticCurveTo(x0 + N * len * 0.5, y + 6, x0, y + 9);
        g.fill();
      });
    }
  } else if (id === 'digital') {
    const cols = [dark, light, mix(paint, [0.3, 0.35, 0.3], 0.5)], s = N / 16;
    for (let i = 0; i < 90; i++) {
      const x = Math.floor(r() * 16) * s, y = Math.floor(r() * 16) * s, w = (1 + Math.floor(r() * 3)) * s, h = (1 + Math.floor(r() * 2)) * s;
      g.fillStyle = css(cols[i % 3]);
      wrapDraw(g, N, () => g.fillRect(x, y, w, h));
    }
  } else if (id === 'flame') {
    // flames licking up from the bottom of the tile (bottom = ground level on the hull sides)
    const layers = [[[1, 0.25, 0.05], 0.62], [[1, 0.6, 0.1], 0.48], [[1, 0.9, 0.35], 0.3]];
    for (const [c, hgt] of layers) {
      g.fillStyle = css(c);
      g.beginPath(); g.moveTo(0, N);
      for (let i = 0; i <= 8; i++) {
        const x = (i / 8) * N, tip = N * (1 - hgt * (0.7 + 0.3 * Math.sin(i * 2.3)));
        g.quadraticCurveTo(x - N / 16, N - (N - tip) * 0.4, x, tip);
        g.quadraticCurveTo(x + N / 32, N - (N - tip) * 0.5, x + N / 16, N - (N - tip) * 0.2);
      }
      g.lineTo(N, N); g.closePath(); g.fill();
    }
  } else if (id === 'carbon') {
    const s = N / 32;
    g.fillStyle = css(mix(paint, [0.08, 0.08, 0.09], 0.8)); g.fillRect(0, 0, N, N);
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
      g.fillStyle = css(mix(paint, (x + y) % 2 ? [0.2, 0.2, 0.22] : [0.12, 0.12, 0.13], 0.75));
      g.fillRect(x * s, y * s, s, s / 2);
    }
  } else if (id === 'checker') {
    const s = N / 4;
    g.fillStyle = contrast;
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) if ((x + y) % 2) g.fillRect(x * s, y * s, s, s);
  } else if (id === 'hazard') {
    g.fillStyle = css(mix([0.95, 0.75, 0.1], paint, 0.25)); g.fillRect(0, 0, N, N);
    g.fillStyle = '#1b1b1b';
    for (let i = -4; i < 8; i++) {
      g.beginPath();
      g.moveTo(i * N / 4, 0); g.lineTo(i * N / 4 + N / 8, 0); g.lineTo(i * N / 4 + N / 8 + N, N); g.lineTo(i * N / 4 + N, N);
      g.closePath(); g.fill();
    }
  }
}

// ------------------------------------------------------------------ HUD bits (emblems, frames)
const EMBLEM_PATHS = {
  star: 'M12 2l2.9 6.6 7.1.6-5.4 4.7 1.6 7L12 17.3 5.8 21l1.6-7L2 9.2l7.1-.6z',
  bolt: 'M13 2L4 14h6l-1 8 9-12h-6z',
  skull: 'M12 2C7 2 4 5.6 4 10c0 2.6 1.2 4.4 3 5.5V19h2v-2h2v2h2v-2h2v2h2v-3.5c1.8-1.1 3-2.9 3-5.5 0-4.4-3-8-8-8zm-3.5 11a2 2 0 110-4 2 2 0 010 4zm7 0a2 2 0 110-4 2 2 0 010 4z',
  wing: 'M2 8c4 0 7 1 10 4 3-3 6-4 10-4-1 3-3 5-6 6l-4 4-4-4C5 13 3 11 2 8z',
  crown: 'M3 18h18l-1.5-9-4.5 4-3-7-3 7-4.5-4z',
  heart: 'M12 21s-8-5.2-8-11a4.5 4.5 0 018-2.8A4.5 4.5 0 0120 10c0 5.8-8 11-8 11z',
  sight: 'M12 2v4M12 18v4M2 12h4M18 12h4M12 7a5 5 0 100 10 5 5 0 000-10z',
  clover: 'M12 11a3.5 3.5 0 11-1-6.8A3.5 3.5 0 1112 11zm0 0a3.5 3.5 0 111 6.8A3.5 3.5 0 1112 11zm0 0l-1 11',
};
const EMBLEM_COLORS = { star: '#ffd34d', bolt: '#7fd7ff', skull: '#f2efe6', wing: '#ffffff', crown: '#ffc83a', heart: '#ff6b8a', sight: '#ff8a5c', clover: '#6fe08a' };
export function emblemSvg(id, size = 14) {
  const d = EMBLEM_PATHS[id];
  if (!d) return '';
  const stroke = id === 'sight' || id === 'clover';
  return `<svg class="emb" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true"><path d="${d}" ${stroke ? `fill="none" stroke="${EMBLEM_COLORS[id]}" stroke-width="2.4" stroke-linecap="round"` : `fill="${EMBLEM_COLORS[id]}"`}/></svg>`;
}
