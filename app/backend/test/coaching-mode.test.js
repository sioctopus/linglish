const test = require('node:test');
const assert = require('node:assert/strict');

const mode = require('../../frontend/js/video-reader/coaching-mode');
const { canUseCoaching } = require('../services/entitlements');
const { explainSentence, localExplanation } = require('../services/coaching');

const activeVip = {
  id: 4,
  membership_type: 'vip',
  subscription_status: 'active',
  membership_expires_at: '2099-01-01T00:00:00.000Z',
};

test('member and premium member can open coaching mode', () => {
  assert.equal(mode.canUseCoaching(activeVip, new Date('2026-10-15T00:00:00Z')), true);
  assert.equal(canUseCoaching(activeVip, { now: new Date('2026-10-15T00:00:00Z') }), true);
  assert.equal(mode.canUseCoaching({
    membership_type: 'svip',
    subscription_status: 'active',
    membership_expires_at: '2099-01-01T00:00:00.000Z',
  }, new Date('2026-10-15T00:00:00Z')), true);
  assert.equal(canUseCoaching({
    membership_type: 'svip',
    subscription_status: 'active',
  }, { now: new Date('2026-10-15T00:00:00Z') }), true);
});

test('free and expired members stay outside coaching mode', () => {
  assert.equal(mode.canUseCoaching({ membership_type: 'free' }), false);
  assert.equal(canUseCoaching({ membership_type: 'free' }), false);
  const expired = {
    membership_type: 'vip',
    subscription_status: 'active',
    membership_expires_at: '2000-01-01T00:00:00.000Z',
  };
  assert.equal(mode.canUseCoaching(expired, new Date('2026-10-15T00:00:00Z')), false);
  assert.equal(canUseCoaching(expired, { now: new Date('2026-10-15T00:00:00Z') }), false);
});

test('fisheye rows grow toward the current sentence above and below', () => {
  const segments = [
    { text: 'One.', start: 0, end: 1 },
    { text: 'Two.', start: 1, end: 2 },
    { text: 'Three.', start: 2, end: 3 },
    { text: 'Four.', start: 3, end: 4 },
    { text: 'Five.', start: 4, end: 5 },
    { text: 'Six.', start: 5, end: 6 },
    { text: 'Seven.', start: 6, end: 7 },
  ];
  const rows = mode.rollingRows(segments, 3);
  assert.equal(rows.length, 7);
  assert.deepEqual(rows.map((row) => row.depth), [3, 2, 1, 0, 1, 2, 3]);
  assert.deepEqual(rows.map((row) => row.role), [
    'previous', 'previous', 'previous', 'current', 'next', 'next', 'next',
  ]);
  assert.equal(rows[3].text, 'Four.');
  assert.equal(rows[0].text, 'One.');
  assert.equal(rows[6].text, 'Seven.');
  // Edges pad with empty slots when the focus is near the start/end.
  assert.equal(mode.rollingRows(segments, 0)[0].text, '');
  assert.equal(mode.rollingRows(segments, 0)[3].text, 'One.');
  assert.equal(mode.rollingRows(segments, 6)[6].text, '');
  assert.equal(mode.rollingRows(segments, 6)[3].text, 'Seven.');
  // Explicit radius=1 still returns the classic three-line window.
  const triplet = mode.rollingRows(segments, 1, 1);
  assert.deepEqual(triplet.map((row) => row.role), ['previous', 'current', 'next']);
  assert.equal(mode.indexAtTime(segments, 1.5), 1);
});

test('coaching actions cover copy, notes, marks, lookup, explain, translate, read, shadow, and compare', () => {
  assert.deepEqual(mode.ACTIONS.map((action) => action.label), [
    '复制', '做笔记', '划线', 'AI查词', '讲解', '翻译', '听原声', '跟读', '听自己', '对比',
  ]);
});

test('notes and underlines stay with the sentence', () => {
  const memory = new Map();
  const storage = {
    getItem: (key) => memory.get(key) || null,
    setItem: (key, value) => memory.set(key, value),
  };
  let record = mode.saveNote(mode.emptyRecord(), 1, '重音在 again');
  record = mode.toggleMark(record, 1, 'again');
  mode.writeRecord(storage, 4, 9, record);
  const loaded = mode.readRecord(storage, 4, 9);
  assert.equal(mode.noteFor(loaded, 1), '重音在 again');
  assert.equal(mode.isMarked(loaded, 1, 'again'), true);
  const copied = mode.copyText({ text: 'Could you say that again?', translation: '能再说一遍吗？' }, 'again');
  assert.equal(copied, 'again');
  assert.equal(mode.copyText({ text: 'Could you say that again?', translation: '能再说一遍吗？' }, ''), 'Could you say that again?\n能再说一遍吗？');
});

test('local explanation still teaches the sentence when the model is unavailable', async () => {
  const result = await explainSentence({
    text: 'Could you say that again?',
    translation: '能再说一遍吗？',
    word: 'again',
  }, { allowModel: false });
  assert.equal(result.source, 'local');
  assert.match(result.explanation, /Could you say that again\?/);
  assert.match(localExplanation({ text: 'Hello.', translation: '', word: '' }), /Hello\./);
});
