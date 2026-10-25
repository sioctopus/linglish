const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { readPage } = require('./helpers/page-source');

const frontend = path.resolve(__dirname, '../../frontend');
const html = readPage('video-reader-desktop.html');
const controls = fs.readFileSync(path.join(frontend, 'js/video-reader/pro-controls.js'), 'utf8');

function keyboardHarness(type = 'local') {
  const listeners = [];
  let time = 12;
  let paused = true;
  let toggles = 0;
  const segments = [{ start_sec: 0 }, { start_sec: 10 }, { start_sec: 20 }];
  const player = {
    get currentTime() { return time; }, set currentTime(value) { time = value; },
    get paused() { return paused; },
    play() { paused = false; toggles += 1; },
    pause() { paused = true; toggles += 1; },
    getCurrentTime() { return time; },
    getPlayerState() { return paused ? 2 : 1; },
    seekTo(value) { time = value; },
  };
  const context = {
    document: {
      addEventListener(event, handler, capture) {
        if (event === 'keydown') listeners.push({ handler, capture: capture === true });
      },
      querySelector() { return null; },
    },
    window: {}, console,
    playerEl: player, youtubePlayer: player, currentPlayerType: type,
    state: { currentSegments: segments },
    currentSegmentIndexByTime: t => t < 10 ? 0 : t < 20 ? 1 : 2,
    highlightActiveSegment() {}, hideDrawer() {},
    gJump: { active: false },
    isTypingTarget: el => ['INPUT', 'TEXTAREA', 'SELECT'].includes(el?.tagName) || !!el?.isContentEditable,
    togglePlay() { paused ? player.play() : player.pause(); },
    jumpSegments(delta) {
      const index = Math.min(2, Math.max(0, context.currentSegmentIndexByTime(time) + delta));
      time = segments[index].start_sec + 0.01;
      player.play();
    },
    getCurrentTime: () => time,
    setCurrentTime(value) { time = value; },
    getDuration: () => 30, showToast() {},
  };
  vm.createContext(context);
  const typingStart = controls.indexOf('  function isTypingTarget(el) {');
  const typingEnd = controls.indexOf('  // Toggle bilingual:', typingStart);
  assert.ok(typingStart >= 0 && typingEnd > typingStart);
  vm.runInContext(controls.slice(typingStart, typingEnd), context);
  const hostStart = html.indexOf("    document.addEventListener('keydown', (ev) => {");
  const hostEnd = html.indexOf('    // Wire dict tab buttons', hostStart);
  assert.ok(hostStart >= 0 && hostEnd > hostStart);
  vm.runInContext(html.slice(hostStart, hostEnd), context);
  const proStart = controls.indexOf("  document.addEventListener('keydown', (e) => {", controls.indexOf('// ---------- 8. Keyboard'));
  const proEnd = controls.indexOf('  // ---------- 9. Boot', proStart);
  assert.ok(proStart >= 0 && proEnd > proStart);
  vm.runInContext(controls.slice(proStart, proEnd), context);
  return {
    dispatch(key, options = {}) {
      const event = {
        key, code: key === ' ' ? 'Space' : key, target: { tagName: 'BUTTON' },
        defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; },
        ...options,
      };
      for (const listener of [...listeners.filter(l => l.capture), ...listeners.filter(l => !l.capture)]) {
        listener.handler(event);
      }
      return event;
    },
    snapshot: () => ({ time, paused, toggles }),
  };
}

for (const type of ['local', 'youtube']) {
  test(`${type}: Space toggles once with both keyboard handlers installed`, () => {
    const harness = keyboardHarness(type);
    harness.dispatch(' ');
    assert.deepEqual(harness.snapshot(), { time: 12, paused: false, toggles: 1 });
    harness.dispatch(' ');
    assert.deepEqual(harness.snapshot(), { time: 12, paused: true, toggles: 2 });
  });
  test(`${type}: arrows jump to sentence starts without an extra five-second seek`, () => {
    const harness = keyboardHarness(type);
    harness.dispatch('ArrowRight');
    assert.equal(harness.snapshot().time, 20.01);
    harness.dispatch('ArrowLeft');
    assert.equal(harness.snapshot().time, 10.01);
  });
}

test('typing, modified keys, held Space and Enter do not accidentally control playback', () => {
  const harness = keyboardHarness();
  harness.dispatch(' ', { target: { tagName: 'INPUT' } });
  harness.dispatch(' ', { ctrlKey: true });
  harness.dispatch('Enter');
  assert.equal(harness.snapshot().toggles, 0);
  harness.dispatch(' ');
  harness.dispatch(' ', { repeat: true });
  assert.equal(harness.snapshot().toggles, 1);
});

test('optional waveform refinement aborts a stalled request and keeps existing subtitles usable', async () => {
  let aborted = false;
  const context = {
    waveformSegmentationConfig: { enabled: true }, waveformOriginalCache: new Map(),
    AbortController, setTimeout, clearTimeout, URLSearchParams, Float32Array,
    API_BASE: '', headers: () => ({}),
    fetch: (_url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        aborted = true;
        reject(new Error('aborted'));
      });
    }),
  };
  const start = html.indexOf('    async function fetchOriginalWaveformFromServer(');
  const end = html.indexOf('    function getWaveformSilenceSplits', start);
  vm.createContext(context);
  vm.runInContext(html.slice(start, end), context);
  assert.equal(await context.fetchOriginalWaveformFromServer(162, 0, 20, 240, 5), null);
  assert.equal(aborted, true);
  assert.equal(context.waveformOriginalCache.size, 0);
});

test('navigation disclosures and header controls keep native Space activation without toggling video', () => {
  for (const target of [
    { tagName: 'SUMMARY', getAttribute() { return null; } },
    { tagName: 'BUTTON', closest(selector) { return selector === '.topbar' ? {} : null; } },
  ]) {
    const harness = keyboardHarness();
    const event = harness.dispatch(' ', { target });
    assert.equal(event.defaultPrevented, false);
    assert.equal(harness.snapshot().toggles, 0);
  }
});
