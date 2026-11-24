// wordcookies.js: Word Cookies. Everyone gets the same letters and races to find the hidden words.
// The first player to find a word claims it. Longer words score more.
import { db, ref, set, update, runTransaction, serverNow, isPermissionDenied } from '../firebase.js';
import { el, mount, toast } from '../ui.js';
import { avatarEl } from '../avatars.js';

export const LEVELS = [{"letters":"stone","words":["nest","net","nets","nose","not","note","notes","one","ones","onset","sent","set","snot","son","stone","ten","tens","toe","tone","tones","tons"]},{"letters":"plate","words":["ale","apt","ate","eat","lap","late","leap","leapt","let","pal","pale","pat","pea","peal","pelt","petal","plate","plea","pleat","tale","tap","tape","tea","teal"]},{"letters":"garden","words":["age","and","anger","are","danger","dare","darn","dean","dear","den","drag","ear","earn","end","era","garden","gear","grade","grand","nag","near","nerd","rag","rage","raged","ran","rang","range","ranged","read","red","rend"]},{"letters":"master","words":["are","arms","ate","ear","east","eat","era","mare","mast","master","mat","mate","meat","met","ram","rate","sat","seat","set","smart","star","stare","steam","stream","tame","tea","team","tear","tram"]},{"letters":"planet","words":["ale","ant","apt","ate","eat","lane","lap","late","lean","leap","leapt","lent","let","nap","neat","net","pal","pale","pan","pane","panel","pant","pat","pea","peal","pelt","pen","penal","pet","petal","plane","planet","plant","plate","plea","pleat","tale","tan","tap","tea","teal","ten"]},{"letters":"friend","words":["den","din","dine","dire","end","fed","fend","fern","fin","find","finder","fine","fined","fir","fire","fried","friend","ire","nerd","red","ref","rein","rend","rid","ride","rind"]},{"letters":"bright","words":["big","birth","bit","brig","bright","girth","grit","hit","rib","rig","right"]},{"letters":"castle","words":["ace","act","acts","ale","ate","case","cast","castle","cat","cats","cleats","east","eat","eats","lace","laces","last","least","lest","let","salt","sat","scale","sea","seat","set","slate","stale","steal","tea","teas"]}];
const ROUND_MS = 100000;
const OVER_MS = 7000;
const ROUNDS = 3;
const points = (w) => ({ 3: 10, 4: 20, 5: 30 }[w.length] || 50);
const shuffled = (list) => [...list].sort(() => Math.random() - 0.5);

export default {
  id: 'word-cookies', name: 'Word Cookies', emoji: '🍪', blurb: 'Race to find the hidden words.', minPlayers: 1,

  create(container, session) {
    const gref = (sub = '') => ref(db, `rooms/${session.code}/game${sub}`);
    let g = null; let letters = []; let picked = []; let tiles = []; let panelKey = ''; let acting = false; let actKey = '';
    const level = () => LEVELS[g.levels[g.round]];
    const nameOf = (uid) => session.room.players[uid]?.name || 'Player';
    const avatarOf = (uid) => session.room.players[uid]?.avatar || '🙂';

    function write(promise, label) {
      Promise.resolve(promise).catch((err) => {
        console.warn(label, err);
        if (isPermissionDenied(err)) toast('The game changed. Refresh the page.');
      });
      return promise;
    }

    const head = el('section', { class: 'card center' });
    const slots = el('section', { class: 'card' });
    const panel = el('section', { class: 'card stack' });
    const board = el('section', { class: 'card' });
    const timer = el('span', {});
    const endBtn = el('button', {
      class: 'btn secondary', type: 'button', hidden: true,
      onclick: () => { if (confirm('End the game for everyone?')) session.endGame(); },
    }, 'End game');
    mount(container, head, slots, panel, board, endBtn);

    // ----- Letter wheel -----
    const current = el('p', { class: 'center hint' }, '\u00a0');
    function refresh() {
      current.textContent = picked.map((i) => letters[i]).join('').toUpperCase() || '\u00a0';
      tiles.forEach((t, i) => { t.disabled = picked.includes(i); });
    }
    async function submit() {
      const word = picked.map((i) => letters[i]).join('');
      picked = []; refresh();
      if (word.length < 3) return toast('Words need at least 3 letters');
      if (!level().words.includes(word)) return toast('Not on this level’s list');
      if (g.found?.[word]) return toast(`${nameOf(g.found[word])} already found it`);
      try {
        const result = await runTransaction(gref(`/found/${word}`), (cur) => cur || session.uid);
        if (result.snapshot.val() === session.uid) toast(`+${points(word)} 🍪`);
        else toast('Someone was faster!');
      } catch (err) {
        write(Promise.reject(err), 'Could not save the word');
        toast('Could not save that word. Refresh if the host changed the game.');
      }
    }
    function buildPlay() {
      picked = []; letters = shuffled([...level().letters]);
      tiles = letters.map((ch, i) => el('button', {
        class: 'tile', type: 'button', onclick: () => { if (!picked.includes(i)) { picked.push(i); refresh(); } },
      }, ch.toUpperCase()));
      refresh();
      mount(panel, current, el('div', { class: 'tiles' }, tiles), el('div', { class: 'share-row' },
        el('button', { class: 'btn secondary', type: 'button', onclick: () => { picked.pop(); refresh(); } }, '⌫ Delete'),
        el('button', {
          class: 'btn secondary', type: 'button',
          onclick: () => { picked = []; letters = shuffled(letters); tiles.forEach((t, i) => { t.textContent = letters[i].toUpperCase(); }); refresh(); },
        }, '🔀 Shuffle'),
        el('button', { class: 'btn', type: 'button', onclick: submit }, 'Enter')));
    }

    // ----- Host referee -----
    const act = (fn) => {
      if (acting) return;
      acting = true;
      Promise.resolve().then(fn).catch((err) => {
        console.warn('Host action failed', err);
        acting = false;
      });
    };
    function finishRound() {
      const scores = { ...(g.scores || {}) }; const gain = {};
      Object.entries(g.found || {}).forEach(([w, uid]) => { gain[uid] = (gain[uid] || 0) + points(w); });
      Object.entries(gain).forEach(([uid, pts]) => { scores[uid] = (scores[uid] || 0) + pts; });
      return update(gref(), { phase: 'over', scores, gain, overAt: serverNow() + OVER_MS });
    }
    function next(r) {
      if (r >= g.total) return update(gref(), { phase: 'final' });
      return update(gref(), { round: r, phase: 'play', found: null, gain: null, endsAt: serverNow() + ROUND_MS });
    }
    function tick() {
      if (!g || !session.isHost) return;
      const now = serverNow();
      if (g.phase === 'play' && (now >= g.endsAt || Object.keys(g.found || {}).length >= level().words.length)) act(finishRound);
      if (g.phase === 'over' && now >= g.overAt) act(() => next(g.round + 1));
    }
    const clock = setInterval(() => {
      timer.textContent = g?.phase === 'play' ? `⏱ ${Math.max(0, Math.ceil((g.endsAt - serverNow()) / 1000))}s` : '';
      tick();
    }, 500);

    return {
      update(room) {
        g = room.game || null;
        if (!g) {
          if (session.isHost) write(set(gref(), { round: 0, total: ROUNDS, levels: shuffled(LEVELS.map((_, i) => i)).slice(0, ROUNDS), phase: 'play', endsAt: serverNow() + ROUND_MS, scores: {} }), 'Could not start Word Cookies');
          return;
        }
        if (actKey !== `${g.round}${g.phase}`) { actKey = `${g.round}${g.phase}`; acting = false; }
        const key = `${g.round}|${g.phase}`;
        if (key !== panelKey) {
          panelKey = key;
          if (g.phase === 'play') buildPlay();
          else if (g.phase === 'over') {
            mount(panel, el('h2', { class: 'center' }, 'Round complete! 🍪'),
              ...Object.entries(g.gain || {}).map(([uid, pts]) => el('p', { class: 'center' }, `${nameOf(uid)} +${pts}`)),
              Object.keys(g.gain || {}).length ? null : el('p', { class: 'muted center' }, 'No words found this time.'));
          } else {
            const top = Object.entries(g.scores || {}).sort((a, b) => b[1] - a[1])[0];
            mount(panel, el('h2', { class: 'center' }, top ? `🏆 ${nameOf(top[0])} wins!` : 'Game over'),
              session.isHost ? el('button', { class: 'btn', type: 'button', onclick: () => session.endGame() }, 'Back to lobby')
                : el('p', { class: 'muted center' }, 'Waiting for the host…'));
          }
        }
        if (g.phase !== 'final') {
          const words = [...level().words].sort((a, b) => a.length - b.length || a.localeCompare(b));
          const foundCount = Object.keys(g.found || {}).length;
          mount(slots, el('h2', {}, `Words ${foundCount}/${words.length}`), el('div', { class: 'slots' }, words.map((w) => {
            const by = g.found?.[w];
            return el('span', { class: `slot${by ? ' found' : g.phase === 'over' ? ' missed' : ''}` },
              by ? [avatarEl(avatarOf(by), 18), ' ', w.toUpperCase()] : g.phase === 'over' ? w.toUpperCase() : Array(w.length).fill('_').join(' '));
          })));
        } else mount(slots);
        mount(head, el('h2', {}, `Round ${Math.min(g.round + 1, g.total)} of ${g.total} `, timer), el('p', { class: 'muted' }, 'Word Cookies'));
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
