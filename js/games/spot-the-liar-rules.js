// spot-the-liar-rules.js: pure timing and scoring rules for Spot the Liar.
// No Firebase or DOM here, so the same code runs in the browser and in tests.

import { guessMatches } from './spot-the-liar-data.js';

export const CLUE_MS = 20000;
export const DISCUSS_MS = 40000;
export const VOTE_MS = 20000;
export const GUESS_MS = 15000;
export const REVEAL_MS = 4000; // how long everyone sees the reveal when the liar escaped
export const OVER_MS = 6000;
export const MAX_ROUNDS = 6;

/** Turn a stored vote map into a strict-majority result. */
export function tallyVotes(votes = {}, liar = '') {
  const picks = Object.values(votes)
    .map((vote) => (vote && typeof vote === 'object' ? vote.pick : vote))
    .filter(Boolean);
  const forLiar = picks.filter((pick) => pick === liar).length;
  return {
    total: picks.length,
    forLiar,
    caught: picks.length > 0 && forLiar * 2 > picks.length,
  };
}

/**
 * Work out one round's points.
 * - liar escapes: liar +200
 * - liar caught, guesses the word: liar +150
 * - liar caught, wrong guess: everyone who voted for the liar +100
 */
export function scoreRound({ liar = '', votes = {}, word = '', guess = '', caught } = {}) {
  const tally = tallyVotes(votes, liar);
  const wasCaught = typeof caught === 'boolean' ? caught : tally.caught;
  const guessCorrect = wasCaught && guessMatches(guess, word);
  const gain = {};
  let outcome;

  if (!wasCaught) {
    gain[liar] = 200;
    outcome = 'escaped';
  } else if (guessCorrect) {
    gain[liar] = 150;
    outcome = 'guessed';
  } else {
    Object.entries(votes).forEach(([voter, vote]) => {
      const pick = vote && typeof vote === 'object' ? vote.pick : vote;
      if (pick === liar) gain[voter] = 100;
    });
    outcome = 'caught';
  }

  return { gain, caught: wasCaught, guessCorrect, tally, outcome };
}

/** Add a round's gain to the running totals without mutating the input. */
export function applyScore(scores = {}, gain = {}) {
  const next = { ...scores };
  Object.entries(gain).forEach(([uid, points]) => {
    next[uid] = (next[uid] || 0) + points;
  });
  return next;
}
