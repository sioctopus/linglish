const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const frontend = path.resolve(__dirname, '../../frontend');
const modulePath = path.join(frontend, 'js/first-lesson-entry.js');
const landingPath = path.join(frontend, 'landing.html');
const todayPath = path.join(frontend, 'today.html');

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
    snapshot() { return Object.fromEntries(values); },
  };
}

function response(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  };
}

function createEnvironment(options = {}) {
  const localStorage = createStorage(options.local || {});
  const sessionStorage = createStorage(options.session || {});
  const requests = [];
  const destinations = [];
  const visitorId = options.visitorId || 'llv_existingvisitor12';
  let currentToken = options.token || null;
  let guestCount = 0;
  let videoRequestCount = 0;
  let profileRequestCount = 0;
  let clearCount = 0;

  const environment = {
    localStorage,
    sessionStorage,
    innerWidth: options.mobile ? 390 : 1280,
    navigator: { userAgent: options.mobile ? 'Mozilla/5.0 (iPhone)' : 'Mozilla/5.0 (Macintosh)' },
    location: {
      search: '?utm_source=launch',
      pathname: '/landing.html',
      assign(destination) { destinations.push(destination); },
    },
    LinglishVisitor: { getId: () => visitorId },
    AuthManager: {
      getToken() { return currentToken; },
      isTokenExpired(token) { return token === 'expired-token'; },
      async clearToken() {
        clearCount += 1;
        currentToken = null;
        localStorage.removeItem('linglish_token');
        localStorage.removeItem('authToken');
      },
      async setToken(token) { currentToken = token; },
    },
    fetch: async (url, requestOptions = {}) => {
      requests.push({ url, options: requestOptions });
      if (url === '/auth/guest') {
        guestCount += 1;
        return response(200, { access_token: `guest-token-${guestCount}`, guest_id: `guest-${guestCount}` });
      }
      if (url === '/auth/profile') {
        profileRequestCount += 1;
        if (options.firstProfileStatus === 401 && profileRequestCount === 1) {
          return response(401, { message: 'TOKEN_REVOKED' });
        }
        return response(200, { user: { id: 7 } });
      }
      if (/^\/video-resources\/\d+$/.test(url)) {
        const preferredId = Number(url.split('/').pop());
        if (options.preferredStatus === 404) return response(404, { message: 'Video not found' });
        return response(200, {
          video: options.preferredVideo === undefined
            ? { id: preferredId, status: 'ready', video_path: `/videos/${preferredId}.mp4`, has_subtitles: true }
            : options.preferredVideo,
        });
      }
      if (url === '/video-resources?lite=1') {
        videoRequestCount += 1;
        if (options.firstVideoStatus === 401 && videoRequestCount === 1) {
          return response(401, { message: 'TOKEN_EXPIRED' });
        }
        return response(200, options.videoPayload === undefined
          ? { items: [{ id: 374, status: 'ready', video_path: '/videos/374.mp4', has_subtitles: true }] }
          : options.videoPayload);
      }
      return response(204, {});
    },
  };

  return {
    environment,
    requests,
    destinations,
    localStorage,
    getToken: () => currentToken,
    getClearCount: () => clearCount,
  };
}

test('first lesson destinations carry the sole focus flag while normal video links do not', () => {
  const entry = require(modulePath);

  assert.equal(
    entry.buildDestination({ mobile: false, source: 'landing_first_lesson', level: 'A1', videoId: 374 }),
    './video-reader-desktop.html?from=landing_first_lesson&focus=first_lesson&level=A1&videoId=374',
  );
  assert.equal(
    entry.buildDestination({ mobile: true, source: 'landing_final_first_lesson', level: 'B1', videoId: 88 }),
    './video-reader.html?from=landing_final_first_lesson&focus=first_lesson&level=B1&videoId=88',
  );

  const today = fs.readFileSync(todayPath, 'utf8');
  assert.match(today, /id="first-lesson-start"[^>]*href="\.\/video-reader-desktop\.html\?from=today_first_lesson&focus=first_lesson"/);
  assert.match(today, /function firstLessonHref\(\)[\s\S]*?focus:\s*'first_lesson'/);
  assert.match(today, /function videoHref\(video\)[\s\S]*?from=today/);
  assert.doesNotMatch(today.match(/function videoHref\(video\)[\s\S]*?\n    \}/)?.[0] || '', /focus=/);
});

test('anonymous entry opens the built-in starter without requiring an account', async () => {
  const entry = require(modulePath);
  const { environment, requests, destinations, localStorage } = createEnvironment();
  const controller = entry.createFirstLessonEntry(environment);

  await Promise.all([
    controller.start({ source: 'landing_first_lesson', level: 'A1' }),
    controller.start({ source: 'landing_first_lesson', level: 'A1' }),
  ]);

  assert.equal(requests.filter((request) => request.url === '/auth/guest').length, 0);
  assert.equal(localStorage.getItem('linglish_visitor_id'), null, 'shared visitor identity must not be replaced');
  assert.equal(localStorage.getItem('linglish_token'), null);
  assert.deepEqual(destinations, ['./today.html?from=landing_first_lesson&starter=1']);
});

test('an expired stored account token opens the anonymous starter without a guest token', async () => {
  const entry = require(modulePath);
  const { environment, requests, destinations, getToken } = createEnvironment({
    token: 'expired-token',
    local: { linglish_token: 'expired-token', authToken: 'expired-token' },
  });
  const controller = entry.createFirstLessonEntry(environment);

  await controller.start({ source: 'landing_first_lesson' });

  assert.equal(requests.filter((request) => request.url === '/auth/guest').length, 0);
  assert.equal(requests.filter((request) => request.url === '/video-resources?lite=1').length, 0);
  assert.equal(getToken(), null);
  assert.deepEqual(destinations, ['./today.html?from=landing_first_lesson&starter=1']);
});

test('a 401 during preselection opens the anonymous starter without creating a guest', async () => {
  const entry = require(modulePath);
  const { environment, requests, destinations, getToken } = createEnvironment({
    token: 'apparently-valid-token',
    firstVideoStatus: 401,
  });
  const controller = entry.createFirstLessonEntry(environment);

  await controller.start({ source: 'landing_first_lesson' });

  assert.equal(requests.filter((request) => request.url === '/video-resources?lite=1').length, 1);
  assert.equal(requests.filter((request) => request.url === '/auth/guest').length, 0);
  assert.equal(getToken(), null);
  assert.deepEqual(destinations, ['./today.html?from=landing_first_lesson&starter=1']);
});

test('a preferred video still validates a locally valid token and server-side playability', async () => {
  const entry = require(modulePath);
  const { environment, requests, destinations } = createEnvironment({ token: 'valid-token' });

  await entry.createFirstLessonEntry(environment).start({
    source: 'today_first_lesson',
    videoId: 374,
  });

  assert.equal(requests.filter((request) => request.url === '/auth/profile').length, 1);
  assert.equal(requests.filter((request) => request.url === '/video-resources/374').length, 1);
  assert.equal(requests.find((request) => request.url === '/auth/profile').options.headers.Authorization, 'Bearer valid-token');
  assert.equal(requests.find((request) => request.url === '/video-resources/374').options.headers.Authorization, 'Bearer valid-token');
  assert.equal(destinations[0].includes('videoId=374'), true);
});

test('a server-revoked preferred-video token is cleared once before opening the anonymous starter', async () => {
  const entry = require(modulePath);
  const { environment, requests, destinations, getToken, getClearCount } = createEnvironment({
    token: 'locally-valid-but-revoked',
    firstProfileStatus: 401,
  });

  await entry.createFirstLessonEntry(environment).start({
    source: 'today_first_lesson',
    videoId: 374,
  });

  assert.equal(getClearCount(), 1);
  assert.equal(requests.filter((request) => request.url === '/auth/guest').length, 0);
  assert.equal(requests.filter((request) => request.url === '/auth/profile').length, 1);
  assert.equal(getToken(), null);
  assert.deepEqual(destinations, ['./today.html?from=today_first_lesson&starter=1']);
});

test('a missing preferred video falls back to a separately validated playable video', async () => {
  const entry = require(modulePath);
  const { environment, requests, destinations } = createEnvironment({
    token: 'valid-token',
    preferredStatus: 404,
    videoPayload: {
      items: [{ id: 375, status: 'ready', youtube_video_id: 'abcdefghijk', has_subtitles: true }],
    },
  });

  await entry.createFirstLessonEntry(environment).start({ source: 'today_first_lesson', videoId: 374 });

  assert.equal(requests.filter((request) => request.url === '/video-resources/374').length, 1);
  assert.equal(requests.filter((request) => request.url === '/video-resources?lite=1').length, 1);
  assert.equal(destinations[0].includes('videoId=375'), true);
});

test('failed or unplayable preferred videos never navigate unless a playable fallback exists', async () => {
  const entry = require(modulePath);
  const cases = [
    { id: 374, status: 'failed', video_path: '/videos/failed.mp4', has_subtitles: true },
    { id: 374, status: 'ready', has_subtitles: true },
  ];

  for (const preferredVideo of cases) {
    const { environment, destinations } = createEnvironment({
      token: 'valid-token',
      preferredVideo,
      videoPayload: { items: [] },
    });
    const trigger = {
      textContent: '开始首课', dataset: {},
      setAttribute() {}, removeAttribute() {},
    };

    await assert.rejects(
      () => entry.createFirstLessonEntry(environment).start({ source: 'today_first_lesson', videoId: 374, trigger }),
      /FIRST_LESSON_VIDEO_UNAVAILABLE/,
    );
    assert.deepEqual(destinations, []);
    assert.match(trigger.textContent, /重试/);
  }
});

test('an empty video result stays on the entry page and leaves a retryable trigger', async () => {
  const entry = require(modulePath);
  const { environment, destinations } = createEnvironment({ token: 'valid-token', videoPayload: { items: [] } });
  const trigger = {
    textContent: '开始首课',
    dataset: {},
    attributes: new Map(),
    setAttribute(name, value) { this.attributes.set(name, value); },
    removeAttribute(name) { this.attributes.delete(name); },
  };
  const controller = entry.createFirstLessonEntry(environment);

  await assert.rejects(
    () => controller.start({ source: 'landing_first_lesson', trigger }),
    /FIRST_LESSON_VIDEO_UNAVAILABLE/,
  );

  assert.deepEqual(destinations, []);
  assert.equal(trigger.attributes.has('aria-disabled'), false);
  assert.match(trigger.textContent, /重试/);
});

test('a quiet landing failure keeps the original button label', async () => {
  const entry = require(modulePath);
  const { environment, destinations } = createEnvironment({ token: 'valid-token', videoPayload: { items: [] } });
  const trigger = {
    textContent: '免注册练 3 句',
    dataset: {},
    attributes: new Map(),
    setAttribute(name, value) { this.attributes.set(name, value); },
    removeAttribute(name) { this.attributes.delete(name); },
  };

  await assert.rejects(
    () => entry.createFirstLessonEntry(environment).start({
      source: 'landing_first_lesson',
      trigger,
      quietFailure: true,
    }),
    /FIRST_LESSON_VIDEO_UNAVAILABLE/,
  );

  assert.deepEqual(destinations, []);
  assert.equal(trigger.textContent, '免注册练 3 句');
});

test('Landing uses the shared first lesson entry for both product CTAs and preserves login routing', () => {
  const html = fs.readFileSync(landingPath, 'utf8');

  assert.match(html, /<script src="\.\/js\/visitor-context\.js[^>]*><\/script>/);
  assert.match(html, /<script src="\.\/js\/auth-manager\.js[^>]*><\/script>/);
  assert.match(html, /<script src="\.\/js\/first-lesson-entry\.js[^>]*><\/script>/);
  assert.match(html, /function startLandingFirstLesson\(event, source\)/);
  assert.match(html, /quietFailure:\s*true/);
  assert.match(html, /starter=1/);
  assert.match(html, /btn-start[\s\S]*?startLandingFirstLesson\(event, 'landing_first_lesson'\)/);
  assert.match(html, /btn-final[\s\S]*?startLandingFirstLesson\(event, 'landing_final_first_lesson'\)/);
  assert.match(html, /btn-login[\s\S]*?redirect\(true\)/);
  assert.match(html, /id="account-chip"/);
  assert.match(html, /退出登录/);
  assert.match(html, /account-badge[\s\S]*?href="\.\/membership\.html"/);
});

for (const mobile of [false, true]) {
  test(`anonymous ${mobile ? 'mobile' : 'desktop'} first lesson opens a real starter without profile or guest requests`, async () => {
    const entry = require(modulePath);
    const { environment, requests, destinations } = createEnvironment({ mobile });
    await entry.createFirstLessonEntry(environment).start({ source: 'public_trial' });
    assert.deepEqual(destinations, ['./today.html?from=public_trial&starter=1']);
    assert.equal(requests.some(r => r.url.startsWith('/auth/')), false);
    const today = fs.readFileSync(todayPath, 'utf8');
    assert.match(today, /get\('starter'\) === '1'/);
    assert.match(today, /if \(requested.*openStarterSentence\(\)/);
  });
}
