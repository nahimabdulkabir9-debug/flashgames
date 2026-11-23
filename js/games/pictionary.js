// pictionary.js: one player draws a secret word, everyone else guesses.
// The drawer picks the word on their own phone and shares only a hash of it,
// so guessers cannot read it. The host runs the clock and the scoring.
import { db, ref, set, update, remove, serverNow } from '../firebase.js';
import { el, mount, toast } from '../ui.js';

const WORDS = ('apple,banana,bicycle,castle,dragon,guitar,rocket,pizza,umbrella,elephant,volcano,robot,rainbow,penguin,lighthouse,'
  + 'sandwich,snowman,airplane,camera,butterfly,pyramid,tractor,bridge,candle,dinosaur,spider,hamburger,windmill,scissors,football,'
  + 'mountain,helicopter,cactus,octopus,teapot,skateboard,ladder,key,clock,whale,sunflower,tent,train,crown,ghost,giraffe,mushroom,telescope,fireworks,microscope,waterfall,astronaut,submarine,crocodile,trampoline,parachute,bulldozer,snowflake,campfire').split(',');
const COLORS = ['#111111', '#e03131', '#1c7ed6', '#2f9e44', '#f08c00', '#9c36b5'];
const DRAW_MS = 80000;
const OVER_MS = 6000;
const ROUNDS_EACH = 3; // how many times each player gets to draw
const isHard = (w) => w.length >= 7; // hard words reveal 2 letters, easy words reveal 1

const norm = (s) => String(s).toLowerCase().replace(/[^a-z]/g, '');
async function hash(word, salt) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}:${norm(word)}`));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}
const shuffled = (list) => [...list].sort(() => Math.random() - 0.5);
// The drawer gets two easy words and one hard word to choose from.
const pick3 = () => shuffled([...shuffled(WORDS.filter((w) => !isHard(w))).slice(0, 2), shuffled(WORDS.filter(isHard))[0]]);

export default {
  id: 'pictionary', name: 'Pictionary', emoji: '🎨', blurb: 'Draw the word, friends guess it.', minPlayers: 2,

  create(container, session, api) {
    const gref = (sub = '') => ref(db, `rooms/${session.code}/game${sub}`);
    let g = null; let myWord = null; let positions = []; let shown = 0; let hintEl = null; let choices = []; let choicesRound = -1;
    let drawing = null; let color = COLORS[0]; let lastPush = 0; let panelKey = ''; let acting = false; let actKey = '';

    const head = el('section', { class: 'card center' });
    const canvas = el('canvas', { class: 'pic-canvas', width: 600, height: 600 });
    const ctx = canvas.getContext('2d');
    const panel = el('section', { class: 'card stack' });
    const board = el('section', { class: 'card' });
    const endBtn = el('button', {
      class: 'btn secondary', type: 'button', hidden: true,
      onclick: () => { if (confirm('End the game for everyone?')) session.endGame(); },
    }, 'End game');
    mount(container, head, el('section', { class: 'card' }, canvas), panel, board, endBtn);

    const order = () => session.playerList().map((p) => p.uid);
    const canDraw = () => g?.phase === 'draw' && g.drawer === session.uid;
    const nameOf = (uid) => session.room.players[uid]?.name || 'Player';

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
    const push = () => { if (drawing) set(gref(`/strokes/${drawing.id}`), { c: drawing.c, p: drawing.p }).catch(() => {}); };
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
    const act = (fn) => { if (!acting) { acting = true; fn(); } };
    function newRound(r) {
      const ids = order();
      if (r >= g.total) return update(gref(), { phase: 'final' });
      return update(gref(), { round: r, drawer: ids[r % ids.length], phase: 'pick', hash: null, word: null, solved: null, strokes: null, gain: null, endsAt: null });
    }
    function finishRound() {
      const scores = { ...(g.scores || {}) }; const gain = {};
      Object.entries(g.solved || {}).forEach(([uid, left]) => {
        gain[uid] = 50 + Math.round((50 * left) / DRAW_MS);
        gain[g.drawer] = (gain[g.drawer] || 0) + 25;
      });
      Object.entries(gain).forEach(([uid, pts]) => { scores[uid] = (scores[uid] || 0) + pts; });
      update(gref(), { phase: 'over', scores, gain, overAt: serverNow() + OVER_MS });
    }
    function tick() {
      if (!g || !session.isHost) return;
      const now = serverNow(); const players = session.playerList();
      if (g.phase === 'pick' && players.find((p) => p.uid === g.drawer)?.online === false) act(() => newRound(g.round + 1));
      if (g.phase === 'draw') {
        const guessers = players.filter((p) => p.uid !== g.drawer && p.online !== false);
        if (now >= g.endsAt || (guessers.length && guessers.every((p) => g.solved?.[p.uid]))) act(finishRound);
      }
      if (g.phase === 'over' && now >= g.overAt) act(() => newRound(g.round + 1));
    }

    // ----- Letter hints -----
    const maskHint = (n) => [...myWord].map((ch, i) => (positions.slice(0, n).includes(i) ? ch : '_')).join(' ');
    // The drawer's phone reveals letters as the clock runs down: one for easy words, two for hard ones.
    function revealTick() {
      if (!myWord || g?.phase !== 'draw' || g.drawer !== session.uid) return;
      const left = (g.endsAt - serverNow()) / DRAW_MS;
      const due = (positions.length > 1 ? [0.55, 0.25] : [0.45]).filter((t) => left <= t).length;
      if (due > shown) { shown = due; update(gref(), { hint: maskHint(due) }); }
    }

    // ----- Player actions -----
    async function choose(word) {
      myWord = word; shown = 0;
      positions = shuffled(Array.from(word, (_, i) => i)).slice(0, isHard(word) ? 2 : 1);
      await update(gref(), { phase: 'draw', hash: await hash(word, `${session.code}${g.round}`), len: word.length, hint: maskHint(0), endsAt: serverNow() + DRAW_MS });
    }
    async function guess(text) {
      if (norm(text).length === 0) return;
      if ((await hash(text, `${session.code}${g.round}`)) === g.hash) {
        await set(gref(`/solved/${session.uid}`), Math.max(1, g.endsAt - serverNow()));
        toast('Correct! 🎉');
      } else toast('Not quite. Try again!');
    }

    // ----- Screens -----
    function renderPanel() {
      const kids = [];
      hintEl = null;
      if (g.phase === 'pick') {
        if (g.drawer === session.uid) {
          if (choicesRound !== g.round) { choices = pick3(); choicesRound = g.round; }
          kids.push(el('h2', {}, 'Choose a word to draw'), ...choices.map((w) => el('button', { class: 'btn', type: 'button', onclick: () => choose(w) }, `${w} (${isHard(w) ? 'hard' : 'easy'})`)));
        } else kids.push(el('p', { class: 'muted center' }, `${nameOf(g.drawer)} is choosing a word…`));
      } else if (g.phase === 'draw') {
        if (g.drawer === session.uid) {
          kids.push(el('h2', {}, `Draw: ${myWord || '…'}`),
            el('div', { class: 'swatches' }, COLORS.map((c) => el('button', {
              class: 'swatch', type: 'button', style: `background:${c}`, 'aria-label': 'Pen colour', onclick: () => { color = c; },
            }))),
            el('button', { class: 'btn secondary', type: 'button', onclick: () => remove(gref('/strokes')) }, '🧹 Clear drawing'));
        } else if (g.solved?.[session.uid]) {
          kids.push(el('p', { class: 'center' }, '✅ You got it! Waiting for the others…'));
        } else {
          const input = el('input', { class: 'input', type: 'text', autocomplete: 'off', placeholder: 'Type your guess', enterkeyhint: 'send' });
          const send = () => { guess(input.value); input.value = ''; input.focus(); };
          input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
          kids.push((hintEl = el('p', { class: 'center hint' }, g.hint || Array(g.len || 0).fill('_').join(' '))), input, el('button', { class: 'btn', type: 'button', onclick: send }, 'Guess'));
        }
      } else if (g.phase === 'over') {
        kids.push(el('h2', { class: 'center' }, `The word was “${g.word || '…'}”`),
          ...Object.entries(g.gain || {}).map(([uid, pts]) => el('p', { class: 'center' }, `${nameOf(uid)} +${pts}`)),
          Object.keys(g.gain || {}).length ? null : el('p', { class: 'muted center' }, 'Nobody guessed it.'));
      } else {
        const top = Object.entries(g.scores || {}).sort((a, b) => b[1] - a[1])[0];
        kids.push(el('h2', { class: 'center' }, top ? `🏆 ${nameOf(top[0])} wins!` : 'Game over'),
          session.isHost ? el('button', { class: 'btn', type: 'button', onclick: () => session.endGame() }, 'Back to lobby')
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
        if (!g) { if (session.isHost) set(gref(), { round: 0, total: order().length * ROUNDS_EACH, drawer: order()[0], phase: 'pick', scores: {} }); return; }
        if (actKey !== `${g.round}${g.phase}`) { actKey = `${g.round}${g.phase}`; acting = false; }
        if (g.phase === 'over' && g.drawer === session.uid && myWord && !g.word) update(gref(), { word: myWord });
        const key = `${g.round}|${g.phase}|${Boolean(g.solved?.[session.uid])}|${g.word || ''}|${prev === null}`;
        if (key !== panelKey) { panelKey = key; renderPanel(); }
        mount(head, el('h2', {}, `Round ${Math.min(g.round + 1, g.total)} of ${g.total} `, timer),
          el('p', { class: 'muted' }, g.phase === 'draw' ? `${nameOf(g.drawer)} is drawing` : 'Pictionary'));
        mount(board, el('h2', {}, 'Scores'), el('ul', { class: 'player-list' }, session.playerList()
          .sort((a, b) => (g.scores?.[b.uid] || 0) - (g.scores?.[a.uid] || 0))
          .map((p) => el('li', { class: 'player' },
            el('span', { class: 'player-avatar', 'aria-hidden': 'true' }, p.avatar), el('span', { class: 'player-name' }, p.name, p.uid === g.drawer ? ' ✏️' : ''),
            el('span', { class: 'player-status ready' }, `${g.scores?.[p.uid] || 0} pts`)))));
        if (hintEl) hintEl.textContent = g.hint || Array(g.len || 0).fill('_').join(' ');
        endBtn.hidden = !(session.isHost && g.phase !== 'final');
        redraw();
      },
      destroy() { clearInterval(clock); },
    };
  },
};
