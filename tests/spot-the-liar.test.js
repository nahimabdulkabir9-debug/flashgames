// Pure tests for Spot the Liar. No emulator needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CATEGORIES, CATEGORY_NAMES, randomPair, guessMatches,
} from '../js/games/spot-the-liar-data.js';
import {
  MAX_ROUNDS, tallyVotes, scoreRound, applyScore,
} from '../js/games/spot-the-liar-rules.js';

const LIAR = 'liar-uid';
const A = 'alice-uid';
const B = 'ben-uid';
const C = 'cara-uid';

test('the word bank has at least 30 categories with 12 words each', () => {
  assert.ok(CATEGORIES.length >= 30);
  assert.equal(CATEGORY_NAMES.length, CATEGORIES.length);
  CATEGORIES.forEach((category) => {
    assert.ok(category.name.length > 0);
    assert.ok(category.words.length >= 12, `${category.name} needs 12 words`);
    category.words.forEach((word) => assert.ok(word.length >= 3 && word.length <= 30));
  });
  const pair = randomPair();
  assert.ok(CATEGORY_NAMES.includes(pair.category));
  assert.ok(CATEGORIES.find((c) => c.name === pair.category).words.includes(pair.word));
});

test('max six rounds and guesses ignore case and punctuation', () => {
  assert.equal(MAX_ROUNDS, 6);
  assert.equal(guessMatches('ICE-CREAM!', 'ice cream'), true);
  assert.equal(guessMatches('lion', 'tiger'), false);
  assert.equal(guessMatches('', 'lion'), false);
});

test('votes need a strict majority to catch the liar', () => {
  assert.deepEqual(tallyVotes({}, LIAR), { total: 0, forLiar: 0, caught: false });
  assert.deepEqual(tallyVotes({ [A]: { pick: LIAR }, [B]: { pick: C } }, LIAR), {
    total: 2, forLiar: 1, caught: false,
  });
  assert.equal(tallyVotes({ [A]: { pick: LIAR }, [B]: { pick: LIAR }, [C]: { pick: A } }, LIAR).caught, true);
});

test('an escaping liar gets 200 points', () => {
  const result = scoreRound({ liar: LIAR, votes: { [A]: { pick: B } }, word: 'lion' });
  assert.equal(result.caught, false);
  assert.equal(result.outcome, 'escaped');
  assert.deepEqual(result.gain, { [LIAR]: 200 });
});

test('a caught liar who guesses the word gets 150 points', () => {
  const result = scoreRound({
    liar: LIAR, votes: { [A]: { pick: LIAR }, [B]: { pick: LIAR } },
    word: 'Ice Cream', guess: 'ice-cream', caught: true,
  });
  assert.equal(result.caught, true);
  assert.equal(result.guessCorrect, true);
  assert.equal(result.outcome, 'guessed');
  assert.deepEqual(result.gain, { [LIAR]: 150 });
});

test('a wrong guess pays 100 to each correct voter', () => {
  const result = scoreRound({
    liar: LIAR,
    votes: { [A]: { pick: LIAR }, [B]: { pick: LIAR }, [C]: { pick: A } },
    word: 'Tiger', guess: 'lion', caught: true,
  });
  assert.equal(result.guessCorrect, false);
  assert.equal(result.outcome, 'caught');
  assert.deepEqual(result.gain, { [A]: 100, [B]: 100 });
});

test('round points are added to the running scores', () => {
  assert.deepEqual(applyScore({ [A]: 50 }, { [A]: 100, [LIAR]: 200 }), {
    [A]: 150, [LIAR]: 200,
  });
});
