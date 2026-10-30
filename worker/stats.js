// Play statistics for the owner's dashboard (/admin.html). One global Durable Object.
// Only anonymous profile keys (already SHA-256 hashes of the device token) are stored: no names,
// no IP addresses. Days are Japan time.
//   events (POST /event): open {pkey, src?, fresh?} | new {pkey} | match {...} | room {roomId, humans, public}
//   src = the ?s= tag of the link a visit came in through (an X post): per tag we count the devices that
//   arrived, how many of them were first launches, and how many then played a match within 7 days.
//   GET /summary?days=N -> daily rows + level histogram + live numbers
import { DurableObject } from 'cloudflare:workers';
import { dayKey } from '../shared/progress.js';

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const KEEP_DAYS = 120;          // daily unique-player keys older than this are deleted
const ROOM_STALE = 3 * 60e3;    // a room that has not reported for 3 min no longer counts as live
const SRC_RE = /^[a-z0-9_-]{1,24}$/;
const SRC_MAX = 300;            // distinct tags kept (anything past this is ignored)
const SRC_WINDOW = 7 * 86400e3; // a match counts for the tag the player arrived through within this time
const emptyDay = () => ({ opened: 0, played: 0, newProfiles: 0, newPlayers: 0, matches: 0, kinds: {}, humanSlots: 0, botSlots: 0, minutes: 0, peak: 0, missions: 0, titles: 0 });

export class GameStats extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.rooms = new Map();   // roomId -> { humans, public, at }
  }

  async day(d) { return (await this.ctx.storage.get(`d:${d}`)) || emptyDay(); }
  async once(key) {           // true the first time a key is seen
    if (await this.ctx.storage.get(key)) return false;
    await this.ctx.storage.put(key, 1);
    return true;
  }

  // a device arrived through a tagged link
  async arrive(src, pkey, fresh, today, now) {
    const list = (await this.ctx.storage.get('srcs')) || [];
    if (!list.includes(src)) { if (list.length >= SRC_MAX) return; list.push(src); await this.ctx.storage.put('srcs', list); }
    const k = `src:${src}`, r = (await this.ctx.storage.get(k)) || { visits: 0, fresh: 0, players: 0, matches: 0, first: today, last: today };
    if (await this.once(`sv:${src}:${pkey}`)) { r.visits++; if (fresh) r.fresh++; }
    r.last = today;
    await this.ctx.storage.put(k, r);
    await this.ctx.storage.put(`ps:${pkey}`, { src, at: now });   // last tagged arrival of this device
  }
  async srcMatch(pkey, now, today) {
    const a = await this.ctx.storage.get(`ps:${pkey}`);
    if (!a || now - a.at > SRC_WINDOW) return;
    const k = `src:${a.src}`, r = await this.ctx.storage.get(k);
    if (!r) return;
    r.matches++; if (await this.once(`sp:${a.src}:${pkey}`)) r.players++;
    r.last = today;
    await this.ctx.storage.put(k, r);
  }

  live(now = Date.now()) {
    let humans = 0, rooms = 0, publicHumans = 0;
    for (const [id, r] of this.rooms) {
      if (now - r.at > ROOM_STALE || !r.humans) { if (now - r.at > ROOM_STALE) this.rooms.delete(id); continue; }
      humans += r.humans; rooms++; if (r.public) publicHumans += r.humans;
    }
    return { humans, rooms, publicHumans };
  }

  async fetch(request) {
    const url = new URL(request.url);
    const now = Date.now(), today = dayKey(now);
    if (url.pathname === '/event' && request.method === 'POST') {
      const e = await request.json().catch(() => ({}));
      const d = await this.day(today);
      if (e.type === 'open' && e.pkey) {
        if (await this.once(`o:${today}:${e.pkey}`)) d.opened++;
        if (e.src && SRC_RE.test(e.src)) await this.arrive(e.src, e.pkey, !!e.fresh, today, now);
      } else if (e.type === 'new') {
        d.newProfiles++;
      } else if (e.type === 'match') {
        d.matches++;
        d.kinds[e.kind] = (d.kinds[e.kind] || 0) + 1;
        d.humanSlots += e.humans || 0; d.botSlots += e.bots || 0;
        for (const p of e.players || []) {
          d.minutes += Math.max(0, Math.min(60, Number(p.minutes) || 0));
          d.missions += p.missions || 0; d.titles += p.titles || 0;
          if (!p.pkey) continue;
          if (await this.once(`pl:${today}:${p.pkey}`)) d.played++;
          await this.srcMatch(p.pkey, now, today);
          const rec = (await this.ctx.storage.get(`p:${p.pkey}`)) || { first: today, matches: 0 };
          if (rec.first === today && rec.matches === 0) d.newPlayers++;
          rec.matches++; rec.last = today; if (p.lv) rec.lv = p.lv;
          await this.ctx.storage.put(`p:${p.pkey}`, rec);
        }
      } else if (e.type === 'room' && e.roomId) {
        this.rooms.set(e.roomId, { humans: e.humans || 0, public: !!e.public, at: now });
        d.peak = Math.max(d.peak, this.live(now).humans);
      } else return json({ ok: false }, 400);
      await this.ctx.storage.put(`d:${today}`, d);
      if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(now + 24 * 3600e3);
      return json({ ok: true });
    }
    if (url.pathname === '/summary') {
      const days = Math.max(1, Math.min(KEEP_DAYS, Number(url.searchParams.get('days')) || 30));
      const rows = [];
      for (let i = days - 1; i >= 0; i--) {
        const k = dayKey(now - i * 86400e3);
        rows.push({ day: k, ...(await this.day(k)) });
      }
      // level histogram + returning players over everyone who has played at least one match
      const levels = Array(50).fill(0);
      let players = 0, active7 = 0, returning = 0;
      const since7 = dayKey(now - 6 * 86400e3);
      for (const [, r] of await this.ctx.storage.list({ prefix: 'p:' })) {
        players++;
        levels[Math.max(1, Math.min(50, r.lv || 1)) - 1]++;
        if (r.last >= since7) active7++;
        if (r.last > r.first) returning++;
      }
      const sources = [];
      for (const s of (await this.ctx.storage.get('srcs')) || []) { const r = await this.ctx.storage.get(`src:${s}`); if (r) sources.push({ src: s, ...r }); }
      sources.sort((a, b) => (a.src < b.src ? -1 : 1));
      return json({ today, rows, levels, totals: { players, active7, returning }, live: this.live(now), sources });
    }
    return json({ error: 'not found' }, 404);
  }

  // daily clean-up of per-day unique keys older than KEEP_DAYS
  async alarm() {
    const cutoff = dayKey(Date.now() - KEEP_DAYS * 86400e3);
    for (const prefix of ['o:', 'pl:']) {
      const old = [];
      for (const [k] of await this.ctx.storage.list({ prefix })) { if (k.slice(prefix.length, prefix.length + 10) < cutoff) old.push(k); if (old.length >= 128) break; }
      if (old.length) await this.ctx.storage.delete(old);
    }
    await this.ctx.storage.setAlarm(Date.now() + 24 * 3600e3);
  }
}

export const statsStub = (env) => env.STATS?.get(env.STATS.idFromName('global'));
export function statEvent(env, ctx, event) {
  const s = statsStub(env);
  if (!s) return;
  const p = s.fetch('https://stats/event', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(event) }).catch(() => {});
  if (ctx?.waitUntil) ctx.waitUntil(p);
}
