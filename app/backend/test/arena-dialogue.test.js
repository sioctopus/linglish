const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sourceDir = path.resolve(__dirname, '../../frontend/js/video-reader');
const mainSource = fs.readFileSync(path.join(sourceDir, 'main.js'), 'utf8');
const arenaSource = fs.readFileSync(path.join(sourceDir, 'arena-dialogue.js'), 'utf8');
const bridgeSource = fs.readFileSync(path.resolve(sourceDir, '../practice/voice-chat-bridge.js'), 'utf8');

function extractFunction(name) {
  const match = mainSource.match(new RegExp(`(^[ \\t]*)(?:async )?function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^\\1\\}`, 'm'));
  assert.ok(match, name);
  return match[0];
}

function classList(initial = []) {
  const values = new Set(initial);
  return {
    contains: value => values.has(value),
    add: (...items) => items.forEach(value => values.add(value)),
    remove: (...items) => items.forEach(value => values.delete(value)),
    toggle(value, force) {
      const on = force === undefined ? !values.has(value) : force;
      if (on) values.add(value); else values.delete(value);
      return on;
    },
  };
}

function element() {
  return {
    hidden: false, disabled: false, textContent: '', innerHTML: '',
    classList: classList(), setAttribute() {}, addEventListener() {},
    querySelector() { return null; },
  };
}

function harness(segments) {
  let clock = 0;
  let timerId = 0;
  let pauses = 0;
  const timers = new Map();
  const renders = [];
  const listeners = new Map();
  const controls = new Map();
  for (const selector of ['[data-arena-status]', '[data-arena-progress]', '[data-arena-roles]', '[data-arena-start]', '[data-arena-stop]', '.arena-dock-setup']) {
    controls.set(selector, element());
  }
  const ids = new Map(['arena-dock', 'mobile-hold', 'mobile-speak-hint'].map(id => [id, element()]));
  const video = {
    currentTime: 0, paused: true, playbackRate: 1,
    play() { this.paused = false; return Promise.resolve(); },
    pause() { pauses++; this.paused = true; },
  };
  const transport = {
    getCurrentTime: () => video.currentTime,
    getPlaybackRate: () => video.playbackRate,
    seek: time => { video.currentTime = time; },
    play: () => video.play(), isPlaying: () => !video.paused,
  };
  const state = { currentSegments: segments, activeSegmentIndex: 0 };
  const context = {
    state, LinglishVideoReaderState: state,
    document: {
      readyState: 'loading',
      body: { dataset: { studyMode: 'arena' }, classList: classList(['study-mode-arena']) },
      getElementById: id => ids.get(id) || null,
      querySelector: selector => controls.get(selector) || null,
      addEventListener() {},
    },
    location: { search: '' }, URLSearchParams,
    addEventListener: (name, callback) => listeners.set(name, callback),
    Date: { now: () => clock },
    setInterval(callback) { timers.set(++timerId, callback); return timerId; },
    clearInterval: id => timers.delete(id),
    videoPlayer: video, youtubePlayer: null,
    coachingTransport: () => transport,
    renderMobileTranscriptWindow: index => renders.push(index),
    syncMobilePlayButton() {}, safePlayVideo: () => video.play(),
    mobileSegmentPosition: null, lastSegmentIndex: -1,
    mobileSegmentPlayback: null,
    console,
  };
  context.window = context;
  vm.createContext(context);
  for (const name of ['resolveMobileSegmentIndexAtTime', 'getMobileShadowSegment', 'pauseLearningVideoNow', 'playSegmentBoundsForShadow', 'toggleMobilePlayPause']) {
    vm.runInContext(extractFunction(name), context);
  }
  if (mainSource.includes('function cancelMobileSegmentPlayback(')) {
    vm.runInContext(extractFunction('cancelMobileSegmentPlayback'), context);
  }
  const apiStart = mainSource.indexOf('window.LinglishMobilePlayback = {');
  vm.runInContext(mainSource.slice(apiStart, mainSource.indexOf('\n};', apiStart) + 3), context);
  vm.runInContext(arenaSource, context);
  const arena = context.LinglishArenaDialogue;
  arena.sync();
  return {
    context, arena, video, state, timers, controls, renders, listeners, ids,
    setClock: time => { clock = time; },
    tick() { for (const callback of [...timers.values()]) callback(); },
    get pauses() { return pauses; },
  };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

function installBridge(h, save) {
  let options;
  h.context.location.pathname = '/video-reader.html';
  h.context.URL = URL;
  h.state.currentVideo = { id: 'A' };
  h.ids.set('voice-chat-coach', element());
  h.context.LinglishShadowRecordingCache = { save };
  h.context.LinglishVoiceChatCoach = {
    create(config) {
      options = config;
      let holding = false;
      return {
        beginHold() {
          if (holding) return;
          holding = true;
          config.onHoldStart({ index: h.context.LinglishMobilePlayback.getIndex() });
        },
        lockPracticeTarget() {},
      };
    },
  };
  vm.runInContext(bridgeSource, h.context);
  h.context.LinglishVoiceChatBridge.mount();
  return { bridge: h.context.LinglishVoiceChatBridge, options };
}

// Keeping the old media clock as the Hold target strands the second learner cue.
test('consecutive learner cues record the arena selection instead of the paused player clock', async () => {
  const h = harness([
    { start: 0, end: 1, text: 'First.', speaker: 'Learner' },
    { start: 2, end: 3, text: 'Second.', speaker: 'Learner' },
    { start: 4, end: 5, text: 'Partner.', speaker: 'Partner' },
  ]);
  h.arena.selectRole('Learner');
  h.arena.start();
  assert.equal(h.context.getMobileShadowSegment().index, 0);
  h.arena.onHoldComplete({ index: 0, runToken: h.arena.getRunToken() });
  assert.equal(h.video.currentTime, 0, 'learner selections do not require playing the cue');
  assert.equal(h.context.getMobileShadowSegment().index, 1);
  assert.equal(h.state.activeSegmentIndex, 1, 'the voice bridge receives the same recording target');
  h.arena.onHoldComplete({ index: h.context.getMobileShadowSegment().index, runToken: h.arena.getRunToken() });
  assert.equal(h.context.LinglishMobilePlayback.getIndex(), 2);
  assert.equal(h.arena.isAwaitingHold(), false);
  h.arena.stop(true);
  await flush();
});

test('partner playback timeout stays on that cue and offers a retry', async () => {
  const h = harness([
    { start: 0, end: 1, text: 'Partner.', speaker: 'Partner' },
    { start: 2, end: 3, text: 'Learner.', speaker: 'Learner' },
  ]);
  h.arena.selectRole('Learner');
  h.arena.start();
  h.setClock(4000);
  h.tick();
  await flush();
  assert.equal(h.context.LinglishMobilePlayback.getIndex(), 0);
  assert.equal(h.arena.isAwaitingHold(), false);
  assert.equal(h.controls.get('[data-arena-start]').disabled, false);
  assert.equal(h.controls.get('.arena-dock-setup').hidden, false);
  h.arena.start();
  assert.equal(h.context.LinglishMobilePlayback.getIndex(), 0);
  h.video.currentTime = 1;
  h.tick();
  await flush();
  assert.equal(h.context.LinglishMobilePlayback.getIndex(), 1, 'only successful replay advances');
  assert.equal(h.arena.isAwaitingHold(), true);
});

for (const { rate, duration, elapsed, position } of [
  { rate: 0.5, duration: 4, elapsed: 5300, position: 2.65 },
  { rate: 0.75, duration: 4, elapsed: 5300, position: 3.9 },
  { rate: 0.75, duration: 40, elapsed: 20000, position: 15 },
]) {
  test(`${duration}s partner cue at ${rate}x keeps playing while media progresses`, async () => {
    const h = harness([
      { start: 0, end: duration, speaker: 'Partner' },
      { start: duration + 1, end: duration + 2, speaker: 'Learner' },
    ]);
    h.video.playbackRate = rate;
    h.arena.selectRole('Learner');
    h.arena.start();
    h.setClock(elapsed);
    h.video.currentTime = position;
    h.tick();
    await flush();
    assert.equal(h.video.paused, false);
    assert.equal(h.controls.get('[data-arena-start]').disabled, true, 'progressing playback must not offer a timeout retry');
    h.setClock(duration / rate * 1000);
    h.video.currentTime = duration;
    h.tick();
    await flush();
    assert.equal(h.context.LinglishMobilePlayback.getIndex(), 1);
    assert.equal(h.arena.isAwaitingHold(), true);
  });
}

test('slow playback still times out if media stops progressing', async () => {
  const h = harness([{ start: 0, end: 40, speaker: 'Partner' }, { start: 41, end: 42, speaker: 'Learner' }]);
  h.video.playbackRate = 0.5;
  h.arena.selectRole('Learner');
  h.arena.start();
  h.setClock(1000);
  h.video.currentTime = 0.5;
  h.tick();
  h.setClock(8000);
  h.tick();
  await flush();
  assert.equal(h.video.paused, true);
  assert.equal(h.controls.get('[data-arena-start]').disabled, false);
  assert.equal(h.context.LinglishMobilePlayback.getIndex(), 0);
});

for (const result of ['missing', 'cancelled', 'error']) {
  test(`partner ${result} result never counts as a completed line`, async () => {
    const h = harness([
      { start: 0, end: 1, speaker: 'Partner' },
      { start: 2, end: 3, speaker: 'Learner' },
    ]);
    h.context.LinglishMobilePlayback.playSegmentBounds = () => result === 'error'
      ? Promise.reject(new Error('playback failed')) : Promise.resolve(result);
    h.arena.selectRole('Learner');
    h.arena.start();
    await flush();
    assert.equal(h.context.LinglishMobilePlayback.getIndex(), 0);
    assert.equal(h.arena.isAwaitingHold(), false);
    assert.equal(h.controls.get('[data-arena-start]').disabled, false);
    h.arena.stop(true);
  });
}

test('stopping arena releases its poll and callback before normal playback resumes', async () => {
  const h = harness([
    { start: 0, end: 1, speaker: 'Partner' },
    { start: 2, end: 3, speaker: 'Learner' },
  ]);
  h.arena.selectRole('Learner');
  h.arena.start();
  const oldTick = [...h.timers.values()][0];
  const oldEnded = h.state.segmentPlaybackCallback;
  h.arena.stop(true);
  h.context.toggleMobilePlayPause();
  const newEnded = () => {};
  h.state.segmentPlaybackEnd = 20;
  h.state.segmentPlaybackCallback = newEnded;
  h.context.LinglishMobilePlayback.setIndex(1);
  const pauses = h.pauses;
  const renderCount = h.renders.length;
  h.video.currentTime = 3;
  h.setClock(16000);
  oldTick();
  oldEnded();
  await flush();
  assert.equal(h.video.paused, false);
  assert.equal(h.pauses, pauses, 'obsolete completion cannot pause the new playback');
  assert.equal(h.renders.length, renderCount, 'obsolete completion cannot restore the old cue');
  assert.equal(h.state.segmentPlaybackEnd, 20);
  assert.equal(h.state.segmentPlaybackCallback, newEnded);
  assert.equal(h.timers.size, 0);
});

test('a new bounded replay cancels the previous lease without clearing the new boundary', async () => {
  const h = harness([{ start: 0, end: 1 }, { start: 4, end: 5 }]);
  const first = h.context.playSegmentBoundsForShadow({ index: 0, start: 0, end: 1 });
  const oldTick = [...h.timers.values()][0];
  const second = h.context.playSegmentBoundsForShadow({ index: 1, start: 4, end: 5 });
  const newEnded = h.state.segmentPlaybackCallback;
  const pauses = h.pauses;
  oldTick();
  assert.equal(h.pauses, pauses);
  assert.equal(h.state.segmentPlaybackCallback, newEnded);
  assert.equal(h.context.LinglishMobilePlayback.getIndex(), 1);
  h.video.currentTime = 5;
  h.tick();
  assert.equal(await first, 'cancelled');
  assert.equal(await second, 'ok');
});

test('leaving arena cancels playback and later normal-mode sync leaves playback alone', async () => {
  const h = harness([{ start: 0, end: 1, speaker: 'Partner' }, { start: 2, end: 3, speaker: 'Learner' }]);
  h.arena.selectRole('Learner');
  h.arena.start();
  h.context.document.body.dataset.studyMode = 'video';
  h.context.document.body.classList.remove('study-mode-arena');
  h.arena.sync();
  assert.equal(h.arena.isRunning(), false);
  assert.equal(h.timers.size, 0);
  assert.equal(h.state.segmentPlaybackCallback, null);
  h.context.toggleMobilePlayPause();
  const pauses = h.pauses;
  h.arena.sync();
  assert.equal(h.video.paused, false);
  assert.equal(h.pauses, pauses);
  await flush();
});

test('normal reader Hold continues following the media clock outside an arena run', () => {
  const h = harness([{ start: 0, end: 1 }, { start: 4, end: 5 }]);
  h.context.LinglishMobilePlayback.setIndex(0);
  h.video.currentTime = 4.5;
  assert.equal(h.context.getMobileShadowSegment().index, 1);
});

test('cancelling a normal shadow preview does not pause resumed playback or re-arm its old Hold', async () => {
  const h = harness([{ start: 0, end: 1 }, { start: 4, end: 5 }]);
  Object.assign(h.context, {
    mobileShadowIgnoreClickUntil: 0, mobileShadowBusy: false,
    mobileShadowAwaitHold: false, mobileShadowHolding: false, mobileShadowStop: null,
    mobileShadowHoldSegment: null, mobileShadowDocListenBound: false, mobilePlayLongPressTimer: 0,
    mobilePlayBtn: null,
    syncMobilePlayHoldLabel() {}, syncMobileShadowButton() {}, setMobileSpeakHint() {},
    LinglishShadowMic: {
      recordShadow() {}, acquireMic: async () => ({}), stopTracks() {},
    },
  });
  for (const name of ['startMobileSentenceShadow', 'resetMobileShadowUi', 'unbindMobileShadowDocListen', 'clearMobilePlayLongPressTimer']) {
    vm.runInContext(extractFunction(name), h.context);
  }
  const preview = h.context.startMobileSentenceShadow();
  await flush();
  h.context.LinglishMobilePlayback.cancelSegmentPlayback();
  h.video.pause();
  h.context.toggleMobilePlayPause();
  const pauses = h.pauses;
  await preview;
  assert.equal(h.video.paused, false);
  assert.equal(h.pauses, pauses);
  assert.equal(h.context.mobileShadowAwaitHold, false);
  assert.equal(h.context.mobileShadowHoldSegment, null);
  assert.equal(h.context.mobileShadowBusy, false);
});

for (const scenario of ['restart-after-save-start', 'restart-before-recorded', 'rejected-restart-hold', 'video-change-during-save', 'current-hold']) {
  test(`recording completion respects its Hold run and video ownership: ${scenario}`, async () => {
    let finishSave;
    const saved = new Promise(resolve => { finishSave = resolve; });
    const h = harness([
      { start: 0, end: 1, speaker: 'Learner', text: 'First.' },
      { start: 2, end: 3, speaker: 'Learner', text: 'Second.' },
      { start: 4, end: 5, speaker: 'Partner', text: 'Partner.' },
    ]);
    const { bridge, options } = installBridge(h, () => saved);
    h.arena.selectRole('Learner');
    h.arena.start();
    await bridge.beginHold();
    if (scenario === 'restart-before-recorded' || scenario === 'rejected-restart-hold') {
      h.arena.stop(true);
      h.arena.start();
      if (scenario === 'rejected-restart-hold') await bridge.beginHold();
    }
    const completion = options.onRecorded({ blob: new Blob(['take']), url: 'blob:take', index: 0 });
    if (scenario === 'restart-after-save-start') {
      h.arena.stop(true);
      h.arena.start();
    } else if (scenario === 'video-change-during-save') {
      h.state.currentVideo = { id: 'B' };
      h.state.currentSegments = h.state.currentSegments.map(segment => ({ ...segment }));
    }
    finishSave({});
    await completion;
    assert.equal(h.context.LinglishMobilePlayback.getIndex(), scenario === 'current-hold' ? 1 : 0);
    assert.equal(h.arena.isAwaitingHold(), true);
    h.arena.stop(true);
  });
}

test('guided disclosure keeps captions before Hold at phone, tablet, and landscape sizes without replacing controls', {
  skip: process.env.LINGLISH_BROWSER_TESTS !== '1',
}, async () => {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.LINGLISH_CHROME_EXECUTABLE ? { executablePath: process.env.LINGLISH_CHROME_EXECUTABLE } : {}),
  });
  const frontend = path.resolve(sourceDir, '../..');
  const css = ['styles/mobile/pages/video-reader-focus.css', 'styles/first-lesson-goal.css']
    .map(file => fs.readFileSync(path.join(frontend, file), 'utf8')).join('\n');
  const layoutSource = fs.readFileSync(path.join(sourceDir, 'mobile-reader-layout.js'), 'utf8');
  try {
    for (const [width, height] of [[390, 844], [768, 1024], [844, 390]]) {
      const page = await browser.newPage({ viewport: { width, height }, hasTouch: true });
      await page.setContent('<html data-learning-focus="first-lesson"><body class="video-reader-mobile-focus"><main class="video-main-area"><div id="video-wrapper" style="height:220px;flex:0 0 auto"></div><section id="first-lesson-goal" style="height:500px;flex:0 0 auto"></section><details id="guided-reader-tools" class="guided-reader-tools"><summary>字幕、查词与播放设置</summary><div id="mobile-transcript" class="mobile-transcript-view"><div style="height:200px">Fixture captions</div></div><div id="mobile-player-controls" class="mobile-player-controls"><button id="mobile-hold" class="mobile-hold-btn">Hold to record</button></div></details></main></body></html>');
      await page.addStyleTag({ content: css });
      await page.addScriptTag({ content: layoutSource });
      await page.evaluate(() => {
        window.originalNodes = ['mobile-transcript', 'mobile-player-controls', 'mobile-hold'].map(id => document.getElementById(id));
        window.MobileReaderLayout.configureGuidedTools(document.getElementById('guided-reader-tools'), true);
      });
      for (let cycle = 0; cycle < 2; cycle++) {
        assert.equal(await page.locator('#guided-reader-tools').evaluate(el => el.open), false);
        assert.equal(await page.locator('#mobile-hold').isVisible(), false, 'closed disclosure must hide Hold');
        await page.locator('#guided-reader-tools > summary').evaluate(el => el.click());
        const open = await page.evaluate(() => {
          const transcript = document.getElementById('mobile-transcript');
          const controls = document.getElementById('mobile-player-controls');
          return {
            ordered: transcript.getBoundingClientRect().bottom <= controls.getBoundingClientRect().top + 1,
            sameNodes: window.originalNodes.every(node => document.getElementById(node.id) === node),
            sameParent: transcript.parentElement === controls.parentElement,
          };
        });
        assert.equal(open.ordered, true, `${width}×${height}: Hold must follow captions without overlapping`);
        assert.equal(open.sameNodes, true);
        assert.equal(open.sameParent, true);
        assert.equal(await page.locator('#mobile-hold').isVisible(), true);
        await page.locator('#guided-reader-tools > summary').evaluate(el => el.click());
      }
      await page.evaluate(() => {
        delete document.documentElement.dataset.learningFocus;
        window.MobileReaderLayout.configureGuidedTools(document.getElementById('guided-reader-tools'), false);
      });
      assert.equal(await page.locator('#mobile-player-controls').evaluate(el => getComputedStyle(el).position), 'sticky', 'ordinary reader keeps its dock behavior');
      assert.equal(await page.evaluate(() => window.originalNodes.every(node => document.getElementById(node.id) === node)), true);
      await page.close();
    }
  } finally {
    await browser.close();
  }
});
