// CPU players. A bot is an ordinary seat in the Game whose inputs are produced here every tick
// instead of arriving over the network, so it plays by exactly the same rules as a human
// (same speed, same shells, same cooldown). Only its decisions come from code.
import { C, DT, heightAt, solveAim, wrapPi, clamp } from './sim.js';
import { PIT_HALF, HEAL_POS } from './arena.js';
import { ITEMS, SLOTS, DEFAULT_LOOK } from './progress.js';

// strength presets: aimErr = spread of the aim point in metres (grows with range), reaction time, turret turn speed, how eagerly it shoots, etc.
export const BOT_LEVELS = {
  easy:   { name: 'よわい', aimErr: 3.0, react: 0.9, turn: 2.2, fire: 0.15, range: 42, lead: 0.2, pref: 32, drift: 0, dodge: 0.0, jumpRand: 0.03, heal: 25 },
  normal: { name: 'ふつう', aimErr: 2.1, react: 0.5, turn: 4.0, fire: 0.3, range: 58, lead: 0.6, pref: 26, drift: 1, dodge: 0.3, jumpRand: 0.06, heal: 40 },
  hard:   { name: 'つよい', aimErr: 1.3, react: 0.25, turn: 7.0, fire: 0.7, range: 75, lead: 0.95, pref: 22, drift: 2, dodge: 0.65, jumpRand: 0.08, heal: 50 },
};
export const BOT_NAMES = ['レイ', 'ガロ', 'ミナ', 'ジン', 'ルカ', 'ソラ', 'ハク', 'ユズ'];   // shown with a CPU badge

const rnd = (a, b) => a + Math.random() * (b - a);
const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) / 0.5;   // ~N(0,1), bounded
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// a random outfit: shows players what can be unlocked
export function randomLook() {
  const look = { ...DEFAULT_LOOK };
  for (const s of SLOTS) {
    if (s.k === 'title' || s.k === 'frame') continue;
    const opts = ITEMS.filter((i) => i.slot === s.k);
    if (Math.random() < 0.6) look[s.k] = pick(opts).id;
  }
  look.paint = 'auto';   // keep the seat colour so players can tell bots apart in the list
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
  constructor(level = 'normal') {
    this.level = BOT_LEVELS[level] ? level : 'normal';
    this.p = BOT_LEVELS[this.level];
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
    if (game.time < me.invulnUntil && game.time < me.invulnUntil - 0.3 && this.level !== 'hard') inp.f = false;

    // ------------------------------------------------ where to go
    let goal = null, mode = 'roam';
    if (game.heal.active && me.hp <= P.heal) { goal = { x: HEAL_POS.x, z: HEAL_POS.z }; mode = 'heal'; }
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
      const radial = clamp((dist - P.pref) / 10, -1, 1);
      dirX = tx * radial + -tz * this.strafe * 0.9; dirZ = tz * radial + tx * this.strafe * 0.9;
    } else if (goal) {
      const gx = goal.x - t.x, gz = goal.z - t.z, gd = Math.hypot(gx, gz) || 1;
      dirX = gx / gd; dirZ = gz / gd;
      if (mode === 'heal' && gd < 2) { dirX *= 0.2; dirZ *= 0.2; }
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
    return inp;
  }
}
