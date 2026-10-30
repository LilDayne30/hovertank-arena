// End-of-match flow: play -> result (stays there: the next match starts when everyone is ready, see test/result-flow.mjs).
//   npx wrangler dev --var MATCH_SECONDS:8   then   URL=http://localhost:8787 node test/match-end.mjs
const URL = process.env.URL || 'http://localhost:8787';
const { id } = await (await fetch(`${URL}/api/rooms`, { method: 'POST' })).json();
const ws = new WebSocket(`${URL.replace(/^http/, 'ws')}/api/rooms/${id}/ws?name=m`);
const phases = []; let result = null; const t0 = Date.now();
ws.onmessage = (ev) => {
  const [t, d] = JSON.parse(ev.data);
  if (t === 's' && phases[phases.length - 1]?.ph !== d.ph) phases.push({ ph: d.ph, at: ((Date.now() - t0) / 1000).toFixed(1), tl: d.tl });
  if (t === 'result') result = d;
};
await new Promise((r) => setTimeout(r, 21000));
console.log('phase changes:', JSON.stringify(phases));
console.log('result message:', JSON.stringify(result));
ws.close(); process.exit(0);
