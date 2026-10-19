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

test('three subtitle rows keep the previous, current, and next sentence', () => {
  const segments = [
    { text: 'I missed the bus.', start: 0, end: 1.4, translation: '我错过了公交。' },
    { text: 'Could you say that again?', start: 1.4, end: 3 },
    { text: 'Sure, listen once more.', start: 3, end: 4.6 },
  ];
  const rows = mode.rollingRows(segments, 1);
  assert.deepEqual(rows.map((row) => row.role), ['previous', 'current', 'next']);
  assert.equal(rows[0].text, 'I missed the bus.');
  assert.equal(rows[1].text, 'Could you say that again?');
  assert.equal(rows[2].text, 'Sure, listen once more.');
  assert.equal(mode.rollingRows(segments, 0)[0].text, '');
  assert.equal(mode.rollingRows(segments, 2)[2].text, '');
  assert.equal(mode.indexAtTime(segments, 1.5), 1);
});

test('coaching actions cover copy, notes, marks, lookup, explain, translate, read, and shadow', () => {
  assert.deepEqual(mode.ACTIONS.map((action) => action.label), [
    '复制', '做笔记', '划线', 'AI查词', '讲解', '翻译', '逐句朗读', '跟读',
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
