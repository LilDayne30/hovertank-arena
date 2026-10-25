// Authoritative match logic, independent of the network layer.
// The Cloudflare Durable Object (worker/room.js) owns sockets and calls into this class.
import {
  C, DT, newTank, stepTank, cleanInput, muzzle, stepShell, segmentHitsTank, separateTanks, heightAt, depenetrate,
} from './sim.js';
import { MATCH_SECONDS, RESULT_SECONDS, MAX_PLAYERS, HEAL_INTERVAL, HEAL_RADIUS, HEAL_POS, TEAM_SPAWNS, DEFAULT_RULES, KILLS_TIME_CAP, cleanRules } from './arena.js';

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
    this.healInterval = opts.healInterval || HEAL_INTERVAL;
    this.heal = { active: false, nextAt: this.healInterval };
    this.queuedEvents = [];      // events raised outside step() (e.g. new game), sent with the next snapshot
    this.rules = cleanRules(opts.rules || DEFAULT_RULES);
    this.winner = null;
  }

  get teamMode() { return this.rules.mode === 'team'; }
  setRules(r) { this.rules = cleanRules(r); if (this.teamMode) this.balanceTeams(); }

  // colour index: free-for-all = seat; teams = red/orange vs blue/cyan
  colorOf(p) {
    if (!this.teamMode) return p.slot;
    const mates = [...this.players.values()].filter((o) => o.team === p.team).sort((a, b) => a.slot - b.slot);
    const second = mates.indexOf(p) % 2 === 1;
    return p.team === 0 ? (second ? 4 : 0) : (second ? 5 : 1);
  }

  smallerTeam(except) {
    const n = [0, 0];
    for (const o of this.players.values()) if (o !== except) n[o.team]++;
    return n[1] < n[0] ? 1 : 0;
  }

  balanceTeams() {
    const list = [...this.players.values()].sort((a, b) => a.slot - b.slot);
    list.forEach((p, i) => { p.team = i % 2; });
  }

  teamKills() {
    const k = [0, 0];
    for (const p of this.players.values()) k[p.team] += p.kills;
    return k;
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
      connected: true, spawnId: 0, team: 0,
    };
    // a fresh match starts when the first player arrives in an empty room
    if (this.players.size === 0) this.resetMatch();
    p.team = this.smallerTeam(p);
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
    return { id: p.id, slot: this.colorOf(p), team: p.team, tick: this.tick, phase: this.phase, rules: this.rules, ...extra };
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
    this.winner = null;
    this.phaseEnds = this.time + (this.rules.goal === 'kills' ? KILLS_TIME_CAP : this.matchSeconds);
    this.shells.length = 0;
    this.heal = { active: false, nextAt: this.time + this.healInterval };
    for (const p of this.players.values()) { p.kills = 0; p.deaths = 0; this.spawn(p); }
  }

  // any player can start a new game (optionally with new rules): scores, timer and positions reset
  onNewGame(id, rules) {
    const p = this.players.get(id);
    if (!p || this.time - (this.lastNewGame ?? -99) < 3) return;   // ignore double taps
    this.lastNewGame = this.time;
    if (rules) this.setRules(rules);
    this.resetMatch();
    this.queuedEvents.push({ t: 'newgame', by: id, rules: this.rules });
    this.sendRoster();
  }

  // team mode: switch to the other team (respawns on that team's side)
  onSwitchTeam(id) {
    const p = this.players.get(id);
    if (!p || !this.teamMode || this.phase !== 'play') return;
    if (this.time - (p.lastSwitch ?? -99) < 2) return;
    p.lastSwitch = this.time;
    p.team ^= 1;
    this.spawn(p);
    this.queuedEvents.push({ t: 'team', v: id, team: p.team });
    this.sendRoster();
  }

  endMatch() {
    this.phase = 'end';
    this.phaseEnds = this.time + RESULT_SECONDS;
    this.shells.length = 0;
    const list = this.scoreboard();
    let winner;
    if (this.teamMode) {
      const k = this.teamKills();
      winner = k[0] === k[1] ? { draw: true } : { team: k[0] > k[1] ? 0 : 1 };
    } else {
      winner = list.length > 1 && list[0].kills === list[1].kills ? { draw: true } : list.length ? { id: list[0].id } : { draw: true };
    }
    this.winner = winner;
    this.io.broadcast('result', { list, winner, rules: this.rules, teams: this.teamMode ? this.teamKills() : null });
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
    const events = this.queuedEvents;
    this.queuedEvents = [];

    if (this.time >= this.phaseEnds) {
      if (this.phase === 'play') {
        this.endMatch();
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
        if (ev.fired) {
          this.shells.push({ id: this.shellId++, owner: p.id, seq: p.tank.shotSeq, ...muzzle(p.tank), life: C.shellLife });
          // spawn protection is for getting your bearings, not for attacking: shooting ends it
          if (this.time < p.invulnUntil) { p.invulnUntil = this.time; events.push({ t: 'unshield', v: p.id }); }
        }
        if (ev.boost) events.push({ t: 'boost', v: p.id, l: ev.boost });
      }
    }

    const alive = [...this.players.values()].filter((p) => p.alive && p.connected);
    for (let a = 0; a < alive.length; a++) for (let b = a + 1; b < alive.length; b++) separateTanks(alive[a].tank, alive[b].tank);
    for (const p of alive) depenetrate(p.tank, w);   // a shove must never leave a tank inside a wall

    // heal pickup on the hill top
    if (this.phase === 'play') {
      if (!this.heal.active && this.time >= this.heal.nextAt) { this.heal.active = true; events.push({ t: 'healspawn' }); }
      if (this.heal.active) {
        for (const p of alive) {
          const t = p.tank;
          if (p.hp >= C.maxHp) continue;           // full HP tanks leave it for someone who needs it
          if (Math.hypot(t.x - HEAL_POS.x, t.z - HEAL_POS.z) > HEAL_RADIUS || Math.abs(t.y - C.hoverHeight - HEAL_POS.y) > 2.5) continue;
          p.hp = C.maxHp;
          this.heal = { active: false, nextAt: this.time + this.healInterval };
          events.push({ t: 'heal', v: p.id });
          break;
        }
      }
    }

    for (let i = this.shells.length - 1; i >= 0; i--) {
      const s = this.shells[i];
      const { hitGround } = stepShell(s, w);
      let dead = hitGround || s.life <= 0;
      if (!dead) {
        const owner = this.players.get(s.owner);
        for (const p of alive) {
          if (p.id === s.owner || !segmentHitsTank(s, p.tank)) continue;
          if (this.teamMode && owner && owner.team === p.team) continue;   // no friendly fire: shells pass through teammates
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
    // first-to-N kills: end as soon as a player (or team) reaches the target
    if (this.phase === 'play' && this.rules.goal === 'kills') {
      const best = this.teamMode ? Math.max(...this.teamKills()) : Math.max(0, ...[...this.players.values()].map((p) => p.kills));
      if (best >= this.rules.target) this.endMatch();
    }
    this.broadcastSnapshot(events);
  }

  kill(p, killerId, events) {
    p.alive = false; p.hp = 0; p.deaths++;
    p.respawnAt = this.time + C.respawnTime;
    const k = this.players.get(killerId);
    if (k && !(this.teamMode && k.team === p.team)) k.kills++;
    events.push({ t: 'kill', k: killerId, v: p.id, x: r2(p.tank.x), y: r2(p.tank.y), z: r2(p.tank.z) });
  }

  spawn(p) {
    const w = this.world;
    // team mode: own half of the arena, away from enemies; free-for-all: farthest from everyone
    const pool = this.teamMode ? TEAM_SPAWNS[p.team] : w.spawns;
    let best = pool[p.slot % pool.length], bestD = -1;
    const others = [...this.players.values()].filter((o) => o !== p && o.alive && o.tank && !(this.teamMode && o.team === p.team));
    if (others.length) {
      for (const s of pool) {
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
      const flags = (p.alive ? 1 : 0) | (t.grounded ? 2 : 0) | (this.time < p.invulnUntil ? 4 : 0) | (p.connected ? 8 : 0) | (t.drifting ? 16 : 0);
      P.push([p.id, r3(t.x), r3(t.y), r3(t.z), r3(t.vx), r3(t.vy), r3(t.vz), r3(t.yaw), r3(t.aimYaw), r3(t.aimPitch),
        p.hp, flags, p.lastSeq, r3(t.cooldown), t.shotSeq, p.kills, p.deaths, p.spawnId,
        p.alive ? 0 : Math.max(0, Math.round((p.respawnAt - this.time) * 10) / 10),
        r3(t.charge), r3(t.boost), t.boostLvl,
        this.time < p.invulnUntil ? Math.round((p.invulnUntil - this.time) * 10) / 10 : 0]);
    }
    const B = this.shells.map((s) => [s.id, s.owner, s.seq, r2(s.x), r2(s.y), r2(s.z), r2(s.vx), r2(s.vy), r2(s.vz)]);
    this.io.broadcast('s', { k: this.tick, ph: this.phase, tl: Math.max(0, Math.round(this.phaseEnds - this.time)), p: P, b: B, e: events,
      hl: this.heal.active ? 1 : 0, hn: this.heal.active ? 0 : Math.max(0, Math.ceil(this.heal.nextAt - this.time)),
      tk: this.teamMode ? this.teamKills() : undefined });
  }

  scoreboard() {
    return [...this.players.values()]
      .map((p) => ({ id: p.id, name: p.name, slot: this.colorOf(p), team: p.team, kills: p.kills, deaths: p.deaths }))
      .sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
  }

  sendRoster() {
    this.io.broadcast('roster', { rules: this.rules, players: [...this.players.values()].map((p) => ({ id: p.id, name: p.name, slot: this.colorOf(p), team: p.team, connected: p.connected })) });
  }
}
