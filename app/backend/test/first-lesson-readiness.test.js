const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createFirstLessonReadiness } = require('../../frontend/js/video-reader/first-lesson-readiness');
const sentenceSegments = require('../../frontend/js/video-reader/sentence-segments');
const { readPage } = require('./helpers/page-source');

const readerHtml = readPage('video-reader-desktop.html');
const mobileReaderMain = fs.readFileSync(path.resolve(__dirname, '../../frontend/js/video-reader/main.js'), 'utf8');

function extractNamedFunction(source, name) {
  const start = source.indexOf(`async function ${name}(`) >= 0
    ? source.indexOf(`async function ${name}(`)
    : source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must remain available for the reader contract`);

  const signatureEnd = source.indexOf(') {', start);
  assert.notEqual(signatureEnd, -1, `${name} must have a parseable function signature`);
  const openBrace = signatureEnd + 2;
  let depth = 0;
  let quote = null;
  let lineComment = false;
  let blockComment = false;

  for (let index = openBrace; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (char === '\\') {
        index += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === '\'' || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }

  throw new Error(`Unable to parse ${name}`);
}

function loadVideoDetailsContract() {
  const source = extractNamedFunction(readerHtml, 'loadVideoDetails');
  const rememberSource = readerHtml.match(/    function rememberVideoWords\(videoId, segments\) \{[\s\S]*?\n    \}/)?.[0];
  assert.ok(rememberSource, 'the reader vocabulary helper must remain available');
  return new Function(
    'state',
    'fetch',
    'headers',
    'API_BASE',
    'refineTranscriptSegments',
    'splitSegmentsByWaveformSilence',
    'window',
    'mergeIncompleteSentences',
    'renderTranscript',
    'syncModeButtons',
    'console',
    'videoSelectionGuard',
    'firstLessonSession',
    'firstLessonReadiness',
    'postEvent',
    'startFirstLessonProgress',
    'firstLessonLifecycle',
    `const rememberVideoWords = (${rememberSource}); return (${source});`,
  );
}

function mobilePostEventContract() {
  const source = extractNamedFunction(mobileReaderMain, 'postEvent');
  return new Function(
    'token',
    'fetch',
    'API_BASE',
    'getAnalyticsContext',
    'window',
    'console',
    `return (${source});`,
  );
}

function mobileCommittedReadinessContract() {
  const source = extractNamedFunction(mobileReaderMain, 'markFirstLessonReadyForCommittedTranscript');
  return new Function(
    'state',
    'firstLessonReadiness',
    'postEvent',
    'firstLessonLifecycle',
    'firstLessonSession',
    'guidedLessonEntry',
    'window',
    `return (${source});`,
  );
}

function mobileRenderTranscriptContract() {
  const source = extractNamedFunction(mobileReaderMain, 'renderTranscript');
  return new Function(
    'state',
    'transcriptContent',
    'transcriptLanguage',
    'waveformSegmentationConfig',
    'ensureWaveformSegmentation',
    'isMobileLayout',
    'requestAnimationFrame',
    'escapeHtml',
    'formatTime',
    'renderMobileTranscriptWindow',
    'mobileSegmentPosition',
    'markFirstLessonReadyForCommittedTranscript',
    'console',
    'fetch',
    'API_BASE',
    'window',
    'firstLessonSession',
    'startMobileFirstLessonProgress',
    `return (${source});`,
  );
}

test('first lesson emits readiness once only after subtitles exist', () => {
  const tracker = createFirstLessonReadiness({ focus: 'first_lesson', from: 'today_first_lesson', startedAt: 1000, now: () => 2600 });

  assert.equal(tracker.markReady({ videoId: 113, segmentCount: 0 }), null);
  assert.deepEqual(tracker.markReady({ videoId: 113, segmentCount: 12 }), {
    video_resource_id: 113,
    segment_count: 12,
    ready_ms: 1600,
  });
  assert.equal(tracker.markReady({ videoId: 113, segmentCount: 12 }), null);
});

test('from attribution alone never enables first lesson readiness', () => {
  const tracker = createFirstLessonReadiness({ from: 'today_first_lesson', startedAt: 1000, now: () => 2000 });

  assert.equal(tracker.markReady({ videoId: 113, segmentCount: 12 }), null);
});

test('mobile reader decorates analytics events with the shared visitor identity', async () => {
  const requests = [];
  const postEvent = mobilePostEventContract()(
    'guest-token',
    async (url, options) => { requests.push({ url, options }); },
    '/api',
    () => ({ page: 'video-reader', from: 'today_first_lesson' }),
    {
      LinglishVisitor: {
        decorateEvent(payload) {
          return {
            ...payload,
            visitor_id: 'llv_abcdefghijkl',
            properties: { ...payload.properties, visitor_id: 'llv_abcdefghijkl' },
          };
        },
      },
    },
    { warn: () => {} },
  );

  await postEvent('video_watch', { video_resource_id: 113, seconds: 15 });

  assert.equal(requests.length, 1);
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    event_name: 'video_watch',
    visitor_id: 'llv_abcdefghijkl',
    properties: {
      page: 'video-reader',
      from: 'today_first_lesson',
      video_resource_id: 113,
      seconds: 15,
      visitor_id: 'llv_abcdefghijkl',
    },
  });
});

test('mobile reader emits readiness once only for committed subtitles of the current video', () => {
  const finalSegments = [{ text: 'One.' }, { text: 'Two.' }];
  const state = { selectedVideoId: 113, currentSegments: finalSegments };
  const events = [];
  const tracker = createFirstLessonReadiness({
    focus: 'first_lesson',
    from: 'today_first_lesson',
    startedAt: 1000,
    now: () => 2500,
  });
  const markCommitted = mobileCommittedReadinessContract()(
    state,
    tracker,
    (name, payload) => events.push({ name, payload }),
    { ready: () => {} },
    { isActive: () => true },
  );

  state.selectedVideoId = 114;
  state.currentSegments = [{ text: 'Different video.' }];
  markCommitted({ id: 113 }, finalSegments);
  state.selectedVideoId = 113;
  state.currentSegments = finalSegments;
  markCommitted({ id: 113 }, finalSegments);
  markCommitted({ id: 113 }, finalSegments);

  assert.deepEqual(events, [{
    name: 'today_first_lesson_workspace_ready',
    payload: { video_resource_id: 113, segment_count: 2, ready_ms: 1500 },
  }]);
});

test('ordinary mobile reader exposes the guided lesson only for the committed selected video', () => {
  const segments = [{ text: 'Could you slow down?' }];
  const state = { selectedVideoId: 42, currentSegments: segments };
  const entry = { hidden: true, href: '' };
  const mark = mobileCommittedReadinessContract()(
    state,
    { markReady() { assert.fail('Ordinary reading is not a first-lesson readiness event'); } },
    () => assert.fail('No first-lesson event expected'),
    {},
    { isActive: () => false },
    entry,
    { LinglishFirstLessonGoal: require('../../frontend/js/video-reader/first-lesson-goal') },
  );
  mark({ id: 41 }, segments);
  assert.equal(entry.hidden, true);
  mark({ id: 42 }, segments);
  assert.equal(entry.hidden, false);
  const url = new URL(entry.href, 'https://example.com/');
  assert.equal(url.searchParams.get('videoId'), '42');
  assert.equal(url.searchParams.get('from'), 'reader_guided_practice');
});

test('mobile first lesson commits and renders subtitles without starting waveform refinement', () => {
  const rawSegments = [{ text: 'Raw line.' }];
  const video = { id: 113, status: 'ready', transcript_segments: rawSegments };
  const state = {
    selectedVideoId: 113,
    currentSegments: [],
    segmentHtmlCache: new Map(),
    transcriptFetchRequested: new Set(),
    isLoadingTranscript: false,
  };
  const events = [];
  const tracker = createFirstLessonReadiness({
    focus: 'first_lesson',
    from: 'today_first_lesson',
    startedAt: 1000,
    now: () => 2500,
  });
  let refinementCalls = 0;
  let mobileRenderCalls = 0;
  const renderTranscript = mobileRenderTranscriptContract()(
    state,
    { innerHTML: '' },
    { textContent: '' },
    { enabled: true },
    () => {
      refinementCalls += 1;
      return new Promise(() => {});
    },
    () => true,
    (callback) => callback(),
    (value) => String(value),
    () => '00:00',
    () => { mobileRenderCalls += 1; },
    null,
    (currentVideo, segments) => {
      assert.equal(state.currentSegments, segments);
      const readiness = tracker.markReady({
        videoId: currentVideo.id,
        segmentCount: segments.length,
      });
      if (readiness) events.push({
        name: 'today_first_lesson_workspace_ready',
        payload: readiness,
      });
    },
    { log: () => {}, warn: (message, error) => assert.fail(error && error.stack || message) },
    async () => ({ ok: false }),
    '/api',
    { LinglishSentenceSegments: sentenceSegments },
    { isActive: () => true },
    () => {},
  );

  renderTranscript(video);
  renderTranscript(video);

  assert.equal(refinementCalls, 0);
  assert.deepEqual(state.currentSegments.map(({ text, source_indices }) => ({ text, source_indices })), [
    { text: 'Raw line.', source_indices: [0] },
  ]);
  assert.equal(mobileRenderCalls, 2);
  assert.deepEqual(events, [{
    name: 'today_first_lesson_workspace_ready',
    payload: { video_resource_id: 113, segment_count: 1, ready_ms: 1500 },
  }]);
});

test('normal mobile entry keeps asynchronous waveform refinement behavior', async () => {
  const rawSegments = [{ text: 'Raw line.' }];
  const finalSegments = [{ text: 'Final one.' }, { text: 'Final two.' }];
  const video = { id: 113, status: 'ready', transcript_segments: rawSegments };
  const state = {
    selectedVideoId: 113,
    currentSegments: [],
    segmentHtmlCache: new Map(),
    transcriptFetchRequested: new Set(),
    isLoadingTranscript: false,
  };
  const committed = [];
  let finishRefinement;
  let refinementCalls = 0;
  const renderTranscript = mobileRenderTranscriptContract()(
    state,
    { innerHTML: '' },
    { textContent: '' },
    { enabled: true },
    async (currentVideo) => {
      refinementCalls += 1;
      currentVideo._waveformSegmentationApplied = true;
      await new Promise((resolve) => { finishRefinement = resolve; });
      currentVideo.transcript_segments = finalSegments;
      return true;
    },
    () => true,
    (callback) => callback(),
    (value) => String(value),
    () => '00:00',
    () => {},
    null,
    (currentVideo, segments) => committed.push({ currentVideo, segments }),
    { log: () => {}, warn: (message, error) => assert.fail(error && error.stack || message) },
    async () => ({ ok: false }),
    '/api',
    { LinglishSentenceSegments: sentenceSegments },
    { isActive: () => false },
    () => {},
  );

  renderTranscript(video);
  renderTranscript(video);
  assert.deepEqual(committed, []);
  assert.equal(refinementCalls, 1);

  finishRefinement();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(committed.length, 1);
  assert.equal(committed[0].currentVideo, video);
  assert.equal(committed[0].segments, finalSegments);
  assert.equal(state.currentSegments, finalSegments);
});

test('desktop first lesson commits and renders subtitles without starting waveform refinement', async () => {
  const state = { currentVideo: { id: 113 }, currentSegments: [] };
  const refinedSegments = [{ text: 'Refined one.' }, { text: 'Refined two.' }];
  const finalSegments = [{ text: 'One.' }, { text: 'Two.' }];
  const events = [];
  let waveformCalls = 0;
  let renderCalls = 0;
  const tracker = createFirstLessonReadiness({
    focus: 'first_lesson',
    from: 'today_first_lesson',
    startedAt: 1000,
    now: () => 2500,
  });
  const loadVideoDetails = loadVideoDetailsContract()(
    state,
    async () => ({ ok: true, json: async () => ({ video: { id: 113, transcript_segments: [{ text: 'raw' }] } }) }),
    () => ({}),
    '/api',
    () => refinedSegments,
    () => {
      waveformCalls += 1;
      return new Promise(() => {});
    },
    { LinglishSentenceSegments: { toDisplayedSentences: () => finalSegments } },
    (segments) => segments,
    () => { renderCalls += 1; },
    () => {},
    { log: () => {}, warn: (message, error) => assert.fail(error && error.stack || message) },
    { isCurrent: () => true },
    { isActive: () => true },
    tracker,
    (name, payload) => events.push({ name, payload }),
    () => {},
    { ready: () => {} },
  );

  const firstLoad = loadVideoDetails(113);
  const settlement = await Promise.race([
    firstLoad.then(() => 'resolved'),
    new Promise((resolve) => setImmediate(() => resolve('pending'))),
  ]);
  assert.equal(settlement, 'resolved');
  await loadVideoDetails(113);

  assert.equal(waveformCalls, 0);
  assert.equal(state.currentSegments, finalSegments);
  assert.equal(renderCalls, 2);
  assert.deepEqual(events, [{
    name: 'today_first_lesson_workspace_ready',
    payload: { video_resource_id: 113, segment_count: 2, ready_ms: 1500 },
  }]);
});

test('normal desktop entry still waits for waveform refinement before committing subtitles', async () => {
  const state = { currentVideo: { id: 113 }, currentSegments: [] };
  const waveformSegments = [{ text: 'Waveform result.' }];
  const finalSegments = [{ text: 'Final result.' }];
  let finishWaveform;
  let waveformCalls = 0;
  let renderCalls = 0;
  const loadVideoDetails = loadVideoDetailsContract()(
    state,
    async () => ({ ok: true, json: async () => ({ video: { id: 113, transcript_segments: [{ text: 'raw' }] } }) }),
    () => ({}),
    '/api',
    (segments) => segments,
    async () => {
      waveformCalls += 1;
      await new Promise((resolve) => { finishWaveform = resolve; });
      return waveformSegments;
    },
    { LinglishSentenceSegments: { toCompleteSentences: (segments) => {
      assert.equal(segments, waveformSegments);
      return finalSegments;
    } } },
    (segments) => segments,
    () => { renderCalls += 1; },
    () => {},
    { log: () => {}, warn: (message, error) => assert.fail(error && error.stack || message) },
    { isCurrent: () => true },
    { isActive: () => false },
    createFirstLessonReadiness({ focus: null, from: 'library', startedAt: 1000, now: () => 2500 }),
    () => assert.fail('normal entry must not emit first lesson readiness'),
    () => {},
    { ready: () => {} },
  );

  const loading = loadVideoDetails(113);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(waveformCalls, 1);
  assert.deepEqual(state.currentSegments, []);
  assert.equal(renderCalls, 0);

  finishWaveform();
  await loading;

  assert.equal(state.currentSegments, finalSegments);
  assert.equal(renderCalls, 1);
});

test('reader suppresses readiness when an asynchronous subtitle load becomes stale', async () => {
  const state = { currentVideo: { id: 113 }, currentSegments: [] };
  const marks = [];
  const events = [];
  const loadVideoDetails = loadVideoDetailsContract()(
    state,
    async () => ({ ok: true, json: async () => ({ video: { id: 113, transcript_segments: [{ text: 'raw' }] } }) }),
    () => ({}),
    '/api',
    (segments) => segments,
    async (segments) => {
      state.currentVideo = { id: 114 };
      return segments;
    },
    { LinglishSentenceSegments: { toCompleteSentences: (segments) => segments } },
    (segments) => segments,
    () => {},
    () => {},
    { log: () => {}, warn: (message, error) => assert.fail(error && error.stack || message) },
    { isCurrent: () => true },
    { isActive: () => false },
    { markReady: (details) => { marks.push(details); return details; } },
    (name, payload) => events.push({ name, payload }),
    () => {},
    { ready: () => {} },
  );

  await loadVideoDetails(113);

  assert.deepEqual(marks, []);
  assert.deepEqual(events, []);
  assert.deepEqual(state.currentSegments, []);
});

test('deactivated mobile session cannot emit readiness and resumes ordinary waveform refinement', async () => {
  const rawSegments = [{ text: 'Raw line.' }];
  const finalSegments = [{ text: 'Ordinary refined line.' }];
  const video = { id: 113, status: 'ready', transcript_segments: rawSegments };
  const state = {
    selectedVideoId: 113,
    currentSegments: [],
    segmentHtmlCache: new Map(),
    transcriptFetchRequested: new Set(),
    isLoadingTranscript: false,
  };
  let active = true;
  let refinementCalls = 0;
  let progressStarts = 0;
  const events = [];
  const markCommitted = mobileCommittedReadinessContract()(
    state,
    { markReady: (details) => details },
    (name) => events.push(name),
    { ready: () => {} },
    { isActive: () => active },
  );
  const renderTranscript = mobileRenderTranscriptContract()(
    state,
    { innerHTML: '' },
    { textContent: '' },
    { enabled: true },
    async (currentVideo) => {
      refinementCalls += 1;
      currentVideo._waveformSegmentationApplied = true;
      currentVideo.transcript_segments = finalSegments;
      return true;
    },
    () => true,
    (callback) => callback(),
    (value) => String(value),
    () => '00:00',
    () => {},
    null,
    markCommitted,
    { log: () => {}, warn: (message, error) => assert.fail(error && error.stack || message) },
    async () => ({ ok: false }),
    '/api',
    { LinglishSentenceSegments: sentenceSegments },
    { isActive: () => active },
    () => { if (active) progressStarts += 1; },
  );

  active = false;
  renderTranscript(video);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(refinementCalls, 1);
  assert.equal(progressStarts, 0);
  assert.deepEqual(events, []);
  assert.equal(state.currentSegments, finalSegments);
});
