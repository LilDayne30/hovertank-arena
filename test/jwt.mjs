// ES256 (Apple) and RS256 (Google) JWTs made by worker/jwt.js verify with standard tools.   node test/jwt.mjs
import { generateKeyPairSync, createVerify, createPublicKey, verify } from 'node:crypto';
import { signJwt, jwsPayload } from '../worker/jwt.js';
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) process.exitCode = 1; };
const b = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
{
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const jwt = await signJwt({ alg: 'ES256', kid: 'K1', typ: 'JWT' }, { iss: 'I', aud: 'appstoreconnect-v1' }, pem, 'ES256');
  const [h, p, s] = jwt.split('.');
  ok(verify('sha256', Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, b(s)), 'ES256 signature verifies (Apple .p8 style key)');
  ok(jwsPayload(jwt).aud === 'appstoreconnect-v1' && JSON.parse(b(h)).kid === 'K1', 'ES256 header / claims readable');
}
{
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const jwt = await signJwt({ alg: 'RS256', typ: 'JWT' }, { iss: 'svc@x.iam.gserviceaccount.com' }, pem, 'RS256');
  const [h, p, s] = jwt.split('.');
  const v = createVerify('RSA-SHA256'); v.update(`${h}.${p}`);
  ok(v.verify(publicKey, b(s)), 'RS256 signature verifies (Google service-account style key)');
}
