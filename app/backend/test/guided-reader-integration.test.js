const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const practice = require('../../frontend/js/video-reader/first-lesson-practice');
const progress = require('../../frontend/js/video-reader/first-lesson-progress');
const replay = require('../../frontend/js/practice/original-audio-replay');
const { readPage } = require('./helpers/page-source');

function sourceFunction(file, name, indent = '') {
  const source = file === 'js/pages/video-reader-desktop-app.js'
    ? readPage('video-reader-desktop.html')
    : fs.readFileSync(path.resolve(__dirname, '../../frontend', file), 'utf8');
  const asyncStart = source.indexOf(`async function ${name}(`);
  const start = asyncStart >= 0 ? asyncStart : source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} is available to verify its production behavior`);
  const end = source.indexOf(`\n${indent}}`, start);
  assert.notEqual(end, -1);
  return source.slice(start, end + indent.length + 2);
}

function contextFixture() {
  const segments = [
    { text: 'Could you slow down?', start: 0, end: 2, source_indices: [0] },
    { text: 'Let me try again.', start: 2, end: 4, source_indices: [1] },
  ];
  const context = {
    state: { selectedVideoId: 10, currentVideo: { id: 10 }, currentSegments: segments, practiceIndex: 0 },
    firstLessonSession: { isActive: () => true },
    firstLessonGoalCard: { getSentenceIndex: () => context.state.practiceIndex },
    playerEl: { currentTime: 0 }, currentPlayerType: 'local', youtubePlayer: null,
    resolveMobileFirstLessonSubject: () => 'user:one',
    resolveFirstLessonSubject: () => 'user:one',
    videoSelectionGeneration: 4,
    currentDesktopSelectionToken: { generation: 4 },
    videoSelectionGuard: { isCurrent: () => true },
    window: { LinglishFirstLessonPractice: practice, LinglishFirstLessonProgress: progress },
  };
  vm.runInNewContext(sourceFunction('js/pages/video-reader-desktop-app.js', 'currentSegmentIndexByTime', '    '), context);
  vm.runInNewContext(sourceFunction('js/pages/video-reader-desktop-app.js', 'currentFirstLessonSegment', '    '), context);
  const captured = practice.createAssessmentContext({
    subject: 'user:one', videoId: 10,
    stableSegmentId: progress.stableSegmentId(10, segments[0], 0),
    selectionGeneration: 4, displayIndex: 0, sourceIndices: [0],
  });
  return { context, captured };
}

for (const [file, name, indent] of [
  ['js/video-reader/main.js', 'isMobileAssessmentContextCurrent', ''],
  ['js/pages/video-reader-desktop-app.js', 'isDesktopAssessmentContextCurrent', '    '],
]) {
  test(`${name} rejects an assessment after selecting another sentence in the same video`, () => {
    const f = contextFixture();
    const isCurrent = vm.runInNewContext(`(${sourceFunction(file, name, indent)})`, f.context);
    assert.equal(isCurrent(f.captured), true);
    f.context.state.practiceIndex = 1;
    assert.equal(isCurrent(f.captured), false);
  });
}

test('guided desktop original playback stops at its sentence and keeps the selected target', async () => {
  const frames = new Map();
  let nextFrame = 0;
  let time = 0;
  let paused = true;
  const highlighted = [];
  const context = {
    state: { currentVideo: { id: 10 }, currentSegments: [{ start: 0, end: 2, text: 'Could you slow down?' }, { start: 2, end: 4, text: 'Let me try again.' }] },
    window: {
      LinglishOriginalAudioReplay: replay,
      requestAnimationFrame: fn => { frames.set(++nextFrame, fn); return nextFrame; },
      cancelAnimationFrame: id => frames.delete(id),
      setTimeout: () => 1, clearTimeout() {},
    },
    currentPlayerType: 'local', youtubePlayer: null,
    playerEl: { get currentTime() { return time; }, set currentTime(value) { time = value; }, play: async () => { paused = false; }, pause: () => { paused = true; } },
    firstLessonSession: { isActive: () => true }, firstLessonPlaybackLocked: false,
    pauseFirstLessonSourcePlayback: () => { paused = true; }, stopSpokenAudio() {},
    renderActiveSubtitle: index => highlighted.push(index),
    firstLessonGoalCard: { feedback() {} },
  };
  const create = vm.runInNewContext(`(${sourceFunction('js/pages/video-reader-desktop-app.js', 'createDesktopFirstLessonPreview', '    ')})`, context);
  const preview = create();
  await preview.play(0);
  function tick() { const [id, callback] = frames.entries().next().value; frames.delete(id); callback(); }
  tick();
  time = 2.05;
  tick();
  assert.equal(paused, true);
  assert.equal(preview.isPlaying(), false);
  assert.ok(time < 2);
  assert.equal(highlighted.at(-1), 0);
});

test('desktop recording stays on its visible sentence while a YouTube seek is pending', () => {
  const { context, captured } = contextFixture();
  let requestedTime = null;
  context.currentPlayerType = 'youtube';
  context.youtubePlayer = { getCurrentTime: () => 1.98, seekTo: time => { requestedTime = time; } };
  const isCurrent = vm.runInNewContext(`(${sourceFunction('js/pages/video-reader-desktop-app.js', 'isDesktopAssessmentContextCurrent', '    ')})`, context);
  context.youtubePlayer.seekTo(0);
  assert.equal(requestedTime, 0);
  assert.equal(context.currentFirstLessonSegment().index, 0);
  assert.equal(isCurrent(captured), true);
  context.state.practiceIndex = 1;
  assert.equal(isCurrent(captured), false);
});

test('desktop playback highlighting preserves the lesson, while an explicit subtitle selection changes it', () => {
  const { context } = contextFixture();
  let selected = 0;
  let stops = 0;
  Object.assign(context, {
    renderLyricStage() {}, activeSubtitleEl: { dataset: {} }, activeTranslationEl: null,
    syncSubtitleAssist() {}, wrapWordsToHTML: text => text, missedWordsForSegment: () => [],
    firstLessonOriginalController: { stop: () => { stops += 1; } },
    firstLessonGoalCard: { setSentence: sentence => { selected = sentence.index; } },
  });
  const render = vm.runInNewContext(`(${sourceFunction('js/pages/video-reader-desktop-app.js', 'renderActiveSubtitle', '    ')})`, context);
  render(1, false);
  assert.equal(selected, 0, 'media timing must not retarget a speaking card');
  assert.equal(stops, 0);
  render(1);
  assert.equal(selected, 1, 'deliberate transcript selection must retarget the card');
  assert.equal(stops, 1, 'a deliberate selection cancels the old sentence preview');
});

test('guided desktop subtitles load while the YouTube iframe is pending and are not reloaded on ready', async () => {
  const loads = [];
  let ready;
  const pending = new Promise(resolve => { ready = resolve; });
  const noop = () => {};
  const context = {
    window: {}, state: { currentVideo: null }, firstLessonGoal: null,
    firstLessonSession: { isActive: () => true },
    firstLessonGoalCard: { hide: noop },
    leaveForCoach: () => false, teardownFirstLessonRecording: noop, rememberStudyVideo: noop,
    transcriptFetchKey: '', transcriptFetchPromise: null,
    clearTranscriptCues: noop, renderTranscript: noop, renderActiveSubtitle: noop, syncActive: noop,
    videoSelectionGuard: { begin: () => ({ generation: 1 }), isCurrent: () => true },
    currentDesktopSelectionToken: null, pendingSeek: null,
    document: { querySelector: () => null, getElementById: () => null },
    localStorage: { setItem: noop }, headers: () => ({}), API_BASE: '',
    fetch: async () => ({ json: async () => ({ needsProxy: false }) }),
    playerEl: { style: {} }, youtubePlayerEl: { style: {} },
    youtubePlayer: null, currentPlayerType: null,
    YouTubePlayer: class { init() { return pending; } on() {} destroy() {} },
    currentTitleEl: {}, progressSaveState: {}, _lastActiveIdx: -1, _lastActiveElement: null,
    openSourceBtn: {}, importWordsBtn: {},
    renderVideoList: noop, setPlayerOverlay: noop, tOverlay: (_key, fallback) => fallback,
    renderVideoIntro: noop, updateVideoMeta: noop, updateVideoProgress: noop,
    setExtractButtonState: noop, stopWatchTimer: noop, debugLog: noop,
    applyPendingSeekToYouTube: noop, updateNextVideoCard: noop,
    autoImportVocabulary: async () => {},
    loadCurrentTranscript: async (video, token) => { loads.push([video.id, token.generation]); },
  };
  vm.runInNewContext(sourceFunction('js/pages/video-reader-desktop-app.js', 'beginTranscriptLoad', '    '), context);
  const select = vm.runInNewContext(`(${sourceFunction('js/pages/video-reader-desktop-app.js', 'selectVideo', '    ')})`, context);
  const selection = select({ id: 10, title: 'English practice', youtube_video_id: 'example-id' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(loads.length, 1, 'available English text must not wait for a third-party iframe');
  ready();
  await selection;
  assert.equal(loads.length, 1, 'player readiness must not reset the prepared lesson');
  assert.deepEqual(loads[0], [10, 1]);
});


test('desktop transcript requests share a promise per selection generation and keep newer loading state', async () => {
  const pending = [];
  let generation = 1;
  const context = {
    state: { currentVideo: { id: 10 }, isLoadingTranscript: false },
    transcriptFetchKey: '', transcriptFetchPromise: null,
    videoSelectionGuard: { isCurrent: token => token.generation === generation },
    clearTranscriptCues() {}, renderTranscript() {}, renderActiveSubtitle() {}, syncActive() {},
    loadCurrentTranscript: (_video, token) => new Promise(resolve => pending.push({ token, resolve })),
  };
  const begin = vm.runInNewContext(`(${sourceFunction('js/pages/video-reader-desktop-app.js', 'beginTranscriptLoad', '    ')})`, context);
  const first = begin({ id: 10 }, { generation: 1 });
  const shared = begin({ id: 10 }, { generation: 1 });
  assert.equal(shared, first, 'callers must receive the actual shared in-flight load');
  assert.equal(pending.length, 1);
  generation = 2;
  const next = begin({ id: 10 }, { generation: 2 });
  assert.notEqual(next, first, 'reselecting the same video must start a fresh generation');
  assert.equal(pending.length, 2);
  pending[0].resolve();
  await first;
  assert.equal(context.state.isLoadingTranscript, true, 'an old selection cannot settle the new request');
  pending[1].resolve();
  await next;
  assert.equal(context.state.isLoadingTranscript, false);
});


test('mobile guided recordings remain available in both the studio and shared recording cache', async () => {
  const recording = { size: 42 };
  const line = { index: 0, text: 'Could you slow down?' };
  const captured = { displayIndex: 0 };
  const cached = [];
  const studio = [];
  const context = {
    token: 'session-token', state: { selectedVideoId: 10 }, mobileSegmentPosition: 1,
    rememberLastRecording: (...args) => cached.push(args),
    firstLessonGoalCard: { setRecording: blob => studio.push(blob) },
    isMobileAssessmentContextCurrent: value => value === captured,
    window: { LinglishFirstLessonPractice: { submitAssessment: async () => null } },
    fetch() {}, API_BASE: '/api', console,
  };
  const submit = vm.runInNewContext(`(${sourceFunction('js/video-reader/main.js', 'submitPracticeRecording')})`, context);
  await submit(recording, line, captured);
  assert.deepEqual(cached, [[recording, 0]]);
  assert.deepEqual(studio, [recording]);
});

test('mobile guided feedback supplies recognition and missed words for the assessed sentence', () => {
  const settled = [];
  const context = {
    state: { practiceIndex: 0, practiceLineWordResults: {} },
    firstLessonSession: { isActive: () => true },
    firstLessonGoalCard: { settle: (...args) => settled.push(args) },
    window: { LinglishFirstLessonGoal: require('../../frontend/js/video-reader/first-lesson-goal') },
    computePracticeWordMatches: () => ({ missingWords: ['slow'] }),
    renderPracticeCurrentLine() {}, updatePracticeButtons() {},
  };
  const handle = vm.runInNewContext(`(${sourceFunction('js/video-reader/main.js', 'handlePracticeResult')})`, context);
  handle({ success: false, similarity: 0.5, recognizedText: 'Could you down?', targetText: 'Could you slow down?' }, { index: 0 });
  assert.equal(settled.length, 1);
  assert.equal(settled[0][1].success, false);
  assert.equal(settled[0][1].recognizedText, 'Could you down?');
  assert.deepEqual(Array.from(settled[0][1].missedWords), ['slow']);
});

for (const target of ['.goal-studio', '.topbar', 'summary']) {
  test(`native playback shortcuts preserve ${target} keyboard actions`, () => {
    const context = {};
    const typing = vm.runInNewContext(`(${sourceFunction('js/video-reader/pro-controls.js', 'isTypingTarget', '  ')})`, context);
    const element = {
      tagName: target === 'summary' ? 'SUMMARY' : 'BUTTON',
      closest: selector => selector === target ? {} : null,
      getAttribute: () => null,
    };
    assert.equal(typing(element), true);
  });
}
