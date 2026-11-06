// "アカウント連携" in the transfer panel: link this profile to Google / Apple, sign in on a new
// device, switch when the account already has other data, unlink.
import { NATIVE } from './platform.js';
import { providers, renderGoogleButton, webAppleToken, nativeToken } from './auth.js';
import { onLang, lang as curLang } from './i18n.js';

const $ = (id) => document.getElementById(id);
const NAME = { google: 'Google', apple: 'Apple' };

export async function setupAccountUi({ profile, tr, lang }) {
  const can = await providers().catch(() => []);
  if (!can.length) return;   // not configured yet (or this device has no way to sign in)
  $('acct-sec').classList.remove('hidden');
  const msg = (t) => { $('acct-msg').textContent = t; };
  let pending = null;

  const paint = () => {
    const links = profile.view?.links || [];
    $('acct-status').innerHTML = links.length
      ? `${tr('連携中：')}${links.map((p) => `<b>${NAME[p]}</b> <button type="button" class="link-btn" data-unlink="${p}">${tr('解除')}</button>`).join(' · ')}`
      : tr('まだ連携していません。連携すると、機種変更してもサインインするだけで同じデータで遊べます。');
    for (const p of ['google', 'apple']) {
      const show = can.includes(p) && !links.includes(p);
      if (p === 'google' && !NATIVE) $('g-btn').classList.toggle('hidden', !show);
      else $(`btn-${p}`).classList.toggle('hidden', !show);
    }
  };
  profile.onChange(paint);

  // after a sign-in that switched profiles, start over with that profile's look, levels, gems
  const result = (r, p) => {
    if (r.status === 'linked') { msg(tr('{p}アカウントと連携しました。', { p: NAME[p] })); return; }
    if (r.status === 'signedin') { msg(tr('サインインしました（Lv.{n}）。読み込み直します…', { n: r.level })); setTimeout(() => location.reload(), 900); return; }
    if (r.status === 'conflict') {
      pending = r.ticket; msg('');
      $('acct-conflict-msg').textContent = tr('この{p}アカウントには別のデータ（Lv.{a}・ジェム{g}）があります。切り替えると、この端末のいまのデータ（Lv.{b}・ジェム{h}）には戻れなくなります。残したいときは、先に引き継ぎコードを発行してメモしてください。',
        { p: NAME[p], a: r.other.level, g: r.other.gems, b: r.current.level, h: r.current.gems });
      $('acct-conflict').classList.remove('hidden');
    }
  };
  const fail = (e) => {
    if (e?.cancelled) { msg(''); return; }
    const m = { other_account: '同じ種類の別のアカウントがすでに連携されています。先に解除してください。', taken: 'このアカウントは別のデータに連携されています。', expired: '時間がたちすぎました。もう一度お試しください。' }[e?.message];
    msg(m ? tr(m) : tr('サインインできませんでした（{m}）', { m: e?.message || '?' }));
  };
  const go = async (p, getToken) => {
    msg(tr('サインイン中…'));
    try { if (!profile.token) await profile.load(); result(await profile.signIn(p, await getToken()), p); } catch (e) { fail(e); }
  };

  // Google: native button in the app; Google's own button on the web
  if (can.includes('google')) {
    if (NATIVE) { $('btn-google').onclick = () => go('google', () => nativeToken('google')); }
    else {
      const draw = (l) => renderGoogleButton($('g-btn'), (tok) => go('google', async () => tok), { locale: l === 'en' ? 'en' : 'ja' }).catch(() => $('g-btn').classList.add('hidden'));
      await draw(lang);
      onLang(() => draw(curLang));   // Google's button text follows the game language
    }
  }
  if (can.includes('apple')) $('btn-apple').onclick = () => go('apple', () => (NATIVE ? nativeToken('apple') : webAppleToken()));

  $('btn-acct-switch').onclick = async () => {
    if (!pending) return;
    try { result(await profile.switchTo(pending), 'google'); } catch (e) { fail(e); }
    pending = null; $('acct-conflict').classList.add('hidden');
  };
  $('btn-acct-keep').onclick = () => { pending = null; $('acct-conflict').classList.add('hidden'); msg(tr('連携しませんでした。')); };
  $('acct-status').addEventListener('click', async (ev) => {
    const p = ev.target?.dataset?.unlink;
    if (!p) return;
    const b = ev.target;
    if (b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = tr('本当に解除する'); setTimeout(() => { b.dataset.armed = ''; b.textContent = tr('解除'); }, 4000); return; }
    try { await profile.unlink(p); msg(tr('{p}アカウントの連携を解除しました。', { p: NAME[p] })); } catch (e) { fail(e); }
  });
  onLang(paint);
  paint();
}
