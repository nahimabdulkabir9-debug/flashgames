import test from 'node:test';
import assert from 'node:assert/strict';
import { answerApproved } from '../js/games/npat-rules.js';

const OWNER = 'owner-uid';
const key = 'name';
const vote = (voter, value) => ({ [voter]: { [`${OWNER}_${key}`]: value } });

test('a dictionary hit counts without votes', () => {
  assert.equal(answerApproved({ check: 1, votes: {}, ownerUid: OWNER, key }), true);
});

test('a strict majority of yes votes approves', () => {
  const votes = { ...vote('a', 1), ...vote('b', 1), ...vote('c', 0) };
  assert.equal(answerApproved({ check: 0, votes, ownerUid: OWNER, key }), true);
});

test('ties and no votes do not approve', () => {
  assert.equal(answerApproved({ check: 0, votes: {}, ownerUid: OWNER, key }), false);
  const tied = { ...vote('a', 1), ...vote('b', 0) };
  assert.equal(answerApproved({ check: 0, votes: tied, ownerUid: OWNER, key }), false);
});

test('the answer owner cannot vote for their own answer', () => {
  const votes = { ...vote(OWNER, 1) };
  assert.equal(answerApproved({ check: 0, votes, ownerUid: OWNER, key }), false);
});
