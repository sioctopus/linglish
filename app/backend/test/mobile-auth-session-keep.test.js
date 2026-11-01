const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Regression: signing in on the mobile page revoked the session it had just been
// issued, so the next page got 401 "登录已过期" and the learner looped back to login.
const frontend = path.resolve(__dirname, '../../frontend');
const html = fs.readFileSync(path.join(frontend, 'mobile-auth.html'), 'utf8');
const authManager = fs.readFileSync(path.join(frontend, 'js/auth-manager.js'), 'utf8');

function jwt(payload) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256' })}.${encode(payload)}.signature`;
}
const now = Math.floor(Date.now() / 1000);
const ISSUED = {
  access_token: jwt({ sub: 7, sid: 'new-session', exp: now + 3600 }),
  refresh_token: jwt({ sub: 7, sid: 'new-session', typ: 'refresh', exp: now + 86400 }),
  device_id: 'device_issued_by_server_0001',
};

function storage(initial = []) {
  const values = new Map(initial);
  return { values, getItem: key => (values.has(key) ? values.get(key) : null), setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
}

function element(attributes = '') {
  const listeners = new Map();
  const classes = new Set((attributes.match(/class="([^"]*)"/)?.[1] || '').split(/\s+/));
  return {
    value: '', checked: false, disabled: false, textContent: '', style: {}, dataset: {},
    classList: { toggle(name, on) { if (on) classes.add(name); else classes.delete(name); }, contains: n => classes.has(n), add: n => classes.add(n), remove: n => classes.delete(n) },
    setAttribute(name, value) { this[name] = value; }, removeAttribute(name) { delete this[name]; },
    querySelectorAll: () => [], querySelector: () => null,
    addEventListener(name, handler) { listeners.set(name, handler); },
    async fire(name) { await listeners.get(name)?.({ preventDefault() {}, currentTarget: this }); },
  };
}

function response(status, payload) {
  return { ok: status < 400, status, headers: new Headers(), json: async () => payload, clone() { return response(status, payload); } };
}

async function signIn(action, { previousRefresh } = {}) {
  const nodes = new Map([...html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)].map(match => [match[1], element(match[0])]));
  const requests = [];
  const local = storage([['linglish_visitor_id', 'llv_session_keep_test01'], ...(previousRefresh ? [['linglish_refresh_token', previousRefresh]] : [])]);
  const timers = [];
  const replaced = [];
  const location = { href: 'https://test.linglish.local/mobile-auth.html', origin: 'https://test.linglish.local', pathname: '/mobile-auth.html', search: '', assign() {}, replace: url => replaced.push(url) };
  const sandbox = {
    URL, URLSearchParams, Uint8Array, Headers, atob, localStorage: local, sessionStorage: storage(), location,
    navigator: { userAgent: 'Test mobile', cookieEnabled: false }, innerWidth: 390,
    console: { log() {}, warn() {}, error() {} },
    setTimeout(fn, delay) { timers.push({ fn, delay }); return 0; }, clearTimeout() {},
    addEventListener() {},
    crypto: { getRandomValues: bytes => bytes.fill(7) },
    document: { cookie: '', getElementById: id => nodes.get(id) || null, querySelector: () => element(), querySelectorAll: () => [] },
    fetch: async (url, init = {}) => {
      requests.push({ url, body: init.body ? JSON.parse(init.body) : null });
      if (url === '/auth/login' || url === '/auth/register') return response(200, ISSUED);
      return response(200, {});
    },
  };
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(authManager, context, { filename: 'auth-manager.js' });
  for (const script of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    if (!script[1].includes('src=') && script[2].includes('const safeStorage =')) vm.runInContext(script[2], context, { filename: 'mobile-auth.inline.js' });
  }
  nodes.get(`${action}-account`).value = 'fixture@example.invalid';
  nodes.get(`${action}-password`).value = 'fixture-password';
  nodes.get('remember-me').checked = true;
  if (action === 'register') {
    nodes.get('register-confirm-password').value = 'fixture-password';
    nodes.get('agree-terms').checked = true;
  }
  await nodes.get(`${action}-form`).fire('submit');
  for (let i = 0; i < 5; i += 1) await new Promise(resolve => setImmediate(resolve));
  timers.filter(timer => timer.delay === 500).forEach(timer => timer.fn());
  return { requests, local, replaced, AuthManager: sandbox.AuthManager };
}

for (const action of ['login', 'register']) {
  test(`${action} keeps the session the server just issued`, async () => {
    const { requests, local, AuthManager } = await signIn(action);
    const revoked = requests.filter(r => r.url === '/auth/logout' && r.body?.refresh_token === ISSUED.refresh_token);
    assert.deepEqual(revoked, [], 'the new refresh credential must never be sent to /auth/logout');
    assert.equal(AuthManager.getToken(), ISSUED.access_token);
    assert.equal(local.getItem('linglish_refresh_token'), ISSUED.refresh_token, 'the refresh credential must survive so the session can renew');
    assert.equal(local.getItem('linglish_device_id'), ISSUED.device_id);
  });
}

test('login returns to the homepage and leaves the login page out of history', async () => {
  const { replaced } = await signIn('login');
  assert.deepEqual(replaced, ['/?from=login']);
});
