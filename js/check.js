// =============================================================
// check.js — the "Setup check" screen from milestone (a).
//
// Open the site with ?check=1 to see it. It tests, step by step,
// that Firebase config, anonymous sign-in, the live connection and a
// database write all work, and explains how to fix whatever fails.
// =============================================================

import { isFirebaseConfigured } from './config.js';
import { el, mount, toast } from './ui.js';

// One row per check, with a status dot that turns green when it passes.
function checkRow(label) {
  const status = el('span', { class: 'check-status' }, 'checking…');
  const row = el('li', { class: 'check' }, el('span', { class: 'dot' }), el('span', {}, label), status);
  return {
    row,
    pass(text = 'OK') { row.classList.add('ok'); status.textContent = text; },
    fail(text) { row.classList.add('bad'); status.textContent = text; },
  };
}

export async function runConnectionCheck(app) {
  const configRow = checkRow('Firebase config');
  const authRow = checkRow('Anonymous sign-in');
  const liveRow = checkRow('Live connection');
  const writeRow = checkRow('Database write + read');

  mount(app,
    el('section', { class: 'card' },
      el('h2', {}, 'Setup check'),
      el('ul', { class: 'checks' }, configRow.row, authRow.row, liveRow.row, writeRow.row)),
    el('a', { class: 'btn secondary', href: './' }, 'Back to home'),
  );

  // Load firebase.js only now, so a missing config shows a clear message
  // instead of a crash.
  if (!isFirebaseConfigured()) {
    configRow.fail('not set: paste your config into js/config.js');
    return;
  }
  const fb = await import('./firebase.js');
  const { ref, set, get, serverTimestamp } = fb;
  configRow.pass(fb.usingEmulator ? 'using local emulator' : 'OK');

  try {
    const uid = await fb.signIn();
    authRow.pass(`OK (you are ${uid.slice(0, 6)}…)`);

    fb.onConnectionChange((online) => {
      if (online) { liveRow.row.classList.remove('bad'); liveRow.pass('online'); }
      else { liveRow.row.classList.remove('ok'); liveRow.fail('offline'); }
    });

    // Write the server time to connectionTest/<uid>, then read it back.
    const testRef = ref(fb.db, `connectionTest/${uid}`);
    await set(testRef, serverTimestamp());
    const snap = await get(testRef);
    const drift = Math.round((fb.serverNow() - snap.val()) / 1000);
    writeRow.pass(`OK (server time check: ${Math.abs(drift)}s)`);
    toast('Firebase is working 🎉');
  } catch (err) {
    console.error(err);
    const failing = authRow.row.classList.contains('ok') ? writeRow : authRow;
    failing.fail(friendlyError(err));
  }
}

// Turn Firebase error codes into advice a human can act on.
function friendlyError(err) {
  const code = err && err.code ? err.code : String(err);
  if (code.includes('operation-not-allowed') || code.includes('admin-restricted')) {
    return 'Anonymous sign-in is not enabled in Firebase (README step 3)';
  }
  if (code.includes('unauthorized-domain')) {
    return 'This website is not in Firebase "Authorized domains" (README step 6)';
  }
  if (code.includes('PERMISSION_DENIED') || code.includes('permission')) {
    return 'Blocked by database rules: publish firebase/database.rules.json (README step 5)';
  }
  if (code.includes('api-key')) return 'The apiKey in js/config.js looks wrong';
  return code;
}

