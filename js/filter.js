// =============================================================
// filter.js — cleans up text that players type.
//
// cleanText()     removes invisible/control characters and extra spaces.
// checkNickname() also enforces the length limit and blocks rude names.
//
// Remember: cleaning is NOT what keeps the page safe from code
// injection. That is done by always displaying text with
// textContent (see ui.js). Cleaning just keeps names readable.
// =============================================================

export const NAME_MIN = 2;
export const NAME_MAX = 16;

/** Remove control characters, zero-width characters and repeated spaces. */
export function cleanText(raw, maxLength = 200) {
  const text = String(raw ?? '')
    .normalize('NFC')
    // Control characters (newlines, tabs, etc.) and zero-width/invisible ones.
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202F\u2060-\u206F\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  // Cut to maxLength without splitting an emoji in half.
  let out = '';
  for (const ch of text) {
    if (out.length + ch.length > maxLength) break;
    out += ch;
  }
  return out.trim();
}

// Words that are never OK anywhere inside a name (checked after
// removing dots and spaces, so "f.u.c.k" and "fuuuck" are caught too).
const BLOCK_ANYWHERE = [
  'fuck', 'bitch', 'cunt', 'nigger', 'nigga', 'whore', 'pussy',
  'asshole', 'motherf', 'slut', 'bastard', 'porn', 'vagina',
  'ashawo', 'olosho', 'oloshi', 'ashewo',
];

// Words that are only blocked as whole words, because they appear
// inside innocent names (e.g. "dick" in "Dickson", "ass" in "Hassan",
// "shit" in "Ashita", "rapist" in "therapist").
const BLOCK_WHOLE_WORD = [
  'dick', 'cock', 'ass', 'sex', 'rape', 'rapist', 'toto', 'tits', 'fag', 'hoe',
  'shit', 'shitty', 'penis', 'fuk',
];

// Turn common look-alike characters back into letters: 0 -> o, 3 -> e, $ -> s...
function unLeet(text) {
  const map = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', '@': 'a', $: 's', '!': 'i' };
  return text.toLowerCase().replace(/[013457@$!8]/g, (c) => map[c]);
}

// Build a pattern that also matches stretched spellings: "fuck" matches
// "fuuuck". Letters that are doubled in the word must stay doubled, so
// "nigger" does not match "Nigeria".
function stretchPattern(word) {
  const runs = word.match(/(.)\1*/g);
  return new RegExp(runs.map((run) => (run.length > 1 ? `${run[0]}{${run.length},}` : `${run}+`)).join(''));
}
const ANYWHERE_PATTERNS = BLOCK_ANYWHERE.map(stretchPattern);

export function isRude(text) {
  const plain = unLeet(text);
  const lettersOnly = plain.replace(/[^a-z]/g, ''); // "f.u.c.k" -> "fuck"
  if (ANYWHERE_PATTERNS.some((pattern) => pattern.test(lettersOnly))) return true;
  const words = plain.split(/[^a-z]+/).filter(Boolean);
  return words.some((w) => BLOCK_WHOLE_WORD.includes(w));
}

/**
 * Check a nickname. Returns { ok: true, name } with the cleaned name,
 * or { ok: false, error } with a message to show the player.
 */
export function checkNickname(raw) {
  const name = cleanText(raw, NAME_MAX);
  if (name.length < NAME_MIN) return { ok: false, error: `Name must be at least ${NAME_MIN} characters.` };
  if (isRude(name)) return { ok: false, error: 'Please choose a different name 🙏' };
  return { ok: true, name };
}
