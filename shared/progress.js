// Progression shared by the server (authoritative: XP, unlocks, missions) and the client (UI).
// Nothing here changes how strong a tank is: every unlock is cosmetic.

// ------------------------------------------------------------------ levels
export const MAX_LEVEL = 50;
// XP needed to go from level L to L+1: grows with the level (quadratic), rounded to 10
export const xpToNext = (L) => (L >= MAX_LEVEL ? 0 : Math.round((150 + 25 * (L - 1) + 1.2 * (L - 1) ** 2) / 10) * 10);
const CUM = [0, 0];                       // CUM[L] = total XP at which level L is reached
for (let L = 1; L < MAX_LEVEL; L++) CUM[L + 1] = CUM[L] + xpToNext(L);
export const XP_FOR_MAX = CUM[MAX_LEVEL];
export function levelOf(xp) {
  let L = 1;
  while (L < MAX_LEVEL && xp >= CUM[L + 1]) L++;
  return { level: L, into: xp - CUM[L], need: xpToNext(L), total: xp, start: CUM[L] };
}
export const totalForLevel = (L) => CUM[Math.max(1, Math.min(MAX_LEVEL, L))];

// ------------------------------------------------------------------ cosmetic slots & items
// unlock: { lv: n } from a level reward, { ach: id } from a long-term mission, or {} = from the start
export const SLOTS = [
  { k: 'paint', name: '塗装' }, { k: 'pattern', name: '柄' }, { k: 'turret', name: '砲塔' },
  { k: 'rear', name: 'リアパーツ' }, { k: 'side', name: 'サイド／フロント' }, { k: 'glow', name: 'ホバーの光' },
  { k: 'trail', name: '弾の軌跡' }, { k: 'spark', name: 'ドリフト火花' }, { k: 'boom', name: '撃破演出' },
  { k: 'emblem', name: 'エンブレム' }, { k: 'frame', name: '名札の枠' }, { k: 'title', name: '称号' },
];
const I = (slot, id, name, unlock = {}, extra = {}) => ({ slot, id, key: `${slot}:${id}`, name, unlock, ...extra });
export const ITEMS = [
  // paint: "auto" = the seat colour (red / blue / yellow / green, or orange / cyan for 2nd team members)
  I('paint', 'auto', '席の色（自動）', {}, { color: null }),
  I('paint', 'red', 'レッド', {}, { color: [0.85, 0.22, 0.18] }),
  I('paint', 'blue', 'ブルー', {}, { color: [0.2, 0.45, 0.9] }),
  I('paint', 'yellow', 'イエロー', {}, { color: [0.95, 0.75, 0.15] }),
  I('paint', 'green', 'グリーン', {}, { color: [0.25, 0.75, 0.35] }),
  I('paint', 'orange', 'オレンジ', {}, { color: [0.95, 0.5, 0.12] }),
  I('paint', 'cyan', 'シアン', {}, { color: [0.2, 0.78, 0.92] }),
  I('paint', 'sand', 'サンド', { lv: 5 }, { color: [0.82, 0.68, 0.45] }),
  I('paint', 'olive', 'オリーブ', { lv: 15 }, { color: [0.42, 0.45, 0.2] }),
  I('paint', 'navy', 'ネイビー', { lv: 25 }, { color: [0.14, 0.2, 0.42] }),
  I('paint', 'pearl', 'パールホワイト', { lv: 40 }, { color: [0.93, 0.92, 0.88] }),
  I('paint', 'matte', 'マットブラック', { lv: 45 }, { color: [0.13, 0.13, 0.14] }),
  I('paint', 'gold', 'ゴールド', { lv: 50 }, { color: [0.95, 0.72, 0.22] }),
  I('paint', 'crimson', 'クリムゾン', { ach: 'wins100' }, { color: [0.55, 0.05, 0.12] }),
  I('paint', 'sakura', 'サクラ', { ach: 'daily30' }, { color: [0.98, 0.62, 0.72] }),

  I('pattern', 'none', 'なし'),
  I('pattern', 'stripe', 'レーシングストライプ', { lv: 5 }),
  I('pattern', 'desert', '砂漠迷彩', { lv: 15 }),
  I('pattern', 'tiger', 'タイガー', { lv: 25 }),
  I('pattern', 'digital', 'デジタル迷彩', { lv: 35 }),
  I('pattern', 'flame', 'ファイヤー', { lv: 45 }),
  I('pattern', 'carbon', 'カーボン', { lv: 50 }),
  I('pattern', 'checker', 'チェッカー', { ach: 'flawless' }),
  I('pattern', 'hazard', 'ハザード', { ach: 'dmg30k' }),

  I('turret', 'std', '標準砲塔'),
  I('turret', 'twin', 'ツインバレル', { lv: 10 }),
  I('turret', 'long', 'ロングバレル', { lv: 20 }),
  I('turret', 'heavy', 'ヘビーキャノン', { lv: 30 }),
  I('turret', 'rail', 'レールガン', { lv: 40 }),
  I('turret', 'king', 'キングス砲塔', { lv: 50 }),
  I('turret', 'dome', 'ドーム砲塔', { ach: 'kills1000' }),
  I('turret', 'missile', 'ミサイルポッド', { ach: 'air30' }),

  I('rear', 'none', 'なし'),
  I('rear', 'spoiler', 'リアスポイラー', { lv: 10 }),
  I('rear', 'fins', 'ツインフィン', { lv: 30 }),
  I('rear', 'jet', 'ジェットウイング', { lv: 50 }),
  I('rear', 'antenna', 'フラッグアンテナ', { ach: 'wins10' }),
  I('rear', 'exhaust', 'ツインマフラー', { ach: 'orange300' }),

  I('side', 'none', 'なし'),
  I('side', 'skirt', 'サイドスカート', { lv: 20 }),
  I('side', 'blade', 'フロントブレード', { lv: 40 }),
  I('side', 'pods', 'サイドポッド', { ach: 'kills100' }),
  I('side', 'canard', 'カナード', { ach: 'play50' }),

  I('glow', 'cyan', 'シアン（標準）', {}, { color: [0.3, 0.8, 1] }),
  I('glow', 'magenta', 'マゼンタ', { lv: 15 }, { color: [1, 0.25, 0.85] }),
  I('glow', 'gold', 'ゴールド', { lv: 45 }, { color: [1, 0.75, 0.2] }),
  I('glow', 'emerald', 'エメラルド', { ach: 'heal50' }, { color: [0.2, 1, 0.5] }),
  I('glow', 'red', 'レッド', { ach: 'turbokill50' }, { color: [1, 0.2, 0.15] }),

  I('trail', 'std', '標準（黄）', {}, { color: [1, 0.82, 0.25] }),
  I('trail', 'ice', 'アイス', { lv: 5 }, { color: [0.55, 0.9, 1] }),
  I('trail', 'neon', 'ネオングリーン', { lv: 35 }, { color: [0.45, 1, 0.3] }),
  I('trail', 'violet', 'バイオレット', { ach: 'long50' }, { color: [0.75, 0.4, 1] }),
  I('trail', 'rose', 'ローズ', { ach: 'multi5' }, { color: [1, 0.4, 0.6] }),

  I('spark', 'std', '標準（白）', {}, { color: [1, 1, 0.92] }),
  I('spark', 'gold', 'ゴールド', { lv: 25 }, { color: [1, 0.8, 0.3] }),
  I('spark', 'pink', 'ピンク', { lv: 35 }, { color: [1, 0.45, 0.75] }),
  I('spark', 'rainbow', 'レインボー', { ach: 'turbo300' }, { rainbow: true }),

  I('boom', 'std', '爆炎（標準）'),
  I('boom', 'plasma', 'プラズマ', { lv: 20 }),
  I('boom', 'firework', '花火', { lv: 40 }),
  I('boom', 'confetti', '紙吹雪', { lv: 50 }),
  I('boom', 'blackflame', '黒炎', { ach: 'multi10' }),

  I('emblem', 'none', 'なし'),
  I('emblem', 'star', 'スター', { lv: 10 }),
  I('emblem', 'bolt', 'イナズマ', { lv: 20 }),
  I('emblem', 'skull', 'ドクロ', { lv: 30 }),
  I('emblem', 'wing', 'ウイング', { lv: 40 }),
  I('emblem', 'crown', 'クラウン', { lv: 50 }),
  I('emblem', 'heart', 'ハート', { ach: 'play1' }),
  I('emblem', 'sight', '照準', { ach: 'hill30' }),
  I('emblem', 'clover', 'クローバー', { ach: 'play300' }),

  I('frame', 'none', 'なし'),
  I('frame', 'bronze', 'ブロンズ', { lv: 10 }),
  I('frame', 'silver', 'シルバー', { lv: 30 }),
  I('frame', 'gold', 'ゴールド', { lv: 50 }),
  I('frame', 'platinum', 'プラチナ', { ach: 'daily150' }),

  I('title', 'none', 'なし'),
  I('title', 'lv20', '一人前', { lv: 20 }),
  I('title', 'lv30', 'ベテラン', { lv: 30 }),
  I('title', 'lv40', 'エース', { lv: 40 }),
  I('title', 'lv50', 'ホバーマスター', { lv: 50 }),
  // the rest of the titles come from long-term missions (added below from ACHIEVEMENTS)
];
export const DEFAULT_LOOK = Object.fromEntries(SLOTS.map((s) => [s.k, ITEMS.find((i) => i.slot === s.k).id]));

// ------------------------------------------------------------------ per-match stats
// keys counted by the server for each player during one match
export const STAT_KEYS = ['matches', 'kills', 'deaths', 'wins', 'hits', 'dmg', 'turbo', 'orange', 'heals', 'jumps', 'air', 'turboKills', 'longKills', 'hillKills', 'clean', 'flawless', 'best'];
// "best" = kills in that one match (missions/achievements use its maximum);
// "clean" = finished with >= 3 kills and <= 1 death; "flawless" = won with >= 3 kills and 0 deaths

// ------------------------------------------------------------------ daily missions
// 3 per day (one per tier), chosen per player; reset at 0:00 Japan time. One reroll per day.
// mode 'sum' adds up over the day's matches, 'max' needs it in a single match.
const M = (tier, id, text, key, target, mode = 'sum') => ({ tier, id, text, key, target, mode, xp: [150, 250, 400][tier] });
export const DAILY = [
  M(0, 'play2', '試合を2回プレイする', 'matches', 2),
  M(0, 'kills3', '合計3機撃破する', 'kills', 3),
  M(0, 'turbo5', 'ドリフトターボを5回出す', 'turbo', 5),
  M(0, 'hits10', '砲弾を10発当てる', 'hits', 10),
  M(0, 'jumps15', 'ジャンプを15回する', 'jumps', 15),
  M(1, 'play4', '試合を4回プレイする', 'matches', 4),
  M(1, 'kills8', '合計8機撃破する', 'kills', 8),
  M(1, 'orange5', 'オレンジのターボを5回出す', 'orange', 5),
  M(1, 'heal2', '回復アイテムを2回取る', 'heals', 2),
  M(1, 'dmg700', '合計700ダメージを与える', 'dmg', 700),
  M(1, 'multi3', '1試合で3機撃破する', 'best', 3, 'max'),
  M(2, 'win1', '試合に1回勝つ', 'wins', 1),
  M(2, 'air1', 'ジャンプ中に撃った弾で1機撃破する', 'air', 1),
  M(2, 'turbokill2', 'ターボ中に撃った弾で2機撃破する', 'turboKills', 2),
  M(2, 'long2', '40m以上離れた敵を2機撃破する', 'longKills', 2),
  M(2, 'multi5', '1試合で5機撃破する', 'best', 5, 'max'),
  M(2, 'hill3', '丘の上から3機撃破する', 'hillKills', 3),
  M(2, 'clean1', '3キル以上・1デス以下で試合を終える', 'clean', 1),
];
export const DAILY_ALL_BONUS = 300;     // all three done
export const DAILY_COUNT = 3;
export const dayKey = (now = Date.now()) => new Date(now + 9 * 3600e3).toISOString().slice(0, 10);   // JST date
export const nextResetAt = (now = Date.now()) => { const d = new Date(now + 9 * 3600e3); d.setUTCHours(24, 0, 0, 0); return d.getTime() - 9 * 3600e3; };

// deterministic pick: one mission of each tier from a seed string
function hash32(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
export function pickDaily(seed, avoid = []) {
  return [0, 1, 2].map((tier) => {
    const pool = DAILY.filter((m) => m.tier === tier && !avoid.includes(m.id));
    return pool[hash32(`${seed}:${tier}`) % pool.length].id;
  });
}
export function rerollOne(seed, current, index) {
  const tier = DAILY.find((m) => m.id === current[index]).tier;
  const pool = DAILY.filter((m) => m.tier === tier && !current.includes(m.id));
  return pool.length ? pool[hash32(`${seed}:re`) % pool.length].id : current[index];
}

// ------------------------------------------------------------------ long-term missions (titles)
const A = (id, title, text, key, target, xp, mode = 'sum') => ({ id, title, text, key, target, xp, mode });
export const ACHIEVEMENTS = [
  A('play1', '新兵', '初めての試合を終える', 'matches', 1, 100),
  A('play50', '常連', '試合を50回プレイする', 'matches', 50, 1000),
  A('play300', '古参兵', '試合を300回プレイする', 'matches', 300, 3000),
  A('kills100', 'ハンター', '合計100機撃破する', 'kills', 100, 800),
  A('kills1000', '撃墜王', '合計1000機撃破する', 'kills', 1000, 4000),
  A('wins10', '勝利の味', '試合に10回勝つ', 'wins', 10, 600),
  A('wins100', '百戦錬磨', '試合に100回勝つ', 'wins', 100, 3000),
  A('turbo300', 'ドリフト職人', 'ドリフトターボを300回出す', 'turbo', 300, 1500),
  A('orange300', 'ドリフトの神', 'オレンジのターボを300回出す', 'orange', 300, 3000),
  A('heal50', '丘の王', '回復アイテムを50回取る', 'heals', 50, 1500),
  A('hill30', '高みの砲手', '丘の上から30機撃破する', 'hillKills', 30, 1200),
  A('air30', '空中戦士', 'ジャンプ中に撃った弾で30機撃破する', 'air', 30, 1500),
  A('turbokill50', '疾風', 'ターボ中に撃った弾で50機撃破する', 'turboKills', 50, 1500),
  A('long50', 'スナイパー', '40m以上離れた敵を50機撃破する', 'longKills', 50, 1500),
  A('multi5', '大暴れ', '1試合で5機撃破する', 'best', 5, 500, 'max'),
  A('multi10', '一騎当千', '1試合で10機撃破する', 'best', 10, 2000, 'max'),
  A('flawless', '無傷の勝者', '0デス・3キル以上で試合に勝つ', 'flawless', 1, 1000),
  A('dmg30k', '破壊神', '合計30000ダメージを与える', 'dmg', 30000, 3000),
  A('daily30', 'コツコツ', 'デイリーミッションを30個達成する', 'dailyDone', 30, 1500),
  A('daily150', '皆勤賞', 'デイリーミッションを150個達成する', 'dailyDone', 150, 4000),
];
for (const a of ACHIEVEMENTS) ITEMS.push(I('title', a.id, a.title, { ach: a.id }));
export const ITEM = new Map(ITEMS.map((i) => [i.key, i]));
export const item = (slot, id) => ITEM.get(`${slot}:${id}`);

// level rewards: every 5 levels a small one, every 10 a big one
export const REWARD_LEVELS = Array.from({ length: MAX_LEVEL / 5 }, (_, i) => (i + 1) * 5);
export const rewardsAt = (lv) => ITEMS.filter((i) => i.unlock.lv === lv);
export const rewardSize = (lv) => (lv % 10 === 0 ? 'big' : lv % 5 === 0 ? 'small' : null);

export function owned(level, achDone) {
  const set = new Set();
  for (const i of ITEMS) {
    const u = i.unlock;
    if ((u.lv === undefined && u.ach === undefined) || (u.lv !== undefined && level >= u.lv) || (u.ach !== undefined && achDone[u.ach])) set.add(i.key);
  }
  return set;
}
// keep only items the player owns; anything else falls back to the default
export function cleanLook(look, ownedSet) {
  const out = { ...DEFAULT_LOOK };
  if (look && typeof look === 'object') {
    for (const s of SLOTS) {
      const id = look[s.k];
      if (typeof id === 'string' && ITEM.has(`${s.k}:${id}`) && (!ownedSet || ownedSet.has(`${s.k}:${id}`))) out[s.k] = id;
    }
  }
  return out;
}

// ------------------------------------------------------------------ XP for one match
// base XP for taking part (so nobody ever gets stuck), plus a bit for playing well
export const XP = { perMinute: 20, kill: 15, hit: 2, win: 60, second: 25, draw: 20, turbo: 2, orange: 4, heal: 10, firstPlay: 100, firstWin: 150 };
export function matchXp(m, ctx) {
  // m: the player's match stats; ctx: { minutes, active, place, players, win, draw, firstPlay, firstWin }
  const lines = [];
  if (!ctx.active) return lines;
  lines.push(['参加（基礎）', Math.round(XP.perMinute * Math.min(5, Math.max(1, ctx.minutes)))]);
  if (m.kills) lines.push([`撃破 ×${m.kills}`, XP.kill * Math.min(20, m.kills)]);
  if (m.hits) lines.push([`命中 ×${m.hits}`, XP.hit * Math.min(40, m.hits)]);
  if (ctx.win) lines.push(['勝利', XP.win]);
  else if (ctx.draw) lines.push(['引き分け', XP.draw]);
  else if (ctx.place === 2 && ctx.players >= 3) lines.push(['2位', XP.second]);
  const t = Math.min(30, (m.turbo - m.orange) * XP.turbo + m.orange * XP.orange);
  if (t > 0) lines.push(['ドリフトターボ', t]);
  if (m.heals) lines.push(['回復アイテム', XP.heal * Math.min(5, m.heals)]);
  if (ctx.firstPlay) lines.push(['本日初プレイ', XP.firstPlay]);
  if (ctx.firstWin) lines.push(['本日初勝利', XP.firstWin]);
  return lines;
}
