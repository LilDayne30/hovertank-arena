// Authoritative match logic, independent of the network layer.
// The Cloudflare Durable Object (worker/room.js) owns sockets and calls into this class.
import {
  C, DT, newTank, stepTank, cleanInput, muzzle, stepShell, segmentHitsTank, separateTanks, heightAt,
} from './sim.js';
import { MATCH_SECONDS, RESULT_SECONDS, MAX_PLAYERS } from './arena.js';

const r3 = (v) => Math.round(v * 1000) / 1000;
const r2 = (v) => Math.round(v * 100) / 100;
export const MAX_QUEUE = 20;   // inputs a client may bank (anti speed-hack)
const MAX_BURST = 6;           // late inputs processed in one tick to catch up

export function sanitizeName(n) {
  if (typeof n !== 'string') return '';
  return n.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 12);
}

export class Game {
  /**
   * @param world heightfield world (shared/sim.js makeWorld) with .spawns
   * @param io { send(id, type, data), broadcast(type, data) }
   */
  constructor(world, io, opts = {}) {
    this.world = world;
    this.io = io;
    this.matchSeconds = opts.matchSeconds || MATCH_SECONDS;
    this.players = new Map();
    this.shells = [];
    this.shellId = 1;
    this.tick = 0;
    this.time = 0;
    this.phase = 'play';
    this.phaseEnds = this.matchSeconds;
    this.acc = 0;
  }

  get size() { return this.players.size; }
  isFull() { return this.players.size >= MAX_PLAYERS; }

  addPlayer(id, name) {
    const used = new Set([...this.players.values()].map((p) => p.slot));
    let slot = 0; while (used.has(slot)) slot++;
    const p = {
      id, slot, name: sanitizeName(name) || `Player ${slot + 1}`,
      tank: null, hp: C.maxHp, alive: false, respawnAt: 0, invulnUntil: 0,
      kills: 0, deaths: 0, queue: [], lastSeq: 0, lastQueued: 0, credits: 0, dropped: 0,
      connected: true, spawnId: 0,
    };
    // a fresh match starts when the first player arrives in an empty room
    if (this.players.size === 0) this.resetMatch();
    this.players.set(id, p);
    this.spawn(p);
    this.sendRoster();
    return p;
  }

  removePlayer(id) {
    this.players.delete(id);
    this.shells = this.shells.filter((s) => s.owner !== id);
    this.sendRoster();
  }

  setConnected(id, on) {
    const p = this.players.get(id);
    if (!p) return;
    p.connected = on;
    p.queue.length = 0;
    p.lastQueued = 0;
    this.sendRoster();
  }

  welcome(id, extra = {}) {
    const p = this.players.get(id);
    return { id: p.id, slot: p.slot, tick: this.tick, phase: this.phase, ...extra };
  }

  onInput(id, batch) {
    const p = this.players.get(id);
    if (!p || !Array.isArray(batch)) return;
    for (const raw of batch.slice(0, MAX_QUEUE)) {
      const inp = cleanInput(raw || {});
      if (inp.seq <= p.lastQueued) continue;            // duplicate / out of order
      p.lastQueued = inp.seq;
      p.queue.push(inp);
    }
    while (p.queue.length > MAX_QUEUE) { p.queue.shift(); p.dropped++; }
  }

  onName(id, name) {
    const p = this.players.get(id);
    if (p) { p.name = sanitizeName(name) || p.name; this.sendRoster(); }
  }

  resetMatch() {
    this.phase = 'play';
    this.phaseEnds = this.time + this.matchSeconds;
    this.shells.length = 0;
    for (const p of this.players.values()) { p.kills = 0; p.deaths = 0; this.spawn(p); }
  }

  // advance real time (seconds); runs whole fixed ticks
  update(dt) {
    this.acc += Math.min(dt, 0.25);
    let steps = 0;
    while (this.acc >= DT && steps < 5) { this.acc -= DT; this.step(); steps++; }
  }

  step() {
    const w = this.world;
    this.tick++;
    this.time += DT;
    const events = [];

    if (this.time >= this.phaseEnds) {
      if (this.phase === 'play') {
        this.phase = 'end'; this.phaseEnds = this.time + RESULT_SECONDS;
        this.shells.length = 0;
        this.io.broadcast('result', this.scoreboard());
      } else {
        this.resetMatch();
        this.sendRoster();
      }
    }

    for (const p of this.players.values()) {
      if (!p.alive) {
        if (p.queue.length) { p.lastSeq = p.queue[p.queue.length - 1].seq; p.queue.length = 0; }
        p.credits = 0;
        if (p.connected && this.phase === 'play' && this.time >= p.respawnAt) this.spawn(p);
        continue;
      }
      if (!p.connected) continue;   // frozen & invisible while its seat is held for reconnection
      // The tank only advances on inputs actually received, so the server replays exactly the
      // client's timeline (prediction stays exact). The credit bucket caps the rate at real time.
      p.credits = Math.min(MAX_BURST, p.credits + 1);
      while (p.credits >= 1 && p.queue.length) {
        p.credits -= 1;
        let inp = p.queue.shift();
        p.lastSeq = inp.seq;
        if (this.phase !== 'play') inp = { ...inp, f: false };
        const ev = stepTank(p.tank, inp, w);
        if (ev.fired) this.shells.push({ id: this.shellId++, owner: p.id, seq: p.tank.shotSeq, ...muzzle(p.tank), life: C.shellLife });
      }
    }

    const alive = [...this.players.values()].filter((p) => p.alive && p.connected);
    for (let a = 0; a < alive.length; a++) for (let b = a + 1; b < alive.length; b++) separateTanks(alive[a].tank, alive[b].tank);

    for (let i = this.shells.length - 1; i >= 0; i--) {
      const s = this.shells[i];
      const { hitGround } = stepShell(s, w);
      let dead = hitGround || s.life <= 0;
      if (!dead) {
        for (const p of alive) {
          if (p.id === s.owner || !segmentHitsTank(s, p.tank)) continue;
          dead = true;
          if (this.time < p.invulnUntil) { events.push({ t: 'shield', o: s.owner, q: s.seq, v: p.id, x: r2(s.x), y: r2(s.y), z: r2(s.z) }); break; }
          p.hp -= C.damage;
          events.push({ t: 'hit', s: s.id, o: s.owner, q: s.seq, v: p.id, hp: Math.max(0, p.hp), x: r2(s.x), y: r2(s.y), z: r2(s.z) });
          if (p.hp <= 0) this.kill(p, s.owner, events);
          break;
        }
      }
      if (dead) {
        if (hitGround || s.life <= 0) events.push({ t: 'boom', s: s.id, o: s.owner, q: s.seq, x: r2(s.x), y: r2(s.y), z: r2(s.z) });
        this.shells.splice(i, 1);
      }
    }
    this.broadcastSnapshot(events);
  }

  kill(p, killerId, events) {
    p.alive = false; p.hp = 0; p.deaths++;
    p.respawnAt = this.time + C.respawnTime;
    const k = this.players.get(killerId);
    if (k) k.kills++;
    events.push({ t: 'kill', k: killerId, v: p.id, x: r2(p.tank.x), y: r2(p.tank.y), z: r2(p.tank.z) });
  }

  spawn(p) {
    const w = this.world;
    let best = w.spawns[p.slot % w.spawns.length], bestD = -1;
    const others = [...this.players.values()].filter((o) => o !== p && o.alive && o.tank);
    if (others.length) {
      for (const s of w.spawns) {
        const d = Math.min(...others.map((o) => Math.hypot(o.tank.x - s.x, o.tank.z - s.z)));
        if (d > bestD) { bestD = d; best = s; }
      }
    }
    const t = newTank(best.x, best.z, best.yaw, heightAt(w, best.x, best.z));
    if (p.tank) t.shotSeq = p.tank.shotSeq;
    p.tank = t;
    p.hp = C.maxHp; p.alive = true;
    p.invulnUntil = this.time + C.spawnInvuln;
    p.spawnId++;
  }

  broadcastSnapshot(events) {
    const P = [];
    for (const p of this.players.values()) {
      const t = p.tank;
      const flags = (p.alive ? 1 : 0) | (t.grounded ? 2 : 0) | (this.time < p.invulnUntil ? 4 : 0) | (p.connected ? 8 : 0);
      P.push([p.id, r3(t.x), r3(t.y), r3(t.z), r3(t.vx), r3(t.vy), r3(t.vz), r3(t.yaw), r3(t.aimYaw), r3(t.aimPitch),
        p.hp, flags, p.lastSeq, r3(t.cooldown), t.shotSeq, p.kills, p.deaths, p.spawnId,
        p.alive ? 0 : Math.max(0, Math.round((p.respawnAt - this.time) * 10) / 10)]);
    }
    const B = this.shells.map((s) => [s.id, s.owner, s.seq, r2(s.x), r2(s.y), r2(s.z), r2(s.vx), r2(s.vy), r2(s.vz)]);
    this.io.broadcast('s', { k: this.tick, ph: this.phase, tl: Math.max(0, Math.round(this.phaseEnds - this.time)), p: P, b: B, e: events });
  }

  scoreboard() {
    return [...this.players.values()]
      .map((p) => ({ id: p.id, name: p.name, slot: p.slot, kills: p.kills, deaths: p.deaths }))
      .sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
  }

  sendRoster() {
    this.io.broadcast('roster', [...this.players.values()].map((p) => ({ id: p.id, name: p.name, slot: p.slot, connected: p.connected })));
  }
}
