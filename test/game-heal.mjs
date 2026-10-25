// Match logic checks without a server: heal pickup timing/effect and "new game".
import fs from 'node:fs';
import { makeWorld, heightAt, C, DT } from '../shared/sim.js';
import { applyObstacles, SPAWNS, HEAL_INTERVAL, HEAL_POS } from '../shared/arena.js';
import { Game } from '../shared/game.js';
const meta = JSON.parse(fs.readFileSync('public/assets/arena_hf.json'));
const b = fs.readFileSync('public/assets/arena_hf.bin');
const w = makeWorld(meta, new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)));
w.spawns = SPAWNS; applyObstacles(w);
const events = [];
const g = new Game(w, { send() {}, broadcast(t, d) { if (t === 's') for (const e of d.e) events.push({ ...e, at: +g.time.toFixed(2), hl: d.hl, hn: d.hn }); } });
g.addPlayer('A', 'A'); g.addPlayer('B', 'B');
const A = g.players.get('A'), B = g.players.get('B');
const run = (sec) => { for (let i = 0; i < Math.round(sec / DT); i++) g.step(); };
const placeOnHill = (p) => { p.tank.x = HEAL_POS.x + 0.5; p.tank.z = HEAL_POS.z; p.tank.y = heightAt(w, p.tank.x, p.tank.z) + C.hoverHeight; p.tank.vx = p.tank.vz = 0; };

run(HEAL_INTERVAL - 1);
console.log('before 40 s: pickup active =', g.heal.active);
run(1.2);
const spawnEv = events.find((e) => e.t === 'healspawn');
console.log('healspawn event at', spawnEv?.at, 's | active =', g.heal.active);
placeOnHill(A); run(0.2);
console.log('A at full HP on the hill: picked up =', events.some((e) => e.t === 'heal'), '(should be false, it stays for someone who needs it)');
A.hp = 32; placeOnHill(A); run(0.2);
const healEv = events.find((e) => e.t === 'heal');
console.log('A at 32 HP on the hill: heal event =', !!healEv, '| HP now', A.hp, '| active =', g.heal.active, '| next in', g.heal.nextAt - g.time > HEAL_INTERVAL - 1 ? `${HEAL_INTERVAL}s` : (g.heal.nextAt - g.time).toFixed(1));
run(HEAL_INTERVAL + 0.5);
console.log('respawned 40 s after pickup:', events.filter((e) => e.t === 'healspawn').length === 2);

// new game
A.kills = 3; B.deaths = 3; g.phaseEnds = g.time + 12;
g.onNewGame('B'); run(0.1);
console.log('new game by B: kills/deaths reset =', A.kills === 0 && B.deaths === 0, '| timer reset to', Math.round(g.phaseEnds - g.time), 's | heal reset (inactive, next in 40 s) =', !g.heal.active && Math.round(g.heal.nextAt - g.time) === HEAL_INTERVAL, '| event =', events.some((e) => e.t === 'newgame' && e.by === 'B'));
g.onNewGame('A'); run(0.1);
console.log('second new game within 3 s ignored =', events.filter((e) => e.t === 'newgame').length === 1);
