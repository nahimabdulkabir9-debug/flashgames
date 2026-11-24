// Rules regression tests. These need the Firebase Emulator running:
//   firebase emulators:start --project demo-flashgames
//   npm install          (first time only; the app itself has no build step)
//   npm run test:rules
import test, { before, after, beforeEach } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  initializeTestEnvironment, assertFails, assertSucceeds,
} from '@firebase/rules-unit-testing';
import { ref, set, get, update, remove, serverTimestamp } from 'firebase/database';

const ROOM = 'ABCDE';
const HOST = 'host-uid';
const DRAWER = 'drawer-uid';
const GUEST = 'guest-uid';
const rules = readFileSync(new URL('../firebase/database.rules.json', import.meta.url), 'utf8');

let env;

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-flashgames',
    database: { rules, host: '127.0.0.1', port: 9000 },
  });
});

after(async () => { await env?.cleanup(); });
beforeEach(async () => { await env.clearDatabase(); });

const dbAs = (uid) => env.authenticatedContext(uid).database();

async function seed({ players = [HOST, DRAWER, GUEST], phase = 'pick', game = {} } = {}) {
  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.database();
    const now = Date.now();
    await set(ref(db, `rooms/${ROOM}/meta`), {
      hostUid: HOST, createdAt: now, status: 'playing', public: false,
    });
    for (const [i, uid] of players.entries()) {
      const slot = String(i + 1);
      await set(ref(db, `rooms/${ROOM}/players/${uid}`), {
        name: `Player ${i + 1}`, avatar: '🙂', joinedAt: now + i, slot, ready: false, online: true,
      });
      await set(ref(db, `rooms/${ROOM}/slots/${slot}`), uid);
    }
    await set(ref(db, `rooms/${ROOM}/game`), {
      round: 0, total: 6, drawer: DRAWER, phase, scores: {}, ...game,
    });
  });
}

test('a player can create a public room', async () => {
  const code = 'ZZZZZ';
  const db = dbAs(HOST);
  await assertSucceeds(update(ref(db), {
    [`rooms/${code}/meta`]: { hostUid: HOST, createdAt: serverTimestamp(), status: 'lobby', public: true },
    [`rooms/${code}/slots/1`]: HOST,
  }));
  await assertSucceeds(set(ref(db, `rooms/${code}/players/${HOST}`), {
    name: 'Host User', avatar: '🙂', joinedAt: serverTimestamp(), slot: '1', ready: false, online: true,
  }));
  await assertSucceeds(set(ref(db, `publicRooms/${code}`), {
    hostName: 'Host User', avatar: '🙂', players: 1,
    gameId: 'pictionary', updatedAt: serverTimestamp(),
  }));
});

test('a player can create a private room', async () => {
  const code = 'YYYYY';
  const db = dbAs(HOST);
  await assertSucceeds(update(ref(db), {
    [`rooms/${code}/meta`]: { hostUid: HOST, createdAt: serverTimestamp(), status: 'lobby', public: false },
    [`rooms/${code}/slots/1`]: HOST,
  }));
  await assertSucceeds(set(ref(db, `rooms/${code}/players/${HOST}`), {
    name: 'Host User', avatar: '🙂', joinedAt: serverTimestamp(), slot: '1', ready: false, online: true,
  }));
});

test('visitors can record one daily visit under their own uid', async () => {
  const hostDb = dbAs(HOST);
  await assertSucceeds(set(ref(hostDb, `siteVisits/2026-11-24/${HOST}`), serverTimestamp()));
  await assertSucceeds(set(ref(hostDb, `siteVisits/2026-11-25/${HOST}`), serverTimestamp()));
  await assertFails(set(ref(hostDb, `siteVisits/2026-11-24/${GUEST}`), serverTimestamp()));
  await assertFails(set(ref(hostDb, `siteVisits/1124/${HOST}`), serverTimestamp()));
  await assertFails(get(ref(hostDb, `siteVisits/2026-11-24`)));
});

test('visitors own their online tab and daily play records', async () => {
  const db = dbAs(HOST);
  await assertSucceeds(set(ref(db, `onlineUsers/${HOST}/tabs/tab-1`), { connectedAt: serverTimestamp() }));
  await assertSucceeds(remove(ref(db, `onlineUsers/${HOST}/tabs/tab-1`)));
  await assertFails(set(ref(db, `onlineUsers/${GUEST}/tabs/tab-2`), { connectedAt: serverTimestamp() }));
  await assertSucceeds(get(ref(db, 'onlineUsers')));

  await assertSucceeds(set(ref(db, `dailyPlayers/2026-11-24/${HOST}`), {
    lastGame: 'pictionary', at: serverTimestamp(),
  }));
  await assertFails(set(ref(db, `dailyPlayers/2026-11-24/${GUEST}`), {
    lastGame: 'pictionary', at: serverTimestamp(),
  }));
  await assertFails(set(ref(db, `dailyPlayers/1124/${HOST}`), {
    lastGame: 'pictionary', at: serverTimestamp(),
  }));
  await assertSucceeds(get(ref(db, 'dailyPlayers/2026-11-24')));
});

test('only room members can read a room', async () => {
  await seed();
  await assertSucceeds(get(ref(dbAs(HOST), `rooms/${ROOM}`)));
  await assertFails(get(ref(dbAs('stranger-uid'), `rooms/${ROOM}`)));
});

test('game phases and scores are host-only', async () => {
  await seed();
  await assertFails(set(ref(dbAs(GUEST), `rooms/${ROOM}/game/phase`), 'final'));
  await assertFails(update(ref(dbAs(GUEST), `rooms/${ROOM}/game`), { [`scores/${GUEST}`]: 999 }));
  await assertSucceeds(set(ref(dbAs(HOST), `rooms/${ROOM}/game/phase`), 'draw'));
});

test('only the drawer can publish a pick', async () => {
  await seed();
  const pick = { hash: 'abc', len: 5, hint: '_____' };
  await assertSucceeds(set(ref(dbAs(DRAWER), `rooms/${ROOM}/game/pick`), pick));
  await assertFails(set(ref(dbAs(GUEST), `rooms/${ROOM}/game/pick`), pick));
});

test('the drawer controls hints, strokes, repick and the revealed word', async () => {
  await seed({ phase: 'draw', game: { endsAt: Date.now() + 60000 } });
  await assertSucceeds(set(ref(dbAs(DRAWER), `rooms/${ROOM}/game/hint`), 'A _ _'));
  await assertFails(set(ref(dbAs(GUEST), `rooms/${ROOM}/game/hint`), 'cheating'));
  await assertSucceeds(set(ref(dbAs(DRAWER), `rooms/${ROOM}/game/strokes/s1`), { c: '#111111', p: '100,200' }));
  await assertFails(set(ref(dbAs(GUEST), `rooms/${ROOM}/game/strokes/s2`), { c: '#111111', p: '100,200' }));
  await assertSucceeds(set(ref(dbAs(DRAWER), `rooms/${ROOM}/game/repick`), true));
  await assertFails(set(ref(dbAs(GUEST), `rooms/${ROOM}/game/repick`), true));

  await env.withSecurityRulesDisabled(async (context) => {
    await set(ref(context.database(), `rooms/${ROOM}/game/phase`), 'over');
  });
  await assertSucceeds(set(ref(dbAs(DRAWER), `rooms/${ROOM}/game/word`), 'apple'));
  await assertFails(set(ref(dbAs(GUEST), `rooms/${ROOM}/game/word`), 'banana'));
});

test('the host can clear every per-round field', async () => {
  await seed({
    phase: 'draw',
    game: {
      endsAt: Date.now() + 60000,
      pick: { hash: 'abc', len: 5, hint: '_____' },
      strokes: { s1: { c: '#111111', p: '1,2' } },
      solved: { [GUEST]: 1234 },
      guesses: { [GUEST]: 'apple' },
      repick: true,
      hint: 'A _ _',
      word: 'apple',
    },
  });
  await assertSucceeds(update(ref(dbAs(HOST), `rooms/${ROOM}/game`), {
    pick: null, strokes: null, solved: null, guesses: null, repick: null,
    hint: null, word: null, hash: null, len: null, endsAt: null,
  }));
});

test('the host can hand the room to another online player', async () => {
  await seed({ players: [HOST, GUEST] });
  await assertSucceeds(set(ref(dbAs(HOST), `rooms/${ROOM}/meta/hostUid`), GUEST));
  await assertFails(set(ref(dbAs(GUEST), `rooms/${ROOM}/meta/hostUid`), DRAWER));
});

test('players own answers and stop requests; the drawer owns solved marks', async () => {
  await seed();
  const guestDb = dbAs(GUEST);
  await assertSucceeds(set(ref(guestDb, `rooms/${ROOM}/game/answers/${GUEST}`), {
    name: 'Ada', place: 'Abuja', animal: 'Ant', thing: 'Apple',
  }));
  await assertSucceeds(set(ref(guestDb, `rooms/${ROOM}/game/stopRequests/${GUEST}`), true));
  await assertFails(set(ref(guestDb, `rooms/${ROOM}/game/solved/${GUEST}`), 1234));
  await assertSucceeds(set(ref(dbAs(DRAWER), `rooms/${ROOM}/game/solved/${GUEST}`), 1234));
});

test('the secret word is drawer-only until the round is over', async () => {
  await seed();
  const secret = { drawer: DRAWER, round: 0, word: 'apple', positions: '0' };
  await assertSucceeds(set(ref(dbAs(DRAWER), `gameSecrets/${ROOM}/0`), secret));
  await assertSucceeds(get(ref(dbAs(DRAWER), `gameSecrets/${ROOM}/0`)));
  await assertFails(get(ref(dbAs(GUEST), `gameSecrets/${ROOM}/0`)));

  await env.withSecurityRulesDisabled(async (context) => {
    await update(ref(context.database(), `rooms/${ROOM}/game`), { phase: 'over' });
  });
  await assertSucceeds(get(ref(dbAs(GUEST), `gameSecrets/${ROOM}/0`)));
  await assertSucceeds(remove(ref(dbAs(HOST), `gameSecrets/${ROOM}`)));
});

test('a free slot can be claimed and released by its owner', async () => {
  await seed({ players: [HOST] });
  await assertSucceeds(set(ref(dbAs(GUEST), `rooms/${ROOM}/slots/2`), GUEST));
  await assertFails(set(ref(dbAs(DRAWER), `rooms/${ROOM}/slots/2`), DRAWER));
  await assertSucceeds(remove(ref(dbAs(GUEST), `rooms/${ROOM}/slots/2`)));
});

test('rooms cap player joins at 16', async () => {
  const players = [HOST, ...Array.from({ length: 15 }, (_, i) => `p-${i}`)];
  await seed({ players });
  await assertFails(set(ref(dbAs('extra-uid'), `rooms/${ROOM}/slots/17`), 'extra-uid'));
  await assertFails(set(ref(dbAs('extra-uid'), `rooms/${ROOM}/players/extra-uid`), {
    name: 'Extra User', avatar: '🙂', joinedAt: Date.now(), slot: '1', ready: false, online: true,
  }));
});

test('only the last member can close a room', async () => {
  await seed({ players: [HOST] });
  await assertSucceeds(remove(ref(dbAs(HOST), `rooms/${ROOM}`)));

  await seed({ players: [HOST, GUEST] });
  await assertFails(remove(ref(dbAs(HOST), `rooms/${ROOM}`)));
});

test('stale public listings can be pruned by any signed-in player', async () => {
  const listing = { hostName: 'Host', avatar: '🙂', players: 2, updatedAt: Date.now() - 130000 };
  await env.withSecurityRulesDisabled(async (context) => {
    await set(ref(context.database(), `publicRooms/${ROOM}`), listing);
  });
  await assertSucceeds(remove(ref(dbAs('stranger-uid'), `publicRooms/${ROOM}`)));

  await env.withSecurityRulesDisabled(async (context) => {
    await set(ref(context.database(), `publicRooms/${ROOM}`), { ...listing, updatedAt: Date.now() });
  });
  await assertFails(remove(ref(dbAs('stranger-uid'), `publicRooms/${ROOM}`)));
});
