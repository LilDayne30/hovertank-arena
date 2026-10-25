// Arena-specific tuning for H4kor "Low Poly Desert Arena" scaled x3.
// The walled pit spans roughly x,z in [-30, 30] m; the floor is flat at y = 0.
// Cover objects (added on top of the original asset) are defined here as data and applied to the
// collision heightfield on both server and client; the client builds matching meshes from them.

// ---------------------------------------------------------------- spawns
const S = [
  [-23, -23], [23, 23], [23, -23], [-23, 23],
  [0, -25], [0, 25], [-25, 0], [25, 0],
];
// yaw convention: forward = (-sin(yaw), -cos(yaw)); facing the centre from (x,z) => yaw = atan2(x, z)
export const SPAWNS = S.map(([x, z]) => ({ x, z, yaw: Math.atan2(x, z) }));

// ---------------------------------------------------------------- cover
// box:   { kind, cx, cz, hx, hz, h }          axis-aligned block, top at height h
// mound: { kind, cx, cz, rTop, rBase, h }     round hill: flat top of radius rTop at height h,
//                                             smooth slope down to the floor at rBase (climbable from any side)
const box = (kind, x0, z0, x1, z1, h) => ({ type: 'box', kind, cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, hx: Math.abs(x1 - x0) / 2, hz: Math.abs(z1 - z0) / 2, h });
const mound = (kind, cx, cz, rTop, rBase, h) => ({ type: 'mound', kind, cx, cz, rTop, rBase, h });

export function moundHeight(o, r) {
  if (r <= o.rTop) return o.h;
  if (r >= o.rBase) return 0;
  const t = (r - o.rTop) / (o.rBase - o.rTop);
  return o.h * (1 - t * t * (3 - 2 * t));     // smoothstep: max slope ~0.4, gentle enough to drive up anywhere
}

// one quadrant (+x,+z); repeated 4x with 90 degree rotations so every spawn is equivalent.
// Kept to the minimum: something to duck behind from each spawn, nothing to get stuck on.
const QUADRANT = [
  box('stone', 12, 14, 18, 15.5, 2.8),       // wall between the corner spawn and the centre
  box('stone', -2, 18, 2, 19.5, 2.6),        // short wall in front of the edge spawn
];
const CENTRE = [
  mound('sand', 0, 0, 3.5, 12, 2.4),          // central round hill (high ground)
];

function rot(o, k) {
  // rotate by k * 90 degrees around the origin: (x, z) -> (z, -x)
  let r = { ...o };
  for (let i = 0; i < k; i++) {
    if (r.type === 'box') r = { ...r, cx: r.cz, cz: -r.cx, hx: r.hz, hz: r.hx };
    else r = { ...r, cx: r.cz, cz: -r.cx };
  }
  return r;
}
export const OBSTACLES = [...CENTRE, ...[0, 1, 2, 3].flatMap((k) => QUADRANT.map((o) => rot(o, k)))];

// Raise the heightfield under every obstacle. Returns, per obstacle, the extents actually covered
// on the 0.5 m grid so the meshes line up exactly with the collision.
export function applyObstacles(w, list = OBSTACLES) {
  const out = [];
  for (const o of list) {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    // bounding box of the obstacle on the grid (only those cells are tested)
    const r = o.type === 'box' ? { a: o.cx - o.hx, b: o.cx + o.hx, c: o.cz - o.hz, d: o.cz + o.hz }
      : { a: o.cx - o.rBase, b: o.cx + o.rBase, c: o.cz - o.rBase, d: o.cz + o.rBase };
    const ixa = Math.max(0, Math.floor((r.a - w.minX) / w.cell)), ixb = Math.min(w.nx - 1, Math.ceil((r.b - w.minX) / w.cell));
    const iza = Math.max(0, Math.floor((r.c - w.minZ) / w.cell)), izb = Math.min(w.nz - 1, Math.ceil((r.d - w.minZ) / w.cell));
    for (let iz = iza; iz <= izb; iz++) {
      const z = w.minZ + iz * w.cell;
      for (let ix = ixa; ix <= ixb; ix++) {
        const x = w.minX + ix * w.cell;
        let h = null;
        if (o.type === 'box') {
          if (Math.abs(x - o.cx) <= o.hx && Math.abs(z - o.cz) <= o.hz) h = o.h;
        } else {
          const rr = Math.hypot(x - o.cx, z - o.cz);
          if (rr < o.rBase) h = moundHeight(o, rr);
        }
        if (h === null) continue;
        const i = iz * w.nx + ix;
        if (h > w.h[i]) w.h[i] = h;
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
      }
    }
    const half = w.cell / 2;
    out.push({ ...o, ex0: x0 - half, ex1: x1 + half, ez0: z0 - half, ez1: z1 + half });
  }
  return out;
}

// ---------------------------------------------------------------- players & match
export const PLAYER_COLORS = [
  [0.85, 0.22, 0.18], // red
  [0.20, 0.45, 0.90], // blue
  [0.95, 0.75, 0.15], // yellow
  [0.25, 0.75, 0.35], // green
];
export const PLAYER_COLOR_NAMES = ['赤', '青', '黄', '緑'];

export const MATCH_SECONDS = 300;
export const RESULT_SECONDS = 10;
export const RECONNECT_SECONDS = 20;
export const MAX_PLAYERS = 4;
