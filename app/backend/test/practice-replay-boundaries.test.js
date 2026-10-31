const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const replayApi = require('../../frontend/js/practice/original-audio-replay');

const { readPage } = require('./helpers/page-source');
function read(page) { return readPage(page); }
function extract(source, name) {
  const match = source.match(new RegExp(`(^[ \\t]*)(?:async )?function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^\\1\\}`, 'm'));
  assert.ok(match, name);
  return match[0];
}

function localPlaybackContext(play) {
  const elements = new Map();
  const video = {
    currentTime: 26, paused: true, muted: false, volume: 1,
    play() { return play.call(this); },
    pause() { this.paused = true; },
  };
  const context = {
    window: { LinglishOriginalAudioReplay: replayApi },
    shadowingPlaybackGuard: null, shadowingSentenceEnded: false,
    shadowingCurrentIndex: 0, shadowingSentences: [{ startTime: 26, endTime: 27, text: 'Test sentence.' }],
    shadowingWaitingTimeout: null, shadowingProgressTimer: null,
    shadowingLastStopIndex: null, shadowingLastStopTime: null,
    videoPlayer: video, youtubePlayer: null, isYouTubeVideo: false,
    unifiedPlayer: { getCurrentTime: () => video.currentTime }, state: { videoId: 1, videoData: {} },
    getSegmentationMode: () => 'caption', computeShadowingSeekTime: () => 26,
    computeShadowingTargetEndTime: () => 27.25,
    setupAutoPauseForSentence() {}, updateShadowingStatus() {}, updateShadowingDisplay() {},
    document: {
      body: { classList: { add() {} } },
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, { style: {}, classList: { remove() {} } });
        return elements.get(id);
      },
    },
    setTimeout() { return 1; }, clearTimeout() {}, setInterval() { return 1; }, clearInterval() {},
    console: { log() {}, warn() {}, error() {} },
  };
  vm.createContext(context);
  return { context, video, elements };
}

for (const page of ['practice-session.html', 'practice-session-desktop.html']) {
  test(`${page}: cancelling a pending local play does not start a muted retry`, async () => {
    let calls = 0;
    let rejectPlay;
    const pending = new Promise((resolve, reject) => { rejectPlay = reject; });
    const { context, video } = localPlaybackContext(function () {
      calls++;
      if (calls === 1) return pending;
      this.paused = false;
      return Promise.resolve();
    });
    for (const name of ['createShadowingPlaybackGuard', 'playCurrentSentenceAuto']) {
      vm.runInContext(extract(read(page), name), context);
    }
    const task = context.playCurrentSentenceAuto({ forceSeek: true });
    video.pause();
    context.shadowingPlaybackGuard = null;
    rejectPlay(new Error('play interrupted by pause'));
    await task;
    assert.equal(calls, 1);
    assert.equal(video.paused, true);
  });

  test(`${page}: cancelling the initial user play does not enter automatic fallback`, async () => {
    let rejectPlay;
    let fallbacks = 0;
    const pending = new Promise((resolve, reject) => { rejectPlay = reject; });
    const { context, video } = localPlaybackContext(() => pending);
    context.playCurrentSentenceAuto = () => { fallbacks++; };
    for (const name of ['createShadowingPlaybackGuard', 'startAutoShadowing']) {
      vm.runInContext(extract(read(page), name), context);
    }
    const task = context.startAutoShadowing();
    video.pause();
    context.shadowingPlaybackGuard = null;
    context.shadowingAutoMode = false;
    context.state.autoMode = false;
    rejectPlay(new Error('play interrupted by pause'));
    await task;
    assert.equal(fallbacks, 0);
    assert.equal(context.state.autoMode, false);
  });

  test(`${page}: a stale manual-play overlay cannot restart a cancelled sentence`, async () => {
    let calls = 0;
    const { context, elements } = localPlaybackContext(() => {
      calls++;
      return Promise.reject(new Error('autoplay denied'));
    });
    for (const name of ['createShadowingPlaybackGuard', 'playCurrentSentenceAuto']) {
      vm.runInContext(extract(read(page), name), context);
    }
    await context.playCurrentSentenceAuto({ forceSeek: true });
    assert.equal(calls, 2);
    context.shadowingPlaybackGuard = null;
    await elements.get('play-overlay').onclick();
    assert.equal(calls, 2);
  });

  test(`${page}: cancelling a pending muted retry does not restore its overlay`, async () => {
    let calls = 0;
    let rejectRetry;
    let notifyRetry;
    const retryStarted = new Promise((resolve) => { notifyRetry = resolve; });
    const pendingRetry = new Promise((resolve, reject) => { rejectRetry = reject; });
    const { context, video, elements } = localPlaybackContext(() => {
      calls++;
      if (calls === 1) return Promise.reject(new Error('autoplay denied'));
      notifyRetry();
      return pendingRetry;
    });
    for (const name of ['createShadowingPlaybackGuard', 'playCurrentSentenceAuto']) {
      vm.runInContext(extract(read(page), name), context);
    }
    const task = context.playCurrentSentenceAuto({ forceSeek: true });
    await retryStarted;
    video.pause();
    context.shadowingPlaybackGuard = null;
    const overlay = elements.get('play-overlay');
    overlay.style.display = 'none';
    rejectRetry(new Error('play interrupted by pause'));
    await task;
    assert.equal(calls, 2);
    assert.equal(overlay.style.display, 'none');
    assert.equal(overlay.onclick, undefined);
  });
}

test('mobile playback stops waiting when YouTube cannot become ready or the user cancels', async () => {
  for (const cancelled of [false, true]) {
    let clock = 0;
    let pauses = 0;
    const statuses = [];
    const context = {
      window: { LinglishOriginalAudioReplay: replayApi },
      Date: { now: () => clock },
      shadowingPlaybackGuard: null, shadowingSentenceEnded: false,
      shadowingCurrentIndex: 0, shadowingSentences: [{ startTime: 26, endTime: 27 }],
      shadowingWaitingTimeout: null, shadowingProgressTimer: null,
      videoPlayer: null, youtubePlayer: { seekTo() {}, getPlayerState: () => undefined },
      youtubePlayerInitializing: true, state: {},
      getSegmentationMode: () => 'caption', computeShadowingTargetEndTime: () => 27.25,
      setupAutoPauseForSentence() {},
      pauseAutoShadowing() { pauses++; context.shadowingPlaybackGuard = null; },
      updateShadowingStatus: text => statuses.push(text),
      setTimeout(fn, ms) { clock += ms; if (cancelled) context.shadowingPlaybackGuard = null; queueMicrotask(fn); return 1; },
      clearTimeout() {}, console: { log() {}, error() {}, warn() {} },
    };
    vm.createContext(context);
    const source = read('practice-session.html');
    for (const name of ['createShadowingPlaybackGuard', 'playCurrentSentenceAuto']) {
      vm.runInContext(extract(source, name), context);
    }
    await context.playCurrentSentenceAuto();
    assert.equal(pauses, cancelled ? 0 : 1);
    assert.equal(clock, cancelled ? 50 : 8000);
    if (!cancelled) assert.match(statuses.at(-1), /重试/);
  }
});

for (const page of ['practice-session.html', 'practice-session-desktop.html']) {
  for (const youtube of [false, true]) {
    test(`${page}: ${youtube ? 'YouTube' : 'local'} end detection waits for the requested one-second sentence`, async () => {
      let time = 48;
      let pauses = 0;
      let endings = 0;
      const callbacks = new Map();
      const listeners = new Map();
      let timer = 0;
      const video = {
        get currentTime() { return time; }, pause() { pauses++; },
        addEventListener: (name, fn) => listeners.set(name, fn),
        removeEventListener: name => listeners.delete(name),
      };
      const context = {
        window: { LinglishOriginalAudioReplay: replayApi },
        shadowingPlaybackGuard: null, shadowingTargetEndTime: 27.25, shadowingSentenceEnded: false,
        shadowingAutoPauseListener: null, shadowingYouTubePauseInterval: null,
        shadowingCurrentIndex: 0, shadowingSentences: [{ startTime: 26, endTime: 27 }],
        shadowingWaitingTimeout: null, shadowingProgressTimer: null,
        shadowingLastStopIndex: null, shadowingLastStopTime: null,
        videoPlayer: youtube ? null : video, isYouTubeVideo: youtube, youtubePlayerInitializing: false,
        youtubePlayer: youtube ? {
          getCurrentTime: () => time, getPlayerState: () => 1,
          seekTo() {}, playVideo() {}, pauseVideo() { pauses++; },
          isMuted: () => false, getVolume: () => 100,
        } : null,
        unifiedPlayer: { getCurrentTime: () => time }, state: {},
        getSegmentationMode: () => 'caption', computeShadowingSeekTime: () => 26,
        computeShadowingTargetEndTime: () => 27.25,
        updateShadowingStatus() {}, document: { getElementById: () => null },
        setInterval(fn) { callbacks.set(++timer, fn); return timer; },
        clearInterval(id) { callbacks.delete(id); }, setTimeout() { return 1; }, clearTimeout() {},
        onSentenceEnded() { endings++; context.shadowingSentenceEnded = true; },
        console: { log() {}, warn() {}, error() {} },
      };
      vm.createContext(context);
      const source = read(page);
      for (const name of ['createShadowingPlaybackGuard', 'canFinishShadowingPlayback', 'setupAutoPauseForSentence']) {
        vm.runInContext(extract(source, name), context);
      }
      if (youtube) {
        vm.runInContext(extract(source, 'playCurrentSentenceAuto'), context);
        await context.playCurrentSentenceAuto({ forceSeek: true });
      } else {
        context.createShadowingPlaybackGuard(context.shadowingSentences[0]);
        context.setupAutoPauseForSentence(context.shadowingSentences[0], 27.25);
      }
      function tick() {
        for (const callback of [...callbacks.values(), ...listeners.values()]) callback();
      }
      tick();
      assert.equal(pauses, 0, 'the old position cannot pause the new sentence');
      time = 26.05; tick();
      time = 27.1; tick();
      assert.equal(pauses, 0, 'the sentence tail is still played');
      time = 27.3; tick(); tick();
      assert.equal(pauses, 1);
      assert.equal(endings, 1, 'completion runs once after actual playback');
    });
  }

  test(`${page}: optional waveform work cancels an unresponsive request`, async () => {
    let signal;
    const context = {
      AbortController, URLSearchParams, Float32Array,
      state: { videoId: 162, originalWaveformCache: new Map() },
      waveformOriginalCache: new Map(), waveformSegmentationConfig: { enabled: true },
      window: { location: { search: '?videoId=162' } },
      API_BASE: '', getAuthToken: () => null, refreshAuthToken: () => null, debugMode: false,
      setTimeout(fn) { queueMicrotask(fn); return 1; }, clearTimeout() {},
      fetch(url, options) {
        signal = options.signal;
        if (!signal) return Promise.reject(new Error('missing request deadline'));
        return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
      },
    };
    vm.createContext(context);
    vm.runInContext(extract(read(page), 'fetchOriginalWaveformFromServer'), context);
    const args = page.includes('desktop') ? [26, 27] : [162, 26, 27];
    assert.equal(await context.fetchOriginalWaveformFromServer(...args), null);
    assert.ok(signal?.aborted);
  });

  test(`${page}: waveform refinement has one shared budget for all candidate sentences`, async () => {
    let clock = 0;
    const calls = [];
    const context = {
      Date: { now: () => clock },
      waveformSegmentationConfig: { enabled: true, maxSplits: 24, minDurationSec: 2, minWords: 1 },
      segStart: segment => segment.start, segEnd: segment => segment.end,
      getSegText: segment => segment.text, isWaveformUsable: () => false,
      async fetchOriginalWaveformFromServer(...args) {
        const budget = args.at(-1);
        calls.push(budget);
        clock += budget;
        return null;
      },
    };
    vm.createContext(context);
    vm.runInContext(extract(read(page), 'splitSegmentsByWaveformSilence'), context);
    const segments = Array.from({ length: 24 }, (_, index) => ({ start: index * 5, end: index * 5 + 4, text: 'A complete sentence to learn.' }));
    const result = await context.splitSegmentsByWaveformSilence(segments, 162);
    assert.equal(JSON.stringify(result), JSON.stringify(segments));
    assert.deepEqual(calls, [2000], 'a stalled first request cannot multiply the delay by the number of sentences');
  });
}
