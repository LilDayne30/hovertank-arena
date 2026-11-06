// Stages. "desert" is the original pit (a heightfield baked from arena.glb, see shared/arena.js);
// the others are built from data here, the same way on the server and on the client, so what you
// see is exactly what you collide with:
//   shapes  boxes (flat tops), ramps (one sloped side), trenches (below the floor)
//   zones   jump pads (launch when you drive onto them) and conveyors (push while grounded)
//   gates   wall sections that open and close (timer or a switch that is shot)
// Heights: up to 0.9 m drives over, up to ~3 m needs a jump, 3.5–5 m only the ground slam, 5.5 m+ is a wall.
import { SPAWNS as DESERT_SPAWNS, OBSTACLES as DESERT_OBSTACLES, PIT_HALF as DESERT_HALF, HEAL_POS as DESERT_HEAL, applyObstacles } from './arena.js';

// what each stage is called and how it looks (the client reads the look; the server ignores it)
export const STAGE_LIST = [
  { id: 'desert', name: '砂漠のすり鉢', en: 'Desert Pit' },
  { id: 'quarry', name: '採掘衛星テラス', en: 'Quarry Moon Terraces' },
  { id: 'foundry', name: '鋳造工場ゲートワークス', en: 'Foundry Gateworks' },
];
export const STAGE_IDS = STAGE_LIST.map((s) => s.id);
export const stageName = (id) => STAGE_LIST.find((s) => s.id === id)?.name || id;

const CELL = 0.5;
// rotations by 90° around the origin: (x, z) -> (z, -x), applied k times
const rotP = (x, z, k) => { for (let i = 0; i < k; i++) [x, z] = [z, -x]; return [x, z]; };
function rotRect(r, k) {   // r = { x0, z0, x1, z1 }
  const [ax, az] = rotP(r.x0, r.z0, k), [bx, bz] = rotP(r.x1, r.z1, k);
  return { x0: Math.min(ax, bx), z0: Math.min(az, bz), x1: Math.max(ax, bx), z1: Math.max(az, bz) };
}
const ROT = ['-z', '-x', '+z', '+x'];   // (x,z)->(z,-x) turns -z into -x, -x into +z, ...
const rotDir = (d, k) => ROT[(ROT.indexOf(d) + k) % 4];
const mirX = (r) => ({ ...r, x0: -r.x1, x1: -r.x0 });
const mirZ = (r) => ({ ...r, z0: -r.z1, z1: -r.z0 });
const flipDir = (d, axis) => (d[1] === axis ? (d[0] === '-' ? '+' : '-') + axis : d);

// shape helpers.   kind = material on the client: floor, cliff, plate, metal, stripe, crate, rock...
const box = (kind, x0, z0, x1, z1, h) => ({ type: 'box', kind, x0: Math.min(x0, x1), z0: Math.min(z0, z1), x1: Math.max(x0, x1), z1: Math.max(z0, z1), h });
// ramp: rises from h0 to h1 towards `up` ('-z' | '+z' | '-x' | '+x')
const ramp = (kind, x0, z0, x1, z1, h0, h1, up) => ({ ...box(kind, x0, z0, x1, z1, h1), type: 'ramp', h0, up });
// prop: the client draws a model (client/stage-data.js) in place of this box; base = ground height under it
const prop = (sh, name, base = 0) => ({ ...sh, prop: name, base });
// trench: lowers the floor to -depth (cut, not raised)
const trench = (x0, z0, x1, z1, depth) => ({ ...box('trench', x0, z0, x1, z1, -depth), type: 'cut' });

function rotShape(s, k) {
  const r = rotRect(s, k);
  return { ...s, ...r, ...(s.up ? { up: rotDir(s.up, k) } : {}) };
}
const around = (shapes) => [0, 1, 2, 3].flatMap((k) => shapes.map((s) => rotShape(s, k)));
const mirror4 = (shapes) => shapes.flatMap((s) => {
  const a = s, b = { ...mirX(s), ...(s.up ? { up: flipDir(s.up, 'x') } : {}) };
  return [a, b, { ...mirZ(a), ...(a.up ? { up: flipDir(a.up, 'z') } : {}) }, { ...mirZ(b), ...(b.up ? { up: flipDir(b.up, 'z') } : {}) }];
});
const spawnAt = (x, z) => ({ x, z, yaw: Math.atan2(x, z) });   // facing the centre

// ---------------------------------------------------------------- B: Quarry Moon Terraces
// 96 m square, 90° rotational symmetry. Floor 0, outer terraces 4 m, centre plateau 8 m (heal),
// trenches 2 m deep round the centre, jump pads onto the terraces and from the trenches to the plateau.
const QUARRY_Q = [
  box('plate', -16, -42, 12, -34, 4),            // outer terrace (north)
  ramp('ramp', 12, -42, 22, -34, 0, 4, '-x'),    //   its one ramp, at the east end
  prop(box('crate', -10, -40, -6, -37, 6.2), 'hangar_roundA', 4),   //   cover on top of the terrace
  ramp('ramp', -2.5, -26, 2.5, -8, 0, 8, '+z'),  // ramp up to the centre plateau (5 m wide, 18 m long)
  trench(4, -13, 13, -10, 2), trench(10, -13, 13, -4, 2),   // trench: an L round the plateau corner
  prop(box('rock', -24, -14, -20, -10, 2.2), 'rock_largeA'),   // rocks on the floor
  prop(box('rock', 26, -22, 29, -18, 2.4), 'rock_largeB'),
  prop(box('rock', -33, -26, -30, -23, 2), 'rock_largeA'),
  prop(box('rock', 42, -47, 47, -42, 2.6), 'rock_crystalsLargeA'),   // crystals in the corner
];
const QUARRY = {
  id: 'quarry', half: 48, wallH: 12,
  shapes: [box('plate', -8, -8, 8, 8, 8), ...around(QUARRY_Q)],
  spawns: [spawnAt(-38, -38), spawnAt(38, 38), spawnAt(38, -38), spawnAt(-38, 38), spawnAt(-24, -24), spawnAt(24, 24), spawnAt(24, -24), spawnAt(-24, 24)],
  heal: { x: 0, y: 8, z: 0 },
  zones: [],   // jump pads, filled in below (rotated with their landing points)
  look: { sky: [0.12, 0.14, 0.22], sun: [0.86, 0.9, 1], ambient: [0.36, 0.38, 0.46], fog: null },
};
// jump pads: from (x,z) to a landing point (tx,tz) with an upward speed vy, repeated round the centre
QUARRY.zones = [0, 1, 2, 3].flatMap((k) => [
  { type: 'pad', x: -20, z: -28, r: 1.8, tx: -12, tz: -36.5, vy: 18 },   // floor -> outer terrace
  { type: 'pad', x: 11.5, z: -11.5, r: 1.4, tx: 5.8, tz: -5.8, vy: 26 },  // trench -> plateau corner
].map((p) => { const [x, z] = rotP(p.x, p.z, k), [tx, tz] = rotP(p.tx, p.tz, k); return { ...p, x, z, tx, tz }; }));

// ---------------------------------------------------------------- A: Foundry Gateworks
// 88 x 64 m, mirror symmetric both ways. The vault in the middle (5.5 m walls) holds the heal; its
// four shutters open for 15 s every 40 s (first at 35 s), a shot switch opens the north or south one
// for 6 s. Conveyor lanes along the north and south walls carry you towards the middle.
const FQ = [   // one quarter (x >= 0, z <= 0), mirrored to the other three
  box('metal', 0, -6.5, 9, -5, 5.5),        // vault wall (north side, east half)
  box('metal', 7.5, -6.5, 9, 0, 5.5),       // vault wall (east side, north half)
  box('stripe', 13, -16, 21, -12, 4.5),     // watchtower
  ramp('ramp', 15, -25.5, 19, -16, 0, 4.5, '+z'),   // its ramp, from the conveyor lane gap
  box('fence', 0, -25.5, 14, -24.7, 1.2),   // fence between the lane and the floor (gap at x 14..24)
  box('fence', 24, -25.5, 34, -24.7, 1.2),
  box('metal', 12, -3, 16, 0, 4),           // press housing (a robot arm on top, see the client)
  prop(box('crate', 36, -12, 38.5, -8, 2.5), 'box-large'),   // machine crate
  prop(box('crate', 6, -17, 8, -15, 1.2), 'box-large'),       // crates
  prop(box('crate', 40, -22, 42, -20, 1.2), 'box-large'),
  prop(box('metal', 35.5, -17, 36.5, -16, 1.5), 'scanner-high'),   // switch post (the target sits on top)
];
const FOUNDRY = {
  id: 'foundry', halfX: 44, halfZ: 32, wallH: 10,
  shapes: mirror4(FQ),
  spawns: [spawnAt(-40, -28.5), spawnAt(40, 28.5), spawnAt(40, -28.5), spawnAt(-40, 28.5), spawnAt(-30, 0), spawnAt(30, 0), spawnAt(-24, -18), spawnAt(24, 18)],
  heal: { x: 0, y: 0, z: 0 },
  healFirst: 35,   // the heal appears when the shutters open
  zones: [
    { type: 'belt', x0: -43.5, z0: -31.5, x1: 0, z1: -26, vx: 6, vz: 0 },
    { type: 'belt', x0: 0, z0: -31.5, x1: 43.5, z1: -26, vx: -6, vz: 0 },
    { type: 'belt', x0: -43.5, z0: 26, x1: 0, z1: 31.5, vx: 6, vz: 0 },
    { type: 'belt', x0: 0, z0: 26, x1: 43.5, z1: 31.5, vx: -6, vz: 0 },
  ],
  // shutters: closed = h, open = 0.  side: which switch opens it ('n' / 's'; east/west only by timer)
  gates: [
    { id: 'n', x0: -3, z0: -6.5, x1: 3, z1: -5, h: 5.5, side: 'n' },
    { id: 's', x0: -3, z0: 5, x1: 3, z1: 6.5, h: 5.5, side: 's' },
    { id: 'w', x0: -9, z0: -2.5, x1: -7.5, z1: 2.5, h: 5.5 },
    { id: 'e', x0: 7.5, z0: -2.5, x1: 9, z1: 2.5, h: 5.5 },
  ],
  gateTimer: { first: 35, every: 40, open: 15 },
  switches: [
    { x: 36, z: -16.5, y: 2.1, r: 0.9, side: 'n' }, { x: -36, z: -16.5, y: 2.1, r: 0.9, side: 'n' },
    { x: 36, z: 16.5, y: 2.1, r: 0.9, side: 's' }, { x: -36, z: 16.5, y: 2.1, r: 0.9, side: 's' },
  ],
  switchOpen: 6, switchCooldown: 20,
  look: { sky: [0.07, 0.08, 0.11], sun: [0.95, 0.9, 0.82], ambient: [0.3, 0.32, 0.38], fog: null },
};

export const STAGES = { quarry: QUARRY, foundry: FOUNDRY };

// ---------------------------------------------------------------- building a world
// Data stages: heightfield (Float32Array) + a kind index per cell (for the client's meshes).
export const KINDS = ['floor', 'wall', 'plate', 'ramp', 'rock', 'crate', 'trench', 'metal', 'stripe', 'fence', 'gate'];
export function buildStageWorld(id, base) {
  if (id === 'desert' || !STAGES[id]) {
    // base: { meta, heights } from arena_hf (server import / client fetch)
    const w = { ...base.meta, h: new Float32Array(new Float32Array(base.heights)), stage: 'desert' };   // own copy
    w.spawns = DESERT_SPAWNS;
    w.teamSpawns = [DESERT_SPAWNS.filter((s) => s.x < -1), DESERT_SPAWNS.filter((s) => s.x > 1)];
    w.heal = DESERT_HEAL; w.halfX = w.halfZ = DESERT_HALF;
    w.cover = applyObstacles(w, DESERT_OBSTACLES);
    w.zones = []; w.gates = []; w.switches = [];
    return finish(w);
  }
  const S = STAGES[id];
  const halfX = S.halfX ?? S.half, halfZ = S.halfZ ?? S.half, m = 2;
  const minX = -halfX - m, minZ = -halfZ - m;
  const nx = Math.round((2 * (halfX + m)) / CELL) + 1, nz = Math.round((2 * (halfZ + m)) / CELL) + 1;
  const h = new Float32Array(nx * nz), kind = new Uint8Array(nx * nz);
  const K = (k) => Math.max(0, KINDS.indexOf(k));
  for (let iz = 0; iz < nz; iz++) for (let ix = 0; ix < nx; ix++) {
    const x = minX + ix * CELL, z = minZ + iz * CELL, i = iz * nx + ix;
    if (Math.abs(x) > halfX || Math.abs(z) > halfZ) { h[i] = S.wallH; kind[i] = K('wall'); }
  }
  const cells = (s, fn) => {
    const ix0 = Math.max(0, Math.ceil((s.x0 - minX) / CELL - 1e-6)), ix1 = Math.min(nx - 1, Math.floor((s.x1 - minX) / CELL + 1e-6));
    const iz0 = Math.max(0, Math.ceil((s.z0 - minZ) / CELL - 1e-6)), iz1 = Math.min(nz - 1, Math.floor((s.z1 - minZ) / CELL + 1e-6));
    for (let iz = iz0; iz <= iz1; iz++) for (let ix = ix0; ix <= ix1; ix++) fn(iz * nx + ix, minX + ix * CELL, minZ + iz * CELL);
  };
  for (const s of S.shapes) {
    if (s.type === 'cut') cells(s, (i) => { if (h[i] === 0) { h[i] = s.h; kind[i] = K('trench'); } });
    else if (s.type === 'box') cells(s, (i) => { if (s.h > h[i]) { h[i] = s.h; kind[i] = K(s.kind); } });
    else if (s.type === 'ramp') cells(s, (i, x, z) => {
      const t = s.up === '-x' ? (s.x1 - x) / (s.x1 - s.x0) : s.up === '+x' ? (x - s.x0) / (s.x1 - s.x0) : s.up === '-z' ? (s.z1 - z) / (s.z1 - s.z0) : (z - s.z0) / (s.z1 - s.z0);
      const v = s.h0 + (s.h - s.h0) * Math.min(1, Math.max(0, t));
      if (v >= h[i]) { h[i] = v; kind[i] = K('ramp'); }
    });
  }
  const w = { minX, minZ, cell: CELL, nx, nz, h, kind, floor: -2, outside: S.wallH, stage: id, halfX, halfZ, wallH: S.wallH };
  w.spawns = S.spawns;
  w.teamSpawns = [S.spawns.filter((s) => s.x < -1), S.spawns.filter((s) => s.x > 1)];
  w.heal = S.heal; w.healFirst = S.healFirst;
  w.zones = S.zones || [];
  w.shapes = S.shapes;
  w.gates = (S.gates || []).map((g) => ({ ...g, open: false }));
  w.gateTimer = S.gateTimer; w.switches = S.switches || []; w.switchOpen = S.switchOpen; w.switchCooldown = S.switchCooldown;
  w.base = new Float32Array(h);   // heights with every gate open (gates are written on top)
  for (const g of w.gates) cells(g, (i) => { w.base[i] = 0; h[i] = 0; kind[i] = K('gate'); });
  w.gateCells = w.gates.map((g) => { const list = []; cells(g, (i) => list.push(i)); return list; });
  for (let i = 0; i < w.gates.length; i++) setGate(w, i, false);
  return finish(w);
}
function finish(w) { w.version = 1; return w; }
// a world made the old way (makeWorld + arena.js): fill in the stage fields with the desert's
export function ensureStage(w) {
  if (w.gates) return w;
  w.stage ??= 'desert'; w.spawns ??= DESERT_SPAWNS;
  w.teamSpawns ??= [w.spawns.filter((s) => s.x < -1), w.spawns.filter((s) => s.x > 1)];
  w.heal ??= DESERT_HEAL; w.halfX ??= DESERT_HALF; w.halfZ ??= DESERT_HALF;
  w.zones ??= []; w.gates = []; w.switches ??= []; w.version ??= 1;
  return w;
}

// open (h = 0) or close (h = gate height) one gate; returns true when it changed
export function setGate(w, i, open) {
  const g = w.gates[i];
  if (!g || (g.open === open && w.version > 1)) return false;
  g.open = open;
  for (const c of w.gateCells[i]) w.h[c] = open ? w.base[c] : g.h;
  w.version++;
  return true;
}
// timer part of the shutters: open during [first + k*every, first + k*every + open)
export function gateTimerOpen(w, t) {
  const T = w.gateTimer;
  if (!T || t < T.first) return false;
  return ((t - T.first) % T.every) < T.open;
}
export const gateMask = (w) => w.gates.reduce((m, g, i) => m | (g.open ? 1 << i : 0), 0);
export function applyGateMask(w, mask) {
  let changed = false;
  for (let i = 0; i < w.gates.length; i++) changed = setGate(w, i, !!(mask & (1 << i))) || changed;
  return changed;
}

// ---------------------------------------------------------------- zones (used inside stepTank)
// jump pad: straight up first; once the hull is above everything between the pad and the landing
// point (clearY), the horizontal speed is applied so it lands on (tx, tz).  hAt(x, z) = ground height.
export function padLaunch(p, hAt, g = 30) {
  const fromY = hAt(p.x, p.z), toY = hAt(p.tx, p.tz);
  let top = Math.max(fromY, toY);
  for (let k = 1; k < 20; k++) top = Math.max(top, hAt(p.x + ((p.tx - p.x) * k) / 20, p.z + ((p.tz - p.z) * k) / 20));
  const clearY = Math.min(top + 0.3, fromY + (p.vy * p.vy) / (2 * g) - 0.2);   // never above the apex
  const tAt = (y, falling) => { const a = 0.5 * g, b = -p.vy, c = y - fromY, d = Math.max(0, b * b - 4 * a * c); return falling ? (-b + Math.sqrt(d)) / (2 * a) : (-b - Math.sqrt(d)) / (2 * a); };
  const t1 = tAt(clearY, false), t2 = tAt(toY, true);
  const dt = Math.max(0.2, t2 - t1);
  return { vy: p.vy, vx: (p.tx - p.x) / dt, vz: (p.tz - p.z) / dt, clearY };
}

// ---------------------------------------------------------------- path graph for CPU tanks
// Nodes on a 2 m grid where a tank fits; an edge joins neighbours a tank can drive between
// (no step above 0.9 m on the way). Higher steps up to 2.8 m are "jump" edges, drops are one-way,
// jump pads add one-way edges to their landing point. Built lazily, rebuilt when gates change.
const NAV = 2;
export function navGraph(w) {
  if (w.nav && w.nav.version === w.version) return w.nav;
  const hx = w.halfX - 2, hz = w.halfZ - 2;
  const cols = Math.floor((2 * hx) / NAV) + 1, rows = Math.floor((2 * hz) / NAV) + 1;
  const H = (x, z) => { const ix = Math.round((x - w.minX) / w.cell), iz = Math.round((z - w.minZ) / w.cell); return ix < 0 || iz < 0 || ix >= w.nx || iz >= w.nz ? 99 : w.h[iz * w.nx + ix]; };
  const nodes = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const x = -hx + c * NAV, z = -hz + r * NAV, y = H(x, z);
    // a tank fits when the ground under its disc is about level with the centre
    let ok = y < 20;
    for (const [dx, dz] of [[1.2, 0], [-1.2, 0], [0, 1.2], [0, -1.2]]) if (Math.abs(H(x + dx, z + dz) - y) > 0.9) ok = false;
    nodes.push(ok ? { x, z, y, e: [] } : null);
  }
  const at = (c, r) => (c < 0 || r < 0 || c >= cols || r >= rows ? null : nodes[r * cols + c]);
  const link = (a, b) => {
    // walk from a to b in 0.5 m steps: the biggest climb and whether it ever rises too much
    let prev = a.y, maxUp = 0;
    const n = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 0.5);
    for (let k = 1; k <= n; k++) { const y = H(a.x + ((b.x - a.x) * k) / n, a.z + ((b.z - a.z) * k) / n); maxUp = Math.max(maxUp, y - prev); prev = y; }
    if (maxUp <= 0.9) return 1;          // drive (down any height)
    if (maxUp <= 2.8) return 2;          // jump up
    return 0;
  };
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const a = at(c, r);
    if (!a) continue;
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const b = at(c + dc, r + dr);
      if (!b) continue;
      const k = link(a, b);
      if (k) a.e.push({ to: (r + dr) * cols + c + dc, cost: Math.hypot(dc, dr) * NAV * (k === 2 ? 1.6 : 1), jump: k === 2 });
    }
  }
  const nearest = (x, z) => {
    let best = -1, bd = Infinity;
    const c0 = Math.round((x + hx) / NAV), r0 = Math.round((z + hz) / NAV);
    for (let r = r0 - 3; r <= r0 + 3; r++) for (let c = c0 - 3; c <= c0 + 3; c++) {
      const n = at(c, r);
      if (!n) continue;
      const d = Math.hypot(n.x - x, n.z - z) + Math.abs(n.y - H(x, z)) * 2;
      if (d < bd) { bd = d; best = r * cols + c; }
    }
    return best;
  };
  for (const zn of w.zones) if (zn.type === 'pad') {
    const a = nearest(zn.x, zn.z), b = nearest(zn.tx, zn.tz);
    if (a >= 0 && b >= 0) nodes[a].e.push({ to: b, cost: 6, pad: true });
  }
  w.nav = { version: w.version, nodes, nearest };
  return w.nav;
}

// A* from (x,z) to (gx,gz): list of {x,z,jump?,pad?} way points (empty when already there / no way)
export function findPath(w, x, z, gx, gz) {
  const g = navGraph(w), N = g.nodes;
  const s = g.nearest(x, z), t = g.nearest(gx, gz);
  if (s < 0 || t < 0 || s === t) return [];
  const open = new Map([[s, 0]]), came = new Map(), cost = new Map([[s, 0]]);
  const hEst = (i) => Math.hypot(N[i].x - N[t].x, N[i].z - N[t].z);
  let guard = 0;
  while (open.size && guard++ < 6000) {
    let cur = -1, best = Infinity;
    for (const [i, f] of open) if (f < best) { best = f; cur = i; }
    if (cur === t) break;
    open.delete(cur);
    for (const e of N[cur].e) {
      const c = cost.get(cur) + e.cost;
      if (c < (cost.get(e.to) ?? Infinity)) { cost.set(e.to, c); came.set(e.to, { from: cur, e }); open.set(e.to, c + hEst(e.to)); }
    }
  }
  if (!came.has(t)) return null;
  const out = [];
  for (let i = t; i !== s; i = came.get(i).from) { const { e } = came.get(i); out.push({ x: N[i].x, z: N[i].z, jump: e.jump, pad: e.pad }); }
  return out.reverse();
}
