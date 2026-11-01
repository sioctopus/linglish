const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const frontend = path.resolve(__dirname, '../../frontend');
const desktop = fs.readFileSync(path.join(frontend, 'js/pages/practice-session-desktop-app.js'), 'utf8');
const mobile = fs.readFileSync(path.join(frontend, 'js/pages/practice-session-app.js'), 'utf8');
const studySwitch = fs.readFileSync(path.join(frontend, 'js/study-switch.js'), 'utf8');

function register(context, source, name) {
  const match = source.match(new RegExp(`(^[ \\t]*)(?:async )?function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^\\1\\}`, 'm'));
  assert.ok(match, `${name} should exist`);
  vm.runInContext(match[0], context);
}

function bootContext(query = '') {
  const stored = new Map();
  const context = vm.createContext({
    URLSearchParams,
    pageParams: new URLSearchParams(query),
    localStorage: { getItem: (key) => stored.get(key) || null },
    window: {},
    isShareMode: () => new URLSearchParams(query).has('share'),
    isQuickFirstLesson: () => new URLSearchParams(query).get('quick') === '1',
  });
  register(context, desktop, 'readCanonicalStudyMedia');
  register(context, desktop, 'getPracticeBootSelection');
  return { context, stored };
}

function studySwitchContext(currentVideo, previousMedia) {
  const saved = new Map();
  const events = new Map();
  const links = ['video', 'coach', 'arena'].map((study) => ({
    dataset: { study }, attributes: new Map(),
    setAttribute(name, value) { this.attributes.set(name, value); },
    getAttribute(name) { return this.attributes.get(name); },
    removeAttribute(name) { this.attributes.delete(name); },
  }));
  const switchRoot = {
    querySelector: () => null,
    querySelectorAll: () => links,
    addEventListener: (event, handler) => events.set(event, handler),
  };
  const window = {
    location: { pathname: '/video-reader-desktop.html', search: '', href: 'https://example.test/video-reader-desktop.html' },
    addEventListener() {},
    requestIdleCallback: (callback) => callback(),
    LinglishVideoReaderState: { currentVideo, selectedVideoId: currentVideo.id },
    LinglishStudyMedia: previousMedia,
  };
  const context = vm.createContext({
    URL, URLSearchParams, window,
    document: {
      getElementById: (id) => id === 'study-switch' ? switchRoot : null,
      querySelectorAll: () => [], addEventListener() {},
    },
    localStorage: { getItem: () => null },
    sessionStorage: { setItem: (key, value) => saved.set(key, value) },
  });
  vm.runInContext(studySwitch, context);
  return {
    window, saved,
    enterPractice(study = 'coach') {
      const link = links.find((item) => item.dataset.study === study);
      events.get('click')({ target: { closest: () => link }, preventDefault() {} });
      return JSON.parse(saved.get('linglish.coach.media'));
    },
  };
}

test('podcast transcript segments survive canonical snapshots and produce practice lines', async () => {
  const currentVideo = {
    id: 'pod:with-transcript', audioUrl: 'https://example.test/podcast.mp3',
    transcript_segments: JSON.stringify([
      { text: ' First line. ', start_sec: '1.25', end_sec: '2.5' },
      { text: 'Second line.', startTime: 2.5, endTime: 4 },
    ]),
  };
  const reader = studySwitchContext(currentVideo);
  const media = reader.enterPractice();
  const state = {};
  const context = vm.createContext({
    state, window: {},
    document: { getElementById: () => null, querySelector: () => null },
    videoPlayer: { load() {} },
    rebuildSegmentRoleMap() {}, renderPracticeLines() {}, renderPracticeCurrentLine() {}, updatePracticeFeedback() {},
  });
  register(context, desktop, 'loadExternalCoachMedia');
  await context.loadExternalCoachMedia(media);
  assert.deepEqual(JSON.parse(JSON.stringify(state.currentSegments)), [
    { index: 0, text: 'First line.', start: 1.25, end: 2.5 },
    { index: 1, text: 'Second line.', start: 2.5, end: 4 },
  ]);
});

test('refreshing the study switch retains hydrated cues only for the matching media', () => {
  const hydrated = {
    id: 'pod:hydrated', audioUrl: 'https://example.test/podcast.mp3',
    cues: [{ index: 8, text: 'Already loaded.', start: 4, end: 6 }],
  };
  const reader = studySwitchContext({ id: hydrated.id, audioUrl: hydrated.audioUrl }, hydrated);
  assert.equal(reader.window.LinglishStudySelection.read().cues.length, 1);
  assert.equal(reader.window.LinglishStudyMedia.cues[0].text, 'Already loaded.');
  assert.equal(reader.enterPractice().cues[0].text, 'Already loaded.');

  reader.window.LinglishVideoReaderState.currentVideo = { id: 'pod:next', audioUrl: 'https://example.test/next.mp3' };
  reader.window.LinglishVideoReaderState.selectedVideoId = 'pod:next';
  const next = reader.enterPractice('arena');
  assert.equal(next.id, 'pod:next');
  assert.deepEqual(next.cues, []);
});

test('fresh transcript cues take precedence over a matching older hydrated snapshot', () => {
  const reader = studySwitchContext({
    id: 'pod:updated', audioUrl: 'https://example.test/podcast.mp3',
    transcript_segments: [{ text: 'Updated transcript.', start: 2, end: 3 }],
  }, {
    id: 'pod:updated', audioUrl: 'https://example.test/podcast.mp3',
    cues: [{ text: 'Old transcript.', start: 0, end: 1 }],
  });
  const media = reader.enterPractice();
  assert.equal(media.cues.length, 1);
  assert.equal(media.cues[0].text, 'Updated transcript.');
});

function externalPracticeContext(fetch) {
  const { context, stored } = bootContext();
  const state = {};
  const player = { load() {} };
  const start = { disabled: true };
  let renders = 0;
  Object.assign(context, {
    state, fetch, API_BASE: '', refreshAuthToken: () => 'account-token',
    sessionStorage: { getItem: () => null },
    document: { getElementById: (id) => id === 'start-practice-btn' ? start : null, querySelector: () => null },
    videoPlayer: player,
    rebuildSegmentRoleMap() {}, renderPracticeLines() { renders++; }, renderPracticeCurrentLine() {}, updatePracticeFeedback() {},
  });
  register(context, desktop, 'loadExternalCoachMedia');
  register(context, desktop, 'loadVideoData');
  return { context, stored, state, player, start, renderCount: () => renders };
}

test('restoring a cue-less saved podcast hydrates its transcript through the authenticated same-origin route', async () => {
  const requests = [];
  const harness = externalPracticeContext(async (url, options) => {
    requests.push({ url, ...options });
    return { ok: true, json: async () => ({ success: true, cues: [{ text: 'Restored line.', start: 1.5, end: 3 }] }) };
  });
  harness.stored.set('linglish.last_study_media.v1', JSON.stringify({
    id: 'pod:saved', audioUrl: 'https://example.test/saved.mp3', transcriptUrl: 'https://example.test/saved.vtt',
  }));
  await harness.context.loadVideoData();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/media/cues');
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].headers.Authorization, 'Bearer account-token');
  assert.equal(requests[0].headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(requests[0].body), { url: 'https://example.test/saved.vtt' });
  assert.equal(harness.state.currentSegments.length, 1);
  assert.equal(harness.state.currentSegments[0].text, 'Restored line.');
  assert.equal(harness.player.src, 'https://example.test/saved.mp3');
  assert.equal(harness.start.disabled, false);
});

test('hydrated external practice does not fetch its transcript again', async () => {
  const harness = externalPracticeContext(() => { throw new Error('Hydrated cues must not be fetched again'); });
  await harness.context.loadExternalCoachMedia({
    id: 'pod:ready', audioUrl: 'https://example.test/ready.mp3', transcriptUrl: 'https://example.test/ready.vtt',
    cues: [{ text: 'Ready to practise.', start: 0, end: 2 }],
  });
  assert.equal(harness.state.currentSegments.length, 1);
  assert.equal(harness.renderCount(), 1);
});

test('missing, empty and failed external transcripts stop before a player or empty practice is initialized', async () => {
  for (const scenario of ['missing', 'empty', 'http-error', 'network-error']) {
    const harness = externalPracticeContext(async () => {
      if (scenario === 'network-error') throw new Error('Connection failed');
      return { ok: scenario !== 'http-error', json: async () => ({ success: scenario !== 'http-error', cues: [] }) };
    });
    const media = { id: 'pod:unavailable', audioUrl: 'https://example.test/episode.mp3' };
    if (scenario !== 'missing') media.transcriptUrl = 'https://example.test/episode.vtt';
    await assert.rejects(harness.context.loadExternalCoachMedia(media), (error) => {
      assert.equal(error.code, 'external_transcript_unavailable');
      assert.match(error.message, /视频学习.*选/);
      return true;
    });
    assert.equal(harness.state.videoId, undefined);
    assert.equal(harness.player.src, undefined);
    assert.equal(harness.renderCount(), 0);
  }
});

test('unavailable external subtitles disable starting practice and offer a working library action', () => {
  const elements = [];
  const start = { disabled: false };
  const list = { innerHTML: '', appendChild(node) { elements.push(node); } };
  const context = vm.createContext({
    URLSearchParams, state: {}, pageParams: new URLSearchParams('videoId=pod:unavailable'),
    readCanonicalStudyMedia: () => null,
    window: { location: { href: '' } },
    practiceArmBtn: { disabled: false }, updatePracticeFeedback() {},
    document: {
      querySelector: () => null,
      getElementById: (id) => id === 'start-practice-btn' ? start : id === 'practice-line-list' ? list : null,
      createElement() {
        return { children: [], appendChild(node) { this.children.push(node); }, addEventListener(event, handler) { this[event] = handler; } };
      },
    },
  });
  register(context, desktop, 'buildPracticeLibraryHref');
  register(context, desktop, 'showPracticeLoadError');
  context.showPracticeLoadError({ code: 'external_transcript_unavailable', message: '请到视频学习重新选片' });
  assert.equal(start.disabled, true);
  const picker = elements[0].children.find((node) => node.textContent === '去视频学习选片');
  assert.ok(picker);
  picker.click();
  const url = new URL(context.window.location.href, 'https://example.test/');
  assert.equal(url.pathname, '/video-reader-desktop.html');
  assert.equal(url.searchParams.get('library'), 'videos');
});

test('practice uses the video-learning selection when opened without a content link', () => {
  const { context, stored } = bootContext();
  stored.set('linglish.last_study_media.v1', JSON.stringify({ id: '123', title: 'Older selection' }));
  context.window.LinglishStudySelection = { read: () => ({ id: '162', title: 'Selected lesson' }) };
  context.window.LinglishStudyRecent = { latest() { throw new Error('Recent history is not a selection'); } };
  assert.equal(context.getPracticeBootSelection().id, '162');
  delete context.window.LinglishStudySelection;
  assert.equal(context.getPracticeBootSelection().id, '123');
});

test('saved practice, pronunciation focus and shared links retain their explicit content', () => {
  for (const query of ['videoId=37', 'videoId=37&focusAssessment=9', 'videoId=37&share=shared-link']) {
    const { context, stored } = bootContext(query);
    stored.set('linglish.last_study_media.v1', JSON.stringify({ id: '162' }));
    assert.equal(context.getPracticeBootSelection().id, '37');
  }
});

test('quick first lessons do not resume an unrelated stored lesson', () => {
  const { context, stored } = bootContext('quick=1');
  stored.set('linglish.last_study_media.v1', JSON.stringify({ id: '162' }));
  assert.equal(context.getPracticeBootSelection(), null);
});

test('an explicit external handoff keeps its session media when older library state remains', async () => {
  let loaded;
  const handoff = { id: 'pod:new', audioUrl: 'https://example.test/new.mp3' };
  const context = vm.createContext({
    pageParams: new URLSearchParams('source=external'),
    isShareMode: () => false,
    getPracticeBootSelection: () => ({ id: '162' }),
    sessionStorage: { getItem: () => JSON.stringify(handoff) },
    loadExternalCoachMedia: async (media) => { loaded = media; },
  });
  register(context, desktop, 'loadVideoData');
  await context.loadVideoData();
  assert.equal(loaded.id, 'pod:new');
});

test('an explicit external content ID rejects a stale session handoff', async () => {
  let loaded;
  const selected = { id: 'pod:new', audioUrl: 'https://example.test/new.mp3' };
  const context = vm.createContext({
    pageParams: new URLSearchParams('source=external&videoId=pod:new'),
    isShareMode: () => false,
    getPracticeBootSelection: () => selected,
    sessionStorage: { getItem: () => JSON.stringify({ id: 'pod:old', audioUrl: 'https://example.test/old.mp3' }) },
    loadExternalCoachMedia: async (media) => { loaded = media; },
  });
  register(context, desktop, 'loadVideoData');
  await context.loadVideoData();
  assert.equal(loaded.id, 'pod:new');
});

test('a shared practice link never boots account-specific external media', async () => {
  let loaded;
  const context = vm.createContext({
    pageParams: new URLSearchParams('source=external&share=shared-lesson'),
    isShareMode: () => true,
    getShareToken: () => 'shared-lesson',
    loadShareVideoData: async (token) => { loaded = token; },
    sessionStorage: { getItem() { throw new Error('Account session media must not be read'); } },
  });
  register(context, desktop, 'loadVideoData');
  await context.loadVideoData();
  assert.equal(loaded, 'shared-lesson');
});

test('practice library navigation opens video learning with the loaded lesson and no account secrets', () => {
  const context = vm.createContext({
    URLSearchParams,
    state: { videoId: '162' },
    pageParams: new URLSearchParams('videoId=37&share=private-share&token=account-token'),
    readCanonicalStudyMedia: () => ({ id: '123' }),
  });
  register(context, desktop, 'buildPracticeLibraryHref');
  for (const library of ['videos', 'channels', 'podcasts', 'saved', 'unexpected']) {
    const url = new URL(context.buildPracticeLibraryHref(library), 'https://example.test/');
    assert.equal(url.pathname, '/video-reader-desktop.html');
    assert.equal(url.searchParams.get('library'), ['channels', 'podcasts'].includes(library) ? library : 'videos');
    assert.equal(url.searchParams.get('videoId'), '162');
    assert.equal(url.searchParams.has('returnTo'), false);
    assert.equal(url.searchParams.has('share'), false);
    assert.equal(url.searchParams.has('token'), false);
  }
});

test('mode-header collapse exposes the same state to sighted users and assistive technology', () => {
  let collapsed = false;
  const button = { textContent: '', setAttribute(name, value) { this[name] = value; } };
  const selector = { classList: { toggle(name, value) { collapsed = value; } } };
  const context = vm.createContext({ document: { getElementById: (id) => id === 'mode-toggle-btn' ? button : selector } });
  register(context, mobile, 'setModeSelectorCollapsed');
  context.setModeSelectorCollapsed(true);
  assert.equal(collapsed, true);
  assert.equal(button.textContent, '展开');
  assert.equal(button['aria-expanded'], 'false');
  context.setModeSelectorCollapsed(false);
  assert.equal(collapsed, false);
  assert.equal(button.textContent, '收起');
  assert.equal(button['aria-expanded'], 'true');
});
