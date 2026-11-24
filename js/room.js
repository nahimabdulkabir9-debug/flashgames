// =============================================================
// room.js — everything about rooms in the database.
//
//   createRoom()  makes a new room with a 5-letter code, you as host.
//   joinRoom()    adds you to an existing room (or rejoins after refresh).
//   RoomSession   keeps you connected to one room: live updates,
//                 online/offline presence, ready status, kicking,
//                 leaving, and automatic host promotion.
//
// How a room is stored in Firebase:
//   rooms/ABCDE/meta            { hostUid, createdAt, status, gameId, settings }
//   rooms/ABCDE/slots/1..16     <uid>  (one claimed slot per player; caps the room)
//   rooms/ABCDE/players/<uid>   { name, avatar, joinedAt, slot, ready, online, lastSeen }
//   rooms/ABCDE/kicked/<uid>    true   (kicked players can't come back)
// =============================================================

import {
  db, signIn, serverNow, ref, get, set, update, remove, runTransaction, onValue, onDisconnect, serverTimestamp,
  isPermissionDenied,
} from './firebase.js';

export const MAX_PLAYERS_PER_ROOM = 16;

// No I or O, so codes can't be confused with 1 and 0 when read aloud.
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

// How long the host may be offline before someone else takes over.
// Long enough that a host who just refreshes the page keeps the role.
const HOST_GRACE_MS = 6000;

/** Friendly error the screens can show directly. */
export class RoomError extends Error {}

export function normalizeCode(raw) {
  return String(raw || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 5);
}
export function isValidCode(code) {
  return /^[A-Z]{5}$/.test(code);
}

function randomCode() {
  // Rejection sampling keeps every letter equally likely (256 is not a
  // multiple of 24, so a plain modulo would favour the first few letters).
  const letters = [];
  while (letters.length < 5) {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    for (const byte of bytes) {
      if (byte < 240) letters.push(CODE_LETTERS[byte % CODE_LETTERS.length]);
      if (letters.length === 5) break;
    }
  }
  return letters.join('');
}

/** The link friends open to join this room, e.g. .../flashgames/?room=ABCDE */
export function roomLink(code) {
  return `${location.origin}${location.pathname}?room=${code}`;
}

/** Create a room and return its code. */
export async function createRoom(profile, { isPublic = false } = {}) {
  const uid = await signIn();
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomCode();
    const metaSnap = await get(ref(db, `rooms/${code}/meta`));
    if (metaSnap.exists()) continue; // code taken, try another

    // One multi-path update writes the room and our player entry together:
    // either both succeed or neither does.
    try {
      await update(ref(db), {
        [`rooms/${code}/meta`]: {
          hostUid: uid,
          createdAt: serverTimestamp(),
          status: 'lobby',
          public: Boolean(isPublic),
        },
        [`rooms/${code}/slots/1`]: uid,
        [`rooms/${code}/players/${uid}`]: newPlayer(profile, '1'),
      });
      return code;
    } catch (err) {
      // Someone else grabbed the same code between our read and write.
      // The rules refuse the overwrite, so try another code.
      if (!isPermissionDenied(err)) throw err;
    }
  }
  throw new RoomError('Could not find a free room code. Please try again.');
}

function newPlayer(profile, slot) {
  return {
    name: profile.name,
    avatar: profile.avatar,
    joinedAt: serverTimestamp(),
    slot: String(slot),
    ready: false,
    online: true,
  };
}

/**
 * Join a room by code. If you were already in it (for example you
 * refreshed the page), you simply rejoin with your old spot and score.
 */
export async function joinRoom(code, profile) {
  const uid = await signIn();
  if (!isValidCode(code)) throw new RoomError('Room codes are 5 letters.');

  const metaSnap = await get(ref(db, `rooms/${code}/meta`));
  if (!metaSnap.exists()) throw new RoomError(`Room ${code} doesn't exist. Check the code?`);

  const kickedSnap = await get(ref(db, `rooms/${code}/kicked/${uid}`));
  if (kickedSnap.exists()) throw new RoomError('The host removed you from this room.');

  const meRef = ref(db, `rooms/${code}/players/${uid}`);
  // We can only read the player list once we are a member, so we try to
  // read our own entry: if it exists, we are rejoining.
  const mine = await get(meRef);
  if (mine.exists()) {
    await update(meRef, { name: profile.name, avatar: profile.avatar, online: true });
    return code;
  }

  // Claim a slot first. There are only 16 slots, so the cap is enforced by
  // the database rather than by a race-prone count. A transaction makes two
  // people picking the same free slot safe.
  const slotsSnap = await get(ref(db, `rooms/${code}/slots`));
  const slots = slotsSnap.val() || {};
  const freeSlots = Array.from({ length: MAX_PLAYERS_PER_ROOM }, (_, i) => String(i + 1))
    .filter((slot) => !slots[slot]);

  for (const slot of freeSlots) {
    let claimed;
    try {
      claimed = await runTransaction(ref(db, `rooms/${code}/slots/${slot}`), (current) => current || uid);
    } catch (err) {
      if (isPermissionDenied(err)) break;
      throw err;
    }
    // Another player won this slot; try the next one.
    if (claimed.snapshot.val() !== uid) continue;

    try {
      await set(meRef, newPlayer(profile, slot));
      return code;
    } catch (err) {
      // Don't leave a slot reserved by a player who never got in.
      await remove(ref(db, `rooms/${code}/slots/${slot}`)).catch(() => {});
      if (isPermissionDenied(err)) break;
      throw err;
    }
  }
  throw new RoomError(`Room ${code} is full (${MAX_PLAYERS_PER_ROOM} players max) or no longer open.`);
}

/**
 * Am I still a member of this room? Used to rejoin after a refresh.
 * Returns false (instead of throwing) when the room is gone.
 */
export async function stillInRoom(code) {
  const uid = await signIn();
  try {
    const snap = await get(ref(db, `rooms/${code}/players/${uid}`));
    return snap.exists();
  } catch (err) {
    // "No permission" means we are not a member (kicked or room gone).
    // A network failure is different: the caller should keep the room and
    // try to rejoin optimistically instead of clearing lastRoom.
    if (isPermissionDenied(err)) return false;
    throw err;
  }
}

/**
 * A live connection to one room.
 *
 *   const session = new RoomSession(code, uid, {
 *     onUpdate(room) { ...redraw the screen... },
 *     onRemoved(reason) { ...go back home... },
 *   });
 *   session.start();
 */
export class RoomSession {
  constructor(code, uid, { onUpdate, onRemoved }) {
    this.code = code;
    this.uid = uid;
    this.onUpdate = onUpdate;
    this.onRemoved = onRemoved;
    this.room = null;           // latest { meta, players, kicked }
    this.unsubscribers = [];
    this.hostTimer = null;
    this.left = false;
  }

  path(sub = '') { return `rooms/${this.code}${sub ? `/${sub}` : ''}`; }
  get meRef() { return ref(db, this.path(`players/${this.uid}`)); }
  get isHost() { return this.room?.meta?.hostUid === this.uid; }

  start() {
    // 1) Presence: whenever our connection comes (back) up, mark us online
    //    and tell Firebase to mark us offline if the connection drops.
    const stopPresence = onValue(ref(db, '.info/connected'), async (snap) => {
      if (snap.val() !== true || this.left) return;
      try {
        await onDisconnect(this.meRef).update({ online: false, lastSeen: serverTimestamp() });
        await update(this.meRef, { online: true });
        this.listedKey = null;
        if (this.room) this.syncPublic();
      } catch { /* removed from room; the room listener handles it */ }
    });
    this.unsubscribers.push(stopPresence);

    // 2) Listen to the whole room and redraw on every change.
    const stopRoom = onValue(ref(db, this.path()), (snap) => {
      const room = snap.val();
      if (!room || !room.meta) return this.handleRemoved('This room has closed.');
      if (!room.players || !room.players[this.uid]) {
        return this.handleRemoved(
          room.kicked && room.kicked[this.uid] ? 'The host removed you from the room.' : 'You left the room.',
        );
      }
      room.players = room.players || {};
      this.room = room;
      this.checkHost();
      this.syncPublic();
      this.onUpdate(room);
    }, async (err) => {
      // A network wobble is not a removal. Keep the session alive and let
      // Firebase reconnect; only an explicit permission denial means we
      // are no longer a member.
      if (!isPermissionDenied(err)) {
        console.warn('Room listener lost connection', err);
        return;
      }
      let kicked = false;
      try { kicked = (await get(ref(db, this.path(`kicked/${this.uid}`)))).exists(); } catch { /* room gone */ }
      this.handleRemoved(kicked ? 'The host removed you from the room.' : 'You are no longer in this room.');
    });
    this.unsubscribers.push(stopRoom);
    // Keep our public listing fresh while we are the host.
    this.beat = setInterval(() => {
      if (this.listedKey && this.isHost) update(ref(db, `publicRooms/${this.code}`), { updatedAt: serverTimestamp() }).catch(() => {});
    }, 30000);
  }

  /** Players sorted by when they joined, as [{ uid, ...data }]. */
  playerList() {
    return Object.entries(this.room?.players || {})
      .map(([uid, p]) => ({ uid, ...p }))
      .sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));
  }

  // ---------- Host promotion ----------
  // There is no server to pick a new host, so every phone runs the same
  // rule: "if the host has been offline for a few seconds, the
  // longest-waiting online human becomes host". Only that one phone
  // acts, and the database rules double-check it is allowed.
  checkHost() {
    const { meta, players } = this.room;
    const host = players[meta.hostUid];
    const hostAway = !host || host.online === false;
    if (!hostAway) {
      clearTimeout(this.hostTimer);
      this.hostTimer = null;
      return;
    }
    const nextHost = this.playerList().find((p) => p.online !== false && !p.isBot);
    if (!nextHost || nextHost.uid !== this.uid || this.hostTimer) return;

    const wait = host ? HOST_GRACE_MS : 0; // host left on purpose: take over now
    this.hostTimer = setTimeout(async () => {
      this.hostTimer = null;
      if (this.left || !this.room) return;
      const current = this.room.players[this.room.meta.hostUid];
      if (current && current.online !== false) return; // host came back
      try {
        await set(ref(db, this.path('meta/hostUid')), this.uid);
      } catch (err) {
        console.warn('Host takeover refused', err);
      }
    }, wait);
  }

  // ---------- Public listing ----------
  // The host keeps rooms/publicRooms/<CODE> up to date while the room is
  // public and still in the lobby. It disappears when the host disconnects.
  async syncPublic() {
    if (!this.isHost || this.left) return;
    const { meta, players } = this.room;
    const entry = ref(db, `publicRooms/${this.code}`);
    if (!(meta.public === true && meta.status === 'lobby')) {
      if (this.listedKey) { this.listedKey = null; await remove(entry).catch(() => {}); }
      return;
    }
    const me = players[this.uid];
    if (!me) return; // removed while a public-listing update was in flight
    const key = `${Object.keys(players).length}|${me.name}|${me.avatar}`;
    if (key === this.listedKey) return;
    this.listedKey = key;
    try {
      await set(entry, { hostName: me.name, avatar: me.avatar, players: Object.keys(players).length, updatedAt: serverTimestamp() });
      await onDisconnect(entry).remove();
    } catch { this.listedKey = null; }
  }

  /** Host only: start a game from the registry. */
  async startGame(gameId) {
    await update(ref(db, this.path('meta')), { gameId, status: 'playing' });
    // A previous game may have left secret words behind.
    await remove(ref(db, `gameSecrets/${this.code}`)).catch(() => {});
  }

  /** Host only: end the game and go back to the lobby. */
  async endGame() {
    await update(ref(db, this.path()), { 'meta/status': 'lobby', 'meta/gameId': null, game: null });
    // Pictionary keeps the drawer's word outside the room node so guessers
    // cannot read it. Clear it when the game ends.
    await remove(ref(db, `gameSecrets/${this.code}`)).catch(() => {});
  }

  /** Host only: make the room public or private. */
  setPublic(value) {
    return update(ref(db, this.path('meta')), { public: Boolean(value) });
  }

  // ---------- Actions ----------
  setReady(ready) {
    return update(this.meRef, { ready: Boolean(ready) });
  }

  /** Host only: remove a player and stop them rejoining. */
  async kick(uid) {
    if (!this.isHost || uid === this.uid) return;
    const slot = this.room?.players?.[uid]?.slot;
    await update(ref(db), {
      [`${this.path()}/kicked/${uid}`]: true,
      [`${this.path()}/players/${uid}`]: null,
      ...(slot ? { [`${this.path()}/slots/${slot}`]: null } : {}),
    });
  }

  /** Leave the room for good. If we are host, hand it to the next player first. */
  async leave() {
    this.left = true;
    try {
      if (this.isHost) await remove(ref(db, `publicRooms/${this.code}`)).catch(() => {});
      await onDisconnect(this.meRef).cancel();

      const slots = Object.keys(this.room?.slots || {});
      const mySlot = this.room?.players?.[this.uid]?.slot;
      const lastOne = slots.length
        ? slots.length === 1 && slots[0] === mySlot
        : this.playerList().length === 1;

      if (lastOne) {
        // Last player out: close the room instead of leaving an empty
        // shell behind. The rules check that no other slot is claimed.
        await remove(ref(db, this.path()));
      } else {
        const changes = {};
        if (this.isHost) {
          const next = this.playerList().find((p) => p.uid !== this.uid && p.online !== false && !p.isBot);
          if (next) changes[`${this.path()}/meta/hostUid`] = next.uid;
        }
        if (mySlot) changes[`${this.path()}/slots/${mySlot}`] = null;
        changes[`${this.path()}/players/${this.uid}`] = null;
        await update(ref(db), changes);
      }
    } catch (err) {
      console.warn('Leave failed', err);
    }
    this.stop();
  }

  handleRemoved(reason) {
    if (this.left) return;
    this.left = true;
    this.stop();
    this.onRemoved(reason);
  }

  stop() {
    clearTimeout(this.hostTimer);
    clearInterval(this.beat);
    this.unsubscribers.forEach((unsubscribe) => unsubscribe());
    this.unsubscribers = [];
  }
}

// ---------- Public rooms ----------
const FRESH_MS = 90000; // hide listings whose host has not refreshed them for 90 s
const STALE_MS = 120000; // rules allow anyone to delete listings this old

function allPublicRooms(value) {
  return Object.entries(value || {}).map(([code, r]) => ({ code, ...r }));
}
function isFresh(room) {
  return serverNow() - (room.updatedAt || 0) < FRESH_MS;
}
function pruneStale(rooms) {
  rooms
    .filter((r) => serverNow() - (r.updatedAt || 0) >= STALE_MS)
    .forEach((r) => remove(ref(db, `publicRooms/${r.code}`)).catch(() => {}));
}
function openRooms(rooms) {
  return rooms
    .filter((r) => isFresh(r) && r.players < MAX_PLAYERS_PER_ROOM)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}
function freshRooms(value) {
  const all = allPublicRooms(value);
  pruneStale(all);
  return openRooms(all);
}

/** Live list of open public rooms. Returns a function that stops listening. */
export function watchPublicRooms(callback) {
  return onValue(ref(db, 'publicRooms'), (snap) => callback(freshRooms(snap.val())), () => callback([]));
}

/** Join a random open public room, or start a new public one if none is open. */
export async function quickPlay(profile) {
  await signIn();
  const open = freshRooms((await get(ref(db, 'publicRooms'))).val());
  while (open.length) {
    const [pick] = open.splice(Math.floor(Math.random() * open.length), 1);
    try { return await joinRoom(pick.code, profile); } catch { /* try the next one */ }
  }
  return createRoom(profile, { isPublic: true });
}
