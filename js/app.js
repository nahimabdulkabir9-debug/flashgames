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
const themeBtn = document.getElementById('theme-btn');
const themeMeta = document.querySelector('meta[name="theme-color"]');
const params = new URLSearchParams(location.search);
document.title = APP_NAME;
document.getElementById('brand-name').textContent = APP_NAME;

// ---------- Light / dark mode ----------
function applyTheme(theme, remember = true) {
  document.documentElement.dataset.theme = theme;
  const dark = theme === 'dark';
  themeBtn?.setAttribute('aria-pressed', String(dark));
  themeMeta?.setAttribute('content', dark ? '#12131f' : '#5b4bdb');
  if (remember) save('theme', theme);
}
const savedTheme = load('theme');
applyTheme(savedTheme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'), false);
themeBtn?.addEventListener('click', () => {
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
});

// ---------- Address bar helpers ----------
// Keep ?room=ABCDE in the address while you are in a room, so a refresh
// brings you straight back, and the link can be copied. Other parameters
// (notably ?emulator=1) are preserved instead of being wiped.
function setRoomInUrl(code) {
  const url = new URL(location.href);
  if (code) {
    url.searchParams.set('room', code);
    url.searchParams.delete('home');
  } else {
    url.searchParams.delete('room');
  }
  history.replaceState(null, '', url);
}

// ---------- Start ----------
let homeModule;   // home.js, loaded in start()
let lobbyModule;  // lobby.js, loaded in start()
let gamesModule;  // games/registry.js
let statsModule;  // stats.js
let running = null; // the game on screen: { id, game }
let activeSession = null;
let leaving = false;
let stopPublic = null; // stops the public-room list when we leave the home screen
let stopStats = null; // stops the live online/played-today counters
let stopConnection = null;
let serverNow = () => Date.now();
const AUTO_START_MS = 10000; // lobby countdown once enough players are in
let presenceUid = null;
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
  playedTodayKeys.add(key); // keep it on failure: a flaky network must not
  statsModule.recordPlay(uid, gameId).catch((err) => { // write on every update
    console.warn('Could not record today’s game', err);
  });
}

function showFatal(message) {
  mount(app, el('section', { class: 'card stack' },
    el('h2', {}, "Can't connect 😕"),
    el('p', { class: 'muted' }, message),
    el('a', { class: 'btn secondary', href: './?check=1' }, 'Run setup check')));
}

function clearScreens() {
  stopPublic?.(); stopPublic = null;
  stopStats?.(); stopStats = null;
}

async function publishPresence() {
  if (!presenceUid || !statsModule) return;
  try {
    await statsModule.startPresence(presenceUid);
  } catch (err) {
    console.warn('Could not publish online status; will retry on reconnect', err);
  }
}

async function start() {
  if (params.has('check') || !isFirebaseConfigured()) {
    try {
      const { runConnectionCheck } = await import('./check.js');
      return await runConnectionCheck(app);
    } catch (err) {
      console.error(err);
      showFatal('The setup check could not load. Check your internet connection and refresh.');
    }
    return;
  }

  // Load the Firebase-dependent modules only after the config check.
  // If the CDN is blocked, show a real error instead of a permanent "Loading…".
  try {
    const [fb, room, stats] = await Promise.all([
      import('./firebase.js'), import('./room.js'), import('./stats.js'),
    ]);
    const { signIn, onConnectionChange, recordVisit } = fb;
    serverNow = fb.serverNow;
    statsModule = stats;
    [homeModule, lobbyModule, gamesModule] = await Promise.all([
      import('./home.js'), import('./lobby.js'), import('./games/registry.js'),
    ]);

    // A persistent, quiet banner is better than a toast that disappears while
    // you are still offline. Firebase keeps trying to reconnect by itself.
    stopConnection = onConnectionChange((online) => {
      if (connectionBanner) {
        connectionBanner.hidden = online;
        connectionBanner.textContent = online ? '' : 'Offline — reconnecting…';
      }
      if (online) publishPresence(); // retry startup presence after reconnects
    });

    let uid;
    try {
      uid = await signInWithRetry(signIn);
    } catch (err) {
      console.error(err);
      showFatal('Check your internet connection and refresh the page.');
      return;
    }
    presenceUid = uid;
    clearScreens();

    // Privacy-light daily count: one entry per anonymous uid per UTC day.
    // Never let analytics stop someone from playing.
    recordVisit(uid).catch((err) => console.warn('Could not record the daily visit', err));
    publishPresence();

    // A ?room= link wins over lastRoom, unless the user tapped Home
    // (./?home=1). A failed invite no longer wipes the saved room.
    const invited = room.normalizeCode(params.get('room'));
    const saved = room.normalizeCode(load('lastRoom'));
    const invitedOk = room.isValidCode(invited);
    const candidate = params.has('home') ? '' : (invitedOk ? invited : (room.isValidCode(saved) ? saved : ''));

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
    if (candidate === saved) save('lastRoom', null);
    showHome(invitedOk ? invited : '', uid, room);
  } catch (err) {
    console.error(err);
    showFatal('A game file could not load. Check your internet connection and try a hard refresh (Ctrl + F5).');
  }
}

function showHome(invitedCode, uid, room) {
  clearScreens();
  app.classList.add('home-page');
  setRoomInUrl(invitedCode || null);
  const { renderHome } = homeModule;
  renderHome(app, {
    invitedCode,
    onCreate: async (profile, options) =>
      enterRoom(await room.createRoom(profile, options), uid, room, options?.gameId || ''),
    onQuick: async (profile, gameId) =>
      enterRoom(await room.quickPlay(profile, gameId, gamesModule.getGame(gameId)?.maxPlayers), uid, room, gameId || ''),
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
function showGameError(session, onLeave) {
  mount(app, el('section', { class: 'card stack' },
    el('h2', {}, 'Something went wrong in this game'),
    el('p', { class: 'muted' }, session.isHost
      ? 'Restarting returns everyone to the lobby.'
      : 'Ask the host to restart the game.'),
    session.isHost ? el('button', {
      class: 'btn', type: 'button',
      onclick: () => session.endGame().catch((err) => {
        console.warn('Could not end the game', err);
        toast('Could not return to the lobby. Try again.');
      }),
    }, 'Back to lobby') : null,
    el('button', { class: 'btn secondary', type: 'button', onclick: onLeave }, '🚪 Leave room')));
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
    // The game owns `box`; the leave bar lives outside it so render() inside
    // the game cannot remove the player's way out.
    const leaveBar = el('div', { class: 'game-exit-bar' }, el('button', {
      class: 'btn secondary', type: 'button', onclick: onLeave,
    }, '🚪 Leave room'));
    mount(app, box, leaveBar);
    try {
      running = { id: def.id, game: def.create(box, session, {}) };
    } catch (err) {
      console.error('Game could not start', err);
      showGameError(session, onLeave);
      return;
    }
  }
  try {
    running.game.update(r);
  } catch (err) {
    // One broken game screen must not take down the whole app.
    console.error('Game screen failed', err);
    stopGame();
    showGameError(session, onLeave);
  }
}

function enterRoom(code, uid, room, selectedGameId = '') {
  // Never let two sessions fight over presence, listeners or host timers.
  activeSession?.stop();
  activeSession = null;
  leaving = false;
  clearScreens();
  app.classList.remove('home-page');
  save('lastRoom', code);
  setRoomInUrl(code);
  mount(app, el('p', { class: 'muted center' }, `Joining room ${code}…`));

  // A game picked on the homepage is stored in the room meta, so it survives
  // a refresh. The host starts it as soon as enough players have joined.
  let autoStarted = false;
  let autoStartGameId = selectedGameId;
  let lastStatus = '';

  const session = new room.RoomSession(code, uid, {
    onUpdate: (r) => {
      if (leaving) return;
      maybeAutoStart(r);
      showRoom(session, r, () => leave());
    },
    onRemoved: (reason) => {
      leaving = true;
      stopGame();
      activeSession = null;
      save('lastRoom', null);
      showHome('', uid, room);
      showModal({ title: 'Back to home', body: [el('p', {}, reason)] });
      leaving = false;
    },
  });
  activeSession = session;

  // The lobby needs a ticking clock for the start countdown.
  const lobbyClock = setInterval(() => {
    if (leaving || !session.room) return;
    maybeAutoStart(session.room);
    if (session.room.meta.status === 'lobby' && session.room.meta.startAt) showRoom(session, session.room, () => leave());
  }, 1000);
  session.unsubscribers.push(() => clearInterval(lobbyClock));

  let startAtPending = false;
  function writeStartAt(value) {
    if (startAtPending) return;
    startAtPending = true;
    session.setStartAt(value).catch((err) => console.warn('Could not set the start time', err))
      .finally(() => { startAtPending = false; });
  }
  function maybeAutoStart(r) {
    if (lastStatus === 'playing' && r.meta.status === 'lobby') autoStarted = false;
    lastStatus = r.meta.status;
    if (autoStarted || !session.isHost || r.meta.status !== 'lobby') return;
    const gameId = r.meta.gameId || autoStartGameId;
    const game = gameId ? gamesModule.getGame(gameId) : null;
    if (!game) { if (r.meta.startAt) writeStartAt(null); return; }
    // Offline players must not count towards a minimum player requirement.
    const count = session.playerList().filter((p) => p.online !== false && !p.isBot).length;
    if (count < game.minPlayers || (game.maxPlayers && count > game.maxPlayers)) {
      if (r.meta.startAt) writeStartAt(null);
      return;
    }
    // Enough players: count down so friends who are still joining are not locked
    // out. A full room, or the host tapping Start, begins straight away.
    const full = count >= Math.min(game.maxPlayers || 16, 16);
    if (!full) {
      if (!r.meta.startAt) { writeStartAt(serverNow() + AUTO_START_MS); return; }
      if (serverNow() < r.meta.startAt) return;
    }
    autoStarted = true;
    autoStartGameId = '';
    session.startGame(game.id).catch((err) => {
      console.warn('Could not start the selected game', err);
      autoStarted = false;
      autoStartGameId = game.id;
    });
  }

  async function leave() {
    if (leaving) return;
    leaving = true;
    session.stop(); // stop listeners first; a queued snapshot cannot resurrect a game
    stopGame();
    try {
      await session.leave();
    } catch (err) {
      console.warn('Could not leave cleanly', err);
    }
    activeSession = null;
    clearScreens();
    save('lastRoom', null);
    showHome('', uid, room);
    toast('You left the room');
    leaving = false;
  }

  session.start();
}

start().catch((err) => {
  console.error(err);
  showFatal('The app could not start. Check your internet connection and refresh.');
});
