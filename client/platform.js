// Web or the Android / iOS app (Capacitor). The app bundles the game files and talks to the same
// server as the website; a few web-only things (service worker, "add to home screen", full-screen
// button) are hidden and the profile key is backed up in native storage, because the app's web view
// may clear localStorage when the phone runs low on space.
import { Capacitor } from '@capacitor/core';

export const NATIVE = Capacitor.isNativePlatform();
export const PLATFORM = Capacitor.getPlatform();   // 'ios' | 'android' | 'web'
export const SERVER = 'https://hovertank-arena.lildayne.workers.dev';
export const API_BASE = NATIVE ? SERVER : location.origin;

// localStorage keys worth keeping (the profile key above all: losing it loses levels, items and gems)
const KEEP = /^ht-(pid|name|loadout|touch-layout|autofire|lang|tut-later|quality|sens|bgm|sfx|mute|rules|qm.*|phrase)$/;
let prefs = null;

// before the game starts: put back anything the web view lost, then mirror every write to native storage
export async function restoreNative() {
  if (!NATIVE) return;
  try {
    ({ Preferences: prefs } = await import('@capacitor/preferences'));
    const { keys } = await prefs.keys();
    for (const k of keys) {
      if (!KEEP.test(k)) continue;
      if (localStorage.getItem(k) === null) { const { value } = await prefs.get({ key: k }); if (value !== null) localStorage.setItem(k, value); }
    }
    const set = Storage.prototype.setItem, del = Storage.prototype.removeItem;
    Storage.prototype.setItem = function (k, v) { set.call(this, k, v); if (this === localStorage && KEEP.test(k)) prefs.set({ key: k, value: String(v) }).catch(() => {}); };
    Storage.prototype.removeItem = function (k) { del.call(this, k); if (this === localStorage && KEEP.test(k)) prefs.remove({ key: k }).catch(() => {}); };
    // first run of the app: copy what this web view already has
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (KEEP.test(k)) prefs.set({ key: k, value: localStorage.getItem(k) }).catch(() => {}); }
  } catch (e) { console.warn('native storage', e?.message); }
}

// wipe the backup too (data deletion)
export async function clearNative() { if (prefs) await prefs.clear().catch(() => {}); }

let haptics = null;
if (NATIVE) import('@capacitor/haptics').then((m) => { haptics = m; }).catch(() => {});
// short vibration: 'light' (you hit someone), 'medium' (a kill), 'heavy' (you were destroyed)
export function haptic(kind = 'light') {
  if (!haptics) return;
  const style = { light: haptics.ImpactStyle.Light, medium: haptics.ImpactStyle.Medium, heavy: haptics.ImpactStyle.Heavy }[kind] || haptics.ImpactStyle.Light;
  haptics.Haptics.impact({ style }).catch(() => {});
}

// links that leave the game: the system browser in the app, a new tab on the web
export async function openExternal(url) {
  const abs = new URL(url, NATIVE ? SERVER + '/' : location.href).href;
  if (!NATIVE) { window.open(abs, '_blank', 'noopener'); return; }
  try { const { Browser } = await import('@capacitor/browser'); await Browser.open({ url: abs }); } catch { location.href = abs; }
}

// Android back button: close what is open, otherwise hand the decision to the game (onBack returns true if handled)
export async function onBackButton(onBack) {
  if (PLATFORM !== 'android') return;
  try {
    const { App } = await import('@capacitor/app');
    App.addListener('backButton', () => { if (!onBack()) App.minimizeApp(); });
  } catch { /* ignore */ }
}
