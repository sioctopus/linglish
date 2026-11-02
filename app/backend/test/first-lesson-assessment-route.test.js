const test = require('node:test');
const assert = require('node:assert/strict');

const dataStore = require('../data-store');
const transcription = require('../services/video-transcription');
const sentenceSegments = require('../../frontend/js/video-reader/sentence-segments');
const progress = require('../../frontend/js/video-reader/first-lesson-progress');

const originals = {
  getVideoResourceById: dataStore.getVideoResourceById,
  transcribeVideoFile: transcription.transcribeVideoFile,
};

function response() {
  return {
    headersSent: false,
    writableEnded: false,
    setHeader() {},
    writeHead(statusCode) { this.statusCode = statusCode; this.headersSent = true; },
    end(payload) { this.payload = JSON.parse(payload); this.writableEnded = true; },
  };
}

function loadRoute(fields) {
  const contentPath = require.resolve('../routes/content');
  const uploadPath = require.resolve('../upload-handler');
  const authPath = require.resolve('../middleware/auth');
  const audioPath = require.resolve('../utils/audio-utils');
  const saved = [contentPath, uploadPath, authPath, audioPath].map((key) => [key, require.cache[key]]);

  require.cache[uploadPath] = {
    id: uploadPath, filename: uploadPath, loaded: true,
    exports: {
      handleFileUpload: async () => ({ files: { audio: { path: '/tmp/lesson.webm' } }, fields }),
      cleanupFile: async () => {},
    },
  };
  require.cache[authPath] = {
    id: authPath, filename: authPath, loaded: true,
    exports: { authenticate: async () => ({ id: 7 }) },
  };
  require.cache[audioPath] = {
    id: audioPath, filename: audioPath, loaded: true,
    exports: { convertAudioToWav: async () => '/tmp/lesson.wav' },
  };
  delete require.cache[contentPath];
  const route = require('../routes/content');

  return {
    route,
    restore() {
      for (const [key, entry] of saved) {
        if (entry) require.cache[key] = entry;
        else delete require.cache[key];
      }
    },
  };
}

test.after(async () => {
  dataStore.getVideoResourceById = originals.getVideoResourceById;
  transcription.transcribeVideoFile = originals.transcribeVideoFile;
  try { await dataStore.pool.end(); } catch (_) {}
});

test('practice route reconstructs and evaluates the exact merged displayed sentence', async () => {
  assert.equal(typeof sentenceSegments.toDisplayedSentences, 'function');
  const raw = [
    { index: 0, start: 0, end: 1, text: 'Please open' },
    { index: 1, start: 1, end: 2, text: 'the window.' },
  ];
  const displayed = sentenceSegments.toDisplayedSentences(raw);
  const stableSegmentId = progress.stableSegmentId(374, displayed[0], 0);
  const loaded = loadRoute({
    videoId: '374',
    segmentIndex: '0',
    stableSegmentId,
    sourceIndices: JSON.stringify([0, 1]),
  });
  dataStore.getVideoResourceById = async () => ({ id: 374, uploader_id: 7, is_public: false, transcript_segments: raw });
  transcription.transcribeVideoFile = async () => ({ text: 'Please open the window.' });
  const req = { method: 'POST', url: '/practice/evaluate', headers: { host: 'localhost' } };
  const res = response();

  try {
    assert.equal(await loaded.route.registerContentRoutes('/practice/evaluate', req, res), true);
  } finally {
    loaded.restore();
  }

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.targetText, 'Please open the window.');
  assert.equal(res.payload.stableSegmentId, stableSegmentId);
  assert.deepEqual(res.payload.sourceIndices, [0, 1]);
  assert.equal(res.payload.success, true);
});

test('practice route rejects a stale stable ID instead of trusting source indices or client text', async () => {
  const raw = [
    { index: 0, start: 0, end: 1, text: 'Please open' },
    { index: 1, start: 1, end: 2, text: 'the window.' },
  ];
  const loaded = loadRoute({
    videoId: '374',
    segmentIndex: '0',
    stableSegmentId: 'v:374:t:0-2000:h:wrong',
    sourceIndices: JSON.stringify([0, 1]),
    targetText: 'Client text must not be trusted.',
  });
  let transcribeCalls = 0;
  dataStore.getVideoResourceById = async () => ({ id: 374, uploader_id: 7, is_public: false, transcript_segments: raw });
  transcription.transcribeVideoFile = async () => { transcribeCalls += 1; return { text: 'ignored' }; };
  const req = { method: 'POST', url: '/practice/evaluate', headers: { host: 'localhost' } };
  const res = response();

  try {
    assert.equal(await loaded.route.registerContentRoutes('/practice/evaluate', req, res), true);
  } finally {
    loaded.restore();
  }

  assert.equal(res.statusCode, 409);
  assert.equal(transcribeCalls, 0);
});

test('practice route reconstructs the exact explicit-ID split sentence and rejects an index mismatch', async () => {
  const raw = [{ id: 17, start: 0, end: 4, text: 'Sit down. Take a breath.' }];
  const displayed = sentenceSegments.toDisplayedSentences(raw);
  const firstStableId = progress.stableSegmentId(374, displayed[0], 0);
  const secondStableId = progress.stableSegmentId(374, displayed[1], 1);
  assert.notEqual(firstStableId, secondStableId);

  const exact = loadRoute({
    videoId: '374',
    segmentIndex: '1',
    stableSegmentId: secondStableId,
    sourceIndices: JSON.stringify([0]),
  });
  dataStore.getVideoResourceById = async () => ({ id: 374, uploader_id: 7, is_public: false, transcript_segments: raw });
  transcription.transcribeVideoFile = async () => ({ text: 'Take a breath.' });
  const exactResponse = response();
  try {
    assert.equal(await exact.route.registerContentRoutes(
      '/practice/evaluate',
      { method: 'POST', url: '/practice/evaluate', headers: { host: 'localhost' } },
      exactResponse,
    ), true);
  } finally {
    exact.restore();
  }

  assert.equal(exactResponse.statusCode, 200);
  assert.equal(exactResponse.payload.targetText, 'Take a breath.');
  assert.equal(exactResponse.payload.stableSegmentId, secondStableId);
  assert.deepEqual(exactResponse.payload.sourceIndices, [0]);

  let transcribeCalls = 0;
  const tampered = loadRoute({
    videoId: '374',
    segmentIndex: '1',
    stableSegmentId: firstStableId,
    sourceIndices: JSON.stringify([0]),
  });
  transcription.transcribeVideoFile = async () => { transcribeCalls += 1; return { text: 'ignored' }; };
  const tamperedResponse = response();
  try {
    assert.equal(await tampered.route.registerContentRoutes(
      '/practice/evaluate',
      { method: 'POST', url: '/practice/evaluate', headers: { host: 'localhost' } },
      tamperedResponse,
    ), true);
  } finally {
    tampered.restore();
  }

  assert.equal(tamperedResponse.statusCode, 409);
  assert.equal(transcribeCalls, 0);
});
