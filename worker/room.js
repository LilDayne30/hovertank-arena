// One Durable Object = one match room (max 4 players). Owns the WebSockets, seat tokens and the
// 30 Hz game loop; all game rules live in shared/game.js.
import { DurableObject } from 'cloudflare:workers';
import { makeWorld } from '../shared/sim.js';
import { SPAWNS, MAX_PLAYERS, RECONNECT_SECONDS, applyObstacles } from '../shared/arena.js';
import { Game } from '../shared/game.js';
import meta from '../public/assets/arena_hf.json';
import heights from '../public/assets/arena_hf.bin';

const world = makeWorld(meta, new Float32Array(heights));
world.spawns = SPAWNS;
applyObstacles(world);   // cover objects are part of the collision heightfield
const CLEANUP_MS = 30 * 60 * 1000;   // forget an empty room after 30 min

const rand = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, n * 2);
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

export class BattleRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.roomId = null;
    this.created = undefined;
    this.sockets = new Map();   // playerId -> WebSocket
    this.tokens = new Map();    // token -> playerId
    this.holds = new Map();     // playerId -> timeout handle (seat kept for reconnection)
    this.loop = null;
    this.game = new Game(world, {
      send: (id, type, data) => this.sendTo(id, type, data),
      broadcast: (type, data) => this.broadcast(type, data),
    }, { matchSeconds: Number(env.MATCH_SECONDS) || undefined, healInterval: Number(env.HEAL_SECONDS) || undefined });
  }

  async fetch(request) {
    const url = new URL(request.url);
    this.roomId = request.headers.get('x-room-id') || this.roomId;
    if (this.created === undefined) this.created = !!(await this.ctx.storage.get('created'));

    if (url.pathname === '/init') {
      await this.ctx.storage.put('created', true);
      this.created = true;
      await this.ctx.storage.setAlarm(Date.now() + CLEANUP_MS);
      return json({ ok: true });
    }
    if (url.pathname === '/info') {
      if (!this.created) return json({ exists: false }, 404);
      return json({ exists: true, players: this.game.size, max: MAX_PLAYERS, full: this.game.isFull() });
    }
    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
      const { 0: client, 1: server } = new WebSocketPair();
      server.accept();
      this.onConnect(server, url);
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response('not found', { status: 404 });
  }

  reject(ws, code, closeCode, message) {
    try { ws.send(JSON.stringify(['error', { code, message }])); ws.close(closeCode, code); } catch { /* ignore */ }
  }

  onConnect(ws, url) {
    if (!this.created) return this.reject(ws, 'notfound', 4004, '部屋が見つかりません');
    const token = url.searchParams.get('token');
    let id = token && this.tokens.get(token);
    let reconnected = false;
    let myToken = token;

    if (id && this.game.players.has(id)) {
      // same seat: replace the old socket (if any) and cancel the seat-expiry timer
      const old = this.sockets.get(id);
      if (old && old !== ws) { this.sockets.delete(id); try { old.close(4000, 'replaced'); } catch { /* ignore */ } }
      clearTimeout(this.holds.get(id)); this.holds.delete(id);
      this.game.setConnected(id, true);
      reconnected = true;
    } else if (token && !url.searchParams.get('name') && !this.game.players.has(id)) {
      return this.reject(ws, 'expired', 4004, '再接続の期限が切れました');
    } else {
      if (this.game.isFull()) return this.reject(ws, 'full', 4001, 'この部屋は満室です');
      id = rand(4);
      const t = rand(12);
      this.tokens.set(t, id);
      this.game.addPlayer(id, url.searchParams.get('name') || '');
      myToken = t;
    }
    this.sockets.set(id, ws);
    this.startLoop();
    this.ctx.storage.deleteAlarm();
    ws.send(JSON.stringify(['welcome', this.game.welcome(id, { token: myToken, roomId: this.roomId, reconnected })]));
    this.game.sendRoster();

    ws.addEventListener('message', (ev) => {
      if (this.sockets.get(id) !== ws) return;
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (!Array.isArray(msg)) return;
      const [type, data] = msg;
      if (type === 'i') this.game.onInput(id, data);
      else if (type === 'ping') ws.send(JSON.stringify(['pong', data]));
      else if (type === 'name') this.game.onName(id, data);
      else if (type === 'newgame') this.game.onNewGame(id);
      else if (type === 'leave') this.drop(id, ws, true);
    });
    const onGone = () => this.drop(id, ws, false);
    ws.addEventListener('close', onGone);
    ws.addEventListener('error', onGone);
  }

  drop(id, ws, consented) {
    if (this.sockets.get(id) !== ws) return;      // an old socket that was already replaced
    this.sockets.delete(id);
    if (consented) { this.forget(id); return; }
    this.game.setConnected(id, false);
    this.holds.set(id, setTimeout(() => this.forget(id), RECONNECT_SECONDS * 1000));
  }

  forget(id) {
    clearTimeout(this.holds.get(id)); this.holds.delete(id);
    for (const [t, pid] of this.tokens) if (pid === id) this.tokens.delete(t);
    this.game.removePlayer(id);
    if (this.game.size === 0) {
      clearInterval(this.loop); this.loop = null;
      this.ctx.storage.setAlarm(Date.now() + CLEANUP_MS);
    }
  }

  startLoop() {
    if (this.loop) return;
    let last = Date.now();
    this.loop = setInterval(() => {
      const now = Date.now();
      this.game.update((now - last) / 1000);
      last = now;
    }, 16);
  }

  async alarm() {
    if (this.game.size === 0) { await this.ctx.storage.deleteAll(); this.created = false; }
  }

  sendTo(id, type, data) {
    const ws = this.sockets.get(id);
    if (ws) try { ws.send(JSON.stringify([type, data])); } catch { /* ignore */ }
  }

  broadcast(type, data) {
    const s = JSON.stringify([type, data]);
    for (const ws of this.sockets.values()) try { ws.send(s); } catch { /* ignore */ }
  }
}
