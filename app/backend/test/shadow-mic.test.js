const test = require('node:test');
const assert = require('node:assert/strict');

const mic = require('../../frontend/js/practice/shadow-mic');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function fakeRecorderFactory(log, options = {}) {
  const instances = [];
  class FakeMediaRecorder {
    constructor(stream, opts) {
      this.stream = stream;
      this.opts = opts || {};
      this.state = 'inactive';
      this.mimeType = (opts && opts.mimeType) || 'audio/webm';
      this.listeners = new Map();
      instances.push(this);
      log.push('recorder.create');
    }
    static isTypeSupported(type) {
      if (options.types) return options.types.includes(type);
      return type === 'audio/webm;codecs=opus'
        || type === 'audio/webm'
        || type === 'audio/mp4';
    }
    addEventListener(name, listener) {
      const list = this.listeners.get(name) || [];
      list.push(listener);
      this.listeners.set(name, list);
    }
    start(timeslice) {
      this.state = 'recording';
      this.timeslice = timeslice;
      log.push(`recorder.start:${timeslice || 0}`);
    }
    stop() {
      if (this.state === 'inactive') return;
      this.state = 'inactive';
      log.push('recorder.stop');
      const dataListeners = this.listeners.get('dataavailable') || [];
      const chunk = options.empty
        ? new Blob([])
        : new Blob([Uint8Array.from({ length: 240 }, () => 1)]);
      dataListeners.forEach((listener) => listener({ data: chunk }));
      const stopListeners = this.listeners.get('stop') || [];
      stopListeners.forEach((listener) => listener());
    }
  }
  return { FakeMediaRecorder, instances };
}

test('pickMimeType prefers opus webm on desktop browsers', () => {
  assert.equal(mic.pickMimeType({
    isTypeSupported: (type) => type === 'audio/webm;codecs=opus' || type === 'audio/mp4',
  }, 'Mozilla/5.0 (Windows NT 10.0) Chrome/120.0.0.0'), 'audio/webm;codecs=opus');
});

test('pickMimeType prefers audio/mp4 on Apple so playback works', () => {
  assert.equal(mic.pickMimeType({
    isTypeSupported: (type) => type === 'audio/webm;codecs=opus' || type === 'audio/mp4',
  }, 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Mobile/15E148 Safari/604.1'), 'audio/mp4');
  assert.equal(mic.defaultTimeslice('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)'), 0);
  assert.equal(mic.defaultTimeslice('Mozilla/5.0 (Windows NT 10.0) Chrome/120.0.0.0'), 250);
});

test('recordingDurationMs clamps sentence length into a speakable window', () => {
  assert.equal(mic.recordingDurationMs({ start: 0, end: 1 }), 2200);
  assert.ok(mic.recordingDurationMs({ start: 0, end: 30 }) <= 20000);
  assert.ok(mic.recordingDurationMs({}) >= 1800);
});

test('recordShadow keeps tracks alive until MediaRecorder stop, then releases them', async () => {
  const log = [];
  const tracks = [1, 2].map((id) => ({
    stop() { log.push(`track.${id}.stop`); },
  }));
  const stream = { getTracks: () => tracks };
  const recorder = fakeRecorderFactory(log);
  const gate = deferred();
  let ready = null;

  const done = mic.recordShadow({
    MediaRecorder: recorder.FakeMediaRecorder,
    getUserMedia: async () => {
      log.push('getUserMedia');
      return stream;
    },
    maxDurationMs: 5000,
    timeslice: 250,
    setTimeout() { return 1; },
    clearTimeout() {},
    now: () => 1000,
    onReady(handle) {
      ready = handle;
      gate.resolve();
    },
  });

  await gate.promise;
  assert.ok(ready && typeof ready.stop === 'function');
  assert.equal(recorder.instances[0].state, 'recording');
  assert.equal(log.includes('track.1.stop'), false);

  ready.stop();
  const result = await done;

  assert.ok(result && result.blob && result.blob.size >= 64);
  assert.ok(log.indexOf('recorder.stop') < log.indexOf('track.1.stop'));
  assert.ok(log.indexOf('recorder.stop') < log.indexOf('track.2.stop'));
});

test('recordShadow can reuse a stream opened inside the tap gesture', async () => {
  const log = [];
  const tracks = [{ stop() { log.push('track.stop'); } }];
  const stream = { getTracks: () => tracks };
  const recorder = fakeRecorderFactory(log);
  const gate = deferred();
  let ready = null;
  const done = mic.recordShadow({
    MediaRecorder: recorder.FakeMediaRecorder,
    stream,
    releaseStream: true,
    maxDurationMs: 4000,
    timeslice: 0,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
    setTimeout() { return 1; },
    clearTimeout() {},
    onReady(handle) {
      ready = handle;
      gate.resolve();
    },
  });
  await gate.promise;
  assert.equal(recorder.instances[0].opts.mimeType, 'audio/mp4');
  assert.equal(recorder.instances[0].timeslice, undefined);
  ready.stop();
  const result = await done;
  assert.ok(result && result.blob.size >= 64);
  assert.equal(log.includes('track.stop'), true);
});

test('recordShadow rejects empty captures so the UI can ask for a retry', async () => {
  const log = [];
  const stream = {
    getTracks: () => [{ stop() { log.push('track.stop'); } }],
  };
  const recorder = fakeRecorderFactory(log, { empty: true });
  const gate = deferred();
  let ready = null;
  const done = mic.recordShadow({
    MediaRecorder: recorder.FakeMediaRecorder,
    getUserMedia: async () => stream,
    maxDurationMs: 4000,
    timeslice: 0,
    setTimeout() { return 1; },
    clearTimeout() {},
    onReady(handle) {
      ready = handle;
      gate.resolve();
    },
  });
  await gate.promise;
  ready.stop();
  await assert.rejects(done, (error) => error.code === 'EMPTY_RECORDING');
  assert.equal(log.includes('track.stop'), true);
});

test('WeChat recording support exposes open-in-browser guidance', () => {
  const support = mic.recordingSupport({
    userAgent: 'MicroMessenger Mozilla/5.0',
    MediaRecorder: null,
    getUserMedia: null,
  });
  assert.equal(support.wechat, true);
  assert.equal(support.ok, false);
  assert.match(support.hint, /浏览器打开/);
  assert.match(mic.errorHint({ code: 'MICROPHONE_DENIED' }, { userAgent: 'MicroMessenger' }), /浏览器打开/);
});

test('acquireMic falls back to simple audio constraints', async () => {
  const calls = [];
  const stream = { getTracks: () => [], getAudioTracks: () => [] };
  const result = await mic.acquireMic({
    getUserMedia: async (constraints) => {
      calls.push(constraints);
      if (constraints && constraints.audio && constraints.audio.channelCount) {
        const err = new Error('overconstrained');
        err.name = 'OverconstrainedError';
        throw err;
      }
      return stream;
    },
  });
  assert.equal(result, stream);
  assert.ok(calls.length >= 2);
  assert.deepEqual(calls[calls.length - 1], { audio: true, video: false });
});

test('sensitiveConstraints disable noise gate so quiet speech can pass', () => {
  const c = mic.sensitiveConstraints('MicroMessenger iPhone');
  assert.equal(c.audio.noiseSuppression, false);
  assert.equal(c.audio.echoCancellation, false);
  assert.equal(c.audio.autoGainControl, true);
  assert.ok(mic.defaultBoostGain('MicroMessenger iPhone') >= 4);
});

test('preferred mic deviceId is remembered and applied to constraints', () => {
  const memory = {
    data: Object.create(null),
    getItem(key) { return Object.prototype.hasOwnProperty.call(this.data, key) ? this.data[key] : null; },
    setItem(key, value) { this.data[key] = String(value); },
    removeItem(key) { delete this.data[key]; },
  };
  mic.setPreferredMicId('usb-lav-1', memory);
  assert.equal(mic.getPreferredMicId(memory), 'usb-lav-1');
  const constrained = mic.applyPreferredDevice(mic.sensitiveConstraints(), 'usb-lav-1');
  assert.deepEqual(constrained.audio.deviceId, { exact: 'usb-lav-1' });
  mic.setPreferredMicId('', memory);
  assert.equal(mic.getPreferredMicId(memory), '');
});

test('prepareMicTracks enables audio tracks', () => {
  const track = { enabled: false, applyConstraints: async () => {} };
  const stream = {
    getAudioTracks: () => [track],
    getTracks: () => [track],
  };
  mic.prepareMicTracks(stream);
  assert.equal(track.enabled, true);
});

test('recordShadow can boost through a fake AudioContext', async () => {
  const log = [];
  const track = { enabled: true, stop() { log.push('track.stop'); } };
  const rawStream = {
    getAudioTracks: () => [track],
    getTracks: () => [track],
  };
  const destStream = {
    getTracks: () => [{ stop() { log.push('dest.stop'); } }],
  };
  function FakeAudioContext() {
    this.state = 'running';
    this.createMediaStreamSource = () => ({ connect() {}, disconnect() { log.push('source.disconnect'); } });
    this.createGain = () => ({ gain: { value: 1 }, connect() {}, disconnect() { log.push('gain.disconnect'); } });
    this.createDynamicsCompressor = () => ({
      threshold: { value: 0 },
      knee: { value: 0 },
      ratio: { value: 0 },
      attack: { value: 0 },
      release: { value: 0 },
      connect() {},
      disconnect() { log.push('comp.disconnect'); },
    });
    this.createMediaStreamDestination = () => ({ stream: destStream });
    this.createAnalyser = () => null;
    this.close = async () => { log.push('ctx.close'); this.state = 'closed'; };
  }
  const recorder = fakeRecorderFactory(log);
  const gate = deferred();
  let ready = null;
  const done = mic.recordShadow({
    MediaRecorder: recorder.FakeMediaRecorder,
    stream: rawStream,
    releaseStream: true,
    boost: true,
    gain: 4,
    AudioContext: FakeAudioContext,
    setInterval() { return 1; },
    clearInterval() {},
    maxDurationMs: 4000,
    timeslice: 0,
    setTimeout() { return 1; },
    clearTimeout() {},
    onReady(handle) {
      ready = handle;
      gate.resolve();
    },
  });
  await gate.promise;
  assert.equal(ready.boosted, true);
  assert.equal(recorder.instances[0].stream, destStream);
  ready.stop();
  const result = await done;
  assert.ok(result && result.blob.size > 0);
  assert.equal(result.boosted, true);
  assert.ok(log.includes('track.stop'));
});
