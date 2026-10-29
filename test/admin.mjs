// Admin profile (every item unlocked) via /api/admin/grant.
//   wrangler dev --var ADMIN_KEY_HASH:$(printf local-test-key | sha256sum | cut -d' ' -f1)   then   URL=http://localhost:8787 node test/admin.mjs
const U = process.env.URL || 'http://localhost:8787';
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) process.exitCode = 1; };
const j = (r) => r.json();
const { token, profile } = await fetch(`${U}/api/profile/new`, { method: 'POST' }).then(j);
ok(!profile.admin && profile.owned.length < 101, `new profile owns ${profile.owned.length}`);
const g = (key, on) => fetch(`${U}/api/admin/grant`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ token, on }) });
ok((await g('wrong', true)).status === 401, 'wrong admin key refused');
const v = await (await g((process.env.AKEY || 'local-test-key'), true)).json();
ok(v.admin && v.owned.length === 101 && v.level === profile.level, `admin profile owns ${v.owned.length} items, level unchanged (Lv${v.level})`);
const { ITEMS } = await import('../shared/progress.js');
const top = Object.fromEntries(['pattern', 'turret', 'aero', 'frame', 'title', 'emblem'].map((s) => [s, ITEMS.filter((i) => i.slot === s).at(-1)?.id]));
const v2 = await fetch(`${U}/api/profile/look`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ look: top }) }).then(j);
ok(Object.entries(top).every(([k, id]) => !id || v2.look[k] === id), `top-tier items can be equipped: ${JSON.stringify(v2.look)}`);
const v3 = await (await g((process.env.AKEY || 'local-test-key'), false)).json();
ok(!v3.admin && v3.owned.length === profile.owned.length && v3.look.turret !== top.turret, 'back to normal: locked items taken off again');
