const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyTranscript, canonicalLevel } = require('../services/video-level');

function ranksFor(text, rank) {
  const ranks = {};
  String(text).toLowerCase().match(/[a-z']+/g).forEach((word) => { ranks[word] = rank; });
  return ranks;
}

test('short everyday lines are A1 without a dictionary', () => {
  const result = classifyTranscript('I am a cat. I like milk. The dog is big.');
  assert.equal(result.difficulty, 'a1');
  assert.equal(result.source, 'structure');
});

test('a long academic sentence is C1 or C2 without a dictionary', () => {
  const result = classifyTranscript(
    'The implementation of sustainable development requires comprehensive international collaboration and sophisticated technological infrastructure.'
  );
  assert.ok(result.difficulty === 'c1' || result.difficulty === 'c2');
});

test('known high-frequency words stay at A1', () => {
  const text = 'I like the cat and the dog. I can see my mum and dad. We go to the park.';
  const result = classifyTranscript(text, ranksFor(text, 200));
  assert.equal(result.difficulty, 'a1');
  assert.equal(result.source, 'vocabulary');
});

test('one rare word does not pull an everyday video above A1', () => {
  const easy = 'I like the cat and the dog. I can see my mum and dad. We go to the park. The sun is big.';
  const ranks = ranksFor(easy, 200);
  ranks.infrastructure = 18000;
  const result = classifyTranscript(`${easy} infrastructure`, ranks);
  assert.equal(result.difficulty, 'a1');
});

test('everyday errands land on A2', () => {
  const text = 'Yesterday I went to the shop with my friend. We bought some bread and milk. It was cold so we went home early. I want to learn English every day.';
  const ranks = {
    yesterday: 900, went: 400, shop: 700, friend: 500, bought: 1100, bread: 800, milk: 600,
    cold: 700, home: 300, early: 800, want: 200, learn: 600, english: 500, every: 300, day: 200,
  };
  const result = classifyTranscript(text, ranks);
  assert.equal(result.difficulty, 'a2');
  assert.equal(result.source, 'vocabulary');
});

test('a personal story with some less common words is B1', () => {
  const text = 'I have been living in this city for three years. The traffic is busy but I enjoy walking to work. Last weekend we visited a museum and talked about our future plans.';
  const ranks = {
    living: 1800, city: 900, three: 400, years: 500, traffic: 2200, busy: 1400, enjoy: 1100,
    walking: 1000, work: 300, last: 400, weekend: 1600, visited: 1700, museum: 2400,
    talked: 800, future: 1500, plans: 1300,
  };
  const result = classifyTranscript(text, ranks);
  assert.equal(result.difficulty, 'b1');
});

test('a business explanation is B2', () => {
  const text = 'The company decided to expand its operations because the market has become increasingly competitive. Managers still need to consider the environmental impact of their decisions.';
  const ranks = {
    company: 600, decided: 1200, expand: 3500, operations: 4000, market: 900, become: 800,
    increasingly: 4200, competitive: 3800, managers: 2000, still: 300, need: 200,
    consider: 1500, environmental: 4500, impact: 1800, decisions: 1600,
  };
  const result = classifyTranscript(text, ranks);
  assert.equal(result.difficulty, 'b2');
});

test('academic vocabulary with dictionary ranks is C1', () => {
  const text = 'The implementation of sustainable development requires comprehensive international collaboration and sophisticated technological infrastructure.';
  const ranks = {
    implementation: 7000, sustainable: 6500, development: 1200, requires: 2000,
    comprehensive: 7200, international: 1800, collaboration: 5000, sophisticated: 9000,
    technological: 6000, infrastructure: 7500,
  };
  const result = classifyTranscript(text, ranks);
  assert.equal(result.difficulty, 'c1');
  assert.equal(result.source, 'vocabulary');
});

test('specialist prose is C2', () => {
  const text = 'The epistemological ramifications of this critique problematize historiography. Archival practices constitute an ideological apparatus. The monograph remains conspicuously undertheorized.';
  const ranks = {
    epistemological: 20000, ramifications: 18000, critique: 9000, problematize: 25000,
    historiography: 30000, archival: 16000, practices: 2000, constitute: 8000,
    ideological: 14000, apparatus: 12000, monograph: 22000, remains: 1500,
    conspicuously: 19000, undertheorized: 35000,
  };
  const result = classifyTranscript(text, ranks);
  assert.equal(result.difficulty, 'c2');
});

test('missing punctuation does not hide advanced vocabulary', () => {
  const text = 'implementation sustainable comprehensive sophisticated technological infrastructure collaboration development requires international';
  const ranks = {
    implementation: 7000, sustainable: 6500, development: 1200, requires: 2000,
    comprehensive: 7200, international: 1800, collaboration: 5000, sophisticated: 9000,
    technological: 6000, infrastructure: 7500,
  };
  const result = classifyTranscript(text, ranks);
  assert.equal(result.difficulty, 'c1');
});

test('a transcript without English words is left unset', () => {
  const result = classifyTranscript('这是一段中文说明，没有英文。');
  assert.equal(result.difficulty, null);
  assert.equal(result.source, 'empty');
});

test('legacy labels fold into the nearest CEFR band', () => {
  assert.equal(canonicalLevel('Beginner'), 'a1');
  assert.equal(canonicalLevel(' intermediate '), 'b1');
  assert.equal(canonicalLevel('A2'), 'a2');
  assert.equal(canonicalLevel('C2'), 'c2');
  assert.equal(canonicalLevel('expert'), null);
});
