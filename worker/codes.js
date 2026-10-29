// Short, easy-to-read room codes (no 0/O/1/I).
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
// room id for a passphrase: 'P' + 9 characters of its SHA-256 (fixed, so the same phrase -> same room)
export async function phraseRoomId(norm) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`ht-phrase:${norm}`)));
  return `P${[...h.slice(0, 9)].map((v) => ALPHABET[v % ALPHABET.length]).join('')}`;
}
export function roomCode() {
  const b = crypto.getRandomValues(new Uint8Array(6));
  return [...b].map((v) => ALPHABET[v % ALPHABET.length]).join('');
}
