// Meshes for the cover objects defined in shared/arena.js. Extents come from applyObstacles(), so
// what you see is exactly what you collide with (collision is the 0.5 m heightfield).
import * as pc from 'playcanvas';
import { moundHeight } from '../shared/arena.js';

const COLORS = {
  stone: [0.78, 0.58, 0.36], stoneCap: [0.66, 0.47, 0.28],
  low: [0.86, 0.70, 0.48], lowCap: [0.72, 0.55, 0.36],
  pillar: [0.74, 0.54, 0.33], pillarCap: [0.60, 0.42, 0.25],
  crate: [0.55, 0.35, 0.18], crateBand: [0.36, 0.22, 0.11],
  sand: [0.74, 0.58, 0.37], sandTop: [0.80, 0.64, 0.42],
};

export function buildStage(app, parent, obstacles) {
  const mats = {};
  const mat = (k) => {
    if (!mats[k]) {
      const m = new pc.StandardMaterial();
      m.diffuse = new pc.Color(...COLORS[k]);
      m.gloss = 0.15; m.metalness = 0; m.useMetalness = true;
      m.update();
      mats[k] = m;
    }
    return mats[k];
  };
  const block = (x0, x1, y0, y1, z0, z1, k) => {
    const e = new pc.Entity('cover');
    e.addComponent('render', { type: 'box', material: mat(k), castShadows: false });
    e.setLocalPosition((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    e.setLocalScale(x1 - x0, y1 - y0, z1 - z0);
    parent.addChild(e);
  };

  for (const o of obstacles) {
    const { ex0, ex1, ez0, ez1 } = o;
    if (o.type === 'mound') { parent.addChild(moundMesh(app.graphicsDevice, o, mat('sand'), mat('sandTop'))); continue; }
    const h = o.h;
    if (o.kind === 'crate') {
      block(ex0, ex1, 0, h, ez0, ez1, 'crate');
      const t = 0.12;   // darker bands so it reads as a crate
      block(ex0 - 0.02, ex1 + 0.02, h * 0.45, h * 0.55, ez0 - 0.02, ez1 + 0.02, 'crateBand');
      block(ex0 - 0.03, ex1 + 0.03, h - t, h + 0.02, ez0 - 0.03, ez1 + 0.03, 'crateBand');
    } else if (o.kind === 'pillar') {
      block(ex0, ex1, 0, h, ez0, ez1, 'pillar');
      block(ex0 - 0.25, ex1 + 0.25, 0, 0.5, ez0 - 0.25, ez1 + 0.25, 'pillarCap');
      block(ex0 - 0.2, ex1 + 0.2, h - 0.35, h + 0.1, ez0 - 0.2, ez1 + 0.2, 'pillarCap');
    } else {
      const k = o.kind === 'low' ? 'low' : 'stone';
      block(ex0, ex1, 0, h - 0.25, ez0, ez1, k);
      block(ex0 - 0.08, ex1 + 0.08, h - 0.25, h, ez0 - 0.08, ez1 + 0.08, `${k}Cap`);
    }
  }
}

// low-poly round hill that follows moundHeight() exactly (flat shaded facets)
function moundMesh(device, o, slopeMat, topMat) {
  const SEG = 28;
  const radii = [];
  for (let r = o.rTop; r < o.rBase - 0.01; r += 1.1) radii.push(r);
  radii.push(o.rBase);
  const hAt = (r) => (r >= o.rBase - 0.01 ? -0.06 : moundHeight(o, r));   // tuck the rim just under the floor
  const ang = (i) => (i / SEG) * Math.PI * 2;
  const pt = (r, i) => [o.cx + Math.cos(ang(i)) * r, hAt(r), o.cz + Math.sin(ang(i)) * r];
  const build = (quads) => {
    const pos = [], nrm = [], idx = [];
    for (const f of quads) {
      const [p0, p1, p2] = f;
      const u = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]], v = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
      let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const len = Math.hypot(...n) || 1; n = n.map((c) => c / len);
      const flip = n[1] < 0;                     // every face of a hill points upwards
      if (flip) n = n.map((c) => -c);
      const base = pos.length / 3;
      for (const p of f) { pos.push(...p); nrm.push(...n); }
      if (f.length === 3) idx.push(...(flip ? [base, base + 2, base + 1] : [base, base + 1, base + 2]));
      else idx.push(...(flip ? [base, base + 2, base + 1, base, base + 3, base + 2] : [base, base + 1, base + 2, base, base + 2, base + 3]));
    }
    const mesh = new pc.Mesh(device);
    mesh.setPositions(pos); mesh.setNormals(nrm); mesh.setIndices(idx); mesh.update();
    return mesh;
  };
  const slope = [];
  for (let k = 0; k < radii.length - 1; k++) {
    for (let i = 0; i < SEG; i++) slope.push([pt(radii[k], i), pt(radii[k], i + 1), pt(radii[k + 1], i + 1), pt(radii[k + 1], i)]);
  }
  const top = [];
  const c = [o.cx, o.h, o.cz];
  for (let i = 0; i < SEG; i++) top.push([c, pt(o.rTop, i + 1), pt(o.rTop, i)]);
  const e = new pc.Entity('hill');
  e.addComponent('render', { meshInstances: [new pc.MeshInstance(build(slope), slopeMat), new pc.MeshInstance(build(top), topMat)], castShadows: false });
  return e;
}
