// Server: sign in with Google / Apple (mock tokens), linking, switching devices, unlink, deletion.
//   AUTH_MOCK=1 IAP_MOCK=1 scratch/with-server.sh 8950 node test/auth.mjs
import { createHash } from 'node:crypto';
const URL = process.env.URL;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) process.exitCode = 1; };
const api = async (path, { token, body } = {}) => {
  const r = await fetch(URL + path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => null) };
};
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const RUN = Date.now().toString(36);
const G = { iss: 'https://accounts.google.com', aud: 'test-web.apps.googleusercontent.com' };
const A = { iss: 'https://appleid.apple.com', aud: 'com.lildayne.hovertank' };
const idt = (base, sub, nonce, extra = {}) => `${b64({ alg: 'mock' })}.${b64({ ...base, sub: `${RUN}-${sub}`, exp: Math.floor(Date.now() / 1000) + 600, nonce, ...extra })}.x`;
const nonce = async () => (await api('/api/auth/nonce', { body: {} })).data.nonce;
const signIn = async (prov, sub, token, extra, opts = {}) => {
  const n = await nonce();
  const tn = opts.hash ? createHash('sha256').update(n).digest('hex') : n;
  return api(`/api/auth/${prov}`, { token, body: { idToken: idt(prov === 'google' ? G : A, sub, tn, extra), nonce: n } });
};
const newProfile = async () => (await api('/api/profile/new', { body: {} })).data.token;

const cfg = await api('/api/auth/config');
ok(cfg.status === 200 && cfg.data.google.web === G.aud && 'web' in cfg.data.apple, `config: ${JSON.stringify(cfg.data)}`);

const P = await newProfile();
let r = await signIn('google', 'g1', P);
ok(r.status === 200 && r.data.status === 'linked' && r.data.view.links.includes('google'), `guest links Google: ${r.data?.status} ${JSON.stringify(r.data?.view?.links)}`);

// token checks
const n1 = await nonce();
r = await api('/api/auth/google', { token: P, body: { idToken: idt(G, 'g1', n1), nonce: n1 } });
ok(r.status === 200, 'signing in again with the same account: ok');
r = await api('/api/auth/google', { token: P, body: { idToken: idt(G, 'g1', n1), nonce: n1 } });
ok(r.status === 401 && r.data.error === 'bad_nonce', 'a used nonce is refused (no replay)');
const n2 = await nonce();
r = await api('/api/auth/google', { body: { idToken: idt({ ...G, aud: 'someone-else' }, 'g1', n2), nonce: n2 } });
ok(r.status === 401 && r.data.error === 'wrong_audience', 'token for another app refused');
r = await api('/api/auth/google', { body: { idToken: idt({ ...G, iss: 'https://evil.example' }, 'g1', n2), nonce: n2 } });
ok(r.status === 401 && r.data.error === 'wrong_issuer', 'token from another issuer refused');
r = await api('/api/auth/google', { body: { idToken: idt(G, 'g1', n2, { exp: 1000 }), nonce: n2 } });
ok(r.status === 401 && r.data.error === 'expired', 'expired token refused');
r = await api('/api/auth/google', { body: { idToken: idt(G, 'g1', 'not-issued'), nonce: 'not-issued' } });
ok(r.status === 401 && r.data.error === 'bad_nonce', 'nonce we never issued refused');
r = await api('/api/auth/google', { body: { idToken: 'garbage', nonce: n2 } });
ok(r.status === 400, 'malformed token refused');

// another device
r = await signIn('google', 'g1', null);
ok(r.status === 200 && r.data.status === 'signedin' && r.data.token === P, 'new device without a profile: signed in to the linked profile');
const fresh = await newProfile();
r = await signIn('google', 'g1', fresh);
ok(r.status === 200 && r.data.status === 'signedin' && r.data.token === P, 'new device with an empty guest profile: switched automatically');

// a device whose guest profile has progress: asked first
const C = await newProfile();
await api('/api/profile/iap', { token: C, body: { platform: 'ios', productId: 'com.lildayne.hovertank.gem_pack_1', transactionId: `mock-auth-${RUN}` } });
r = await signIn('google', 'g1', C);
ok(r.status === 409 && r.data.status === 'conflict' && r.data.ticket && r.data.current.gems === 100, `guest with progress: conflict ${JSON.stringify(r.data?.current)} vs ${JSON.stringify(r.data?.other)}`);
const sw = await api('/api/auth/switch', { body: { ticket: r.data.ticket } });
ok(sw.status === 200 && sw.data.token === P, 'player chose to switch: signed in to the linked profile');
ok((await api('/api/auth/switch', { body: { ticket: r.data.ticket } })).status === 404, 'a switch ticket works once');

// Apple (native sign-in puts the SHA-256 of the nonce into the token)
r = await signIn('apple', 'a1', P, {}, { hash: true });
ok(r.status === 200 && r.data.status === 'linked' && r.data.view.links.includes('apple') && r.data.view.links.includes('google'), `Apple linked too (hashed nonce): ${JSON.stringify(r.data?.view?.links)}`);
r = await signIn('apple', 'a1', null, { aud: 'com.lildayne.hovertank.web' });
ok(r.status === 200 && r.data.token === P, 'Apple on the web (Services ID) signs in to the same profile');

// one Google account per profile; an account belongs to one profile
r = await signIn('google', 'g2', P);
ok(r.status === 409 && r.data.error === 'other_account', 'a second Google account cannot be linked to the same profile');
r = await signIn('google', 'g3', C);
ok(r.status === 200 && r.data.status === 'linked', 'another profile links its own Google account');

// unlink, then delete
r = await api('/api/profile/unlink', { token: P, body: { provider: 'google' } });
ok(r.status === 200 && JSON.stringify(r.data.links) === '["apple"]', `unlink Google: ${JSON.stringify(r.data?.links)}`);
r = await signIn('google', 'g1', null);
ok(r.status === 200 && r.data.status === 'signedin' && r.data.token !== P, 'after unlinking, that Google account starts a new profile');
r = await api('/api/profile/delete', { token: P, body: {} });
ok(r.status === 200, 'delete data');
r = await signIn('apple', 'a1', null, {}, { hash: true });
ok(r.status === 200 && r.data.token !== P && r.data.profile.xp === 0, 'after deletion the Apple account no longer reaches the old profile');
