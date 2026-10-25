const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { readPage } = require('./helpers/page-source');
function read(page) { return readPage(page); }
function extract(source, name) {
  const match = source.match(new RegExp(`(^[ \\t]*)(?:async )?function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^\\1\\}`, 'm'));
  assert.ok(match, name);
  return match[0];
}

for (const page of ['practice-session.html', 'practice-session-desktop.html']) {
  for (const mode of ['shadowing', 'dialogue']) {
    test(`${page}: choosing another video retains ${mode} and the current lesson`, () => {
      const source = read(page);
      const context = {
        URLSearchParams, currentPracticeMode: mode,
        window: { location: { search: '?from=today_first_lesson&quick=1&lines=3&level=beginner&desktop=1&share=test-share&token=test-token' } },
      };
      vm.createContext(context);
      if (page.includes('desktop')) vm.runInContext(extract(source, 'getPracticePageParams'), context);
      vm.runInContext(extract(source, 'buildPracticeVideoHref'), context);
      const url = new URL(context.buildPracticeVideoHref('162&mode=other'), 'https://example.test/');
      assert.equal(url.searchParams.get('videoId'), '162&mode=other');
      assert.equal(url.searchParams.get('mode'), mode);
      assert.equal(url.searchParams.get('quick'), '1');
      assert.equal(url.searchParams.get('lines'), '3');
      assert.equal(url.searchParams.get('desktop'), '1');
      assert.equal(url.searchParams.has('share'), false);
      assert.equal(url.searchParams.has('token'), false);
    });
  }
}

test('desktop video selection is immediately usable even when optional labels never load', async () => {
  const source = read('practice-session-desktop.html');
  const elements = new Map();
  let rendered = 0;
  const context = {
    currentPracticeMode: 'shadowing', allVideoList: [], currentDifficultyFilter: null,
    document: { getElementById(id) {
      if (!elements.has(id)) elements.set(id, { style: {}, innerHTML: '' });
      return elements.get(id);
    } },
    VideoTagSystem: { loadFromServer: () => new Promise(() => {}), syncVideoTagsFromServer() {} },
    renderDifficultyFilters() {}, renderTagFilters() {}, setupFilterButtons() {}, setupVideoSearch() {},
    renderVideoList() { rendered++; }, refreshAuthToken: () => null, console,
  };
  vm.createContext(context);
  vm.runInContext(extract(source, 'showVideoSelectModal'), context);
  await context.showVideoSelectModal([{ id: 162 }]);
  assert.equal(elements.get('video-select-modal').style.display, 'flex');
  assert.equal(elements.get('filter-container').style.display, 'block');
  assert.equal(elements.get('video-select-title').textContent, '选择跟读视频');
  assert.equal(rendered, 1);
});

test('mobile selection shows accurate short-video duration and keeps the chosen mode after a click', async () => {
  const source = read('practice-session.html');
  const events = new Map();
  const item = { dataset: { videoId: '162' }, addEventListener: (event, fn) => events.set(event, fn) };
  const list = { innerHTML: '', querySelectorAll: () => [item] };
  const modal = { style: {} };
  const heading = {};
  const context = {
    currentPracticeMode: 'shadowing', URLSearchParams,
    window: { location: { search: '?mode=shadowing&from=mobile_today_choice', href: '' } },
    document: { getElementById: id => id === 'video-list-container' ? list : id === 'video-select-title' ? heading : modal },
  };
  vm.createContext(context);
  for (const name of ['escapeHtml', 'buildPracticeVideoHref', 'showVideoSelectModal']) vm.runInContext(extract(source, name), context);
  await context.showVideoSelectModal([{ id: 162, title: '<img onerror="alert(1)">', duration_sec: 56, has_subtitles: true }]);
  assert.equal(modal.style.display, 'flex');
  assert.match(list.innerHTML, /0:56/);
  assert.match(list.innerHTML, /有字幕/);
  assert.match(list.innerHTML, /&lt;img/);
  assert.doesNotMatch(list.innerHTML, /<img onerror/);
  events.get('click')();
  const target = new URL(context.window.location.href, 'https://example.test/');
  assert.equal(target.searchParams.get('mode'), 'shadowing');
  assert.equal(target.searchParams.get('videoId'), '162');
});

test('desktop selection identifies existing subtitles in the lite catalog and escapes card text', () => {
  const list = { innerHTML: '', querySelectorAll: () => [] };
  const context = {
    document: { getElementById: id => id === 'video-list-container' ? list : null },
    showFavoritesOnly: false, currentTagFilter: null, currentCollectionFilter: null, currentSearchQuery: '',
    allVideoList: [], currentDifficultyFilter: null, debugMode: false,
    getDifficultyFilteredVideos: () => [{ id: 162, title: '<img onerror="alert(1)">', duration_sec: 56, has_subtitles: true }],
    renderCollectionFilters() {}, isFavorite: () => false, getVideoThumbnail: () => '/cover.jpg',
    console: { log() {}, error() {} },
  };
  vm.createContext(context);
  vm.runInContext(extract(read('practice-session.html'), 'escapeHtml'), context);
  vm.runInContext(extract(read('practice-session-desktop.html'), 'renderVideoList'), context);
  context.renderVideoList();
  assert.match(list.innerHTML, /0:56/);
  assert.match(list.innerHTML, /有字幕/);
  assert.doesNotMatch(list.innerHTML, /等待AI处理中|<img onerror/);
  assert.match(list.innerHTML, /&lt;img/);
});
