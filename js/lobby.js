// =============================================================
// lobby.js — the waiting room before a game starts.
//
// Shows the room code with copy/WhatsApp/share buttons, the live
// player list (avatar, name, host crown, ready, offline), a Ready
// button for players, and host controls (kick, start).
// renderLobby() is called again every time the room changes.
// =============================================================

import { APP_NAME } from './config.js';
import { el, mount, toast, showModal, copyText } from './ui.js';
import { GAMES } from './games/registry.js';
import { roomLink, MAX_PLAYERS_PER_ROOM } from './room.js';

/**
 * @param container where to draw
 * @param session   the RoomSession (see room.js)
 * @param onLeave   called when the player taps "Leave room"
 */
export function renderLobby(container, session, { onLeave }) {
  const players = session.playerList();
  const me = session.room.players[session.uid];
  const hostUid = session.room.meta.hostUid;
  const link = roomLink(session.code);
  const isPublic = session.room.meta.public === true;

  // ---- Room code + sharing ----
  const shareText = `Join my ${APP_NAME} room! Code: ${session.code}\n${link}`;
  const shareButtons = [
    el('button', {
      class: 'btn secondary', type: 'button',
      onclick: async () => toast((await copyText(link)) ? 'Link copied ✅' : 'Could not copy, sorry'),
    }, '🔗 Copy link'),
    el('a', {
      class: 'btn whatsapp',
      href: `https://wa.me/?text=${encodeURIComponent(shareText)}`,
      target: '_blank', rel: 'noopener',
    }, '💬 WhatsApp'),
  ];
  // The phone's own share sheet, where supported (most Android browsers).
  if (navigator.share) {
    shareButtons.push(el('button', {
      class: 'btn secondary', type: 'button',
      onclick: () => navigator.share({ title: APP_NAME, text: shareText, url: link }).catch(() => {}),
    }, '📤 Share'));
  }

  const codeCard = el('section', { class: 'card room-code-card' },
    el('p', { class: 'label' }, 'Room code'),
    el('p', { class: 'room-code', 'aria-label': `Room code ${session.code.split('').join(' ')}` }, session.code),
    el('div', { class: 'share-row' }, shareButtons),
    el('p', { class: 'muted center' }, isPublic ? '🌍 Public: anyone can find this room' : '🔒 Private: code or link only'),
    session.isHost ? el('button', {
      class: 'btn secondary', type: 'button',
      onclick: () => session.setPublic(!isPublic).catch(() => toast('Could not change the room type')),
    }, isPublic ? 'Make private' : 'Make public') : null);

  // ---- Player list ----
  const rows = players.map((p) => {
    const isMe = p.uid === session.uid;
    const isHost = p.uid === hostUid;
    const offline = p.online === false;
    const ready = isHost || p.ready;
    return el('li', { class: `player${offline ? ' offline' : ''}` },
      el('span', { class: 'player-avatar', 'aria-hidden': 'true' }, p.avatar || '🙂'),
      el('span', { class: 'player-name' },
        el('span', {}, p.name), // textContent: safe even if the name contains <tags>
        isMe ? el('span', { class: 'tag' }, 'you') : null,
        isHost ? el('span', { class: 'tag host' }, '👑 host') : null),
      el('span', { class: `player-status${ready ? ' ready' : ''}` },
        offline ? '📡 reconnecting' : ready ? '✅ ready' : '⏳ not ready'),
      session.isHost && !isMe ? el('button', {
        class: 'kick-btn', type: 'button', 'aria-label': `Remove ${p.name}`,
        onclick: () => confirmKick(session, p),
      }, '✕') : null);
  });

  const playersCard = el('section', { class: 'card' },
    el('h2', {}, `Players (${players.length}/${MAX_PLAYERS_PER_ROOM})`),
    el('ul', { class: 'player-list' }, rows));

  // ---- Bottom controls ----
  const controls = el('section', { class: 'card stack' });
  if (session.isHost) {
    const waitingFor = players.filter((p) => p.uid !== hostUid && !p.ready && p.online !== false);
    controls.append(
      el('p', { class: 'muted center' }, waitingFor.length
        ? `Waiting for ${waitingFor.length} player(s) to get ready…`
        : 'Everyone is ready!'),
      el('button', {
        class: 'btn', type: 'button',
        onclick: () => chooseGame(session, players.length),
      }, '▶️ Start game'),
    );
  } else {
    controls.append(
      el('p', { class: 'muted center' }, 'The host will start the game when everyone is ready.'),
      el('button', {
        class: `btn${me.ready ? ' secondary' : ''}`, type: 'button',
        onclick: () => session.setReady(!me.ready),
      }, me.ready ? '✋ Not ready yet' : "✅ I'm ready"),
    );
  }
  controls.append(el('button', { class: 'btn secondary', type: 'button', onclick: onLeave }, '🚪 Leave room'));

  mount(container, codeCard, playersCard, controls);
}

function confirmKick(session, player) {
  showModal({
    title: `Remove ${player.name}?`,
    body: [el('p', {}, "They won't be able to rejoin this room.")],
    actions: [
      { label: 'Remove', style: 'danger', onClick: () => session.kick(player.uid).catch(() => toast('Could not remove player')) },
      { label: 'Cancel', style: 'secondary' },
    ],
  });
}

// The host picks a game from the registry; everyone's screen switches (see app.js).
function chooseGame(session, playerCount) {
  showModal({
    title: 'Choose a game',
    body: [el('p', { class: 'muted' }, 'Everyone in the room joins in.')],
    actions: [
      ...GAMES.map((game) => ({
        label: `${game.emoji} ${game.name}`,
        onClick: () => (playerCount < game.minPlayers
          ? toast(`${game.name} needs at least ${game.minPlayers} players`)
          : session.startGame(game.id).catch(() => toast('Could not start the game'))),
      })),
      { label: 'Cancel', style: 'secondary' },
    ],
  });
}
