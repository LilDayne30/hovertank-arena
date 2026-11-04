// Tutorial: a private room with two target tanks that never shoot back. The server (shared/game.js)
// checks each step and, after the last one, the room grants the reward items (shared/progress.js,
// unlock { ach: 'tutorial' }). Texts are Japanese source strings (translated with client/i18n.js).
export const TUTORIAL_ACH = 'tutorial';

// need = how much of it (metres driven, hits, uses, kills) before the next step
export const TUT_STEPS = [
  { id: 'move', need: 14, title: '移動', pc: 'WASD で走ってみよう', touch: '画面の左側に指を置いて、すべらせて走ろう', count: '{n}/{need} m' },
  { id: 'hit', need: 2, title: '射撃', pc: 'マウスで的を狙って、左クリックで撃とう', touch: '画面の右側をなぞって狙い、FIRE で撃とう', count: '命中 {n}/{need}' },
  { id: 'jump', need: 1, title: 'ジャンプ', pc: 'Space でジャンプしよう', touch: 'JUMP でジャンプしよう' },
  { id: 'side', need: 1, title: 'サイドアーム', pc: 'E で「{side}」を使おう', touch: 'SUB で「{side}」を使おう' },
  { id: 'ult', need: 1, title: '必殺技', pc: '必殺技ゲージを満タンにしたよ。Q で「{ult}」を撃とう', touch: '必殺技ゲージを満タンにしたよ。SP で「{ult}」を撃とう' },
  { id: 'kill', need: 1, title: '撃破', pc: '的を1台撃破しよう', touch: '的を1台撃破しよう' },
];

// where things stand in the tutorial room: the player starts in the south-west corner facing north,
// up the open strip along the west wall; the two targets wait ~25 m ahead (no cover in between)
export const TUT_PLAYER = { x: -31, z: -31, yaw: Math.PI };
export const TUT_TARGETS = [{ x: -35, z: -6 }, { x: -25, z: -9 }];
export const TUT_TARGET_NAMES = ['的A', '的B'];
