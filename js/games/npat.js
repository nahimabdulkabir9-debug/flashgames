// npat.js: Name, Place, Animal, Thing. A letter appears and everyone writes one answer for each
// category that starts with it. A unique answer scores 10, an answer someone else also wrote scores 5.
// Players own their answers/checks/votes/stop requests; the host owns phases, timers and scores.
import { db, ref, set, update, serverNow, isPermissionDenied } from '../firebase.js';
import { el, mount, toast } from '../ui.js';
import { avatarEl } from '../avatars.js';
import { answerApproved } from './npat-rules.js';

const CATS = [['name', 'Name'], ['place', 'Place'], ['animal', 'Animal'], ['thing', 'Thing']];
const ROUNDS = 5;
const ROUND_MS = 60000;
const GRACE_MS = 2000; // short delay after the last player taps Stop
const OVER_MS = 14000;
const VOTE_MS = 30000; // time to check each other's answers
const LETTERS = 'ABCDEFGHIJKLMNOPRSTW'.split('');
const clean = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z ]/g, '').trim();
const CHECK_TIMEOUT_MS = 4000;
const cache = new Map();
async function getJson(url) {
  const stop = new AbortController(); const timer = setTimeout(() => stop.abort(), CHECK_TIMEOUT_MS);
  try { const res = await fetch(url, { signal: stop.signal }); return res.ok ? await res.json() : null; } catch { return null; } finally { clearTimeout(timer); }
}
// Is this a real answer? First the Free Dictionary API (dictionaryapi.dev), then Wikipedia's search
// (names, places and more). If neither can be reached, the answer is simply left for the players to vote on.
async function isRealAnswer(text) {
  const word = clean(text);
  if (cache.has(word)) return cache.get(word);
  let ok = false;
  if (!word.includes(' ')) ok = Boolean(await getJson(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`));
  if (!ok) {
    const data = await getJson(`https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(text.trim())}&limit=5&namespace=0&format=json&origin=*`);
    ok = Boolean(data?.[1]?.some((title) => clean(title) === word));
  }
  cache.set(word, ok);
  return ok;
}
const shuffled = (list) => [...list].sort(() => Math.random() - 0.5);

export default {
  id: 'npat', name: 'Name, Place, Animal, Thing', emoji: '✍️', blurb: 'Think fast: one answer per category.', minPlayers: 1,

  create(container, session) {
    const gref = (sub = '') => ref(db, `rooms/${session.code}/game${sub}`);
    let myVotes = {}; let votedDone = false; let checksSig = '';
    let g = null; let inputs = {}; let submitted = false; let stopBtn = null; let panelKey = ''; let acting = false; let actKey = '';
    const letterFor = (upper = true) => {
      const letter = String(g?.letters?.[g?.round] || 'A').toUpperCase();
      return upper ? letter : letter.toLowerCase();
    };

    const head = el('section', { class: 'card center' });
    const panel = el('section', { class: 'card stack' });
    const board = el('section', { class: 'card' });
    const timer = el('span', {});
    const endBtn = el('button', {
      class: 'btn secondary', type: 'button', hidden: true,
      onclick: () => { if (confirm('End the game for everyone?')) session.endGame().catch(() => toast('Could not end the game. Try again.')); },
    }, 'End game');
    mount(container, head, panel, board, endBtn);

    function write(promise, label) {
      Promise.resolve(promise).catch((err) => {
        console.warn(label, err);
        if (isPermissionDenied(err)) toast('The game changed. Refresh the page.');
      });
      return promise;
    }

    // ----- Playing -----
    async function submit() {
      if (submitted || !inputs.name) return;
      submitted = true;
      const answers = {};
      CATS.forEach(([key]) => { answers[key] = inputs[key].value.trim().slice(0, 30); inputs[key].disabled = true; });
      if (stopBtn) { stopBtn.disabled = true; stopBtn.textContent = 'Waiting for the others…'; }
      write(set(gref(`/answers/${session.uid}`), answers).catch((err) => {
        // A failed write must be retryable, not a permanent disabled screen.
        submitted = false;
        Object.values(inputs).forEach((input) => { input.disabled = false; });
        if (stopBtn) { stopBtn.disabled = false; stopBtn.textContent = '✋ Stop! I’m done'; }
        throw err;
      }), 'Could not save answers');
    }
    async function stop() {
      if (submitted || !inputs.name) return;
      await submit();
      if (stopBtn) stopBtn.textContent = 'Stop requested — waiting for everyone…';
      // One player cannot end the round for everyone. The host ends it once
      // every online player has stopped (or the timer runs out).
      write(set(gref(`/stopRequests/${session.uid}`), true), 'Stop request failed');
    }
    function buildPlay() {
      inputs = {};
      const saved = g.answers?.[session.uid];
      submitted = Boolean(saved);
      const letter = letterFor();
      const fields = CATS.map(([key, label], index) => {
        inputs[key] = el('input', {
          class: 'input', type: 'text', maxlength: 30, autocomplete: 'off', 'aria-label': label,
          placeholder: `${label} starting with ${letter}`, enterkeyhint: 'next',
          value: saved?.[key] || '',
        });
        inputs[key].addEventListener('keydown', (event) => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          const next = CATS[index + 1]?.[0];
          if (next) inputs[next].focus(); else stopBtn?.click();
        });
        inputs[key].disabled = submitted;
        return el('div', {}, el('label', { class: 'label' }, label), inputs[key]);
      });
      stopBtn = el('button', { class: 'btn warm', type: 'button', onclick: stop }, '✋ Stop! I’m done');
      if (submitted || g.stopRequests?.[session.uid]) {
        stopBtn.disabled = true;
        stopBtn.textContent = 'Stop requested — waiting for everyone…';
      }
      mount(panel, fields, stopBtn);
    }

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
    function scoreRound() {
      const letter = letterFor(false); const answers = g.answers || {};
      const pts = {}; const gain = {};
      CATS.forEach(([key]) => {
        const valid = {};
        Object.keys(answers).forEach((uid) => {
          const a = clean(answers[uid]?.[key]);
          if (a.length >= 2 && a.startsWith(letter)
            && answerApproved({ check: g.checks?.[uid]?.[key], votes: g.votes, ownerUid: uid, key })) valid[uid] = a;
        });
        const counts = {};
        Object.values(valid).forEach((a) => { counts[a] = (counts[a] || 0) + 1; });
        Object.entries(valid).forEach(([uid, a]) => {
          const p = counts[a] === 1 ? 10 : 5;
          (pts[uid] = pts[uid] || {})[key] = p; gain[uid] = (gain[uid] || 0) + p;
        });
      });
      const scores = { ...(g.scores || {}) };
      Object.entries(gain).forEach(([uid, p]) => { scores[uid] = (scores[uid] || 0) + p; });
      update(gref(), { phase: 'over', scores, gain, pts, overAt: serverNow() + OVER_MS });
    }
    function beginStop() {
      const stopper = Object.keys(g.stopRequests || {})[0];
      if (!stopper || g.stoppedBy) return;
      update(gref(), { endsAt: Math.min(g.endsAt, serverNow() + GRACE_MS), stoppedBy: stopper });
    }
    function endPlay() {
      const stopper = Object.keys(g.stopRequests || {})[0] || g.stoppedBy || null;
      return update(gref(), { phase: 'vote', voteEndsAt: serverNow() + VOTE_MS, stoppedBy: stopper });
    }
    function next(r) {
      if (r >= g.total) return update(gref(), { phase: 'final' });
      return update(gref(), {
        round: r, phase: 'play', answers: null, pts: null, gain: null, stoppedBy: null,
        votes: null, voted: null, checks: null, stopRequests: null,
        voteEndsAt: null, endsAt: serverNow() + ROUND_MS,
      });
    }
    function tick() {
      if (!g || !session.isHost) return;
      const now = serverNow();
      if (g.phase === 'play') {
        const online = session.playerList().filter((p) => p.online !== false);
        if (!g.stoppedBy && online.length && online.every((p) => g.stopRequests?.[p.uid])) act(beginStop);
        if (now >= g.endsAt + 1500 || (online.length && g.answers && online.every((p) => g.answers[p.uid]))) act(endPlay);
      }
      if (g.phase === 'vote') {
        const online = session.playerList().filter((p) => p.online !== false);
        if (now >= g.voteEndsAt || (online.length && online.every((p) => g.checks?.[p.uid]) && online.every((p) => g.voted?.[p.uid]))) act(scoreRound);
      }
      if (g.phase === 'over' && now >= g.overAt) act(() => next(g.round + 1));
    }
    const clock = setInterval(() => {
      const until = g?.phase === 'play' ? g.endsAt : g?.phase === 'vote' ? g.voteEndsAt : null;
      timer.textContent = until ? `⏱ ${Math.max(0, Math.ceil((until - serverNow()) / 1000))}s` : '';
      if (g?.phase === 'play' && serverNow() >= g.endsAt - 900) submit();
      tick();
    }, 200);

    // ----- Screens -----
    const nameOf = (uid) => session.room.players[uid]?.name || 'Player';
    // Each player's phone looks up their own answers (dictionary, then Wikipedia) and shares the result.
    async function runChecks() {
      const letter = letterFor(false); const mine = g.answers?.[session.uid] || {}; const out = { done: 1 };
      await Promise.all(CATS.map(async ([key]) => {
        const c = clean(mine[key]);
        if (c.length >= 2 && c.startsWith(letter)) out[key] = (await isRealAnswer(mine[key])) ? 1 : 0;
      }));
      write(set(gref(`/checks/${session.uid}`), out), 'Could not save checks');
    }

    // Voting: answers the dictionary could not confirm are marked correct or wrong by the other players.
    function buildVote() {
      const letter = letterFor(false);
      const online = session.playerList().filter((p) => p.online !== false);
      const allChecked = online.length > 0 && online.every((p) => g.checks?.[p.uid]);
      const rows = []; let confirmed = 0;
      const doneBtn = el('button', { class: 'btn', type: 'button', onclick: () => finish() }, 'Done checking');
      function finish() {
        votedDone = true; doneBtn.disabled = true; doneBtn.textContent = 'Waiting for the others…';
        write(set(gref(`/voted/${session.uid}`), true), 'Could not finish checking');
      }
      session.playerList().filter((p) => p.uid !== session.uid).forEach((p) => CATS.forEach(([key, label]) => {
        const answer = g.answers?.[p.uid]?.[key]; const c = clean(answer);
        if (!answer || c.length < 2 || !c.startsWith(letter) || !g.checks?.[p.uid]) return;
        if (g.checks[p.uid][key] === 1) { confirmed += 1; return; }
        const id = `${p.uid}_${key}`;
        const yes = el('button', { class: `vote-btn${myVotes[id] === 1 ? ' on' : ''}`, type: 'button', 'aria-label': `${p.name} ${label} correct`, 'aria-pressed': myVotes[id] === 1 ? 'true' : 'false' }, '✅');
        const no = el('button', { class: `vote-btn${myVotes[id] === 0 ? ' on' : ''}`, type: 'button', 'aria-label': `${p.name} ${label} wrong`, 'aria-pressed': myVotes[id] === 0 ? 'true' : 'false' }, '❌');
        const cast = (v) => {
          myVotes[id] = v;
          yes.classList.toggle('on', v === 1); no.classList.toggle('on', v === 0);
          yes.setAttribute('aria-pressed', String(v === 1)); no.setAttribute('aria-pressed', String(v === 0));
          write(set(gref(`/votes/${session.uid}/${id}`), v), 'Could not save vote');
        };
        yes.addEventListener('click', () => cast(1));
        no.addEventListener('click', () => cast(0));
        rows.push(el('div', { class: 'vote-row' },
          el('div', {}, el('span', { class: 'muted' }, `${p.name} · ${label}`), el('strong', {}, answer)), el('div', { class: 'vote-btns' }, yes, no)));
      }));
      if (votedDone) { doneBtn.disabled = true; doneBtn.textContent = 'Waiting for the others…'; }
      mount(panel, el('h2', { class: 'center' }, 'Check the answers'),
        el('p', { class: 'muted center' }, allChecked
          ? `${confirmed} answer(s) were found in the dictionary. For the rest, tap ✅ or ❌. More ✅ than ❌ decides it; ties and no votes don't count.`
          : 'Looking up the words…'),
        allChecked && !rows.length ? el('p', { class: 'center' }, 'Nothing needs checking.') : rows,
        allChecked ? doneBtn : null);
      if (allChecked && !rows.length && !votedDone) finish();
    }
    function buildOver() {
      mount(panel, el('h2', { class: 'center' }, `Letter ${letterFor()}: results`),
        session.playerList().map((p) => el('div', { class: 'npat-row' },
          el('div', { class: 'player-name' }, avatarEl(p.avatar, 28), p.name, el('span', { class: 'tag host' }, `+${g.gain?.[p.uid] || 0}`)),
          CATS.map(([key, label]) => {
            const answer = g.answers?.[p.uid]?.[key] || '—'; const pt = g.pts?.[p.uid]?.[key];
            return el('p', { class: 'muted' }, `${label}: ${answer} ${pt ? `(+${pt})` : '✗'}`);
          }))));
    }

    return {
      update(room) {
        g = room.game || null;
        if (!g) {
          if (session.isHost) write(set(gref(), {
            round: 0, total: ROUNDS, letters: shuffled(LETTERS).slice(0, ROUNDS),
            phase: 'play', endsAt: serverNow() + ROUND_MS, scores: {},
          }), 'Could not start NPAT');
          return;
        }
        if (session.isHost && !Array.isArray(g.letters?.[g.round])) {
          write(update(gref(), { letters: shuffled(LETTERS).slice(0, ROUNDS) }), 'Could not repair the letter list');
        }
        const actionKey = `${g.round}|${g.phase}|${Boolean(g.stoppedBy)}`;
        if (actKey !== actionKey) { actKey = actionKey; acting = false; }
        const key = `${g.round}|${g.phase}`;
        if (key !== panelKey) {
          panelKey = key;
          if (g.phase === 'play') buildPlay();
          else if (g.phase === 'vote') {
            // Restore local state after a refresh; a second vote is rejected by rules.
            myVotes = { ...(g.votes?.[session.uid] || {}) };
            votedDone = Boolean(g.voted?.[session.uid]);
            checksSig = JSON.stringify(g.checks || {});
            buildVote();
            runChecks();
          }
          else if (g.phase === 'over') buildOver();
          else {
            const top = Object.entries(g.scores || {}).sort((a, b) => b[1] - a[1])[0];
            mount(panel, el('h2', { class: 'center' }, top ? `🏆 ${nameOf(top[0])} wins!` : 'Game over'),
              session.isHost ? el('button', { class: 'btn', type: 'button', onclick: () => session.endGame().catch(() => toast('Could not return to the lobby. Try again.')) }, 'Back to lobby')
                : el('p', { class: 'muted center' }, 'Waiting for the host…'));
          }
        }
        if (g.phase === 'play' && g.stopRequests?.[session.uid] && stopBtn) {
          stopBtn.disabled = true;
          stopBtn.textContent = 'Stop requested — waiting for everyone…';
        }
        if (g.phase === 'vote' && JSON.stringify(g.checks || {}) !== checksSig) { checksSig = JSON.stringify(g.checks || {}); buildVote(); }
        if (g.phase === 'over') buildOver(); // results can still be arriving
        mount(head, el('div', { class: 'big-letter' }, g.phase === 'final' ? '🎉' : letterFor()),
          el('h2', {}, `Round ${Math.min(g.round + 1, g.total)} of ${g.total} `, timer), el('p', { class: 'muted' }, g.stoppedBy && g.phase === 'play' ? `✋ ${nameOf(g.stoppedBy)} tapped Stop!` : 'Name, Place, Animal, Thing'));
        mount(board, el('h2', {}, 'Scores'), el('ul', { class: 'player-list' }, session.playerList()
          .sort((a, b) => (g.scores?.[b.uid] || 0) - (g.scores?.[a.uid] || 0))
          .map((p) => el('li', { class: 'player' },
            el('span', { class: 'player-avatar', 'aria-hidden': 'true' }, avatarEl(p.avatar, 44)), el('span', { class: 'player-name' }, p.name),
            el('span', { class: 'player-status ready' }, `${g.scores?.[p.uid] || 0} pts`)))));
        endBtn.hidden = !(session.isHost && g.phase !== 'final');
      },
      destroy() { clearInterval(clock); },
    };
  },
};
