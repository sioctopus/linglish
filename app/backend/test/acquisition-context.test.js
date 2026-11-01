const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const frontend = path.resolve(__dirname, '../../frontend');
const acquisitionPath = path.join(frontend, 'js/acquisition-context.js');
const trackerPath = path.join(frontend, 'js/page-tracker.js');
const landingPath = path.join(frontend, 'landing.html');

function createStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
  };
}

function createEnvironment(url, referrer = '', storage = createStorage()) {
  const parsed = new URL(url);
  return {
    localStorage: storage,
    location: {
      href: parsed.href,
      origin: parsed.origin,
      pathname: parsed.pathname,
      search: parsed.search,
    },
    document: { referrer },
    crypto: { randomUUID: () => 'visitor-1' },
    Date,
  };
}

test('acquisition classifies Google, X, WeChat, direct, and gives UTM priority', () => {
  const acquisition = require(acquisitionPath);
  const cases = [
    ['https://www.example.com/', 'https://www.google.com/search?q=english', 'google', 'organic'],
    ['https://www.example.com/', 'https://t.co/abc', 'x', 'social'],
    ['https://www.example.com/', 'https://mp.weixin.qq.com/s/abc', 'wechat', 'social'],
    ['https://www.example.com/', '', 'direct', 'none'],
    ['https://www.example.com/?utm_source=newsletter&utm_medium=email', 'https://www.google.com/', 'newsletter', 'email'],
  ];

  for (const [url, referrer, source, medium] of cases) {
    const controller = acquisition.createAcquisitionContext(createEnvironment(url, referrer));
    const context = controller.capture();
    assert.equal(context.first_source, source);
    assert.equal(context.first_medium, medium);
  }
});

test('first touch survives same-site navigation and decorate keeps one visitor identity', () => {
  const acquisition = require(acquisitionPath);
  const storage = createStorage();
  const first = acquisition.createAcquisitionContext(createEnvironment(
    'https://www.example.com/?utm_source=x&utm_campaign=launch',
    'https://x.com/wu',
    storage
  ));
  const firstContext = first.capture();

  const next = acquisition.createAcquisitionContext(createEnvironment(
    'https://www.example.com/video-reader.html?from=landing',
    'https://www.example.com/',
    storage
  ));
  const nextContext = next.capture();
  const decorated = next.decorate({ page: 'video-reader', source: 'internal_navigation' });

  assert.equal(firstContext.visitor_id, 'llv_visitor-1');
  assert.equal(nextContext.visitor_id, firstContext.visitor_id);
  assert.equal(nextContext.first_source, 'x');
  assert.equal(nextContext.first_campaign, 'launch');
  assert.equal(decorated.first_source, 'x');
  assert.equal(decorated.source, 'internal_navigation');
  assert.equal(decorated.visitor_id, firstContext.visitor_id);
});

test('page tracker decorates both anonymous and authenticated visit payloads', () => {
  const tracker = fs.readFileSync(trackerPath, 'utf8');
  const landing = fs.readFileSync(landingPath, 'utf8');

  assert.match(tracker, /LinglishVisitor\.decorateEvent\(payload\)/);
  assert.equal((tracker.match(/JSON\.stringify\(decorateEvent\(/g) || []).length, 2);
  assert.match(tracker, /fetch\('\/track\/page-visit'/);
  assert.match(tracker, /fetch\('\/events'/);
  assert.match(landing, /<script src="\.\/js\/visitor-context\.js\?v=1"><\/script>[\s\S]*?<script src="\.\/js\/first-lesson-entry\.js\?v=2026103001"><\/script>/);
});
