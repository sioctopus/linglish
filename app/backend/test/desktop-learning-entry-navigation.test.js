const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const frontend = path.resolve(__dirname, '../../frontend');
const homePath = path.join(frontend, 'index-desktop.html');
const todayPath = path.join(frontend, 'today.html');
const practicePath = path.join(frontend, 'practice-session-desktop.html');

test('home normal training stays ordinary while Today first lesson uses the focus contract', () => {
  const home = fs.readFileSync(homePath, 'utf8');
  const html = fs.readFileSync(todayPath, 'utf8');
  const startTodayLearning = home.match(/function startTodayLearning\(event, source = 'hero'\)\s*\{[\s\S]*?\n    \}/);
  const firstLessonHref = html.match(/function firstLessonHref\(\)\s*\{[\s\S]*?\n    \}/);

  assert.ok(startTodayLearning, 'startTodayLearning should exist');
  assert.ok(firstLessonHref, 'firstLessonHref should exist');
  assert.match(startTodayLearning[0], /getVideoHrefForLevel\(lv\)/);
  assert.doesNotMatch(startTodayLearning[0], /\.\/today\.html/);
  assert.match(
    html,
    /id="first-lesson-start"[^>]*href="\.\/video-reader-desktop\.html\?from=today_first_lesson&focus=first_lesson"/
  );
  assert.match(firstLessonHref[0], /video-reader-desktop\.html/);
  assert.match(firstLessonHref[0], /focus:\s*'first_lesson'/);
  assert.doesNotMatch(firstLessonHref[0], /practice-session-desktop\.html/);
  assert.doesNotMatch(startTodayLearning[0], /focus=first_lesson/);
});

function extractFirstLessonDecision(html) {
  const helper = html.match(/function handleFirstLessonStart\(event, trigger\)\s*\{[\s\S]*?\n    \}/);

  assert.ok(helper, 'handleFirstLessonStart should exist');
  return helper[0];
}

function executeFirstLessonDecision(helper, state, token, guestCalls) {
  const getToken = () => token;
  const startGuestFirstLesson = (event, trigger) => {
    guestCalls.push({ event, trigger });
    event.preventDefault();
  };
  return new Function('state', 'getToken', 'startGuestFirstLesson', `${helper}; return handleFirstLessonStart;`)(
    state,
    getToken,
    startGuestFirstLesson
  );
}

function clickEvent(href) {
  let defaultPrevented = false;
  return {
    currentTarget: { href },
    preventDefault() {
      defaultPrevented = true;
    },
    get defaultPrevented() {
      return defaultPrevented;
    },
  };
}

test('today first lesson delegates anonymous, valid, and expired sessions to the shared entry controller', () => {
  const html = fs.readFileSync(todayPath, 'utf8');
  const helper = extractFirstLessonDecision(html);

  assert.match(html, /<script src="\.\/js\/first-lesson-entry\.js[^>]*><\/script>/);
  assert.match(helper, /event\.preventDefault\(\)/);
  assert.match(helper, /LinglishFirstLessonEntry\.start\(/);
  assert.match(helper, /source:\s*'today_first_lesson'/);
  assert.match(helper, /videoId:\s*state\.firstVideo\?\.id/);
  assert.doesNotMatch(helper, /if\s*\(currentToken\)\s*return/);
});

test('focus next button uses the active shadowing state machine', () => {
  const html = fs.readFileSync(practicePath, 'utf8');

  assert.match(html, /function handleFocusNextSentence\(\)/);
  assert.match(
    html,
    /currentPracticeMode === 'shadowing'[\s\S]*?goToNextSentence\(\)/
  );
  assert.match(
    html,
    /focusNextBtn\.onclick\s*=\s*\(\)\s*=>\s*handleFocusNextSentence\(\)/
  );
  assert.match(
    html,
    /function goToNextSentence\(\)[\s\S]*?shadowingCurrentIndex\+\+[\s\S]*?playCurrentSentenceAuto\(\)/
  );
});
