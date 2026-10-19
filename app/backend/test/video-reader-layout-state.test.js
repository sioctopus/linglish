const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const frontend = path.resolve(__dirname, '../../frontend');
const stateModulePath = path.join(frontend, 'js/video-reader/reader-layout-state.js');
const pagePath = path.join(frontend, 'video-reader-desktop.html');

test('a selected video opens in the simple layout while the library and saved choices remain accessible', () => {
  const { shouldStartFocused } = require(stateModulePath);
  assert.equal(shouldStartFocused({ savedPreference: null, hasVideo: true }), true);
  assert.equal(shouldStartFocused({ savedPreference: null, hasVideo: false }), false);
  assert.equal(shouldStartFocused({ savedPreference: 'false', hasVideo: true }), false);
  assert.equal(shouldStartFocused({ savedPreference: 'true', hasVideo: true }), true);
  assert.equal(shouldStartFocused({ savedPreference: 'false', hasVideo: true, firstLesson: true }), true);
});

test('opening the video library exits focus mode and expands the sidebar', () => {
  assert.equal(fs.existsSync(stateModulePath), true, 'reader layout state module should exist');
  const { toggleVideoLibrary } = require(stateModulePath);

  assert.deepEqual(
    toggleVideoLibrary({ focusMode: true, sidebarCollapsed: true }),
    { focusMode: false, sidebarCollapsed: false }
  );
});

test('video library button still toggles the sidebar outside focus mode', () => {
  assert.equal(fs.existsSync(stateModulePath), true, 'reader layout state module should exist');
  const { toggleVideoLibrary } = require(stateModulePath);

  assert.deepEqual(
    toggleVideoLibrary({ focusMode: false, sidebarCollapsed: false }),
    { focusMode: false, sidebarCollapsed: true }
  );
  assert.deepEqual(
    toggleVideoLibrary({ focusMode: false, sidebarCollapsed: true }),
    { focusMode: false, sidebarCollapsed: false }
  );
});

test('vocabulary view hides the left column and drops the embedded title bar', () => {
  const html = fs.readFileSync(pagePath, 'utf8');
  const vocab = fs.readFileSync(path.join(frontend, 'video-vocabulary-desktop.html'), 'utf8');

  assert.match(html, /classList\.toggle\('vocab-view', isVocab\)/);
  assert.match(html, /\.shell\.vocab-view \.sidebar\s*\{[^}]*display:\s*none/);
  assert.match(html, /\.shell\.vocab-view\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(html, /new URLSearchParams\(\{ embed: '1', level, v \}\)/);
  assert.match(html, /video-vocabulary-desktop\.html\?\$\{params\.toString\(\)\}/);
  assert.doesNotMatch(vocab, /class="topbar"/);
  assert.match(vocab, /html\.vocab-embedded \.page-nav/);
});

test('desktop reader wires the hamburger button to the shared layout transition', () => {
  const html = fs.readFileSync(pagePath, 'utf8');

  assert.match(html, /js\/video-reader\/reader-layout-state\.js/);
  assert.match(html, /LinglishReaderLayoutState\.toggleVideoLibrary/);
  assert.match(html, /toggleSidebarBtn\.setAttribute\('aria-expanded'/);
});

test('vocabulary navigation hides both surrounding columns and preserves embedded navigation on return', () => {
  const vm = require('node:vm');
  const html = fs.readFileSync(pagePath, 'utf8');
  const setView = html.match(/    function setHashView\(hash, opts\) \{[\s\S]*?\n    \}/)?.[0];
  const syncEmbed = html.match(/    function syncVocabEmbed\(videoId, sentence\) \{[\s\S]*?\n    \}/)?.[0];
  const classes = new Set();
  const shell = { classList: { toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); } } };
  let src = '';
  const context = {
    URLSearchParams,
    document: { querySelector: selector => selector === '.shell' ? shell : null },
    tabVideoBtn: { classList: { toggle() {} } }, tabVocabBtn: { classList: { toggle() {} } },
    viewVideoEl: { style: {} }, viewVocabEl: { style: {} },
    syncStudySwitch() {}, vocabFocusVideoId: null, vocabFocusSentence: false,
    resolveVocabLevel: () => 'beginner', resolveVocabVersion: () => 'fixture-version',
    vocabEmbedFrame: { getAttribute: () => src, setAttribute(_name, value) { src = value; }, closest: () => null },
    vocabNativeWrap: { style: {} },
  };
  vm.runInNewContext(`${syncEmbed}; ${setView}; this.setHashView = setHashView;`, context);
  context.setHashView('#vocabulary', { videoId: 7, sentence: true });
  assert.equal(classes.has('vocab-view'), true);
  assert.equal(context.viewVideoEl.style.display, 'none');
  assert.equal(context.viewVocabEl.style.display, '');
  const url = new URL(src, 'https://app.example.test/');
  assert.equal(url.searchParams.get('embed'), '1');
  assert.equal(url.searchParams.get('videoId'), '7');
  assert.equal(url.searchParams.get('sentence'), '1');
  context.setHashView('');
  assert.equal(classes.has('vocab-view'), false);
  assert.equal(context.viewVocabEl.style.display, 'none');
  assert.equal(context.viewVideoEl.style.display, '');
});
