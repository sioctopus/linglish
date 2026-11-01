const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const frontend = path.resolve(__dirname, '../../frontend');
const { readPage } = require('./helpers/page-source');
function read(file) { return readPage(file); }
function extractFunction(source, name) {
  const match = source.match(new RegExp(`(^[ \\t]*)function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^\\1\\}`, 'm'));
  assert.ok(match, `${name} exists`);
  return match[0];
}

for (const page of ['practice-session.html', 'practice-session-desktop.html']) {
  const source = read(page);
  function initialMode(search, savedMode) {
    const context = {
      URLSearchParams,
      window: { location: { search } },
      localStorage: { getItem: () => savedMode },
      PRACTICE_MODE_STORAGE_KEY: 'linglish_practice_mode',
    };
    const functions = ['loadPracticeModePreference', 'getInitialPracticeMode'];
    if (page.includes('desktop')) functions.push('getPracticePageParams', 'isQuickFirstLesson');
    vm.runInNewContext(functions.map(name => extractFunction(source, name)).join('\n'), context);
    return context.getInitialPracticeMode();
  }

  test(`${page}: an explicit learning choice wins over the last practice mode`, () => {
    assert.equal(initialMode('?mode=shadowing', 'dialogue'), 'shadowing');
    assert.equal(initialMode('?mode=dialogue', 'shadowing'), 'dialogue');
  });
  test(`${page}: existing preference remains the default without a valid choice`, () => {
    assert.equal(initialMode('', 'dialogue'), 'dialogue');
    assert.equal(initialMode('?mode=reading', 'dialogue'), 'dialogue');
    assert.equal(initialMode('?mode=arena', 'shadowing'), 'shadowing');
    assert.equal(initialMode('?mode=unknown', 'invalid'), 'shadowing');
  });
  test(`${page}: a quick first lesson always enters shadowing`, () => {
    assert.equal(initialMode('?quick=1&mode=dialogue', 'dialogue'), 'shadowing');
    assert.equal(initialMode('?from=today_first_lesson', 'dialogue'), 'shadowing');
  });
}

const todayHtml = read('mobile-today.html');
function entryHarness() {
  const entries = new Map();
  for (const match of todayHtml.matchAll(/<a id="(learning-entry-[^"]+)"[^>]*href="([^"]+)"/g)) {
    entries.set(match[1], { href: match[2], setAttribute(name, value) { this[name] = value; } });
  }
  const context = {
    document: { getElementById: id => entries.get(id) },
    encodeURIComponent,
    bindRecoClick() {},
  };
  vm.runInNewContext(extractFunction(read('js/mobile-today.js'), 'updateLearningEntryLinks'), context);
  return { entries, update: context.updateLearningEntryLinks };
}
function destination(entry) { return new URL(entry.href, 'https://www.example.com/'); }

test('the mobile first screen opens one sentence instead of a mode menu', () => {
  const { entries } = entryHarness();
  assert.equal(entries.size, 1);
  const practice = destination(entries.get('learning-entry-shadowing'));
  assert.equal(practice.pathname, '/video-reader.html');
  assert.equal(practice.searchParams.get('mode'), 'shadowing');
  assert.equal(practice.searchParams.get('focus'), 'first_lesson');
  assert.equal(entries.get('learning-entry-listening'), undefined);
  assert.equal(entries.get('learning-entry-game'), undefined);
  assert.ok(todayHtml.indexOf('id="learning-entry-shadowing"') < todayHtml.indexOf('id="learning-details"'));
  assert.ok(todayHtml.indexOf('id="learning-details"') < todayHtml.indexOf('href="./game.html"'));
});

test('a recommendation stays on the same shadowing sentence', () => {
  const { entries, update } = entryHarness();
  update({ id: 162 });
  const practice = destination(entries.get('learning-entry-shadowing'));
  assert.equal(practice.pathname, '/video-reader.html');
  assert.equal(practice.searchParams.get('mode'), 'shadowing');
  assert.equal(practice.searchParams.get('focus'), 'first_lesson');
  assert.equal(practice.searchParams.get('videoId'), '162');
});

test('missing recommendations retain shadowing and video IDs stay encoded', () => {
  const { entries, update } = entryHarness();
  update({ id: '162&mode=dialogue' });
  const practice = destination(entries.get('learning-entry-shadowing'));
  assert.equal(practice.searchParams.get('videoId'), '162&mode=dialogue');
  assert.equal(practice.searchParams.get('mode'), 'shadowing');
  assert.equal(practice.searchParams.get('focus'), 'first_lesson');
  update(null);
  assert.equal(destination(entries.get('learning-entry-shadowing')).searchParams.has('videoId'), false);
  assert.equal(destination(entries.get('learning-entry-shadowing')).pathname, '/video-reader.html');
});

const desktopToday = read('today.html');
function desktopEntryHarness(plan, video) {
  const entries = new Map();
  for (const match of desktopToday.matchAll(/<a\b([^>]*)>/g)) {
    const id = match[1].match(/\bid="(learning-entry-[^"]+)"/)?.[1];
    const href = match[1].match(/\bhref="([^"]+)"/)?.[1];
    if (id && href) entries.set(id, { href });
  }
  const context = {
    state: { plan, firstVideo: video }, URLSearchParams, encodeURIComponent,
    normalizeLevel: () => 'beginner', LEVEL_META: { beginner: { name: '初级', desc: '' } },
    setText() {}, renderStatusPills() {},
    setHref(id, href) { if (entries.has(id)) entries.get(id).href = href; },
  };
  vm.runInNewContext(['videoHref', 'practiceHref', 'renderLearningEntryLinks', 'renderHero']
    .map(name => extractFunction(desktopToday, name)).join('\n'), context);
  return { entries, render: context.renderHero };
}

test('desktop today opens on one sentence, with game and import after practice', () => {
  assert.match(desktopToday, /id="first-lesson-start"[^>]*href="\.\/video-reader-desktop\.html\?from=today_first_lesson&focus=first_lesson"/);
  assert.match(desktopToday, /开始说这一句/);
  assert.doesNotMatch(desktopToday, /id="learning-entry-game"/);
  assert.doesNotMatch(desktopToday, /id="learning-entry-listening"/);
  assert.doesNotMatch(desktopToday, /今天想怎么学/);
  assert.ok(desktopToday.indexOf('id="first-lesson-start"') < desktopToday.indexOf('id="day-end"'));
  assert.ok(desktopToday.indexOf('id="day-end"') < desktopToday.indexOf('href="./game.html"'));
  assert.ok(desktopToday.indexOf('id="day-end"') < desktopToday.indexOf('href="./youtube-import.html"'));
});

test('a desktop plan cannot replace the next sentence with review or a mode menu', () => {
  const { entries } = desktopEntryHarness({ primaryAction: { href: './video-vocabulary-desktop.html' } }, { id: 162 });
  assert.equal(entries.size, 0);
  const start = desktopToday.match(/id="first-lesson-start"[^>]*href="([^"]+)"/);
  assert.ok(start);
  assert.equal(new URL(start[1], 'https://www.example.com/').searchParams.get('focus'), 'first_lesson');
});
