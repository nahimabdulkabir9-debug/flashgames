// =============================================================
// home.js — the first screen: nickname, avatar, create or join.
//
// It doesn't talk to Firebase itself. When the player taps a button
// it calls onCreate(profile) or onJoin(code, profile), which app.js
// provides, so this file only deals with the form.
// =============================================================

import { APP_TAGLINE } from './config.js';
import { el, mount } from './ui.js';
import { checkNickname, NAME_MAX } from './filter.js';
import { normalizeCode, isValidCode, MAX_PLAYERS_PER_ROOM } from './room.js';
import { load, save } from './storage.js';
import { AVATAR_IDS, avatarEl } from './avatars.js';

export const AVATARS = AVATAR_IDS;
const OLD_EMOJI_AVATARS = [
  '😎', '🦁', '🐼', '🐘', '🦅', '🦊', '🐙', '🦜',
  '🚀', '🍕', '🍔', '🌮', '🍩', '🍉', '🍍', '🌽',
  '⚽', '🎧', '🎤', '🥁', '👑', '🔥', '⚡', '🎮',
];

/**
 * Draw the home screen.
 * @param container   where to draw
 * @param invitedCode a room code from a ?room= link, or ''
 * @param onCreate    async (profile) => {}
 * @param onJoin      async (code, profile) => {}
 */
export function renderHome(container, { invitedCode = '', onCreate, onJoin, onQuick, watchPublic }) {
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

  // Disable the buttons while we talk to Firebase, so double taps don't
  // create two rooms.
  async function busy(button, task) {
    errorBox.textContent = '';
    const all = [createBtn, joinBtn, quickBtn];
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
    class: 'btn', type: 'button',
    onclick: () => {
      const profile = readProfile();
      if (profile) busy(createBtn, () => onCreate(profile, { isPublic }));
    },
  }, '🎉 Create a room');

  const joinBtn = el('button', {
    class: 'btn warm', type: 'button',
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
    class: 'btn secondary', type: 'button',
    onclick: () => { const profile = readProfile(); if (profile) busy(quickBtn, () => onQuick(profile)); },
  }, '⚡ Quick play');
  const publicList = el('ul', { class: 'player-list' }, el('li', { class: 'muted' }, 'Looking for rooms…'));
  const publicCard = el('section', { class: 'card stack' }, el('h2', {}, '🌍 Public rooms'), publicList, quickBtn);
  // The invited view hides the public list, so don't leave a listener running
  // just to update a card that is not on screen.
  if (watchPublic && !invitedCode) {
    watchPublic((rooms) => {
      publicList.replaceChildren(...(rooms.length ? rooms.map((r) => el('li', { class: 'player' },
        el('span', { class: 'player-avatar', 'aria-hidden': 'true' }, avatarEl(r.avatar, 44)),
        el('span', { class: 'player-name' }, `${r.hostName}'s room`),
        el('span', { class: 'player-status' }, `${r.players}/${MAX_PLAYERS_PER_ROOM}`),
        el('button', {
          class: 'btn join-mini', type: 'button',
          onclick: () => { const p = readProfile(); if (p) busy(quickBtn, () => onJoin(r.code, p)); },
        }, 'Join')))
        : [el('li', { class: 'muted' }, 'No public rooms right now. Create one!')]));
    });
  }

  const joinCard = el('section', { class: `card${invitedCode ? ' invited' : ''}` },
    el('h2', {}, invitedCode ? `You've been invited to room ${invitedCode}` : 'Join friends'),
    el('div', { class: 'join-row' }, codeInput, joinBtn));

  const profileCard = el('section', { class: 'card' },
    el('label', { for: 'name', class: 'label' }, 'Your nickname'),
    nameInput,
    el('p', { class: 'label' }, 'Pick your avatar'),
    el('div', { class: 'avatar-grid' }, avatarButtons),
    errorBox);

  mount(container,
    invitedCode ? null : el('section', { class: 'card hero' },
      el('h1', {}, 'Let’s play! 🎮'),
      el('p', { class: 'muted' }, APP_TAGLINE)),
    profileCard,
    // When invited, show Join first so the friend can't miss it.
    invitedCode ? joinCard : el('section', { class: 'card stack' }, typeRow, createBtn),
    invitedCode ? el('section', { class: 'card' }, el('p', { class: 'muted' }, 'Or start your own:'), createBtn) : joinCard,
    invitedCode ? null : publicCard,
  );
}
