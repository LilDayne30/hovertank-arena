// Arena-specific tuning for H4kor "Low Poly Desert Arena" scaled x3.
// The walled pit spans roughly x,z in [-30, 30] m; the floor is flat at y = 0.
// Spawn points sit inside the pit, facing the centre.
const S = [
  [-22, -22], [22, 22], [22, -22], [-22, 22],
  [0, -24], [0, 24], [-24, 0], [24, 0],
];
export const SPAWNS = S.map(([x, z]) => ({ x, z, yaw: Math.atan2(x, z) }));
// yaw convention: forward = (-sin(yaw), -cos(yaw)); facing the centre from (x,z) means forward = -(x,z)/|..|
// => -sin(yaw) = -x/r, -cos(yaw) = -z/r => yaw = atan2(x, z)

export const PLAYER_COLORS = [
  [0.85, 0.22, 0.18], // red
  [0.20, 0.45, 0.90], // blue
  [0.95, 0.75, 0.15], // yellow
  [0.25, 0.75, 0.35], // green
];
export const PLAYER_COLOR_NAMES = ['赤', '青', '黄', '緑'];

export const MATCH_SECONDS = 300;
export const RESULT_SECONDS = 10;
export const RECONNECT_SECONDS = 20;
export const MAX_PLAYERS = 4;
