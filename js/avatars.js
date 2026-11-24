// avatars.js: drawn avatars (little animal characters), made in code as SVG.
// A player's avatar is stored as a short id like "a7". Old emoji avatars still show as text.
// The SVG is built only from the fixed lists below, never from user text.

export const AVATAR_IDS = Array.from({ length: 24 }, (_, i) => `a${i + 1}`);

const BG = ['#ffd166', '#ef476f', '#06d6a0', '#4cc9f0', '#9b5de5', '#f15bb5', '#fee440', '#7bd389'];
const FUR = ['#f4a261', '#e9c46a', '#adb5bd', '#f8f9fa', '#b08968', '#ffb3c1'];
const EARS = ['cat', 'bear', 'bunny', 'none'];
const EYES = ['dots', 'happy', 'wink', 'glasses'];
const MOUTH = ['smile', 'open', 'cat'];
const ACC = ['none', 'cap', 'crown', 'phones'];
const INK = '#2b2d42';

export function avatarSvg(id) {
  const n = AVATAR_IDS.indexOf(id);
  if (n < 0) return null;
  const bg = BG[n % 8]; const fur = FUR[(n * 5 + 1) % 6];
  const ears = EARS[n % 4]; const eyes = EYES[(n >> 2) % 4]; const mouth = MOUTH[n % 3]; const acc = ACC[(n >> 1) % 4];
  const accColor = BG[(n + 3) % 8];
  const stroke = `fill="none" stroke="${INK}" stroke-width="2.4" stroke-linecap="round"`;
  const thin = `fill="none" stroke="${INK}" stroke-width="1.8" stroke-linecap="round"`;
  const parts = [`<circle cx="32" cy="32" r="32" fill="${bg}"/>`];
  if (ears === 'cat') parts.push(`<path d="M12 28 L14 6 L29 17Z M52 28 L50 6 L35 17Z" fill="${fur}"/>`);
  if (ears === 'bear') parts.push(`<circle cx="15" cy="17" r="8" fill="${fur}"/><circle cx="49" cy="17" r="8" fill="${fur}"/>`);
  if (ears === 'bunny') parts.push(`<ellipse cx="22" cy="12" rx="5" ry="13" fill="${fur}"/><ellipse cx="42" cy="12" rx="5" ry="13" fill="${fur}"/>`);
  parts.push(`<circle cx="32" cy="38" r="21" fill="${fur}"/>`);
  if (eyes === 'dots' || eyes === 'glasses') parts.push(`<circle cx="24" cy="35" r="2.8" fill="${INK}"/><circle cx="40" cy="35" r="2.8" fill="${INK}"/>`);
  if (eyes === 'happy') parts.push(`<path d="M20.5 36 q3.5 -5 7 0 M36.5 36 q3.5 -5 7 0" ${stroke}/>`);
  if (eyes === 'wink') parts.push(`<circle cx="24" cy="35" r="2.8" fill="${INK}"/><path d="M36.5 36 q3.5 -5 7 0" ${stroke}/>`);
  if (eyes === 'glasses') parts.push(`<circle cx="24" cy="35" r="6.5" ${thin}/><circle cx="40" cy="35" r="6.5" ${thin}/><path d="M30.5 35 h3" ${thin}/>`);
  parts.push(`<circle cx="32" cy="42" r="2" fill="#c9506f"/>`);
  if (mouth === 'smile') parts.push(`<path d="M26 47 q6 6 12 0" ${stroke}/>`);
  if (mouth === 'open') parts.push(`<ellipse cx="32" cy="50" rx="4.5" ry="3.4" fill="#7a1f2b"/>`);
  if (mouth === 'cat') parts.push(`<path d="M25 47 q3.5 4 7 0 q3.5 4 7 0" ${stroke}/>`);
  if (acc === 'cap') parts.push(`<path d="M13 30 Q32 4 51 30Z" fill="${accColor}"/><rect x="11" y="28" width="42" height="5" rx="2.5" fill="${accColor}"/>`);
  if (acc === 'crown') parts.push(`<path d="M20 22 L21 8 L27 15 L32 6 L37 15 L43 8 L44 22Z" fill="#ffd23f" stroke="#c99a00" stroke-width="1.5" stroke-linejoin="round"/>`);
  if (acc === 'phones') parts.push(`<path d="M12 40 Q11 12 32 12 Q53 12 52 40" fill="none" stroke="${INK}" stroke-width="4"/><rect x="8" y="35" width="8" height="14" rx="3.5" fill="${INK}"/><rect x="48" y="35" width="8" height="14" rx="3.5" fill="${INK}"/>`);
  return `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${parts.join('')}</svg>`;
}

/** A round avatar element. size is in pixels; 0 means fill the parent. */
export function avatarEl(id, size = 40) {
  const node = document.createElement('span');
  node.className = 'avatar';
  node.style.cssText = size ? `width:${size}px;height:${size}px` : 'width:100%;aspect-ratio:1';
  const svg = avatarSvg(id);
  if (svg) node.innerHTML = svg; // safe: built only from our own fixed lists
  else node.textContent = id || '🙂'; // an older emoji avatar
  return node;
}
