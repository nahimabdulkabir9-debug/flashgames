// =============================================================
// config.js — the ONE place for app-wide settings.
//
// Change APP_NAME here to rename the whole site.
// Paste your Firebase web config into firebaseConfig (see README).
//
// Is it safe to put the Firebase config in a PUBLIC repo? YES.
// These values only tell the browser WHICH Firebase project to
// talk to. They are not passwords. What actually protects your data
// is the security rules in firebase/database.rules.json, plus the
// "Authorized domains" list in Firebase Authentication.
// Never put a service-account key or admin secret in this repo.
// =============================================================

export const APP_NAME = 'FlashGames';
export const APP_TAGLINE = 'Party games for friends, anywhere in the world. No download, no sign-up.';

export const firebaseConfig = {
  apiKey: 'AIzaSyDhRMp5vLjZ8-Jv8tS_aiVlL_MqvQrOuyc',
  authDomain: 'flashgames-5b774.firebaseapp.com',
  databaseURL: 'https://flashgames-5b774-default-rtdb.europe-west1.firebasedatabase.app',
  projectId: 'flashgames-5b774',
  storageBucket: 'flashgames-5b774.firebasestorage.app',
  messagingSenderId: '657706947440',
  appId: '1:657706947440:web:270cefdae630416691f5b5',
};

// Local testing with the Firebase Emulator (see README, "Test locally").
// When you open the site on localhost with ?emulator=1 in the address,
// the app talks to the emulator on your computer instead of the real project.
export const EMULATOR = {
  host: '127.0.0.1',
  databasePort: 9000,
  authPort: 9099,
};

// True once you have replaced the placeholder values above.
export function isFirebaseConfigured() {
  return !firebaseConfig.apiKey.startsWith('PASTE_');
}
