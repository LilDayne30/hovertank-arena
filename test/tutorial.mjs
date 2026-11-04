// Tutorial room logic (no server needed): targets that never shoot, each step checked in order,
// the meter filled for the special step, "done" reported once.   node test/tutorial.mjs
import { readFileSync } from 'node:fs';
import { makeWorld, C, solveAim } from '../shared/sim.js';
import { SPAWNS, applyObstacles } from '../shared/arena.js';
import { Game } from '../shared/game.js';
import { TUT_STEPS, TUT_PLAYER } from '../shared/tutorial.js';
import { ULT_MAX } from '../shared/abilities.js';
import { ITEMS, owned } from '../shared/progress.js';
import { randomLook } from '../shared/bot.js';

const meta = JSON.parse(readFileSync('public/assets/arena_hf.json'));
const buf = readFileSync('public/assets/arena_hf.bin');
const world = makeWorld(meta, new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4));
world.spawns = SPAWNS; applyObstacles(world);
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) process.exitCode = 1; };

const sent = [], done = [];
const g = new Game(world, { send: (id, type, data) => { if (type === 'tut') sent.push(data); }, broadcast() {}, tutorialDone: (p) => done.push(p.id) }, { tutorial: true });
const me = g.addPlayer('me', 'Me');
g.onLoadout('me', { side: 'dash', ult: 'mega' });
const bots = [...g.players.values()].filter((p) => p.bot);
ok(bots.length === 2 && bots.every((b) => b.bot.level === 'dummy'), `two target tanks: ${bots.map((b) => b.name).join(', ')}`);
ok(Math.hypot(me.tank.x - TUT_PLAYER.x, me.tank.z - TUT_PLAYER.z) < 0.5, 'player starts in the tutorial corner');
ok(!Number.isFinite(g.phaseEnds), 'no time limit');
ok(g.welcome('me').tut?.step === 0, 'welcome carries the tutorial step');

let seq = 0;
const step = (n, fn = () => ({})) => { for (let i = 0; i < n; i++) { g.onInput('me', [{ seq: ++seq, mx: 0, mz: 0, ay: me.tank?.aimYaw ?? 0, ap: 0, ...fn(i) }]); g.step(); } };
const aimAt = (b) => { if (!b) return {}; const [ay, ap] = solveAim(me.tank, { x: b.tank.x, y: b.tank.y + C.hitCenterY, z: b.tank.z }); return { ay, ap }; };
const stepNow = () => TUT_STEPS[me.tut?.step ?? 0]?.id;

// the targets never fire, even after a long time
step(30 * 20);
ok(g.shells.every((s) => s.owner === 'me') && me.hp === C.maxHp, 'targets do not shoot (20 s)');
ok(bots.every((b) => Math.hypot(b.tank.x - b.tutHome.x, b.tank.z - b.tutHome.z) < 7), 'targets stay near their spots while the player is near');

// 1 move: drive towards the centre
ok(stepNow() === 'move', 'step 1: move');
step(30 * 3, () => ({ mx: 0, mz: 1 }));
ok(stepNow() === 'hit', `moved -> step 2 (hit); progress messages: ${sent.length}`);
// a jump before its step does not count
step(5, () => ({ j: true })); step(30);
ok(stepNow() === 'hit', 'jumping early does not skip the shooting step');

// 2 hit twice: aim at the nearest target and fire until 2 hits
const tgt = () => bots.filter((b) => b.alive).sort((a, b) => Math.hypot(a.tank.x - me.tank.x, a.tank.z - me.tank.z) - Math.hypot(b.tank.x - me.tank.x, b.tank.z - me.tank.z))[0];
for (let i = 0; i < 30 * 12 && stepNow() === 'hit'; i++) step(1, () => ({ ...aimAt(tgt()), f: i % 4 === 0 }));
ok(stepNow() === 'jump', 'two hits -> step 3 (jump)');
// 3 jump
step(1, () => ({ j: true })); step(10);
ok(stepNow() === 'side', 'jumped -> step 4 (sidearm)');
// 4 sidearm
step(1, () => ({ a: true })); step(30);
ok(stepNow() === 'ult', 'sidearm used -> step 5 (special)');
ok(me.tank.ult >= ULT_MAX, 'special meter filled for the special step');
// 5 special
step(1, () => ({ ...aimAt(tgt()), u: true })); step(5);
ok(stepNow() === 'kill' || me.tut.step === TUT_STEPS.length, 'special used -> step 6 (destroy a target; done at once if the special shot killed one)');
// 6 kill
let killT = 0;
for (let i = 0; i < 30 * 40 && stepNow() === 'kill'; i++, killT++) step(1, () => ({ ...aimAt(tgt()), f: i % 4 === 0 }));
console.log(`      kill step took ${(killT / 30).toFixed(1)} s of aiming and firing`);
ok(me.tut.step === TUT_STEPS.length && done.length === 1 && done[0] === 'me', `target destroyed -> tutorial done (reported ${done.length}x)`);
ok(sent.at(-1)?.done === true, 'last message says done');
step(30 * 5, () => ({ ...aimAt(tgt()), f: true }));
ok(done.length === 1, 'done is reported only once');

// rewards: exclusive items, not on CPU tanks, not from levels
const rew = ITEMS.filter((i) => i.unlock.ach === 'tutorial');
ok(rew.length === 3 && ['paint', 'rear', 'title'].every((s) => rew.some((i) => i.slot === s)), `reward items: ${rew.map((i) => i.key).join(', ')}`);
ok(rew.every((i) => !owned(50, {}).has(i.key)) && rew.every((i) => owned(1, { tutorial: 1 }).has(i.key)), 'owned only after the tutorial');
let leaked = false;
for (let i = 0; i < 400; i++) { const l = randomLook(i % 2 ? undefined : 50); if (rew.some((r) => l[r.slot] === r.id)) leaked = true; }
ok(!leaked, 'CPU tanks never wear the tutorial rewards');
