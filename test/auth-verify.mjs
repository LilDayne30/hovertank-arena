// Unit: real RS256 ID token checks (signature, key id) with a local key standing in for Google's.
//   node test/auth-verify.mjs   (bundles worker/auth.js with a stub for cloudflare:workers)
import { build } from 'esbuild';
import { generateKeyPairSync, createSign, randomUUID } from 'node:crypto';
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) process.exitCode = 1; };
const out = `scratch/auth-bundle-${process.pid}.mjs`;
await build({ entryPoints: ['worker/auth.js'], bundle: true, format: 'esm', platform: 'neutral', outfile: out, alias: { 'cloudflare:workers': './test/stubs/cloudflare-workers.js' }, logLevel: 'error' });
const { verifyIdToken } = await import(`../${out}`);
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
const kid = randomUUID();
const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };
globalThis.fetch = async (url) => { if (String(url).includes('googleapis.com/oauth2/v3/certs')) return new Response(JSON.stringify({ keys: [jwk] })); throw new Error('unexpected fetch ' + url); };
const env = { GOOGLE_WEB_CLIENT_ID: 'web-1.apps.googleusercontent.com' };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const sign = (claims, key = privateKey, k = kid) => {
  const h = b64({ alg: 'RS256', kid: k, typ: 'JWT' }), p = b64(claims);
  return `${h}.${p}.${createSign('RSA-SHA256').update(`${h}.${p}`).sign(key).toString('base64url')}`;
};
const good = { iss: 'https://accounts.google.com', aud: env.GOOGLE_WEB_CLIENT_ID, sub: '123', exp: Math.floor(Date.now() / 1000) + 600, nonce: 'n' };
const c = await verifyIdToken(env, 'google', sign(good));
ok(c.sub === '123' && c.aud === env.GOOGLE_WEB_CLIENT_ID, 'valid RS256 token accepted');
const err = async (t) => { try { await verifyIdToken(env, 'google', t); return 'accepted'; } catch (e) { return e.code; } };
ok(await err(sign(good, other.privateKey)) === 'bad_signature', 'signed with another key: refused');
const [h, p, s] = sign(good).split('.');
ok(await err(`${h}.${b64({ ...good, sub: '999' })}.${s}`) === 'bad_signature', 'claims changed after signing: refused');
ok(await err(sign(good, privateKey, 'nope')) === 'unknown_key', 'unknown key id: refused');
ok(await err(`${b64({ alg: 'mock' })}.${p}.x`) === 'bad_token', 'mock tokens refused when AUTH_MOCK is off');
ok(await err(`${b64({ alg: 'none' })}.${p}.`) === 'bad_token', 'alg "none" refused');
ok(await err(sign({ ...good, aud: 'x' })) === 'wrong_audience', 'wrong audience refused');
(await import('node:fs')).unlinkSync(out);
