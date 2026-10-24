import { Room, CloseCode } from '@colyseus/core';
import {
  C, DT, newTank, stepTank, cleanInput, muzzle, stepShell, segmentHitsTank, separateTanks, heightAt,
} from '../shared/sim.js';
import { MATCH_SECONDS as DEFAULT_MATCH, RESULT_SECONDS, RECONNECT_SECONDS, MAX_PLAYERS } from '../shared/arena.js';

const MATCH_SECONDS = Number(process.env.MATCH_SECONDS) || DEFAULT_MATCH;   // env override for tests
import { loadWorld } from './world.js';

const world = loadWorld();
const r3 = (v) => Math.round(v * 1000) / 1000;
const MAX_QUEUE = 20;
const MAX_BURST = 6;
const IDLE = { seq: 0, mx: 0, mz: 0, ay: 0, ap: 0, j: false, d: false, f: false };

export class BattleRoom extends Room {
  maxClients = MAX_PLAYERS;
  patchRate = null;          // no schema state; we broadcast our own snapshots
  autoDispose = true;

  messages = {
    // batch of inputs: [{seq,mx,mz,ay,ap,j,d,f}, ...]
    i: (client, batch) => {
      const p = this.players.get(client.sessionId);
      if (!p || !Array.isArray(batch)) return;
      for (const raw of batch.slice(0, MAX_QUEUE)) {
        const inp = cleanInput(raw || {});
        if (inp.seq <= p.lastQueued) continue;          // duplicate / out of order
        p.lastQueued = inp.seq;
        p.queue.push(inp);
      }
      // a client cannot bank more than MAX_QUEUE ticks of input (prevents speed hacks)
      while (p.queue.length > MAX_QUEUE) { p.queue.shift(); p.dropped++; }
    },
    name: (client, name) => {
      const p = this.players.get(client.sessionId);
      if (p) { p.name = sanitizeName(name) || p.name; this.sendRoster(); }
    },
    ping: (client, t) => client.send('pong', t),
  };

  onCreate() {
    this.players = new Map();
    this.shells = [];
    this.shellId = 1;
    this.tick = 0;
    this.time = 0;
    this.phase = 'play';
    this.phaseEnds = MATCH_SECONDS;
    this.acc = 0;
    this.setPrivate(true);   // only reachable via invite (room id)
    this.lastNow = performance.now();
    this.setTimestep(() => { const now = performance.now(); this.update((now - this.lastNow) / 1000); this.lastNow = now; }, 1000 / 60);
  }

  onJoin(client, options) {
    const used = new Set([...this.players.values()].map((p) => p.slot));
    let slot = 0; while (used.has(slot)) slot++;
    const p = {
      id: client.sessionId, slot,
      name: sanitizeName(options?.name) || `Player ${slot + 1}`,
      tank: null, hp: C.maxHp, alive: false, respawnAt: 0, invulnUntil: 0,
      kills: 0, deaths: 0,
      queue: [], lastSeq: 0, lastQueued: 0, lastInput: { ...IDLE }, dropped: 0,
      connected: true,
    };
    this.players.set(client.sessionId, p);
    this.spawn(p);
    client.send('welcome', { id: p.id, slot, tick: this.tick, phase: this.phase, roomId: this.roomId });
    this.sendRoster();
  }

  onDrop(client) {
    const p = this.players.get(client.sessionId);
    if (p) { p.connected = false; p.queue.length = 0; this.sendRoster(); }
    this.allowReconnection(client, RECONNECT_SECONDS);
  }

  onReconnect(client) {
    const p = this.players.get(client.sessionId);
    if (!p) return;
    p.connected = true;
    p.lastQueued = 0; p.queue.length = 0;
    client.send('welcome', { id: p.id, slot: p.slot, tick: this.tick, phase: this.phase, roomId: this.roomId, reconnected: true });
    this.sendRoster();
  }

  onLeave(client) {
    this.players.delete(client.sessionId);
    this.sendRoster();
  }

  // ------------------------------------------------------------------ simulation
  update(dt) {
    this.acc += Math.min(dt, 0.25);
    let steps = 0;
    while (this.acc >= DT && steps < 5) { this.acc -= DT; this.step(); steps++; }
  }

  step() {
    this.tick++;
    this.time += DT;
    const events = [];

    // match phases
    if (this.time >= this.phaseEnds) {
      if (this.phase === 'play') {
        this.phase = 'end'; this.phaseEnds = this.time + RESULT_SECONDS;
        this.shells.length = 0;
        this.broadcast('result', this.scoreboard());
      } else {
        this.phase = 'play'; this.phaseEnds = this.time + MATCH_SECONDS;
        for (const p of this.players.values()) { p.kills = 0; p.deaths = 0; this.spawn(p); }
        this.sendRoster();
      }
    }

    // tanks
    for (const p of this.players.values()) {
      if (!p.alive) {
        if (p.queue.length) { p.lastSeq = p.queue[p.queue.length - 1].seq; p.queue.length = 0; }
        p.credits = 0;
        if (p.connected && this.phase === 'play' && this.time >= p.respawnAt) this.spawn(p);
        continue;
      }
      if (!p.connected) continue;   // frozen & invisible while waiting for reconnection
      // The tank only advances on inputs actually received, so the server replays exactly the
      // client's timeline (prediction stays exact). A credit bucket caps the rate at real time:
      // +1 credit per tick, bursts of up to MAX_BURST late inputs are allowed to catch up.
      p.credits = Math.min(MAX_BURST, (p.credits || 0) + 1);
      while (p.credits >= 1 && p.queue.length) {
        p.credits -= 1;
        let inp = p.queue.shift();
        p.lastInput = inp; p.lastSeq = inp.seq;
        if (this.phase !== 'play') inp = { ...inp, f: false };
        const ev = stepTank(p.tank, inp, world);
        if (ev.fired) {
          const m = muzzle(p.tank);
          this.shells.push({ id: this.shellId++, owner: p.id, seq: p.tank.shotSeq, ...m, life: C.shellLife });
        }
      }
    }

    // tank-vs-tank
    const alive = [...this.players.values()].filter((p) => p.alive && p.connected);
    for (let a = 0; a < alive.length; a++) for (let b = a + 1; b < alive.length; b++) separateTanks(alive[a].tank, alive[b].tank);

    // shells
    for (let i = this.shells.length - 1; i >= 0; i--) {
      const s = this.shells[i];
      const { hitGround } = stepShell(s, world);
      let dead = hitGround || s.life <= 0;
      if (!dead) {
        for (const p of alive) {
          if (p.id === s.owner || !segmentHitsTank(s, p.tank)) continue;
          dead = true;
          if (this.time < p.invulnUntil) { events.push({ t: 'shield', o: s.owner, q: s.seq, v: p.id, x: r3(s.x), y: r3(s.y), z: r3(s.z) }); break; }
          p.hp -= C.damage;
          events.push({ t: 'hit', s: s.id, o: s.owner, q: s.seq, v: p.id, hp: Math.max(0, p.hp), x: r3(s.x), y: r3(s.y), z: r3(s.z) });
          if (p.hp <= 0) this.kill(p, s.owner, events);
          break;
        }
      }
      if (dead) {
        if (hitGround || s.life <= 0) events.push({ t: 'boom', s: s.id, o: s.owner, q: s.seq, x: r3(s.x), y: r3(s.y), z: r3(s.z) });
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
    events.push({ t: 'kill', k: killerId, v: p.id, x: r3(p.tank.x), y: r3(p.tank.y), z: r3(p.tank.z) });
  }

  spawn(p) {
    // farthest spawn from other living tanks
    let best = world.spawns[p.slot % world.spawns.length], bestD = -1;
    const others = [...this.players.values()].filter((o) => o !== p && o.alive && o.tank);
    if (others.length) {
      for (const s of world.spawns) {
        const d = Math.min(...others.map((o) => Math.hypot(o.tank.x - s.x, o.tank.z - s.z)));
        if (d > bestD) { bestD = d; best = s; }
      }
    }
    const t = newTank(best.x, best.z, best.yaw, heightAt(world, best.x, best.z));
    if (p.tank) t.shotSeq = p.tank.shotSeq;
    p.tank = t;
    p.hp = C.maxHp; p.alive = true;
    p.invulnUntil = this.time + C.spawnInvuln;
    p.spawnId = (p.spawnId || 0) + 1;    // lets the client snap instead of reconciling
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
    const B = this.shells.map((s) => [s.id, s.owner, s.seq, r3(s.x), r3(s.y), r3(s.z), r3(s.vx), r3(s.vy), r3(s.vz)]);
    this.broadcast('s', { k: this.tick, ph: this.phase, tl: Math.max(0, Math.round(this.phaseEnds - this.time)), p: P, b: B, e: events });
  }

  scoreboard() {
    return [...this.players.values()]
      .map((p) => ({ id: p.id, name: p.name, slot: p.slot, kills: p.kills, deaths: p.deaths }))
      .sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
  }

  sendRoster() {
    this.broadcast('roster', [...this.players.values()].map((p) => ({ id: p.id, name: p.name, slot: p.slot, connected: p.connected })));
  }
}

function sanitizeName(n) {
  if (typeof n !== 'string') return '';
  return n.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 12);
}

export { CloseCode };
