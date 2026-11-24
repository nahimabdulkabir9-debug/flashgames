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

import {
  db, signIn, ref, set, onDisconnect, onValue, serverTimestamp, serverUtcDay,
} from './firebase.js';

function connectionId() {
  // One id per page load, reused if startPresence() is retried after a
  // reconnect. onDisconnect removes that same entry when this tab leaves.
  const id = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80) || 'tab';
}
const TAB_ID = connectionId();

/** UTC day according to Firebase, so a wrong phone clock cannot skew counts. */
export function utcDay() {
  return serverUtcDay();
}

/** Publish this tab as online. Firebase removes the entry if we disconnect. */
export async function startPresence(uid) {
  const visitor = uid || await signIn();
  const entry = ref(db, `onlineUsers/${visitor}/tabs/${TAB_ID}`);
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
  let day = '';
  let stopPlayed = null;
  let dayTimer = null;
  const emit = () => callback({ online, playedToday });

  // Keep the last known number on a transient error. Flashing 0 on every
  // network wobble made the site look broken when it was not.
  const stopOnline = onValue(ref(db, 'onlineUsers'), (snap) => {
    const users = snap.val() || {};
    online = Object.values(users)
      .filter((user) => user && user.tabs && Object.keys(user.tabs).length > 0).length;
    emit();
  }, () => { emit(); });

  function bindDay() {
    const next = utcDay();
    if (next === day) return;
    stopPlayed?.();
    day = next;
    stopPlayed = onValue(ref(db, `dailyPlayers/${day}`), (snap) => {
      playedToday = Object.keys(snap.val() || {}).length;
      emit();
    }, () => { emit(); });
  }
  bindDay(); // a page left open overnight must follow the new UTC day
  dayTimer = setInterval(bindDay, 60000);

  return () => {
    clearInterval(dayTimer);
    stopOnline();
    stopPlayed?.();
  };
}
