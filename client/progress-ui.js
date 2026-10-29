// Lobby profile bar, garage, missions, transfer screen and the XP part of the result screen.
import {
  SLOTS, ITEMS, item, DAILY, ACHIEVEMENTS, REWARD_LEVELS, rewardsAt, rewardSize, DEFAULT_LOOK, DAILY_ALL_BONUS, MAX_LEVEL,
} from '../shared/progress.js';
import { PLAYER_COLORS } from '../shared/arena.js';
import { emblemSvg } from './looks.js';
import { t as tr, tLine, lang, onLang } from './i18n.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const css = (c) => `rgb(${c.map((v) => Math.round(Math.min(1, v) * 255)).join(',')})`;
const slotName = (k) => tr(SLOTS.find((s) => s.k === k)?.name || k);
const nm = (it) => tr(it.name);
const achOf = (id) => ACHIEVEMENTS.find((a) => a.id === id);
export const titleName = (id) => (id && id !== 'none' ? tr(item('title', id)?.name || '') : '');

export function unlockText(it) {
  if (it.unlock.lv) return tr('Lv.{n}で解放', { n: it.unlock.lv });
  if (it.unlock.ach) { const a = achOf(it.unlock.ach); return tr('「{t}」（{x}）で解放', { t: tr(a.title), x: tr(a.text) }); }
  return '';
}

function swatch(it) {
  if (it.slot === 'paint') return it.color ? `<i class="sw" style="background:${css(it.color)}"></i>` : `<i class="sw" style="background:conic-gradient(${PLAYER_COLORS.slice(0, 4).map(css).join(',')})"></i>`;
  if (['glow', 'trail', 'spark'].includes(it.slot)) return it.rainbow ? '<i class="sw" style="background:linear-gradient(90deg,#f55,#fd4,#5f7,#4cf,#b6f)"></i>' : `<i class="sw glow" style="background:${css(it.color)}"></i>`;
  if (it.slot === 'emblem') return it.id === 'none' ? '<i class="sw none"></i>' : emblemSvg(it.id, 18);
  if (it.slot === 'frame') return `<i class="sw frame-${it.id}"></i>`;
  return '';
}

export function setupProgressUi({ profile, onPreview, onSaved, inRoom }) {
  let view = null, draft = null, tab = 'paint', mtab = 'daily';
  // panels opened from the lobby replace it while they are open
  const open = (id) => { if (!inRoom()) $('lobby').classList.add('hidden'); $(id).classList.remove('hidden'); };
  const close = (id) => { $(id).classList.add('hidden'); if (!inRoom() && ['garage', 'missions', 'transfer'].every((k) => $(k).classList.contains('hidden'))) $('lobby').classList.remove('hidden'); };

  // ---------------------------------------------------------------- profile bar
  function paintBar() {
    if (!view) return;
    $('prof-bar').classList.remove('hidden');
    $('pb-lv').textContent = `Lv.${view.level}`;
    $('pb-title').innerHTML = `${emblemSvg(view.look.emblem, 15)}${esc(titleName(view.look.title))}`;
    $('pb-xp').textContent = view.level >= MAX_LEVEL ? tr('{n} XP（最大レベル）', { n: view.xp }) : `${view.into} / ${view.need} XP`;
    $('pb-fill').style.width = `${view.level >= MAX_LEVEL ? 100 : (view.into / view.need) * 100}%`;
    const d = view.daily;
    $('pb-badge').textContent = ` ${d.done.length}/${d.ids.length}`;
  }
  profile.onChange((v) => { view = v; paintBar(); if (!$('garage').classList.contains('hidden')) paintGarage(); if (!$('missions').classList.contains('hidden')) paintMissions(); });

  // ---------------------------------------------------------------- garage
  const paintTabs = () => {
    $('g-tabs').innerHTML = SLOTS.map((s) => `<button type="button" data-k="${s.k}">${tr(s.name)}</button>`).join('');
    $('g-tabs').querySelectorAll('button').forEach((b) => { b.onclick = () => { tab = b.dataset.k; paintGarage(); }; });
  };
  paintTabs();
  onLang(() => { paintTabs(); paintBar(); if (!$('garage').classList.contains('hidden')) paintGarage(); if (!$('missions').classList.contains('hidden')) paintMissions(); });
  function paintGarage() {
    if (!view) return;
    const own = new Set(view.owned);
    $('g-tabs').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.k === tab)));
    const list = ITEMS.filter((i) => i.slot === tab);
    $('g-items').innerHTML = list.map((it) => {
      const has = own.has(it.key), on = draft[tab] === it.id;
      return `<button type="button" class="it ${has ? '' : 'locked'}" data-id="${it.id}" aria-pressed="${on}">${swatch(it)}<span>${esc(nm(it))}</span>${has ? '' : `<small>🔒 ${esc(unlockText(it))}</small>`}</button>`;
    }).join('');
    $('g-items').querySelectorAll('button').forEach((b) => {
      b.onclick = () => {
        const it = item(tab, b.dataset.id);
        if (!own.has(it.key)) { $('g-hint').textContent = `${nm(it)}：${unlockText(it)}`; return; }
        draft = { ...draft, [tab]: it.id };
        $('g-hint').textContent = '';
        paintGarage();
        onPreview(draft);
      };
    });
    const changed = JSON.stringify(draft) !== JSON.stringify(view.look);
    $('btn-g-save').disabled = !changed;
    $('btn-g-save').textContent = tr(changed ? '決定' : '保存済み');
    $('g-count').textContent = tr('解放済み {a} / {b}', { a: view.owned.length, b: ITEMS.length });
  }
  function openGarage() {
    if (!view) return;
    draft = { ...DEFAULT_LOOK, ...view.look };
    $('g-hint').textContent = inRoom() ? tr('自分の戦車がプレビューされます（決定すると他のプレイヤーにも反映）') : '';
    open('garage');
    paintGarage();
    onPreview(draft);
  }
  function closeGarage() { close('garage'); onPreview(null); }
  $('btn-garage').onclick = openGarage;
  $('btn-garage2').onclick = () => { $('settings').classList.add('hidden'); openGarage(); };
  $('btn-g-close').onclick = closeGarage;
  $('btn-g-save').onclick = async () => {
    $('btn-g-save').disabled = true;
    try { await profile.saveLook(draft); draft = { ...view.look }; onSaved(view.look); paintGarage(); $('g-hint').textContent = tr('保存しました'); }
    catch (e) { $('g-hint').textContent = tr('保存できませんでした（{m}）', { m: e.message }); $('btn-g-save').disabled = false; }
  };

  // ---------------------------------------------------------------- missions
  $('m-tabs').querySelectorAll('button').forEach((b) => { b.onclick = () => { mtab = b.dataset.t; paintMissions(); }; });
  function bar(p, t) { return `<div class="mbar"><i style="width:${Math.min(100, (p / t) * 100)}%"></i></div>`; }
  function paintMissions() {
    if (!view) return;
    $('m-tabs').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.t === mtab)));
    let html = '';
    if (mtab === 'daily') {
      const d = view.daily, left = Math.max(0, d.resetAt - Date.now());
      html += `<p class="note">${tr('毎日0時（日本時間）に更新・あと{h}時間{m}分 ／ 1日1回だけミッションを入れ替えられます', { h: Math.floor(left / 3600e3), m: Math.floor((left % 3600e3) / 60e3) })}</p>`;
      html += d.ids.map((id, i) => {
        const m = DAILY.find((x) => x.id === id), p = d.prog[id] || 0, done = d.done.includes(id);
        return `<div class="mrow ${done ? 'done' : ''}"><div class="mt"><b>${tr(['かんたん', 'ふつう', 'むずかしい'][m.tier])}</b> ${esc(tr(m.text))}</div>${bar(done ? m.target : p, m.target)}
          <div class="mm"><span>${done ? tr('達成！') : `${p} / ${m.target}`}</span><span>+${m.xp} XP</span>${!done && !d.rerolled ? `<button type="button" class="mini" data-re="${i}">${tr('入れ替え')}</button>` : ''}</div></div>`;
      }).join('');
      html += `<div class="mrow ${d.bonus ? 'done' : ''}"><div class="mt">${tr('3つ全部達成でボーナス')}</div><div class="mm"><span>${d.bonus ? tr('達成！') : `${d.done.length} / 3`}</span><span>+${DAILY_ALL_BONUS} XP</span></div></div>`;
    } else if (mtab === 'ach') {
      const doneN = view.ach.filter((a) => a.done).length;
      html += `<p class="note">${tr('達成すると称号（ガレージの「称号」で付けられます）と経験値がもらえます。達成 {a} / {b}', { a: doneN, b: ACHIEVEMENTS.length })}</p>`;
      html += ACHIEVEMENTS.map((a) => {
        const st = view.ach.find((x) => x.id === a.id) || { prog: 0, done: false };
        const extra = ITEMS.filter((i) => i.unlock.ach === a.id && i.slot !== 'title').map((i) => (lang === 'en' ? `${nm(i)} (${slotName(i.slot)})` : `${nm(i)}（${slotName(i.slot)}）`));
        return `<div class="mrow ${st.done ? 'done' : ''}"><div class="mt"><b>${tr('称号「{t}」', { t: esc(tr(a.title)) })}</b> ${esc(tr(a.text))}</div>${bar(st.prog, a.target)}
          <div class="mm"><span>${st.done ? tr('達成！') : `${st.prog} / ${a.target}`}</span><span>+${a.xp} XP${extra.length ? `${lang === 'en' ? ' · ' : '・'}${esc(extra.join(lang === 'en' ? ', ' : '、'))}` : ''}</span></div></div>`;
      }).join('');
    } else {
      html += `<p class="note">${tr('5レベルごとに小さな報酬、10レベルごとに大きな報酬。強さは変わりません（見た目だけ）。')}</p>`;
      html += REWARD_LEVELS.map((lv) => {
        const got = view.level >= lv, items = rewardsAt(lv);
        return `<div class="mrow lvrow ${got ? 'done' : ''}"><div class="mt"><b>Lv.${lv}</b> <em class="${rewardSize(lv)}">${tr(rewardSize(lv) === 'big' ? '大報酬' : '小報酬')}</em> ${got ? '✓' : ''}</div>
          <div class="lvitems">${items.map((i) => `<span>${swatch(i)}${esc(nm(i))}<small>${slotName(i.slot)}</small></span>`).join('')}</div></div>`;
      }).join('');
    }
    $('m-body').innerHTML = html;
    $('m-body').querySelectorAll('[data-re]').forEach((b) => { b.onclick = async () => { b.disabled = true; try { await profile.reroll(Number(b.dataset.re)); } catch { b.disabled = false; } }; });
  }
  $('btn-missions').onclick = () => { open('missions'); paintMissions(); };
  $('btn-m-close').onclick = () => close('missions');

  // ---------------------------------------------------------------- transfer
  let armed = 0;
  $('btn-transfer').onclick = () => { open('transfer'); $('tr-code').textContent = ''; $('tr-msg').textContent = ''; };
  $('btn-tr-close').onclick = () => close('transfer');
  $('btn-tr-issue').onclick = async () => {
    try {
      const { code, expiresAt } = await profile.transferCode();
      $('tr-code').innerHTML = `<b class="code">${esc(code)}</b><br><small>${tr('{d} まで有効・1回だけ使えます。この画面を他の人に見せないでください。', { d: new Date(expiresAt).toLocaleString(lang === 'en' ? 'en-US' : 'ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) })}</small>`;
    } catch (e) { $('tr-code').textContent = tr('発行できませんでした（{m}）', { m: e.message }); }
  };
  $('btn-tr-redeem').onclick = async () => {
    const code = $('tr-input').value.trim();
    if (!code) return;
    if (performance.now() - armed > 4000) { armed = performance.now(); $('tr-msg').textContent = tr('この端末の今のデータは、入力したコードのデータに置き換わります。もう一度押すと引き継ぎます。'); return; }
    armed = 0;
    try { await profile.redeem(code); $('tr-msg').textContent = tr('引き継ぎました（Lv.{n}）', { n: view.level }); onSaved(view.look); }
    catch (e) { $('tr-msg').textContent = tr(e.status === 429 ? '試行回数が多すぎます。しばらく待ってからやり直してください。' : 'コードが違うか、期限が切れています。'); }
  };

  // ---------------------------------------------------------------- after a match
  function showMatchProgress(res) {
    const el = $('result-xp');
    if (!res || res.duplicate) return;
    if (!res.lines?.length) { el.innerHTML = `<p class="note">${tr('この試合は経験値の対象外でした（ほとんど動いていないため）')}</p>`; return; }
    const a = res.after, lvUp = a.level > res.before.level;
    const pct = a.level >= MAX_LEVEL ? 100 : (a.into / a.need) * 100;
    const unlocked = (res.unlocked || []).map((k) => item(...k.split(':'))).filter(Boolean);
    el.innerHTML = `
      <div class="xp-total">+${res.gained} XP ${lvUp ? `<b class="lvup">${tr('レベルアップ！ Lv.{a} → {b}', { a: res.before.level, b: a.level })}</b>` : `<span>Lv.${a.level}</span>`}</div>
      <div class="xpbar"><i style="width:${pct}%"></i></div>
      <ul class="xp-lines">${res.lines.map(([t, n]) => `<li><span>${esc(tLine(t))}</span><b>+${n}</b></li>`).join('')}</ul>
      ${unlocked.length ? `<div class="unlocked"><b>${tr('新しく解放：')}</b>${unlocked.map((i) => `<span>${swatch(i)}${esc(nm(i))}<small>${slotName(i.slot)}</small></span>`).join('')}<br><small>${tr('ロビーまたは⚙のガレージで装備できます')}</small></div>` : ''}`;
  }
  function clearMatchProgress() { $('result-xp').innerHTML = ''; }

  return { showMatchProgress, clearMatchProgress, openGarage, closeGarage, get look() { return view?.look; } };
}
