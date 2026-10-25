import * as pc from 'playcanvas';
import { Room, createRoom, roomInfo } from './net.js';
import {
  C, DT, makeWorld, heightAt, newTank, stepTank, muzzle, stepShell, segmentHitsTank, wrapPi, clamp,
} from '../shared/sim.js';
import { PLAYER_COLORS, RECONNECT_SECONDS, applyObstacles, PIT_HALF, HEAL_POS } from '../shared/arena.js';
import { Input } from './input.js';
import { Fx } from './fx.js';
import { buildStage } from './stage.js';

// ------------------------------------------------------------------ config
const ENDPOINT = location.origin;   // the Worker serves both the page and /api
const INTERP_TICKS = 3.5;          // remote entities are rendered ~115 ms in the past
const CAM_DIST = 8.5, CAM_PIVOT = 2.3, CAM_LIFT = 0.9, BASE_FOV = 62;
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const DEBUG = params.has('debug');
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  sget(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
  sset(k, v) { try { sessionStorage.setItem(k, v); } catch { /* ignore */ } },
  sdel(k) { try { sessionStorage.removeItem(k); } catch { /* ignore */ } },
};

// ------------------------------------------------------------------ globals
let app, device, world, tankAsset, camera, root, fx;
let input;
let room = null, myId = null, mySlot = 0, phase = 'play';
const roster = new Map();         // id -> {name, slot, connected}
const tanks = new Map();          // id -> visual
const snaps = [];                 // parsed snapshots (ascending k)
let serverTick = null;            // estimated current server tick (float)
const pendingEvents = [];
let camYaw = 0, camPitch = 0.05, camDistNow = CAM_DIST, fovKick = 0;
const aimPoint = new pc.Vec3();
let acc = 0, seq = 0;
const local = { t: null, prev: null, alive: false, spawnId: -1, pending: [], offset: new pc.Vec3(), hp: C.maxHp, invuln: false, invulnLeft: 0, respawnIn: 0, sliding: false };
const localShells = [];
const seenShells = new Set();     // remote shell ids that already got a muzzle flash
let ping = 0, fpsSmooth = 60;
const stats = { corrections: 0, bigCorrections: 0 };
const mats = {};
const heal = { active: false, next: 0, e: null, tag: null };
window.__ht = { stats, local, snaps, setCam: DEBUG ? (y, p) => { camYaw = y; camPitch = p; } : undefined, los: DEBUG ? (...a) => lineOfSight(...a) : undefined, get aim() { return aimPoint; }, get room() { return room; }, get fps() { return fpsSmooth; }, get ping() { return ping; }, get fx() { return fx; } };

// ------------------------------------------------------------------ boot
init().catch((e) => { console.error(e); showLoading(false); $('lobby-status').textContent = `初期化に失敗しました: ${e.message}`; });

async function init() {
  document.body.classList.toggle('touch', matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window);
  $('name').value = store.get('ht-name') || '';
  const rid = params.get('r');
  if (rid) { $('btn-join').classList.remove('hidden'); $('btn-join').textContent = `部屋 ${rid} に参加`; }
  $('btn-create').onclick = () => start('create');
  $('btn-join').onclick = () => start('join', rid);
  wireUi();
  showLoading(true, '読み込み中…');
  await setupEngine();
  showLoading(false);
  window.__ht.readyAt = performance.now();
  // auto-rejoin after a reload in the same tab
  if (rid && store.sget(`ht-token-${rid}`)) start('reconnect', rid);
}

async function setupEngine() {
  const canvas = $('game');
  device = await pc.createGraphicsDevice(canvas, { deviceTypes: ['webgl2'], antialias: false, powerPreference: 'high-performance' });
  const opts = new pc.AppOptions();
  opts.graphicsDevice = device;
  opts.componentSystems = [pc.RenderComponentSystem, pc.CameraComponentSystem, pc.LightComponentSystem];
  opts.resourceHandlers = [pc.TextureHandler, pc.ContainerHandler];
  app = new pc.AppBase(canvas);
  app.init(opts);
  app.setCanvasFillMode(pc.FILLMODE_FILL_WINDOW);
  app.setCanvasResolution(pc.RESOLUTION_AUTO);
  window.addEventListener('resize', () => app.resizeCanvas());
  app.scene.ambientLight = new pc.Color(0.52, 0.47, 0.42);
  app.scene.exposure = 1.0;

  root = new pc.Entity('root');
  app.root.addChild(root);
  camera = new pc.Entity('camera');
  camera.addComponent('camera', { clearColor: new pc.Color(0.78, 0.66, 0.50), fov: BASE_FOV, nearClip: 0.2, farClip: 300 });
  app.root.addChild(camera);
  const sun = new pc.Entity('sun');
  sun.addComponent('light', { type: 'directional', color: new pc.Color(1, 0.94, 0.84), intensity: 1.15, castShadows: false });
  sun.setEulerAngles(52, 35, 0);
  app.root.addChild(sun);
  fx = new Fx(app, root);
  applyQuality(store.get('ht-quality') || (document.body.classList.contains('touch') ? 'mid' : 'high'));

  // world: heightfield + meshes + cover objects
  const base = import.meta.env.BASE_URL;
  const [meta, hf] = await Promise.all([
    fetch(`${base}assets/arena_hf.json`).then((r) => r.json()),
    fetchBinary(`${base}assets/arena_hf.bin`),
  ]);
  world = makeWorld(meta, new Float32Array(hf));
  const cover = applyObstacles(world);
  const [arena, tank] = await Promise.all([loadContainer(`${base}assets/arena.glb`), loadContainer(`${base}assets/tank.glb`)]);
  tankAsset = tank;
  root.addChild(arena.resource.instantiateRenderEntity());
  buildStage(app, root, cover);
  makeMaterials();
  makeHealPickup();

  input = new Input(canvas, {
    touchLayer: $('touch-layer'), stickBase: $('stick-base'), stickKnob: $('stick-knob'),
    btnFire: $('btn-fire'), btnJump: $('btn-jump'), btnDrift: $('btn-drift'),
    onPointerLock: (locked) => { $('pc-help').style.opacity = locked ? '0.35' : '0.9'; },
  });
  input.enabled = false;
  const sens = parseFloat(store.get('ht-sens') || '1');
  $('sens').value = String(sens); setSens(sens);

  camera.setPosition(40, 26, 40); camera.lookAt(0, 0, 0);
  app.on('update', update);
  app.start();
}

// Binary assets are shipped pre-gzipped (<file>.gz, see vite.config.js) because the CDN does not
// compress .glb/.bin. Decompress in the browser; fall back to the plain file if needed.
async function fetchBinary(url) {
  if (typeof DecompressionStream !== 'undefined') {
    try {
      const r = await fetch(`${url}.gz`);
      if (r.ok) return await new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    } catch { /* fall through */ }
  }
  return (await fetch(url)).arrayBuffer();
}

async function loadContainer(url) {
  const buf = await fetchBinary(url);
  const blobUrl = URL.createObjectURL(new Blob([buf], { type: 'model/gltf-binary' }));
  return new Promise((resolve, reject) => {
    app.assets.loadFromUrlAndFilename(blobUrl, url.split('/').pop(), 'container', (err, asset) => (err ? reject(err) : resolve(asset)));
  });
}

// ------------------------------------------------------------------ quality & settings
function applyQuality(q) {
  const dpr = window.devicePixelRatio || 1;
  device.maxPixelRatio = q === 'low' ? Math.min(dpr, 1) * 0.6 : q === 'mid' ? Math.min(dpr, 1.25) : Math.min(dpr, 2);
  app?.resizeCanvas();
  fx?.setQuality(q);
  store.set('ht-quality', q);
  document.querySelectorAll('#quality-row button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.q === q)));
}
function setSens(v) { if (input) { input.mouseSens = 0.0025 * v; input.touchSens = 0.0065 * v; } store.set('ht-sens', String(v)); }

function wireUi() {
  document.querySelectorAll('#quality-row button').forEach((b) => { b.onclick = () => applyQuality(b.dataset.q); });
  $('sens').oninput = (e) => setSens(parseFloat(e.target.value));
  $('btn-settings').onclick = () => { document.exitPointerLock?.(); $('settings').classList.remove('hidden'); };
  $('btn-settings-close').onclick = () => $('settings').classList.add('hidden');
  $('btn-invite').onclick = () => { document.exitPointerLock?.(); showInvite(); };
  $('btn-invite-close').onclick = () => $('invite').classList.add('hidden');
  $('btn-copy').onclick = async () => {
    const v = $('invite-url').value;
    try { await navigator.clipboard.writeText(v); $('btn-copy').textContent = 'コピーしました'; } catch { $('invite-url').select(); document.execCommand?.('copy'); }
    setTimeout(() => { $('btn-copy').textContent = 'コピー'; }, 1500);
  };
  $('btn-share').onclick = () => navigator.share?.({ title: 'Hover Tank Arena', text: '一緒に対戦しよう', url: $('invite-url').value }).catch(() => {});
  if (!navigator.share) $('btn-share').classList.add('hidden');
  $('btn-fullscreen').onclick = async () => {
    try { await document.documentElement.requestFullscreen?.(); await screen.orientation?.lock?.('landscape'); } catch { /* not supported (iOS Safari) */ }
  };
  // new game: tap twice (the first tap asks for confirmation)
  let armed = 0;
  const newGame = (btn) => () => {
    if (!room) return;
    if (performance.now() - armed > 3000) { armed = performance.now(); btn.textContent = 'もう一度押すとリセット'; setTimeout(() => { btn.textContent = btn.dataset.label; }, 3000); return; }
    armed = 0; btn.textContent = btn.dataset.label;
    room.send('newgame', 1);
  };
  for (const id of ['btn-newgame', 'btn-result-newgame']) { const b = $(id); b.dataset.label = b.textContent; b.onclick = newGame(b); }
  $('btn-leave').onclick = async () => { if (room) { store.sdel(`ht-token-${room.roomId}`); await room.leave(); } location.href = location.pathname; };
}

function showInvite() {
  $('invite-url').value = `${location.origin}${location.pathname}?r=${room.roomId}`;
  $('invite').classList.remove('hidden');
}
function showLoading(on, text) { $('loading').classList.toggle('hidden', !on); if (text) $('loading-text').textContent = text; }
function banner(text) { $('banner').textContent = text || ''; $('banner').classList.toggle('hidden', !text); }

// ------------------------------------------------------------------ networking
async function start(mode, rid) {
  const name = $('name').value.trim().slice(0, 12);
  store.set('ht-name', name);
  $('lobby-status').textContent = '';
  showLoading(true, 'サーバーに接続中…');
  try {
    let id = rid;
    if (mode === 'create') id = await createRoom(ENDPOINT);
    else {
      const info = await roomInfo(ENDPOINT, id);
      if (!info.exists) throw Object.assign(new Error('notfound'), { code: 'notfound' });
      if (info.full && mode !== 'reconnect') throw Object.assign(new Error('full'), { code: 'full' });
    }
    room = new Room(ENDPOINT, id);
    bindRoom(room);
    const token = mode === 'reconnect' ? store.sget(`ht-token-${id}`) : null;
    await room.connect(name, token);   // with a valid token the server gives back the same seat
  } catch (e) {
    showLoading(false);
    const code = e?.code || '';
    $('lobby-status').textContent = code === 'full' ? 'この部屋は満室です（最大4人）。'
      : code === 'notfound' ? '部屋が見つかりません。URLが違うか、部屋が削除された可能性があります。'
        : `接続できませんでした: ${e?.message || e}`;
    room = null;
    return;
  }
  history.replaceState(null, '', `${location.pathname}?r=${room.roomId}${DEBUG ? '&debug' : ''}`);
  store.sset(`ht-token-${room.roomId}`, room.reconnectionToken);
  showLoading(false);
  $('lobby').classList.add('hidden');
  $('hud').classList.remove('hidden');
  document.body.classList.add('playing');
  input.enabled = true;
  if (mode === 'create') showInvite();
  if (!input.touchMode) $('center-msg').textContent = 'クリックで操作開始';
  setInterval(() => room?.send('ping', performance.now()), 2000);
}

function bindRoom(r) {
  r.onMessage('welcome', (m) => { myId = m.id; mySlot = m.slot; phase = m.phase; if (m.reconnected) { local.spawnId = -1; } });
  r.onMessage('roster', (list) => {
    const seen = new Set();
    for (const p of list) { roster.set(p.id, p); seen.add(p.id); }
    for (const id of [...roster.keys()]) if (!seen.has(id)) { roster.delete(id); removeTank(id); }
    updateBoard();
  });
  r.onMessage('s', onSnapshot);
  r.onMessage('result', showResult);
  r.onMessage('pong', (t) => { ping = ping ? ping * 0.7 + (performance.now() - t) * 0.3 : performance.now() - t; });
  r.onDrop(() => { banner('接続が切れました。再接続中…'); input.reset(); });
  r.onReconnect(() => { banner(''); store.sset(`ht-token-${r.roomId}`, r.reconnectionToken); local.spawnId = -1; });
  r.onLeave(() => {
    banner('');
    document.body.classList.remove('playing');
    input.enabled = false;
    $('center-msg').textContent = '';
    $('lobby').classList.remove('hidden');
    $('btn-join').classList.remove('hidden');
    $('btn-join').textContent = 'もう一度参加';
    $('btn-join').onclick = () => location.reload();
    $('lobby-status').textContent = `サーバーとの接続が切れました（${RECONNECT_SECONDS}秒以内の再接続に失敗）。`;
  });
}

function parseSnap(m) {
  const players = new Map();
  for (const a of m.p) {
    players.set(a[0], {
      id: a[0], x: a[1], y: a[2], z: a[3], vx: a[4], vy: a[5], vz: a[6], yaw: a[7], ay: a[8], ap: a[9],
      hp: a[10], alive: !!(a[11] & 1), grounded: !!(a[11] & 2), invuln: !!(a[11] & 4), connected: !!(a[11] & 8), drifting: !!(a[11] & 16),
      lastSeq: a[12], cooldown: a[13], shotSeq: a[14], kills: a[15], deaths: a[16], spawnId: a[17], respawnIn: a[18],
      charge: a[19] || 0, boost: a[20] || 0, boostLvl: a[21] || 0, invulnLeft: a[22] || 0,
    });
  }
  const shells = m.b.map((b) => ({ id: b[0], owner: b[1], seq: b[2], x: b[3], y: b[4], z: b[5], vx: b[6], vy: b[7], vz: b[8] }));
  return { k: m.k, ph: m.ph, tl: m.tl, players, shells, hl: !!m.hl, hn: m.hn || 0 };
}

function onSnapshot(m) {
  const s = parseSnap(m);
  snaps.push(s);
  while (snaps.length > 40) snaps.shift();
  if (serverTick === null || Math.abs(serverTick - s.k) > 15) serverTick = s.k;
  else serverTick += (s.k - serverTick) * 0.08;
  for (const e of m.e) {
    if (e.t === 'hit' && e.o === myId) flashHitmark();
    if (e.t === 'hit' && e.v === myId) { flashDamage(); fx.addShake(0.5); }
    if (e.t === 'newgame') {
      notice(`${escapeHtml(nameOf(e.by))} がニューゲームを開始しました`);
      $('result').classList.add('hidden'); $('settings').classList.add('hidden');
      local.spawnId = -1;
    }
    if (e.t === 'healspawn') notice('中央の丘に回復アイテムが出現！');
    if (e.t === 'heal' && e.v === myId) { centerFlash('全回復！', 1000, true); flashHeal(); }
    pendingEvents.push({ k: s.k, e });
  }
  if (phase !== s.ph) { phase = s.ph; if (phase === 'play') $('result').classList.add('hidden'); }
  $('timer').textContent = `${Math.floor(s.tl / 60)}:${String(s.tl % 60).padStart(2, '0')}`;
  heal.active = s.hl; heal.next = s.hn;
  $('heal-ind').textContent = s.ph !== 'play' ? '' : s.hl ? '✚ 回復アイテム 出現中（中央の丘）' : `✚ 回復まで ${s.hn}秒`;
  $('heal-ind').classList.toggle('on', s.hl);
  updateBoardScores(s);

  const me = s.players.get(myId);
  if (!me) return;
  local.hp = me.hp; local.invuln = me.invuln; local.invulnLeft = me.invulnLeft; local.respawnIn = me.respawnIn;
  if (!me.alive || !me.connected) { local.alive = false; local.pending = local.pending.filter((p) => p.seq > me.lastSeq); return; }
  if (!local.alive || me.spawnId !== local.spawnId) {
    // (re)spawn: snap to the server state
    local.t = fromServer(me); local.prev = { ...local.t };
    local.pending = []; local.offset.set(0, 0, 0);
    local.alive = true; local.spawnId = me.spawnId;
    camYaw = me.yaw; camPitch = 0.05;
    return;
  }
  // reconcile: rewind to server state and replay inputs the server hasn't processed yet
  local.pending = local.pending.filter((p) => p.seq > me.lastSeq);
  const before = local.t;
  const t = fromServer(me);
  for (const inp of local.pending) stepTank(t, inp, world);
  t.cooldown = before.cooldown; t.shotSeq = Math.max(t.shotSeq, before.shotSeq);  // keep local fire timing to avoid double shots
  const ex = before.x - t.x, ey = before.y - t.y, ez = before.z - t.z;
  const err = Math.hypot(ex, ey, ez);
  if (err > 0.01) {
    stats.corrections++;
    if (err > 4) { stats.bigCorrections++; local.offset.set(0, 0, 0); }
    else local.offset.add(new pc.Vec3(ex, ey, ez));
    local.prev.x -= ex; local.prev.y -= ey; local.prev.z -= ez;
  }
  local.t = t;
}

function fromServer(p) {
  const t = newTank(p.x, p.z, p.yaw, 0);
  Object.assign(t, {
    y: p.y, vx: p.vx, vy: p.vy, vz: p.vz, aimYaw: p.ay, aimPitch: p.ap, grounded: p.grounded, cooldown: p.cooldown, shotSeq: p.shotSeq,
    charge: p.charge, boost: p.boost, boostLvl: p.boostLvl, drifting: p.drifting,
  });
  return t;
}

// ------------------------------------------------------------------ per-frame update
function update(dt) {
  dt = Math.min(dt, 0.1);
  fpsSmooth = fpsSmooth * 0.95 + (1 / Math.max(dt, 1e-4)) * 0.05;
  if (!room || !myId) { lobbyCamera(dt); fx.update(dt); return; }

  const [lx, ly] = input.takeLook();
  camYaw = wrapPi(camYaw - lx);
  camPitch = clamp(camPitch - ly, -0.55, 0.62);

  acc += dt;
  let n = 0;
  while (acc >= DT && n < 5) { acc -= DT; tick(); n++; }
  if (n === 5) acc = 0;
  const alpha = acc / DT;

  if (serverTick !== null) serverTick += dt / DT;
  const rt = serverTick === null ? null : serverTick - INTERP_TICKS;

  local.offset.mulScalar(Math.exp(-12 * dt));
  renderLocal(alpha, dt);
  if (rt !== null) { renderRemote(rt, dt); flushEvents(rt); }
  tankFx(dt);
  updateHealPickup(dt);
  updateCamera(dt);
  computeAimPoint();
  updateLocalShells(dt);
  fx.update(dt);
  updateTags();
  updateHud(dt);
}

function tick() {
  const s = input.sample();
  const fx0 = -Math.sin(camYaw), fz0 = -Math.cos(camYaw), rx = Math.cos(camYaw), rz = -Math.sin(camYaw);
  const mx = rx * s.mx + fx0 * s.my, mz = rz * s.mx + fz0 * s.my;
  let ay = camYaw, ap = 0;
  if (local.t) [ay, ap] = solveAim(local.t, aimPoint);
  const inp = { seq: ++seq, mx: r3(mx), mz: r3(mz), ay: r3(ay), ap: r3(ap), j: s.jump, d: s.drift, f: s.fire && phase === 'play' };
  local.sliding = false;
  if (local.alive && local.t) {
    local.prev = { ...local.t };
    const t = local.t;
    const ev = stepTank(t, inp, world);
    const gy = t.y - C.hoverHeight;
    if (ev.fired) { fireLocalShell(t); fx.addShake(0.07); }
    if (ev.landed) fx.landRing(t.x, gy, t.z, 1);
    if (ev.jumped) fx.jumpRing(t.x, gy, t.z);
    if (ev.boost) { fx.boostBurst(t.x, gy, t.z, t.yaw, ev.boost); fovKick = ev.boost === 2 ? 14 : 9; fx.addShake(0.15 * ev.boost); }
    local.sliding = ev.sliding;
  }
  local.pending.push(inp);
  if (local.pending.length > 90) local.pending.shift();
  outBuf.push(inp);
  if (outBuf.length >= 2) { room.send('i', outBuf); outBuf = []; }
}
let outBuf = [];
const r3 = (v) => Math.round(v * 1000) / 1000;

// aim the barrel at whatever is under the crosshair (with gravity compensation)
function solveAim(t, target) {
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

// ------------------------------------------------------------------ materials
function makeMaterials() {
  // blob shadow (radial gradient texture generated at runtime: no download)
  const cv = document.createElement('canvas'); cv.width = cv.height = 64;
  const g = cv.getContext('2d'); const gr = g.createRadialGradient(32, 32, 4, 32, 32, 31);
  gr.addColorStop(0, 'rgba(0,0,0,0.55)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  const tex = new pc.Texture(device, { width: 64, height: 64, format: pc.PIXELFORMAT_RGBA8, mipmaps: true });
  tex.setSource(cv);
  const sm = new pc.StandardMaterial();
  sm.diffuse = new pc.Color(0, 0, 0); sm.opacityMap = tex; sm.opacityMapChannel = 'a';
  sm.blendType = pc.BLEND_NORMAL; sm.depthWrite = false; sm.useLighting = false; sm.update();
  mats.shadow = sm;
  // hover glow under the hull (additive, uses the same gradient)
  const hg = new pc.StandardMaterial();
  hg.diffuse = new pc.Color(0, 0, 0); hg.emissive = new pc.Color(0.3, 0.8, 1); hg.emissiveMap = tex; hg.emissiveMapChannel = 'a';
  hg.blendType = pc.BLEND_ADDITIVE; hg.depthWrite = false; hg.useLighting = false; hg.update();
  mats.hover = hg;
  mats.slotGlow = PLAYER_COLORS.map((c) => {
    const m = new pc.StandardMaterial();
    m.diffuse = new pc.Color(0, 0, 0); m.emissive = new pc.Color(...c); m.useLighting = false;
    m.blendType = pc.BLEND_ADDITIVE; m.depthWrite = false; m.update(); return m;
  });
  mats.slotLit = PLAYER_COLORS.map((c) => { const m = new pc.StandardMaterial(); m.diffuse = new pc.Color(...c); m.update(); return m; });
}

// ------------------------------------------------------------------ heal pickup
function makeHealPickup() {
  const g = new pc.Entity('heal');
  const cross = new pc.Entity('cross');
  const glowMat = fx.m.green;
  for (const [sx, sy] of [[1.6, 0.5], [0.5, 1.6]]) {
    const b = new pc.Entity('bar');
    b.addComponent('render', { type: 'box', material: glowMat, castShadows: false });
    b.setLocalScale(sx, sy, 0.5);
    cross.addChild(b);
  }
  const halo = new pc.Entity('halo');
  halo.addComponent('render', { type: 'sphere', material: fx.m.greenGlow, castShadows: false });
  halo.setLocalScale(2.6, 2.6, 2.6);
  cross.addChild(halo);
  g.addChild(cross);
  const ring = new pc.Entity('ring');
  ring.addComponent('render', { type: 'torus', material: fx.m.greenGlow, castShadows: false });
  ring.setLocalPosition(0, -1.25, 0);
  g.addChild(ring);
  const beam = new pc.Entity('beam');
  beam.addComponent('render', { type: 'cylinder', material: fx.m.greenGlow, castShadows: false });
  beam.setLocalScale(0.35, 30, 0.35);
  beam.setLocalPosition(0, 15, 0);
  g.addChild(beam);
  g.setPosition(HEAL_POS.x, HEAL_POS.y + 1.4, HEAL_POS.z);
  g.enabled = false;
  root.addChild(g);
  heal.e = g; heal.cross = cross; heal.ring = ring;
  const tag = document.createElement('div');
  tag.className = 'tag heal-tag';
  tag.textContent = '✚ 回復';
  $('tags').appendChild(tag);
  heal.tag = tag;
}
function updateHealPickup() {
  const on = heal.active && phase === 'play';
  heal.e.enabled = on;
  heal.tag.style.display = 'none';
  if (!on) return;
  const t = performance.now() / 1000;
  heal.cross.setLocalPosition(0, Math.sin(t * 2.2) * 0.25, 0);
  heal.cross.setLocalEulerAngles(0, (t * 90) % 360, 0);
  const s = 4 + Math.sin(t * 3) * 0.4;
  heal.ring.setLocalScale(s, 0.15, s);
  // screen label so players can find it from anywhere
  const p = new pc.Vec3(), w = app.graphicsDevice.clientRect?.width || innerWidth, h = app.graphicsDevice.clientRect?.height || innerHeight;
  camera.camera.worldToScreen(new pc.Vec3(HEAL_POS.x, HEAL_POS.y + 3.4, HEAL_POS.z), p);
  if (p.z > 0 && p.x > 0 && p.y > 0 && p.x < w && p.y < h) { heal.tag.style.display = 'block'; heal.tag.style.left = `${p.x}px`; heal.tag.style.top = `${p.y}px`; }
}

// ------------------------------------------------------------------ tanks
function getTank(id, slot) {
  let v = tanks.get(id);
  if (v) return v;
  const e = tankAsset.resource.instantiateRenderEntity();
  const col = PLAYER_COLORS[slot % 4];
  const cache = new Map();
  for (const r of e.findComponents('render')) {
    for (const mi of r.meshInstances) {
      const m = mi.material;
      if (!cache.has(m)) {
        const c = m.clone();
        if (/^Main/.test(m.name)) {
          const shade = m.name === 'Main_Dark' ? 0.62 : m.name === 'Main_Light' ? 1.18 : m.name === 'Main_Details' ? 0.35 : 0.9;
          c.diffuse = new pc.Color(Math.min(1, col[0] * shade), Math.min(1, col[1] * shade), Math.min(1, col[2] * shade));
        }
        c.update();
        cache.set(m, c);
      }
      mi.material = cache.get(m);
    }
  }
  root.addChild(e);
  const shadow = new pc.Entity('shadow');
  shadow.addComponent('render', { type: 'plane', material: mats.shadow, castShadows: false });
  root.addChild(shadow);
  const hover = new pc.Entity('hover');
  hover.addComponent('render', { type: 'plane', material: mats.hover, castShadows: false });
  root.addChild(hover);
  const shieldMat = new pc.StandardMaterial();
  shieldMat.diffuse = new pc.Color(0, 0, 0); shieldMat.emissive = new pc.Color(0.4, 0.85, 1); shieldMat.opacity = 0.3;
  shieldMat.blendType = pc.BLEND_ADDITIVE; shieldMat.depthWrite = false; shieldMat.useLighting = false; shieldMat.update();
  const shield = new pc.Entity('shield');
  shield.addComponent('render', { type: 'sphere', material: shieldMat, castShadows: false });
  shield.setLocalScale(5.2, 3.6, 5.6);
  shield.setLocalPosition(0, 1, 0);
  e.addChild(shield);
  const tag = document.createElement('div');
  tag.className = 'tag';
  tag.innerHTML = '<span></span><div class="bar"><i></i></div>';
  $('tags').appendChild(tag);
  v = {
    e, turret: e.findByName('Turret'), shadow, hover, shield, shieldMat, tag, slot, hp: C.maxHp, visible: true,
    pos: new pc.Vec3(), yaw: 0, vx: 0, vz: 0, mats: [...cache.values()], flash: 0, recoil: 0, smokeT: 0,
    grounded: true, drifting: false, charge: 0, boost: 0, boostLvl: 0, lastSpawn: -1,
  };
  tanks.set(id, v);
  return v;
}
function removeTank(id) {
  const v = tanks.get(id);
  if (!v) return;
  v.e.destroy(); v.shadow.destroy(); v.hover.destroy(); v.tag.remove();
  tanks.delete(id);
}

function placeTank(v, x, y, z, yaw, aimYaw, vx, vz, visible, invuln, time) {
  v.visible = visible;
  v.e.enabled = visible; v.shadow.enabled = visible; v.hover.enabled = visible;
  v.tag.style.display = 'none';
  if (!visible) return;
  // hover bob + bank into slides (purely cosmetic)
  const rightX = Math.cos(yaw), rightZ = -Math.sin(yaw);
  const fwdX = -Math.sin(yaw), fwdZ = -Math.cos(yaw);
  const lat = vx * rightX + vz * rightZ, lon = vx * fwdX + vz * fwdZ;
  v.roll = pc.math.lerp(v.roll || 0, clamp(-lat * 1.0, -12, 12), 0.15);
  v.pitch = pc.math.lerp(v.pitch || 0, clamp(lon * 0.25 + (v.boost > 0 ? 4 : 0), -5, 8), 0.1);
  const bob = Math.sin(time * 3.1 + v.slot) * 0.06;
  v.pos.set(x, y + bob, z);
  v.yaw = yaw; v.vx = vx; v.vz = vz;
  v.e.setPosition(v.pos);
  v.e.setEulerAngles(0, 0, 0);
  v.e.rotateLocal(0, yaw * pc.math.RAD_TO_DEG, 0);
  v.e.rotateLocal(v.pitch, 0, v.roll);
  if (v.turret) {
    v.turret.setLocalEulerAngles(0, wrapPi(aimYaw - yaw) * pc.math.RAD_TO_DEG, 0);
    if (v.turretBase === undefined) v.turretBase = v.turret.getLocalPosition().clone();
    // recoil: push the turret back along its own forward
    const rel = wrapPi(aimYaw - yaw), k = v.recoil * 0.35;
    v.turret.setLocalPosition(v.turretBase.x + Math.sin(rel) * k, v.turretBase.y, v.turretBase.z + Math.cos(rel) * k);
  }
  const gy = heightAt(world, x, z);
  const hgt = Math.max(0, y - C.hoverHeight - gy);
  const s = 4.6 * clamp(1 - hgt * 0.12, 0.45, 1);
  v.shadow.setPosition(x, gy + 0.04, z);
  v.shadow.setLocalScale(s, 1, s * 1.2);
  v.shadow.setEulerAngles(0, yaw * pc.math.RAD_TO_DEG, 0);
  const pulse = 1 + Math.sin(time * 9 + v.slot) * 0.08 + (v.boost > 0 ? 0.35 : 0);
  v.hover.setPosition(x, gy + 0.06, z);
  v.hover.setLocalScale(3.6 * pulse * clamp(1 - hgt * 0.2, 0.3, 1), 1, 4.6 * pulse * clamp(1 - hgt * 0.2, 0.3, 1));
  v.hover.setEulerAngles(0, yaw * pc.math.RAD_TO_DEG, 0);
  // spawn shield: steady bubble, blinks in its last half second
  v.shield.enabled = invuln && (v.invulnLeft > 0.5 || Math.floor(time * 12) % 2 === 0);
  if (v.shield.enabled) { v.shieldMat.opacity = 0.22 + Math.sin(time * 6) * 0.08; v.shieldMat.update(); }
}

function renderLocal(alpha) {
  if (!myId) return;
  const v = getTank(myId, mySlot);
  if (!local.alive || !local.t) { placeTank(v, 0, 0, 0, 0, 0, 0, 0, false); return; }
  const a = local.prev, b = local.t;
  const x = pc.math.lerp(a.x, b.x, alpha) + local.offset.x;
  const y = pc.math.lerp(a.y, b.y, alpha) + local.offset.y;
  const z = pc.math.lerp(a.z, b.z, alpha) + local.offset.z;
  const yaw = a.yaw + wrapPi(b.yaw - a.yaw) * alpha;
  v.boost = b.boost; v.boostLvl = b.boostLvl; v.charge = b.charge; v.drifting = local.sliding; v.invulnLeft = local.invulnLeft;
  if (v.lastSpawn !== local.spawnId) { v.lastSpawn = local.spawnId; fx.respawnBeam(x, y - C.hoverHeight, z, mats.slotGlow[mySlot % 4]); }
  v.hp = local.hp;
  placeTank(v, x, y, z, yaw, camYaw, b.vx, b.vz, true, local.invuln, performance.now() / 1000);
}

function bracket(rt) {
  if (!snaps.length) return null;
  let a = snaps[0], b = snaps[0];
  for (let i = 0; i < snaps.length; i++) {
    if (snaps[i].k <= rt) a = snaps[i];
    if (snaps[i].k > rt) { b = snaps[i]; break; }
    b = snaps[i];
  }
  const span = b.k - a.k;
  return { a, b, f: span > 0 ? clamp((rt - a.k) / span, 0, 1) : 0 };
}

function renderRemote(rt) {
  const br = bracket(rt);
  if (!br) return;
  const { a, b, f } = br;
  const now = performance.now() / 1000;
  for (const [id, pb] of b.players) {
    if (id === myId) continue;
    const pa = a.players.get(id) || pb;
    const r = roster.get(id);
    if (!r) continue;                       // wait for the roster so the colour is right
    if (tanks.get(id) && tanks.get(id).slot !== r.slot) removeTank(id);
    const v = getTank(id, r.slot);
    const vis = pa.alive && pb.alive && pa.connected && pa.spawnId === pb.spawnId;
    const x = pc.math.lerp(pa.x, pb.x, f), y = pc.math.lerp(pa.y, pb.y, f), z = pc.math.lerp(pa.z, pb.z, f);
    const yaw = pa.yaw + wrapPi(pb.yaw - pa.yaw) * f;
    const ay = pa.ay + wrapPi(pb.ay - pa.ay) * f;
    const src = f < 0.5 ? pa : pb;
    v.boost = src.boost; v.boostLvl = src.boostLvl; v.charge = src.charge; v.invulnLeft = src.invulnLeft;
    // derive cosmetic state changes (jump / land / slide / respawn) from the interpolated stream
    if (vis) {
      if (v.lastSpawn !== pa.spawnId) { v.lastSpawn = pa.spawnId; fx.respawnBeam(x, y - C.hoverHeight, z, mats.slotGlow[r.slot % 4]); }
      else if (v.grounded && !src.grounded) fx.jumpRing(x, y - C.hoverHeight, z);
      else if (!v.grounded && src.grounded) fx.landRing(x, y - C.hoverHeight, z, 0.8);
      const lat = Math.abs(src.vx * Math.cos(yaw) - src.vz * Math.sin(yaw));
      v.drifting = src.drifting && src.grounded && Math.hypot(src.vx, src.vz) > C.driftMinSpeed && lat > C.driftMinSlide;
    }
    v.grounded = src.grounded;
    placeTank(v, x, y, z, yaw, ay, pb.vx, pb.vz, vis, pb.invuln, now);
    v.hp = pb.hp;
    v.name = r?.name || '';
  }
  for (const id of tanks.keys()) if (id !== myId && !b.players.has(id)) removeTank(id);

  // remote shells: rendered at the same (past) time as the tanks that fired them
  const used = new Set();
  for (const s of a.shells) {
    if (s.owner === myId) continue;
    const dt = (rt - a.k) * DT;
    const px = s.x + s.vx * dt, py = s.y + s.vy * dt - 0.5 * C.shellGravity * dt * dt, pz = s.z + s.vz * dt;
    if (!seenShells.has(s.id)) {
      seenShells.add(s.id);
      const sp = Math.hypot(s.vx, s.vy, s.vz) || 1;
      fx.muzzle(px, py, pz, s.vx / sp, s.vy / sp, s.vz / sp);
      const ov = tanks.get(s.owner); if (ov) ov.recoil = 1;
      if (seenShells.size > 300) seenShells.clear();
    }
    drawShell(`r${s.id}`, px, py, pz, s.vx, s.vy - C.shellGravity * dt, s.vz);
    used.add(`r${s.id}`);
  }
  for (const [key, e] of shellEnts) if (key[0] === 'r' && !used.has(key)) freeShell(key, e);
}

function flushEvents(rt) {
  while (pendingEvents.length && pendingEvents[0].k <= rt + 0.5) {
    const { e } = pendingEvents.shift();
    if (e.t === 'boom') { if (e.o !== myId) fx.explosion(e.x, e.y, e.z, 1.6); }
    else if (e.t === 'hit') {
      fx.hitSpark(e.x, e.y, e.z);
      const v = tanks.get(e.v); if (v) v.flash = 1;
      if (e.o === myId) killLocalShell(e.q, false);
    } else if (e.t === 'shield') { fx.shieldSpark(e.x, e.y, e.z); if (e.o === myId) killLocalShell(e.q, false); }
    else if (e.t === 'healspawn') fx.healSpawn(HEAL_POS.x, HEAL_POS.y, HEAL_POS.z);
    else if (e.t === 'heal') {
      fx.healBurst(HEAL_POS.x, HEAL_POS.y + 1.4, HEAL_POS.z);
      const v = tanks.get(e.v); if (v) v.healFlash = 1;
      if (e.v !== myId) notice(`${escapeHtml(nameOf(e.v))} が回復した`);
    } else if (e.t === 'boost') {
      if (e.v !== myId) { const v = tanks.get(e.v); if (v && v.visible) fx.boostBurst(v.pos.x, v.pos.y - C.hoverHeight, v.pos.z, v.yaw, e.l); }
    } else if (e.t === 'kill') {
      const slot = roster.get(e.v)?.slot ?? 0;
      fx.bigKill(e.x, e.y, e.z, mats.slotLit[slot % 4]);
      feed(e.k, e.v);
      if (e.v === myId) centerFlash('撃破された…', 1800);
      else if (e.k === myId) { centerFlash('撃破！', 1200, true); fx.addShake(0.3); }
    }
  }
}

// per-frame cosmetic effects on every visible tank
let smokeClock = 0;
function tankFx(dt) {
  smokeClock += dt;
  for (const [id, v] of tanks) {
    v.recoil = Math.max(0, v.recoil - dt * 6);
    if (v.flash > 0 || v.healFlash > 0) {
      v.flash = Math.max(0, v.flash - dt * 6);
      v.healFlash = Math.max(0, (v.healFlash || 0) - dt * 2);
      const f = v.flash, g = v.healFlash * 0.7;
      for (const m of v.mats) { m.emissive = new pc.Color(f + g * 0.3, f * 0.45 + g, f * 0.25 + g * 0.35); m.update(); }
    }
    if (!v.visible) continue;
    const gy = heightAt(world, v.pos.x, v.pos.z);
    if (v.drifting && v.pos.y - C.hoverHeight - gy < 0.3) fx.driftSparks(v.pos.x, gy, v.pos.z, v.yaw, v.charge >= C.charge2 ? 2 : v.charge >= C.charge1 ? 1 : 0);
    if (v.boost > 0) fx.exhaust(v.pos.x, v.pos.y - C.hoverHeight, v.pos.z, v.yaw, v.boostLvl);
    v.smokeT -= dt;
    if (v.hp <= 67 && v.smokeT <= 0) { fx.damageSmoke(v.pos.x, v.pos.y - C.hoverHeight, v.pos.z, v.hp <= 34); v.smokeT = v.hp <= 34 ? 0.1 / fx.scale : 0.35 / fx.scale; }
    if (id === myId) fx.listener = v.pos;
  }
}

// ------------------------------------------------------------------ camera & aim
function updateCamera(dt) {
  const v = tanks.get(myId);
  let px, py, pz;
  if (local.alive && v) { px = v.pos.x; py = v.pos.y; pz = v.pos.z; }
  else { const p = camera.getPosition(); px = p.x; py = p.y - 2; pz = p.z; }
  const cp = Math.cos(camPitch);
  const fx0 = -Math.sin(camYaw) * cp, fy = Math.sin(camPitch), fz0 = -Math.cos(camYaw) * cp;
  const pivot = new pc.Vec3(px, py + CAM_PIVOT, pz);
  fovKick *= Math.exp(-2.5 * dt);
  camera.camera.fov = BASE_FOV + fovKick + (local.t && local.t.boost > 0 ? 4 : 0);
  if (local.alive) {
    // pull the camera in when terrain/walls/cover would block it
    let want = CAM_DIST;
    for (let d = 0.5; d <= CAM_DIST; d += 0.25) {
      const x = pivot.x - fx0 * d, y = pivot.y - fy * d + CAM_LIFT * (d / CAM_DIST), z = pivot.z - fz0 * d;
      if (heightAt(world, x, z) + 0.45 > y || Math.abs(x) > PIT_HALF + 3 || Math.abs(z) > PIT_HALF + 3) { want = Math.max(1.2, d - 0.4); break; }
    }
    camDistNow = want < camDistNow ? want : pc.math.lerp(camDistNow, want, 1 - Math.exp(-4 * dt));
    const d = camDistNow;
    const sh = fx.shake * 0.35;
    const jx = (Math.random() - 0.5) * sh, jy = (Math.random() - 0.5) * sh, jz = (Math.random() - 0.5) * sh;
    camera.setPosition(pivot.x - fx0 * d + jx, pivot.y - fy * d + CAM_LIFT * (d / CAM_DIST) + jy, pivot.z - fz0 * d + jz);
    camera.lookAt(pivot.x + fx0 * 40 + jx * 3, pivot.y + fy * 40 + jy * 3, pivot.z + fz0 * 40 + jz * 3);
  }
}

function computeAimPoint() {
  const o = camera.getPosition(), f = camera.forward;
  let best = 160;
  for (const [id, v] of tanks) {
    if (id === myId || !v.visible) continue;
    const cx = v.pos.x - o.x, cy = v.pos.y + C.hitCenterY - o.y, cz = v.pos.z - o.z;
    const tca = cx * f.x + cy * f.y + cz * f.z;
    if (tca < 0) continue;
    const d2 = cx * cx + cy * cy + cz * cz - tca * tca, r = C.hitRadius * 0.85;
    if (d2 > r * r) continue;
    const hit = tca - Math.sqrt(r * r - d2);
    if (hit < best && hit > camDistNow) best = hit;
  }
  for (let d = camDistNow + 1; d < best; d += 0.5) {
    const x = o.x + f.x * d, y = o.y + f.y * d, z = o.z + f.z * d;
    if (y <= heightAt(world, x, z)) { best = d; break; }
  }
  aimPoint.set(o.x + f.x * best, o.y + f.y * best, o.z + f.z * best);
}

function lineOfSight(ax, ay, az, bx, by, bz) {
  const d = Math.hypot(bx - ax, by - ay, bz - az);
  for (let s = 1; s < d - 1; s += 0.75) {
    const k = s / d;
    if (ay + (by - ay) * k < heightAt(world, ax + (bx - ax) * k, az + (bz - az) * k)) return false;
  }
  return true;
}

function lobbyCamera() {
  const t = performance.now() / 1000 * 0.08;
  camera.setPosition(Math.sin(t) * PIT_HALF * 1.1, 26, Math.cos(t) * PIT_HALF * 1.1);
  camera.lookAt(0, 2, 0);
}

// ------------------------------------------------------------------ shells
const shellEnts = new Map(), shellPool = [];
function drawShell(key, x, y, z, vx, vy, vz) {
  let e = shellEnts.get(key);
  if (!e) {
    e = shellPool.pop();
    if (!e) {
      e = new pc.Entity('shell');
      e.addComponent('render', { type: 'box', material: fx.m.shell, castShadows: false });
      const core = new pc.Entity('core');
      core.addComponent('render', { type: 'sphere', material: fx.m.shellCore, castShadows: false });
      core.setLocalScale(1.5, 1.5, 0.45);
      e.addChild(core);
      root.addChild(e);
    }
    e.enabled = true;
    shellEnts.set(key, e);
  }
  e.setPosition(x, y, z);
  const sp = Math.hypot(vx, vy, vz) || 1;
  e.lookAt(x + vx / sp, y + vy / sp, z + vz / sp);
  e.setLocalScale(0.28, 0.28, 1.9);
  fx.trail(x, y, z, false);
}
function freeShell(key, e) { e.enabled = false; shellEnts.delete(key); shellPool.push(e); }

function fireLocalShell(t) {
  const m = muzzle(t);
  localShells.push({ seq: t.shotSeq, ...m, px: m.x, py: m.y, pz: m.z, life: C.shellLife, acc: 0 });
  const sp = Math.hypot(m.vx, m.vy, m.vz);
  fx.muzzle(m.x, m.y, m.z, m.vx / sp, m.vy / sp, m.vz / sp);
  const v = tanks.get(myId); if (v) v.recoil = 1;
}
function killLocalShell(q, boom = true) {
  const i = localShells.findIndex((s) => s.seq === q);
  if (i < 0) return;
  const s = localShells[i];
  if (boom) fx.explosion(s.x, s.y, s.z, 1.6);
  const key = `l${s.seq}`; const e = shellEnts.get(key);
  if (e) freeShell(key, e);
  localShells.splice(i, 1);
}
function updateLocalShells(dt) {
  for (let i = localShells.length - 1; i >= 0; i--) {
    const s = localShells[i];
    s.acc += dt;
    let dead = false;
    while (s.acc >= DT && !dead) {
      s.acc -= DT;
      const { hitGround } = stepShell(s, world);
      if (hitGround || s.life <= 0) { dead = true; if (hitGround) fx.explosion(s.x, s.y, s.z, 1.6); break; }
      for (const [id, v] of tanks) {   // visual-only hit; the server decides damage
        if (id === myId || !v.visible) continue;
        if (segmentHitsTank(s, { x: v.pos.x, y: v.pos.y, z: v.pos.z })) { dead = true; break; }
      }
    }
    if (dead) { killLocalShell(s.seq, false); continue; }
    const f = s.acc / DT;
    drawShell(`l${s.seq}`, s.x + s.vx * DT * f, s.y + s.vy * DT * f, s.z + s.vz * DT * f, s.vx, s.vy, s.vz);
  }
}

// ------------------------------------------------------------------ HUD
function colorCss(slot) { const c = PLAYER_COLORS[slot % 4]; return `rgb(${c.map((v) => Math.round(v * 255)).join(',')})`; }
function nameOf(id) { const r = roster.get(id); return r ? r.name : '???'; }
let lastScores = new Map();
function updateBoardScores(s) {
  lastScores = new Map([...s.players].map(([id, p]) => [id, p.kills]));
  updateBoard();
}
function updateBoard() {
  const rows = [...roster.values()].sort((a, b) => (lastScores.get(b.id) || 0) - (lastScores.get(a.id) || 0));
  const html = rows.map((r) => `<div class="${r.id === myId ? 'me' : ''} ${r.connected ? '' : 'off'}"><span class="dot" style="background:${colorCss(r.slot)}"></span>${escapeHtml(r.name)} <b>${lastScores.get(r.id) || 0}</b>${r.connected ? '' : ' (切断中)'}</div>`).join('');
  if ($('board').innerHTML !== html) $('board').innerHTML = html;
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function feed(k, v) {
  const d = document.createElement('div');
  const rk = roster.get(k), rv = roster.get(v);
  d.innerHTML = `<span style="color:${colorCss(rk?.slot ?? 0)}">${escapeHtml(nameOf(k))}</span> ▶ <span style="color:${colorCss(rv?.slot ?? 0)}">${escapeHtml(nameOf(v))}</span>`;
  $('feed').prepend(d);
  setTimeout(() => d.remove(), 5000);
  while ($('feed').children.length > 5) $('feed').lastChild.remove();
}
let centerUntil = 0;
function centerFlash(text, ms, big) {
  const el = $('center-msg');
  el.textContent = text; centerUntil = performance.now() + ms;
  el.classList.remove('pop'); void el.offsetWidth; if (big) el.classList.add('pop');
}
function flashHitmark() { const h = $('hitmark'); h.classList.add('on'); setTimeout(() => h.classList.remove('on'), 60); }
function flashHeal() { const h = $('hpwrap'); h.classList.add('healed'); setTimeout(() => h.classList.remove('healed'), 700); }
let noticeTimer = 0;
function notice(html) { const n = $('notice'); n.innerHTML = html; n.classList.add('on'); clearTimeout(noticeTimer); noticeTimer = setTimeout(() => n.classList.remove('on'), 2600); }
function flashDamage() { const h = $('damage'); h.classList.add('on'); setTimeout(() => h.classList.remove('on'), 80); }
function showResult(list) {
  const ol = $('result-list');
  ol.innerHTML = list.map((p) => `<li><span class="dot" style="background:${colorCss(p.slot)}"></span>${escapeHtml(p.name)} — ${p.kills} 撃破 / ${p.deaths} 被撃破</li>`).join('');
  $('result-next').textContent = '10秒後に次の試合が始まります';
  $('result').classList.remove('hidden');
  document.exitPointerLock?.();
}
let hudT = 0;
function updateHud(dt) {
  hudT += dt;
  $('hpbar').style.width = `${local.hp}%`;
  $('hptext').textContent = String(local.hp);
  // drift charge gauge: fills while sliding, blue = boost level 1, orange = level 2
  const t = local.t;
  const ch = local.alive && t ? t.charge : 0;
  const g = $('drift');
  g.classList.toggle('show', ch > 0.05 || (t && t.boost > 0));
  $('drift-fill').style.width = `${Math.min(100, (ch / C.charge2) * 100)}%`;
  g.dataset.lvl = ch >= C.charge2 ? '2' : ch >= C.charge1 ? '1' : '0';
  $('shield-msg').classList.toggle('hidden', !(local.alive && local.invuln));
  if (local.alive && local.invuln) $('shield-msg').textContent = `無敵 ${local.invulnLeft.toFixed(1)}秒（撃つと解除）`;
  if (performance.now() > centerUntil) {
    let msg = '';
    if (!local.alive && myId && phase === 'play') msg = `リスポーンまで ${local.respawnIn.toFixed(1)} 秒`;
    else if (!input.touchMode && document.pointerLockElement !== $('game') && $('settings').classList.contains('hidden') && $('invite').classList.contains('hidden') && phase === 'play') msg = 'クリックで操作開始';
    $('center-msg').textContent = msg;
    $('center-msg').classList.remove('pop');
  }
  if (hudT > 0.5) {
    hudT = 0;
    $('fps').textContent = `${Math.round(fpsSmooth)} fps`;
    $('net').textContent = `${Math.round(ping)} ms`;
  }
}
function updateTags() {
  const tmp = new pc.Vec3();
  const w = app.graphicsDevice.clientRect?.width || window.innerWidth;
  const h = app.graphicsDevice.clientRect?.height || window.innerHeight;
  const o = camera.getPosition();
  for (const [id, v] of tanks) {
    if (id === myId || !v.visible) continue;
    camera.camera.worldToScreen(new pc.Vec3(v.pos.x, v.pos.y + 3.1, v.pos.z), tmp);
    if (tmp.z < 0 || tmp.x < 0 || tmp.y < 0 || tmp.x > w || tmp.y > h) continue;
    if (!lineOfSight(o.x, o.y, o.z, v.pos.x, v.pos.y + 1.6, v.pos.z)) continue;   // no name tags through cover
    v.tag.style.display = 'block';
    v.tag.style.left = `${tmp.x}px`; v.tag.style.top = `${tmp.y}px`;
    v.tag.firstChild.textContent = v.name || '';
    v.tag.firstChild.style.color = colorCss(v.slot);
    v.tag.querySelector('i').style.width = `${v.hp}%`;
  }
}
