// CPU players. A bot is an ordinary seat in the Game whose inputs are produced here every tick
// instead of arriving over the network, so it plays by exactly the same rules as a human
// (same speed, same shells, same cooldown). Only its decisions come from code.
import { C, DT, heightAt, solveAim, wrapPi, clamp } from './sim.js';
import { PIT_HALF, HEAL_POS } from './arena.js';
import { ITEMS, SLOTS, DEFAULT_LOOK, owned } from './progress.js';
import { SIDEARMS, ULTS, ULT_MAX } from './abilities.js';

export const randomLoadout = () => ({ side: pick(SIDEARMS).id, ult: pick(ULTS).id });

// strength presets: aimErr = spread of the aim point in metres (grows with range), reaction time, turret turn speed, how eagerly it shoots, etc.
export const BOT_LEVELS = {
  easy:   { name: 'よわい', aimErr: 3.0, react: 0.9, turn: 2.2, fire: 0.15, range: 42, lead: 0.2, pref: 32, drift: 0, dodge: 0.0, jumpRand: 0.03, heal: 25 },
  normal: { name: 'ふつう', aimErr: 2.1, react: 0.5, turn: 4.0, fire: 0.3, range: 58, lead: 0.6, pref: 26, drift: 1, dodge: 0.3, jumpRand: 0.06, heal: 40 },
  hard:   { name: 'つよい', aimErr: 1.3, react: 0.25, turn: 7.0, fire: 0.7, range: 75, lead: 0.95, pref: 22, drift: 2, dodge: 0.65, jumpRand: 0.08, heal: 50 },
};
export const BOT_NAMES = ['レイ', 'ガロ', 'ミナ', 'ジン', 'ルカ', 'ソラ', 'ハク', 'ユズ'];   // private rooms (shown with a CPU badge)
// quick-match rooms: ordinary-looking player names
export const QM_NAMES = ['たける', 'Kaito', 'ゆうと', 'Mika', 'ShadowFox', 'りん', 'Hayate', 'なぎ', 'Sora_7', 'こはる', 'Ryu', 'みなと', 'Nova', 'ゆい', 'Ken', 'あおい',
  'ToraX', 'はると', 'Luna', 'そうた', 'Blitz', 'ひなた', 'Jet', 'さくら', 'Zero', 'こうき', 'Mint', 'いつき', 'Raven', 'めい'];

// a continuous strength 0 (easy) .. 0.5 (normal) .. 1 (hard): parameters interpolated between the presets
export const PRESET_SKILL = { easy: 0, normal: 0.5, hard: 1 };
export function botParams(skill) {
  const k = clamp(skill, 0, 1), [a, b, f] = k <= 0.5 ? [BOT_LEVELS.easy, BOT_LEVELS.normal, k / 0.5] : [BOT_LEVELS.normal, BOT_LEVELS.hard, (k - 0.5) / 0.5];
  const out = {};
  for (const key of Object.keys(a)) out[key] = typeof a[key] === 'number' ? a[key] + (b[key] - a[key]) * f : a[key];
  out.drift = Math.round(out.drift);
  return out;
}
// quick match: strength follows the players' level (Lv1 ~ easy, Lv30 ~ normal, Lv50 ~ hard)
export const skillForLevel = (lv) => 0.05 + 0.85 * ((clamp(lv || 1, 1, 50) - 1) / 49) ** 0.8;

const rnd = (a, b) => a + Math.random() * (b - a);
const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) / 0.5;   // ~N(0,1), bounded
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// a random outfit; with a level, only items a player of that level could have unlocked
export function randomLook(level) {
  const look = { ...DEFAULT_LOOK };
  const have = level ? owned(level, {}) : null;
  for (const s of SLOTS) {
    if (s.k === 'title') continue;
    const opts = ITEMS.filter((i) => i.slot === s.k && (!have || have.has(i.key)));
    if (opts.length && Math.random() < 0.6) look[s.k] = pick(opts).id;
  }
  if (!level || Math.random() < 0.5) look.paint = 'auto';
  return look;
}

function lineOfSight(w, ax, ay, az, bx, by, bz) {
  const d = Math.hypot(bx - ax, by - ay, bz - az);
  for (let s = 1.5; s < d - 1; s += 1) {
    const k = s / d;
    if (ay + (by - ay) * k < heightAt(w, ax + (bx - ax) * k, az + (bz - az) * k) + 0.2) return false;
  }
  return true;
}

// can the tank drive from (x,z) towards direction a for `dist` metres?
function freeDir(w, x, z, a, dist) {
  const h0 = heightAt(w, x, z);
  for (const d of [2.5, dist]) {
    const px = x - Math.sin(a) * d, pz = z - Math.cos(a) * d;
    if (Math.abs(px) > PIT_HALF - 2.5 || Math.abs(pz) > PIT_HALF - 2.5) return false;
    if (heightAt(w, px, pz) - h0 > C.stepMax * 0.8) return false;
  }
  return true;
}

export class BotBrain {
  // level: 'easy' | 'normal' | 'hard', or a number 0..1 (continuous strength)
  constructor(level = 'normal') {
    this.level = typeof level === 'number' ? level : BOT_LEVELS[level] ? level : 'normal';
    this.setSkill(typeof level === 'number' ? level : PRESET_SKILL[this.level]);
    this.seq = 0;
    this.time = 0;
    this.target = null; this.retarget = 0;
    this.lastSeen = null;
    this.errYaw = 0; this.errPitch = 0; this.errAt = 0;
    this.aimYaw = 0; this.aimPitch = 0;
    this.strafe = Math.random() < 0.5 ? 1 : -1; this.strafeAt = rnd(1.5, 3.5);
    this.stuckT = 0; this.escape = 0; this.escapeDir = 0;
    this.driftUntil = 0; this.driftCool = rnd(2, 4);
    this.seenFor = 0;
  }
  setSkill(skill) { this.skill = clamp(skill, 0, 1); this.p = botParams(this.skill); }

  // me: the bot's player record; game: the Game (players, shells, heal, world, teamMode)
  think(me, game) {
    const w = game.world, t = me.tank, P = this.p;
    this.time += DT;
    const inp = { seq: ++this.seq, mx: 0, mz: 0, ay: this.aimYaw, ap: this.aimPitch, j: false, d: false, f: false };
    if (!t || !me.alive) return inp;
    const eye = { x: t.x, y: t.y + C.muzzleUp, z: t.z };

    // ------------------------------------------------ choose a target (every reaction interval)
    const enemies = [...game.players.values()].filter((o) => o !== me && o.alive && o.connected && o.tank && !(game.teamMode && o.team === me.team));
    this.retarget -= DT;
    if (this.retarget <= 0 || (this.target && !enemies.includes(this.target))) {
      this.retarget = P.react;
      let best = null, bestS = Infinity;
      for (const o of enemies) {
        const d = Math.hypot(o.tank.x - t.x, o.tank.z - t.z);
        const vis = lineOfSight(w, eye.x, eye.y, eye.z, o.tank.x, o.tank.y + C.hitCenterY + 0.4, o.tank.z);
        const s = d + (vis ? 0 : 45) + o.hp * 0.12 + (o === this.target ? -12 : 0) + (game.time < o.invulnUntil ? 25 : 0);
        if (s < bestS) { bestS = s; best = { o, vis, d }; }
      }
      if (best && best.o !== this.target) this.seenFor = 0;
      this.target = best?.o || null;
      this.vis = best?.vis || false;
    }
    const tgt = this.target?.tank;
    if (tgt && this.vis) { this.lastSeen = { x: tgt.x, z: tgt.z }; this.seenFor += DT; } else this.seenFor = 0;
    const dist = tgt ? Math.hypot(tgt.x - t.x, tgt.z - t.z) : 999;

    // ------------------------------------------------ aim: lead the target, plus a human-like error
    if (this.time > this.errAt) {
      this.errAt = this.time + P.react * rnd(0.7, 1.3);
      // aim point misses by a few metres like a person would (more at long range)
      const d = Math.max(8, dist === 999 ? 30 : dist), spread = P.aimErr * (0.6 + d / 40);
      this.errYaw = (gauss() * spread) / d; this.errPitch = (gauss() * spread * 0.35) / d;
    }
    let wantYaw = this.aimYaw, wantPitch = this.aimPitch;
    if (tgt) {
      const fly = dist / C.shellSpeed;
      const ax = tgt.x + tgt.vx * fly * P.lead, az = tgt.z + tgt.vz * fly * P.lead;
      const ayv = tgt.grounded ? 0 : tgt.vy * fly * P.lead * 0.5;
      [wantYaw, wantPitch] = solveAim(t, { x: ax, y: tgt.y + C.hitCenterY + ayv, z: az });
      wantYaw += this.errYaw; wantPitch += this.errPitch;
    } else {
      wantYaw = t.yaw;
    }
    const maxTurn = P.turn * DT;
    this.aimYaw = wrapPi(this.aimYaw + clamp(wrapPi(wantYaw - this.aimYaw), -maxTurn, maxTurn));
    this.aimPitch += clamp(wantPitch - this.aimPitch, -maxTurn, maxTurn);
    inp.ay = this.aimYaw; inp.ap = clamp(this.aimPitch, C.aimPitchMin, C.aimPitchMax);

    // ------------------------------------------------ shoot
    const aligned = Math.abs(wrapPi(wantYaw - this.aimYaw)) < 0.05 && Math.abs(wantPitch - this.aimPitch) < 0.05;
    const shieldUp = this.target && game.time < this.target.invulnUntil;
    if (tgt && this.vis && aligned && dist < P.range && !shieldUp && this.seenFor > P.react * 0.5 && t.cooldown <= 0 && Math.random() < P.fire) inp.f = true;
    // fresh spawn: wait for the shield to run out before shooting (shooting ends it)
    if (game.time < me.invulnUntil && game.time < me.invulnUntil - 0.3 && this.skill < 0.8) inp.f = false;

    // ------------------------------------------------ where to go
    let goal = null, mode = 'roam';
    if (this.wantsHeal(me, game)) { goal = { x: HEAL_POS.x, z: HEAL_POS.z }; mode = 'heal'; }
    else if (tgt && this.vis) mode = 'fight';
    else if (this.lastSeen) { goal = this.lastSeen; mode = 'hunt'; if (Math.hypot(goal.x - t.x, goal.z - t.z) < 4) this.lastSeen = null; }
    else if (tgt) { goal = { x: tgt.x, z: tgt.z }; mode = 'hunt'; }
    else goal = { x: HEAL_POS.x * 0 + Math.sin(this.time * 0.2) * 20, z: Math.cos(this.time * 0.2) * 20 };

    let dirX = 0, dirZ = 0;
    if (mode === 'fight') {
      // keep a preferred range and circle-strafe; switch direction now and then
      this.strafeAt -= DT;
      if (this.strafeAt <= 0) {
        this.strafeAt = rnd(1.4, 3.8); this.strafe *= -1;
        if (P.drift && Math.hypot(t.vx, t.vz) > 10 && this.time > this.driftCool) {
          this.driftUntil = this.time + (P.drift >= 2 ? rnd(C.charge2 + 0.05, C.charge2 + 0.3) : rnd(C.charge1 + 0.05, C.charge1 + 0.4));
          this.driftCool = this.time + rnd(3, 6);
        }
      }
      const tx = (tgt.x - t.x) / (dist || 1), tz = (tgt.z - t.z) / (dist || 1);
      const pref = t.ultK === 'slam' && t.ult >= ULT_MAX ? 5 : P.pref;   // slam ready: get in close
      const radial = clamp((dist - pref) / 10, -1, 1);
      dirX = tx * radial + -tz * this.strafe * 0.9; dirZ = tz * radial + tx * this.strafe * 0.9;
    } else if (goal) {
      const gx = goal.x - t.x, gz = goal.z - t.z, gd = Math.hypot(gx, gz) || 1;
      dirX = gx / gd; dirZ = gz / gd;
      if (mode === 'heal' && gd < 2) { dirX *= game.heal.active ? 0.6 : 0.1; dirZ *= game.heal.active ? 0.6 : 0.1; }   // drive over it / wait on top
    }

    // obstacle avoidance: steer to the free direction closest to the wanted one
    let want = Math.atan2(-dirX, -dirZ), mag = Math.min(1, Math.hypot(dirX, dirZ));
    if (this.escape > 0) { this.escape -= DT; want = this.escapeDir; mag = 1; }
    if (mag > 0.05 && !freeDir(w, t.x, t.z, want, 5)) {
      for (const off of [0.5, -0.5, 1.0, -1.0, 1.6, -1.6, 2.3, -2.3, Math.PI]) {
        const a = want + off * (this.strafe || 1);
        if (freeDir(w, t.x, t.z, a, 5)) { want = a; break; }
      }
    }
    // stuck (pushing but not moving): back off in a random free direction and hop
    const speed = Math.hypot(t.vx, t.vz);
    if (mag > 0.3 && speed < 2 && t.grounded) this.stuckT += DT; else this.stuckT = Math.max(0, this.stuckT - DT);
    if (this.stuckT > 0.9) { this.stuckT = 0; this.escape = rnd(0.7, 1.3); this.escapeDir = want + Math.PI + rnd(-1, 1); inp.j = true; }

    inp.mx = -Math.sin(want) * mag; inp.mz = -Math.cos(want) * mag;
    if (this.time < this.driftUntil && speed > C.driftMinSpeed * 0.8) inp.d = true;

    // ------------------------------------------------ jumps: dodge incoming shells, sometimes just hop
    if (t.grounded) {
      if (P.dodge && Math.random() < P.dodge * 0.25) {
        for (const s of game.shells) {
          if (s.owner === me.id) continue;
          const rx = t.x - s.x, rz = t.z - s.z, sp = Math.hypot(s.vx, s.vz) || 1;
          const along = (rx * s.vx + rz * s.vz) / sp;
          if (along < 0 || along > sp * 0.4) continue;           // behind it, or more than 0.4 s away
          const miss = Math.abs(rx * s.vz - rz * s.vx) / sp;
          if (miss < 2.2) { inp.j = true; break; }
        }
      }
      if (Math.random() < P.jumpRand * DT) inp.j = true;
    }

    // ------------------------------------------------ sidearm / special
    // every strength uses them; stronger CPUs time them better (dodge at the last moment, perfect guard)
    const skill = this.skill;
    const incoming = this.incomingShell(me, game, 0.35);
    const sideTry = (p) => Math.random() < p * DT * 30;   // p = chance per 1/30 s
    if (t.sideCd <= 0 && game.phase === 'play') {
      if (t.side === 'dash') {
        if (incoming && sideTry(0.15 + skill * 0.5)) {
          // sidestep the shell
          const sx = -incoming.vz, sz = incoming.vx, sl = Math.hypot(sx, sz) || 1, side = Math.random() < 0.5 ? 1 : -1;
          inp.mx = (sx / sl) * side; inp.mz = (sz / sl) * side; inp.a = true;
        } else if (mode === 'heal' && Math.hypot(HEAL_POS.x - t.x, HEAL_POS.z - t.z) > 12 && sideTry(0.04)) inp.a = true;   // rush to the heal
        else if (tgt && this.vis && (dist > P.pref + 14 || me.hp <= 34) && sideTry(0.02)) inp.a = true;    // close in / get away
        else if (tgt && this.vis && sideTry(0.006)) inp.a = true;                                          // random juke while strafing
      } else if (t.side === 'shield') {
        if (incoming && incoming.eta < 0.05 + skill * 0.25 && sideTry(0.2 + skill * 0.6)) inp.a = true;
        else if (incoming && skill < 0.4 && sideTry(0.05)) inp.a = true;                               // weak CPUs just raise it early
      } else if (t.side === 'mine') {
        if (tgt && dist < 24 && sideTry(0.03)) inp.a = true;
        else if (Math.hypot(HEAL_POS.x - t.x, HEAL_POS.z - t.z) < 9 && sideTry(0.03)) inp.a = true;   // trap the heal hill
      } else if (t.side === 'bounce' && tgt && aligned && dist < P.range && (this.vis || this.lastSeen) && sideTry(0.04 + P.fire * 0.3)) inp.a = true;
    }
    if (t.ult >= ULT_MAX && tgt && !shieldUp && game.phase === 'play') {
      const k = t.ultK;
      if (k === 'overdrive' && this.vis && dist < 55) inp.u = true;
      else if ((k === 'mega' || k === 'strike') && this.vis && aligned && dist > 10 && dist < 75 && sideTry(0.25)) inp.u = true;
      else if (k === 'strike' && !this.vis && this.lastSeen && sideTry(0.01)) inp.u = true;   // bomb where it hid
      else if (k === 'slam' && (dist < 9 || (!t.grounded && dist < 14))) inp.u = true;
    }
        return inp;
  }

  // go for the heal pickup? (it only works below full HP). Hurt bots go from further away, and a
  // badly hurt one also heads for the hill a few seconds before the next one appears.
  // Once decided it sticks to it (no dithering) until healed or the item is gone.
  wantsHeal(me, game) {
    const t = me.tank, H = game.heal, sk = this.skill;
    if (me.hp >= 100 || (!H.active && H.nextAt - game.time > 2 + sk * 4)) { this.healGoal = false; return false; }
    const d = Math.hypot(HEAL_POS.x - t.x, HEAL_POS.z - t.z);
    if (this.healGoal) return true;
    const want = H.active
      ? me.hp <= 40 || (me.hp <= 70 && d < 28 + sk * 30) || d < 10 + sk * 8
      : me.hp <= 70 && d < 18 + sk * 22;
    if (want && Math.random() < 0.15 + sk * 0.5) this.healGoal = true;   // reacts within a few ticks
    return this.healGoal;
  }

  // the nearest enemy shell that will pass close to us soon: { vx, vz, eta } or null
  incomingShell(me, game, within) {
    const t = me.tank;
    let best = null;
    for (const s of game.shells) {
      if (s.owner === me.id) continue;
      const rx = t.x - s.x, rz = t.z - s.z, sp = Math.hypot(s.vx, s.vz) || 1;
      const along = (rx * s.vx + rz * s.vz) / sp, eta = along / sp;
      if (eta < 0 || eta > within) continue;
      if (Math.abs(rx * s.vz - rz * s.vx) / sp > 2.4) continue;
      if (!best || eta < best.eta) best = { vx: s.vx, vz: s.vz, eta };
    }
    return best;
  }
}
