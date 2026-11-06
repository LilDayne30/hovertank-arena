// Meshes for the stages built from data (shared/stages.js): the terrain is drawn straight from the
// same heightfield the physics uses (flat areas merged into big quads, cliffs as vertical faces,
// ramps as sloped quads), so what you see is exactly what you collide with. One mesh with vertex
// colours = one draw call. Shutters, jump pads, conveyor belts and switches are separate entities.
import * as pc from 'playcanvas';

const PAL = {
  quarry: {
    floor: [0.42, 0.45, 0.52], wall: [0.24, 0.26, 0.32], plate: [0.62, 0.64, 0.70], ramp: [0.78, 0.55, 0.30], rock: [0.36, 0.38, 0.46],
    crate: [0.90, 0.90, 0.92], trench: [0.25, 0.27, 0.33], metal: [0.5, 0.52, 0.58], stripe: [0.95, 0.55, 0.15], fence: [0.95, 0.55, 0.15], gate: [0.42, 0.45, 0.52],
  },
  foundry: {
    floor: [0.26, 0.28, 0.32], wall: [0.18, 0.2, 0.25], plate: [0.4, 0.42, 0.48], ramp: [0.85, 0.5, 0.12], rock: [0.3, 0.32, 0.38],
    crate: [0.62, 0.42, 0.22], trench: [0.18, 0.2, 0.24], metal: [0.44, 0.48, 0.56], stripe: [0.92, 0.58, 0.12], fence: [0.95, 0.7, 0.1], gate: [0.26, 0.28, 0.32],
  },
};
const SIDE_DARK = 0.72;   // cliffs are drawn darker than tops

export function buildDataStage(app, w, KINDS, loadProp) {
  const device = app.graphicsDevice;
  const pal = PAL[w.stage] || PAL.quarry;
  const root = new pc.Entity(`stage-${w.stage}`);
  const { nx, nz, cell, minX, minZ } = w;
  // drawn heights: gates open (the shutters are their own entities), boxes with a model drawn as the
  // ground under them (the model stands there instead)
  const H = new Float32Array(w.base || w.h), KD = new Uint8Array(w.kind);
  const kIndex = (k) => Math.max(0, KINDS.indexOf(k));
  for (const sh of w.shapes || []) {
    if (!sh.prop) continue;
    const ix0 = Math.ceil((sh.x0 - minX) / cell - 1e-6), ix1 = Math.floor((sh.x1 - minX) / cell + 1e-6);
    const iz0 = Math.ceil((sh.z0 - minZ) / cell - 1e-6), iz1 = Math.floor((sh.z1 - minZ) / cell + 1e-6);
    for (let iz = iz0; iz <= iz1; iz++) for (let ix = ix0; ix <= ix1; ix++) { const i = iz * nx + ix; H[i] = sh.base; KD[i] = kIndex(sh.base > 0 ? 'plate' : 'floor'); }
  }
  const kindName = (i) => KINDS[KD[i]] || 'floor';
  const isRamp = (i) => kindName(i) === 'ramp';
  const col = (k, dark = 1) => (pal[k] || pal.floor).map((c) => c * dark);

  const pos = [], nrm = [], clr = [], uv = [], idx = [];
  const TILE = 4;   // the texture repeats every 4 m
  const quad = (p, n, c) => {   // p: 4 corners counter-clockwise seen from the normal side
    const b = pos.length / 3;
    for (const q of p) {
      pos.push(...q); nrm.push(...n); clr.push(...c, 1);
      if (Math.abs(n[1]) > 0.5) uv.push(q[0] / TILE, q[2] / TILE); else if (Math.abs(n[0]) > 0.5) uv.push(q[2] / TILE, q[1] / TILE); else uv.push(q[0] / TILE, q[1] / TILE);
    }
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  };
  const X = (ix) => minX + (ix - 0.5) * cell, Z = (iz) => minZ + (iz - 0.5) * cell;   // cell edges

  // ---- flat tops: greedy rectangles of equal height and kind
  const done = new Uint8Array(nx * nz);
  for (let iz = 0; iz < nz; iz++) for (let ix = 0; ix < nx; ix++) {
    const i = iz * nx + ix;
    if (done[i] || isRamp(i)) continue;
    const h = H[i], k = KD[i];
    const same = (j) => !done[j] && !isRamp(j) && H[j] === h && KD[j] === k;
    let ex = ix; while (ex + 1 < nx && same(iz * nx + ex + 1)) ex++;
    let ez = iz;
    grow: while (ez + 1 < nz) { for (let x = ix; x <= ex; x++) if (!same((ez + 1) * nx + x)) break grow; ez++; }
    for (let z = iz; z <= ez; z++) for (let x = ix; x <= ex; x++) done[z * nx + x] = 1;
    const x0 = X(ix), x1 = X(ex + 1), z0 = Z(iz), z1 = Z(ez + 1);
    const tint = kindName(i) === 'floor' ? 1 : 1;
    quad([[x0, h, z1], [x1, h, z1], [x1, h, z0], [x0, h, z0]], [0, 1, 0], col(kindName(i), tint));
  }
  // ---- ramps: one sloped quad each, from the stage data
  for (const s of w.shapes || []) {
    if (s.type !== 'ramp') continue;
    const { x0, x1, z0, z1 } = s, lo = s.h0, hi = s.h;
    const y = (x, z) => (s.up === '-x' ? (x === x0 ? hi : lo) : s.up === '+x' ? (x === x1 ? hi : lo) : s.up === '-z' ? (z === z0 ? hi : lo) : (z === z1 ? hi : lo));
    const a = [x0, y(x0, z1), z1], b = [x1, y(x1, z1), z1], c = [x1, y(x1, z0), z0], d = [x0, y(x0, z0), z0];
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
    let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const L = Math.hypot(...n) || 1; n = n.map((q) => q / L); if (n[1] < 0) n = n.map((q) => -q);
    quad([a, b, c, d], n, col('ramp'));
    // warning stripes along the ramp edges
  }
  // ---- cliffs between neighbouring cells of different height (merged along each edge line)
  const side = (hiI, loI) => kindName(hiI) === 'trench' ? 'trench' : kindName(hiI);
  // edges between columns ix and ix+1 (faces along z)
  for (let ix = 0; ix < nx - 1; ix++) {
    let run = null;
    const flush = () => {
      if (!run) return;
      const x = X(ix + 1), z0 = Z(run.iz0), z1 = Z(run.iz1 + 1);
      const n = run.dir > 0 ? [1, 0, 0] : [-1, 0, 0];   // facing the lower side
      const p = run.dir > 0 ? [[x, run.lo, z1], [x, run.lo, z0], [x, run.hi, z0], [x, run.hi, z1]] : [[x, run.lo, z0], [x, run.lo, z1], [x, run.hi, z1], [x, run.hi, z0]];
      quad(p, n, col(run.k, SIDE_DARK));
      run = null;
    };
    for (let iz = 0; iz < nz; iz++) {
      const a = iz * nx + ix, b = a + 1, ha = H[a], hb = H[b];
      if (Math.abs(ha - hb) < 0.02 || (isRamp(a) && isRamp(b))) { flush(); continue; }
      const dir = ha > hb ? 1 : -1, hi = Math.max(ha, hb), lo = Math.min(ha, hb), k = side(dir > 0 ? a : b, dir > 0 ? b : a);
      if (run && run.dir === dir && run.hi === hi && run.lo === lo && run.k === k && run.iz1 === iz - 1) run.iz1 = iz;
      else { flush(); run = { dir, hi, lo, k, iz0: iz, iz1: iz }; }
    }
    flush();
  }
  // edges between rows iz and iz+1 (faces along x)
  for (let iz = 0; iz < nz - 1; iz++) {
    let run = null;
    const flush = () => {
      if (!run) return;
      const z = Z(iz + 1), x0 = X(run.ix0), x1 = X(run.ix1 + 1);
      const n = run.dir > 0 ? [0, 0, 1] : [0, 0, -1];
      const p = run.dir > 0 ? [[x0, run.lo, z], [x1, run.lo, z], [x1, run.hi, z], [x0, run.hi, z]] : [[x1, run.lo, z], [x0, run.lo, z], [x0, run.hi, z], [x1, run.hi, z]];
      quad(p, n, col(run.k, SIDE_DARK * 0.92));
      run = null;
    };
    for (let ix = 0; ix < nx; ix++) {
      const a = iz * nx + ix, b = a + nx, ha = H[a], hb = H[b];
      if (Math.abs(ha - hb) < 0.02 || (isRamp(a) && isRamp(b))) { flush(); continue; }
      const dir = ha > hb ? 1 : -1, hi = Math.max(ha, hb), lo = Math.min(ha, hb), k = side(dir > 0 ? a : b, dir > 0 ? b : a);
      if (run && run.dir === dir && run.hi === hi && run.lo === lo && run.k === k && run.ix1 === ix - 1) run.ix1 = ix;
      else { flush(); run = { dir, hi, lo, k, ix0: ix, ix1: ix }; }
    }
    flush();
  }
  const mesh = new pc.Mesh(device);
  mesh.setPositions(pos); mesh.setNormals(nrm); mesh.setColors(clr); mesh.setUvs(0, uv); mesh.setIndices(idx); mesh.update();
  const mat = new pc.StandardMaterial();
  mat.diffuse = new pc.Color(1, 1, 1); mat.diffuseVertexColor = true; mat.diffuseMap = surfaceTexture(device, w.stage);
  mat.gloss = w.stage === 'foundry' ? 0.35 : 0.15; mat.useMetalness = true; mat.metalness = 0; mat.update();
  const terrain = new pc.Entity('terrain');
  terrain.addComponent('render', { meshInstances: [new pc.MeshInstance(mesh, mat)], castShadows: false });
  root.addChild(terrain);
  const tris = idx.length / 3;

  // ---- simple coloured blocks for the moving / glowing parts
  const mats = {};
  const flat = (name, c, emissive = null) => {
    if (mats[name]) return mats[name];
    const m = new pc.StandardMaterial();
    m.diffuse = new pc.Color(...c); m.gloss = 0.3; m.useMetalness = true; m.metalness = 0;
    if (emissive) { m.emissive = new pc.Color(...emissive); m.emissiveIntensity = 1; }
    m.update(); mats[name] = m; return m;
  };
  const block = (parent, type, m, px, py, pz, sx, sy, sz) => {
    const e = new pc.Entity(); e.addComponent('render', { type, material: m, castShadows: false });
    e.setLocalPosition(px, py, pz); e.setLocalScale(sx, sy, sz); parent.addChild(e); return e;
  };

  // shutters: slide down into the floor when open
  const gates = w.gates.map((g) => {
    const e = new pc.Entity('gate'); root.addChild(e);
    const cx = (g.x0 + g.x1) / 2, cz = (g.z0 + g.z1) / 2, sx = g.x1 - g.x0 + cell, sz = g.z1 - g.z0 + cell;
    e.setLocalPosition(cx, 0, cz);
    const body = block(e, 'box', flat('gate', [0.55, 0.58, 0.64]), 0, g.h / 2, 0, sx, g.h, sz);
    const n = 5;   // orange / dark warning bands
    for (let k = 0; k < n; k++) block(body, 'box', flat('gateband', [0.95, 0.55, 0.12]), 0, -0.5 + (k + 0.5) / n, 0, 1.01, 0.08, 1.01);
    const lamp = block(e, 'sphere', flat('lampoff', [0.3, 0.1, 0.05]), 0, g.h + 0.35, 0, 0.6, 0.6, 0.6);
    return { g, e, body, lamp, y: 0, sx, sz };
  });
  // jump pads: glowing discs with a ring
  for (const z of w.zones) {
    if (z.type === 'pad') {
      const y = heightOf(w, z.x, z.z);
      block(root, 'cylinder', flat('pad', [0.2, 0.9, 1], [0.1, 0.6, 0.9]), z.x, y + 0.04, z.z, z.r * 2, 0.08, z.r * 2);
      block(root, 'cylinder', flat('padrim', [0.9, 0.9, 0.95]), z.x, y + 0.02, z.z, z.r * 2 + 0.6, 0.05, z.r * 2 + 0.6);
    } else if (z.type === 'belt') {
      // rollers: dark strip with bright chevrons that move with the belt (animated in update())
      block(root, 'box', flat('belt', [0.12, 0.13, 0.15]), (z.x0 + z.x1) / 2, 0.02, (z.z0 + z.z1) / 2, z.x1 - z.x0, 0.04, z.z1 - z.z0);
    }
  }
  const chevrons = [];
  for (const z of w.zones) if (z.type === 'belt') {
    const len = z.x1 - z.x0, n = Math.floor(len / 4), dir = Math.sign(z.vx);
    for (let k = 0; k < n; k++) {
      const e = new pc.Entity(); root.addChild(e);
      for (const s of [-1, 1]) {
        const bar = block(e, 'box', flat('chev', [0.95, 0.75, 0.15], [0.35, 0.25, 0.02]), 0, 0, s * 0.9, 0.35, 0.03, 2.1);
        bar.setLocalEulerAngles(0, -dir * s * 35, 0);
      }
      chevrons.push({ e, z, base: z.x0 + 2 + k * 4, dir });
    }
  }
  // switches: a target disc on each post; lit when ready
  const switches = w.switches.map((s) => {
    const e = new pc.Entity('switch'); root.addChild(e); e.setLocalPosition(s.x, s.y, s.z);
    const disc = block(e, 'cylinder', flat('swready', [0.2, 1, 0.4], [0.1, 0.8, 0.25]), 0, 0, 0, s.r * 2, 0.15, s.r * 2);
    disc.setLocalEulerAngles(90, 0, 0);
    block(e, 'cylinder', flat('swring', [0.95, 0.95, 0.95]), 0, 0, 0, s.r * 2.3, 0.1, s.r * 2.3).setLocalEulerAngles(90, 0, 0);
    return { s, disc };
  });

  // models (Kenney, CC0) standing in for the boxes marked with a prop, plus decoration
  if (loadProp) {
    const place = (name, x, y, z, sx, sy, sz, yaw = 0) => loadProp(`assets/stages/${w.stage}/${name}.glb`).then((asset) => {
      const e = asset.resource.instantiateRenderEntity();
      e.setLocalPosition(x, y, z); e.setLocalScale(sx, sy, sz); e.setLocalEulerAngles(0, yaw, 0);
      root.addChild(e);
    }).catch((err) => console.warn('prop', name, err?.message));
    const DIM = { rock_largeA: [0.92, 0.5, 0.83], rock_largeB: [0.92, 0.5, 0.83], rock_crystalsLargeA: [0.83, 0.54, 0.92], hangar_roundA: [3.28, 1.5, 2.84], 'box-large': [1, 0.5, 1], 'scanner-high': [0.7, 1.2, 1.6] };
    let k = 0;
    for (const sh of w.shapes || []) {
      if (!sh.prop) continue;
      const d = DIM[sh.prop] || [1, 1, 1], sx = sh.x1 - sh.x0, sz = sh.z1 - sh.z0, hgt = sh.h - sh.base;
      const big = /rock/.test(sh.prop) ? 1.12 : 1;   // lumpy rocks: a little larger than their box
      place(sh.prop, (sh.x0 + sh.x1) / 2, sh.base, (sh.z0 + sh.z1) / 2, (sx / d[0]) * big, (hgt / d[1]) * big, (sz / d[2]) * big, /rock/.test(sh.prop) ? (k++ * 97) % 360 : 0);
    }
    if (w.stage === 'foundry') {
      for (const x of [-14, 14]) for (const z of [-1.5, 1.5]) place('robot-arm-a', x, 4.2, z, 2.6, 2.6, 2.6, x > 0 ? 90 : -90);
      for (const x of [-9, 9]) for (const z of [-6.5, 6.5]) place('structure-yellow-tall', x, 0, z, 3, 3, 3, 90);
    }
    if (w.stage === 'quarry') {
      for (const [x, z, sc] of [[-30, 30, 9], [30, -30, 9], [-14, 34, 6], [14, -34, 6], [34, 14, 6], [-34, -14, 6]]) place('crater', x, 0, z, sc, 1.2, sc, x * 3);
    }
  }

  let tAcc = 0;
  return {
    root, tris,
    // called every frame: shutters follow w.gates[i].open, belts scroll, switches show readiness
    update(dt, { switchCd = 0, warn = false } = {}) {
      tAcc += dt;
      for (const G of gates) {
        const want = G.g.open ? -G.g.h + 0.05 : 0;
        G.y += (want - G.y) * Math.min(1, dt * 7);
        G.body.setLocalPosition(0, G.g.h / 2 + G.y, 0);
        G.lamp.render.material = G.g.open ? flat('lampon', [0.2, 1, 0.3], [0.2, 1, 0.3]) : warn && Math.floor(tAcc * 6) % 2 ? flat('lampwarn', [1, 0.6, 0.1], [1, 0.5, 0]) : flat('lampoff', [0.3, 0.1, 0.05]);
      }
      for (const c of chevrons) {
        const len = c.z.x1 - c.z.x0;
        let x = c.base + (tAcc * Math.abs(c.z.vx) * c.dir);
        x = c.z.x0 + ((((x - c.z.x0) % len) + len) % len);
        c.e.setLocalPosition(x, 0.06, (c.z.z0 + c.z.z1) / 2);
      }
      for (const S of switches) S.disc.render.material = switchCd > 0 ? flat('swwait', [0.5, 0.15, 0.1]) : flat('swready', [0.2, 1, 0.4], [0.1, 0.8, 0.25]);
    },
  };
}
// a tiling surface texture (made in code: no image to download), tinted per face by the vertex colours
function surfaceTexture(device, stage) {
  const N = 256, c = document.createElement('canvas'); c.width = c.height = N;
  const g = c.getContext('2d');
  let seed = stage === 'foundry' ? 7 : 3;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  g.fillStyle = '#e6e6e6'; g.fillRect(0, 0, N, N);
  if (stage === 'foundry') {
    // steel floor plates (2 m) with seams, rivets and a fine brushed noise
    for (let i = 0; i < 2600; i++) { const v = 205 + rnd() * 40; g.fillStyle = `rgb(${v},${v},${v})`; g.fillRect(rnd() * N, rnd() * N, 2 + rnd() * 10, 1); }
    g.strokeStyle = 'rgba(40,40,45,0.55)'; g.lineWidth = 3;
    for (const o of [0, N / 2]) { g.beginPath(); g.moveTo(o + 1.5, 0); g.lineTo(o + 1.5, N); g.moveTo(0, o + 1.5); g.lineTo(N, o + 1.5); g.stroke(); }
    g.fillStyle = 'rgba(60,60,66,0.7)';
    for (const x of [10, N / 2 - 10, N / 2 + 10, N - 10]) for (const y of [10, N / 2 - 10, N / 2 + 10, N - 10]) { g.beginPath(); g.arc(x, y, 3, 0, Math.PI * 2); g.fill(); }
  } else {
    // regolith: speckles and soft blotches, faint panel seams
    for (let i = 0; i < 40; i++) { const v = 200 + rnd() * 50; g.fillStyle = `rgba(${v},${v},${v},0.35)`; g.beginPath(); g.arc(rnd() * N, rnd() * N, 10 + rnd() * 34, 0, Math.PI * 2); g.fill(); }
    for (let i = 0; i < 3500; i++) { const v = 150 + rnd() * 105; g.fillStyle = `rgb(${v},${v},${v})`; g.fillRect(rnd() * N, rnd() * N, 1 + rnd() * 2, 1 + rnd() * 2); }
    g.strokeStyle = 'rgba(70,70,80,0.25)'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(1, 0); g.lineTo(1, N); g.moveTo(0, 1); g.lineTo(N, 1); g.stroke();
  }
  const tex = new pc.Texture(device, { width: N, height: N, mipmaps: true, addressU: pc.ADDRESS_REPEAT, addressV: pc.ADDRESS_REPEAT, anisotropy: 4 });
  tex.setSource(c);
  return tex;
}
function heightOf(w, x, z) {
  const ix = Math.round((x - w.minX) / w.cell), iz = Math.round((z - w.minZ) / w.cell);
  return w.h[iz * w.nx + ix];
}
