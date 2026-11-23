// =============================================================
// storage.js — remembers small things on this phone (localStorage):
// your nickname, avatar, the room you were last in, sound on/off.
//
// Every read and write is wrapped in try/catch because some
// browsers (private mode, strict settings) block storage. The app
// must still work then; it just won't remember things.
// =============================================================

const PREFIX = 'fg.';

export function load(key, fallback = null) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function save(key, value) {
  try {
    if (value === null || value === undefined) localStorage.removeItem(PREFIX + key);
    else localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch { /* storage blocked: ignore */ }
}
