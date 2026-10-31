const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const frontend = path.resolve(__dirname, '../../frontend');
const focusModulePath = path.join(frontend, 'js/video-reader/first-lesson-focus.js');
const { readPage } = require('./helpers/page-source');
const mobilePath = path.join(frontend, 'video-reader.html');
const mobileMainPath = path.join(frontend, 'js/video-reader/main.js');
const focusCssPath = path.join(frontend, 'styles/mobile/pages/video-reader-focus.css');

function createDocument() {
  return { documentElement: { dataset: {} } };
}

test('focus=first_lesson is the only product-mode flag and from remains attribution', () => {
  const focus = require(focusModulePath);

  assert.deepEqual(focus.readContext('?focus=first_lesson&from=today_first_lesson'), {
    enabled: true,
    from: 'today_first_lesson',
  });
  assert.equal(focus.readContext('?from=today_first_lesson').enabled, false);
  assert.equal(focus.readContext('?focus=other&from=today_first_lesson').enabled, false);

  const documentObject = createDocument();
  assert.equal(focus.applyDocumentState(documentObject, '?focus=first_lesson&from=landing'), true);
  assert.equal(documentObject.documentElement.dataset.learningFocus, 'first-lesson');
  focus.exitDocumentState(documentObject);
  assert.equal(documentObject.documentElement.dataset.learningFocus, undefined);
});

test('lifecycle completion analytics consume one truthful practice snapshot', () => {
  const focus = require(focusModulePath);
  const events = [];
  const tracker = focus.createLifecycleTracker({
    search: '?focus=first_lesson&from=landing_first_lesson',
    emit(name, properties) { events.push({ name, properties }); },
  });
  const snapshot = {
    videoId: '374', total: 21, practicedCount: 1, percentage: 5, complete: false,
  };

  tracker.ready({ video_resource_id: 374 });
  tracker.playback({ video_resource_id: 374 });
  tracker.practice(snapshot);
  tracker.practice(snapshot);
  tracker.feedback({ score: 88, segmentId: 'v:374:s:0' });

  assert.deepEqual(events.map((event) => event.name), [
    'first_lesson_ready',
    'first_lesson_playback_started',
    'first_lesson_sentence_completed',
    'first_lesson_ai_feedback_seen',
  ]);
  assert.deepEqual(events[2].properties, {
    from: 'landing_first_lesson',
    video_resource_id: '374',
    practiced: 1,
    total: 21,
    percentage: 5,
    complete: false,
  });
});

test('opening the library deactivates the mutable session and restores ordinary behavior', () => {
  const focus = require(focusModulePath);
  const documentObject = createDocument();
  const replacements = [];
  const events = [];
  const cleared = [];
  const session = focus.createSession({
    search: '?focus=first_lesson&from=today_first_lesson&videoId=374',
    pathname: '/video-reader.html',
    hash: '#line-1',
    document: documentObject,
    history: { replaceState(_state, _title, url) { replacements.push(url); } },
    onClear() { cleared.push('first-lesson-ui'); },
  });
  const tracker = focus.createLifecycleTracker({
    search: '?focus=first_lesson&from=today_first_lesson&videoId=374',
    isActive: () => session.isActive(),
    emit(name) { events.push(name); },
  });
  let firstLessonWrites = 0;
  let ordinaryResumeWrites = 0;
  let ordinaryVisitedWrites = 0;
  let waveformRefinements = 0;

  function selectOrdinaryVideo() {
    if (session.isActive()) firstLessonWrites += 1;
    else {
      ordinaryResumeWrites += 1;
      ordinaryVisitedWrites += 1;
      waveformRefinements += 1;
    }
    tracker.ready({ video_resource_id: 999 });
  }

  assert.equal(session.isActive(), true);
  session.deactivate('library-open');
  selectOrdinaryVideo();

  assert.equal(session.isActive(), false);
  assert.equal(documentObject.documentElement.dataset.learningFocus, undefined);
  assert.deepEqual(cleared, ['first-lesson-ui']);
  assert.deepEqual(replacements, ['/video-reader.html?from=today_first_lesson&videoId=374#line-1']);
  assert.equal(firstLessonWrites, 0);
  assert.equal(ordinaryResumeWrites, 1);
  assert.equal(ordinaryVisitedWrites, 1);
  assert.equal(waveformRefinements, 1);
  assert.deepEqual(events, []);
});

test('desktop focus defaults the library closed while keeping learning and recording controls', () => {
  const html = readPage('video-reader-desktop.html');
  const css = readPage('video-reader-desktop.html');

  const focusScript = html.indexOf('js/video-reader/first-lesson-focus.js');
  const progressScript = html.indexOf('js/video-reader/first-lesson-progress.js');
  const stateApplication = html.indexOf('applyDocumentState(document, window.location.search)');
  assert.ok(focusScript >= 0 && progressScript >= 0 && stateApplication >= 0);
  assert.ok(focusScript < stateApplication);
  assert.match(html, /firstLessonFocus[\s\S]*?setFocusMode\(true,\s*\{\s*persist:\s*false\s*\}\)/);
  assert.match(html, /LinglishReaderLayoutState\.toggleVideoLibrary/);
  assert.match(html, /setFocusMode\(next\.focusMode\)/);
  assert.match(html, /id="player"[^>]*controls/);
  assert.match(html, /id="active-subtitle"/);
  assert.match(html, /id="vrp-prev"|pro-controls\.js/);
  assert.match(html, /id="first-lesson-record"[^>]*(?:aria-label|title)=/);
  assert.match(css, /data-learning-focus="first-lesson"[\s\S]*?#open-video-browser[\s\S]*?display:\s*none/s);
  assert.doesNotMatch(css, /data-learning-focus="first-lesson"[^}]*#toggle-sidebar[^}]*display:\s*none/s);
});

test('device-routed reader keeps video, subtitles, Prev Replay Next, recording, and focus exit', () => {
  const html = fs.readFileSync(mobilePath, 'utf8');
  const main = fs.readFileSync(mobileMainPath, 'utf8');
  const css = fs.readFileSync(focusCssPath, 'utf8');

  assert.match(html, /js\/video-reader\/first-lesson-focus\.js/);
  assert.match(html, /js\/video-reader\/first-lesson-progress\.js/);
  assert.match(html, /applyDocumentState\(document, window\.location\.search\)/);
  assert.match(html, /id="video-player"/);
  assert.match(html, /id="mobile-transcript-list"/);
  assert.match(html, /id="mobile-prev-segment"[^>]*aria-label=/);
  assert.match(html, /id="mobile-replay"[^>]*aria-label=/);
  assert.match(html, /id="mobile-next-segment"[^>]*aria-label=/);
  assert.match(html, /id="practice-start"[^>]*(?:aria-label|title)=/);
  assert.match(main, /toggle-sidebar-btn[\s\S]*?firstLessonSession\.deactivate\('library-open'\)/);
  assert.match(css, /data-learning-focus="first-lesson"/);
});

test('generic onboarding tour is suppressed only by the focus product flag', () => {
  const desktop = readPage('video-reader-desktop.html');
  assert.match(desktop, /LinglishTour\.shouldStartTour\(window\.location\.search\)/);
});
