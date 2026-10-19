const test = require('node:test');
const assert = require('node:assert/strict');

const { analyze } = require('../../frontend/js/video-reader/sentence-analysis');

test('a long sentence becomes a shorter version, a trunk, and a clause note', () => {
  const result = analyze('The word apartment actually comes from Italian and originally referred to a place that was separated from something else.');

  assert.match(result.simplified, /The word apartment comes from Italian\./);
  assert.match(result.simplified, /It meant a place\./);
  assert.equal(result.trunk, 'The word apartment comes from Italian');
  assert.ok(result.parts.some((part) => /referred to/i.test(part.en)));
  assert.ok(result.parts.some((part) => /that was separated/i.test(part.en)));
  assert.ok(result.points.some((point) => point.includes('that')));
  assert.ok(result.keywords.includes('apartment'));
  assert.equal(result.keywords.includes('from'), false);
});

test('a short sentence still has a trunk and one reading note', () => {
  const result = analyze('Could you say that again?');
  assert.equal(result.trunk, 'Could you say that again');
  assert.ok(result.points.length >= 1);
});
