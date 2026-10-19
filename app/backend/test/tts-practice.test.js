const test = require('node:test');
const assert = require('node:assert/strict');

const { practiceRequest } = require('../routes/tts');

test('practice speech accepts a short English line and an allowed voice', () => {
  const request = practiceRequest({ text: ' Hi, Ben! ', voice: 'en-US-GuyNeural' });
  assert.equal(request.text, 'Hi, Ben!');
  assert.equal(request.voice, 'en-US-GuyNeural');
});

test('practice speech accepts the more natural multilingual voices', () => {
  const request = practiceRequest({ text: 'Hello.', voice: 'en-US-AvaMultilingualNeural' });
  assert.equal(request.voice, 'en-US-AvaMultilingualNeural');
});

test('practice speech accepts the natural British voices', () => {
  const request = practiceRequest({ text: 'Hello.', voice: 'en-GB-LibbyNeural' });
  assert.equal(request.voice, 'en-GB-LibbyNeural');
});

test('practice speech uses Ava when the voice is not one of the practice voices', () => {
  const request = practiceRequest({ text: 'Hello.', voice: 'en-AU-NatashaNeural' });
  assert.equal(request.voice, 'en-US-AvaMultilingualNeural');
});

test('practice speech rejects an empty or oversized line', () => {
  assert.throws(() => practiceRequest({ text: '   ' }), { message: 'text is required' });
  assert.throws(() => practiceRequest({ text: 'a'.repeat(181) }), { message: 'text is too long' });
});
