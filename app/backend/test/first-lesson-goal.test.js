const test = require('node:test');
const assert = require('node:assert/strict');
const progress = require('../../frontend/js/video-reader/first-lesson-progress');
const goals = require('../../frontend/js/video-reader/first-lesson-goal');
const segmentIds = (videoId, segments) => segments.map((segment, index) => progress.stableSegmentId(videoId, segment, index));

function fixture(count = 30) {
  const values = new Map();
  const storage = { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value) };
  let now = new Date(2026, 8, 22, 12).getTime();
  const clock = () => now;
  const segments = Array.from({ length: count }, (_, index) => ({ start: index * 3, end: index * 3 + 2, text: `Sentence ${index}.` }));
  const ids = segmentIds(10, segments);
  const full = progress.createStore(storage, clock);
  const goal = goals.createStore(storage, clock);
  let snapshot = full.start('user:1', 10, segments);
  return {
    storage, clock, segments, ids, full, goal,
    sync: () => goal.sync(snapshot, segments, ids),
    practice(index, success = true) {
      snapshot = full.markPracticed('user:1', 10, ids[index], {
        success, score: 90, evidence: { kind: 'recording_assessment', assessmentId: `a-${index}`, recording: true },
      }).snapshot;
    },
    snapshot: () => snapshot,
    tomorrow: () => { now += 24 * 60 * 60 * 1000; },
  };
}

test('three-sentence goal does not shorten or complete the full-video record', () => {
  const f = fixture();
  assert.equal(f.sync().total, 3);
  for (let index = 0; index < 3; index++) f.practice(index);
  assert.equal(f.sync().complete, true);
  assert.equal(f.snapshot().total, 30);
  assert.equal(f.snapshot().practicedCount, 3);
  assert.equal(f.snapshot().complete, false);
});

test('failed, repeated and heard-only sentences cannot inflate the goal', () => {
  const f = fixture();
  f.sync();
  f.full.markHeard('user:1', 10, f.ids[0], { source: 'playback', forward: true, fraction: 1 });
  f.practice(0, false);
  assert.equal(f.sync().completedCount, 0);
  f.practice(0);
  f.practice(0);
  f.practice(8);
  assert.equal(f.sync().completedCount, 1);
  assert.equal(f.sync().nextIndex, 1);
});

test('reload resumes same goal; next day starts next three only after completion', () => {
  const f = fixture();
  f.sync();
  f.practice(0);
  f.sync();
  f.tomorrow();
  const reload = goals.createStore(f.storage, f.clock);
  assert.equal(reload.sync(f.snapshot(), f.segments, f.ids).nextIndex, 1);
  f.practice(1); f.practice(2);
  assert.equal(reload.sync(f.snapshot(), f.segments, f.ids).complete, true);
  assert.equal(reload.sync(f.snapshot(), f.segments, f.ids).complete, true);
  f.tomorrow();
  const next = reload.sync(f.snapshot(), f.segments, f.ids);
  assert.equal(next.nextIndex, 3);
  assert.equal(next.completedCount, 0);
});

test('short videos, subject isolation, and transcript replacement are safe', () => {
  const f = fixture(2);
  assert.equal(f.sync().total, 2);
  assert.equal(f.goal.latest('user:2'), null);
  const changed = f.segments.map(segment => ({ ...segment, text: 'Replacement ' + segment.text }));
  const snapshot = f.full.start('user:1', 10, changed);
  const next = f.goal.sync(snapshot, changed, segmentIds(10, changed));
  assert.equal(next.completedCount, 0);
  assert.equal(next.nextIndex, 0);
});

test('completed video creates no empty or falsely completed goal', () => {
  const f = fixture(2);
  f.practice(0); f.practice(1);
  assert.equal(f.sync(), null);
});

test('unrecordably long lines are skipped and unavailable storage stays usable', () => {
  const f = fixture(4);
  f.segments[0].end = 35;
  const snapshot = f.full.start('user:1', 10, f.segments);
  const storage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  const store = goals.createStore(storage, f.clock);
  const goal = store.sync(snapshot, f.segments, segmentIds(10, f.segments));
  assert.equal(goal.nextIndex, 1);
  assert.equal(goal.saved, false);
  assert.equal(store.latest('user:1').videoId, '10');
});

test('one spoken sentence leaves a single line and two choices', () => {
  assert.equal(goals.sentenceResult(false, ['responsible', 'the']), '这句漏了 responsible、the。');
  assert.equal(goals.sentenceResult(true, []), '这句说出来了。');
  const calls = [];
  function element(tag) {
    return {
      tag, hidden: false, className: '', textContent: '', children: [], attrs: {},
      setAttribute(name, value) { this.attrs[name] = value; },
      removeAttribute(name) { delete this.attrs[name]; },
      append(...nodes) { this.children.push(...nodes); },
      replaceChildren(...nodes) { this.children = nodes; },
      addEventListener(type, fn) { this.listeners = { ...(this.listeners || {}), [type]: fn }; },
      click() { this.listeners?.click?.(); },
    };
  }
  const doc = { createElement: element };
  const container = element('div');
  container.ownerDocument = doc;
  container.classList = { add() {} };
  const card = goals.createCard(container, {
    mobile: false,
    listen() {},
    record() {},
    next() { calls.push('next'); },
  });
  card.update({ total: 3, completedCount: 0, complete: false, saved: true, nextIndex: 0 });
  card.feedback('先听，再开口。');
  card.settle('这句漏了 responsible。');
  card.feedback('这条说明不该盖住结果');
  const flat = [];
  (function walk(node) {
    flat.push(node);
    (node.children || []).forEach(walk);
  })(container);
  assert.equal(flat.find(node => node.className === 'goal-feedback').textContent, '这句漏了 responsible。');
  const again = flat.find(node => node.textContent === '再来一句');
  const stop = flat.find(node => node.textContent === '今天到这');
  assert.equal(again.hidden, false);
  assert.equal(stop.hidden, false);
  assert.equal(stop.href, './today.html#day-end');
  assert.equal(flat.find(node => node.tag === 'progress').hidden, true);
  again.click();
  assert.deepEqual(calls, ['next']);
});

test('resume URLs are same-origin known pages and reject invalid video IDs', () => {
  assert.equal(goals.resumeHref({ videoId: 'javascript:alert(1)' }, true), null);
  const url = new URL(goals.resumeHref({ videoId: '10' }, true), 'https://example.com/');
  assert.equal(url.pathname, '/video-reader.html');
  assert.equal(url.searchParams.get('videoId'), '10');
  assert.equal(url.searchParams.get('focus'), 'first_lesson');
});

test('readable old storage cannot overwrite an unsaved next-day goal when quota is full', () => {
  const f = fixture();
  f.sync();
  f.practice(0); f.practice(1); f.practice(2);
  f.sync(); f.tomorrow();
  const store = goals.createStore({ getItem: f.storage.getItem, setItem() { throw new Error('quota'); } }, f.clock);
  const next = store.sync(f.snapshot(), f.segments, f.ids);
  assert.equal(next.nextIndex, 3);
  f.practice(3);
  const resumed = store.sync(f.snapshot(), f.segments, f.ids);
  assert.equal(resumed.completedCount, 1);
  assert.deepEqual(resumed.ids, next.ids);
});
