const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { readPage } = require('./helpers/page-source');

const frontend = path.resolve(__dirname, '../../frontend');
const source = fs.readFileSync(path.join(frontend, 'js/auth-manager.js'), 'utf8');

function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
}
function jwt(exp) { return `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ sub: 7, exp })).toString('base64url')}.fixture`; }
function harness(options = {}) {
  let now = 1_800_000_000_000;
  let blocked = Boolean(options.blocked);
  const local = storage(options.initial || {});
  const session = storage();
  const requests = [];
  const sandbox = {
    Headers, Uint8Array, atob, Promise, URL,
    location: { href: 'https://linglish.example/today.html' },
    Date: class extends Date { static now() { return now; } },
    navigator: { cookieEnabled: false }, document: { cookie: '' },
    console: { log() {}, warn() {}, error() {} },
    fetch: async (url, init) => {
      requests.push({ url, init });
      return options.fetch ? options.fetch(url, init) : { ok: true, status: 200, json: async () => ({ access_token: jwt(Math.floor(now / 1000) + 3600), refresh_token: 'rotated-refresh' }) };
    },
  };
  for (const [name, value] of [['localStorage', local], ['sessionStorage', session]]) {
    Object.defineProperty(sandbox, name, { get() { if (blocked) throw new DOMException('Storage blocked', 'SecurityError'); return value; } });
  }
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(source, context);
  return { manager: sandbox.AuthManager, sandbox, context, requests, advance(ms) { now += ms; }, block() { blocked = true; }, initialToken: jwt(1_800_003_600) };
}

test('a completed session check releases its tracked promise so a later expiry refreshes', async () => {
  const h = harness({ initial: { authToken: jwt(1_800_003_600), linglish_refresh_token: 'initial-refresh' } });
  await h.manager.ready;
  assert.equal(await h.manager.ensureSession(), h.initialToken);
  h.advance(3_500_000);
  const renewed = await h.manager.ensureSession();
  assert.equal(h.requests.filter(r => r.url === '/auth/refresh').length, 1);
  assert.notEqual(renewed, h.initialToken);
  assert.equal(h.manager.getToken(), renewed);
});

test('concurrent forced refreshes share one rotation request and the same access token', async () => {
  let resolve;
  const response = new Promise(done => { resolve = done; });
  const h = harness({ initial: { authToken: jwt(1_800_003_600), linglish_refresh_token: 'initial-refresh' }, fetch: () => response });
  const checks = [h.manager.ensureSession({ force: true }), h.manager.ensureSession({ force: true }), h.manager.ensureSession({ force: true })];
  resolve({ ok: true, status: 200, json: async () => ({ access_token: jwt(1_800_007_200), refresh_token: 'rotated-once' }) });
  const tokens = await Promise.all(checks);
  assert.equal(h.requests.filter(r => r.url === '/auth/refresh').length, 1);
  assert.equal(new Set(tokens).size, 1);
});

test('completed refresh rotations release the tracked promise for the next access expiry', async () => {
  const h = harness({ initial: { authToken: jwt(1_800_000_100), linglish_refresh_token: 'initial-refresh' } });
  const first = await h.manager.ensureSession();
  h.advance(3_500_000);
  const second = await h.manager.ensureSession();
  assert.equal(h.requests.filter(r => r.url === '/auth/refresh').length, 2);
  assert.notEqual(first, second);
});

test('a concurrent fast session check does not swallow a forced 401 renewal', async () => {
  const h = harness({ initial: { authToken: jwt(1_800_003_600), linglish_refresh_token: 'initial-refresh' } });
  const normal = h.manager.ensureSession();
  const forced = h.manager.ensureSession({ force: true });
  await Promise.all([normal, forced]);
  assert.equal(h.requests.filter(r => r.url === '/auth/refresh').length, 1);
});

test('a failed refresh releases its promise and a later check can retry', async () => {
  let attempts = 0;
  const h = harness({
    initial: { authToken: jwt(1_800_000_100), linglish_refresh_token: 'initial-refresh' },
    fetch: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('offline');
      return { ok: true, status: 200, json: async () => ({ access_token: jwt(1_800_007_200), refresh_token: 'rotated-refresh' }) };
    },
  });
  await h.manager.ensureSession();
  assert.equal(await h.manager.ensureSession(), jwt(1_800_007_200));
  assert.equal(attempts, 2);
});

test('authenticated page requests refresh a 401 once and retry with the rotated credential', async () => {
  let requests = 0;
  const h = harness({
    initial: { authToken: jwt(1_800_003_600), linglish_refresh_token: 'initial-refresh' },
    fetch: async (url, init) => {
      if (url === '/auth/refresh') {
        return { ok: true, status: 200, json: async () => ({ access_token: jwt(1_800_007_200), refresh_token: 'rotated-refresh' }) };
      }
      requests += 1;
      return { ok: requests > 1, status: requests > 1 ? 200 : 401 };
    },
  });
  const response = await h.sandbox.fetch('/articles', { headers: { Authorization: `Bearer ${h.manager.getToken()}` } });
  assert.equal(response.status, 200);
  assert.equal(h.requests.filter(r => r.url === '/auth/refresh').length, 1);
  const retry = h.requests.filter(r => r.url === '/articles')[1];
  assert.equal(retry.init.headers.get('Authorization'), `Bearer ${jwt(1_800_007_200)}`);
});

test('storage property SecurityError still permits login and logout using memory', async () => {
  const h = harness({ blocked: true });
  assert.equal(await h.manager.saveLogin({ access_token: jwt(1_800_003_600), refresh_token: 'memory-refresh' }, true), true);
  assert.equal(h.manager.getToken(), h.initialToken);
  await h.manager.clearToken({ skipRevoke: true, skipMediaSession: true });
  assert.equal(h.manager.getToken(), null);
});

test('storage revoked after initialization falls back to memory without throwing', async () => {
  const h = harness();
  h.block();
  await h.manager.saveLogin({ access_token: jwt(1_800_003_600), refresh_token: 'memory-refresh' }, true);
  assert.equal(h.manager.getToken(), h.initialToken);
  assert.equal(await h.manager.ensureSession(), h.initialToken);
});

for (const page of ['document-import.html', 'daily-speaking.html', 'exam-paper.html']) {
  test(`${page} loads AuthManager before inline requests and reads credentials from it`, () => {
    const html = readPage(page);
    const managerScript = html.indexOf('src="./js/auth-manager.js');
    const inlineToken = html.indexOf('function readToken()');
    assert.ok(managerScript >= 0 && managerScript < inlineToken, 'the shared refresh and retry handler must load before requests');
    const functions = [...html.matchAll(/function (readToken|readAuthToken)\(\) \{([\s\S]*?)\n    \}/g)];
    assert.ok(functions.length > 0);
    for (const entry of functions) {
      const context = vm.createContext({ window: { AuthManager: { getToken: () => 'renewed-credential' } } });
      vm.runInContext(`${entry[0]}; result = ${entry[1]}();`, context);
      assert.equal(context.result, 'renewed-credential');
      context.window.AuthManager.getToken = () => null;
      vm.runInContext(`result = ${entry[1]}();`, context);
      assert.equal(context.result, '', 'a cleared session must not fall back to stale raw storage');
    }
  });
}

test('external API failures never refresh or receive account credentials', async () => {
  const h = harness({ initial: { authToken: jwt(1_800_003_600), linglish_refresh_token: 'initial-refresh' }, fetch: async () => ({ ok: false, status: 401 }) });
  await h.sandbox.fetch(new URL('https://outside.example/media'), { headers: { Authorization: 'Bearer unrelated-external-token' } });
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].init.headers.Authorization, 'Bearer unrelated-external-token');
});

test('an external login response cannot replace the Linglish refresh session', async () => {
  const h = harness({ initial: { authToken: jwt(1_800_003_600), linglish_refresh_token: 'initial-refresh' }, fetch: async () => ({ ok: true, status: 200, clone() { return this; }, json: async () => ({ refresh_token: 'external-session', access_token: jwt(1_800_007_200) }) }) });
  await h.sandbox.fetch('https://outside.example/auth/login');
  await new Promise(setImmediate);
  assert.equal(h.manager.getToken(), h.initialToken);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].init, undefined);
});
