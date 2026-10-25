// Match logic checks without a server: team mode (balance, spawns, no friendly fire, team score)
// and first-to-N-kills (ends immediately at the target, for players and for teams).
import fs from 'node:fs';
import { makeWorld, heightAt, C, DT, muzzle } from '../shared/sim.js';
import { applyObstacles, SPAWNS } from '../shared/arena.js';
import { Game } from '../shared/game.js';
const meta = JSON.parse(fs.readFileSync('public/assets/arena_hf.json'));
const b = fs.readFileSync('public/assets/arena_hf.bin');
const w = makeWorld(meta, new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)));
w.spawns = SPAWNS; applyObstacles(w);
const mk = (rules) => {
  const out = { results: [], events: [], roster: null };
  const g = new Game(w, { send() {}, broadcast(t, d) { if (t === 'result') out.results.push(d); if (t === 'roster') out.roster = d; if (t === 's') out.events.push(...d.e); } }, { rules });
  out.g = g; return out;
};
const run = (g, sec) => { for (let i = 0; i < Math.round(sec / DT); i++) g.step(); };
// put shooter 12 m in front of target with a shell already in flight towards it
const shoot = (g, from, to) => {
  const a = g.players.get(from).tank, t = g.players.get(to).tank;
  t.x = 10; t.z = -20; t.y = heightAt(w, 10, -20) + C.hoverHeight; t.vx = t.vz = 0;
  a.x = 10; a.z = -32; a.y = heightAt(w, 10, -32) + C.hoverHeight; a.aimYaw = Math.PI; a.aimPitch = 0.02;
  g.players.get(to).invulnUntil = 0;
  g.shells.push({ id: g.shellId++, owner: from, seq: 1, ...muzzle(a), life: C.shellLife });
  run(g, 0.5);
};

// ---- team mode
let T = mk({ mode: 'team', goal: 'time' });
for (const id of ['A', 'B', 'C', 'D']) T.g.addPlayer(id, id);
const P = (id) => T.g.players.get(id);
console.log('teams by join order:', ['A', 'B', 'C', 'D'].map((id) => `${id}=${P(id).team}`).join(' '), '| colours', T.roster.players.map((p) => p.slot).join(','));
console.log('team spawns: red team on the west half =', ['A', 'C'].every((id) => P(id).tank.x < 0), '| blue on the east =', ['B', 'D'].every((id) => P(id).tank.x > 0));
const hpBefore = P('C').hp; shoot(T.g, 'A', 'C');
console.log('friendly fire (A shoots teammate C): C HP', hpBefore, '->', P('C').hp, '| hit events', T.events.filter((e) => e.t === 'hit').length);
for (let i = 0; i < 3; i++) { P('B').hp = 34; shoot(T.g, 'A', 'B'); run(T.g, 3.2); }
console.log('A kills enemy B 3x: A kills', P('A').kills, '| team score', T.g.teamKills());
T.g.onSwitchTeam('D'); console.log('D switches team ->', P('D').team, '| respawned on west =', P('D').tank.x < 0);

// ---- first to N kills (free-for-all)
let K = mk({ mode: 'ffa', goal: 'kills', target: 5 });
K.g.addPlayer('A', 'A'); K.g.addPlayer('B', 'B');
for (let i = 0; i < 5; i++) { K.g.players.get('B').hp = 34; shoot(K.g, 'A', 'B'); run(K.g, 3.2); if (K.results.length) break; }
console.log('FFA first to 5: match ended =', K.results.length === 1, '| winner', JSON.stringify(K.results[0]?.winner), '| A kills', K.g.players.get('A').kills, '| phase', K.g.phase);

// ---- first to N kills (teams)
let TK = mk({ mode: 'team', goal: 'kills', target: 5 });
for (const id of ['A', 'B', 'C']) TK.g.addPlayer(id, id);
for (let i = 0; i < 6 && !TK.results.length; i++) { const shooter = i % 2 ? 'C' : 'A'; TK.g.players.get('B').hp = 34; shoot(TK.g, shooter, 'B'); run(TK.g, 3.2); }
console.log('Team first to 5 (A and C share the kills): ended =', TK.results.length === 1, '| winner', JSON.stringify(TK.results[0]?.winner), '| teams', JSON.stringify(TK.results[0]?.teams));

// ---- rules change via new game
K.g.lastNewGame = -99; K.g.onNewGame('A', { mode: 'team', goal: 'time' }); run(K.g, 0.1);
console.log('new game with team rules: mode', K.g.rules.mode, '| teams', [...K.g.players.values()].map((p) => p.team).join(','), '| phase', K.g.phase, '| timer', Math.round(K.g.phaseEnds - K.g.time));
