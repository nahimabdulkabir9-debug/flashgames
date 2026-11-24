// =============================================================
// app.js — the starting point of the app (index.html loads it).
//
// It decides which screen to show:
//   ?check=1        -> the setup check (check.js)
//   in a room       -> the lobby (lobby.js)
//   otherwise       -> the home screen (home.js)
// and it handles rejoining your room after a page refresh.
// =============================================================

import { APP_NAME, isFirebaseConfigured } from './config.js';
import { el, mount, toast, showModal } from './ui.js';
import { load, save } from './storage.js';

const app = document.getElementById('app');
const connectionBanner = document.getElementById('connection-banner');
const params = new URLSearchParams(location.search);
document.title = APP_NAME;
document.getElementById('brand-name').textContent = APP_NAME;

// ---------- Light / dark mode ----------
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  save('theme', theme);
}
applyTheme(load('theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
document.getElementById('theme-btn').addEventListener('click', () => {
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
});

// ---------- Address bar helpers ----------
// We keep ?room=ABCDE in the address while you are in a room, so a
// refresh brings you straight back, and the link can be copied.
function setRoomInUrl(code) {
  const url = code ? `${location.pathname}?room=${code}` : location.pathname;
  history.replaceState(null, '', url);
}

// ---------- Start ----------
let homeModule;   // home.js, loaded in start()
let lobbyModule;  // lobby.js, loaded in start()
let gamesModule;  // games/registry.js
let running = null; // the game on screen: { id, game }
let stopPublic = null; // stops the public-room list when we leave the home screen

// Anonymous sign-in can fail because the network is briefly down. A failed
// promise must not poison every later call, so try a few times with backoff.
async function signInWithRetry(signIn, tries = 3) {
  let lastError;
  for (let i = 0; i < tries; i += 1) {
    try { return await signIn(); } catch (err) {
      lastError = err;
      if (i < tries - 1) await new Promise((resolve) => setTimeout(resolve, 500 * (2 ** i)));
    }
  }
  throw lastError;
}

async function start() {
  if (params.has('check') || !isFirebaseConfigured()) {
    const { runConnectionCheck } = await import('./check.js');
    return runConnectionCheck(app);
  }

  // Load the Firebase-dependent modules only after the config check.
  // They are small, so we load them all at once, in parallel.
  const [{ signIn, onConnectionChange }, room] = await Promise.all([import('./firebase.js'), import('./room.js')]);
  [homeModule, lobbyModule, gamesModule] = await Promise.all([import('./home.js'), import('./lobby.js'), import('./games/registry.js')]);

  // A persistent, quiet banner is better than a toast that disappears while
  // you are still offline. Firebase keeps trying to reconnect by itself.
  onConnectionChange((online) => {
    if (!connectionBanner) return;
    connectionBanner.hidden = online;
    connectionBanner.textContent = online ? '' : 'Offline — reconnecting…';
  });

  let uid;
  try {
    uid = await signInWithRetry(signIn);
  } catch (err) {
    console.error(err);
    mount(app, el('section', { class: 'card' },
      el('h2', {}, "Can't connect 😕"),
      el('p', {}, 'Check your internet connection and refresh the page.'),
      el('a', { class: 'btn secondary', href: './?check=1' }, 'Run setup check')));
    return;
  }

  // Which room should we be in? A ?room= link wins; otherwise the room
  // saved from last time (for when the address was lost).
  const invited = room.normalizeCode(params.get('room'));
  const saved = room.normalizeCode(load('lastRoom'));
  const candidate = room.isValidCode(invited) ? invited : (room.isValidCode(saved) ? saved : '');

  if (candidate) {
    let inRoom = false;
    try {
      inRoom = await room.stillInRoom(candidate);
    } catch (err) {
      // A network failure is not proof that we were kicked. Keep the room
      // and join optimistically; the live listener will correct us if not.
      console.warn('Could not confirm room membership; rejoining optimistically', err);
      inRoom = true;
    }
    if (inRoom) return enterRoom(candidate, uid, room);
  }
  save('lastRoom', null);
  showHome(room.isValidCode(invited) ? invited : '', uid, room);
}

function showHome(invitedCode, uid, room) {
  setRoomInUrl(invitedCode || null);
  const { renderHome } = homeModule;
  renderHome(app, {
    invitedCode,
    onCreate: async (profile, options) => enterRoom(await room.createRoom(profile, options), uid, room),
    onQuick: async (profile) => enterRoom(await room.quickPlay(profile), uid, room),
    watchPublic: (callback) => { stopPublic?.(); stopPublic = room.watchPublicRooms(callback); },
    onJoin: async (code, profile) => enterRoom(await room.joinRoom(code, profile), uid, room),
  });
}

// Show the lobby, or the game the host started.
function stopGame() {
  try { running?.game.destroy(); } catch (err) { console.warn('Game cleanup failed', err); }
  running = null;
}
function showGameError(session) {
  mount(app, el('section', { class: 'card stack' },
    el('h2', {}, 'Something went wrong in this game'),
    el('p', { class: 'muted' }, session.isHost
      ? 'Restarting returns everyone to the lobby.'
      : 'Ask the host to restart the game.'),
    session.isHost ? el('button', {
      class: 'btn', type: 'button',
      onclick: () => session.endGame().catch((err) => console.warn('Could not end the game', err)),
    }, 'Back to lobby') : null));
}
function showRoom(session, r, onLeave) {
  const def = r.meta.status === 'playing' ? gamesModule.getGame(r.meta.gameId) : null;
  if (!def) {
    stopGame();
    return lobbyModule.renderLobby(app, session, { onLeave });
  }
  if (!running || running.id !== def.id) {
    stopGame();
    const box = el('div');
    mount(app, box);
    try {
      running = { id: def.id, game: def.create(box, session, {}) };
    } catch (err) {
      console.error('Game could not start', err);
      showGameError(session);
      return;
    }
  }
  try {
    running.game.update(r);
  } catch (err) {
    // One broken game screen must not take down the whole app.
    console.error('Game screen failed', err);
    stopGame();
    showGameError(session);
  }
}

function enterRoom(code, uid, room) {
  stopPublic?.();
  stopPublic = null;
  save('lastRoom', code);
  setRoomInUrl(code);
  mount(app, el('p', { class: 'muted center' }, `Joining room ${code}…`));

  const session = new room.RoomSession(code, uid, {
    onUpdate: (r) => showRoom(session, r, () => leave()),
    onRemoved: (reason) => {
      stopGame();
      save('lastRoom', null);
      showHome('', uid, room);
      showModal({ title: 'Back to home', body: [el('p', {}, reason)] });
    },
  });

  async function leave() {
    stopGame();
    await session.leave();
    save('lastRoom', null);
    showHome('', uid, room);
    toast('You left the room');
  }

  session.start();
}

start();
