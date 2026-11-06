// Sign in with Google / Apple (optional). Gets an ID token from the provider and hands it to the
// server (worker/auth.js), which links the account to this profile or signs in to the profile the
// account already belongs to.
//   web:      Google Identity Services (its own button) and Sign in with Apple JS (popup)
//   iOS app:  native Google and Apple sign-in (@capgo/capacitor-social-login)
//   Android:  native Google sign-in (Credential Manager). Apple is not offered there.
import { NATIVE, PLATFORM, API_BASE } from './platform.js';

let cfg = null;
export async function authConfig() {
  if (!cfg) cfg = await fetch(`${API_BASE}/api/auth/config`).then((r) => r.json()).catch(() => ({ google: {}, apple: {} }));
  return cfg;
}
// which sign-in buttons this device can show
export async function providers() {
  const c = await authConfig();
  const list = [];
  if (NATIVE ? (PLATFORM === 'ios' ? c.google.ios : c.google.web) : c.google.web) list.push('google');
  if (PLATFORM === 'ios' || (!NATIVE && c.apple.web)) list.push('apple');
  return list;
}
const nonce = async () => (await fetch(`${API_BASE}/api/auth/nonce`, { method: 'POST' }).then((r) => r.json())).nonce;
const script = (src) => new Promise((res, rej) => {
  if (document.querySelector(`script[src="${src}"]`)) return res();
  const s = Object.assign(document.createElement('script'), { src, async: true, onload: res, onerror: () => rej(new Error('load')) });
  document.head.appendChild(s);
});

// ---------------------------------------------------------------- native (iOS / Android app)
let social = null;
async function native() {
  if (social) return social;
  const c = await authConfig();
  const { SocialLogin } = await import('@capgo/capacitor-social-login');
  await SocialLogin.initialize({
    google: { webClientId: c.google.web || undefined, iOSClientId: c.google.ios || undefined, iOSServerClientId: c.google.web || undefined, mode: 'online' },
    ...(PLATFORM === 'ios' ? { apple: {} } : {}),
  });
  social = SocialLogin;
  return social;
}
// -> { idToken, nonce, code? }; throws { cancelled: true } when the player closes the sign-in
export async function nativeToken(provider) {
  const sl = await native(), n = await nonce();
  try {
    const { result } = await sl.login({ provider, options: provider === 'google' ? { nonce: n, scopes: ['openid'] } : { nonce: n, scopes: [] } });
    if (!result?.idToken) throw new Error('no_token');
    // Apple (legacy mode): accessToken.token is the authorization code, kept by the server to revoke on deletion
    return { idToken: result.idToken, nonce: n, code: provider === 'apple' ? result.accessToken?.token || result.authorizationCode : undefined };
  } catch (e) { throw Object.assign(new Error(e?.message || 'cancelled'), { cancelled: /cancel|1001|12501|dismiss/i.test(String(e?.message || e?.code || '')) }); }
}

// ---------------------------------------------------------------- web
// Google draws its own button (required for ID tokens on the web). onToken gets { idToken, nonce }.
// A nonce is single-use, so the button is drawn again after every attempt.
export async function renderGoogleButton(el, onToken, { locale = 'ja', width = 240 } = {}) {
  const c = await authConfig();
  if (!c.google.web) return false;
  await script('https://accounts.google.com/gsi/client');
  const draw = async () => {
    const n = await nonce();
    window.google.accounts.id.initialize({
      client_id: c.google.web, nonce: n, ux_mode: 'popup', use_fedcm_for_button: true, auto_select: false, itp_support: true,
      callback: (resp) => { if (resp?.credential) onToken({ idToken: resp.credential, nonce: n }); draw(); },
    });
    el.innerHTML = '';
    window.google.accounts.id.renderButton(el, { type: 'standard', theme: 'outline', size: 'large', shape: 'pill', text: 'continue_with', locale, width });
  };
  await draw();
  return true;
}
export async function webAppleToken() {
  const c = await authConfig();
  await script('https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/ja_JP/appleid.auth.js');
  const n = await nonce();
  window.AppleID.auth.init({ clientId: c.apple.web, scope: '', redirectURI: `${location.origin}/`, usePopup: true, nonce: n });
  try {
    const r = await window.AppleID.auth.signIn();
    return { idToken: r.authorization.id_token, nonce: n, code: r.authorization.code };
  } catch (e) { throw Object.assign(new Error(e?.error || 'cancelled'), { cancelled: /popup_closed|user_cancelled/.test(String(e?.error || '')) }); }
}
