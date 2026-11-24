// =============================================================
// stats.js — small site-wide counters for the home screen.
//
//   onlineUsers/<uid>/tabs/<tabId>   one entry per open tab
//   dailyPlayers/<YYYY-MM-DD>/<uid>  one entry per player per UTC day
//
// Uids are anonymous. No nickname, room code or answer is stored here.
// Rules let a visitor write only their own uid; everyone signed in can
// read the counts so the homepage can show them live.
// =============================================================

import { db, signIn, ref, set, remove, onDisconnect, onValue, serverTimestamp } from './firebase.js';

export function utcDay() {
  return new Date().toISOString().slice(0, 10);
}

function connectionId() {
  // A fresh id per page load avoids a reload's old onDisconnect() removing
  // the new entry. Multiple tabs of the same user still dedupe by uid.
  const id = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80) || 'tab';
}

/** Publish this tab as online. Firebase removes the entry if we disconnect. */
export async function startPresence(uid) {
  const visitor = uid || await signIn();
  const entry = ref(db, `onlineUsers/${visitor}/tabs/${connectionId()}`);
  await onDisconnect(entry).remove();
  await set(entry, { connectedAt: serverTimestamp() });
}

/** Count this player once today when a game starts. Safe to call repeatedly. */
export async function recordPlay(uid, gameId) {
  const player = uid || await signIn();
  return set(ref(db, `dailyPlayers/${utcDay()}/${player}`), {
    lastGame: String(gameId || '').slice(0, 40),
    at: serverTimestamp(),
  });
}

/**
 * Live { online, playedToday } counts. Returns a function that stops both
 * listeners, so the app can clean up when it leaves the home screen.
 */
export function watchSiteStats(callback) {
  let online = 0;
  let playedToday = 0;
  const emit = () => callback({ online, playedToday });

  const stopOnline = onValue(ref(db, 'onlineUsers'), (snap) => {
    const users = snap.val() || {};
    online = Object.values(users)
      .filter((user) => user && user.tabs && Object.keys(user.tabs).length > 0).length;
    emit();
  }, () => { online = 0; emit(); });

  // The page is normally short-lived, but capture the day once per listener.
  const day = utcDay();
  const stopPlayed = onValue(ref(db, `dailyPlayers/${day}`), (snap) => {
    playedToday = Object.keys(snap.val() || {}).length;
    emit();
  }, () => { playedToday = 0; emit(); });

  return () => { stopOnline(); stopPlayed(); };
}
