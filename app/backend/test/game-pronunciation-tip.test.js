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
