// Authoritative match logic, independent of the network layer.
// The Cloudflare Durable Object (worker/room.js) owns sockets and calls into this class.
import {
  C, DT, newTank, stepTank, cleanInput, muzzle, stepShell, segmentHitsTank, separateTanks, heightAt, depenetrate,
} from './sim.js';
import { MATCH_SECONDS, RESULT_SECONDS, MAX_PLAYERS, HEAL_INTERVAL, HEAL_RADIUS, HEAL_POS, TEAM_SPAWNS, DEFAULT_RULES, KILLS_TIME_CAP, cleanRules } from './arena.js';
import { BotBrain, BOT_NAMES, QM_NAMES, randomLook, skillForLevel } from './bot.js';

const r3 = (v) => Math.round(v * 1000) / 1000;
const r2 = (v) => Math.round(v * 100) / 100;
export const MAX_QUEUE = 20;   // inputs a client may bank (anti speed-hack)
const MAX_BURST = 6;           // late inputs processed in one tick to catch up
export const QM_WAIT = 5;       // s: a new quick-match room waits this long for more people, then bots fill in
const LONG_KILL = 40;          // m: a kill from farther than this counts as long range
const ACTIVE_MOVE = 40;        // m driven (or 3 shots) to count as having taken part in a match

// per-player counters for one match (used for XP, missions and titles; never for gameplay)
export const freshStats = () => ({ kills: 0, deaths: 0, hits: 0, dmg: 0, turbo: 0, orange: 0, heals: 0, jumps: 0, air: 0, turboKills: 0, longKills: 0, hillKills: 0, shots: 0, moved: 0 });

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
    this.matchStart = 0;
    this.matchNo = 1;
    // CPU players: autoFill = quick-match rooms keep every empty seat filled with a bot;
    // otherwise rules.bots bots join (invite rooms). Bots never take a seat a human wants.
    this.autoFill = !!opts.autoFill;
    this.waitSeconds = opts.waitSeconds ?? QM_WAIT;
    this.botSeq = 0;
  }

  // seats in this room: quick-match rooms use the chosen size, invite rooms always 4
  get capacity() { return this.autoFill ? this.rules.size : MAX_PLAYERS; }
  get humans() { let n = 0; for (const p of this.players.values()) if (!p.bot) n++; return n; }
  get botCount() { return this.players.size - this.humans; }

  // quick match: nobody joins a match in progress. New people are let in while a fresh room is
  // still gathering players ('wait') and between matches ('end'); bots fill seats only at match start.
  get open() { return this.autoFill && (this.phase === 'wait' || this.phase === 'end') && this.humans < this.capacity; }
  startWait() {
    this.phase = 'wait';
    this.phaseEnds = this.time + this.waitSeconds;
    this.shells.length = 0;
    this.io.phase?.('wait');
  }
  beginMatch() {
    this.resetMatch();   // (fills empty seats with bots in quick-match rooms)
    this.sendRoster();
    this.io.phase?.('play');
  }

  wantedBots() {
    const h = this.humans;
    if (h === 0) return 0;
    if (this.autoFill && this.phase === 'wait') return 0;
    if (this.autoFill) return Math.max(0, this.capacity - h);
    return Math.min(this.rules.bots || 0, MAX_PLAYERS - h);
  }

  // average level of the people in the room (quick-match bots are matched to it)
  humanLevel() {
    const lv = [...this.players.values()].filter((p) => !p.bot).map((p) => p.prof?.lv || 1);
    return lv.length ? lv.reduce((a, b) => a + b, 0) / lv.length : 1;
  }

  addBot(level) {
    const used = new Set([...this.players.values()].map((p) => p.name));
    const id = `cpu${++this.botSeq}`;
    if (this.autoFill) {
      // quick match: a regular-looking opponent whose strength follows the players' level
      const pool = QM_NAMES.filter((n) => !used.has(n));
      const name = pool[Math.floor(Math.random() * pool.length)] || `Player${100 + this.botSeq}`;
      const avg = this.humanLevel();
      const lv = Math.max(1, Math.min(50, Math.round(avg + (Math.random() * 6 - 3))));
      const p = this.addPlayer(id, name, { bot: new BotBrain(this.botSkill(lv)) });
      p.prof = { lv, look: randomLook(lv), hidden: true };
      return p;
    }
    const name = BOT_NAMES.find((n) => !used.has(n)) || `ボット${this.botSeq + 1}`;
    const p = this.addPlayer(id, name, { bot: new BotBrain(level) });
    p.prof = { lv: 0, look: randomLook(), bot: true };
    return p;
  }
  botSkill(lv) { return Math.max(0, Math.min(1, skillForLevel(lv) + (Math.random() * 0.12 - 0.06))); }

  // quick match: when the people's levels become known (profiles load after joining), retune bots
  retuneBots() {
    if (!this.autoFill) return;
    const avg = this.humanLevel();
    for (const p of this.players.values()) {
      if (!p.bot || !p.prof?.hidden) continue;
      if (Math.abs((p.prof.tunedFor ?? -99) - avg) < 0.5) continue;
      p.prof.tunedFor = avg;
      p.prof.lv = Math.max(1, Math.min(50, Math.round(avg + (Math.random() * 6 - 3))));
      p.prof.look = randomLook(p.prof.lv);
      p.bot.setSkill(this.botSkill(p.prof.lv));
    }
  }

  // add / remove bots to match wantedBots(); keeps teams even by moving bots, never humans
  syncBots() {
    const want = this.wantedBots();
    const level = () => this.rules.botLevel;
    let changed = false;
    while (this.botCount > want) {
      const bots = [...this.players.values()].filter((p) => p.bot);
      this.removePlayer(bots[bots.length - 1].id, true); changed = true;
    }
    while (this.botCount < want && this.players.size < this.capacity) { this.addBot(level()); changed = true; }
    for (const p of this.players.values()) if (p.bot && !this.autoFill && p.bot.level !== this.rules.botLevel) { p.bot = new BotBrain(this.rules.botLevel); changed = true; }
    if (this.teamMode) {
      const n = [0, 0]; for (const p of this.players.values()) n[p.team]++;
      for (const p of this.players.values()) {
        if (!p.bot || Math.abs(n[0] - n[1]) < 2) continue;
        const big = n[0] > n[1] ? 0 : 1;
        if (p.team === big) { p.team ^= 1; n[big]--; n[big ^ 1]++; this.spawn(p); changed = true; }
      }
    }
    if (changed) this.sendRoster();
  }

  get teamMode() { return this.rules.mode === 'team'; }
  setRules(r) { this.rules = cleanRules(r); if (this.teamMode) this.balanceTeams(); this.syncBots?.(); }

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
  isFull() { return this.humans >= this.capacity; }   // bots give their seat up for humans

  addPlayer(id, name, extra = {}) {
    // a human arriving in a room full of bots takes a bot's seat
    if (!extra.bot && this.players.size >= this.capacity) {
      const b = [...this.players.values()].reverse().find((p) => p.bot);
      if (b) this.removePlayer(b.id, true);
    }
    const used = new Set([...this.players.values()].map((p) => p.slot));
    let slot = 0; while (used.has(slot)) slot++;
    const p = {
      id, slot, name: sanitizeName(name) || `Player ${slot + 1}`,
      tank: null, hp: C.maxHp, alive: false, respawnAt: 0, invulnUntil: 0,
      kills: 0, deaths: 0, queue: [], lastSeq: 0, lastQueued: 0, credits: 0, dropped: 0,
      connected: true, spawnId: 0, team: 0,
      m: freshStats(), joinedAt: this.time, prof: null, bot: extra.bot || null,
    };
    // a fresh match starts when the first player arrives in an empty room
    // (quick match: first a short wait so people arriving together end up in the same match)
    if (this.players.size === 0) { if (this.autoFill && !extra.bot) this.startWait(); else this.resetMatch(); }
    p.team = this.smallerTeam(p);
    this.players.set(id, p);
    this.spawn(p);
    if (!p.bot && !(this.autoFill && this.phase === 'play')) this.syncBots();
    this.sendRoster();
    if (this.autoFill && this.phase === 'wait' && this.humans >= this.capacity) this.beginMatch();   // full: no need to wait
    return p;
  }

  removePlayer(id, quiet) {
    const p = this.players.get(id);
    this.players.delete(id);
    this.shells = this.shells.filter((s) => s.owner !== id);
    // quick match: a seat left during a match stays empty until the next match starts
    if (p && !p.bot && !quiet && (!this.autoFill || this.phase !== 'play' || this.humans === 0)) this.syncBots();
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

  // cosmetic profile from the progression server: { key, lv, look } (look already validated)
  setProfile(id, prof) {
    const p = this.players.get(id);
    if (p) { p.prof = prof; this.retuneBots(); this.sendRoster(); }
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
    this.matchStart = this.time;
    this.matchNo++;
    for (const p of this.players.values()) { p.kills = 0; p.deaths = 0; p.m = freshStats(); p.joinedAt = this.time; this.spawn(p); }
    if (this.autoFill) this.syncBots();
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
    this.io.matchEnd?.(this.matchSummary(list, winner));
  }

  // what each player did this match, for XP / missions / titles (see shared/progress.js)
  matchSummary(list, winner) {
    const all = [...this.players.values()];
    const isActive = (p) => p.m.moved >= ACTIVE_MOVE || p.m.shots >= 3;
    const active = all.filter(isActive);
    const contested = this.teamMode ? new Set(active.map((p) => p.team)).size === 2 : active.length >= 2;
    const ranked = list.filter((r) => active.some((p) => p.id === r.id));
    return {
      matchNo: this.matchNo, seconds: Math.max(0, this.time - this.matchStart),
      players: all.map((p) => {
        const m = p.m;
        const win = contested && (this.teamMode ? winner.team === p.team : winner.id === p.id);
        const draw = contested && !!winner.draw;
        const stats = {
          matches: 1, kills: m.kills, deaths: m.deaths, wins: win ? 1 : 0, hits: m.hits, dmg: m.dmg, turbo: m.turbo, orange: m.orange,
          heals: m.heals, jumps: m.jumps, air: m.air, turboKills: m.turboKills, longKills: m.longKills, hillKills: m.hillKills,
          clean: m.kills >= 3 && m.deaths <= 1 ? 1 : 0, flawless: win && m.kills >= 3 && m.deaths === 0 ? 1 : 0, best: m.kills,
        };
        const ctx = {
          active: isActive(p), minutes: Math.max(0, this.time - Math.max(this.matchStart, p.joinedAt)) / 60,
          win, draw, place: ranked.findIndex((r) => r.id === p.id) + 1, players: active.length, team: this.teamMode,
        };
        return { id: p.id, prof: p.prof, bot: !!p.bot, stats, ctx };
      }),
    };
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
        this.io.phase?.('end');
      } else {
        this.beginMatch();
      }
    }

    for (const p of this.players.values()) if (p.bot && p.alive) p.queue.push(p.bot.think(p, this));
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
        const t = p.tank;
        const ev = stepTank(t, inp, w);
        if (this.phase === 'play') {
          p.m.moved += Math.hypot(t.vx, t.vz) * DT;
          if (ev.jumped) p.m.jumps++;
          if (ev.boost) { p.m.turbo++; if (ev.boost >= 2) p.m.orange++; }
        }
        if (ev.fired) {
          p.m.shots++;
          // how the shot was fired (for missions): airborne, boosting, from the hill top
          const onHill = t.grounded && heightAt(w, t.x, t.z) > 2.0 && Math.hypot(t.x, t.z) < 7;
          this.shells.push({ id: this.shellId++, owner: p.id, seq: t.shotSeq, ...muzzle(t), life: C.shellLife,
            air: !t.grounded, turbo: t.boost > 0, hill: onHill, ox: t.x, oz: t.z });
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
          p.m.heals++;
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
          if (owner) { owner.m.hits++; owner.m.dmg += C.damage; }
          events.push({ t: 'hit', s: s.id, o: s.owner, q: s.seq, v: p.id, hp: Math.max(0, p.hp), x: r2(s.x), y: r2(s.y), z: r2(s.z) });
          if (p.hp <= 0) this.kill(p, s.owner, events, s);
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

  kill(p, killerId, events, shell) {
    p.alive = false; p.hp = 0; p.deaths++; p.m.deaths++;
    p.respawnAt = this.time + C.respawnTime;
    const k = this.players.get(killerId);
    if (k && !(this.teamMode && k.team === p.team)) {
      k.kills++; k.m.kills++;
      if (shell) {
        if (shell.air) k.m.air++;
        if (shell.turbo) k.m.turboKills++;
        if (shell.hill) k.m.hillKills++;
        if (Math.hypot(p.tank.x - shell.ox, p.tank.z - shell.oz) >= LONG_KILL) k.m.longKills++;
      }
    }
    events.push({ t: 'kill', k: killerId, v: p.id, x: r2(p.tank.x), y: r2(p.tank.y), z: r2(p.tank.z) });
  }

  spawn(p) {
    const w = this.world;
    // team mode: own half of the arena, away from enemies; free-for-all: farthest from everyone
    const pool = this.teamMode ? TEAM_SPAWNS[p.team] : w.spawns;
    let best = pool[p.slot % pool.length], bestD = -Infinity;
    const live = [...this.players.values()].filter((o) => o !== p && o.alive && o.tank);
    const others = live.filter((o) => !(this.teamMode && o.team === p.team));
    const mates = live.filter((o) => this.teamMode && o.team === p.team);
    if (others.length || mates.length) {
      for (const s of pool) {
        let d = others.length ? Math.min(...others.map((o) => Math.hypot(o.tank.x - s.x, o.tank.z - s.z))) : 100;
        if (mates.some((o) => Math.hypot(o.tank.x - s.x, o.tank.z - s.z) < 8)) d -= 1000;   // don't land on a teammate
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
    this.io.broadcast('roster', { rules: this.rules, players: [...this.players.values()].map((p) => ({
      id: p.id, name: p.name, slot: this.colorOf(p), team: p.team, connected: p.connected, lv: p.prof?.lv || 0, look: p.prof?.look || null,
      // private rooms label CPU players; quick-match bots look like everyone else
      bot: p.bot && !p.prof?.hidden ? p.bot.level : undefined,
    })) });
  }
}
