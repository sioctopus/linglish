const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const modulePath = path.resolve(__dirname, '../../frontend/js/video-reader/first-lesson-progress.js');
const desktopPath = path.resolve(__dirname, '../../frontend/video-reader-desktop.html');
const mobileMainPath = path.resolve(__dirname, '../../frontend/js/video-reader/main.js');
const proControlsPath = path.resolve(__dirname, '../../frontend/js/video-reader/pro-controls.js');
const sentenceSegments = require('../../frontend/js/video-reader/sentence-segments');

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial).map(([key, value]) => [key, String(value)]));
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
    dump() { return Object.fromEntries(values); },
  };
}

function segments(count = 21) {
  return Array.from({ length: count }, (_, index) => ({
    index,
    start: index * 2.5,
    end: index * 2.5 + 2,
    text: `Sentence ${index + 1}.`,
  }));
}

function validPracticeEvidence(id) {
  return {
    success: true,
    score: 88,
    evidence: { kind: 'recording_assessment', assessmentId: id, recording: true },
  };
}

test('stable segment IDs survive refresh-equivalent segment objects', () => {
  const progress = require(modulePath);
  const source = segments(2);
  const clone = JSON.parse(JSON.stringify(source));

  assert.deepEqual(
    source.map((segment, index) => progress.stableSegmentId(374, segment, index)),
    clone.map((segment, index) => progress.stableSegmentId('374', segment, index)),
  );
  assert.notEqual(
    progress.stableSegmentId(374, source[0], 0),
    progress.stableSegmentId(374, source[1], 1),
  );
});

test('explicit-ID split sentences keep refresh-stable unique IDs and receive independent practice credit', () => {
  const progress = require(modulePath);
  const raw = [{ id: 17, start: 0, end: 4, text: 'Sit down. Take a breath.' }];
  const displayed = sentenceSegments.toDisplayedSentences(raw);
  const refreshed = sentenceSegments.toDisplayedSentences(JSON.parse(JSON.stringify(raw)));
  const ids = displayed.map((segment, index) => progress.stableSegmentId(374, segment, index));
  const refreshedIds = refreshed.map((segment, index) => progress.stableSegmentId('374', segment, index));

  assert.equal(displayed.length, 2);
  assert.deepEqual(ids, refreshedIds);
  assert.notEqual(ids[0], ids[1]);

  const store = progress.createStore(memoryStorage(), () => 1_500);
  const initial = store.start('user:7', 374, displayed);
  assert.equal(initial.total, 2);
  const practiced = store.markPracticed('user:7', 374, ids[1], validPracticeEvidence('split-second'));
  assert.equal(practiced.changed, true);
  assert.equal(practiced.snapshot.practicedCount, 1);
  assert.equal(practiced.snapshot.complete, false);
  assert.deepEqual(practiced.snapshot.practicedSegmentIds, [ids[1]]);
  assert.equal(store.markPracticed('user:7', 374, ids[0], validPracticeEvidence('split-first')).snapshot.complete, true);
});

test('progress start rejects duplicate displayed stable IDs', () => {
  const progress = require(modulePath);
  const duplicate = { id: 17, start: 0, end: 1, text: 'Same sentence.' };
  const store = progress.createStore(memoryStorage(), () => 1_750);

  assert.throws(
    () => store.start('user:7', 374, [duplicate, { ...duplicate }]),
    /FIRST_LESSON_DUPLICATE_SEGMENT_ID/,
  );
});

test('ordinary 20/21 visited and video_progress_374=0 migrate to heard/resume, never practiced', () => {
  const progress = require(modulePath);
  const storage = memoryStorage({
    'linglish.vrp.visited.v1': JSON.stringify({ 374: Array.from({ length: 20 }, (_, index) => index) }),
    video_progress_374: '0',
  });
  const store = progress.createStore(storage, () => 1_000);

  const snapshot = store.start('visitor:llv_existingvisitor12', 374, segments());

  assert.equal(snapshot.version, 2);
  assert.equal(snapshot.total, 21);
  assert.equal(snapshot.heardCount, 20);
  assert.equal(snapshot.practicedCount, 0);
  assert.equal(snapshot.percentage, 0);
  assert.equal(snapshot.resumeSeconds, 0);
  assert.equal(snapshot.complete, false);
  assert.equal(storage.dump()['linglish.firstLesson.progress.v2'] !== undefined, true);
});

test('only forward playback at or beyond half a sentence marks heard and never marks practiced', () => {
  const progress = require(modulePath);
  const store = progress.createStore(memoryStorage(), () => 2_000);
  const source = segments(3);
  const subject = 'user:7';
  store.start(subject, 374, source);
  const segmentId = progress.stableSegmentId(374, source[0], 0);

  for (const evidence of [
    { source: 'playback', forward: true, fraction: 0.49 },
    { source: 'seek', forward: true, fraction: 0.9 },
    { source: 'subtitle_scroll', forward: true, fraction: 0.9 },
    { source: 'direct_selection', forward: true, fraction: 0.9 },
    { source: 'programmatic_navigation', forward: true, fraction: 0.9 },
    { source: 'playback', forward: false, fraction: 0.9 },
  ]) {
    assert.equal(store.markHeard(subject, 374, segmentId, evidence).changed, false);
  }

  const heard = store.markHeard(subject, 374, segmentId, {
    source: 'playback', forward: true, fraction: 0.5,
  }).snapshot;
  assert.equal(heard.heardCount, 1);
  assert.equal(heard.practicedCount, 0);
  assert.equal(heard.percentage, 0);
});

test('practice requires a known stable segment, success, finite score, recording, and assessment evidence', () => {
  const progress = require(modulePath);
  const store = progress.createStore(memoryStorage(), () => 3_000);
  const source = segments(21);
  const subject = 'user:7';
  store.start(subject, 374, source);
  const segmentId = progress.stableSegmentId(374, source[0], 0);

  for (const evidence of [
    {},
    { success: false, score: 88, evidence: { kind: 'recording_assessment', assessmentId: 'a', recording: true } },
    { success: true, score: null, evidence: { kind: 'recording_assessment', assessmentId: 'a', recording: true } },
    { success: true, score: 88, evidence: { kind: 'recording_assessment', assessmentId: 'a' } },
    { success: true, score: 88, evidence: { kind: 'playback', assessmentId: 'a', recording: true } },
  ]) {
    assert.equal(store.markPracticed(subject, 374, segmentId, evidence).changed, false);
  }
  assert.equal(store.markPracticed(subject, 374, 'unknown-segment', validPracticeEvidence('a')).changed, false);

  const result = store.markPracticed(subject, 374, segmentId, validPracticeEvidence('assessment-1'));
  assert.equal(result.changed, true);
  assert.equal(result.snapshot.heardCount, 1);
  assert.equal(result.snapshot.practicedCount, 1);
  assert.equal(result.snapshot.percentage, 5);
  assert.equal(result.snapshot.complete, false);
  assert.deepEqual(result.snapshot.practicedSegmentIds, [segmentId]);
});

test('refresh preserves one subject while account switching remains isolated', () => {
  const progress = require(modulePath);
  const storage = memoryStorage();
  const source = segments(2);
  const first = progress.createStore(storage, () => 4_000);
  const id = progress.stableSegmentId(374, source[0], 0);
  first.start('user:7', 374, source);
  first.markPracticed('user:7', 374, id, validPracticeEvidence('refresh-proof'));

  const refreshed = progress.createStore(storage, () => 5_000);
  assert.equal(refreshed.start('user:7', 374, source).practicedCount, 1);
  assert.equal(refreshed.start('user:8', 374, source).practicedCount, 0);
  assert.equal(refreshed.start('user:7', 999, source).practicedCount, 0);
});

test('general progress sync is blocked until complete and runs once from the completion snapshot', () => {
  const progress = require(modulePath);
  const storage = memoryStorage();
  let now = 6_000;
  const store = progress.createStore(storage, () => now++);
  const source = segments(2);
  const subject = 'user:7';
  const synced = [];
  store.start(subject, 374, source);

  const firstId = progress.stableSegmentId(374, source[0], 0);
  const secondId = progress.stableSegmentId(374, source[1], 1);
  store.markPracticed(subject, 374, firstId, validPracticeEvidence('one'));
  assert.equal(store.syncCompleted(subject, 374, (snapshot) => synced.push(snapshot)), false);

  const completed = store.markPracticed(subject, 374, secondId, validPracticeEvidence('two')).snapshot;
  assert.equal(completed.practicedCount, 2);
  assert.equal(completed.percentage, 100);
  assert.equal(completed.complete, true);
  assert.equal(typeof completed.completedAt, 'number');
  assert.equal(store.syncCompleted(subject, 374, (snapshot) => synced.push(snapshot)), true);
  assert.equal(store.syncCompleted(subject, 374, (snapshot) => synced.push(snapshot)), false);
  assert.equal(synced.length, 1);
  assert.deepEqual(
    { practiced: synced[0].practicedCount, total: synced[0].total, percentage: synced[0].percentage, complete: synced[0].complete },
    { practiced: 2, total: 2, percentage: 100, complete: true },
  );
});

test('desktop and mobile integrations read practice snapshots and never convert navigation into practice', () => {
  const desktop = fs.readFileSync(desktopPath, 'utf8');
  const mobile = fs.readFileSync(mobileMainPath, 'utf8');
  const pro = fs.readFileSync(proControlsPath, 'utf8');

  assert.match(desktop, /firstLessonProgressStore\.start/);
  assert.match(desktop, /markPracticed[\s\S]*?recording_assessment/);
  assert.match(desktop, /syncCompleted[\s\S]*?recordVideoProgress/);
  assert.match(mobile, /firstLessonProgressStore\.start/);
  assert.match(mobile, /handlePracticeResult[\s\S]*?markPracticed[\s\S]*?recording_assessment/);
  assert.doesNotMatch(mobile.match(/function navigateMobileSegment\([\s\S]*?\n\}/)?.[0] || '', /markPracticed/);
  assert.match(pro, /markHeard[\s\S]*?source:\s*'playback'/);
  assert.match(pro, /refreshStudiedCounter[\s\S]*?practicedCount/);
  assert.doesNotMatch(pro.match(/function jumpSegments\([\s\S]*?\n  \}/)?.[0] || '', /markPracticed/);
  assert.doesNotMatch(pro.match(/function replayCurrentSegment\([\s\S]*?\n  \}/)?.[0] || '', /markPracticed/);
});
