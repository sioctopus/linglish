const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function bridgeFixture() {
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const state = { currentVideo: { id: 'A' }, currentSegments: [{}] };
  const window = {
    location: { pathname: '/video-reader-desktop.html', search: '' },
    LinglishVideoReaderState: state,
    LinglishShadowRecordingCache: {
      get: () => pending,
      applyToState(target, recording) { target.lastRecordingBlob = recording.blob; target.lastRecordingUrl = 'blob:A'; },
    },
  };
  const document = {
    readyState: 'loading', addEventListener() {},
    getElementById() { return null; }, querySelector() { return null; },
  };
  const source = fs.readFileSync(path.join(__dirname, '../../frontend/js/practice/voice-chat-bridge.js'), 'utf8');
  vm.runInNewContext(source.replace('    resolveVideoId,', '    resolveVideoId, currentSegmentIndex,'), {
    window, document, URL, URLSearchParams,
  });
  return { window, state, bridge: window.LinglishVoiceChatBridge, resolve };
}

for (const method of ['hydrateShadowRecording', 'resolvePlayableShadowUrl']) {
  test(`${method} rejects a recording loaded for a previous video`, async () => {
    const h = bridgeFixture();
    const response = method === 'hydrateShadowRecording' ? h.bridge[method]('A', 0) : h.bridge[method](0);
    h.state.currentVideo = { id: 'B' };
    h.state.currentSegments = [{}];
    h.resolve({ blob: new Blob(['A']), segmentIndex: 0 });
    assert.equal(await response, method === 'hydrateShadowRecording' ? false : '');
    assert.equal(h.state.lastRecordingBlob, null);
    assert.equal(h.state.lastRecordingUrl, '');
  });
}

test('desktop hold resolves the playing cue before an old chat selection', () => {
  const h = bridgeFixture();
  h.state.activeSegmentIndex = 0;
  h.window.__vrdPro = {
    state: h.state, playerEl: { currentTime: 42 },
    currentSegmentIndexByTime(time) { assert.equal(time, 42); return 2; },
  };
  assert.equal(h.bridge.currentSegmentIndex(), 2);
});

test('desktop Space capture defers to native controls and guided lessons', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../frontend/js/video-reader/desktop-x-hold.js'), 'utf8');
  const extract = name => source.match(new RegExp(`  function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?\\n  \\}`))[0];
  let starts = 0;
  const document = { documentElement: { dataset: {} } };
  const context = vm.createContext({ holdBtn: null, pointerDown: false, spaceDown: false, document, beginHold() { starts += 1; } });
  vm.runInContext(`${extract('isTypingTarget')}; ${extract('onSpaceDown')};`, context);
  for (const tag of ['BUTTON', 'SUMMARY', 'AUDIO', 'VIDEO', 'INPUT', 'TEXTAREA', 'SELECT', 'A']) {
    context.onSpaceDown({ code: 'Space', target: { tagName: tag }, preventDefault() { assert.fail(tag); } });
  }
  document.documentElement.dataset.learningFocus = 'first-lesson';
  context.onSpaceDown({ code: 'Space', target: { tagName: 'BODY' }, preventDefault() { assert.fail('guided lesson'); } });
  assert.equal(starts, 0);
  delete document.documentElement.dataset.learningFocus;
  context.onSpaceDown({ code: 'Space', target: { tagName: 'BODY' }, preventDefault() {}, stopImmediatePropagation() {} });
  assert.equal(starts, 1);
});

test('hydration for the selected video survives its transcript becoming ready', async () => {
  const h = bridgeFixture();
  const response = h.bridge.hydrateShadowRecording('A', 0);
  h.state.currentSegments = [{ text: 'loaded transcript' }];
  const blob = new Blob(['A']);
  h.resolve({ blob, segmentIndex: 0 });
  assert.equal(await response, true);
  assert.equal(h.state.lastRecordingBlob, blob);
  assert.equal(h.state.lastRecordingUrl, 'blob:A');
});
