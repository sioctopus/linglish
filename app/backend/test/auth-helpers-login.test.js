const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const helperSource = fs.readFileSync(path.join(__dirname, '../../frontend/auth-helpers.js'), 'utf8');

function loadHelper({ pathname, statusFor, authManager, fetchImpl }) {
  const alerts = [];
  const cleared = [];
  const location = {
    pathname,
    href: `http://local${pathname}`,
  };
  const window = {
    location,
    innerWidth: 1280,
    alert(message) { alerts.push(message); },
    setTimeout(fn) { fn(); return 0; },
    AuthManager: authManager || {
      clearToken() { cleared.push('token'); },
    },
    fetch: fetchImpl || function fetch(url) {
      return Promise.resolve({
        status: statusFor(url),
        clone() { return this; },
        async json() { return { message: 'INVALID_CREDENTIALS' }; },
      });
    },
  };
  window.window = window;
  vm.runInNewContext(helperSource, {
    window,
    location,
    alert: window.alert,
    setTimeout: window.setTimeout,
    Headers: globalThis.Headers,
  });
  return { window, alerts, cleared, location };
}

test('a failed password login stays on the auth page', async () => {
  const page = loadHelper({
    pathname: '/desktop-auth.html',
    statusFor(url) { return String(url).includes('/auth/login') ? 401 : 200; },
  });

  const response = await page.window.fetch('/auth/login', { method: 'POST' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(response.status, 401);
  assert.deepEqual(page.alerts, []);
  assert.deepEqual(page.cleared, []);
  assert.equal(page.location.href, 'http://local/desktop-auth.html');
});

test('an expired session outside the auth page still returns to login', async () => {
  const options = [];
  const page = loadHelper({
    pathname: '/today.html',
    statusFor() { return 401; },
    authManager: {
      clearToken(value) { options.push(value || {}); },
    },
  });

  await page.window.fetch('/users/me');
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(page.alerts, ['登录已过期，请重新登录']);
  assert.equal(options.length, 1);
  assert.equal(options[0].skipRevoke, true);
  assert.equal(page.location.href, './desktop-auth.html');
});

test('a renewable session stays signed in and does not revoke the login', async () => {
  const calls = [];
  const page = loadHelper({
    pathname: '/index-desktop.html',
    statusFor() { return 401; },
    authManager: {
      clearToken(options) { calls.push(options || {}); },
      async ensureSession() { return 'header.payload.signature'; },
      isTokenExpired() { return false; },
      isLoggedIn() { return true; },
    },
    fetchImpl(url, init) {
      const authorization = init && init.headers && typeof init.headers.get === 'function'
        ? init.headers.get('Authorization')
        : '';
      return Promise.resolve({
        status: String(authorization).includes('header.payload.signature') ? 200 : 401,
        clone() { return this; },
        async json() { return { message: 'TOKEN_EXPIRED' }; },
      });
    },
  });

  const response = await page.window.fetch('/users/me', {
    headers: { Authorization: 'Bearer expired.access.token' },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(page.alerts, []);
  assert.deepEqual(calls, []);
  assert.equal(page.location.href, 'http://local/index-desktop.html');
});

test('login pages remember the account and can stay signed in together', () => {
  const desktop = fs.readFileSync(path.join(__dirname, '../../frontend/desktop-auth.html'), 'utf8');
  const mobile = fs.readFileSync(path.join(__dirname, '../../frontend/mobile-auth.html'), 'utf8');
  const home = fs.readFileSync(path.join(__dirname, '../../frontend/index-desktop.html'), 'utf8');
  for (const source of [desktop, mobile, home]) {
    assert.match(source, /userEmail/);
    assert.match(source, /ensureSession|prefillSavedAccount/);
  }
  assert.match(mobile, /autocomplete="username"/);
  assert.match(mobile, /autocomplete="current-password"/);
  assert.match(home, /session: result\.session/);
  assert.doesNotMatch(desktop, /localStorage\.setItem\(\s*['"]password['"]/);
  assert.doesNotMatch(mobile, /localStorage\.setItem\(\s*['"]password['"]/);
});
