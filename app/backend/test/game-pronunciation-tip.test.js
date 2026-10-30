const test = require('node:test');
const assert = require('node:assert/strict');

const views = require('../../frontend/js/game/game-views');

test('pronunciation tip marks the stressed syllable and the key sound', () => {
  assert.equal(
    views.pronunciationTip('/ˈæpl/'),
    '重音在第一个音节 · æ 嘴张大，舌放平，比“哎”更开',
  );
  assert.equal(
    views.pronunciationTip('/bəˈnɑːnə/'),
    '重音在第二个音节 · ɑː 嘴张大，舌后缩，拉长',
  );
  assert.equal(views.pronunciationTip(''), '');
});

test('intro sentence uses This is a/an for theme nouns', () => {
  assert.equal(views.introSentence('fruits', 'watermelon'), 'This is a watermelon.');
  assert.equal(views.introSentence('fruits', 'apple'), 'This is an apple.');
  assert.equal(views.introSentence('colors', 'red'), 'This is red.');
  assert.match(views.expandSpeakLine('fruits', 'watermelon'), /^This is a watermelon\./);
  assert.match(views.introSpeakLine('fruits', 'watermelon'), /Yum!/);
});

test('teach plan follows US parent naming → expand → life → play', () => {
  const plan = views.teachPlan('fruits', { lemma: 'watermelon', zh: '西瓜' });
  assert.ok(plan);
  assert.match(plan.lead, /美式亲子/);
  assert.equal(plan.steps.length, 4);
  assert.match(plan.steps[0].t, /What’s this|What's this|停/);
  assert.match(plan.steps[1].t, /This is a watermelon/);
  assert.match(plan.steps[2].t, /厨房|超市/);
  assert.match(plan.avoid, /考问/);
  const note = views.teachNote('fruits', { lemma: 'watermelon', zh: '西瓜' });
  assert.match(note, /命名/);
  assert.match(note, /扩展/);
});

test('save helpers are exported for captioned card export', () => {
  assert.equal(typeof views.renderThemeCardBitmap, 'function');
  assert.equal(typeof views.saveThemeCardImage, 'function');
});
