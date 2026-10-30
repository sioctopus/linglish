const test = require('node:test');
const assert = require('node:assert/strict');

const {
  toCompleteSentences,
  toDisplayedSentences,
  toDisplayedParagraphs,
  displayIndexForTime,
  findIndexByTime,
} = require('../../frontend/js/video-reader/sentence-segments');

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

test('long travel intro with list commas becomes short practice cards', () => {
  const text = "This is our first day in Beijing, so let's go explore the Temple of Heaven, learn English vocabulary, phrases, common expressions, and you'll get to practice your pronunciation with two shadowing segments.";
  const result = toDisplayedSentences([{ start: 0, end: 18, text }]);
  const texts = result.map((segment) => segment.text);
  const wordCount = (line) => (String(line).match(/\b[\w’'-]+\b/g) || []).length;
  assert.ok(texts.length >= 4, `expected multiple cards, got ${JSON.stringify(texts)}`);
  assert.ok(result.every((segment) => wordCount(segment.text) <= 12), `card too long: ${JSON.stringify(texts)}`);
  assert.equal(
    texts.join(' ').replace(/[,\s]+/g, ' ').trim(),
    text.replace(/[,\s]+/g, ' ').trim(),
  );
  assert.ok(!texts.some((line) => /Temple of Heaven, learn English vocabulary, phrases, common expressions/i.test(line)), `still packed mid card: ${JSON.stringify(texts)}`);
});

test('long unpunctuated speech stays readable as short timed lines, not one paragraph', () => {
  const words = Array.from({ length: 36 }, (_, index) => `word${index}`);
  words[35] = 'done.';
  const result = toCompleteSentences([
    { start: 0, end: 4, text: words.slice(0, 12).join(' ') },
    { start: 4.2, end: 8, text: words.slice(12, 24).join(' ') },
    { start: 8.2, end: 12, text: words.slice(24).join(' ') },
  ]);

  assert.ok(result.length >= 2);
  assert.equal(result.map((segment) => segment.text).join(' '), words.join(' '));
  assert.ok(result.every((segment) => (segment.text.match(/\b[\w’'-]+\b/g) || []).length <= 28));
});

test('does not glue separate spoken lines just because auto-captions omit periods', () => {
  const result = toDisplayedSentences([
    { start: 0, end: 3, text: 'And I had tacos last night from a Mexican restaurant' },
    { start: 3.2, end: 6, text: 'and I bought a bottle of horchata' },
    { start: 6.2, end: 9, text: 'but I did not drink it yet' },
  ]);

  assert.deepEqual(result.map((segment) => segment.text), [
    'And I had tacos last night from a Mexican restaurant',
    'and I bought a bottle of horchata',
    'but I did not drink it yet',
  ]);
});

test('carries dangling how-about tail across timed cue windows and splits dialogue turns', () => {
  const result = toDisplayedSentences([
    { start: 0, end: 5, text: "Hi how are you I'm good how about" },
    { start: 5, end: 10, text: "you I'm fine thanks what's your" },
    { start: 10, end: 14, text: 'name' },
  ]);

  const texts = result.map((segment) => segment.text);
  assert.ok(!texts.some((text) => /\bhow about$/i.test(text)), `stranded tail still present: ${JSON.stringify(texts)}`);
  assert.ok(!texts.some((text) => /^you I'm fine/i.test(text)), `leading you tail: ${JSON.stringify(texts)}`);
  // Match on-screen dialogue cards: keep "I'm good how about you" as one line.
  assert.deepEqual(texts, [
    'Hi how are you',
    "I'm good how about you",
    "I'm fine thanks",
    "what's your name",
  ]);
});

test('keeps nice to meet you together when YouTube cuts after meet', () => {
  const result = toDisplayedSentences([
    { start: 0, end: 4, text: "I'm Lisa nice to meet" },
    { start: 4, end: 8, text: 'you what do you do' },
    { start: 8, end: 11, text: 'nice to meet' },
    { start: 11, end: 15, text: 'you my name is Tom' },
  ]);
  const texts = result.map((segment) => segment.text);
  assert.ok(texts.some((text) => /nice to meet you/i.test(text)), `missing meet you: ${JSON.stringify(texts)}`);
  assert.ok(!texts.some((text) => /nice to meet$/i.test(text)), `stranded meet: ${JSON.stringify(texts)}`);
  assert.ok(!texts.some((text) => /^you\b/i.test(text)), `orphan you line: ${JSON.stringify(texts)}`);
  assert.ok(texts.some((text) => /^I'm Lisa nice to meet you$/i.test(text) || /^nice to meet you$/i.test(text)), `card missing: ${JSON.stringify(texts)}`);
});

test('keeps nice to meet you too and where are you from on the right lines', () => {
  const raw = [
    { start: 20.37, end: 22.84, text: 'nice to meet you' },
    { start: 22.84, end: 26.08, text: 'too where are you' },
    { start: 26.08, end: 31.2, text: "from I'm from the US and you" },
  ];
  const result = toDisplayedSentences(raw);
  const texts = result.map((segment) => segment.text);
  assert.ok(texts.some((text) => /^nice to meet you too$/i.test(text)), `missing meet you too: ${JSON.stringify(texts)}`);
  assert.ok(texts.some((text) => /^where are you from$/i.test(text)), `missing where are you from: ${JSON.stringify(texts)}`);
  assert.ok(texts.some((text) => /^I'm from the US and you$/i.test(text)), `missing I'm from the US: ${JSON.stringify(texts)}`);
  assert.ok(!texts.some((text) => /^too\b/i.test(text)), `orphan too line: ${JSON.stringify(texts)}`);
  assert.ok(!texts.some((text) => /^from\b/i.test(text)), `orphan from line: ${JSON.stringify(texts)}`);
  assert.ok(!texts.some((text) => /too where are you/i.test(text)), `too still glued to where: ${JSON.stringify(texts)}`);

  const meet = result.find((segment) => /^nice to meet you too$/i.test(segment.text));
  const where = result.find((segment) => /^where are you from$/i.test(segment.text));
  assert.ok(meet.start >= raw[0].start - 0.001 && meet.end <= raw[1].end + 0.001, `meet timing invents outside sources: ${JSON.stringify(meet)}`);
  assert.ok(where.start >= raw[1].start - 0.001 && where.end <= raw[2].end + 0.001, `where timing invents outside sources: ${JSON.stringify(where)}`);
  assert.ok(Array.isArray(meet.source_indices) && meet.source_indices.includes(0), `meet missing source 0: ${JSON.stringify(meet)}`);
  assert.ok(Array.isArray(where.source_indices) && where.source_indices.length, `where missing sources: ${JSON.stringify(where)}`);

  // Raw clock maps into the repaired display cards.
  assert.equal(displayIndexForTime(result, raw, 21.0), result.indexOf(meet));
  assert.equal(findIndexByTime(raw, 24.0), 1);
});

test('attaches orphan last/year and lived/there without swallowing the next turn', () => {
  const result = toDisplayedSentences([
    { start: 37.84, end: 42.08, text: 'now yes I moved here last' },
    { start: 42.08, end: 46.33, text: 'year do you like it here' },
    { start: 65.16, end: 71.48, text: "it's quiet and safe how long have you lived" },
    { start: 71.48, end: 75.75, text: 'there for about 2 years now' },
  ]);
  const texts = result.map((segment) => segment.text);
  assert.ok(texts.some((text) => /moved here last year$/i.test(text)), `missing last year: ${JSON.stringify(texts)}`);
  assert.ok(texts.some((text) => /^do you like it here$/i.test(text)), `missing like-it-here question: ${JSON.stringify(texts)}`);
  assert.ok(texts.some((text) => /have you lived there$/i.test(text) || /lived there for about/i.test(text)), `missing lived there: ${JSON.stringify(texts)}`);
  assert.ok(!texts.some((text) => /^year\b/i.test(text)), `orphan year line: ${JSON.stringify(texts)}`);
  assert.ok(!texts.some((text) => /^there for about/i.test(text) && !/lived there/i.test(texts.join(' | '))), `orphan there line: ${JSON.stringify(texts)}`);
});

test('splits packed meet-you-too then where-are-you-from without cutting are you', () => {
  const result = toDisplayedSentences([
    { start: 20.37, end: 26.08, text: 'nice to meet you too where are you' },
    { start: 26.08, end: 31.2, text: "from I'm from the US and you" },
  ]);
  const texts = result.map((segment) => segment.text);
  assert.ok(texts.some((text) => /^nice to meet you too$/i.test(text)), `missing meet you too: ${JSON.stringify(texts)}`);
  assert.ok(texts.some((text) => /^where are you from$/i.test(text)), `missing where are you from: ${JSON.stringify(texts)}`);
  assert.ok(texts.some((text) => /^I'm from the US and you$/i.test(text)), `missing I'm from line: ${JSON.stringify(texts)}`);
  assert.ok(!texts.some((text) => /too where$/i.test(text)), `cut before are you: ${JSON.stringify(texts)}`);
  assert.ok(!texts.some((text) => /^are you$/i.test(text)), `orphan are you: ${JSON.stringify(texts)}`);
});

test('splits name-exchange dialogue and drops stale short Chinese glosses', () => {
  const result = toDisplayedSentences([
    { start: 8, end: 14, text: "thanks what's your name my name is John", translation: '我还好' },
    { start: 14, end: 20, text: "what's yours I'm Lisa nice to meet", translation: '我还好' },
  ]);
  const texts = result.map((segment) => segment.text);
  assert.ok(texts.some((text) => /\bmy name is John\b/i.test(text)), `missing my name is John: ${JSON.stringify(texts)}`);
  assert.ok(texts.some((text) => /^what['’]?s your name$/i.test(text) || /\bwhat['’]?s your name\b/i.test(text)), `missing what's your name: ${JSON.stringify(texts)}`);
  assert.ok(!texts.some((text) => /thanks what's your name my name is John/i.test(text)), `still packed: ${JSON.stringify(texts)}`);
  assert.ok(result.every((segment) => !segment.translation), `stale zh kept: ${JSON.stringify(result)}`);
});

test('splits packed YouTube auto-caption dialogue turns without punctuation', () => {
  const result = toDisplayedSentences([
    { start: 31.2, end: 37.84, text: "I'm from Canada oh that's great do you live here" },
    { start: 81.24, end: 86.41, text: 'do I work in an office what about you' },
    { start: 86.41, end: 92.56, text: "I'm a teacher that's great great what do you" },
    { start: 121, end: 130.16, text: "that's good what about you do you like your job it's okay" },
    { start: 139.24, end: 148.64, text: "co-workers that's important what do you do after work I go" },
    { start: 148.64, end: 153.48, text: "to the gym that's it's great I want to exercise" },
  ]);
  const texts = result.map((segment) => segment.text);

  assert.ok(texts.some((text) => /^I'm from Canada$/i.test(text)), `missing Canada line: ${JSON.stringify(texts)}`);
  assert.ok(texts.some((text) => /^oh that's great$/i.test(text)), `missing oh that's great: ${JSON.stringify(texts)}`);
  assert.ok(texts.some((text) => /^do you live here$/i.test(text)), `missing do you live here: ${JSON.stringify(texts)}`);

  assert.ok(texts.some((text) => /work in an office/i.test(text)), `missing office line: ${JSON.stringify(texts)}`);
  assert.ok(texts.some((text) => /^what about you$/i.test(text)), `missing what about you after office: ${JSON.stringify(texts)}`);

  assert.ok(texts.some((text) => /^I'm a teacher$/i.test(text)), `missing I'm a teacher: ${JSON.stringify(texts)}`);
  assert.ok(texts.some((text) => /that's great/i.test(text)), `missing that's great after teacher: ${JSON.stringify(texts)}`);

  // Keep reciprocal card together, then split the next question / answer.
  assert.ok(texts.some((text) => /^that's good what about you$/i.test(text)), `lost reciprocal card: ${JSON.stringify(texts)}`);
  assert.ok(texts.some((text) => /^do you like your job$/i.test(text)), `missing do you like your job: ${JSON.stringify(texts)}`);
  assert.ok(texts.some((text) => /^it's okay$/i.test(text)), `missing it's okay: ${JSON.stringify(texts)}`);

  assert.ok(texts.some((text) => /^co-workers$/i.test(text) || /^co-workers\b/i.test(text)), `missing co-workers: ${JSON.stringify(texts)}`);
  assert.ok(texts.some((text) => /^that's important$/i.test(text)), `missing that's important alone: ${JSON.stringify(texts)}`);
  assert.ok(texts.some((text) => /what do you do after work/i.test(text)), `missing after-work question: ${JSON.stringify(texts)}`);
  assert.ok(texts.some((text) => /^I go$/i.test(text) || /^I go to the gym$/i.test(text) || /to the gym/i.test(text)), `missing gym line: ${JSON.stringify(texts)}`);
  assert.ok(texts.some((text) => /I want to exercise/i.test(text)), `missing I want to exercise: ${JSON.stringify(texts)}`);

  assert.ok(!texts.some((text) => /Canada oh that's great do you live/i.test(text)), `still packed Canada line: ${JSON.stringify(texts)}`);
  assert.ok(!texts.some((text) => /that's good what about you do you like your job it's okay/i.test(text)), `still packed job line: ${JSON.stringify(texts)}`);
  assert.ok(!texts.some((text) => /co-workers that's important/i.test(text)), `still packed co-workers reaction: ${JSON.stringify(texts)}`);
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
