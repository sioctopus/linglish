const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const frontend = path.resolve(__dirname, '../../frontend');
const fallbackPath = '/app-releases/android/internal/Linglish-0.1.5-code6-arm64.apk';
const fallbackHash = '564a080d38e777075925124e1ef556e364566d717682448f792986b82e39c6d8';
const read = name => fs.existsSync(path.join(frontend, name)) ? fs.readFileSync(path.join(frontend, name), 'utf8') : '';

function element(initial = {}) {
  const listeners = new Map();
  return {
    textContent: '', hidden: false, disabled: false, href: '', children: [], attributes: {}, ...initial,
    set innerHTML(_) { throw new Error('Untrusted release content must remain text'); },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    addEventListener(name, listener) { listeners.set(name, listener); },
    replaceChildren(...children) { this.children = children; },
    click() { if (!this.disabled) return listeners.get('click')?.({ preventDefault() {} }); },
  };
}

function manifest(overrides = {}) {
  return {
    schemaVersion: 1, platform: 'android', channel: 'internal', applicationId: 'org.linglish.mobile.dev',
    version: '0.1.6', versionCode: 7, bytes: 40_000_000, sha256: 'a'.repeat(64),
    notes: ['优化学习体验'], publishedAt: '2026-10-31T12:00:00.000Z',
    apkPath: '/app-releases/android/internal/Linglish-0.1.6-code7-arm64.apk', ...overrides,
  };
}

function harness(fetcher) {
  const nodes = Object.fromEntries([
    'android-download', 'release-version', 'release-size', 'release-status', 'release-retry',
    'release-notes', 'release-sha256',
  ].map(id => [id, element()]));
  nodes['android-download'].href = fallbackPath;
  nodes['release-version'].textContent = '0.1.5';
  nodes['release-size'].textContent = '35.7 MB';
  nodes['release-sha256'].textContent = fallbackHash;
  const requests = [];
  const timers = new Map();
  let timerId = 0;
  const sandbox = {
    document: { getElementById: id => nodes[id], createElement: () => element() },
    fetch(url, options) { requests.push({ url, options }); return fetcher(url, options); },
    AbortController, URL, console,
    setTimeout(callback) { timers.set(++timerId, callback); return timerId; },
    clearTimeout(id) { timers.delete(id); },
  };
  for (const key of ['localStorage', 'sessionStorage']) {
    Object.defineProperty(sandbox, key, { get() { throw new Error('Public downloads cannot read account storage'); } });
  }
  sandbox.window = sandbox;
  vm.runInNewContext(read('js/pages/app-download.js'), sandbox);
  return {
    nodes, requests,
    async settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); },
    timeout() { for (const callback of [...timers.values()]) callback(); },
  };
}

const response = payload => ({ ok: true, redirected: false, json: async () => payload });

test('the public page has a usable APK link before JavaScript executes', () => {
  const html = read('download.html');
  const anchor = html.match(/<a\b[^>]*\bid="android-download"[^>]*>/)?.[0];
  assert.ok(anchor, 'the page must provide a real download link');
  assert.equal(anchor.match(/\bhref="([^"]+)"/)?.[1], fallbackPath);
  assert.equal(anchor.match(/\bdownload(?:="[^"]*")?(?=\s|>)/)?.[0].trim(), 'download');
  assert.ok(!/\b(?:hidden|disabled)\b/.test(anchor), 'the fallback remains usable without scripting');
});

test('checking the public manifest omits credentials and rejects redirects', async () => {
  const h = harness(async () => response(manifest()));
  await h.settle();
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].url, '/app-releases/android/internal/latest.json');
  assert.equal(h.requests[0].options.credentials, 'omit');
  assert.equal(h.requests[0].options.cache, 'no-store');
  assert.equal(h.requests[0].options.redirect, 'error');
  assert.equal(h.requests[0].options.headers, undefined, 'no account authorization is attached');
});

test('a verified newer release updates the visible version, size and manual download', async () => {
  const h = harness(async () => response(manifest({ notes: ['<img src=x onerror=alert(1)>'] })));
  await h.settle();
  assert.equal(h.nodes['android-download'].href, '/app-releases/android/internal/Linglish-0.1.6-code7-arm64.apk');
  assert.equal(h.nodes['release-version'].textContent, '0.1.6');
  assert.equal(h.nodes['release-size'].textContent, '40.0 MB');
  assert.equal(h.nodes['release-sha256'].textContent, 'a'.repeat(64));
  assert.equal(h.nodes['release-notes'].children[0].textContent, '<img src=x onerror=alert(1)>');
  assert.equal(h.nodes['release-status'].attributes['data-state'], 'success');
  assert.equal(h.requests.length, 1, 'checking never starts an APK download');
});

for (const [name, overrides] of [
  ['external URL', { apkPath: 'https://outside.example/Linglish-0.1.6-code7-arm64.apk' }],
  ['protocol-relative URL', { apkPath: '//outside.example/package.apk' }],
  ['traversal', { apkPath: '/app-releases/android/internal/../internal/Linglish-0.1.6-code7-arm64.apk' }],
  ['encoded traversal', { apkPath: '/app-releases/android/internal/%2e%2e/package.apk' }],
  ['query token', { apkPath: '/app-releases/android/internal/Linglish-0.1.6-code7-arm64.apk?token=secret' }],
  ['version mismatch', { version: '0.1.7' }],
  ['build mismatch', { versionCode: 8 }],
  ['wrong app', { applicationId: 'outside.app' }],
  ['wrong channel', { channel: 'production' }],
  ['wrong platform', { platform: 'ios' }],
  ['unknown schema', { schemaVersion: 2 }],
  ['invalid digest', { sha256: 'not-a-sha256' }],
  ['invalid size', { bytes: -1 }],
  ['invalid date', { publishedAt: 'yesterday' }],
  ['invalid notes', { notes: '<b>unsafe</b>' }],
]) {
  test(`an invalid manifest (${name}) preserves the verified fallback and offers retry`, async () => {
    const h = harness(async () => response(manifest(overrides)));
    await h.settle();
    assert.equal(h.nodes['android-download'].href, fallbackPath);
    assert.equal(h.nodes['release-version'].textContent, '0.1.5');
    assert.equal(h.nodes['release-status'].attributes['data-state'], 'error');
    assert.equal(h.nodes['release-retry'].hidden, false);
    assert.equal(h.nodes['release-retry'].disabled, false);
    assert.doesNotMatch(h.nodes['release-status'].textContent, /最新/);
  });
}

test('a failed check can be retried without losing the known download', async () => {
  let attempts = 0;
  const h = harness(async () => { if (++attempts === 1) throw new Error('offline'); return response(manifest()); });
  await h.settle();
  assert.equal(h.nodes['android-download'].href, fallbackPath);
  assert.equal(h.nodes['release-status'].attributes['data-state'], 'error');
  h.nodes['release-retry'].click();
  await h.settle();
  assert.equal(h.nodes['android-download'].href, '/app-releases/android/internal/Linglish-0.1.6-code7-arm64.apk');
  assert.equal(attempts, 2);
});

test('a redirected or unsuccessful HTTP response cannot replace the known download', async () => {
  for (const reply of [{ ok: false, status: 404 }, { ...response(manifest()), redirected: true }]) {
    const h = harness(async () => reply);
    await h.settle();
    assert.equal(h.nodes['android-download'].href, fallbackPath);
    assert.equal(h.nodes['release-status'].attributes['data-state'], 'error');
  }
});

test('an older published build never downgrades the available package', async () => {
  const h = harness(async () => response(manifest({ version: '0.1.4', versionCode: 5, apkPath: '/app-releases/android/internal/Linglish-0.1.4-code5-arm64.apk' })));
  await h.settle();
  assert.equal(h.nodes['android-download'].href, fallbackPath);
  assert.equal(h.nodes['release-version'].textContent, '0.1.5');
  assert.equal(h.nodes['release-status'].attributes['data-state'], 'stale');
  assert.doesNotMatch(h.nodes['release-status'].textContent, /最新/);
});

test('the same build cannot silently change the verified package identity', async () => {
  const h = harness(async () => response(manifest({ version: '0.1.5', versionCode: 6, apkPath: fallbackPath })));
  await h.settle();
  assert.equal(h.nodes['android-download'].href, fallbackPath);
  assert.equal(h.nodes['release-sha256'].textContent, fallbackHash);
  assert.equal(h.nodes['release-status'].attributes['data-state'], 'error');
});

test('a timed-out response cannot replace a newer successful retry', async () => {
  let resolveSlow;
  let attempts = 0;
  const h = harness(() => ++attempts === 1 ? new Promise(resolve => { resolveSlow = resolve; }) : Promise.resolve(response(manifest({ version: '0.1.7', versionCode: 8, apkPath: '/app-releases/android/internal/Linglish-0.1.7-code8-arm64.apk' }))));
  h.timeout();
  await h.settle();
  assert.equal(h.nodes['release-status'].attributes['data-state'], 'error');
  h.nodes['release-retry'].click();
  await h.settle();
  resolveSlow(response(manifest()));
  await h.settle();
  assert.equal(h.nodes['release-version'].textContent, '0.1.7');
  assert.equal(h.nodes['android-download'].href, '/app-releases/android/internal/Linglish-0.1.7-code8-arm64.apk');
  assert.equal(h.nodes['release-status'].attributes['data-state'], 'success');
});

test('a later stale manifest cannot downgrade a release already shown on the page', async () => {
  let attempts = 0;
  const h = harness(async () => response(++attempts === 1 ? manifest() : manifest({ version: '0.1.5', versionCode: 6, apkPath: fallbackPath, bytes: 35680859, sha256: fallbackHash })));
  await h.settle();
  h.nodes['release-retry'].click();
  await h.settle();
  assert.equal(h.nodes['release-version'].textContent, '0.1.6');
  assert.equal(h.nodes['android-download'].href, '/app-releases/android/internal/Linglish-0.1.6-code7-arm64.apk');
});
