// In-app purchases (Android / iOS apps). Players buy gems (an in-game currency) with real money
// through the App Store / Google Play, then spend gems on cosmetics in the shop (later also on
// gacha draws). Nothing sold changes how strong a tank is.
//
// Paid gems (bought) and free gems (given by the game, e.g. events) are counted apart: Japanese law
// on prepaid payment instruments (資金決済法) looks at the unused balance of *paid* currency, and
// store rules forbid purchased currency from expiring. When spending, free gems go first.

export const GEM = { id: 'gem', name: 'ジェム', icon: '💎' };
export const SPEND_ORDER = ['free', 'paid'];

// Store products: consumable, same product ID on App Store Connect and Google Play.
// Prices are set in each store (the app always shows the store's own price string).
// gems = what one purchase gives. Changing the amount of an existing product needs a new product ID.
export const GEM_PACKS = [
  { id: 'com.lildayne.hovertank.gem_pack_1', gems: 100 },
  { id: 'com.lildayne.hovertank.gem_pack_2', gems: 550 },
  { id: 'com.lildayne.hovertank.gem_pack_3', gems: 1200 },
  { id: 'com.lildayne.hovertank.gem_pack_4', gems: 2600 },
];
export const gemPack = (id) => GEM_PACKS.find((p) => p.id === id);

// Items sold for gems. Each key must be an item in shared/progress.js whose unlock is { shop: true }
// (shop items are never unlocked by levels or missions and never worn by CPU tanks).
//   e.g. { key: 'paint:neon', price: 300 }
export const SHOP_ITEMS = [];
export const shopItem = (key) => SHOP_ITEMS.find((s) => s.key === key);

// the shop (and gem purchases) stay hidden until there is something to sell
export const SHOP_OPEN = SHOP_ITEMS.length > 0;

// The UUID that ties a store purchase to a profile (StoreKit appAccountToken / Play obfuscatedAccountId),
// derived from the profile key so the server can check that a purchase belongs to the player sending it.
export async function accountToken(profileKey) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`ht-acct:${profileKey}`))).slice(0, 16);
  h[6] = (h[6] & 0x0f) | 0x50; h[8] = (h[8] & 0x3f) | 0x80;   // UUID version 5 layout, RFC 4122 variant
  const x = [...h].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

// spend `price` gems from a wallet { paid, free }: returns the new wallet and what was taken, or null
export function spend(wallet, price) {
  const w = { paid: wallet.paid || 0, free: wallet.free || 0 };
  if (w.paid + w.free < price) return null;
  const took = { paid: 0, free: 0 };
  let left = price;
  for (const k of SPEND_ORDER) { const n = Math.min(left, w[k]); w[k] -= n; took[k] += n; left -= n; }
  return { wallet: w, took };
}
