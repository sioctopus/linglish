const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const missed = require(path.resolve(__dirname, '../../frontend/js/video-reader/missed-words.js'));

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    getItem(key) { return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null; },
    setItem(key, value) { data[key] = String(value); },
  };
}

test('missed words are the reference words absent from the recording', () => {
  assert.deepEqual(
    missed.missingWords('I was responsible for the meeting', 'I was for meeting'),
    ['responsible', 'the']
  );
});

test('a later reading clears only the words that were actually said', () => {
  const storage = memoryStorage();
  assert.deepEqual(
    missed.remember(storage, 113, 4, 'I was responsible for the meeting', 'I was for meeting'),
    ['responsible', 'the']
  );
  assert.deepEqual(
    missed.remember(storage, 113, 4, 'I was responsible for the meeting', 'I was responsible for meeting'),
    ['the']
  );
  assert.deepEqual(missed.wordsFor(storage, 113, 4), ['the']);
  assert.deepEqual(missed.wordsFor(storage, 113, 5), []);
});
