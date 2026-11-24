// spot-the-liar.js: one secret word, one hidden liar.
// The host runs the phase clock. The word lives in liarSecrets and the liar's
// identity lives in liarAssignments, so nobody can read either before reveal
// unless they are allowed to see that particular piece.
import {
  db, ref, set, update, get, onValue, serverNow, isPermissionDenied,
} from '../firebase.js';
import { el, mount, toast } from '../ui.js';
import { avatarEl } from '../avatars.js';
import {
  CATEGORY_NAMES, randomPair, randomWord, wordsFor,
} from './spot-the-liar-data.js';
import {
  CLUE_MS, DISCUSS_MS, VOTE_MS, GUESS_MS, REVEAL_MS, OVER_MS, MAX_ROUNDS,
  tallyVotes, scoreRound, applyScore,
} from './spot-the-liar-rules.js';

const shuffled = (list) => [...list].sort(() => Math.random() - 0.5);
const SETUP_MS = 30000; // stops an away host from freezing the room in setup
const PHASE_LABELS = {
  setup: 'Choosing the word',
  clue: 'One-word clues',
  discuss: 'Discussion',
  vote: 'Vote for the liar',
  reveal: 'Reveal',
  over: 'Scoreboard',
  final: 'Final scores',
};

export default {
  id: 'spot-the-liar',
  name: 'Spot the Liar',
  emoji: '🕵️',
  blurb: 'One secret word, one hidden liar. Catch them.',
  minPlayers: 3,
  maxPlayers: 12,

  create(container, session) {
    const gref = (sub = '') => ref(db, `rooms/${session.code}/game${sub}`);
    const secretRef = (round) => ref(db, `liarSecrets/${session.code}/${round}`);
    const assignmentRef = (round, uid) =>
      ref(db, `liarAssignments/${session.code}/${round}${uid ? `/${uid}` : ''}`);

    let g = null;
    let secret = null;
    let stopSecret = null;
    let secretKey = '';
    let stopAssignment = null;
    let assignmentKey = '';
    let panelKey = '';
    let actKey = '';
    let acting = false;
    let myLiar = false;
    let hostLiar = '';
    let pendingLiar = ''; // set locally until the assignment listener reports back
    let hostCategory = CATEGORY_NAMES[0];
    let hostWord = wordsFor(hostCategory)[0];
    let hostChoiceRound = -1;
    let clueInput = null;
    let guessInput = null;

    const head = el('section', { class: 'card center' });
    const panel = el('section', { class: 'card stack' });
    const board = el('section', { class: 'card' });
    const timer = el('span', {});
    const endBtn = el('button', {
      class: 'btn secondary', type: 'button', hidden: true,
      onclick: () => { if (confirm('End the game for everyone?')) session.endGame().catch(() => toast('Could not end the game. Try again.')); },
    }, 'End game');
    mount(container, head, panel, board, endBtn);

    const players = () => session.playerList();
    const nameOf = (uid) => session.room?.players?.[uid]?.name || 'Player';
    const avatarOf = (uid) => session.room?.players?.[uid]?.avatar || '🙂';
    const isRevealed = (phase) => ['reveal', 'over', 'final'].includes(phase);

    // The liar is hidden until reveal. Hosts can read the assignment subtree;
    // everyone else only knows their own true/false status.
    const liarOf = () => session.isHost
      ? (pendingLiar || hostLiar || (isRevealed(g?.phase) ? g?.liar || '' : ''))
      : (isRevealed(g?.phase) ? g?.liar || '' : '');
    const amILiar = () => Boolean(
      myLiar
      || (session.isHost && pendingLiar === session.uid)
      || (isRevealed(g?.phase) && g?.liar === session.uid),
    );

    function noteError(label, err) {
      console.warn(label, err);
      if (isPermissionDenied(err)) toast('The game changed. Refresh the page.');
    }
    function write(promise, label) {
      Promise.resolve(promise).catch((err) => noteError(label, err));
      return promise;
    }
    // Host actions are driven by a 250 ms clock. Reset on success too, so a
    // second turn in the same phase (another clue, another guess) is not lost.
    function act(fn) {
      if (acting) return;
      acting = true;
      Promise.resolve().then(fn).then(
        () => { acting = false; },
        (err) => {
          console.warn('Host action failed', err);
          acting = false;
        },
      );
    }

    function ensureHostChoice() {
      if (!session.isHost || !g || g.phase !== 'setup' || hostChoiceRound === g.round) return;
      const pair = randomPair();
      hostCategory = pair.category;
      hostWord = pair.word;
      hostChoiceRound = g.round;
    }

    function activeIds() {
      const online = players().filter((p) => p.online !== false);
      return (online.length >= 3 ? online : players()).map((p) => p.uid);
    }
    function makeOrders(ids) {
      const clueOrder = {};
      ids.forEach((uid, i) => { clueOrder[i] = uid; });
      return {
        total: Math.min(ids.length, MAX_ROUNDS),
        liar: shuffled(ids)[0],
        clueOrder,
      };
    }

    // ----- Host referee -----
    async function initGame() {
      const ids = activeIds();
      if (ids.length < 3) return;
      const { total, liar, clueOrder } = makeOrders(ids);
      pendingLiar = liar;
      await set(assignmentRef(0), { [liar]: true });
      await set(gref(), {
        round: 0, total, phase: 'setup', liar: null, clueOrder, scores: {},
        setupEndsAt: serverNow() + SETUP_MS,
      });
    }

    function clearRoundFields() {
      // `null` is allowed by the rules, so no clue or vote can leak into the
      // next round. Keep scores and the clue order.
      return {
        liar: null, category: null, caught: null, guessCorrect: null,
        clues: null, liarVotes: null, liarGuess: null,
        clueIndex: null, currentCluer: null,
        endsAt: null, guessEndsAt: null, overAt: null, gain: null,
        setupEndsAt: null,
      };
    }

    async function newRound(r) {
      const ids = activeIds();
      if (ids.length < 3) return Promise.resolve();
      if (r >= (g.total || MAX_ROUNDS)) {
        return update(gref(), { ...clearRoundFields(), phase: 'final' });
      }
      // Rebuild both orders from the players still in the room. Otherwise an
      // exit leaves stale clue givers and a liar who is no longer present.
      const { total, liar, clueOrder } = makeOrders(ids);
      pendingLiar = liar;
      await set(assignmentRef(r), { [liar]: true });
      return update(gref(), {
        ...clearRoundFields(), round: r, total, liar: null, phase: 'setup',
        clueOrder, scores: g.scores || {}, setupEndsAt: serverNow() + SETUP_MS,
      });
    }

    async function startRound(category, word) {
      const chosenCategory = category || hostCategory;
      const chosenWord = word || hostWord;
      hostCategory = chosenCategory;
      hostWord = chosenWord;
      hostChoiceRound = g.round;
      // No liar uid here: everyone can read this word, but only non-liars may
      // subscribe before the guess window ends.
      await set(secretRef(g.round), {
        round: g.round, category: chosenCategory, word: chosenWord,
      });
      await update(gref(), {
        ...clearRoundFields(),
        phase: 'clue',
        category: chosenCategory,
        clueIndex: 0,
        currentCluer: g.clueOrder?.[0] || players()[0]?.uid || '',
        endsAt: serverNow() + CLUE_MS,
      });
    }

    function advanceClue() {
      const index = Number(g.clueIndex || 0) + 1;
      const order = g.clueOrder || {};
      if (index >= Object.keys(order).length) {
        return update(gref(), {
          phase: 'discuss', endsAt: serverNow() + DISCUSS_MS,
          clueIndex: null, currentCluer: null,
        });
      }
      return update(gref(), {
        clueIndex: index, currentCluer: order[String(index)] || '',
        endsAt: serverNow() + CLUE_MS,
      });
    }

    function startVote() {
      return update(gref(), {
        phase: 'vote', endsAt: serverNow() + VOTE_MS,
        clueIndex: null, currentCluer: null, liarVotes: null,
      });
    }

    function revealLiar() {
      const liar = liarOf();
      const { caught } = tallyVotes(g.liarVotes || {}, liar);
      return update(gref(), {
        phase: 'reveal', liar, caught, liarGuess: null, guessCorrect: null,
        endsAt: null, guessEndsAt: serverNow() + (caught ? GUESS_MS : REVEAL_MS),
        overAt: null, gain: null,
      });
    }

    async function finishReveal() {
      let word = '';
      try {
        const snap = await get(secretRef(g.round));
        word = snap.val()?.word || '';
      } catch (err) {
        console.warn('Could not read the revealed word', err);
      }
      const liar = g.liar || liarOf();
      const result = scoreRound({
        liar, votes: g.liarVotes || {}, word,
        guess: g.liarGuess || '', caught: g.caught === true,
      });
      return update(gref(), {
        phase: 'over',
        scores: applyScore(g.scores || {}, result.gain),
        gain: result.gain,
        guessCorrect: result.guessCorrect,
        overAt: serverNow() + OVER_MS,
      });
    }

    function tick() {
      if (!g || !session.isHost) return;
      const now = serverNow();
      if (g.phase === 'setup') {
        if (typeof g.setupEndsAt !== 'number') {
          act(() => update(gref(), { setupEndsAt: now + SETUP_MS }));
        } else if (now >= g.setupEndsAt) {
          ensureHostChoice();
          act(() => startRound(hostCategory, hostWord));
        }
      }
      if (g.phase === 'clue') {
        const current = g.currentCluer;
        const online = players().find((p) => p.uid === current)?.online !== false;
        if (!current || !online || g.clues?.[current] || now >= g.endsAt) act(advanceClue);
      }
      if (g.phase === 'discuss' && now >= g.endsAt) act(startVote);
      if (g.phase === 'vote') {
        // The liar is not expected to vote themselves out. An offline liar
        // must not hold the round until the full timer expires.
        const voters = players().filter((p) => p.online !== false && p.uid !== liarOf());
        if (now >= g.endsAt || (voters.length && voters.every((p) => g.liarVotes?.[p.uid]))) act(revealLiar);
      }
      if (g.phase === 'reveal') {
        if (now >= g.guessEndsAt || (g.caught && g.liarGuess)) act(finishReveal);
      }
      if (g.phase === 'over' && now >= g.overAt) act(() => newRound(g.round + 1));
    }

    const clock = setInterval(() => {
      const until = g?.phase === 'reveal' ? g.guessEndsAt
        : g?.phase === 'over' ? g.overAt : g?.endsAt;
      timer.textContent = until ? `⏱ ${Math.max(0, Math.ceil((until - serverNow()) / 1000))}s` : '';
      tick();
    }, 250);

    // ----- Hidden liar assignment -----
    function watchAssignment() {
      const key = g ? `${session.code}/${g.round}` : '';
      if (key === assignmentKey) return;
      if (stopAssignment) { stopAssignment(); stopAssignment = null; }
      assignmentKey = key;
      myLiar = false;
      hostLiar = '';
      panelKey = '';
      if (!key) return;
      stopAssignment = onValue(
        session.isHost ? assignmentRef(g.round) : assignmentRef(g.round, session.uid),
        (snap) => {
          if (session.isHost) {
            const values = snap.val() || {};
            hostLiar = Object.keys(values).find((uid) => values[uid] === true) || '';
            myLiar = hostLiar === session.uid;
          } else {
            myLiar = snap.val() === true;
          }
          panelKey = '';
          renderPanel();
        },
        (err) => console.warn('Liar assignment listener error', err),
      );
    }

    // ----- Secret word -----
    function watchSecret() {
      const live = Boolean(g && g.phase);
      const allowed = live && (!amILiar() || isRevealed(g.phase));
      const key = allowed ? `${session.code}/${g.round}` : '';
      if (key === secretKey) return;
      if (stopSecret) { stopSecret(); stopSecret = null; }
      secretKey = key;
      secret = null;
      panelKey = '';
      if (!key) return;
      stopSecret = onValue(secretRef(g.round), (snap) => {
        const s = snap.val();
        secret = s && s.round === g?.round ? s : null;
        if (session.isHost && g?.phase === 'setup' && !amILiar() && secret) {
          hostCategory = secret.category || hostCategory;
          hostWord = secret.word || hostWord;
          hostChoiceRound = g.round;
        }
        panelKey = '';
        renderPanel();
      }, (err) => console.warn('Secret listener error', err));
    }

    // ----- Screens -----
    function infoLine() {
      const category = g.category || secret?.category || '…';
      if (amILiar() && !isRevealed(g.phase)) {
        return el('p', { class: 'secret-word liar-only' },
          `Category: ${category} · You are the liar 🕵️`,
          el('span', { class: 'muted' }, ' Give a clue that fits the category without giving away a word.'));
      }
      const word = secret?.word || '';
      return el('p', { class: 'secret-word' },
        `Category: ${category} · Word: `, el('strong', {}, word || '…'));
    }

    function clueList() {
      const entries = Object.entries(g.clues || {});
      if (!entries.length) return el('p', { class: 'muted center' }, 'No clues yet.');
      return el('div', { class: 'clue-list' }, entries.map(([uid, text]) =>
        el('div', { class: 'clue-row' },
          el('span', { class: 'clue-name' }, avatarEl(avatarOf(uid), 24), ' ', nameOf(uid)),
          el('strong', { class: 'clue-word' }, text))));
    }

    function buildSetup() {
      const kids = [el('h2', {}, 'Choose the secret word')];
      if (!session.isHost) {
        kids.push(infoLine(), el('p', { class: 'muted center' }, 'The host is picking the category and word on their phone…'));
        mount(panel, kids);
        return;
      }
      ensureHostChoice();
      // If the host is the liar, pick a word silently. They already know the
      // category (every liar does) but must not see the word on their screen.
      const hostIsLiar = amILiar();
      const catOptions = CATEGORY_NAMES.map((name) => {
        const option = el('option', { value: name }, name);
        if (name === hostCategory) option.selected = true;
        return option;
      });
      const categorySelect = el('select', {
        class: 'input', 'aria-label': 'Category',
        onchange: () => {
          hostCategory = categorySelect.value;
          hostWord = randomWord(hostCategory);
          renderPanel();
        },
      }, ...catOptions);
      kids.push(el('label', { class: 'label' }, 'Category'), categorySelect);

      if (hostIsLiar) {
        kids.push(el('p', { class: 'muted center' },
          'You are the liar this round. A word has been picked, but it stays hidden from you.'),
          el('button', {
            class: 'btn secondary', type: 'button',
            onclick: () => { hostWord = randomWord(hostCategory); toast('Secret word shuffled.'); },
          }, '🔀 Shuffle hidden word'));
      } else {
        const wordOptions = wordsFor(hostCategory).map((word) => {
          const option = el('option', { value: word }, word);
          if (word === hostWord) option.selected = true;
          return option;
        });
        const wordSelect = el('select', {
          class: 'input', 'aria-label': 'Secret word',
          onchange: () => { hostWord = wordSelect.value; },
        }, ...wordOptions);
        kids.push(el('label', { class: 'label' }, 'Secret word'), wordSelect,
          el('button', {
            class: 'btn secondary', type: 'button',
            onclick: () => { hostWord = randomWord(hostCategory); renderPanel(); },
          }, '🎲 Surprise me'));
      }

      const startBtn = el('button', {
        class: 'btn', type: 'button',
        onclick: async () => {
          startBtn.disabled = true;
          startBtn.textContent = 'Starting…';
          try {
            await startRound(hostCategory, hostWord);
          } catch (err) {
            noteError('Could not start the round', err);
            toast('Could not start the round. Try again.');
            startBtn.disabled = false;
            startBtn.textContent = '▶️ Start the round';
          }
        },
      }, '▶️ Start the round');
      kids.push(startBtn);
      mount(panel, kids);
    }

    function buildClue() {
      const kids = [infoLine(), clueList()];
      const current = g.currentCluer;
      if (current === session.uid) {
        clueInput = el('input', {
          class: 'input', type: 'text', maxlength: 20, autocomplete: 'off',
          placeholder: 'One word only', 'aria-label': 'Your one-word clue', enterkeyhint: 'send',
        });
        let sending = false;
        const send = () => {
          if (sending) return;
          const clue = clueInput.value.trim();
          if (!clue || /\s/.test(clue)) return toast('Give one word only.');
          sending = true;
          clueInput.disabled = true;
          write(set(gref(`/clues/${session.uid}`), clue.slice(0, 20)).catch((err) => {
            sending = false;
            if (clueInput) clueInput.disabled = false;
            throw err;
          }), 'Could not send the clue');
        };
        clueInput.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') send();
        });
        kids.push(el('h2', { class: 'center' }, 'Your turn — give one word'), clueInput,
          el('button', { class: 'btn', type: 'button', onclick: send }, 'Send clue'));
      } else {
        kids.push(el('p', { class: 'muted center' },
          current ? `${nameOf(current)} is giving a clue…` : 'Getting the first player…'));
      }
      mount(panel, kids);
    }

    function buildDiscuss() {
      mount(panel, el('h2', {}, 'Talk it through'), infoLine(), clueList(),
        el('p', { class: 'muted center' }, 'You have 40 seconds. The vote opens when the timer ends.'));
    }

    function buildVote() {
      const kids = [infoLine(), clueList(), el('h2', {}, 'Who do you think is the liar?')];
      const picked = g.liarVotes?.[session.uid]?.pick;
      if (picked) {
        kids.push(el('p', { class: 'muted center' }, `Vote sent for ${nameOf(picked)}. Waiting for the others…`));
      } else {
        kids.push(el('div', { class: 'vote-grid' }, players()
          .filter((p) => p.uid !== session.uid)
          .map((p) => el('button', {
            class: 'btn vote-tile', type: 'button',
            onclick: () => write(
              set(gref(`/liarVotes/${session.uid}`), { pick: p.uid }),
              'Could not save your vote',
            ),
          }, avatarEl(p.avatar, 28), el('span', {}, p.name)))));
      }
      mount(panel, kids);
    }

    function buildReveal() {
      const hiding = amILiar() && g.caught && !g.liarGuess && g.phase === 'reveal';
      const kids = [
        el('h2', { class: 'center' }, `The liar was ${nameOf(g.liar || liarOf())}`),
        el('p', { class: 'reveal-word' }, 'The word was ',
          el('strong', {}, hiding ? 'hidden until you guess' : secret?.word || '…')),
      ];
      if (g.caught) {
        if (amILiar() && !g.liarGuess) {
          guessInput = el('input', {
            class: 'input', type: 'text', maxlength: 30, autocomplete: 'off',
            placeholder: 'Guess the word', 'aria-label': 'Guess the secret word', enterkeyhint: 'send',
          });
          let sending = false;
          const send = () => {
            if (sending) return;
            const guess = guessInput.value.trim();
            if (!guess) return;
            sending = true;
            guessInput.disabled = true;
            write(set(gref('/liarGuess'), guess.slice(0, 30)).catch((err) => {
              sending = false;
              if (guessInput) guessInput.disabled = false;
              throw err;
            }), 'Could not send your guess');
          };
          guessInput.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') send();
          });
          kids.push(el('p', {}, 'Caught! You have 15 seconds to guess the word.'), guessInput,
            el('button', { class: 'btn', type: 'button', onclick: send }, 'Send guess'));
        } else {
          kids.push(el('p', { class: 'muted center' }, g.liarGuess
            ? `${nameOf(g.liar || liarOf())} guessed “${g.liarGuess}”.`
            : `${nameOf(g.liar || liarOf())} has 15 seconds to guess the word…`));
        }
      } else {
        kids.push(el('p', { class: 'muted center' }, 'The liar got away with +200 points.'));
      }
      mount(panel, kids);
    }

    function buildOver() {
      const kids = [
        el('h2', { class: 'center' }, 'Round over'),
        el('p', { class: 'muted center' }, `The liar was ${nameOf(g.liar || liarOf())} · Word: ${secret?.word || '…'}`),
        ...Object.entries(g.gain || {}).map(([uid, pts]) =>
          el('p', { class: 'center' }, `${nameOf(uid)} +${pts}`)),
        el('p', { class: 'muted center' }, 'Next round starting…'),
      ];
      mount(panel, kids);
    }

    function buildFinal() {
      const top = Object.entries(g.scores || {}).sort((a, b) => b[1] - a[1])[0];
      mount(panel, el('h2', { class: 'center' }, top ? `🏆 ${nameOf(top[0])} wins!` : 'Game over'),
        el('p', { class: 'muted center' }, 'Thanks for playing Spot the Liar.'),
        session.isHost
          ? el('button', { class: 'btn', type: 'button', onclick: () => session.endGame().catch(() => toast('Could not return to the lobby. Try again.')) }, 'Back to lobby')
          : el('p', { class: 'muted center' }, 'Waiting for the host…'));
    }

    function renderPanel() {
      if (!g) {
        mount(panel, el('p', { class: 'muted center' }, 'Starting Spot the Liar…'));
        return;
      }
      clueInput = null;
      guessInput = null;
      if (g.phase === 'setup') buildSetup();
      else if (g.phase === 'clue') buildClue();
      else if (g.phase === 'discuss') buildDiscuss();
      else if (g.phase === 'vote') buildVote();
      else if (g.phase === 'reveal') buildReveal();
      else if (g.phase === 'over') buildOver();
      else buildFinal();
    }

    function renderBoard() {
      mount(board, el('h2', {}, 'Scores'), el('ul', { class: 'player-list' }, players()
        .sort((a, b) => (g.scores?.[b.uid] || 0) - (g.scores?.[a.uid] || 0))
        .map((p) => el('li', { class: 'player' },
          el('span', { class: 'player-avatar', 'aria-hidden': 'true' }, avatarEl(p.avatar, 44)),
          el('span', { class: 'player-name' }, p.name),
          el('span', { class: 'player-status ready' }, `${g.scores?.[p.uid] || 0} pts`)))));
    }

    return {
      update(room) {
        g = room.game || null;
        watchAssignment();
        watchSecret();
        if (!g) {
          if (session.isHost) write(initGame(), 'Could not start Spot the Liar');
          if (!panel.firstChild) mount(panel, el('p', { class: 'muted center' }, 'Starting Spot the Liar…'));
          return;
        }
        if (actKey !== `${g.round}|${g.phase}`) { actKey = `${g.round}|${g.phase}`; acting = false; }
        ensureHostChoice();

        const key = [
          g.round, g.total, g.phase, g.liar, hostLiar, myLiar, g.category, g.clueIndex,
          g.currentCluer, Object.keys(g.clues || {}).length,
          Object.keys(g.liarVotes || {}).length, g.liarVotes?.[session.uid]?.pick || '',
          g.caught, Boolean(g.liarGuess), g.guessCorrect, Boolean(secret?.word), Boolean(g.gain),
        ].join('|');
        if (key !== panelKey) { panelKey = key; renderPanel(); }

        mount(head, el('h2', {}, `Round ${Math.min(g.round + 1, g.total)} of ${g.total} `, timer),
          el('p', { class: 'muted' }, PHASE_LABELS[g.phase] || 'Spot the Liar'));
        renderBoard();
        endBtn.hidden = !(session.isHost && g.phase !== 'final');
      },
      destroy() {
        clearInterval(clock);
        if (stopSecret) stopSecret();
        if (stopAssignment) stopAssignment();
      },
    };
  },
};
