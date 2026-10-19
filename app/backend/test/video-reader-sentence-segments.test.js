const test = require('node:test');
const assert = require('node:assert/strict');

const { toCompleteSentences, toDisplayedSentences, toDisplayedParagraphs } = require('../../frontend/js/video-reader/sentence-segments');

test('joins ASR fragments into one complete sentence', () => {
  const result = toCompleteSentences([
    { start: 0, end: 1.2, text: "Yeah, we'll probably walk up all" },
    { start: 1.2, end: 1.45, text: 'the' },
    { start: 1.45, end: 2.8, text: "floors, but there's mirrors all" },
    { start: 2.8, end: 3.2, text: 'along.' },
  ]);

  assert.equal(result.length, 1);
  assert.equal(result[0].text, "Yeah, we'll probably walk up all the floors, but there's mirrors all along.");
  assert.equal(result[0].start, 0);
  assert.equal(result[0].end, 3.2);
  assert.deepEqual(result[0].source_indices, [0, 1, 2, 3]);
});

test('splits multiple sentences and carries an unfinished tail into the next fragment', () => {
  const result = toCompleteSentences([
    { start: 0, end: 4, text: 'My name is Sarah. I am 35 years old. I' },
    { start: 4, end: 7, text: 'have a husband. His name is Daniel. We' },
    { start: 7, end: 9, text: 'live in London.' },
  ]);

  assert.deepEqual(result.map((s) => s.text), [
    'My name is Sarah.',
    'I am 35 years old.',
    'I have a husband.',
    'His name is Daniel.',
    'We live in London.',
  ]);
  assert.ok(result.every((s) => s.end > s.start));
});

test('keeps translated fragments aligned while joining a complete sentence', () => {
  const result = toCompleteSentences([
    { start_sec: 0, end_sec: 1, text: 'This is', translation: '这是' },
    { start_sec: 1, end_sec: 2, text: 'a school bus.', translation: '一辆校车。' },
  ]);

  assert.equal(result.length, 1);
  assert.equal(result[0].text, 'This is a school bus.');
  assert.equal(result[0].translation, '这是一辆校车。');
  assert.equal(result[0].start_sec, 0);
  assert.equal(result[0].end_sec, 2);
});

test('does not join across a speaker change or a long silence', () => {
  const result = toCompleteSentences([
    { start: 0, end: 1, text: 'How are', speaker: 'A' },
    { start: 1, end: 2, text: 'you?', speaker: 'B' },
    { start: 5, end: 6, text: 'I am', speaker: 'B' },
    { start: 6, end: 7, text: 'fine.', speaker: 'B' },
  ]);

  assert.deepEqual(result.map((s) => s.text), ['How are', 'you?', 'I am fine.']);
});

test('display contract preserves raw source identity through coarse splitting and fragment merging', () => {
  const result = toDisplayedSentences([
    { index: 40, start: 0, end: 1, text: 'Please open' },
    { index: 41, start: 1, end: 2, text: 'the window.' },
    { index: 42, start: 2, end: 12, text: 'Sit down. Take a breath.' },
  ]);

  assert.deepEqual(result.map((segment) => segment.text), [
    'Please open the window.',
    'Sit down.',
    'Take a breath.',
  ]);
  assert.deepEqual(result.map((segment) => segment.source_indices), [[0, 1], [2], [2]]);
  assert.deepEqual(result.map((segment) => segment.index), [0, 1, 2]);
});

test('a long spoken sentence stays whole instead of stopping at a word cap', () => {
  const words = Array.from({ length: 36 }, (_, index) => `word${index}`);
  words[35] = 'done.';
  const result = toCompleteSentences([
    { start: 0, end: 4, text: words.slice(0, 12).join(' ') },
    { start: 4.2, end: 8, text: words.slice(12, 24).join(' ') },
    { start: 8.2, end: 12, text: words.slice(24).join(' ') },
  ]);

  assert.equal(result.length, 1);
  assert.equal(result[0].text, words.join(' '));
});

test('titles and decimals stay inside the sentence', () => {
  const result = toCompleteSentences([
    { start: 0, end: 3, text: 'Mr. Smith paid 3.14 dollars. He left.' },
  ]);

  assert.deepEqual(result.map((segment) => segment.text), [
    'Mr. Smith paid 3.14 dollars.',
    'He left.',
  ]);
});

test('nearby sentences become one readable paragraph and a pause starts the next', () => {
  const result = toDisplayedParagraphs([
    { start: 0, end: 2, text: 'My name is Sarah.' },
    { start: 2.2, end: 4, text: 'I am 35 years old.' },
    { start: 4.3, end: 6.5, text: 'I live in London.' },
    { start: 9, end: 11, text: 'Today we start the next topic.' },
  ]);

  assert.deepEqual(result.map((segment) => segment.text), [
    'My name is Sarah. I am 35 years old. I live in London.',
    'Today we start the next topic.',
  ]);
  assert.equal(result[0].start, 0);
  assert.equal(result[0].end, 6.5);
  assert.deepEqual(result[0].source_indices, [0, 1, 2]);
});

test('explicit provider identity is preserved on each deterministic split sentence', () => {
  const raw = [{ id: 17, start: 0, end: 4, text: 'Sit down. Take a breath.' }];
  const first = toDisplayedSentences(raw);
  const refreshed = toDisplayedSentences(JSON.parse(JSON.stringify(raw)));

  assert.deepEqual(first.map((segment) => segment.id), [17, 17]);
  assert.deepEqual(first.map((segment) => segment.source_indices), [[0], [0]]);
  assert.deepEqual(
    first.map(({ text, start, end }) => ({ text, start, end })),
    refreshed.map(({ text, start, end }) => ({ text, start, end })),
  );
  assert.notDeepEqual(
    { text: first[0].text, start: first[0].start, end: first[0].end },
    { text: first[1].text, start: first[1].start, end: first[1].end },
  );
});
