const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.resolve(__dirname, '../../frontend/practice-session-desktop.html'), 'utf8');
const replayApi = require('../../frontend/js/practice/original-audio-replay');
function registerReplayHelpers(context) {
  context.shadowingPlaybackGuard = null;
  context.window = { LinglishOriginalAudioReplay: replayApi };
  for (const name of ['createShadowingPlaybackGuard', 'canFinishShadowingPlayback']) {
    const source = html.match(new RegExp(`^    function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^    \\}`, 'm'));
    assert.ok(source);
    vm.runInContext(source[0], context);
  }
}
function harness(mode) {
  const calls = [];
  let handler;
  const context = {
    currentPracticeMode: mode, state: { isRecording: false },
    document: {
      addEventListener(name, callback) { if (name === 'keydown') handler = callback; },
      getElementById(id) { return { disabled: false, click: () => calls.push(id) }; },
      querySelector() { return { style: { display: 'grid' } }; },
    },
    dialoguePracticeState: {}, Date,
    togglePracticePlayback: () => calls.push('playback'),
    handleFocusPrevSentence: () => calls.push('previous'),
    handleFocusNextSentence: () => calls.push('next'),
  };
  const start = html.indexOf("    document.addEventListener('keydown', (e) => {", html.indexOf('// 键盘快捷键支持'));
  const end = html.indexOf('    // 显示快捷键提示', start);
  assert.ok(start >= 0 && end > start);
  vm.runInNewContext(html.slice(start, end), context);
  return {
    calls, context,
    press(key, options = {}) {
      handler({ key, target: { tagName: 'BUTTON' }, preventDefault() {}, ...options });
    },
  };
}

for (const mode of ['shadowing', 'dialogue']) {
  test(`${mode}: Space controls playback and arrows use the same sentence actions as the toolbar`, () => {
    const env = harness(mode);
    env.press(' '); env.press('ArrowLeft'); env.press('ArrowRight'); env.press('Enter');
    assert.deepEqual(env.calls, ['playback', 'previous', 'next']);
  });
  test(`${mode}: typing, modified and repeated keys do not trigger playback`, () => {
    const env = harness(mode);
    env.press(' ', { target: { tagName: 'INPUT' } });
    env.press(' ', { target: { tagName: 'DIV', isContentEditable: true } });
    env.press(' ', { ctrlKey: true });
    env.press(' ', { repeat: true });
    assert.deepEqual(env.calls, []);
  });
}

test('sentence navigation stays blocked while a recording is in progress', () => {
  const env = harness('dialogue');
  env.context.state.isRecording = true;
  env.press('ArrowLeft'); env.press('ArrowRight');
  assert.deepEqual(env.calls, []);
});

test('clicking a highlighted subtitle seeks the active player; a double-click opens its dictionary', () => {
  const events = new Map();
  const calls = [];
  const li = {
    dataset: { start: '10', end: '20', arrayIndex: '1', canonicalIndex: '1' },
    classList: { toggle() {} },
  };
  const vocab = { dataset: { word: 'learning' } };
  const list = { contains: () => true, addEventListener: (name, handler) => events.set(name, handler) };
  const context = {
    document: { getElementById: () => list },
    state: { isRecording: false }, currentPracticeMode: 'dialogue',
    unifiedPlayer: { setCurrentTime: time => calls.push(['seek', time]) },
    videoPlayer: { set currentTime(_) { throw new Error('must not seek the hidden HTML5 player'); } },
    safePlayVideo: () => calls.push(['play']),
    highlightCurrentSegment() {}, renderPracticeCurrentLine() {},
    openPracticeDictionary: word => calls.push(['dictionary', word]),
  };
  const start = html.indexOf("    const practiceLineList = document.getElementById('practice-line-list');");
  const end = html.indexOf("    const practiceFeedbackEl =", start);
  vm.runInNewContext(html.slice(start, end), context);
  const event = {
    detail: 1, preventDefault() {}, stopPropagation() {},
    target: { closest: selector => selector === '.vocab-word' ? vocab : selector === '.line-item' ? li : null },
  };
  events.get('click')(event);
  assert.deepEqual(calls, [['seek', 10], ['play']]);
  events.get('click')({ ...event, detail: 2 });
  events.get('dblclick')({ ...event, detail: 2 });
  assert.deepEqual(calls, [['seek', 10], ['play'], ['dictionary', 'learning']]);
});

test('shadowing toolbar previous/next and playback preserve the selected sentence and resume intent', () => {
  const calls = [];
  const context = {
    state: { isRecording: false }, currentPracticeMode: 'shadowing',
    shadowingSentences: [{}, {}, {}], shadowingCurrentIndex: 1,
    shadowingLastStopIndex: 0, shadowingLastStopTime: 10,
    pauseAutoShadowing: () => calls.push('pause'),
    startAutoShadowing: options => calls.push(options?.resume ? 'resume' : 'start'),
    updateShadowingDisplay() {}, goToNextSentence: () => calls.push('complete'),
    unifiedPlayer: { isPaused: () => true },
  };
  vm.createContext(context);
  const start = html.indexOf('    function playShadowingSentence(index) {');
  const end = html.indexOf('    // ASR按钮事件监听', start);
  vm.runInContext(html.slice(start, end), context);
  vm.runInContext('handleFocusPrevSentence()', context);
  assert.equal(context.shadowingCurrentIndex, 0);
  assert.deepEqual(calls, ['pause', 'start']);
  vm.runInContext('handleFocusNextSentence()', context);
  assert.equal(context.shadowingCurrentIndex, 1);
  vm.runInContext('togglePracticePlayback()', context);
  assert.equal(calls.at(-1), 'resume');
});

test('resuming local shadowing keeps its playback position; an explicit sentence selection restarts it', async () => {
  const player = { currentTime: 7, paused: true, async play() { this.paused = false; } };
  const context = {
    shadowingAutoMode: false, state: {}, videoPlayer: player, isYouTubeVideo: false,
    shadowingSentences: [{ startTime: 0, endTime: 10 }], shadowingCurrentIndex: 0,
    shadowingProgressTimer: null, shadowingTargetEndTime: null,
    document: { getElementById: () => null, body: { classList: { add() {} } } },
    computeShadowingSeekTime: () => 0, computeShadowingTargetEndTime: () => 10,
    setupAutoPauseForSentence() {}, updateShadowingDisplay() {}, console,
    setInterval: () => 1, clearInterval() {},
  };
  const start = html.indexOf('    async function startAutoShadowing(');
  const end = html.indexOf('    let shadowingWaitingInterval', start);
  vm.createContext(context);
  registerReplayHelpers(context);
  vm.runInContext(html.slice(start, end), context);
  await context.startAutoShadowing({ resume: true });
  assert.equal(player.currentTime, 7);
  await context.startAutoShadowing();
  assert.equal(player.currentTime, 0);
});

test('YouTube shadowing resumes mid-sentence and restarts a sentence that has already ended', async () => {
  let time = 7;
  const seeks = [];
  const context = {
    shadowingSentences: [{ startTime: 0, endTime: 10 }], shadowingCurrentIndex: 0,
    videoPlayer: null, isYouTubeVideo: true,
    youtubePlayer: { getCurrentTime: () => time, seekTo(value) { seeks.push(value); time = value; }, playVideo() {} },
    unifiedPlayer: { getCurrentTime: () => time },
    shadowingWaitingTimeout: null, shadowingProgressTimer: null,
    shadowingLastStopIndex: null, shadowingLastStopTime: null,
    getSegmentationMode: () => 'smart', computeShadowingSeekTime: () => 0,
    computeShadowingTargetEndTime: () => 10, setupAutoPauseForSentence() {}, updateShadowingStatus() {},
    document: { getElementById: () => null },
    clearTimeout() {}, clearInterval() {}, setInterval: () => 1,
  };
  vm.createContext(context);
  registerReplayHelpers(context);
  const start = html.indexOf('    async function playCurrentSentenceAuto(');
  const end = html.indexOf('    function onSentenceEnded()', start);
  vm.runInContext(html.slice(start, end), context);
  await context.playCurrentSentenceAuto({ resume: true });
  assert.deepEqual(seeks, []);
  time = 12;
  await context.playCurrentSentenceAuto({ resume: true });
  assert.deepEqual(seeks, [0]);
});
