// =============================================================
// home.js — the first screen: nickname, avatar, create or join,
// and a game catalog where players can pick a game and start it.
//
// It doesn't talk to Firebase itself. It calls the callbacks app.js
// provides: onCreate(profile, options), onJoin(code, profile),
// onQuick(profile, gameId), watchPublic(callback), watchStats(callback).
// =============================================================

import { APP_TAGLINE } from './config.js';
import { el, mount } from './ui.js';
import { checkNickname, NAME_MAX } from './filter.js';
import { normalizeCode, isValidCode, MAX_PLAYERS_PER_ROOM } from './room.js';
import { load, save } from './storage.js';
import { AVATAR_IDS, avatarEl } from './avatars.js';
import { GAMES, CATEGORIES, getGame } from './games/registry.js';

export const AVATARS = AVATAR_IDS;
const OLD_EMOJI_AVATARS = [
  '😎', '🦁', '🐼', '🐘', '🦅', '🦊', '🐙', '🦜',
  '🚀', '🍕', '🍔', '🌮', '🍩', '🍉', '🍍', '🌽',
  '⚽', '🎧', '🎤', '🥁', '👑', '🔥', '⚡', '🎮',
];

const count = (n) => Number(n || 0).toLocaleString();

function sectionHead(title, subtitle) {
  return el('div', { class: 'section-head' },
    el('div', {}, el('h2', {}, title), el('p', { class: 'muted' }, subtitle)));
}

/**
 * Draw the home screen.
 * @param container   where to draw
 * @param invitedCode a room code from a ?room= link, or ''
 * @param onCreate    async (profile, options) => {}
 * @param onJoin      async (code, profile) => {}
 * @param onQuick     async (profile, gameId) => {}
 * @param watchPublic (rooms) => {} listener setup
 * @param watchStats  ({ online, playedToday }) => {} listener setup
 */
export function renderHome(container, {
  invitedCode = '', onCreate, onJoin, onQuick, watchPublic, watchStats,
}) {
  const saved = load('profile', {});
  let avatar = AVATARS.includes(saved.avatar) ? saved.avatar
    : AVATARS[Math.floor(Math.random() * AVATARS.length)];

  // ---- Nickname ----
  const nameInput = el('input', {
    id: 'name', class: 'input', type: 'text', maxlength: NAME_MAX,
    autocomplete: 'nickname', placeholder: 'e.g. Alex', enterkeyhint: 'done',
  });
  nameInput.value = saved.name || '';
  const errorBox = el('p', { class: 'error', role: 'alert' });

  // ---- Avatar picker: a grid of big emoji buttons ----
  const avatarButtons = AVATARS.map((emoji) => el('button', {
    type: 'button',
    class: `avatar-option${emoji === avatar ? ' selected' : ''}`,
    'aria-label': `Avatar ${emoji}`,
    'aria-pressed': emoji === avatar ? 'true' : 'false',
    onclick: (event) => {
      avatar = emoji;
      avatarButtons.forEach((b) => {
        const on = b === event.currentTarget;
        b.classList.toggle('selected', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    },
  }, avatarEl(emoji, 0)));

  // ---- Join code ----
  const codeInput = el('input', {
    id: 'code', class: 'input code-input', type: 'text', maxlength: 5,
    autocapitalize: 'characters', autocomplete: 'off', spellcheck: 'false',
    placeholder: 'ABCDE', 'aria-label': 'Room code', enterkeyhint: 'go',
  });
  codeInput.value = invitedCode;
  codeInput.addEventListener('input', () => { codeInput.value = normalizeCode(codeInput.value); });

  // Check the form and return the profile, or show an error and return null.
  function readProfile() {
    const result = checkNickname(nameInput.value);
    if (!result.ok) {
      errorBox.textContent = result.error;
      nameInput.focus();
      return null;
    }
    nameInput.value = result.name;
    const profile = { name: result.name, avatar };
    save('profile', profile);
    return profile;
  }

  // Disable every action button while Firebase is working, so double taps
  // don't create two rooms or start two games.
  async function busy(button, task) {
    errorBox.textContent = '';
    const all = [...container.querySelectorAll('[data-busy]')];
    all.forEach((b) => { b.disabled = true; });
    const label = button.textContent;
    button.textContent = 'Please wait…';
    try {
      await task();
    } catch (err) {
      console.error(err);
      errorBox.textContent = err.message || 'Something went wrong. Check your internet and try again.';
      all.forEach((b) => { b.disabled = false; });
      button.textContent = label;
    }
  }

  const createBtn = el('button', {
    class: 'btn', type: 'button', 'data-busy': 'true',
    onclick: () => {
      const profile = readProfile();
      if (profile) busy(createBtn, () => onCreate(profile, { isPublic }));
    },
  }, '🎉 Create a room');

  const joinBtn = el('button', {
    class: 'btn warm', type: 'button', 'data-busy': 'true',
    onclick: () => {
      const profile = readProfile();
      if (!profile) return;
      const code = normalizeCode(codeInput.value);
      if (!isValidCode(code)) {
        errorBox.textContent = 'Type the 5-letter room code your friend sent you.';
        codeInput.focus();
        return;
      }
      busy(joinBtn, () => onJoin(code, profile));
    },
  }, 'Join');
  codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinBtn.click(); });

  // ---- Room type: private or public ----
  let isPublic = false;
  const typeNote = el('p', { class: 'muted center' }, 'Only people with your code or link can join.');
  const typeBtns = [['🔒 Private', false], ['🌍 Public', true]].map(([label, value]) => el('button', {
    type: 'button', class: `seg-btn${value ? '' : ' selected'}`,
    onclick: () => {
      isPublic = value;
      typeBtns.forEach((b, i) => b.classList.toggle('selected', (i === 1) === value));
      typeNote.textContent = value ? 'Anyone can find and join from the public list.' : 'Only people with your code or link can join.';
    },
  }, label));
  const typeRow = el('div', { class: 'stack' }, el('div', { class: 'seg' }, typeBtns), typeNote);

  // ---- Public rooms list + Quick play ----
  const quickBtn = el('button', {
    class: 'btn secondary', type: 'button', 'data-busy': 'true',
    onclick: () => { const profile = readProfile(); if (profile) busy(quickBtn, () => onQuick(profile)); },
  }, '⚡ Quick play');
  const publicList = el('ul', { class: 'player-list' }, el('li', { class: 'muted' }, 'Looking for rooms…'));
  const publicCard = el('section', { class: 'card stack' }, el('h2', {}, '🌍 Public rooms'), publicList, quickBtn);
  // The invited view hides the public list, so don't leave a listener running
  // just to update a card that is not on screen.
  if (watchPublic && !invitedCode) {
    watchPublic((rooms) => {
      publicList.replaceChildren(...(rooms.length ? rooms.map((r) => {
        const game = getGame(r.gameId);
        return el('li', { class: 'player' },
          el('span', { class: 'player-avatar', 'aria-hidden': 'true' }, avatarEl(r.avatar, 44)),
          el('span', { class: 'player-name' }, `${r.hostName}'s room`),
          el('span', { class: 'player-status' },
            `${game ? `${game.emoji} ${game.shortName}` : 'Open room'} · ${r.players}/${MAX_PLAYERS_PER_ROOM}`),
          el('button', {
            class: 'btn join-mini', type: 'button', 'data-busy': 'true',
            onclick: () => { const p = readProfile(); if (p) busy(quickBtn, () => onJoin(r.code, p)); },
          }, 'Join'));
      }) : [el('li', { class: 'muted' }, 'No public rooms right now. Create one!')]));
    });
  }

  // ---- Live site counters ----
  const onlineNumber = el('strong', { class: 'stat-number' }, '–');
  const playedNumber = el('strong', { class: 'stat-number' }, '–');
  const stat = (emoji, number, label) => el('div', { class: 'stat-card' },
    el('span', { class: 'stat-icon', 'aria-hidden': 'true' }, emoji),
    number,
    el('span', { class: 'stat-label' }, label));
  const statsRow = el('div', {
    class: 'hero-stats', role: 'group', 'aria-label': 'Site activity',
  }, stat('🟢', onlineNumber, 'online now'), stat('🎮', playedNumber, 'played today'));
  if (watchStats) {
    watchStats(({ online, playedToday }) => {
      onlineNumber.textContent = count(online);
      playedNumber.textContent = count(playedToday);
    });
  }

  const hero = el('section', { class: 'card hero home-hero' },
    el('p', { class: 'eyebrow' }, '⚡ FlashGames'),
    el('h1', {}, 'Play together, anywhere.'),
    el('p', { class: 'hero-tagline' }, APP_TAGLINE),
    statsRow);

  const joinCard = el('section', { class: `card join-card${invitedCode ? ' invited' : ''}` },
    el('h2', {}, invitedCode ? `You've been invited to room ${invitedCode}` : 'Join friends'),
    el('p', { class: 'muted' }, 'Have a 5-letter code from a friend?'),
    el('div', { class: 'join-row' }, codeInput, joinBtn));

  const profileCard = el('section', { class: 'card profile-card' },
    el('h2', {}, 'Your player card'),
    el('label', { for: 'name', class: 'label' }, 'Nickname'),
    nameInput,
    el('p', { class: 'label' }, 'Pick your avatar'),
    el('div', { class: 'avatar-grid' }, avatarButtons),
    errorBox);

  const createCard = el('section', { class: 'card stack' },
    invitedCode ? el('p', { class: 'muted' }, 'Or start your own room:') : el('h2', {}, 'Start a room'),
    typeRow,
    createBtn);

  // ---- Game catalog ----
  function gameCard(game, featured = false) {
    const playBtn = el('button', {
      class: 'btn play-btn', type: 'button', 'data-busy': 'true',
      'aria-label': `Play ${game.name} now`,
      onclick: () => { const profile = readProfile(); if (profile) busy(playBtn, () => onQuick(profile, game.id)); },
    }, '▶️ Play Now');
    return el('article', { class: `game-card accent-${game.accent}${featured ? ' featured' : ''}` },
      el('div', { class: 'game-card-top' },
        el('span', { class: 'game-emoji', 'aria-hidden': 'true' }, game.emoji),
        el('span', { class: 'category-pill' }, game.category)),
      el('h3', {}, game.name),
      el('p', { class: 'muted game-blurb' }, game.blurb),
      el('div', { class: 'game-meta' },
        el('span', {}, `👥 ${game.players}`),
        el('span', {}, `⏱ ${game.time}`)),
      playBtn);
  }

  const featuredSection = el('section', { class: 'games-section' },
    sectionHead('🔥 Featured games', 'The crowd favourites. Tap Play Now to start a public room.'),
    el('div', { class: 'featured-grid' },
      GAMES.filter((game) => game.featured).map((game) => gameCard(game, true))));

  let category = 'All';
  const gameGrid = el('div', { class: 'game-grid' });
  const chipButtons = CATEGORIES.map((name) => el('button', {
    type: 'button',
    class: `chip${name === category ? ' selected' : ''}`,
    'aria-pressed': name === category ? 'true' : 'false',
    onclick: (event) => {
      category = name;
      chipButtons.forEach((chip) => {
        const on = chip === event.currentTarget;
        chip.classList.toggle('selected', on);
        chip.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      paintGames();
    },
  }, name));
  function paintGames() {
    const list = category === 'All' ? GAMES : GAMES.filter((game) => game.category === category);
    gameGrid.replaceChildren(...list.map((game) => gameCard(game)));
  }
  paintGames();
  const allGamesSection = el('section', { class: 'games-section' },
    sectionHead('🎲 All games', 'Pick a category, then jump straight into a game.'),
    el('div', { class: 'category-chips', role: 'group', 'aria-label': 'Game categories' }, chipButtons),
    gameGrid);

  mount(container,
    hero,
    el('div', { class: 'home-layout' },
      el('div', { class: 'home-side' },
        invitedCode ? joinCard : profileCard,
        invitedCode ? profileCard : createCard,
        invitedCode ? createCard : joinCard,
        invitedCode ? null : publicCard),
      el('div', { class: 'home-main' }, featuredSection, allGamesSection)));
}
