// npat.js: Name, Place, Animal, Thing. A letter appears and everyone writes one answer for each
// category that starts with it. A unique answer scores 10, an answer someone else also wrote scores 5.
import { db, ref, set, update, serverNow } from '../firebase.js';
import { el, mount } from '../ui.js';
import { avatarEl } from '../avatars.js';

const CATS = [['name', 'Name'], ['place', 'Place'], ['animal', 'Animal'], ['thing', 'Thing']];
const ROUNDS = 5;
const ROUND_MS = 60000;
const GRACE_MS = 2000; // time left for everyone once somebody taps Stop
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

    const head = el('section', { class: 'card center' });
    const panel = el('section', { class: 'card stack' });
    const board = el('section', { class: 'card' });
    const timer = el('span', {});
    const endBtn = el('button', {
      class: 'btn secondary', type: 'button', hidden: true,
      onclick: () => { if (confirm('End the game for everyone?')) session.endGame(); },
    }, 'End game');
    mount(container, head, panel, board, endBtn);

    // ----- Playing -----
    async function submit() {
      if (submitted || !inputs.name) return;
      submitted = true;
      const answers = {};
      CATS.forEach(([key]) => { answers[key] = inputs[key].value.trim().slice(0, 30); inputs[key].disabled = true; });
      stopBtn.disabled = true; stopBtn.textContent = 'Waiting for the others…';
      await set(gref(`/answers/${session.uid}`), answers).catch(() => {});
    }
    async function stop() {
      await submit();
      update(gref(), { endsAt: Math.min(g.endsAt, serverNow() + GRACE_MS), stoppedBy: session.uid });
    }
    function buildPlay() {
      submitted = false; inputs = {};
      const letter = g.letters[g.round].toUpperCase();
      const fields = CATS.map(([key, label]) => {
        inputs[key] = el('input', {
          class: 'input', type: 'text', maxlength: 30, autocomplete: 'off', 'aria-label': label,
          placeholder: `${label} starting with ${letter}`, enterkeyhint: 'next',
        });
        return el('div', {}, el('label', { class: 'label' }, label), inputs[key]);
      });
      stopBtn = el('button', { class: 'btn warm', type: 'button', onclick: stop }, '✋ Stop! I’m done');
      mount(panel, fields, stopBtn);
    }

    // ----- Host referee -----
    const act = (fn) => { if (!acting) { acting = true; fn(); } };
    function scoreRound() {
      const letter = g.letters[g.round].toLowerCase(); const answers = g.answers || {};
      const pts = {}; const gain = {};
      // An answer counts when more players marked it correct than wrong (a tie, or no votes, counts too).
      const approved = (uid, key) => {
        if (g.checks?.[uid]?.[key] === 1) return true; // found in the dictionary
        let yes = 0; let no = 0;
        Object.entries(g.votes || {}).forEach(([voter, v]) => {
          if (voter === uid) return;
          if (v[`${uid}_${key}`] === 1) yes += 1; else if (v[`${uid}_${key}`] === 0) no += 1;
        });
        return yes >= no;
      };
      CATS.forEach(([key]) => {
        const valid = {};
        Object.keys(answers).forEach((uid) => {
          const a = clean(answers[uid]?.[key]);
          if (a.length >= 2 && a.startsWith(letter) && approved(uid, key)) valid[uid] = a;
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
    function endPlay() {
      return update(gref(), { phase: 'vote', voteEndsAt: serverNow() + VOTE_MS });
    }
    function next(r) {
      if (r >= g.total) return update(gref(), { phase: 'final' });
      return update(gref(), { round: r, phase: 'play', answers: null, pts: null, gain: null, stoppedBy: null, votes: null, voted: null, checks: null, voteEndsAt: null, endsAt: serverNow() + ROUND_MS });
    }
    function tick() {
      if (!g || !session.isHost) return;
      const now = serverNow();
      if (g.phase === 'play') {
        const online = session.playerList().filter((p) => p.online !== false);
        if (now >= g.endsAt + 1500 || (g.answers && online.every((p) => g.answers[p.uid]))) act(endPlay);
      }
      if (g.phase === 'vote') {
        const online = session.playerList().filter((p) => p.online !== false);
        if (now >= g.voteEndsAt || (online.every((p) => g.checks?.[p.uid]) && online.every((p) => g.voted?.[p.uid]))) act(scoreRound);
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
      const letter = g.letters[g.round].toLowerCase(); const mine = g.answers?.[session.uid] || {}; const out = { done: 1 };
      await Promise.all(CATS.map(async ([key]) => {
        const c = clean(mine[key]);
        if (c.length >= 2 && c.startsWith(letter)) out[key] = (await isRealAnswer(mine[key])) ? 1 : 0;
      }));
      await set(gref(`/checks/${session.uid}`), out).catch(() => {});
    }

    // Voting: answers the dictionary could not confirm are marked correct or wrong by the other players.
    function buildVote() {
      const letter = g.letters[g.round].toLowerCase();
      const allChecked = session.playerList().filter((p) => p.online !== false).every((p) => g.checks?.[p.uid]);
      const rows = []; let confirmed = 0;
      const doneBtn = el('button', { class: 'btn', type: 'button', onclick: () => finish() }, 'Done checking');
      function finish() {
        votedDone = true; doneBtn.disabled = true; doneBtn.textContent = 'Waiting for the others…';
        set(gref(`/voted/${session.uid}`), true).catch(() => {});
      }
      session.playerList().filter((p) => p.uid !== session.uid).forEach((p) => CATS.forEach(([key, label]) => {
        const answer = g.answers?.[p.uid]?.[key]; const c = clean(answer);
        if (!answer || c.length < 2 || !c.startsWith(letter) || !g.checks?.[p.uid]) return;
        if (g.checks[p.uid][key] === 1) { confirmed += 1; return; }
        const id = `${p.uid}_${key}`;
        const yes = el('button', { class: `vote-btn${myVotes[id] === 1 ? ' on' : ''}`, type: 'button', 'aria-label': `${p.name} ${label} correct` }, '✅');
        const no = el('button', { class: `vote-btn${myVotes[id] === 0 ? ' on' : ''}`, type: 'button', 'aria-label': `${p.name} ${label} wrong` }, '❌');
        const cast = (v) => {
          myVotes[id] = v; yes.classList.toggle('on', v === 1); no.classList.toggle('on', v === 0);
          set(gref(`/votes/${session.uid}/${id}`), v).catch(() => {});
        };
        yes.addEventListener('click', () => cast(1));
        no.addEventListener('click', () => cast(0));
        rows.push(el('div', { class: 'vote-row' },
          el('div', {}, el('span', { class: 'muted' }, `${p.name} · ${label}`), el('strong', {}, answer)), el('div', { class: 'vote-btns' }, yes, no)));
      }));
      if (votedDone) { doneBtn.disabled = true; doneBtn.textContent = 'Waiting for the others…'; }
      mount(panel, el('h2', { class: 'center' }, 'Check the answers'),
        el('p', { class: 'muted center' }, allChecked
          ? `${confirmed} answer(s) were found in the dictionary. For the rest, tap ✅ if it is correct or ❌ if it is wrong. The majority decides.`
          : 'Looking up the words…'),
        allChecked && !rows.length ? el('p', { class: 'center' }, 'Nothing needs checking.') : rows,
        allChecked ? doneBtn : null);
      if (allChecked && !rows.length && !votedDone) finish();
    }
    function buildOver() {
      mount(panel, el('h2', { class: 'center' }, `Letter ${g.letters[g.round].toUpperCase()}: results`),
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
          if (session.isHost) set(gref(), { round: 0, total: ROUNDS, letters: shuffled(LETTERS).slice(0, ROUNDS), phase: 'play', endsAt: serverNow() + ROUND_MS, scores: {} });
          return;
        }
        if (actKey !== `${g.round}${g.phase}`) { actKey = `${g.round}${g.phase}`; acting = false; }
        const key = `${g.round}|${g.phase}`;
        if (key !== panelKey) {
          panelKey = key;
          if (g.phase === 'play') buildPlay();
          else if (g.phase === 'vote') { myVotes = {}; votedDone = false; checksSig = JSON.stringify(g.checks || {}); buildVote(); runChecks(); }
          else if (g.phase === 'over') buildOver();
          else {
            const top = Object.entries(g.scores || {}).sort((a, b) => b[1] - a[1])[0];
            mount(panel, el('h2', { class: 'center' }, top ? `🏆 ${nameOf(top[0])} wins!` : 'Game over'),
              session.isHost ? el('button', { class: 'btn', type: 'button', onclick: () => session.endGame() }, 'Back to lobby')
                : el('p', { class: 'muted center' }, 'Waiting for the host…'));
          }
        }
        if (g.phase === 'vote' && JSON.stringify(g.checks || {}) !== checksSig) { checksSig = JSON.stringify(g.checks || {}); buildVote(); }
        if (g.phase === 'over') buildOver(); // results can still be arriving
        mount(head, el('div', { class: 'big-letter' }, g.phase === 'final' ? '🎉' : g.letters[g.round].toUpperCase()),
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
