// Quick match: one global Durable Object that keeps the list of PUBLIC rooms (rooms made with
// "quick match"). Private rooms ("create room" + invite link) are never listed here.
// Rooms report their player count on every join/leave and once a minute while occupied.
import { DurableObject } from 'cloudflare:workers';
import { cleanRules, MAX_PLAYERS, goalKey } from '../shared/arena.js';
import { roomCode } from './codes.js';

const STALE_MS = 3 * 60 * 1000;      // a room that has not reported for 3 min is dropped
const HOLD_MS = 15 * 1000;           // a seat handed out by /match is held this long for the joiner
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

export class Matchmaker extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.rooms = new Map();     // id -> { id, players, mode, at }
    this.holds = new Map();     // id -> [expiry timestamps of seats handed out]
    this.creating = new Map();  // id -> promise of the room's /init while it is being created
    ctx.blockConcurrencyWhile(async () => {
      const all = await ctx.storage.list({ prefix: 'r:' });
      for (const [, v] of all) this.rooms.set(v.id, v);
    });
  }

  held(id, now) {
    const h = (this.holds.get(id) || []).filter((t) => t > now);
    this.holds.set(id, h);
    return h.length;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const now = Date.now();
    const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};

    if (url.pathname === '/update') {
      const { id, players, mode, size, open, goal, target } = body;
      if (!id) return json({ ok: false }, 400);
      if (!players) { this.rooms.delete(id); this.holds.delete(id); await this.ctx.storage.delete(`r:${id}`); return json({ ok: true }); }
      const prev = this.rooms.get(id);
      // a join that we handed out has arrived: release one held seat
      if (prev && players > prev.players) { const h = this.holds.get(id) || []; h.splice(0, players - prev.players); this.holds.set(id, h); }
      const entry = { id, players, mode: mode === 'team' ? 'team' : 'ffa', size: prev?.size || cleanRules({ mode, size }).size, gk: goalKey({ goal, target }), open: open !== false, at: now };
      this.rooms.set(id, entry);
      await this.ctx.storage.put(`r:${id}`, entry);
      return json({ ok: true });
    }

    if (url.pathname === '/match') {
      const want = body.mode === 'team' || body.mode === 'ffa' ? body.mode : 'any';
      // how many tanks fight: 2 / 3 / 4 (team battle is always 4 = 2 v 2)
      const size = cleanRules({ mode: want === 'team' ? 'team' : 'ffa', size: body.size }).size;
      const exclude = new Set(Array.isArray(body.exclude) ? body.exclude : []);
      const gk = goalKey(body);   // win condition: 5 min or first to N kills
      // drop rooms that stopped reporting
      for (const [id, r] of this.rooms) if (now - r.at > STALE_MS && this.held(id, now) === 0) { this.rooms.delete(id); this.ctx.storage.delete(`r:${id}`); }
      // fill the fullest room first so players actually meet each other
      const candidates = [...this.rooms.values()]
        .filter((r) => !exclude.has(r.id) && (want === 'any' || r.mode === want) && (r.size || 4) === size && (r.gk || 't') === gk && r.open !== false)
        .map((r) => ({ ...r, taken: r.players + this.held(r.id, now) }))
        .filter((r) => r.taken < (r.size || MAX_PLAYERS))
        .sort((a, b) => b.taken - a.taken || b.at - a.at);
      let id = candidates[0]?.id;
      // hold the seat right away (before any await) so simultaneous requests see it
      const hold = () => { const h = this.holds.get(id) || []; h.push(now + HOLD_MS); this.holds.set(id, h); };
      if (id) {
        hold();
        if (this.creating.has(id)) await this.creating.get(id);   // room still being set up
        return json({ id, created: false });
      }
      id = roomCode();
      const rules = cleanRules({ mode: want === 'team' ? 'team' : 'ffa', goal: body.goal === 'kills' ? 'kills' : 'time', target: body.target, size });
      const entry = { id, players: 0, mode: rules.mode, size: rules.size, gk: goalKey(rules), open: true, at: now };
      this.rooms.set(id, entry);
      hold();
      // other matches arriving while the room is being created join this same room
      const ready = this.env.ROOMS.get(this.env.ROOMS.idFromName(id)).fetch('https://room/init', {
        method: 'POST', headers: { 'x-room-id': id, 'content-type': 'application/json' }, body: JSON.stringify({ rules, public: true }),
      });
      this.creating.set(id, ready);
      try { await ready; } finally { this.creating.delete(id); }
      await this.ctx.storage.put(`r:${id}`, entry);
      return json({ id, created: true });
    }

    if (url.pathname === '/stats') {
      let players = 0, rooms = 0;
      for (const r of this.rooms.values()) if (now - r.at <= STALE_MS) { players += r.players; rooms++; }
      return json({ players, rooms });
    }
    return new Response('not found', { status: 404 });
  }
}
