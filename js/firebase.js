// =============================================================
// firebase.js — connects the app to Firebase.
//
// We load the Firebase SDK straight from Google's CDN as ES modules,
// so there is no npm install and no build step.
// Every other file imports `db`, `auth` and the helpers from here
// instead of talking to the CDN directly.
// =============================================================

import { getApp, getApps, initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, signInAnonymously, onAuthStateChanged, connectAuthEmulator,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  getDatabase, ref, onValue, connectDatabaseEmulator,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';

import { firebaseConfig, EMULATOR } from './config.js';

// Re-export the database functions the rest of the app uses, so the
// SDK version number lives in this one file only.
export {
  ref, get, set, update, remove, onValue, off, onDisconnect,
  serverTimestamp, runTransaction, child,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';

// Use the local emulator only on localhost AND when ?emulator=1 is in the URL.
// This can never switch on by accident on the live github.io site.
// We remember the choice for this tab (sessionStorage), so it survives the
// address changing to ?room=ABCDE and page refreshes.
const params = new URLSearchParams(location.search);
const isLocalhost = ['localhost', '127.0.0.1'].includes(location.hostname);
function emulatorRequested() {
  try {
    if (params.get('emulator') === '1') sessionStorage.setItem('fg.emulator', '1');
    return sessionStorage.getItem('fg.emulator') === '1';
  } catch {
    return params.get('emulator') === '1';
  }
}
export const usingEmulator = isLocalhost && emulatorRequested();

// The emulator does not care about real keys, so give it a dummy project.
const config = usingEmulator
  ? { ...firebaseConfig, apiKey: 'demo-key', projectId: 'demo-flashgames',
      databaseURL: `http://${EMULATOR.host}:${EMULATOR.databasePort}?ns=demo-flashgames` }
  : firebaseConfig;

// getApps() keeps this module safe if it is ever evaluated twice.
const app = getApps().length ? getApp() : initializeApp(config);
export const auth = getAuth(app);
export const db = getDatabase(app);

if (usingEmulator) {
  connectAuthEmulator(auth, `http://${EMULATOR.host}:${EMULATOR.authPort}`, { disableWarnings: true });
  connectDatabaseEmulator(db, EMULATOR.host, EMULATOR.databasePort);
}

// ---------- Anonymous sign-in ----------
// Firebase remembers the anonymous user in the browser, so a player who
// refreshes the page keeps the SAME user id (uid). That is how we will
// let people rejoin their room after a refresh.
let uidPromise = null;
export function signIn() {
  if (!uidPromise) {
    const pending = new Promise((resolve, reject) => {
      // A restored session is already signed in; do not make a second call.
      if (auth.currentUser) {
        resolve(auth.currentUser.uid);
        return;
      }
      let settled = false;
      let starting = false;
      let stop = () => {};
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        stop(); // always detach the observer, on success AND failure
        callback(value);
      };
      stop = onAuthStateChanged(auth, (user) => {
        if (user) {
          finish(resolve, user.uid);
          return;
        }
        // The observer can fire null more than once before sign-in settles.
        if (starting) return;
        starting = true;
        signInAnonymously(auth)
          .then((credential) => finish(resolve, credential.user.uid))
          .catch((err) => finish(reject, err));
      });
    });
    uidPromise = pending;
    // A failed attempt must not poison every later call: allow a retry.
    pending.catch(() => { if (uidPromise === pending) uidPromise = null; });
  }
  return uidPromise;
}

/** Record this anonymous visitor once per UTC day for simple daily counts. */
export async function recordVisit(uid) {
  const visitor = uid || await signIn();
  await serverTimeReady;
  return set(ref(db, `siteVisits/${serverUtcDay()}/${visitor}`), serverTimestamp());
}

/** True when Firebase refused a read/write (as opposed to a network error). */
export function isPermissionDenied(err) {
  const code = String(err?.code || '');
  const message = String(err?.message || '');
  return code === 'PERMISSION_DENIED' || code.includes('permission-denied')
    || message.includes('PERMISSION_DENIED') || message.includes('Permission denied');
}

// ---------- Connection status ----------
// `.info/connected` is a special Firebase path: true when this browser
// has a live connection to the database, false when offline.
export function onConnectionChange(callback) {
  return onValue(ref(db, '.info/connected'), (snap) => callback(snap.val() === true));
}

// ---------- Server time ----------
// Phone clocks are often wrong by seconds or minutes. Firebase tells us
// the difference between our clock and the server's, so timers agree
// on every phone. Use serverNow() instead of Date.now() for game timers.
let serverOffset = 0;
let markTimeReady = () => {};
export const serverTimeReady = new Promise((resolve) => { markTimeReady = resolve; });
onValue(ref(db, '.info/serverTimeOffset'), (snap) => {
  serverOffset = Number(snap.val()) || 0;
  markTimeReady();
});
export function serverNow() {
  return Date.now() + serverOffset;
}
/** UTC day according to Firebase, not the phone clock. */
export function serverUtcDay() {
  return new Date(serverNow()).toISOString().slice(0, 10);
}
