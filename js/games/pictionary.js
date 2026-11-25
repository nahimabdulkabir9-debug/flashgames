// pictionary.js: one player draws a secret word, everyone else guesses.
// The drawer keeps the real word in gameSecrets (readable only by them while
// the round is live). Guessers send guesses; the drawer checks them and marks
// the round solved. The host owns phases, timers and scores.
import {
  db, ref, set, update, remove, get, onValue, serverNow, isPermissionDenied,
} from '../firebase.js';
import { el, mount, toast } from '../ui.js';
import { avatarEl } from '../avatars.js';

const WORDS = ('apple,banana,bicycle,castle,dragon,guitar,rocket,pizza,umbrella,elephant,volcano,robot,rainbow,penguin,lighthouse,'
  + 'sandwich,snowman,airplane,camera,butterfly,pyramid,tractor,bridge,candle,dinosaur,spider,hamburger,windmill,scissors,football,'
  + 'mountain,helicopter,cactus,octopus,teapot,skateboard,ladder,key,clock,whale,sunflower,tent,train,crown,ghost,giraffe,mushroom,telescope,fireworks,microscope,waterfall,astronaut,submarine,crocodile,trampoline,parachute,bulldozer,snowflake,campfire').split(',');
const COLORS = ['#111111', '#e03131', '#1c7ed6', '#2f9e44', '#f08c00', '#9c36b5'];
const DRAW_MS = 80000;
const DRAWER_GRACE_MS = 8000; // a refresh or brief blip must not skip the round
const OVER_MS = 6000;
const ROUNDS_EACH = 3; // how many times each player gets to draw
const isHard = (w) => w.length >= 7; // hard words reveal 2 letters, easy words reveal 1

const norm = (s) => String(s).toLowerCase().replace(/[^a-z]/g, '');
const shuffled = (list) => [...list].sort(() => Math.random() - 0.5);
// The drawer gets two easy words and one hard word to choose from.
const pick3 = () => shuffled([...shuffled(WORDS.filter((w) => !isHard(w))).slice(0, 2), shuffled(WORDS.filter(isHard))[0]]);

export default {
  id: 'pictionary', name: 'Pictionary', emoji: '🎨', blurb: 'Draw the word, friends guess it.', minPlayers: 2,

  create(container, session) {
    const gref = (sub = '') => ref(db, `rooms/${session.code}/game${sub}`);
    const secretRef = (round) => ref(db, `gameSecrets/${session.code}/${round}`);
    let g = null; let myWord = null; let positions = []; let shown = 0; let hintEl = null; let choices = []; let choicesRound = '';
    let drawing = null; let color = COLORS[0]; let lastPush = 0; let panelKey = ''; let acting = false; let actKey = '';
    let secret = null; let stopSecret = null; let secretKey = ''; let secretRound = -1;
    let stopGuesses = null; let guessKey = '';
    const claimed = new Set(); // guesses this drawer has already scored
    const drawerAway = { uid: '', since: 0 };

    const head = el('section', { class: 'card center' });
    const canvas = el('canvas', { class: 'pic-canvas', width: 600, height: 600 });
    canvas.style.touchAction = 'none'; // stop the page scrolling while drawing
    const ctx = canvas.getContext('2d');
    const panel = el('section', { class: 'card stack' });
    const board = el('section', { class: 'card' });
    const endBtn = el('button', {
      class: 'btn secondary', type: 'button', hidden: true,
      onclick: () => { if (confirm('End the game for everyone?')) session.endGame().catch(() => toast('Could not end the game. Try again.')); },
    }, 'End game');
    mount(container, head, el('section', { class: 'card' }, canvas), panel, board, endBtn);

    const order = () => session.playerList().map((p) => p.uid);
    const canDraw = () => g?.phase === 'draw' && g.drawer === session.uid;
    const nameOf = (uid) => session.room.players[uid]?.name || 'Player';

    // An old tab may try to write after the host has changed the rules/game.
    function noteError(label, err) {
      console.warn(label, err);
      if (isPermissionDenied(err)) toast('The game changed. Refresh the page to continue.');
    }
    function write(promise, label) {
      Promise.resolve(promise).catch((err) => noteError(label, err));
      return promise;
    }

    // ----- Canvas -----
    function redraw() {
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 600, 600);
      const strokes = { ...(g?.strokes || {}) };
      if (drawing) strokes[drawing.id] = drawing;
      ctx.lineWidth = 8; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      Object.keys(strokes).sort().forEach((id) => {
        const s = strokes[id]; const p = String(s.p).split(',').map((n) => Number(n) * 0.6);
        ctx.strokeStyle = s.c; ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.lineTo(p[0] + 0.01, p[1]);
        for (let i = 2; i < p.length; i += 2) ctx.lineTo(p[i], p[i + 1]);
        ctx.stroke();
      });
    }
    const pos = (e) => {
      const r = canvas.getBoundingClientRect();
      return [Math.round(((e.clientX - r.left) / r.width) * 1000), Math.round(((e.clientY - r.top) / r.height) * 1000)];
    };
    const push = () => {
      if (drawing) set(gref(`/strokes/${drawing.id}`), { c: drawing.c, p: drawing.p })
        .catch((err) => console.warn('Stroke sync failed', err));
    };
    canvas.addEventListener('pointerdown', (e) => {
      if (!canDraw()) return;
      canvas.setPointerCapture(e.pointerId);
      drawing = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, c: color, p: pos(e).join(',') };
      redraw(); push();
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!drawing) return;
      drawing.p += `,${pos(e).join(',')}`; redraw();
      if (Date.now() - lastPush > 90) { lastPush = Date.now(); push(); }
    });
    const endStroke = () => { if (drawing) { push(); drawing = null; } };
    canvas.addEventListener('pointerup', endStroke);
    canvas.addEventListener('pointercancel', endStroke);

    // ----- Host referee -----
    const act = (fn) => {
      if (acting) return;
      acting = true;
      Promise.resolve().then(fn).then(
        () => { acting = false; },
        (err) => {
          console.warn('Host action failed', err);
          acting = false;
        },
      );
    };
    function clearRoundFields() {
      // The host clears these atomically when a round changes. `null` values
      // are allowed by the rules so stale data never leaks into a new round.
      return {
        pick: null, strokes: null, solved: null, guesses: null, repick: null,
        len: null, hint: null, word: null,
        endsAt: null, overAt: null, voteEndsAt: null, gain: null,
      };
    }
    function newRound(r) {
      drawerAway.uid = '';
      drawerAway.since = 0;
      const ids = order();
      if (!ids.length) return;
      if (r >= g.total) return update(gref(), { ...clearRoundFields(), phase: 'final' });
      return update(gref(), {
        ...clearRoundFields(), round: r, drawer: ids[r % ids.length],
        phase: 'pick', scores: g.scores || {},
      });
    }
    function startDraw() {
      if (!g.pick) return;
      return update(gref(), {
        ...clearRoundFields(),
        phase: 'draw',
        len: g.pick.len, hint: g.pick.hint,
        endsAt: serverNow() + DRAW_MS,
      });
    }
    function backToPick() {
      return update(gref(), { ...clearRoundFields(), phase: 'pick' });
    }
    async function finishRound() {
      const scores = { ...(g.scores || {}) }; const gain = {};
      Object.entries(g.solved || {}).forEach(([uid, left]) => {
        gain[uid] = 50 + Math.round((50 * left) / DRAW_MS);
        gain[g.drawer] = (gain[g.drawer] || 0) + 25;
      });
      Object.entries(gain).forEach(([uid, pts]) => { scores[uid] = (scores[uid] || 0) + pts; });
      await update(gref(), { phase: 'over', scores, gain, overAt: serverNow() + OVER_MS });
      // Reveal the word even if the drawer has gone offline. The host may read
      // the secret now that the phase is over, and can write it to the game.
      try {
        const snap = await get(secretRef(g.round));
        if (snap.val()?.word) await update(gref(), { word: snap.val().word });
      } catch (err) {
        console.warn('Could not publish the word', err);
      }
    }
    function tick() {
      if (!g || !session.isHost) return;
      const now = serverNow(); const players = session.playerList();
      if (g.phase === 'pick') {
        const drawer = players.find((p) => p.uid === g.drawer);
        const drawerOnline = drawer && drawer.online !== false;
        if (drawerOnline) {
          drawerAway.uid = '';
          drawerAway.since = 0;
          if (g.pick) act(startDraw);
        } else if (drawerAway.uid !== g.drawer || !drawerAway.since) {
          drawerAway.uid = g.drawer;
          drawerAway.since = now;
        } else if (now - drawerAway.since >= DRAWER_GRACE_MS) {
          act(() => newRound(g.round + 1));
        }
      }
      if (g.phase === 'draw') {
        if (g.repick) act(backToPick);
        else {
          const guessers = players.filter((p) => p.uid !== g.drawer && p.online !== false);
          if (now >= g.endsAt || (guessers.length && guessers.every((p) => g.solved?.[p.uid]))) act(finishRound);
        }
      }
      if (g.phase === 'over' && now >= g.overAt) act(() => newRound(g.round + 1));
    }

    // ----- Secret word (drawer only while the round is live) -----
    function watchSecret() {
      const mine = Boolean(g && (g.phase === 'pick' || g.phase === 'draw') && g.drawer === session.uid);
      const key = mine ? `${session.code}/${g.round}` : '';
      const round = g?.round ?? -1;
      if (key === secretKey && round === secretRound) return;
      secretRound = round;
      // Keep the drawer's word through `over` as a fallback in case the host
      // cannot publish it. It is cleared when the next round starts.
      const keepWord = Boolean(g && g.phase === 'over' && g.drawer === session.uid
        && myWord && secretKey === `${session.code}/${g.round}`);
      if (stopSecret) { stopSecret(); stopSecret = null; }
      secretKey = key;
      if (!keepWord) {
        secret = null; myWord = null; positions = []; shown = 0; panelKey = '';
      }
      if (!key) return;
      stopSecret = onValue(secretRef(g.round), (snap) => {
        const s = snap.val();
        if (!s || s.round !== g?.round || s.drawer !== session.uid) {
          secret = null; myWord = null; positions = []; shown = 0; panelKey = '';
        } else {
          secret = s;
          myWord = s.word;
          positions = String(s.positions || '').split(',').filter(Boolean).map(Number);
          shown = 0; panelKey = '';
        }
        renderPanel();
      }, (err) => console.warn('Secret listener error', err));
    }

    // ----- Guess checking (drawer only) -----
    function watchGuesses() {
      const mine = Boolean(g && g.phase === 'draw' && g.drawer === session.uid);
      const key = mine ? `${session.code}/${g.round}` : '';
      if (key === guessKey) return;
      if (stopGuesses) { stopGuesses(); stopGuesses = null; }
      guessKey = key;
      if (!key) return;
      stopGuesses = onValue(gref('/guesses'), (snap) => {
        const guesses = snap.val() || {};
        Object.entries(guesses).forEach(([uid, text]) => {
          const id = `${g?.round}|${uid}`;
          if (uid === session.uid || !myWord || g.solved?.[uid] || claimed.has(id)) return;
          if (!session.room?.players?.[uid]) return; // left or kicked: rules reject the mark
          if (norm(text) !== norm(myWord)) return;
          claimed.add(id);
          set(gref(`/solved/${uid}`), Math.max(1, (g.endsAt || serverNow()) - serverNow()))
            .catch((err) => {
              if (!isPermissionDenied(err)) claimed.delete(id);
              console.warn('Could not mark guess', err);
            });
        });
      }, (err) => console.warn('Guess listener error', err));
    }

    // ----- Letter hints -----
    const maskHint = (n) => [...myWord].map((ch, i) => (positions.slice(0, n).includes(i) ? ch : '_')).join(' ');
    // The drawer's phone reveals letters as the clock runs down: one for easy words, two for hard ones.
    function revealTick() {
      if (!myWord || g?.phase !== 'draw' || g.drawer !== session.uid) return;
      const left = (g.endsAt - serverNow()) / DRAW_MS;
      const due = (positions.length > 1 ? [0.55, 0.25] : [0.45]).filter((t) => left <= t).length;
      if (due > shown) {
        shown = due;
        update(gref(), { hint: maskHint(due) }).catch((err) => console.warn('Hint sync failed', err));
      }
    }

    // ----- Player actions -----
    async function pickWord(word) {
      const nextPositions = shuffled(Array.from(word, (_, i) => i)).slice(0, isHard(word) ? 2 : 1);
      await set(secretRef(g.round), {
        drawer: session.uid, round: g.round, word, positions: nextPositions.join(','),
      });
      myWord = word; positions = nextPositions; shown = 0;
      await set(gref('/pick'), { len: word.length, hint: maskHint(0) });
    }
    let choosing = false;
    async function choose(word) {
      if (choosing) return; // ignore a double tap while the first one is still being saved
      choosing = true;
      try {
        await pickWord(word);
      } catch (err) {
        console.warn('Could not choose a word', err);
        // If the host has already started drawing, the first tap worked: no error to show.
        if (g?.phase === 'pick') toast('Could not choose that word. Try again.');
      } finally {
        choosing = false;
      }
    }
    async function guess(text) {
      const answer = text.trim().slice(0, 30);
      if (!norm(answer)) return;
      try {
        await set(gref(`/guesses/${session.uid}`), answer);
        toast('Guess sent!');
      } catch (err) {
        noteError('Guess failed', err);
      }
    }

    // ----- Screens -----
    function renderPanel() {
      const kids = [];
      hintEl = null;
      if (g.phase === 'pick') {
        if (g.drawer === session.uid) {
          const choiceKey = `${g.round}|${Boolean(g.repick)}`;
          if (choicesRound !== choiceKey) { choices = pick3(); choicesRound = choiceKey; }
          kids.push(el('h2', {}, 'Choose a word to draw'),
            ...choices.map((w) => el('button', { class: 'btn', type: 'button', onclick: () => choose(w) }, `${w} (${isHard(w) ? 'hard' : 'easy'})`)),
            g.pick ? el('p', { class: 'muted center' }, 'Word saved. You can choose again or wait for the host.') : null);
        } else kids.push(el('p', { class: 'muted center' }, `${nameOf(g.drawer)} is choosing a word…`));
      } else if (g.phase === 'draw') {
        if (g.drawer === session.uid) {
          const swatches = COLORS.map((c) => el('button', {
            class: 'swatch', type: 'button', style: `background:${c}`,
            'aria-label': `Pen colour ${c}`, 'aria-pressed': String(c === color),
            onclick: () => {
              color = c;
              swatches.forEach((b, i) => b.setAttribute('aria-pressed', String(COLORS[i] === c)));
            },
          }));
          kids.push(el('h2', {}, `Draw: ${myWord || '…'}`),
            myWord ? null : el('p', { class: 'muted center' }, 'Your word could not be restored. Use repick to choose another.'),
            el('div', { class: 'swatches', role: 'group', 'aria-label': 'Pen colours' }, swatches),
            el('button', { class: 'btn secondary', type: 'button', onclick: () => write(remove(gref('/strokes')), 'Clear failed') }, '🧹 Clear drawing'),
            el('button', {
              class: 'btn secondary', type: 'button',
              onclick: () => write(set(gref('/repick'), true), 'Repick failed'),
            }, '🔁 Can’t draw this word'));
        } else if (g.solved?.[session.uid]) {
          kids.push(el('p', { class: 'center' }, '✅ You got it! Waiting for the others…'));
        } else {
          const input = el('input', { class: 'input', type: 'text', autocomplete: 'off', placeholder: 'Type your guess', enterkeyhint: 'send' });
          const send = () => { guess(input.value); input.value = ''; input.focus(); };
          input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
          kids.push((hintEl = el('p', { class: 'center hint' }, g.hint || Array(g.len || 0).fill('_').join(' '))), input,
            el('button', { class: 'btn', type: 'button', onclick: send }, 'Guess'));
        }
      } else if (g.phase === 'over') {
        kids.push(el('h2', { class: 'center' }, `The word was “${g.word || secret?.word || myWord || '…'}”`),
          ...Object.entries(g.gain || {}).map(([uid, pts]) => el('p', { class: 'center' }, `${nameOf(uid)} +${pts}`)),
          Object.keys(g.gain || {}).length ? null : el('p', { class: 'muted center' }, 'Nobody guessed it.'));
      } else {
        const top = Object.entries(g.scores || {}).sort((a, b) => b[1] - a[1])[0];
        kids.push(el('h2', { class: 'center' }, top ? `🏆 ${nameOf(top[0])} wins!` : 'Game over'),
          session.isHost ? el('button', { class: 'btn', type: 'button', onclick: () => session.endGame().catch(() => toast('Could not return to the lobby. Try again.')) }, 'Back to lobby')
            : el('p', { class: 'muted center' }, 'Waiting for the host…'));
      }
      mount(panel, kids);
    }

    const timer = el('span', {});
    const clock = setInterval(() => {
      if (g?.phase === 'draw') timer.textContent = `⏱ ${Math.max(0, Math.ceil((g.endsAt - serverNow()) / 1000))}s`;
      else timer.textContent = '';
      tick();
      revealTick();
    }, 500);

    return {
      update(room) {
        const prev = g; g = room.game || null;
        watchSecret();
        watchGuesses();
        if (!g) {
          if (session.isHost) write(set(gref(), {
            round: 0, total: order().length * ROUNDS_EACH, drawer: order()[0],
            phase: 'pick', scores: {},
          }), 'Could not start Pictionary');
          return;
        }
        const actionKey = `${g.round}|${g.phase}|${Boolean(g.repick)}`;
        if (actKey !== actionKey) {
          actKey = actionKey;
          acting = false;
          claimed.clear();
          drawing = null; // never carry a half-drawn stroke into the next round
        }
        if (g.phase === 'over' && g.drawer === session.uid && myWord && !g.word) {
          write(update(gref(), { word: myWord }), 'Could not reveal the word');
        }
        const key = `${g.round}|${g.phase}|${Boolean(g.solved?.[session.uid])}|${g.word || ''}|${Boolean(g.pick)}|${Boolean(g.repick)}|${Boolean(secret)}|${prev === null}`;
        if (key !== panelKey) { panelKey = key; renderPanel(); }
        mount(head, el('h2', {}, `Round ${Math.min(g.round + 1, g.total)} of ${g.total} `, timer),
          el('p', { class: 'muted' }, g.phase === 'draw' ? `${nameOf(g.drawer)} is drawing` : 'Pictionary · v2'));
        mount(board, el('h2', {}, 'Scores'), el('ul', { class: 'player-list' }, session.playerList()
          .sort((a, b) => (g.scores?.[b.uid] || 0) - (g.scores?.[a.uid] || 0))
          .map((p) => el('li', { class: 'player' },
            el('span', { class: 'player-avatar', 'aria-hidden': 'true' }, avatarEl(p.avatar, 44)), el('span', { class: 'player-name' }, p.name, p.uid === g.drawer ? ' ✏️' : ''),
            el('span', { class: 'player-status ready' }, `${g.scores?.[p.uid] || 0} pts`)))));
        if (hintEl) hintEl.textContent = g.hint || Array(g.len || 0).fill('_').join(' ');
        endBtn.hidden = !(session.isHost && g.phase !== 'final');
        redraw();
      },
      destroy() {
        clearInterval(clock);
        if (stopSecret) stopSecret();
        if (stopGuesses) stopGuesses();
      },
    };
  },
};
