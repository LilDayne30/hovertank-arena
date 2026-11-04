// In-app purchases in the Android / iOS app (@capgo/native-purchases: StoreKit 2 / Play Billing).
// Flow for one gem pack:
//   1. the store sells it (the purchase is tied to this profile with appAccountToken)
//   2. our server checks it with Apple / Google and adds the gems (worker/iap.js) — only then
//   3. the purchase is finished (iOS) / consumed (Android), so it can be bought again.
// If the app closes or the network fails between 1 and 3, the purchase stays unfinished; on the next
// start recoverPurchases() sends it to the server again (gems are never given twice: the server
// keeps every purchase it has already used).
import { NATIVE, PLATFORM } from './platform.js';
import { GEM_PACKS, gemPack, accountToken } from '../shared/shop.js';

let NP = null, TYPE = null;
async function plugin() {
  if (!NATIVE) return null;
  if (!NP) { const m = await import('@capgo/native-purchases'); NP = m.NativePurchases; TYPE = m.PURCHASE_TYPE; }
  return NP;
}
// same derivation as the server (worker/profile.js profileKey + shared/shop.js accountToken)
async function acctFor(token) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`ht-profile:${token}`));
  return accountToken([...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join(''));
}

export const storeAvailable = async () => { try { const p = await plugin(); return !!p && (await p.isBillingSupported()).isBillingSupported; } catch { return false; } };

// gem packs with the store's own names and prices (Apple requires showing these, never our own)
export async function gemProducts() {
  const p = await plugin();
  if (!p) return [];
  const { products } = await p.getProducts({ productIdentifiers: GEM_PACKS.map((g) => g.id), productType: TYPE.INAPP });
  return GEM_PACKS.map((g) => ({ ...g, product: products.find((x) => x.identifier === g.id) })).filter((g) => g.product);
}

// tell the server about one store transaction; true when it is settled (gems given now or earlier)
async function settle(profile, t) {
  const body = PLATFORM === 'ios'
    ? { platform: 'ios', productId: t.productIdentifier, transactionId: t.transactionId }
    : { platform: 'android', productId: t.productIdentifier, purchaseToken: t.purchaseToken };
  try {
    const res = await profile.call('/iap', body);
    profile.applyProgress(res);
    return { ok: true, credited: res.credited || 0 };
  } catch (e) {
    // already used by this profile = settled; anything else (network, store not reachable) = try again later
    if (e.status === 409) return { ok: true, credited: 0 };
    return { ok: false, error: e.message };
  }
}
async function finish(t) {
  if (PLATFORM === 'ios') await NP.finishTransaction({ transactionId: t.transactionId });
  else await NP.consumePurchase({ purchaseToken: t.purchaseToken });
}

// buy one gem pack. Returns { credited } or throws (cancelled by the player: error.cancelled = true)
export async function buyGems(profile, packId) {
  const p = await plugin();
  if (!p || !gemPack(packId)) throw new Error('unavailable');
  if (!profile.token) await profile.load();
  let t;
  try {
    t = await p.purchaseProduct({ productIdentifier: packId, productType: TYPE.INAPP, quantity: 1, appAccountToken: await acctFor(profile.token), autoAcknowledgePurchases: false });
  } catch (e) { const err = new Error(e?.message || 'cancelled'); err.cancelled = /cancel/i.test(String(e?.message || e?.code || '')); throw err; }
  if (PLATFORM === 'android' && t.purchaseState && !['PURCHASED', '1'].includes(String(t.purchaseState))) throw Object.assign(new Error('pending'), { pending: true });
  const r = await settle(profile, t);
  if (!r.ok) throw Object.assign(new Error(r.error || 'verify'), { retryLater: true });
  await finish(t).catch(() => {});   // if this fails, recoverPurchases() finishes it next time (no double gems)
  return r;
}

// on start: settle purchases that were paid for but not finished
export async function recoverPurchases(profile) {
  const p = await plugin();
  if (!p) return 0;
  let n = 0;
  try {
    // iOS: transactions StoreKit still holds unfinished; Android: purchases not consumed yet
    const { purchases, transactions } = PLATFORM === 'ios' ? await p.getUnfinishedTransactions() : await p.getPurchases({ productType: TYPE.INAPP });
    for (const t of purchases || transactions || []) {
      if (!gemPack(t.productIdentifier)) continue;
      if (PLATFORM === 'android' && !['PURCHASED', '1'].includes(String(t.purchaseState))) continue;
      const r = await settle(profile, t);
      if (r.ok) { await finish(t).catch(() => {}); n += r.credited ? 1 : 0; }
    }
  } catch (e) { console.warn('recover purchases', e?.message); }
  return n;
}
