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
const LETTERS = 'ABCDEFGHIJKLMNOPRSTW'.split('');
const clean = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z ]/g, '').trim();
const shuffled = (list) => [...list].sort(() => Math.random() - 0.5);

export default {
  id: 'npat', name: 'Name, Place, Animal, Thing', emoji: '✍️', blurb: 'Think fast: one answer per category.', minPlayers: 1,

  create(container, session) {
    const gref = (sub = '') => ref(db, `rooms/${session.code}/game${sub}`);
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
    function finishRound() {
      const letter = g.letters[g.round].toLowerCase(); const answers = g.answers || {};
      const pts = {}; const gain = {};
      CATS.forEach(([key]) => {
        const valid = {};
        Object.keys(answers).forEach((uid) => {
          const a = clean(answers[uid]?.[key]);
          if (a.length >= 2 && a.startsWith(letter)) valid[uid] = a;
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
    function next(r) {
      if (r >= g.total) return update(gref(), { phase: 'final' });
      return update(gref(), { round: r, phase: 'play', answers: null, pts: null, gain: null, stoppedBy: null, endsAt: serverNow() + ROUND_MS });
    }
    function tick() {
      if (!g || !session.isHost) return;
      const now = serverNow();
      if (g.phase === 'play') {
        const online = session.playerList().filter((p) => p.online !== false);
        if (now >= g.endsAt + 1500 || (g.answers && online.every((p) => g.answers[p.uid]))) act(finishRound);
      }
      if (g.phase === 'over' && now >= g.overAt) act(() => next(g.round + 1));
    }
    const clock = setInterval(() => {
      timer.textContent = g?.phase === 'play' ? `⏱ ${Math.max(0, Math.ceil((g.endsAt - serverNow()) / 1000))}s` : '';
      if (g?.phase === 'play' && serverNow() >= g.endsAt - 900) submit();
      tick();
    }, 200);

    // ----- Screens -----
    const nameOf = (uid) => session.room.players[uid]?.name || 'Player';
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
          else if (g.phase === 'over') buildOver();
          else {
            const top = Object.entries(g.scores || {}).sort((a, b) => b[1] - a[1])[0];
            mount(panel, el('h2', { class: 'center' }, top ? `🏆 ${nameOf(top[0])} wins!` : 'Game over'),
              session.isHost ? el('button', { class: 'btn', type: 'button', onclick: () => session.endGame() }, 'Back to lobby')
                : el('p', { class: 'muted center' }, 'Waiting for the host…'));
          }
        }
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
