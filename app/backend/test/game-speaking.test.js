const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const speaking = require(path.resolve(__dirname, '../../frontend/js/game/games/speaking.js'));

test('exact transcript matches the target lemma', () => {
  const graded = speaking.gradeTranscript('school', 'school');
  assert.equal(graded.isCorrect, true);
  assert.equal(graded.tier, 'exact');
});

test('transcript containing the lemma still counts as correct', () => {
  const graded = speaking.gradeTranscript('desk', 'the desk please');
  assert.equal(graded.isCorrect, true);
  assert.equal(graded.tier, 'contains');
});

test('small spelling slips are accepted as close matches', () => {
  const graded = speaking.gradeTranscript('apple', 'aple');
  assert.equal(graded.isCorrect, true);
  assert.equal(graded.tier, 'close');
});

test('unrelated transcript is rejected', () => {
  const graded = speaking.gradeTranscript('school', 'banana');
  assert.equal(graded.isCorrect, false);
  assert.equal(graded.tier, 'miss');
});

test('normalizeSpoken strips punctuation and casing', () => {
  assert.equal(speaking.normalizeSpoken("It's a School!"), 'its a school');
});
