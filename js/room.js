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
  db, signIn, serverNow, serverTimeReady, ref, get, set, update, remove, runTransaction, onValue, onDisconnect, serverTimestamp,
  isPermissionDenied,
} from './firebase.js';

export const MAX_PLAYERS_PER_ROOM = 16;

// No I or O, so codes can't be confused with 1 and 0 when read aloud.
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

// How long the host may be offline before someone else takes over.
// Long enough that a host who just refreshes the page keeps the role.
const HOST_GRACE_MS = 6000;
// A client that crashed with no onDisconnect still stops heartbeating. Treat
// a lastSeen older than this as away, even if its online flag is stuck true.
const HOST_STALE_MS = 45000;
const PRESENCE_BEAT_MS = 15000;

/** Friendly error the screens can show directly. */
export class RoomError extends Error {}

/** A permission denial usually means the live rules are older than the app. */
function rulesFailure(message, err) {
  console.error(message, err);
  return new RoomError(`${message}. Make sure the latest Firebase rules are published, then refresh.`);
}

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
export async function createRoom(profile, { isPublic = false, gameId = '' } = {}) {
  const uid = await signIn();
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomCode();
    const metaSnap = await get(ref(db, `rooms/${code}/meta`));
    if (metaSnap.exists()) continue; // code taken, try another

    // Create the room and claim slot 1 atomically, then add our player. The
    // player write needs the claimed slot to already exist in the rules, so
    // it cannot be part of the same update.
    try {
      await update(ref(db), {
        [`rooms/${code}/meta`]: {
          hostUid: uid,
          createdAt: serverTimestamp(),
          status: 'lobby',
          public: Boolean(isPublic),
          ...(gameId ? { gameId } : {}),
        },
        [`rooms/${code}/slots/1`]: uid,
      });
    } catch (err) {
      if (!isPermissionDenied(err)) throw err;
      // A collision means someone else won this code; try another one.
      const taken = await get(ref(db, `rooms/${code}/meta`)).catch(() => null);
      if (taken?.exists() && taken.val().hostUid !== uid) continue;
      throw rulesFailure('Firebase rejected the room creation', err);
    }

    try {
      await set(ref(db, `rooms/${code}/players/${uid}`), newPlayer(profile, '1'));
      return code;
    } catch (err) {
      // Don't leave a room shell behind if the player write failed.
      await remove(ref(db, `rooms/${code}/slots/1`)).catch(() => {});
      await remove(ref(db, `rooms/${code}/meta`)).catch(() => {});
      if (isPermissionDenied(err)) throw rulesFailure('Firebase rejected your player entry', err);
      throw err;
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
      if (isPermissionDenied(err)) throw rulesFailure(`Firebase rejected joining room ${code}`, err);
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
    this.beat = null;
    this.listedKey = null;
    this.started = false;
    this.left = false;
    this.stopPresence = null;
  }

  path(sub = '') { return `rooms/${this.code}${sub ? `/${sub}` : ''}`; }
  get meRef() { return ref(db, this.path(`players/${this.uid}`)); }
  get isHost() { return this.room?.meta?.hostUid === this.uid; }

  start() {
    if (this.started) return; // a second start() must not leak a second beat
    this.started = true;
    // 1) Presence: whenever our connection comes (back) up, mark us online
    //    and tell Firebase to mark us offline if the connection drops.
    //    Write online FIRST so a failed onDisconnect registration cannot
    //    leave us permanently invisible.
    this.stopPresence = onValue(ref(db, '.info/connected'), async (snap) => {
      if (snap.val() !== true || this.left) return;
      try {
        await update(this.meRef, { online: true, lastSeen: serverTimestamp() });
        if (this.left) return;
        await onDisconnect(this.meRef).update({ online: false, lastSeen: serverTimestamp() });
        if (this.left) return;
        this.listedKey = null;
        if (this.room) this.syncPublic();
      } catch (err) {
        if (!isPermissionDenied(err) && !this.left) console.warn('Room presence update failed', err);
      }
    });
    this.unsubscribers.push(this.stopPresence);

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
    // Heartbeat: keep our own presence and public listing fresh, and re-run
    // host promotion even if the room snapshot did not change.
    this.beat = setInterval(() => {
      if (this.left) return;
      update(this.meRef, { online: true, lastSeen: serverTimestamp() }).catch(() => {});
      if (this.room) this.checkHost();
      if (this.listedKey && this.isHost) {
        update(ref(db, `publicRooms/${this.code}`), { updatedAt: serverTimestamp() }).catch(() => {});
      }
    }, PRESENCE_BEAT_MS);
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
    const stale = (p) => !p || p.online === false
      || (typeof p.lastSeen === 'number' && serverNow() - p.lastSeen > HOST_STALE_MS);
    const hostAway = stale(host);
    if (!hostAway) {
      clearTimeout(this.hostTimer);
      this.hostTimer = null;
      return;
    }
    const candidates = this.playerList().filter((p) => !stale(p) && !p.isBot);
    const nextHost = candidates[0];
    if (!nextHost || nextHost.uid !== this.uid || this.hostTimer) return;

    const wait = host ? HOST_GRACE_MS : 0; // host left on purpose: take over now
    this.hostTimer = setTimeout(async () => {
      this.hostTimer = null;
      if (this.left || !this.room) return;
      const current = this.room.players[this.room.meta.hostUid];
      if (current && !stale(current)) return; // host came back
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
      // Remove unconditionally: a refresh may have lost listedKey. This is
      // harmless when the entry does not exist.
      this.listedKey = null;
      await onDisconnect(entry).cancel().catch(() => {});
      await remove(entry).catch(() => {});
      return;
    }
    const me = players[this.uid];
    if (!me) return; // removed while a public-listing update was in flight
    const key = `${meta.gameId || ''}|${Object.keys(players).length}|${me.name}|${me.avatar}`;
    if (key === this.listedKey) return;
    try {
      await set(entry, {
        hostName: me.name,
        avatar: me.avatar,
        players: Object.keys(players).length,
        ...(meta.gameId ? { gameId: meta.gameId } : {}),
        updatedAt: serverTimestamp(),
      });
      // A failed onDisconnect registration must not disable the heartbeat.
      await onDisconnect(entry).remove().catch(() => {});
      this.listedKey = key;
    } catch (err) {
      if (!isPermissionDenied(err)) console.warn('Public room listing failed', err);
    }
  }

  /** Host only: start a game from the registry. */
  async startGame(gameId) {
    // Clear old secrets FIRST, then open the new game. Doing it in the other
    // order can delete a fresh secret written in the gap.
    await remove(ref(db, `gameSecrets/${this.code}`)).catch(() => {});
    await remove(ref(db, `liarSecrets/${this.code}`)).catch(() => {});
    await remove(ref(db, `liarAssignments/${this.code}`)).catch(() => {});
    await update(ref(db), {
      [`rooms/${this.code}/meta/gameId`]: gameId,
      [`rooms/${this.code}/meta/status`]: 'playing',
      [`rooms/${this.code}/game`]: null,
    });
  }

  /** Host only: end the game and go back to the lobby. */
  async endGame() {
    // Pictionary and Spot the Liar keep secret words outside the room node.
    // Clear everything in one atomic write so no new round can race it.
    await update(ref(db), {
      [`rooms/${this.code}/meta/status`]: 'lobby',
      [`rooms/${this.code}/meta/gameId`]: null,
      [`rooms/${this.code}/game`]: null,
      [`gameSecrets/${this.code}`]: null,
      [`liarSecrets/${this.code}`]: null,
      [`liarAssignments/${this.code}`]: null,
    });
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
      // Remove our membership BEFORE cancelling the safety net. If cancel()
      // or the removal fails, onDisconnect still has a chance to mark us
      // offline instead of leaving a ghost member with no fallback.
      const slots = Object.entries(this.room?.slots || {})
        .filter(([, uid]) => uid).map(([slot]) => slot);
      const mySlot = this.room?.players?.[this.uid]?.slot;
      const lastOne = slots.length
        ? slots.length === 1 && slots[0] === mySlot
        : this.playerList().length === 1;

      // Remove the listing while we are still the host. After the room is
      // gone nobody has permission to remove it (except stale-listing cleanup).
      if (this.isHost) await remove(ref(db, `publicRooms/${this.code}`)).catch(() => {});

      if (lastOne) {
        await remove(ref(db, this.path()));
      } else {
        const changes = {};
        if (this.isHost) {
          const candidates = this.playerList().filter((p) => p.uid !== this.uid && p.online !== false && !p.isBot);
          if (candidates[0]) changes[`${this.path()}/meta/hostUid`] = candidates[0].uid;
        }
        if (mySlot) changes[`${this.path()}/slots/${mySlot}`] = null;
        changes[`${this.path()}/players/${this.uid}`] = null;
        await update(ref(db), changes);
      }
      if (this.isHost) {
        await onDisconnect(ref(db, `publicRooms/${this.code}`)).cancel().catch(() => {});
      }
      await onDisconnect(this.meRef).cancel().catch(() => {});
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
    this.hostTimer = null;
    this.beat = null;
    this.listedKey = null;
    this.unsubscribers.forEach((unsubscribe) => { try { unsubscribe(); } catch { /* already stopped */ } });
    this.unsubscribers = [];
    this.stopPresence = null;
    this.started = false;
  }
}

// ---------- Public rooms ----------
const FRESH_MS = 90000; // hide listings whose host has not refreshed them for 90 s
const STALE_MS = 120000; // rules allow anyone to delete listings this old
let timeReady = false;
serverTimeReady.then(() => { timeReady = true; });

function allPublicRooms(value) {
  return Object.entries(value || {}).map(([code, r]) => ({ code, ...r }));
}
function isFresh(room) {
  return !timeReady || serverNow() - (room.updatedAt || 0) < FRESH_MS;
}
function pruneStale(rooms) {
  if (!timeReady) return; // a wrong phone clock must never delete live rooms
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
  let last = [];
  return onValue(ref(db, 'publicRooms'), (snap) => {
    last = freshRooms(snap.val());
    callback(last);
  }, (err) => {
    console.warn('Public room list lost connection', err);
    callback(last); // keep the last good list instead of flashing "No rooms"
  });
}

/** Join a random open public room, or start a new public one if none is open. */
export async function quickPlay(profile, gameId = '') {
  await signIn();
  // A game chosen from the homepage gets its own public room so everyone
  // who joins is playing the same game. app.js starts it when enough arrive.
  if (gameId) return createRoom(profile, { isPublic: true, gameId });
  const open = openRooms(allPublicRooms((await get(ref(db, 'publicRooms'))).val()));
  while (open.length) {
    const [pick] = open.splice(Math.floor(Math.random() * open.length), 1);
    try { return await joinRoom(pick.code, profile); } catch { /* try the next one */ }
  }
  return createRoom(profile, { isPublic: true });
}
