const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '../../frontend/auth-helpers.js'), 'utf8');

function harness(status = 401, message = 'INVALID_CREDENTIALS') {
  const alerts = [];
  const timers = [];
  const values = new Map([['authToken', 'existing-session'], ['linglish_token', 'existing-session']]);
  const storage = { removeItem: key => values.delete(key) };
  const sandbox = {
    URL,
    navigator: { language: 'en' },
    location: { href: 'https://example.com/mobile-auth.html', pathname: '/mobile-auth.html' },
    localStorage: storage,
    sessionStorage: storage,
    innerWidth: 390,
    alert: message => alerts.push(message),
    setTimeout: callback => timers.push(callback),
    fetch: async () => new Response(JSON.stringify({ message }), { status, headers: { 'Content-Type': 'application/json' } }),
  };
  sandbox.window = sandbox;
  vm.runInNewContext(source, sandbox);
  return { sandbox, alerts, timers, values };
}

test('failed credential entry returns its error without a session-expired alert or redirect', async t => {
  const inputs = [
    '/auth/login',
    'https://example.com/auth/login?redirect=%2Ftoday.html',
    new Request('https://example.com/auth/login', { method: 'POST' }),
    new URL('https://example.com/auth/login'),
  ];
  for (const input of inputs) {
    await t.test(String(input.url || input), async () => {
      const h = harness();
      const response = await h.sandbox.fetch(input);
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { message: 'INVALID_CREDENTIALS' });
      assert.deepEqual(h.alerts, []);
      assert.equal(h.timers.length, 0);
      assert.equal(h.values.get('authToken'), 'existing-session');
    });
  }
});

test('session establishment failures do not consume the later protected-page expiry handler', async () => {
  const h = harness();
  for (const endpoint of ['/auth/register', '/auth/guest', '/auth/refresh', '/auth/oauth/session']) {
    await h.sandbox.fetch(endpoint);
  }
  assert.deepEqual(h.alerts, []);
  await h.sandbox.fetch('/users/me');
  assert.deepEqual(h.alerts, ['Login expired, please log in again']);
  assert.equal(h.values.has('authToken'), false);
});

test('an expired protected request still clears credentials and redirects only once', async () => {
  const h = harness();
  await h.sandbox.fetch('/articles?next=/auth/login');
  await h.sandbox.fetch('/users/me');
  assert.deepEqual(h.alerts, ['Login expired, please log in again']);
  assert.equal(h.values.has('authToken'), false);
  assert.equal(h.timers.length, 1);
  h.timers[0]();
  assert.equal(h.sandbox.location.href, './mobile-auth.html');
});

test('a banned login still shows the account restriction and clears old credentials', async () => {
  const h = harness(403, 'BANNED');
  const response = await h.sandbox.fetch('/auth/login');
  await new Promise(setImmediate);
  assert.deepEqual(await response.json(), { message: 'BANNED' });
  assert.deepEqual(h.alerts, ['Your account has been banned. Please contact support']);
  assert.equal(h.values.has('authToken'), false);
});

test('ordinary forbidden responses remain available to the page without clearing a session', async () => {
  const h = harness(403, 'FORBIDDEN');
  const response = await h.sandbox.fetch('/articles/123');
  await new Promise(setImmediate);
  assert.deepEqual(await response.json(), { message: 'FORBIDDEN' });
  assert.deepEqual(h.alerts, []);
  assert.equal(h.values.get('authToken'), 'existing-session');
});
