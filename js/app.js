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
let statsModule;  // stats.js
let running = null; // the game on screen: { id, game }
let stopPublic = null; // stops the public-room list when we leave the home screen
let stopStats = null; // stops the live online/played-today counters
const playedTodayKeys = new Set(); // avoid rewriting the same day/game over and over

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

// One row per player per UTC day, written by each player when a game starts.
function notePlayed(uid, gameId) {
  if (!statsModule || !gameId) return;
  const key = `${statsModule.utcDay()}|${gameId}`;
  if (playedTodayKeys.has(key)) return;
  playedTodayKeys.add(key);
  statsModule.recordPlay(uid, gameId).catch((err) => {
    playedTodayKeys.delete(key);
    console.warn('Could not record today’s game', err);
  });
}

async function start() {
  if (params.has('check') || !isFirebaseConfigured()) {
    const { runConnectionCheck } = await import('./check.js');
    return runConnectionCheck(app);
  }

  // Load the Firebase-dependent modules only after the config check.
  // They are small, so we load them all at once, in parallel.
  const [{ signIn, onConnectionChange, recordVisit }, room, stats] = await Promise.all([
    import('./firebase.js'), import('./room.js'), import('./stats.js'),
  ]);
  statsModule = stats;
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

  // Privacy-light daily count: one entry per anonymous uid per UTC day.
  // Never let analytics stop someone from playing.
  recordVisit(uid).catch((err) => console.warn('Could not record the daily visit', err));
  statsModule.startPresence(uid).catch((err) => console.warn('Could not publish online status', err));

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
  app.classList.add('home-page');
  setRoomInUrl(invitedCode || null);
  const { renderHome } = homeModule;
  renderHome(app, {
    invitedCode,
    onCreate: async (profile, options) =>
      enterRoom(await room.createRoom(profile, options), uid, room, options?.gameId || ''),
    onQuick: async (profile, gameId) =>
      enterRoom(await room.quickPlay(profile, gameId), uid, room, gameId || ''),
    watchPublic: (callback) => { stopPublic?.(); stopPublic = room.watchPublicRooms(callback); },
    watchStats: (callback) => {
      stopStats?.();
      stopStats = statsModule?.watchSiteStats(callback) || null;
    },
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
  if (r.meta.status === 'playing') notePlayed(session.uid, def.id);
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

function enterRoom(code, uid, room, selectedGameId = '') {
  app.classList.remove('home-page');
  stopPublic?.();
  stopPublic = null;
  stopStats?.();
  stopStats = null;
  save('lastRoom', code);
  setRoomInUrl(code);
  mount(app, el('p', { class: 'muted center' }, `Joining room ${code}…`));

  // A game picked on the homepage is stored in the room meta, so it survives
  // a refresh. The host starts it as soon as enough players have joined.
  let autoStarted = false;

  const session = new room.RoomSession(code, uid, {
    onUpdate: (r) => {
      maybeAutoStart(r);
      showRoom(session, r, () => leave());
    },
    onRemoved: (reason) => {
      stopGame();
      save('lastRoom', null);
      showHome('', uid, room);
      showModal({ title: 'Back to home', body: [el('p', {}, reason)] });
    },
  });

  function maybeAutoStart(r) {
    if (autoStarted || !session.isHost || r.meta.status !== 'lobby') return;
    const gameId = r.meta.gameId || selectedGameId;
    const game = gameId ? gamesModule.getGame(gameId) : null;
    if (!game) return;
    const count = Object.keys(r.players || {}).length;
    if (count < game.minPlayers || (game.maxPlayers && count > game.maxPlayers)) return;
    autoStarted = true;
    session.startGame(game.id).catch((err) => {
      console.warn('Could not start the selected game', err);
      autoStarted = false;
    });
  }

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
