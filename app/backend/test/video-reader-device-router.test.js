const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let DeviceRouter = {};
try {
  DeviceRouter = require('../../frontend/js/video-reader/device-router');
} catch (_) {
  // RED phase: behavior assertions below should fail until the router exists.
}

function target(overrides = {}) {
  return DeviceRouter.getRedirectTarget({
    pathname: '/video-reader-desktop.html',
    search: '',
    hash: '',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    viewportWidth: 1440,
    mediaMatches: false,
    ...overrides
  });
}

test('mobile UA redirects desktop reader and preserves search and hash', () => {
  assert.equal(typeof DeviceRouter.getRedirectTarget, 'function');

  assert.equal(
    target({
      search: '?videoId=123&from=today_first_lesson',
      hash: '#vocabulary',
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
      viewportWidth: 390,
      mediaMatches: true
    }),
    './video-reader.html?videoId=123&from=today_first_lesson#vocabulary'
  );
});

test('the real mobile redirect target loads visitor and first-lesson readiness before its reader code', () => {
  const redirectTarget = target({
    search: '?videoId=123&from=today_first_lesson',
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
    viewportWidth: 390,
    mediaMatches: true,
  });
  const relativePage = redirectTarget.split(/[?#]/, 1)[0].replace(/^\.\//, '');
  const pagePath = path.resolve(__dirname, '../../frontend', relativePage);
  const html = fs.readFileSync(pagePath, 'utf8');
  const visitorIndex = html.indexOf('<script src="./js/visitor-context.js');
  const readinessIndex = html.indexOf('<script src="./js/video-reader/first-lesson-readiness.js');
  const readerIndex = html.indexOf('<script src="./js/video-reader/main.js');

  assert.ok(visitorIndex >= 0, 'redirect target must load the visitor context');
  assert.ok(readinessIndex >= 0, 'redirect target must load first-lesson readiness');
  assert.ok(visitorIndex < readerIndex, 'visitor context must load before the reader');
  assert.ok(readinessIndex < readerIndex, 'readiness must load before the reader');
});

test('narrow viewport redirects even when the user agent is not mobile', () => {
  assert.equal(
    target({
      viewportWidth: 768,
      mediaMatches: true
    }),
    './video-reader.html'
  );
});

test('desktop reader remains on desktop for a wide desktop browser', () => {
  assert.equal(target(), null);
});

test('desktop override prevents redirect on a phone', () => {
  assert.equal(
    target({
      search: '?videoId=123&desktop=1',
      userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9)',
      viewportWidth: 390,
      mediaMatches: true
    }),
    null
  );
});

test('mobile reader never redirects to itself on a mobile device', () => {
  assert.equal(
    target({
      pathname: '/courses/video-reader.html',
      search: '?videoId=a%2Fb',
      hash: '#line-3',
      userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9)',
      viewportWidth: 390,
      mediaMatches: true
    }),
    null
  );
});

test('mobile reader redirects a wide desktop browser and preserves location data', () => {
  assert.equal(
    target({
      pathname: '/video-reader.html',
      search: '?videoId=a%2Fb&from=library',
      hash: '#line-3'
    }),
    './video-reader-desktop.html?videoId=a%2Fb&from=library#line-3'
  );
});

test('iPad portrait uses the phone reader and YouhuaPad landscape keeps the desktop reader', () => {
  assert.equal(
    target({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      viewportWidth: 834,
      maxTouchPoints: 5,
      pointer: 'coarse',
      hover: 'none',
      mediaMatches: false
    }),
    './video-reader.html'
  );

  assert.equal(
    target({
      userAgent: 'Mozilla/5.0 (Linux; Android 13; YouhuaPad) AppleWebKit',
      viewportWidth: 1280,
      maxTouchPoints: 5,
      pointer: 'coarse',
      hover: 'none',
      mediaMatches: false
    }),
    null
  );
});

test('unrelated pages are never redirected', () => {
  assert.equal(
    target({
      pathname: '/today.html',
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
      viewportWidth: 390,
      mediaMatches: true
    }),
    null
  );
});
