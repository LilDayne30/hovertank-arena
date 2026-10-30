// One Durable Object = one match room (max 4 players). Owns the WebSockets, seat tokens and the
// 30 Hz game loop; all game rules live in shared/game.js.
import { DurableObject } from 'cloudflare:workers';
import { makeWorld } from '../shared/sim.js';
import { SPAWNS, MAX_PLAYERS, RECONNECT_SECONDS, applyObstacles, cleanRules } from '../shared/arena.js';
import { Game } from '../shared/game.js';
import { TOKEN_RE, profileKey, profileStub } from './profile.js';
import { statEvent } from './stats.js';
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
      matchEnd: (summary) => this.awardMatch(summary),
      phase: () => this.report(),   // quick match: tell the matchmaker when the room opens / closes
    }, { matchSeconds: Number(env.MATCH_SECONDS) || undefined, healInterval: Number(env.HEAL_SECONDS) || undefined, ultRate: Number(env.ULT_RATE) || undefined });
  }

  async fetch(request) {
    const url = new URL(request.url);
    this.roomId = request.headers.get('x-room-id') || this.roomId;
    if (this.created === undefined) {
      this.created = !!(await this.ctx.storage.get('created'));
      const saved = await this.ctx.storage.get('rules');
      if (saved && this.game.size === 0) this.game.setRules(saved);
      this.public = !!(await this.ctx.storage.get('public'));
      this.phrase = (await this.ctx.storage.get('phrase')) || null;
      this.game.autoFill = this.public;   // quick-match rooms: empty seats are filled with CPU players
    }

    if (url.pathname === '/init') {
      let rules = null, isPublic = false;
      try { const b = await request.json(); rules = b?.rules ?? null; isPublic = !!b?.public; } catch { /* default rules */ }
      rules = cleanRules(rules);
      this.public = isPublic;
      this.game.autoFill = isPublic;
      this.game.setRules(rules);
      await this.ctx.storage.put({ created: true, rules, public: isPublic });
      this.created = true;
      await this.ctx.storage.setAlarm(Date.now() + CLEANUP_MS);
      return json({ ok: true });
    }
    // passphrase room: join it if someone is (or is about to be) inside, otherwise (re)make it with these rules
    if (url.pathname === '/claim') {
      let b = {};
      try { b = await request.json(); } catch { /* ignore */ }
      const busy = this.created && (this.game.humans > 0 || Date.now() - (this.claimedAt || 0) < 15000);
      if (busy) {
        if (this.game.isFull()) return json({ error: 'full', rules: this.game.rules }, 409);
        return json({ created: false, rules: this.game.rules, players: this.game.humans });
      }
      const rules = cleanRules(b.rules);
      this.public = false; this.game.autoFill = false; this.phrase = typeof b.phrase === 'string' ? b.phrase.slice(0, 32) : null;
      this.game.setRules(rules);
      await this.ctx.storage.put({ created: true, rules, public: false, phrase: this.phrase });
      this.created = true; this.claimedAt = Date.now();
      await this.ctx.storage.setAlarm(Date.now() + CLEANUP_MS);
      return json({ created: true, rules, players: 0 });
    }
    if (url.pathname === '/info') {
      if (!this.created) return json({ exists: false }, 404);
      return json({ exists: true, players: this.game.humans, bots: this.game.botCount, max: MAX_PLAYERS, full: this.game.isFull(), rules: this.game.rules, public: !!this.public });
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
      // joins from quick match only while the room is gathering players or between matches
      // (an invite link still lets a friend in at any time)
      if (url.searchParams.get('qm') && this.game.humans > 0 && !this.game.open) return this.reject(ws, 'full', 4001, 'この部屋は試合中です');
      id = rand(4);
      const t = rand(12);
      this.tokens.set(t, id);
      this.game.addPlayer(id, url.searchParams.get('name') || '');
      myToken = t;
    }
    this.sockets.set(id, ws);
    this.startLoop();
    this.ctx.storage.deleteAlarm();
    ws.send(JSON.stringify(['welcome', this.game.welcome(id, { token: myToken, roomId: this.roomId, reconnected, public: !!this.public, phrase: this.phrase || undefined })]));
    if (!reconnected) this.report();
    this.game.sendRoster();

    ws.addEventListener('message', (ev) => {
      if (this.sockets.get(id) !== ws) return;
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (!Array.isArray(msg)) return;
      const [type, data] = msg;
      if (type === 'i') this.game.onInput(id, data);
      else if (type === 'ping') ws.send(JSON.stringify(['pong', data]));
      else if (type === 'name') this.game.onName(id, data);
      else if (type === 'newgame') {
        // quick-match rooms keep their rules (the matchmaker sorts players by them); new game just restarts
        const rules = !this.public && data && typeof data === 'object' ? data.rules : null;
        this.game.onNewGame(id, rules);
        this.ctx.storage.put('rules', this.game.rules);
      }
      else if (type === 'team') this.game.onSwitchTeam(id);
      else if (type === 'ready') this.game.onReady(id);
      else if (type === 'nextrules') { if (!this.public && data && typeof data === 'object') { this.game.onNextRules(id, data.rules); this.ctx.storage.put('rules', this.game.rules); } }
      else if (type === 'prof') this.attachProfile(id, data);
      else if (type === 'loadout') this.game.onLoadout(id, data);
      else if (type === 'look') { const p = this.game.players.get(id); if (p?.prof) this.attachProfile(id, null, p.prof.key); }
      else if (type === 'leave') this.drop(id, ws, true);
    });
    const onGone = () => this.drop(id, ws, false);
    ws.addEventListener('close', onGone);
    ws.addEventListener('error', onGone);
  }

  // the client sends its profile token once after joining; the room only keeps the hashed key
  async attachProfile(id, token, key) {
    if (!this.env.PROFILES) return;
    try {
      if (!key) { if (typeof token !== 'string' || !TOKEN_RE.test(token)) return; key = await profileKey(token); }
      const b = await (await profileStub(this.env, key).fetch('https://profile/brief')).json();
      if (this.game.players.has(id)) this.game.setProfile(id, { key, lv: b.lv, look: b.look });
    } catch (e) { console.warn('profile', e?.message); }
  }

  // match over: report every player's stats to their profile and send them what they earned
  awardMatch(summary) {
    if (!this.env.PROFILES) return;
    const matchId = `${this.roomId}:${this.startedAt || (this.startedAt = Date.now())}:${summary.matchNo}`;
    const humans = summary.players.filter((e) => !e.bot);
    const results = new Map();
    const jobs = [];
    for (const e of summary.players) {
      if (!e.prof?.key) continue;
      const req = profileStub(this.env, e.prof.key).fetch('https://profile/award', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ matchId, stats: e.stats, ctx: e.ctx }),
      }).then((r) => r.json()).then((res) => {
        results.set(e.id, res);
        this.sendTo(e.id, 'prog', res);
        const p = this.game.players.get(e.id);
        if (p?.prof && res.after && res.after.level !== p.prof.lv) this.game.setProfile(e.id, { ...p.prof, lv: res.after.level });
      }).catch((err) => console.warn('award', err?.message));
      this.ctx.waitUntil?.(req);
      jobs.push(req);
    }
    // owner's statistics (anonymous profile keys only)
    if (humans.length) {
      const r = this.game.rules;
      const kind = this.public ? (r.mode === 'team' ? 'quick-team' : `quick-${r.size}`) : `private-${r.mode}`;
      const send = Promise.allSettled(jobs).then(() => statEvent(this.env, this.ctx, {
        type: 'match', kind, humans: humans.length, bots: summary.players.length - humans.length, seconds: summary.seconds,
        players: humans.map((e) => {
          const res = results.get(e.id);
          return { pkey: e.prof?.key, minutes: e.ctx.minutes, lv: res?.after?.level || e.prof?.lv, missions: res?.missions?.length || 0, titles: res?.ach?.length || 0 };
        }),
      }));
      this.ctx.waitUntil?.(send);
    }
  }

  drop(id, ws, consented) {
    if (this.sockets.get(id) !== ws) return;      // an old socket that was already replaced
    this.sockets.delete(id);
    if (consented) { this.forget(id); return; }
    this.game.setConnected(id, false);
    this.holds.set(id, setTimeout(() => this.forget(id), RECONNECT_SECONDS * 1000));
  }

  // tell the matchmaker how many players this public room has (0 = remove it from the list)
  report() {
    statEvent(this.env, this.ctx, { type: 'room', roomId: this.roomId, humans: this.game.humans, public: !!this.public });
    if (!this.public || !this.env.MATCH) return;
    const players = this.game.humans;   // CPU players don't count: they leave when people arrive
    this.env.MATCH.get(this.env.MATCH.idFromName('global')).fetch('https://mm/update', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: this.roomId, players, mode: this.game.rules.mode, size: this.game.rules.size, goal: this.game.rules.goal, target: this.game.rules.target, open: players === 0 || this.game.open }),
    }).catch(() => {});
  }

  forget(id) {
    clearTimeout(this.holds.get(id)); this.holds.delete(id);
    for (const [t, pid] of this.tokens) if (pid === id) this.tokens.delete(t);
    this.game.removePlayer(id);
    this.report();
    if (this.game.size === 0) {
      clearInterval(this.loop); this.loop = null;
      this.ctx.storage.setAlarm(Date.now() + CLEANUP_MS);
    }
  }

  startLoop() {
    if (this.loop) return;
    let last = Date.now(), lastReport = Date.now();
    this.loop = setInterval(() => {
      if (Date.now() - lastReport > 60000) { lastReport = Date.now(); this.report(); }   // heartbeat for the matchmaker
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
