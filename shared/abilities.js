// Sidearms (cooldown, E / SUB) and special moves (meter, Q / SP).
// Everyone can pick any of them from the start: they change how you play, not how strong you are.
// Design rule: one button each, but timing / placement / aim decide how much they are worth.

export const SIDEARMS = [
  { id: 'dash', name: 'ブーストダッシュ', icon: '»', cd: 6,
    desc: '押した瞬間、入力している方向へ一気に加速（空中でも可）。弾をかわす・距離を詰める・ドリフトターボとつなげる。',
    tip: '撃たれた瞬間に横へ。ジャンプ中に使うと空中で軌道を変えられる',
    speed: 21, time: 0.3, cap: 32 },
  { id: 'shield', name: 'リフレクトシールド', icon: '◎', cd: 10,
    desc: '1.5秒間、砲弾と爆風を防ぐバリア。張った直後0.25秒以内に受けた砲弾は、撃った相手へはね返す。',
    tip: '弾が届く直前に張るとジャストガード（はね返し）',
    dur: 1.5, perfect: 0.25 },
  { id: 'mine', name: '地雷', icon: '✱', cd: 9,
    desc: '車体の後ろに地雷を置く（最大2個・30秒）。0.8秒後に作動し、敵が3m以内に入ると爆発。',
    tip: '追ってくる相手の進路、回復アイテムの丘、曲がり角に',
    max: 2, arm: 0.8, trigger: 3, radius: 3.8, damage: [34, 18], life: 30 },
  { id: 'bounce', name: 'バウンド弾', icon: '↯', cd: 7,
    desc: '壁や地面で2回はね返る砲弾を、メインの砲撃とは別に撃つ。',
    tip: '壁に向けて撃って、遮蔽物の裏に隠れた相手をねらう',
    bounces: 2, restitution: 0.85 },
];

export const ULTS = [
  { id: 'overdrive', name: 'オーバードライブ', icon: '⚡',
    desc: '6秒間、連射が約2倍・最高速度とドリフトの溜まりが上がる。',
    tip: '撃ち合いの最中に。ドリフトターボと重ねると手がつけられない',
    dur: 6, fireMul: 0.45, speedMul: 1.2, accelMul: 1.3, chargeMul: 1.6 },
  { id: 'mega', name: 'メガキャノン', icon: '☄',
    desc: '速く、ほとんど落ちない大砲弾。直撃で75ダメージ、まわり5mにも爆風。',
    tip: '遠くの相手の動きを読んで直撃させる',
    speed: 150, gravity: 3, life: 1.7, hitR: 0.7, direct: 75, radius: 5, splash: [40, 15] },
  { id: 'strike', name: 'エアストライク', icon: '✈',
    desc: '照準した場所に、1.4秒後から6発の爆撃が降る（半径5.5m）。',
    tip: '相手の逃げ道や、回復アイテムを取りに来る瞬間をねらう',
    delay: 1.4, bombs: 6, spread: 5.5, span: 0.9, radius: 3.4, damage: [28, 14] },
  { id: 'slam', name: 'グラウンドスラム', icon: '⤓',
    desc: '高く跳んで急降下。着地点のまわり8mに衝撃波（最大55ダメージ）と吹き飛ばし。空中で使うとすぐ急降下。',
    tip: 'ジャンプ中や丘の上から、敵の真ん中に落ちる',
    jump: 16, fallG: 3.2, dive: -24, radius: 8, damage: [55, 15], kb: 15 },
];

export const ULT_MAX = 100;
export const ULT_GAIN = { perSec: 1.5, hit: 10, kill: 20 };   // ~ one special every 40-60 s of fighting
export const DEFAULT_LOADOUT = { side: 'dash', ult: 'overdrive' };
export const SIDE = Object.fromEntries(SIDEARMS.map((a, i) => [a.id, { ...a, index: i }]));
export const ULT = Object.fromEntries(ULTS.map((a, i) => [a.id, { ...a, index: i }]));
export function cleanLoadout(l) {
  return { side: SIDE[l?.side] ? l.side : DEFAULT_LOADOUT.side, ult: ULT[l?.ult] ? l.ult : DEFAULT_LOADOUT.ult };
}
