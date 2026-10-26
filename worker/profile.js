// Progression storage. One Durable Object per player profile, addressed by the SHA-256 of the
// player's secret token (the token itself is only ever held by the player's device and, for at most
// 24 h, by a transfer code). XP, missions and unlocks are computed here from match results that
// the game rooms report: clients can't award themselves anything.
import { DurableObject } from 'cloudflare:workers';
import {
  levelOf, owned, cleanLook, DEFAULT_LOOK, STAT_KEYS, DAILY, DAILY_ALL_BONUS, ACHIEVEMENTS, dayKey, nextResetAt,
  pickDaily, rerollOne, matchXp, ITEM,
} from '../shared/progress.js';

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
export const TOKEN_RE = /^[A-Za-z0-9_-]{32,64}$/;

export async function profileKey(token) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`ht-profile:${token}`));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
export const profileStub = (env, key) => env.PROFILES.get(env.PROFILES.idFromName(`p:${key}`));
export function newToken() {
  const b = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const emptyStats = () => Object.fromEntries([...STAT_KEYS, 'dailyDone'].map((k) => [k, 0]));

export class PlayerProfile extends DurableObject {
  async load() {
    if (this.d) return this.d;
    this.d = (await this.ctx.storage.get('d')) || { v: 1, xp: 0, stats: emptyStats(), ach: {}, look: { ...DEFAULT_LOOK }, daily: null, recent: [], created: Date.now() };
    for (const k of Object.keys(emptyStats())) this.d.stats[k] ??= 0;
    return this.d;
  }
  async save() { await this.ctx.storage.put('d', this.d); }

  ownedSet() { return owned(levelOf(this.d.xp).level, this.d.ach); }

  daily(now = Date.now()) {
    const day = dayKey(now);
    if (this.d.daily?.day !== day) {
      this.d.daily = { day, ids: pickDaily(`${this.ctx.id.toString()}:${day}`), prog: {}, done: [], rerolled: false, bonus: false, played: false, won: false };
    }
    return this.d.daily;
  }

  view() {
    const d = this.d, lv = levelOf(d.xp), dl = this.daily();
    return {
      level: lv.level, xp: d.xp, into: lv.into, need: lv.need,
      look: cleanLook(d.look, this.ownedSet()), owned: [...this.ownedSet()],
      stats: d.stats,
      ach: ACHIEVEMENTS.map((a) => ({ id: a.id, done: !!d.ach[a.id], prog: Math.min(a.target, d.stats[a.key] || 0) })),
      daily: { day: dl.day, resetAt: nextResetAt(), ids: dl.ids, prog: dl.prog, done: dl.done, rerolled: dl.rerolled, bonus: dl.bonus },
    };
  }
  brief() {
    const lv = levelOf(this.d.xp).level;
    return { lv, look: cleanLook(this.d.look, this.ownedSet()) };
  }

  async fetch(request) {
    const url = new URL(request.url);
    await this.load();
    const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};
    if (url.pathname === '/view') { const v = this.view(); await this.save(); return json(v); }
    if (url.pathname === '/brief') return json(this.brief());
    if (url.pathname === '/look') {
      this.d.look = cleanLook(body.look, this.ownedSet());
      await this.save();
      return json(this.view());
    }
    if (url.pathname === '/reroll') {
      const dl = this.daily(), i = Number(body.index);
      if (!dl.rerolled && i >= 0 && i < dl.ids.length && !dl.done.includes(dl.ids[i])) {
        const id = rerollOne(`${this.ctx.id.toString()}:${dl.day}`, dl.ids, i);
        if (id !== dl.ids[i]) { delete dl.prog[dl.ids[i]]; dl.ids[i] = id; dl.rerolled = true; }
      }
      await this.save();
      return json(this.view());
    }
    if (url.pathname === '/award') return json(await this.award(body));
    return json({ error: 'not found' }, 404);
  }

  // one finished match: stats + context from the room (worker/room.js -> shared/game.js matchSummary)
  async award({ matchId, stats, ctx }) {
    const d = this.d;
    if (!matchId || d.recent.includes(matchId)) return { duplicate: true, view: this.view() };   // retries count once
    d.recent = [...d.recent.slice(-29), matchId];
    const before = levelOf(d.xp), ownedBefore = this.ownedSet();
    const lines = [];
    if (!ctx?.active) { await this.save(); return { lines, gained: 0, before, after: before, unlocked: [], missions: [], ach: [], view: this.view() }; }

    const s = {};
    for (const k of STAT_KEYS) s[k] = Math.max(0, Math.min(10000, Math.floor(Number(stats?.[k]) || 0)));
    const dl = this.daily();
    lines.push(...matchXp(s, { ...ctx, firstPlay: !dl.played, firstWin: !!ctx.win && !dl.won }));
    dl.played = true;
    if (ctx.win) dl.won = true;

    // lifetime stats
    for (const k of STAT_KEYS) d.stats[k] = k === 'best' ? Math.max(d.stats.best, s.best) : d.stats[k] + s[k];

    // daily missions
    const missions = [];
    for (const id of dl.ids) {
      if (dl.done.includes(id)) continue;
      const m = DAILY.find((x) => x.id === id);
      dl.prog[id] = m.mode === 'max' ? Math.max(dl.prog[id] || 0, s[m.key]) : (dl.prog[id] || 0) + s[m.key];
      if (dl.prog[id] >= m.target) {
        dl.prog[id] = m.target; dl.done.push(id); missions.push(id);
        lines.push([`デイリー：${m.text}`, m.xp]);
        d.stats.dailyDone++;
      }
    }
    if (!dl.bonus && dl.done.length >= dl.ids.length) { dl.bonus = true; lines.push(['デイリー全達成ボーナス', DAILY_ALL_BONUS]); }

    // long-term missions (titles)
    const ach = [];
    for (const a of ACHIEVEMENTS) {
      if (d.ach[a.id] || (d.stats[a.key] || 0) < a.target) continue;
      d.ach[a.id] = Date.now(); ach.push(a.id);
      lines.push([`称号「${a.title}」獲得`, a.xp]);
    }

    const gained = lines.reduce((n, l) => n + l[1], 0);
    d.xp += gained;
    const after = levelOf(d.xp);
    const unlocked = [...this.ownedSet()].filter((k) => !ownedBefore.has(k) && ITEM.has(k));
    await this.save();
    return { lines, gained, before, after, unlocked, missions, ach, view: this.view() };
  }
}

// ------------------------------------------------------------------ transfer codes
// "引き継ぎコード": a short one-time code (valid 24 h) that hands the token to another device.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_TTL = 24 * 3600e3;
const code8 = () => [...crypto.getRandomValues(new Uint8Array(8))].map((v) => ALPHABET[v % ALPHABET.length]).join('');
export const normCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export class TransferCodes extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.fails = new Map(); }

  async fetch(request) {
    const url = new URL(request.url);
    const body = await request.json().catch(() => ({}));
    const now = Date.now();
    if (url.pathname === '/issue') {
      if (!TOKEN_RE.test(body.token || '')) return json({ error: 'bad token' }, 400);
      const key = await profileKey(body.token);
      const old = await this.ctx.storage.get(`t:${key}`);
      if (old) await this.ctx.storage.delete(`c:${old}`);
      const c = code8();
      await this.ctx.storage.put({ [`c:${c}`]: { token: body.token, exp: now + CODE_TTL }, [`t:${key}`]: c });
      if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(now + CODE_TTL);
      return json({ code: `${c.slice(0, 4)}-${c.slice(4)}`, expiresAt: now + CODE_TTL });
    }
    if (url.pathname === '/redeem') {
      // slow down guessing: at most 10 wrong codes per address per hour
      const ip = request.headers.get('x-ip') || '?';
      const f = (this.fails.get(ip) || []).filter((t) => t > now - 3600e3);
      if (f.length >= 10) return json({ error: 'too many attempts' }, 429);
      const c = normCode(body.code);
      const rec = c.length === 8 && (await this.ctx.storage.get(`c:${c}`));
      if (!rec || rec.exp < now) { f.push(now); this.fails.set(ip, f); return json({ error: 'invalid code' }, 404); }
      await this.ctx.storage.delete([`c:${c}`, `t:${await profileKey(rec.token)}`]);
      return json({ token: rec.token });
    }
    return json({ error: 'not found' }, 404);
  }

  async alarm() {
    const now = Date.now();
    let next = 0;
    for (const [k, v] of await this.ctx.storage.list({ prefix: 'c:' })) {
      if (v.exp < now) {
        const tk = `t:${await profileKey(v.token)}`;
        await this.ctx.storage.delete(k);
        if ((await this.ctx.storage.get(tk)) === k.slice(2)) await this.ctx.storage.delete(tk);
      }
      else next = next ? Math.min(next, v.exp) : v.exp;
    }
    if (next) await this.ctx.storage.setAlarm(next + 1000);
  }
}
