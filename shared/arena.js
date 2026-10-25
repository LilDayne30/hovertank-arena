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
// box:  { kind, cx, cz, hx, hz, h }            axis-aligned block, top at height h
// ramp: { kind, ax, az, dx, dz, len, hw, h0, h1 } slope starting at (ax,az) going along (dx,dz)
//        for len metres, half-width hw, height h0 at the start and h1 at the end
const box = (kind, x0, z0, x1, z1, h) => ({ type: 'box', kind, cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, hx: Math.abs(x1 - x0) / 2, hz: Math.abs(z1 - z0) / 2, h });
const ramp = (kind, ax, az, dx, dz, len, hw, h0, h1) => ({ type: 'ramp', kind, ax, az, dx, dz, len, hw, h0, h1 });

// one quadrant (+x,+z); repeated 4x with 90 degree rotations so every spawn is equivalent
const QUADRANT = [
  box('stone', 11, 13, 17, 14.5, 3.2),     // L-shaped wall (full cover)
  box('stone', 11, 14.5, 12.5, 19, 3.2),
  box('crate', 19.5, 5.5, 21.5, 7.5, 1.8),  // crate (half cover, can be jumped onto from a run)
  box('low', 5.5, 20, 10.5, 21.2, 1.3),     // low wall: blocks low shots, jump over it
  box('pillar', -1.25, 17.75, 1.25, 20.25, 4.5),   // tall pillar in front of the edge spawn
  ramp('stone', 5, 0, 1, 0, 6, 2, 2.2, 0),          // ramp from the centre mesa down to the floor
];
const CENTRE = [
  box('stone', -5, -5, 5, 5, 2.2),          // central mesa (high ground, reached by the ramps)
];

function rot(o, k) {
  // rotate by k * 90 degrees around the origin: (x, z) -> (z, -x)
  let r = { ...o };
  for (let i = 0; i < k; i++) {
    if (r.type === 'box') r = { ...r, cx: r.cz, cz: -r.cx, hx: r.hz, hz: r.hx };
    else r = { ...r, ax: r.az, az: -r.ax, dx: r.dz, dz: -r.dx };
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
      : (() => { const ex = o.ax + o.dx * o.len, ez = o.az + o.dz * o.len, px = Math.abs(o.dz) * o.hw, pz = Math.abs(o.dx) * o.hw;
        return { a: Math.min(o.ax, ex) - px, b: Math.max(o.ax, ex) + px, c: Math.min(o.az, ez) - pz, d: Math.max(o.az, ez) + pz }; })();
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
          const px = x - o.ax, pz = z - o.az;
          const u = px * o.dx + pz * o.dz, v = Math.abs(-px * o.dz + pz * o.dx);
          if (u >= 0 && u <= o.len && v <= o.hw) h = o.h0 + (o.h1 - o.h0) * (u / o.len);
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
