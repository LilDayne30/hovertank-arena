// Spawn protection: a freshly spawned tank is shielded, and firing removes the shield at once.
const URL = process.env.URL || 'http://localhost:8787';
const { id } = await (await fetch(`${URL}/api/rooms`, { method: 'POST' })).json();
const ws = new WebSocket(`${URL.replace(/^http/, 'ws')}/api/rooms/${id}/ws?name=s`);
let me, before = null, after = null, unshield = false, seq = 0, fired = false;
ws.onmessage = (ev) => {
  const [t, d] = JSON.parse(ev.data);
  if (t === 'welcome') me = d.id;
  if (t !== 's') return;
  const p = d.p.find((x) => x[0] === me); if (!p) return;
  const shielded = !!(p[11] & 4);
  if (d.e.some((e) => e.t === 'unshield' && e.v === me)) unshield = true;
  if (before === null) { before = shielded; ws.send(JSON.stringify(['i', [{ seq: ++seq, mx: 0, mz: 0, ay: 0, ap: 0, f: true }]])); fired = true; return; }
  if (fired && after === null && unshield) after = shielded;
};
await new Promise((r) => setTimeout(r, 1500));
console.log(`shield right after spawn: ${before} | 'unshield' event after firing: ${unshield} | shield after firing: ${after}`);
ws.close(); process.exit(0);
