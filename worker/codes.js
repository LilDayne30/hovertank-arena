// Short, easy-to-read room codes (no 0/O/1/I).
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function roomCode() {
  const b = crypto.getRandomValues(new Uint8Array(6));
  return [...b].map((v) => ALPHABET[v % ALPHABET.length]).join('');
}
