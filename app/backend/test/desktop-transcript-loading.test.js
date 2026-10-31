const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const desktopHtml = path.resolve(__dirname, '../../frontend/video-reader-desktop.html');

function read() {
  return fs.readFileSync(desktopHtml, 'utf8');
}

test('desktop video reader shows transcript loading and starts fetch in parallel with player', () => {
  const source = read();
  assert.match(source, /isLoadingTranscript:\s*false/);
  assert.match(source, /function beginTranscriptLoad/);
  assert.match(source, /字幕加载中…/);
  assert.match(source, /beginTranscriptLoad\(v,\s*selectionToken\)/);
  assert.match(source, /字幕与视频并行加载/);
});

test('desktop bilingual translation uses cache, progressive drain, and visible observer', () => {
  const source = read();
  assert.match(source, /desktopTranslateCache/);
  assert.match(source, /desktopTranslateInflight/);
  assert.match(source, /scheduleDesktopBilingualDrain/);
  assert.match(source, /queueVisibleBilingualTranslations/);
  assert.match(source, /IntersectionObserver/);
  assert.match(source, /patchDesktopTranslationDom/);
  assert.match(source, /targets\.length < 24/);
});

test('desktop avoids stacking bilingual placeholders on every transcript row', () => {
  const source = read();
  assert.match(source, /Only paint Chinese when ready/);
  assert.match(source, /showTransLine = state\.showBilingual && hasZh/);
  assert.match(source, /Fast path: show cues once ASAP/);
});
