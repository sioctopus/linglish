const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../../frontend/js/pages/video-reader-desktop-app.js'), 'utf8');

function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `missing desktop reader section ${start}`);
  return source.slice(from, to);
}

function element() {
  const classes = new Set();
  return {
    hidden: false, textContent: '', innerHTML: '', dataset: {}, style: {},
    classList: { add: value => classes.add(value), remove: value => classes.delete(value) },
    removeAttribute(key) { delete this.dataset[key.replace('data-', '')]; },
  };
}

function harness() {
  const nodes = Object.fromEntries(['lyric-stage', 'lyric-prev', 'lyric-current', 'lyric-next', 'lyric-translation'].map(id => [id, element()]));
  const active = element();
  const legacyTranslation = element();
  const rows = new Map();
  const context = {
    state: { currentVideo: { id: 113 }, showBilingual: true, currentSegments: [
      { text: 'Welcome back.', translation: '欢迎回来。', start_sec: 0, end_sec: 3 },
      { text: 'Take your time.', cn: '慢慢来。', start_sec: 3, end_sec: 6 },
    ] },
    document: { getElementById: id => nodes[id], querySelector: () => null, createElement: element },
    activeSubtitleEl: active, activeTranslationEl: legacyTranslation,
    firstLessonSession: { isActive: () => false },
    syncSubtitleAssist() {}, missedWordsForSegment: () => new Set(),
    wrapWordsToHTML: text => text, esc: text => text,
    transcriptListEl: { querySelector: selector => rows.get(Number(selector.match(/\d+/)?.[0])) || null },
    desktopTranslateFailed: new Set(), desktopTranslateCache: new Map(),
    bilingualCacheKey: text => text, shouldAutoTranslateSegment: () => false,
    translateText: async () => '', setTimeout: () => 1, clearTimeout() {},
  };
  vm.createContext(context);
  // Exercise the real rendering and asynchronous translation code, replacing only
  // the browser DOM and remote translation request at their boundaries.
  const renderStart = source.includes('    function renderActiveTranslation(')
    ? '    function renderActiveTranslation(' : '    function renderLyricStage(';
  vm.runInContext(section(renderStart, '    function syncSubtitleAssist('), context);
  vm.runInContext(section('    function patchDesktopTranslationDom(', '    function queueVisibleBilingualTranslations('), context);
  return { context, nodes, active, legacyTranslation, rows };
}

test('visible current sentence follows imported Chinese, seeks, display mode, and transcript clearing', () => {
  const { context, nodes, legacyTranslation } = harness();
  context.renderActiveSubtitle(0);
  assert.equal(nodes['lyric-translation'].textContent, '欢迎回来。');
  assert.equal(nodes['lyric-translation'].hidden, false);
  assert.equal(legacyTranslation.textContent, '欢迎回来。');
  context.renderActiveSubtitle(1);
  assert.equal(nodes['lyric-current'].innerHTML, 'Take your time.');
  assert.equal(nodes['lyric-translation'].textContent, '慢慢来。');
  context.state.showBilingual = false;
  context.renderActiveSubtitle(1);
  assert.equal(nodes['lyric-translation'].hidden, true);
  assert.equal(nodes['lyric-translation'].textContent, '');
  context.state.showBilingual = true;
  context.renderActiveSubtitle(1);
  assert.equal(nodes['lyric-translation'].textContent, '慢慢来。');
  context.state.currentSegments = [];
  context.renderActiveSubtitle(-1);
  assert.equal(nodes['lyric-stage'].hidden, true);
  assert.equal(nodes['lyric-translation'].hidden, true);
  assert.equal(nodes['lyric-translation'].textContent, '');
});

test('late translation stays hidden in English mode and appears when bilingual is restored', async () => {
  const { context, nodes, legacyTranslation, rows } = harness();
  context.state.currentSegments[0].translation = '';
  context.renderActiveSubtitle(0);
  let resolve;
  context.translateText = () => new Promise(done => { resolve = done; });
  const row = { translation: null, querySelector() { return this.translation; }, appendChild(node) { this.translation = node; } };
  rows.set(0, row);
  const pending = context.ensureDesktopBilingualTranslations([0]);
  context.state.showBilingual = false;
  context.renderActiveSubtitle(0);
  resolve('欢迎回来。');
  await pending;
  assert.equal(row.translation, null, 'English transcript must not gain a Chinese row');
  assert.equal(nodes['lyric-translation'].hidden, true);
  assert.equal(legacyTranslation.style.display, 'none');
  context.state.showBilingual = true;
  context.renderActiveSubtitle(0);
  assert.equal(nodes['lyric-translation'].textContent, '欢迎回来。');
});

test('translation arriving after a seek updates only its own cue', async () => {
  const { context, nodes } = harness();
  context.state.currentSegments[0].translation = '';
  context.renderActiveSubtitle(0);
  let resolve;
  context.translateText = () => new Promise(done => { resolve = done; });
  const pending = context.ensureDesktopBilingualTranslations([0]);
  context.renderActiveSubtitle(1);
  resolve('欢迎回来。');
  await pending;
  assert.equal(nodes['lyric-translation'].textContent, '慢慢来。');
  context.renderActiveSubtitle(0);
  assert.equal(nodes['lyric-translation'].textContent, '欢迎回来。');
});

test('switching video while translation is pending cannot patch a new video with the old Chinese', async () => {
  const { context, nodes } = harness();
  context.state.currentSegments[0].translation = '';
  context.renderActiveSubtitle(0);
  let resolve;
  context.translateText = () => new Promise(done => { resolve = done; });
  const pending = context.ensureDesktopBilingualTranslations([0]);
  context.state.currentVideo = { id: 114 };
  context.state.currentSegments = [{ text: 'A different video.', translation: '另一段视频。' }];
  context.renderActiveSubtitle(0);
  resolve('旧的视频译文。');
  await pending;
  assert.equal(nodes['lyric-translation'].textContent, '另一段视频。');
  assert.equal(context.state.currentSegments[0].translation, '另一段视频。');
});

test('overlapping visible and background requests retain each in-flight translation', async () => {
  const { context, nodes } = harness();
  context.state.currentSegments.forEach(seg => { delete seg.translation; delete seg.cn; });
  context.renderActiveSubtitle(0);
  const resolvers = {};
  context.translateText = text => new Promise(resolve => { resolvers[text] = resolve; });
  const first = context.ensureDesktopBilingualTranslations([0]);
  const second = context.ensureDesktopBilingualTranslations([0, 1]);
  resolvers['Welcome back.']('欢迎回来。');
  resolvers['Take your time.']('慢慢来。');
  await Promise.all([first, second]);
  assert.equal(context.state.currentSegments[0].translation, '欢迎回来。');
  assert.equal(context.state.currentSegments[1].translation, '慢慢来。');
  assert.equal(nodes['lyric-translation'].textContent, '欢迎回来。');
});

test('compact extraction label still reports progress and restores after a failed request', async () => {
  const label = { textContent: '提取' };
  let click;
  let finish;
  const context = {
    state: { currentVideo: { id: 113 } }, API_BASE: '',
    importWordsBtn: {
      disabled: false, textContent: '提取',
      querySelector: selector => selector === '.import-words__label' ? label : null,
      addEventListener(_type, callback) { click = callback; },
    },
    getToken: () => 'fixture-token', headers: () => ({}), showToast() {}, setExtractButtonState() {},
    fetch: () => new Promise(resolve => { finish = resolve; }),
  };
  vm.createContext(context);
  vm.runInContext(section("    importWordsBtn.addEventListener('click',", "    refreshVideosBtn.addEventListener("), context);
  const pending = click();
  assert.equal(context.importWordsBtn.disabled, true);
  assert.equal(label.textContent, '提取中…');
  finish({ ok: false, json: async () => ({ message: 'Local fixture failure' }) });
  await pending;
  assert.equal(label.textContent, '提取');
  assert.equal(context.importWordsBtn.disabled, false);
});
