// Progression client: keeps the anonymous profile token on this device and talks to /api/profile.
// The server decides everything (XP, unlocks); this only caches the latest view for the UI.
import { NATIVE, PLATFORM } from './platform.js';
const KEY = 'ht-pid';
const get = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
const set = (v) => { try { localStorage.setItem(KEY, v); } catch { /* private mode: profile lasts this session */ } };
// where this visit came from: a link like /?s=t1a (an X post). Read once, then removed from the address bar
// so a copied link does not carry it on. Only the tag itself is sent; the owner's dashboard counts per tag.
export const SRC_RE = /^[a-z0-9_-]{1,24}$/;
let arrivalSrc = (() => {
  try {
    const u = new URL(location.href), s = (u.searchParams.get('s') || '').trim().toLowerCase();
    if (!u.searchParams.has('s')) return null;
    const rest = u.search.slice(1).split('&').filter((x) => x && x.split('=')[0] !== 's');   // keep the others exactly as written
    history.replaceState(history.state, '', u.pathname + (rest.length ? `?${rest.join('&')}` : '') + u.hash);
    return SRC_RE.test(s) ? s : null;
  } catch { return null; }
})() || (NATIVE ? `app-${PLATFORM}` : null);   // installs from the stores are counted as app-ios / app-android

export class Profile {
  constructor(base) {
    this.base = base;
    this.token = get();
    this.view = null;
    this.listeners = new Set();
  }
  onChange(fn) { this.listeners.add(fn); if (this.view) fn(this.view); }
  emit() { for (const fn of this.listeners) fn(this.view); }

  async call(path, body, root = '/api/profile') {
    const src = (path === '' || path === '/new') ? arrivalSrc : null;
    const r = await fetch(`${this.base}${root}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}), ...(src ? { 'x-src': src } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store',
    });
    if (src && r.ok) arrivalSrc = null;   // counted once per visit
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(data.error || `HTTP ${r.status}`), { status: r.status, data });
    return data;
  }

  // first launch creates a profile; afterwards it is loaded
  async load() {
    if (!this.token) {
      const { token, profile } = await this.call('/new', {});
      this.token = token; set(token); this.view = profile;
    } else {
      try { this.view = await this.call(''); } catch (e) {
        if (e.status !== 401) throw e;
        const { token, profile } = await this.call('/new', {});   // token was malformed: start fresh
        this.token = token; set(token); this.view = profile;
      }
    }
    this.emit();
    return this.view;
  }
  async saveLook(look) { this.view = await this.call('/look', { look }); this.emit(); return this.view; }
  async reroll(index) { this.view = await this.call('/reroll', { index }); this.emit(); return this.view; }
  async transferCode() { return this.call('/transfer', {}); }
  // erase this profile on the server and forget the key on this device (a fresh one is made on the next start)
  async deleteData() {
    await this.call('/delete', {});
    this.token = null; this.view = null;
    try { localStorage.removeItem(KEY); } catch { /* ignore */ }
  }
  async redeem(code) {
    const { token, profile } = await this.call('/redeem', { code });
    this.token = token; set(token); this.view = profile; this.emit();
    return profile;
  }
  // sign in with Google / Apple (client/auth.js gets the ID token). Returns
  //   { status: 'linked' }                        this profile now has the account
  //   { status: 'signedin', level }               switched to the profile the account belongs to
  //   { status: 'conflict', ticket, current, other }   ask the player, then switchTo(ticket)
  async signIn(provider, tok) {
    try {
      const r = await this.call(`/${provider}`, tok, '/api/auth');
      return this.applyAuth(r);
    } catch (e) { if (e.status === 409 && e.data?.status === 'conflict') return e.data; throw e; }
  }
  async switchTo(ticket) { return this.applyAuth(await this.call('/switch', { ticket }, '/api/auth')); }
  applyAuth(r) {
    if (r.status === 'linked') { this.view = r.view; this.emit(); return r; }
    if (r.status === 'signedin') { this.token = r.token; set(r.token); this.view = r.profile; this.emit(); return { status: 'signedin', level: r.profile.level }; }
    return r;
  }
  async unlink(provider) { this.view = await this.call('/unlink', { provider }); this.emit(); return this.view; }
  // a match result from the room ('prog' message) carries the new view
  applyProgress(res) { if (res?.view) { this.view = res.view; this.emit(); } }
}
