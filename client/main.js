import * as pc from 'playcanvas';
import { Room, createRoom, roomInfo } from './net.js';
import {
  C, DT, makeWorld, heightAt, newTank, stepTank, muzzle, stepShell, segmentHitsTank, wrapPi, clamp,
} from '../shared/sim.js';
import { PLAYER_COLORS, PLAYER_COLOR_NAMES, RECONNECT_SECONDS } from '../shared/arena.js';
import { Input } from './input.js';

// ------------------------------------------------------------------ config
const ENDPOINT = location.origin;   // the Worker serves both the page and /api
const INTERP_TICKS = 3.5;          // remote entities are rendered ~115 ms in the past
const CAM_DIST = 8.5, CAM_PIVOT = 2.3, CAM_LIFT = 0.9;
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
let app, device, world, tankAsset, camera, root;
let input;
let room = null, myId = null, mySlot = 0, phase = 'play';
const roster = new Map();         // id -> {name, slot, connected}
const tanks = new Map();          // id -> visual
const snaps = [];                 // parsed snapshots (ascending k)
let serverTick = null;            // estimated current server tick (float)
const pendingEvents = [];
let camYaw = 0, camPitch = 0.05, camDistNow = CAM_DIST;
let aimPoint = new pc.Vec3();
let acc = 0, seq = 0;
const local = { t: null, prev: null, alive: false, spawnId: -1, pending: [], offset: new pc.Vec3(), hp: C.maxHp, invuln: false, respawnIn: 0 };
const localShells = [];
let ping = 0, fpsSmooth = 60;
const stats = { corrections: 0, bigCorrections: 0 };
window.__ht = { stats, local, snaps, setCam: DEBUG ? (y, p) => { camYaw = y; camPitch = p; } : undefined, get aim() { return aimPoint; }, get room() { return room; }, get fps() { return fpsSmooth; }, get ping() { return ping; } };

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
  applyQuality(store.get('ht-quality') || (document.body.classList.contains('touch') ? 'mid' : 'high'));
  window.addEventListener('resize', () => app.resizeCanvas());
  app.scene.ambientLight = new pc.Color(0.52, 0.47, 0.42);
  app.scene.exposure = 1.0;

  root = new pc.Entity('root');
  app.root.addChild(root);
  camera = new pc.Entity('camera');
  camera.addComponent('camera', { clearColor: new pc.Color(0.78, 0.66, 0.50), fov: 62, nearClip: 0.2, farClip: 300 });
  app.root.addChild(camera);
  const sun = new pc.Entity('sun');
  sun.addComponent('light', { type: 'directional', color: new pc.Color(1, 0.94, 0.84), intensity: 1.15, castShadows: false });
  sun.setEulerAngles(52, 35, 0);
  app.root.addChild(sun);

  // world: heightfield + meshes
  const base = import.meta.env.BASE_URL;
  const [meta, hf] = await Promise.all([
    fetch(`${base}assets/arena_hf.json`).then((r) => r.json()),
    fetch(`${base}assets/arena_hf.bin`).then((r) => r.arrayBuffer()),
  ]);
  world = makeWorld(meta, new Float32Array(hf));
  const [arena, tank] = await Promise.all([loadContainer(`${base}assets/arena.glb`), loadContainer(`${base}assets/tank.glb`)]);
  tankAsset = tank;
  const arenaEnt = arena.resource.instantiateRenderEntity();
  root.addChild(arenaEnt);
  makeFxResources();

  input = new Input(canvas, {
    touchLayer: $('touch-layer'), stickBase: $('stick-base'), stickKnob: $('stick-knob'),
    btnFire: $('btn-fire'), btnJump: $('btn-jump'), btnDrift: $('btn-drift'),
    onPointerLock: (locked) => { $('pc-help').style.opacity = locked ? '0.35' : '0.9'; },
  });
  input.enabled = false;
  const sens = parseFloat(store.get('ht-sens') || '1');
  $('sens').value = String(sens); setSens(sens);

  // idle camera orbit for the lobby
  camera.setPosition(30, 18, 30); camera.lookAt(0, 0, 0);
  app.on('update', update);
  app.start();
}

function loadContainer(url) {
  return new Promise((resolve, reject) => {
    app.assets.loadFromUrl(url, 'container', (err, asset) => (err ? reject(err) : resolve(asset)));
  });
}

// ------------------------------------------------------------------ quality & settings
function applyQuality(q) {
  const dpr = window.devicePixelRatio || 1;
  device.maxPixelRatio = q === 'low' ? Math.min(dpr, 1) * 0.6 : q === 'mid' ? Math.min(dpr, 1.25) : Math.min(dpr, 2);
  app?.resizeCanvas();
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
      hp: a[10], alive: !!(a[11] & 1), grounded: !!(a[11] & 2), invuln: !!(a[11] & 4), connected: !!(a[11] & 8),
      lastSeq: a[12], cooldown: a[13], shotSeq: a[14], kills: a[15], deaths: a[16], spawnId: a[17], respawnIn: a[18],
    });
  }
  const shells = m.b.map((b) => ({ id: b[0], owner: b[1], seq: b[2], x: b[3], y: b[4], z: b[5], vx: b[6], vy: b[7], vz: b[8] }));
  return { k: m.k, ph: m.ph, tl: m.tl, players, shells };
}

function onSnapshot(m) {
  const s = parseSnap(m);
  snaps.push(s);
  while (snaps.length > 40) snaps.shift();
  if (serverTick === null || Math.abs(serverTick - s.k) > 15) serverTick = s.k;
  else serverTick += (s.k - serverTick) * 0.08;
  for (const e of m.e) {
    if (e.t === 'hit' && e.o === myId) flashHitmark();
    if (e.t === 'hit' && e.v === myId) flashDamage();
    pendingEvents.push({ k: s.k, e });
  }
  if (phase !== s.ph) { phase = s.ph; if (phase === 'play') $('result').classList.add('hidden'); }
  $('timer').textContent = `${Math.floor(s.tl / 60)}:${String(s.tl % 60).padStart(2, '0')}`;
  updateBoardScores(s);

  const me = s.players.get(myId);
  if (!me) return;
  local.hp = me.hp; local.invuln = me.invuln; local.respawnIn = me.respawnIn;
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
  Object.assign(t, { y: p.y, vx: p.vx, vy: p.vy, vz: p.vz, aimYaw: p.ay, aimPitch: p.ap, grounded: p.grounded, cooldown: p.cooldown, shotSeq: p.shotSeq });
  return t;
}

// ------------------------------------------------------------------ per-frame update
function update(dt) {
  dt = Math.min(dt, 0.1);
  fpsSmooth = fpsSmooth * 0.95 + (1 / Math.max(dt, 1e-4)) * 0.05;
  if (!room || !myId) { lobbyCamera(dt); return; }

  // look
  const [lx, ly] = input.takeLook();
  camYaw = wrapPi(camYaw - lx);
  camPitch = clamp(camPitch - ly, -0.55, 0.62);

  // fixed-rate simulation ticks
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
  updateCamera(dt, alpha);
  computeAimPoint();
  updateLocalShells(dt);
  updateFx(dt);
  updateTags();
  updateHud(dt);
}

function tick() {
  const s = input.sample();
  const fx = -Math.sin(camYaw), fz = -Math.cos(camYaw), rx = Math.cos(camYaw), rz = -Math.sin(camYaw);
  const mx = rx * s.mx + fx * s.my, mz = rz * s.mx + fz * s.my;
  let ay = camYaw, ap = 0;
  if (local.t) [ay, ap] = solveAim(local.t, aimPoint);
  const inp = { seq: ++seq, mx: r3(mx), mz: r3(mz), ay: r3(ay), ap: r3(ap), j: s.jump, d: s.drift, f: s.fire && phase === 'play' };
  if (local.alive && local.t) {
    local.prev = { ...local.t };
    const ev = stepTank(local.t, inp, world);
    if (ev.fired) fireLocalShell(local.t);
    if (ev.landed) spawnDust(local.t.x, local.t.y - C.hoverHeight, local.t.z, 6, 1.2);
    if (ev.jumped) spawnDust(local.t.x, local.t.y - C.hoverHeight, local.t.z, 4, 0.8);
    if (s.drift && local.t.grounded && Math.hypot(local.t.vx, local.t.vz) > 7 && seq % 3 === 0) spawnDust(local.t.x, local.t.y - C.hoverHeight, local.t.z, 1, 0.6);
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
      if (!/^Main/.test(m.name)) continue;
      if (!cache.has(m)) {
        const c = m.clone();
        const shade = m.name === 'Main_Dark' ? 0.62 : m.name === 'Main_Light' ? 1.18 : m.name === 'Main_Details' ? 0.35 : 0.9;
        c.diffuse = new pc.Color(Math.min(1, col[0] * shade), Math.min(1, col[1] * shade), Math.min(1, col[2] * shade));
        c.update();
        cache.set(m, c);
      }
      mi.material = cache.get(m);
    }
  }
  root.addChild(e);
  const shadow = new pc.Entity('shadow');
  shadow.addComponent('render', { type: 'plane', material: fx.shadowMat, castShadows: false });
  shadow.setLocalScale(4.6, 1, 4.6);
  root.addChild(shadow);
  const shield = new pc.Entity('shield');
  shield.addComponent('render', { type: 'sphere', material: fx.shieldMat, castShadows: false });
  shield.setLocalScale(5, 3.4, 5);
  shield.setLocalPosition(0, 1, 0);
  e.addChild(shield);
  const tag = document.createElement('div');
  tag.className = 'tag';
  tag.innerHTML = '<span></span><div class="bar"><i></i></div>';
  $('tags').appendChild(tag);
  v = { e, turret: e.findByName('Turret'), shadow, shield, tag, slot, hp: C.maxHp, visible: true, pos: new pc.Vec3() };
  tanks.set(id, v);
  return v;
}
function removeTank(id) {
  const v = tanks.get(id);
  if (!v) return;
  v.e.destroy(); v.shadow.destroy(); v.tag.remove();
  tanks.delete(id);
}

function placeTank(v, x, y, z, yaw, aimYaw, vx, vz, visible, invuln, time) {
  v.visible = visible;
  v.e.enabled = visible; v.shadow.enabled = visible;
  v.tag.style.display = 'none';
  if (!visible) return;
  // hover bob + bank into slides (purely cosmetic)
  const rightX = Math.cos(yaw), rightZ = -Math.sin(yaw);
  const fwdX = -Math.sin(yaw), fwdZ = -Math.cos(yaw);
  const lat = vx * rightX + vz * rightZ, lon = vx * fwdX + vz * fwdZ;
  v.roll = pc.math.lerp(v.roll || 0, clamp(-lat * 1.0, -10, 10), 0.15);
  v.pitch = pc.math.lerp(v.pitch || 0, clamp(lon * 0.25, -5, 5), 0.1);
  const bob = Math.sin(time * 3.1 + v.slot) * 0.06;
  v.pos.set(x, y + bob, z);
  v.e.setPosition(v.pos);
  v.e.setEulerAngles(0, 0, 0);
  v.e.rotateLocal(0, yaw * pc.math.RAD_TO_DEG, 0);
  v.e.rotateLocal(v.pitch, 0, v.roll);
  if (v.turret) v.turret.setLocalEulerAngles(0, wrapPi(aimYaw - yaw) * pc.math.RAD_TO_DEG, 0);
  const gy = heightAt(world, x, z);
  const hgt = Math.max(0, y - C.hoverHeight - gy);
  const s = 4.6 * clamp(1 - hgt * 0.12, 0.45, 1);
  v.shadow.setPosition(x, gy + 0.04, z);
  v.shadow.setLocalScale(s, 1, s * 1.2);
  v.shadow.setEulerAngles(0, yaw * pc.math.RAD_TO_DEG, 0);
  v.shield.enabled = invuln && Math.floor(time * 10) % 2 === 0;
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
    const e = shellEntity(`r${s.id}`);
    e.setPosition(s.x + s.vx * dt, s.y + s.vy * dt - 0.5 * C.shellGravity * dt * dt, s.z + s.vz * dt);
    used.add(`r${s.id}`);
  }
  for (const [key, e] of fx.shellEnts) if (key[0] === 'r' && !used.has(key)) { e.enabled = false; fx.shellEnts.delete(key); fx.shellPool.push(e); }
}

function flushEvents(rt) {
  while (pendingEvents.length && pendingEvents[0].k <= rt + 0.5) {
    const { e } = pendingEvents.shift();
    if (e.t === 'boom') { if (e.o !== myId) explosion(e.x, e.y, e.z, 1.6); }
    else if (e.t === 'hit') { explosion(e.x, e.y, e.z, 2.2); if (e.o === myId) killLocalShell(e.q, false); }
    else if (e.t === 'shield') { spark(e.x, e.y, e.z); if (e.o === myId) killLocalShell(e.q, false); }
    else if (e.t === 'kill') {
      explosion(e.x, e.y + 1, e.z, 4.5);
      feed(e.k, e.v);
      if (e.v === myId) centerFlash(`撃破された…`, 1800);
      else if (e.k === myId) centerFlash(`撃破！`, 1200);
    }
  }
}

// ------------------------------------------------------------------ camera & aim
function updateCamera(dt) {
  const v = tanks.get(myId);
  let px, py, pz;
  if (local.alive && v) { px = v.pos.x; py = v.pos.y; pz = v.pos.z; }
  else { const p = camera.getPosition(); px = p.x; py = p.y - 2; pz = p.z; }
  const cp = Math.cos(camPitch);
  const fx = -Math.sin(camYaw) * cp, fy = Math.sin(camPitch), fz = -Math.cos(camYaw) * cp;
  const pivot = new pc.Vec3(px, py + CAM_PIVOT, pz);
  if (local.alive) {
    // pull the camera in when terrain/walls would block it
    let want = CAM_DIST;
    for (let d = 0.5; d <= CAM_DIST; d += 0.25) {
      const x = pivot.x - fx * d, y = pivot.y - fy * d + CAM_LIFT * (d / CAM_DIST), z = pivot.z - fz * d;
      if (heightAt(world, x, z) + 0.45 > y || Math.abs(x) > 33 || Math.abs(z) > 33) { want = Math.max(1.2, d - 0.4); break; }
    }
    camDistNow = want < camDistNow ? want : pc.math.lerp(camDistNow, want, 1 - Math.exp(-4 * dt));
    const d = camDistNow;
    camera.setPosition(pivot.x - fx * d, pivot.y - fy * d + CAM_LIFT * (d / CAM_DIST), pivot.z - fz * d);
    camera.lookAt(pivot.x + fx * 40, pivot.y + fy * 40, pivot.z + fz * 40);
  }
}

function computeAimPoint() {
  const o = camera.getPosition(), f = camera.forward;
  let best = 160;
  // remote tanks
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
  // terrain (march)
  for (let d = camDistNow + 1; d < best; d += 0.75) {
    const x = o.x + f.x * d, y = o.y + f.y * d, z = o.z + f.z * d;
    if (y <= heightAt(world, x, z)) { best = d; break; }
  }
  aimPoint.set(o.x + f.x * best, o.y + f.y * best, o.z + f.z * best);
}

function lobbyCamera(dt) {
  const t = performance.now() / 1000 * 0.08;
  camera.setPosition(Math.sin(t) * 34, 20, Math.cos(t) * 34);
  camera.lookAt(0, 2, 0);
}

// ------------------------------------------------------------------ shells & fx
const fx = { shellPool: [], shellEnts: new Map(), puffs: [], puffPool: [] };
function makeFxResources() {
  const mat = (r, g, b, emissive = true) => {
    const m = new pc.StandardMaterial();
    if (emissive) { m.emissive = new pc.Color(r, g, b); m.diffuse = new pc.Color(0, 0, 0); m.useLighting = false; } else m.diffuse = new pc.Color(r, g, b);
    m.update(); return m;
  };
  fx.shellMat = mat(1, 0.75, 0.3);
  fx.fireMat = mat(1, 0.55, 0.15);
  fx.dustMat = mat(0.80, 0.66, 0.48);
  fx.sparkMat = mat(0.5, 0.85, 1);
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
  fx.shadowMat = sm;
  const sh = new pc.StandardMaterial();
  sh.emissive = new pc.Color(0.4, 0.8, 1); sh.diffuse = new pc.Color(0, 0, 0); sh.opacity = 0.22;
  sh.blendType = pc.BLEND_ADDITIVE; sh.depthWrite = false; sh.useLighting = false; sh.update();
  fx.shieldMat = sh;
}
function shellEntity(key) {
  let e = fx.shellEnts.get(key);
  if (e) return e;
  e = fx.shellPool.pop();
  if (!e) { e = new pc.Entity('shell'); e.addComponent('render', { type: 'sphere', material: fx.shellMat, castShadows: false }); e.setLocalScale(0.55, 0.55, 0.55); root.addChild(e); }
  e.enabled = true;
  fx.shellEnts.set(key, e);
  return e;
}
function fireLocalShell(t) {
  const m = muzzle(t);
  localShells.push({ seq: t.shotSeq, ...m, px: m.x, py: m.y, pz: m.z, life: C.shellLife, acc: 0 });
  puff(m.x, m.y, m.z, fx.fireMat, 1.1, 0.12);
}
function killLocalShell(q, boom = true) {
  const i = localShells.findIndex((s) => s.seq === q);
  if (i < 0) return;
  const s = localShells[i];
  if (boom) explosion(s.x, s.y, s.z, 1.6);
  const key = `l${s.seq}`; const e = fx.shellEnts.get(key);
  if (e) { e.enabled = false; fx.shellEnts.delete(key); fx.shellPool.push(e); }
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
      if (hitGround || s.life <= 0) { dead = true; if (hitGround) explosion(s.x, s.y, s.z, 1.6); break; }
      for (const [id, v] of tanks) {   // visual-only hit; the server decides damage
        if (id === myId || !v.visible) continue;
        if (segmentHitsTank(s, { x: v.pos.x, y: v.pos.y, z: v.pos.z })) { dead = true; break; }
      }
    }
    if (dead) { killLocalShell(s.seq, false); continue; }
    // draw between ticks
    const f = s.acc / DT;
    shellEntity(`l${s.seq}`).setPosition(s.x + s.vx * DT * f, s.y + s.vy * DT * f, s.z + s.vz * DT * f);
  }
}
function puff(x, y, z, mat, size, life) {
  let e = fx.puffPool.pop();
  if (!e) { e = new pc.Entity('puff'); e.addComponent('render', { type: 'sphere', castShadows: false }); root.addChild(e); }
  e.render.material = mat; e.enabled = true; e.setPosition(x, y, z); e.setLocalScale(0.01, 0.01, 0.01);
  fx.puffs.push({ e, t: 0, life, size });
  if (fx.puffs.length > 60) { const p = fx.puffs.shift(); p.e.enabled = false; fx.puffPool.push(p.e); }
}
function explosion(x, y, z, size) { puff(x, y, z, fx.fireMat, size, 0.32); puff(x, y + 0.3, z, fx.dustMat, size * 1.3, 0.6); }
function spark(x, y, z) { puff(x, y, z, fx.sparkMat, 1.4, 0.2); }
function spawnDust(x, y, z, n, size) {
  for (let i = 0; i < n; i++) puff(x + (Math.random() - 0.5) * 3, y + 0.2, z + (Math.random() - 0.5) * 3, fx.dustMat, size * (0.7 + Math.random() * 0.6), 0.5);
}
function updateFx(dt) {
  for (let i = fx.puffs.length - 1; i >= 0; i--) {
    const p = fx.puffs[i];
    p.t += dt;
    const k = p.t / p.life;
    if (k >= 1) { p.e.enabled = false; fx.puffPool.push(p.e); fx.puffs.splice(i, 1); continue; }
    const s = p.size * Math.sin(Math.min(1, k * 1.4) * Math.PI * 0.5) * (1 - k * 0.6);
    p.e.setLocalScale(s, s, s);
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
function centerFlash(text, ms) { $('center-msg').textContent = text; centerUntil = performance.now() + ms; }
function flashHitmark() { const h = $('hitmark'); h.classList.add('on'); setTimeout(() => h.classList.remove('on'), 60); }
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
  if (performance.now() > centerUntil) {
    let msg = '';
    if (!local.alive && myId && phase === 'play') msg = `リスポーンまで ${local.respawnIn.toFixed(1)} 秒`;
    else if (!input.touchMode && document.pointerLockElement !== $('game') && $('settings').classList.contains('hidden') && $('invite').classList.contains('hidden') && phase === 'play') msg = 'クリックで操作開始';
    $('center-msg').textContent = msg;
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
  for (const [id, v] of tanks) {
    if (id === myId || !v.visible) continue;
    camera.camera.worldToScreen(new pc.Vec3(v.pos.x, v.pos.y + 3.1, v.pos.z), tmp);
    if (tmp.z < 0 || tmp.x < 0 || tmp.y < 0 || tmp.x > w || tmp.y > h) continue;
    v.tag.style.display = 'block';
    v.tag.style.left = `${tmp.x}px`; v.tag.style.top = `${tmp.y}px`;
    v.tag.firstChild.textContent = v.name || '';
    v.tag.firstChild.style.color = colorCss(v.slot);
    v.tag.querySelector('i').style.width = `${v.hp}%`;
  }
}
