const fs = require('node:fs');
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const starter = require(path.resolve(__dirname, '../../frontend/js/starter-sentence.js'));

function memoryStorage() {
  const data = {};
  return {
    getItem(key) { return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null; },
    setItem(key, value) { data[key] = String(value); },
  };
}

test('today opens the built-in sentence when no video can be played', () => {
  const today = fs.readFileSync(path.resolve(__dirname, '../../frontend/today.html'), 'utf8');
  assert.match(today, /id="starter-sentence"/);
  assert.match(today, /FIRST_LESSON_VIDEO_UNAVAILABLE'\) openStarterSentence/);
  assert.match(today, /get\('starter'\) === '1'/);
  assert.ok(today.indexOf('id="first-lesson-start"') < today.indexOf('id="starter-sentence"'));
});

test('an empty library still opens the first short sentence', () => {
  const storage = memoryStorage();
  const now = new Date(2026, 9, 15, 12);
  const first = starter.current(storage, now);
  assert.equal(first.sentence, 'I was responsible for the meeting.');
  assert.equal(first.spoken, 0);
  assert.equal(first.total, 5);
  starter.markSpoken(storage, now);
  assert.equal(starter.current(storage, now).sentence, 'The client arrived early.');
  assert.equal(starter.current(storage, now).spoken, 1);
});

test('the fifth sentence ends the day and the next day starts again', () => {
  const storage = memoryStorage();
  const today = new Date(2026, 9, 15, 12);
  for (let i = 0; i < 5; i += 1) starter.markSpoken(storage, today);
  const done = starter.current(storage, today);
  assert.equal(done.finished, true);
  assert.equal(done.spoken, 5);
  const tomorrow = starter.current(storage, new Date(2026, 9, 16, 12));
  assert.equal(tomorrow.spoken, 0);
  assert.equal(tomorrow.sentence, starter.SENTENCES[0]);
});

test('missed words stay inside the same sentence', () => {
  const html = starter.lineHTML('I was responsible for the meeting.', ['responsible', 'the']);
  assert.match(html, /class="starter-word starter-missing">responsible</);
  assert.match(html, /class="starter-word starter-missing">the</);
  assert.match(html, /class="starter-word">meeting</);
  const spoken = [];
  const ok = starter.speak('I was responsible for the meeting.', {
    cancel() {},
    speak(utter) { spoken.push(utter.text); },
  }, function Utterance(text) { this.text = text; });
  assert.equal(ok, true);
  assert.deepEqual(spoken, ['I was responsible for the meeting.']);
});
