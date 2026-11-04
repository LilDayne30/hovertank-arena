// Player names are shown to everyone in the room, so names with slurs or sexual words are refused
// (the server then uses "Player N"). Matching ignores width, case, spaces / symbols and
// katakana vs hiragana. Kept short on purpose: common substrings that make false positives are left out.
const WORDS = [
  // English
  'fuck', 'shit', 'bitch', 'cunt', 'nigger', 'nigga', 'faggot', 'retard', 'rape', 'penis', 'vagina', 'porn', 'pussy', 'whore', 'slut', 'nazi', 'hitler', 'killyourself',
  // Japanese (written in hiragana; katakana input is folded to hiragana)
  'しね', 'ころす', 'きちがい', 'がいじ', 'ちんこ', 'ちんぽ', 'まんこ', 'せっくす', 'れいぷ', 'ふぁっく', 'おなにー', 'ぱいぱん',
  '死ね', '氏ね', '殺す', '基地外', '池沼',
];
export function normName(s) {
  return String(s).normalize('NFKC').toLowerCase()
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/[\s\p{P}\p{S}_]/gu, '')
    .replace(/0/g, 'o').replace(/1/g, 'i').replace(/3/g, 'e').replace(/4/g, 'a').replace(/5/g, 's').replace(/\$/g, 's').replace(/@/g, 'a');
}
// ordinary words that contain a listed one (removed before matching)
const SAFE = ['しねま', 'shitake', 'scunthorpe', 'grape', 'drape', 'therapist', 'しねる'];
export const isBadName = (s) => { let n = normName(s); for (const w of SAFE) n = n.split(w).join(''); return WORDS.some((w) => n.includes(w)); };
