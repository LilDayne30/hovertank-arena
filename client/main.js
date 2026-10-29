import * as pc from 'playcanvas';
import { Room, roomInfo, quickMatch, joinPhrase, stats as fetchStats } from './net.js';
import {
  C, DT, makeWorld, heightAt, newTank, stepTank, muzzle, stepShell, segmentHitsTank, wrapPi, clamp, solveAim, projectile, SHELL_KINDS,
} from '../shared/sim.js';
import { SIDEARMS, ULTS, SIDE, ULT, ULT_MAX, cleanLoadout } from '../shared/abilities.js';
import { PLAYER_COLORS, RECONNECT_SECONDS, applyObstacles, PIT_HALF, HEAL_POS, TEAM_NAMES, TEAM_COLORS, DEFAULT_RULES, KILL_TARGETS, cleanRules, rulesLabel, qmLabel, normPhrase } from '../shared/arena.js';
import { Input } from './input.js';
import { Fx } from './fx.js';
import { buildStage } from './stage.js';
import { setupPwa } from './pwa.js';
import { Looks, emblemSvg } from './looks.js';
import { Profile } from './profile.js';
import { setupProgressUi, titleName } from './progress-ui.js';
import { DEFAULT_LOOK } from '../shared/progress.js';
import { Sound } from './audio.js';

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
let app, device, world, tankAsset, camera, root, fx, looks, profile, pui;
const preview = { look: null, yaw: 0.6, v: null };
const sound = new Sound();
// hit stop: on a kill the picture freezes for a split second (tanks, camera, effects), then catches up.
// Only the rendering pauses: inputs, prediction and the server keep running, so nothing desyncs.
const hitstop = { until: 0, lag: 0, frozen: null };
function hitStop(ms) { hitstop.until = Math.max(hitstop.until, performance.now() + ms); }
let lastCharge = 0;   // garage preview (lobby: its own tank on the hill; in a room: your tank)
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
let rules = { ...DEFAULT_RULES }, myTeam = 0, teamKills = [0, 0], settingsRules = null, publicRoom = false;
const sameTeam = (id) => rules.mode === 'team' && roster.get(id)?.team === myTeam;
// sidearm + special choice (kept on this device, sent to the room on join and on every change)
let loadout = cleanLoadout(JSON.parse(store.get('ht-loadout') || 'null'));
const loadoutPickers = [];
const reflected = new Set();      // shells you turned around with a perfect guard (now yours, drawn from the server)
const megaShown = new Set();      // your own mega cannon blasts already drawn locally
const mines = new Map();          // mine id -> entity
const abil = { sideReady: true, ultReady: false };
window.__ht = { stats, local, snaps, setCam: DEBUG ? (y, p) => { camYaw = y; camPitch = p; } : undefined, los: DEBUG ? (...a) => lineOfSight(...a) : undefined, get aim() { return aimPoint; }, get room() { return room; }, get fps() { return fpsSmooth; }, get ping() { return ping; }, get fx() { return fx; }, get app() { return app; } };

// ------------------------------------------------------------------ boot
init().catch((e) => { console.error(e); showLoading(false); $('lobby-status').textContent = `初期化に失敗しました: ${e.message}`; });

async function init() {
  document.body.classList.toggle('touch', matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window);
  $('name').value = store.get('ht-name') || '';
  const rid = params.get('r');
  if (rid) { $('btn-join').classList.remove('hidden'); $('btn-join').textContent = `部屋 ${rid} に参加`; }
  // rules for a new room (remembered); when opened from an invite, show the room's rules instead
  const lobbyRules = rulesPicker($('lobby-rules'), cleanRules(JSON.parse(store.get('ht-rules') || 'null')), (r) => store.set('ht-rules', JSON.stringify(r)));
  // private match: passphrase (empty -> one is made up)
  $('phrase').value = store.get('ht-phrase') || '';
  $('btn-phrase-rand').onclick = () => { $('phrase').value = randomPhrase(); };
  $('phrase').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) $('btn-create').click(); });
  $('btn-create').onclick = () => {
    if (!$('phrase').value.trim()) $('phrase').value = randomPhrase();
    if (!normPhrase($('phrase').value)) { $('lobby-status').textContent = '合言葉は2〜16文字にしてください。'; return; }
    store.set('ht-phrase', $('phrase').value.trim());
    start('phrase', null, lobbyRules.get());
  };
  // quick match (public rooms) with a mode preference
  // quick match: mode + how many tanks fight (team battle is always 2 v 2)
  let qmMode = store.get('ht-qm') || 'any', qmSize = Number(store.get('ht-qm-size')) || 4;
  const paintQm = () => {
    document.querySelectorAll('#qm-mode [data-v]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === qmMode)));
    const size = qmMode === 'team' ? 4 : qmSize;
    document.querySelectorAll('#qm-size button').forEach((b) => { b.setAttribute('aria-pressed', String(Number(b.dataset.n) === size)); b.disabled = qmMode === 'team' && b.dataset.n !== '4'; });
  };
  document.querySelectorAll('#qm-mode [data-v]').forEach((b) => { b.onclick = () => { qmMode = b.dataset.v; store.set('ht-qm', qmMode); paintQm(); }; });
  document.querySelectorAll('#qm-size button').forEach((b) => { b.onclick = () => { qmSize = Number(b.dataset.n); store.set('ht-qm-size', String(qmSize)); if (qmMode === 'team' && qmSize !== 4) qmMode = 'ffa'; paintQm(); }; });
  // win condition (people are matched with others who picked the same)
  let qmGoal = store.get('ht-qm-goal') === 'kills' ? 'kills' : 'time', qmTarget = KILL_TARGETS.includes(Number(store.get('ht-qm-target'))) ? Number(store.get('ht-qm-target')) : 10;
  const goalSel = document.querySelector('#qm-goal select');
  goalSel.innerHTML = KILL_TARGETS.map((n) => `<option value="${n}">${n}</option>`).join('');
  const paintGoal = () => {
    document.querySelectorAll('#qm-goal [data-g]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.g === qmGoal)));
    goalSel.value = String(qmTarget); goalSel.classList.toggle('dim', qmGoal !== 'kills');
    store.set('ht-qm-goal', qmGoal); store.set('ht-qm-target', String(qmTarget));
  };
  document.querySelectorAll('#qm-goal [data-g]').forEach((b) => { b.onclick = () => { qmGoal = b.dataset.g; paintGoal(); }; });
  goalSel.onchange = () => { qmTarget = Number(goalSel.value); qmGoal = 'kills'; paintGoal(); };
  paintQm(); paintGoal();
  $('btn-quick').onclick = () => start('quick', null, null, qmMode, qmMode === 'team' ? 4 : qmSize, qmGoal, qmTarget);
  if (rid) roomInfo(ENDPOINT, rid).then((i) => { if (i.exists && i.rules) $('lobby-room-rules').textContent = i.public ? `この部屋：クイックマッチ・${qmLabel(i.rules)}` : `この部屋のルール：${rulesLabel(i.rules)}（${i.players}/4人）`; }).catch(() => {});
  $('btn-join').onclick = () => start('join', rid);
  loadoutPicker($('lobby-loadout')); loadoutPicker($('settings-loadout'));
  wireUi();
  setupSound();
  profile = new Profile(ENDPOINT);
  pui = setupProgressUi({
    profile,
    inRoom: () => !!room,
    onPreview: (look) => {
      preview.look = look ? { ...look } : null;
      if (room) { removeTank(myId); input.enabled = !look; if (look) { document.exitPointerLock?.(); input.reset(); } }
      if (preview.v) { removeTank('__preview'); preview.v = null; }
    },
    onSaved: () => { if (room) room.send('look', 1); },
  });
  profile.load().catch((e) => console.warn('profile', e.message));
  if (DEBUG) window.__ht.fxKill = (style, d = 16) => {   // debug: play a kill (effect + hit stop) in front of the camera
    const p = camera.getPosition(), f = camera.forward, x = p.x + f.x * d, z = p.z + f.z * d, gy = heightAt(world, x, z);
    fx.killStyle(x, gy + C.hoverHeight, z, mats.slotLit[1], style, { groundY: gy, big: true });
    hitStop(120); screenFlash('kill'); sound.impact(); fovKick = -9; centerFlash('撃破！', 1200, true);
  };
  if (DEBUG) window.__ht.preview = (look) => { preview.look = look ? { ...DEFAULT_LOOK, ...look } : null; if (preview.v) removeTank('__preview'); $('lobby').classList.toggle('hidden', !!look); };
  const pwa = setupPwa({
    onOffline: (off) => {
      $('offline').classList.toggle('hidden', !off);
      for (const id of ['btn-quick', 'btn-create', 'btn-join']) $(id).disabled = off;
    },
  });
  // server reachability probe (also fetches the quick-match player count, not displayed yet)
  const showStats = () => fetchStats(ENDPOINT).then((st) => {
    pwa.setReachable(true);
    // (the player count is not shown for now: with few players it would make the game look empty)
  }).catch(() => { pwa.setReachable(false); });
  showStats(); setInterval(() => { if (!room) showStats(); }, 15000);
  window.addEventListener('online', showStats);
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
  looks = new Looks(app, device, tank);
  root.addChild(arena.resource.instantiateRenderEntity());
  buildStage(app, root, cover);
  makeMaterials();
  makeHealPickup();
  fx.flash(0, -60, 0, [1, 1, 1], 0.001, 0.05);   // compile the flash-light shader variants now, not on the first kill

  input = new Input(canvas, {
    touchLayer: $('touch-layer'), stickBase: $('stick-base'), stickKnob: $('stick-knob'),
    btnFire: $('btn-fire'), btnJump: $('btn-jump'), btnDrift: $('btn-drift'), btnSide: $('btn-side'), btnUlt: $('btn-ult'),
    onPointerLock: (locked) => { $('pc-help').style.opacity = locked ? '0.35' : '0.9'; },
  });
  input.enabled = false;
  if (DEBUG) window.__ht.input = input;
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
  $('btn-settings').onclick = () => { document.exitPointerLock?.(); settingsRules.set(rules); $('btn-team').classList.toggle('hidden', rules.mode !== 'team');
    $('settings-rules').classList.toggle('hidden', publicRoom); $('public-note').classList.toggle('hidden', !publicRoom);
    $('btn-newgame').textContent = $('btn-newgame').dataset.label = publicRoom ? 'ニューゲーム' : 'このルールでニューゲーム'; $('settings').classList.remove('hidden'); };
  $('btn-settings-close').onclick = () => $('settings').classList.add('hidden');
  $('btn-invite').onclick = () => { document.exitPointerLock?.(); showInvite(); };
  $('btn-invite-close').onclick = () => $('invite').classList.add('hidden');
  $('btn-copy').onclick = async () => {
    const v = myPhrase || $('invite-url').value;
    try { await navigator.clipboard.writeText(v); $('btn-copy').textContent = 'コピーしました'; } catch { $('invite-url').select(); document.execCommand?.('copy'); }
    setTimeout(() => { $('btn-copy').textContent = 'コピー'; }, 1500);
  };
  $('btn-share').onclick = () => navigator.share?.(myPhrase
    ? { title: 'Hover Tank Arena', text: `Hover Tank Arenaで一緒に対戦しよう！ ロビーの「合言葉」に「${myPhrase}」と入れてね`, url: `${location.origin}${location.pathname}` }
    : { title: 'Hover Tank Arena', text: '一緒に対戦しよう', url: $('invite-url').value }).catch(() => {});
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
    room.send('newgame', btn.id === 'btn-newgame' ? { rules: settingsRules.get() } : 1);
  };
  settingsRules = rulesPicker($('settings-rules'), rules, () => {});
  $('btn-team').onclick = () => { room?.send('team', 1); $('settings').classList.add('hidden'); };
  for (const id of ['btn-newgame', 'btn-result-newgame']) { const b = $(id); b.dataset.label = b.textContent; b.onclick = newGame(b); }
  $('btn-leave').onclick = async () => { if (room) { store.sdel(`ht-token-${room.roomId}`); await room.leave(); } location.href = location.pathname; };
}

// ------------------------------------------------------------------ sound settings
function setupSound() {
  const unlock = () => { sound.unlock(); if (!room) sound.setMusic('lobby'); };
  for (const ev of ['pointerdown', 'keydown', 'touchend']) window.addEventListener(ev, unlock, { capture: true });
  const bgm = parseFloat(store.get('ht-bgm') ?? '0.55'), sfx = parseFloat(store.get('ht-sfx') ?? '0.9');
  sound.setVolume('bgm', bgm); sound.setVolume('sfx', sfx);
  $('vol-bgm').value = String(bgm); $('vol-sfx').value = String(sfx);
  $('vol-bgm').oninput = (e) => { sound.setVolume('bgm', +e.target.value); store.set('ht-bgm', e.target.value); };
  $('vol-sfx').oninput = (e) => { sound.setVolume('sfx', +e.target.value); store.set('ht-sfx', e.target.value); };
  const paintMute = () => document.querySelectorAll('.btn-mute').forEach((b) => { b.textContent = sound.muted ? '🔇' : '🔊'; b.setAttribute('aria-pressed', String(sound.muted)); });
  sound.setMuted(store.get('ht-mute') === '1'); paintMute();
  document.querySelectorAll('.btn-mute').forEach((b) => { b.onclick = (e) => { e.stopPropagation(); sound.unlock(); sound.setMuted(!sound.muted); store.set('ht-mute', sound.muted ? '1' : '0'); paintMute(); }; });
  document.addEventListener('click', (e) => { if (e.target.closest?.('button') && !e.target.closest('.btn-mute')) sound.click(); });
}

let myPhrase = '';   // passphrase of the private room you are in ('' = quick match / old invite link)
function showInvite() {
  $('invite-url').value = `${location.origin}${location.pathname}?r=${room.roomId}`;
  $('invite-h').textContent = myPhrase ? '合言葉' : '招待URL';
  $('invite-phrase').textContent = myPhrase;
  $('invite-phrase-box').classList.toggle('hidden', !myPhrase);
  $('invite-url-box').classList.toggle('hidden', !!myPhrase);
  $('invite').classList.remove('hidden');
}
const PHRASE_WORDS = ['たこ', 'いか', 'ねこ', 'うに', 'くま', 'そら', 'ほし', 'もち', 'かぜ', 'ゆき', 'つき', 'はな', 'さめ', 'きつね', 'たぬき', 'かに'];
function randomPhrase() { return `${PHRASE_WORDS[Math.floor(Math.random() * PHRASE_WORDS.length)]}${10 + Math.floor(Math.random() * 90)}`; }
function showLoading(on, text) { $('loading').classList.toggle('hidden', !on); if (text) $('loading-text').textContent = text; }
function banner(text) { $('banner').textContent = text || ''; $('banner').classList.toggle('hidden', !text); }

// ------------------------------------------------------------------ networking
let phraseJoin = null;
async function start(mode, rid, newRules, qmMode, qmSize = 4, qmGoal = 'time', qmTarget = 10) {
  const name = $('name').value.trim().slice(0, 12);
  store.set('ht-name', name);
  $('lobby-status').textContent = '';
  showLoading(true, 'サーバーに接続中…');
  try {
    let id = rid;
    if (mode === 'quick') {
      // a seat can be taken by someone else between matching and joining: try another room then
      const tried = [];
      for (let attempt = 0; attempt < 4; attempt++) {
        showLoading(true, attempt ? '別の部屋を探しています…' : '対戦相手を探しています…');
        id = await quickMatch(ENDPOINT, qmMode, tried, qmSize, qmGoal, qmTarget);
        room = new Room(ENDPOINT, id);
        room.quick = true;
        bindRoom(room);
        try { await room.connect(name, null); break; } catch (e) { room = null; tried.push(id); if (e.code !== 'full' || attempt === 3) throw e; }
      }
    } else if (mode === 'phrase') {
      const raw = $('phrase').value.trim();
      const res = await joinPhrase(ENDPOINT, raw, newRules);
      id = res.id; phraseJoin = { raw, created: res.created, rules: res.rules };
      store.sset(`ht-phrase-${id}`, raw);
    }
    else {
      const info = await roomInfo(ENDPOINT, id);
      if (!info.exists) throw Object.assign(new Error('notfound'), { code: 'notfound' });
      if (info.full && mode !== 'reconnect') throw Object.assign(new Error('full'), { code: 'full' });
    }
    if (mode !== 'quick') {
      room = new Room(ENDPOINT, id);
      bindRoom(room);
      const token = mode === 'reconnect' ? store.sget(`ht-token-${id}`) : null;
      await room.connect(name, token);   // with a valid token the server gives back the same seat
    }
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
  if (mode === 'phrase') {
    if (phraseJoin.created) { showInvite(); notice(`合言葉「${escapeHtml(phraseJoin.raw)}」の部屋を作りました`); }
    else notice(`合言葉「${escapeHtml(phraseJoin.raw)}」の部屋に参加しました（${rulesLabel(phraseJoin.rules)}）`);
  }
  if (mode === 'quick') notice('クイックマッチ：対戦に参加しました');
  if (!input.touchMode) $('center-msg').textContent = 'クリックで操作開始';
  setInterval(() => room?.send('ping', performance.now()), 2000);
}

function bindRoom(r) {
  r.onMessage('welcome', (m) => {
    const sendProf = () => { if (profile.token) r.send('prof', profile.token); };
    if (profile.token) sendProf(); else profile.load().then(sendProf).catch(() => {});
    r.send('loadout', loadout);
    myId = m.id; mySlot = m.slot; myTeam = m.team ?? 0; phase = m.phase; publicRoom = !!m.public;
    myPhrase = m.phrase ? (store.sget(`ht-phrase-${r.roomId}`) || m.phrase) : '';
    $('btn-invite').textContent = myPhrase ? '合言葉' : '招待'; if (m.rules) setRules(m.rules); if (m.reconnected) { local.spawnId = -1; } });
  r.onMessage('roster', (msg) => {
    const list = Array.isArray(msg) ? msg : msg.players;
    if (msg.rules) setRules(msg.rules);
    const seen = new Set();
    for (const p of list) { p.look = { ...DEFAULT_LOOK, ...(p.look || {}) }; p.key = `${p.slot}|${JSON.stringify(p.look)}`; roster.set(p.id, p); seen.add(p.id); }
    for (const id of [...roster.keys()]) if (!seen.has(id)) { roster.delete(id); removeTank(id); }
    const me = roster.get(myId);
    if (me) { myTeam = me.team ?? 0; if (me.slot !== mySlot) { mySlot = me.slot; removeTank(myId); } }
    for (const [id, v] of tanks) { const r = roster.get(id); if (r && v.key !== lookKeyFor(id) && id !== '__preview') removeTank(id); }
    updateBoard();
  });
  r.onMessage('s', onSnapshot);
  r.onMessage('result', showResult);
  r.onMessage('prog', (res) => { if (DEBUG) (window.__ht.progs ??= []).push(res); profile.applyProgress(res); pui.showMatchProgress(res); if (res?.after && res.before && res.after.level > res.before.level) setTimeout(() => sound.levelUp(), 900); });
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
      sideCd: a[23] || 0, ult: a[24] || 0, shieldT: a[25] || 0, shieldAge: a[26] ?? 9, odT: a[27] || 0, slam: a[28] || 0,
      side: SIDEARMS[a[29]]?.id || 'dash', ultK: ULTS[a[30]]?.id || 'overdrive', dashT: a[31] || 0,
    });
  }
  const shells = m.b.map((b) => ({ id: b[0], owner: b[1], seq: b[2], x: b[3], y: b[4], z: b[5], vx: b[6], vy: b[7], vz: b[8], kind: SHELL_KINDS[b[9]] || 'shell', bounce: b[10] || 0 }));
  const mn = (m.mn || []).map((a) => ({ id: a[0], owner: a[1], x: a[2], y: a[3], z: a[4], armed: !!a[5] }));
  return { k: m.k, ph: m.ph, tl: m.tl, players, shells, mines: mn, hl: !!m.hl, hn: m.hn || 0 };
}

function onSnapshot(m) {
  const s = parseSnap(m);
  snaps.push(s);
  while (snaps.length > 40) snaps.shift();
  if (serverTick === null || Math.abs(serverTick - s.k) > 15) serverTick = s.k;
  else serverTick += (s.k - serverTick) * 0.08;
  for (const e of m.e) {
    if (e.t === 'hit' && e.o === myId) { flashHitmark(); sound.hitConfirm(); }
    if (e.t === 'hit' && e.v === myId) { flashDamage(); fx.addShake(0.5); sound.hurt(); }
    if (e.t === 'team' && e.v !== myId) notice(`${escapeHtml(nameOf(e.v))} が${TEAM_NAMES[e.team]}に移動`);
    if (e.t === 'newgame') {
      sound.horn();
      notice(`${escapeHtml(nameOf(e.by))} がニューゲームを開始しました（${publicRoom ? qmLabel(e.rules || rules) : rulesLabel(e.rules || rules)}）`);
      $('result').classList.add('hidden'); $('settings').classList.add('hidden');
      local.spawnId = -1;
    }
    if (e.t === 'healspawn') notice('中央の丘に回復アイテムが出現！');
    if (e.t === 'heal' && e.v === myId) { centerFlash('全回復！', 1000, true); flashHeal(); }
    if (e.t === 'reflect') { reflected.add(e.s); if (reflected.size > 200) reflected.clear(); }
    pendingEvents.push({ k: s.k, e });
  }
  if (phase !== s.ph) { phase = s.ph; if (phase === 'play') { $('result').classList.add('hidden'); sound.horn(); } }
  sound.setMusic(phase === 'play' ? 'battle' : 'result', phase === 'play' && rules.goal === 'time' && s.tl <= 30);
  teamKills = m.tk || [0, 0];
  waitLeft = s.ph === 'wait' ? s.tl : 0;
  $('timer').textContent = s.ph === 'wait' ? 'マッチング中' : rules.goal === 'kills' ? `${rules.target}キル先取` : `${Math.floor(s.tl / 60)}:${String(s.tl % 60).padStart(2, '0')}`;
  $('teamscore').classList.toggle('hidden', rules.mode !== 'team');
  if (rules.mode === 'team') $('teamscore').innerHTML = `<span style="color:${rgb(TEAM_COLORS[0])}">${TEAM_NAMES[0]} ${teamKills[0]}</span> − <span style="color:${rgb(TEAM_COLORS[1])}">${teamKills[1]} ${TEAM_NAMES[1]}</span>`;
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
    sideCd: p.sideCd, ult: p.ult, shieldT: p.shieldT, shieldAge: p.shieldAge, odT: p.odT, slam: p.slam, dashT: p.dashT, side: p.side, ultK: p.ultK,
  });
  return t;
}

// ------------------------------------------------------------------ per-frame update
function update(dt) {
  dt = Math.min(dt, 0.1);
  fpsSmooth = fpsSmooth * 0.95 + (1 / Math.max(dt, 1e-4)) * 0.05;
  if (!room || !myId) {
    if (preview.look && looks) garagePreview(dt); else { if (tanks.has('__preview')) removeTank('__preview'); lobbyCamera(dt); }
    sound.engine({ alive: false });
    fx.update(dt); return;
  }

  const [lx, ly] = input.takeLook();
  camYaw = wrapPi(camYaw - lx);
  camPitch = clamp(camPitch - ly, -0.55, 0.62);

  acc += dt;
  let n = 0;
  while (acc >= DT && n < 5) { acc -= DT; tick(); n++; }
  if (n === 5) acc = 0;
  const alpha = acc / DT;

  if (serverTick !== null) serverTick += dt / DT;
  // during a hit stop, remote tanks are rendered further in the past (frozen); afterwards the extra
  // delay melts away so they catch up smoothly
  const stopping = performance.now() < hitstop.until;
  const vdt = stopping ? dt * 0.03 : dt;
  if (stopping) hitstop.lag += (dt / DT) * 0.97;
  else if (hitstop.lag > 0) { hitstop.lag *= Math.exp(-5 * dt); if (hitstop.lag < 0.02) hitstop.lag = 0; }
  const rt = serverTick === null ? null : serverTick - INTERP_TICKS - hitstop.lag;

  local.offset.mulScalar(Math.exp(-12 * dt));
  renderLocal(alpha, dt, stopping);
  if (rt !== null) { renderRemote(rt, dt); flushEvents(rt); }
  tankFx(vdt);
  updateHealPickup(dt);
  if (preview.look) garageCamera(dt, tanks.get(myId)?.pos); else updateCamera(dt);
  computeAimPoint();
  updateLocalShells(dt);
  fx.update(vdt);
  updateTags();
  updateHud(dt);
  const cp = camera.getPosition();
  sound.setListener(cp.x, cp.y, cp.z, camYaw);
  const lt = local.t;
  sound.engine({ alive: local.alive && !!lt, inGame: phase === 'play' || phase === 'end', speed: lt ? Math.hypot(lt.vx, lt.vz) : 0, boost: lt?.boost || 0, sliding: local.sliding, charge: lt?.charge || 0 });
}

function tick() {
  const s = input.sample();
  const fx0 = -Math.sin(camYaw), fz0 = -Math.cos(camYaw), rx = Math.cos(camYaw), rz = -Math.sin(camYaw);
  const mx = rx * s.mx + fx0 * s.my, mz = rz * s.mx + fz0 * s.my;
  let ay = camYaw, ap = 0;
  if (local.t) [ay, ap] = solveAim(local.t, aimPoint);
  const play = phase === 'play';
  const inp = { seq: ++seq, mx: r3(mx), mz: r3(mz), ay: r3(ay), ap: r3(ap), j: s.jump, d: s.drift, f: s.fire && play, a: s.side && play, u: s.ult && play };
  if (!inp.a) delete inp.a;
  if (!inp.u) delete inp.u;
  local.sliding = false;
  if (local.alive && local.t) {
    local.prev = { ...local.t };
    const t = local.t;
    const ev = stepTank(t, inp, world);
    const gy = t.y - C.hoverHeight;
    if (ev.fired) { fireLocalShell(t, 'shell', ev.fireSeq); fx.addShake(0.07); }
    if (ev.side) localSide(t, ev, gy);
    if (ev.ult) localUlt(t, ev, gy);
    if (ev.slam) { fx.slamWave(t.x, gy, t.z, ULT.slam.radius); sound.slam(null, true); fovKick = 12; }
    else if (ev.landed) { fx.landRing(t.x, gy, t.z, 1); sound.land(null, true); }
    if (ev.jumped && !ev.ult) { fx.jumpRing(t.x, gy, t.z); sound.jump(null, true); }
    if (ev.boost) { fx.boostBurst(t.x, gy, t.z, t.yaw, ev.boost); fovKick = ev.boost === 2 ? 14 : 9; fx.addShake(0.15 * ev.boost); sound.boost(null, true, ev.boost); }
    const lvl = t.charge >= C.charge2 ? 2 : t.charge >= C.charge1 ? 1 : 0;
    if (lvl > lastCharge) sound.chargeTing(lvl);
    lastCharge = lvl;
    local.sliding = ev.sliding;
  }
  local.pending.push(inp);
  if (local.pending.length > 90) local.pending.shift();
  outBuf.push(inp);
  if (outBuf.length >= 2) { room.send('i', outBuf); outBuf = []; }
}
let outBuf = [];
const r3 = (v) => Math.round(v * 1000) / 1000;

// your own sidearm / special: instant feedback (the server does the real work)
function localSide(t, ev, gy) {
  if (ev.side === 'dash') {
    const sp = Math.hypot(t.vx, t.vz) || 1;
    fx.dashBurst(t.x, gy, t.z, t.vx / sp, t.vz / sp); sound.dash(null, true); fovKick = 11; fx.addShake(0.12);
  } else if (ev.side === 'shield') { fx.shieldUp(t.x, gy, t.z); sound.shieldUp(null, true); }
  else if (ev.side === 'mine') sound.minePlace(null, true);
  else if (ev.side === 'bounce') fireLocalShell(t, 'bounce', ev.sideSeq);
  flashAbility('ab-side');
}
function localUlt(t, ev, gy) {
  const U = ULT[ev.ult];
  centerFlash(`${U.icon} ${U.name}`, 900, true);
  if (ev.ult === 'overdrive') { fx.overdriveStart(t.x, gy, t.z, true); sound.overdrive(null, true); fovKick = 8; }
  else if (ev.ult === 'mega') { fireLocalShell(t, 'mega', ev.ultSeq); fx.addShake(0.4); fovKick = -6; }
  else if (ev.ult === 'strike') sound.strikeCall(null, true, false);
  else if (ev.ult === 'slam') { fx.jumpRing(t.x, gy, t.z); sound.slamJump(null, true); }
  flashAbility('ab-ult');
}
function flashAbility(id) { const el = $(id); el.classList.add('on'); setTimeout(() => el.classList.remove('on'), 180); }

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
  mats.bounceShell = fx.col([0.6, 1, 0.35], true, 1); mats.bouncePuff = fx.col([0.55, 1, 0.4]);
  mats.megaShell = fx.col([1, 0.45, 1], true, 1);
  mats.mineBody = (() => { const m = new pc.StandardMaterial(); m.diffuse = new pc.Color(0.16, 0.15, 0.14); m.update(); return m; })();
  mats.mineMine = fx.col([0.35, 0.8, 1], true, 1); mats.mineEnemy = fx.col([1, 0.2, 0.1], true, 1); mats.mineOff = fx.col([0.5, 0.45, 0.4]);
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
// the look a tank is drawn with: the garage preview for yourself while it is open, else the roster's
function lookFor(id) {
  if (id === '__preview') return preview.look || DEFAULT_LOOK;
  if (id === myId && preview.look) return preview.look;
  return roster.get(id)?.look || (id === myId ? pui?.look : null) || DEFAULT_LOOK;
}
function slotFor(id) { return id === '__preview' ? 0 : id === myId ? mySlot : roster.get(id)?.slot ?? 0; }
function lookKeyFor(id) { return `${slotFor(id)}|${JSON.stringify(lookFor(id))}`; }

function getTank(id) {
  let v = tanks.get(id);
  if (v && v.key === lookKeyFor(id)) return v;
  if (v) removeTank(id);
  const slot = slotFor(id), look = lookFor(id);
  const { e, turret, paintMats, glowMats, outlines } = looks.build(look, slot);
  root.addChild(e);
  const shadow = new pc.Entity('shadow');
  shadow.addComponent('render', { type: 'plane', material: mats.shadow, castShadows: false });
  root.addChild(shadow);
  const hover = new pc.Entity('hover');
  hover.addComponent('render', { type: 'plane', material: looks.hoverMat(look, mats.hover), castShadows: false });
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
  tag.innerHTML = '<span class="nm"></span><div class="bar"><i></i></div>';
  $('tags').appendChild(tag);
  v = {
    e, turret, shadow, hover, shield, shieldMat, tag, slot, hp: C.maxHp, visible: true, key: lookKeyFor(id), look,
    pos: new pc.Vec3(), yaw: 0, vx: 0, vz: 0, mats: paintMats, glowMats, outlines, rel: null, flash: 0, recoil: 0, smokeT: 0,
    grounded: true, drifting: false, charge: 0, boost: 0, boostLvl: 0, lastSpawn: -1, trail: looks.trailMats(look),
  };
  looks.setRelation(v, relationOf(id));
  tanks.set(id, v);
  return v;
}
// outline colour: red = enemy, blue = teammate, none = yourself
function relationOf(id) {
  if (id === '__preview') return (DEBUG && window.__ht.previewRel) || 'none';
  return id === myId ? 'none' : sameTeam(id) ? 'ally' : 'enemy';
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
  // reflect shield (sidearm): brighter and bigger; white during the perfect-guard window
  const guard = v.shieldT > 0;
  v.shield.enabled = guard || (invuln && (v.invulnLeft > 0.5 || Math.floor(time * 12) % 2 === 0));
  if (v.shield.enabled) {
    const perfect = guard && v.shieldAge <= SIDE.shield.perfect;
    const mode = perfect ? 2 : guard ? 1 : 0;
    if (v.shieldMode !== mode) {
      v.shieldMode = mode;
      v.shieldMat.emissive = mode === 2 ? new pc.Color(1, 1, 1) : mode === 1 ? new pc.Color(0.45, 0.95, 1) : new pc.Color(0.4, 0.85, 1);
      const k = mode ? 1.12 : 1; v.shield.setLocalScale(5.2 * k, 3.6 * k, 5.6 * k);
    }
    v.shieldMat.opacity = mode === 2 ? 0.75 : mode === 1 ? 0.38 + Math.sin(time * 14) * 0.08 + (v.shieldT < 0.4 && Math.floor(time * 14) % 2 ? -0.25 : 0) : 0.22 + Math.sin(time * 6) * 0.08;
    v.shieldMat.update();
  }
}

function renderLocal(alpha, dt, stopping) {
  if (!myId) return;
  const v = getTank(myId);
  if (!local.alive || !local.t) { placeTank(v, 0, 0, 0, 0, 0, 0, 0, false); hitstop.frozen = null; return; }
  const a = local.prev, b = local.t;
  let x = pc.math.lerp(a.x, b.x, alpha) + local.offset.x;
  let y = pc.math.lerp(a.y, b.y, alpha) + local.offset.y;
  let z = pc.math.lerp(a.z, b.z, alpha) + local.offset.z;
  let yaw = a.yaw + wrapPi(b.yaw - a.yaw) * alpha;
  if (stopping) {
    // hold the drawn tank where it was; the offset then eases it back after the stop
    const f = hitstop.frozen || (hitstop.frozen = { x, y, z, yaw });
    local.offset.x += f.x - x; local.offset.y += f.y - y; local.offset.z += f.z - z;
    x = f.x; y = f.y; z = f.z; yaw = f.yaw;
  } else hitstop.frozen = null;
  v.boost = b.boost; v.boostLvl = b.boostLvl; v.charge = b.charge; v.drifting = local.sliding; v.invulnLeft = local.invulnLeft;
  v.shieldT = b.shieldT; v.shieldAge = b.shieldAge; v.odT = b.odT; v.dashT = b.dashT; v.slam = b.slam;
  if (v.lastSpawn !== local.spawnId) { v.lastSpawn = local.spawnId; fx.respawnBeam(x, y - C.hoverHeight, z, mats.slotGlow[mySlot % 4]); sound.respawn(null, true); }
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
    const v = getTank(id);
    looks.setRelation(v, relationOf(id));
    const vis = pa.alive && pb.alive && pa.connected && pa.spawnId === pb.spawnId;
    const x = pc.math.lerp(pa.x, pb.x, f), y = pc.math.lerp(pa.y, pb.y, f), z = pc.math.lerp(pa.z, pb.z, f);
    const yaw = pa.yaw + wrapPi(pb.yaw - pa.yaw) * f;
    const ay = pa.ay + wrapPi(pb.ay - pa.ay) * f;
    const src = f < 0.5 ? pa : pb;
    v.boost = src.boost; v.boostLvl = src.boostLvl; v.charge = src.charge; v.invulnLeft = src.invulnLeft;
    v.shieldT = src.shieldT; v.shieldAge = src.shieldAge; v.odT = src.odT; v.dashT = src.dashT; v.slam = src.slam;
    // derive cosmetic state changes (jump / land / slide / respawn) from the interpolated stream
    if (vis) {
      const sp3 = { x, y, z };
      if (v.lastSpawn !== pa.spawnId) { v.lastSpawn = pa.spawnId; fx.respawnBeam(x, y - C.hoverHeight, z, mats.slotGlow[r.slot % 4]); sound.respawn(sp3); }
      else if (v.grounded && !src.grounded) { fx.jumpRing(x, y - C.hoverHeight, z); sound.jump(sp3); }
      else if (!v.grounded && src.grounded) { fx.landRing(x, y - C.hoverHeight, z, 0.8); sound.land(sp3, false, 0.8); }
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
    if (s.owner === myId && !reflected.has(s.id)) continue;
    const dt = (rt - a.k) * DT, g = s.kind === 'mega' ? ULT.mega.gravity : C.shellGravity;
    const px = s.x + s.vx * dt, py = s.y + s.vy * dt - 0.5 * g * dt * dt, pz = s.z + s.vz * dt;
    if (!seenShells.has(s.id)) {
      seenShells.add(s.id);
      if (!reflected.has(s.id)) {
        const sp = Math.hypot(s.vx, s.vy, s.vz) || 1;
        if (s.kind === 'mega') { fx.megaMuzzle(px, py, pz, s.vx / sp, s.vy / sp, s.vz / sp); sound.megaFire({ x: px, y: py, z: pz }, false); }
        else { fx.muzzle(px, py, pz, s.vx / sp, s.vy / sp, s.vz / sp); sound.fire({ x: px, y: py, z: pz }, false); }
        const ov = tanks.get(s.owner); if (ov) ov.recoil = s.kind === 'mega' ? 2 : 1;
      }
      if (seenShells.size > 300) seenShells.clear();
    }
    drawShell(`r${s.id}`, px, py, pz, s.vx, s.vy - g * dt, s.vz, s.owner, s.kind);
    used.add(`r${s.id}`);
  }
  for (const [key, e] of shellEnts) if (key[0] === 'r' && !used.has(key)) freeShell(key, e);
  updateMines(b.mines || []);
}

// mines: a dark disc with a light; yours / your team's glow blue, enemy ones blink red now and then
function updateMines(list) {
  const seen = new Set(), now = performance.now() / 1000;
  for (const m of list) {
    seen.add(m.id);
    let e = mines.get(m.id);
    if (!e) {
      e = new pc.Entity('mine');
      e.addComponent('render', { type: 'cylinder', material: mats.mineBody, castShadows: false });
      e.setLocalScale(1.3, 0.22, 1.3);
      const l = new pc.Entity('light');
      l.addComponent('render', { type: 'sphere', material: mats.mineOff, castShadows: false });
      l.setLocalScale(0.3, 1.5, 0.3); l.setLocalPosition(0, 0.6, 0);
      e.addChild(l); e.light = l;
      root.addChild(e); mines.set(m.id, e);
      e.setPosition(m.x, m.y + 0.08, m.z);
    }
    const friendly = m.owner === myId || sameTeam(m.owner);
    const blink = friendly ? Math.floor(now * 2) % 2 === 0 : (now + m.id * 0.37) % 1.6 < 0.12;
    const mat = !m.armed ? mats.mineOff : blink ? (friendly ? mats.mineMine : mats.mineEnemy) : mats.mineOff;
    if (e.light.render.material !== mat) e.light.render.material = mat;
  }
  for (const [id, e] of mines) if (!seen.has(id)) { e.destroy(); mines.delete(id); }
}

function flushEvents(rt) {
  while (pendingEvents.length && pendingEvents[0].k <= rt + 0.5) {
    const { e } = pendingEvents.shift();
    if (e.t === 'boom') { if (e.o !== myId && e.k !== 2) { fx.explosion(e.x, e.y, e.z, 1.6); sound.boom(e, 1); } }
    else if (abilityEvent(e)) { /* handled */ }
    else if (e.t === 'hit') {
      fx.hitSpark(e.x, e.y, e.z);
      if (e.v !== myId) sound.boom(e, 1.15);
      const v = tanks.get(e.v); if (v) v.flash = 1;
      if (e.o === myId) killLocalShell(e.q, false);
    } else if (e.t === 'shield') { fx.shieldSpark(e.x, e.y, e.z); sound.shield(e); if (e.o === myId) killLocalShell(e.q, false); }
    else if (e.t === 'block') { fx.shieldSpark(e.x, e.y, e.z); sound.shield(e); if (e.o === myId) killLocalShell(e.q, false); const v = tanks.get(e.v); if (v) v.flash = 0.25; }
    else if (e.t === 'healspawn') { fx.healSpawn(HEAL_POS.x, HEAL_POS.y, HEAL_POS.z); sound.healSpawn(); }
    else if (e.t === 'heal') {
      fx.healBurst(HEAL_POS.x, HEAL_POS.y + 1.4, HEAL_POS.z);
      sound.heal(HEAL_POS, e.v === myId);
      const v = tanks.get(e.v); if (v) v.healFlash = 1;
      if (e.v !== myId) notice(`${escapeHtml(nameOf(e.v))} が回復した`);
    } else if (e.t === 'boost') {
      if (e.v !== myId) { const v = tanks.get(e.v); if (v && v.visible) { fx.boostBurst(v.pos.x, v.pos.y - C.hoverHeight, v.pos.z, v.yaw, e.l); sound.boost(v.pos, false, e.l); } }
    } else if (e.t === 'kill') {
      const vt = tanks.get(e.v);
      const mine = e.k === myId, me = e.v === myId;
      fx.killStyle(e.x, e.y, e.z, vt?.mats?.[0] || mats.slotLit[(roster.get(e.v)?.slot ?? 0) % 4], roster.get(e.k)?.look?.boom, { groundY: heightAt(world, e.x, e.z), big: mine || me });
      feed(e.k, e.v);
      sound.kill(e, mine, me);
      if (me) { centerFlash('撃破された…', 1800); hitStop(180); screenFlash('death'); sound.impact(); fovKick = 10; }
      else if (mine) { centerFlash('撃破！', 1200, true); fx.addShake(0.5); hitStop(120); screenFlash('kill'); sound.impact(); fovKick = -9; }
    }
  }
}

// sidearm / special events from the server (returns true when handled)
function abilityEvent(e) {
  const v = tanks.get(e.v), me = e.v === myId, gyAt = (x, z) => heightAt(world, x, z);
  switch (e.t) {
    case 'side': {
      if (me || !v?.visible) return true;
      const gy = v.pos.y - C.hoverHeight;
      if (e.k === 'dash') { const sp = Math.hypot(v.vx, v.vz) || 1; fx.dashBurst(v.pos.x, gy, v.pos.z, v.vx / sp, v.vz / sp); sound.dash(v.pos, false); }
      else if (e.k === 'shield') { fx.shieldUp(v.pos.x, gy, v.pos.z); sound.shieldUp(v.pos, false); }
      else if (e.k === 'mine') sound.minePlace(v.pos, false);
      return true;
    }
    case 'ult': {
      if (me) return true;
      const U = ULT[e.k];
      if (U) notice(`<span style="color:${colorCss(roster.get(e.v)?.slot ?? 0)}">${escapeHtml(nameOf(e.v))}</span> の必殺技　${U.icon} ${U.name}`);
      if (!v?.visible) return true;
      const gy = v.pos.y - C.hoverHeight;
      if (e.k === 'overdrive') { fx.overdriveStart(v.pos.x, gy, v.pos.z); sound.overdrive(v.pos, false); }
      else if (e.k === 'slam') { fx.jumpRing(v.pos.x, gy, v.pos.z); sound.slamJump(v.pos, false); }
      return true;
    }
    case 'reflect': {
      fx.reflectBurst(e.x, e.y, e.z); sound.reflect(e, me);
      if (e.o === myId) { killLocalShell(e.q, false); centerFlash('はね返された！', 900); }
      if (me) { centerFlash('ジャストガード！', 1000, true); fx.addShake(0.3); }
      return true;
    }
    case 'rico': if (e.o !== myId || reflected.has(e.s)) { fx.rico(e.x, e.y, e.z); sound.rico(e); } return true;
    case 'mega': {
      if (e.o === myId && megaShown.has(e.q)) return true;
      if (e.o === myId) killLocalShell(e.q, false, true);
      else { fx.megaBlast(e.x, e.y, e.z, gyAt(e.x, e.z)); sound.bigBoom(e, 1.8); }
      return true;
    }
    case 'strike': {
      const mine = e.o === myId, enemy = !mine && !sameTeam(e.o), gy = gyAt(e.x, e.z), U = ULT.strike;
      const last = Math.max(...e.b.map((b) => b[2]));
      fx.strikeMarker(e.x, gy, e.z, U.spread, last + 0.35, enemy);
      if (!mine) sound.strikeCall(e, false, enemy);
      for (const [bx, bz, dt] of e.b) {
        const fall = Math.min(0.6, dt), by = gyAt(bx, bz);
        fx.later(Math.max(0, dt - fall), () => { fx.bombFall(bx, by, bz, fall); sound.bombWhistle({ x: bx, y: by, z: bz }, fall); });
      }
      return true;
    }
    case 'bomb': fx.bombBlast(e.x, e.y, e.z); sound.boom(e, 1.4); return true;
    case 'mineboom': fx.mineBlast(e.x, e.y, e.z); sound.bigBoom(e, 1.3); return true;
    case 'slam': if (!me) { fx.slamWave(e.x, e.y, e.z, ULT.slam.radius); sound.slam(e, false); } return true;
    default: return false;
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
    if (v.drifting && v.pos.y - C.hoverHeight - gy < 0.3) fx.driftSparks(v.pos.x, gy, v.pos.z, v.yaw, v.charge >= C.charge2 ? 2 : v.charge >= C.charge1 ? 1 : 0, looks.sparkMat(v.look));
    if (v.boost > 0) fx.exhaust(v.pos.x, v.pos.y - C.hoverHeight, v.pos.z, v.yaw, v.boostLvl);
    if (v.odT > 0) fx.overdriveAura(v.pos.x, v.pos.y - C.hoverHeight, v.pos.z);
    if (v.dashT > 0 || v.slam === 2) fx.dashTrail(v.pos.x, v.pos.y - C.hoverHeight, v.pos.z);
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
    if (id === myId || !v.visible || sameTeam(id)) continue;   // shells pass through teammates
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

// garage: the tank sits on the right of the screen (the item list is on the left), slowly turning
function garagePreview(dt) {
  const v = getTank('__preview');
  preview.yaw += dt * 0.45;
  const t = performance.now() / 1000;
  const y = HEAL_POS.y + C.hoverHeight;
  placeTank(v, 0, y, 0, preview.yaw, preview.yaw + Math.sin(t * 0.7) * 0.5, 0, 0, true, false, t);
  tankFx(dt);
  garageCamera(dt, v.pos, true);
}
function garageCamera(dt, pos, fixed) {
  if (!pos) return;
  const t = performance.now() / 1000;
  const ang = fixed ? 0.9 : t * 0.25, d = 9.5;
  const cx = pos.x + Math.sin(ang) * d, cz = pos.z + Math.cos(ang) * d, cy = pos.y + 3.2;
  camera.camera.fov = BASE_FOV;
  camera.setPosition(cx, cy, cz);
  // shift the look target left so the tank lands in the right part of the screen
  const fxv = pos.x - cx, fzv = pos.z - cz, len = Math.hypot(fxv, fzv);
  const rx = -fzv / len, rz = fxv / len;   // camera right (on the ground plane)
  const aspect = (app.graphicsDevice.width || 16) / (app.graphicsDevice.height || 9);
  const k = d * Math.tan((BASE_FOV * Math.PI) / 360) * aspect * (innerWidth > 700 ? 0.42 : 0.38);
  camera.lookAt(pos.x - rx * k, pos.y + 1.0, pos.z - rz * k);
}

function lobbyCamera() {
  const t = performance.now() / 1000 * 0.08;
  camera.setPosition(Math.sin(t) * PIT_HALF * 1.1, 26, Math.cos(t) * PIT_HALF * 1.1);
  camera.lookAt(0, 2, 0);
}

// ------------------------------------------------------------------ shells
const shellEnts = new Map(), shellPool = [];
function drawShell(key, x, y, z, vx, vy, vz, owner, kind = 'shell') {
  const trail = tanks.get(owner)?.trail;
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
  if (kind === 'mega') { e.setLocalScale(0.8, 0.8, 3.4); e.render.material = mats.megaShell; fx.megaTrail(x, y, z); return; }
  if (kind === 'bounce') { e.setLocalScale(0.36, 0.36, 1.5); e.render.material = mats.bounceShell; fx.trail(x, y, z, false, mats.bouncePuff); return; }
  e.setLocalScale(0.28, 0.28, 1.9);
  e.render.material = trail?.shell || fx.m.shell;
  fx.trail(x, y, z, false, trail?.puff);
}
function freeShell(key, e) { e.enabled = false; shellEnts.delete(key); shellPool.push(e); }

function fireLocalShell(t, kind = 'shell', seq = t.shotSeq) {
  const m = projectile(t, kind);
  localShells.push({ seq, ...m, px: m.x, py: m.y, pz: m.z, acc: 0 });
  const sp = Math.hypot(m.vx, m.vy, m.vz);
  if (kind === 'mega') { fx.megaMuzzle(m.x, m.y, m.z, m.vx / sp, m.vy / sp, m.vz / sp); sound.megaFire(m, true); }
  else { fx.muzzle(m.x, m.y, m.z, m.vx / sp, m.vy / sp, m.vz / sp); sound.fire(m, true); }
  const v = tanks.get(myId); if (v) v.recoil = kind === 'mega' ? 2 : 1;
}
// remove a predicted shell; a mega cannon shell always ends in its big blast (drawn once)
function killLocalShell(q, boom = true, mega = false) {
  const i = localShells.findIndex((s) => s.seq === q);
  if (i < 0) return;
  const s = localShells[i];
  if (s.kind === 'mega' && (boom || mega || !megaShown.has(s.seq))) {
    if (!megaShown.has(s.seq)) { megaShown.add(s.seq); if (megaShown.size > 50) megaShown.delete(megaShown.values().next().value); fx.megaBlast(s.x, s.y, s.z, heightAt(world, s.x, s.z)); sound.bigBoom(s, 1.8); }
  } else if (boom) { fx.explosion(s.x, s.y, s.z, 1.6); sound.boom(s, 1); }
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
      const { hitGround, bounced } = stepShell(s, world);
      if (bounced) { fx.rico(s.x, s.y, s.z); sound.rico(s); }
      if (hitGround || s.life <= 0) { dead = true; if (hitGround) killLocalShell(s.seq, true); break; }
      for (const [id, v] of tanks) {   // visual-only hit; the server decides damage
        if (id === myId || !v.visible || sameTeam(id)) continue;
        if (segmentHitsTank(s, { x: v.pos.x, y: v.pos.y, z: v.pos.z })) { dead = true; break; }
      }
    }
    if (dead) { killLocalShell(s.seq, false, true); continue; }
    const f = s.acc / DT;
    drawShell(`l${s.seq}`, s.x + s.vx * DT * f, s.y + s.vy * DT * f, s.z + s.vz * DT * f, s.vx, s.vy, s.vz, myId, s.kind);
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
  const byKills = (a, b) => (lastScores.get(b.id) || 0) - (lastScores.get(a.id) || 0);
  const row = (r) => `<div class="${r.id === myId ? 'me' : ''} ${r.connected ? '' : 'off'}"><span class="dot" style="background:${colorCss(r.slot)}"></span>${r.bot ? '<span class="cpu">CPU</span>' : r.lv ? `<span class="lv">Lv${r.lv}</span>` : ''}${emblemSvg(r.look?.emblem, 12)}${escapeHtml(r.name)} <b>${lastScores.get(r.id) || 0}</b>${r.connected ? '' : ' (切断中)'}</div>`;
  let html;
  if (rules.mode === 'team') {
    html = [0, 1].map((t) => {
      const members = [...roster.values()].filter((r) => (r.team ?? 0) === t).sort(byKills);
      return `<div class="team-h" style="color:${rgb(TEAM_COLORS[t])}">${TEAM_NAMES[t]} <b>${teamKills[t]}</b>${t === myTeam ? '（味方）' : ''}</div>${members.map(row).join('') || '<div class="off">―</div>'}`;
    }).join('');
  } else html = [...roster.values()].sort(byKills).map(row).join('');
  html = `<div class="rules-h">${publicRoom ? `クイックマッチ・${qmLabel(rules)}` : rulesLabel(rules)}</div>${html}`;
  if ($('board').innerHTML !== html) $('board').innerHTML = html;
}
// HUD text for team colours is lightened so it stays readable on the bright desert
function rgb(c) { return `rgb(${c.map((v) => Math.round(Math.min(1, v * 0.6 + 0.4) * 255)).join(',')})`; }
function setRules(r) {
  const changed = JSON.stringify(r) !== JSON.stringify(rules);
  rules = cleanRules(r);
  if (changed) { updateBoard(); for (const id of [...tanks.keys()]) removeTank(id); }   // colours may change
}

// small segmented control for mode / goal / target (used in the lobby and in settings)
function rulesPicker(el, initial, onChange) {
  let cur = cleanRules(initial);
  el.innerHTML = `
    <div class="row"><span class="lbl">モード</span><button data-k="mode" data-v="ffa" type="button">個人戦</button><button data-k="mode" data-v="team" type="button">チーム戦</button></div>
    <div class="row"><span class="lbl">勝利条件</span><button data-k="goal" data-v="time" type="button">5分間で多く倒す</button><button data-k="goal" data-v="kills" type="button">先に</button>
      <select data-k="target">${KILL_TARGETS.map((n) => `<option value="${n}">${n}</option>`).join('')}</select><span class="lbl2">キル</span></div>
    <div class="row"><span class="lbl">CPU</span>${[0, 1, 2, 3].map((n) => `<button data-k="bots" data-v="${n}" type="button">${n ? `${n}体` : 'なし'}</button>`).join('')}</div>
    <div class="row cpu-lv"><span class="lbl">CPUの強さ</span><button data-k="botLevel" data-v="easy" type="button">よわい</button><button data-k="botLevel" data-v="normal" type="button">ふつう</button><button data-k="botLevel" data-v="hard" type="button">つよい</button></div>`;
  const paint = () => {
    el.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(String(cur[b.dataset.k]) === b.dataset.v)));
    el.querySelector('.cpu-lv').classList.toggle('dim', !cur.bots);
    const sel = el.querySelector('select'); sel.value = String(cur.target); sel.classList.toggle('dim', cur.goal !== 'kills');
  };
  el.querySelectorAll('button').forEach((b) => { b.onclick = () => { cur = cleanRules({ ...cur, [b.dataset.k]: b.dataset.v }); paint(); onChange(cur); }; });
  el.querySelector('select').onchange = (e) => { cur = cleanRules({ ...cur, target: Number(e.target.value), goal: 'kills' }); paint(); onChange(cur); };
  paint();
  return { get: () => cur, set: (r) => { cur = cleanRules(r); paint(); } };
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
function screenFlash(kind) { const el = $('flash'); el.className = ''; void el.offsetWidth; el.className = kind; }
function flashHitmark() { const h = $('hitmark'); h.classList.add('on'); setTimeout(() => h.classList.remove('on'), 60); }
function flashHeal() { const h = $('hpwrap'); h.classList.add('healed'); setTimeout(() => h.classList.remove('healed'), 700); }
let noticeTimer = 0;
function notice(html) { const n = $('notice'); n.innerHTML = html; n.classList.add('on'); clearTimeout(noticeTimer); noticeTimer = setTimeout(() => n.classList.remove('on'), 2600); }
function flashDamage() { const h = $('damage'); h.classList.add('on'); setTimeout(() => h.classList.remove('on'), 80); }
function showResult(res) {
  const list = Array.isArray(res) ? res : res.list;
  const w = res.winner || {};
  const title = w.draw ? '引き分け' : w.team !== undefined ? `${TEAM_NAMES[w.team]}の勝利！` : w.id ? `${escapeHtml(nameOf(w.id))} の勝利！` : '試合終了';
  const mine = w.team !== undefined ? w.team === myTeam : w.id === myId;
  sound.matchEnd(w.draw ? 'draw' : mine ? 'win' : 'lose');
  $('result-title').innerHTML = title + (w.draw ? '' : mine ? '<small>（あなたの勝ち）</small>' : '');
  $('result-teams').innerHTML = res.teams ? `<span style="color:${rgb(TEAM_COLORS[0])}">${TEAM_NAMES[0]} ${res.teams[0]}</span> − <span style="color:${rgb(TEAM_COLORS[1])}">${res.teams[1]} ${TEAM_NAMES[1]}</span>` : '';
  const ol = $('result-list');
  ol.innerHTML = list.map((p) => { const r = roster.get(p.id); return `<li><span class="dot" style="background:${colorCss(p.slot)}"></span>${r?.bot ? '<small class="cpu">CPU</small> ' : r?.lv ? `<small>Lv${r.lv}</small> ` : ''}${emblemSvg(r?.look?.emblem, 14)}${escapeHtml(p.name)} — ${p.kills} 撃破 / ${p.deaths} 被撃破</li>`; }).join('');
  pui.clearMatchProgress();
  $('result-next').textContent = '10秒後に次の試合が始まります';
  $('result').classList.remove('hidden');
  document.exitPointerLock?.();
}
let hudT = 0, waitLeft = 0;
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
  updateAbilityHud(t);
  $('shield-msg').classList.toggle('hidden', !(local.alive && local.invuln));
  if (local.alive && local.invuln) $('shield-msg').textContent = `無敵 ${local.invulnLeft.toFixed(1)}秒（撃つと解除）`;
  if (performance.now() > centerUntil) {
    let msg = '';
    if (phase === 'wait') msg = `対戦相手を探しています… ${waitLeft}\n（そのあいだ自由に走れます）`;
    else if (!local.alive && myId && phase === 'play') msg = `リスポーンまで ${local.respawnIn.toFixed(1)} 秒`;
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
// sidearm cooldown ring + special meter (PC: next to the HP bar, touch: the SUB / SP buttons)
function updateAbilityHud(t) {
  const S = SIDE[t?.side || loadout.side], U = ULT[t?.ultK || loadout.ult];
  const live = local.alive && !!t && phase === 'play';
  const sideK = t ? 1 - t.sideCd / S.cd : 1, ultK = t ? t.ult / ULT_MAX : 0;
  const sideReady = live && t.sideCd <= 0, ultReady = live && t.ult >= ULT_MAX;
  for (const [ids, k, ready, icon] of [[['ab-side', 'btn-side'], sideK, sideReady, S.icon], [['ab-ult', 'btn-ult'], ultK, ultReady, U.icon]]) {
    for (const id of ids) {
      const el = $(id), cd = k.toFixed(3);
      if (el.dataset.cd !== cd) { el.dataset.cd = cd; el.style.setProperty('--cd', cd); }
      el.classList.toggle('ready', ready);
      const ic = el.querySelector('.ic'); if (ic.textContent !== icon) ic.textContent = icon;
    }
  }
  const pct = `${Math.floor(ultK * 100)}%`, pe = $('ab-ult').querySelector('.pct'); if (pe.textContent !== pct) pe.textContent = pct;
  // ready pings (not on respawn / match start)
  if (sideReady && !abil.sideReady) sound.readyPing('side');
  if (ultReady && !abil.ultReady) { sound.readyPing('ult'); notice(`必殺技 ${U.icon} ${U.name} READY（${input.touchMode ? 'SPボタン' : 'Qキー'}）`); }
  abil.sideReady = sideReady || !live; abil.ultReady = ultReady || (!live && abil.ultReady);
}

// sidearm / special chooser (the lobby and the settings panel share one state)
function loadoutPicker(el) {
  const opt = (k, a) => `<button type="button" data-k="${k}" data-v="${a.id}"><b>${a.icon}</b>${a.name}</button>`;
  el.innerHTML = `<div class="lo-h">サイドアーム <small>（${document.body.classList.contains('touch') ? 'SUBボタン' : 'Eキー'}・クールダウン制）</small></div><div class="lo-opts">${SIDEARMS.map((a) => opt('side', a)).join('')}</div><p class="lo-desc" data-d="side"></p>
    <div class="lo-h">必殺技 <small>（${document.body.classList.contains('touch') ? 'SPボタン' : 'Qキー'}・ゲージ満タンで使える）</small></div><div class="lo-opts">${ULTS.map((a) => opt('ult', a)).join('')}</div><p class="lo-desc" data-d="ult"></p>`;
  const paint = () => {
    el.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(loadout[b.dataset.k] === b.dataset.v)));
    const S = SIDE[loadout.side], U = ULT[loadout.ult];
    el.querySelector('[data-d="side"]').innerHTML = `${escapeHtml(S.desc)}（クールダウン${S.cd}秒）<em>コツ：${escapeHtml(S.tip)}</em>`;
    el.querySelector('[data-d="ult"]').innerHTML = `${escapeHtml(U.desc)}<em>コツ：${escapeHtml(U.tip)}</em>`;
  };
  el.querySelectorAll('button').forEach((b) => { b.onclick = () => {
    loadout = cleanLoadout({ ...loadout, [b.dataset.k]: b.dataset.v });
    store.set('ht-loadout', JSON.stringify(loadout));
    room?.send('loadout', loadout);
    for (const p of loadoutPickers) p();
  }; });
  loadoutPickers.push(paint);
  paint();
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
    const ally = sameTeam(id);
    if (!ally && !lineOfSight(o.x, o.y, o.z, v.pos.x, v.pos.y + 1.6, v.pos.z)) continue;   // enemy tags hidden behind cover
    v.tag.style.display = 'block';
    v.tag.style.left = `${tmp.x}px`; v.tag.style.top = `${tmp.y}px`;
    const r = roster.get(id);
    const tk = `${ally}|${v.name}|${r?.lv}|${r?.bot}|${r?.look?.emblem}|${r?.look?.title}|${r?.look?.frame}|${r?.lo?.side}|${r?.lo?.ult}`;
    if (v.tagKey !== tk) {
      v.tagKey = tk;
      v.tag.className = `tag frame-${r?.look?.frame || 'none'}${ally ? ' ally' : ''}`;
      const ttl = titleName(r?.look?.title);
      v.tag.firstChild.innerHTML = `${ally ? '▼ ' : ''}${r?.bot ? '<span class="cpu">CPU</span>' : r?.lv ? `<span class="lv">Lv${r.lv}</span>` : ''}${emblemSvg(r?.look?.emblem, 12)}${escapeHtml(v.name || '')}${r?.lo ? `<span class="lo">${SIDE[r.lo.side]?.icon || ''}${ULT[r.lo.ult]?.icon || ''}</span>` : ''}${ttl ? `<span class="ttl">${escapeHtml(ttl)}</span>` : ''}`;
      v.tag.firstChild.style.color = colorCss(v.slot);
    }
    v.tag.querySelector('i').style.width = `${v.hp}%`;
  }
}
