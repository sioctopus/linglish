const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const frontend = path.resolve(__dirname, '../../frontend');
const html = fs.readFileSync(path.join(frontend, 'mobile-auth.html'), 'utf8');

function storage() {
  const values = new Map([['linglish_app_version', '2024.12.16.002'], ['linglish_visitor_id', 'llv_entry_test_browser123']]);
  return { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
}

// A DOM boundary double: the real page registers and runs its own handlers.
function element(attributes = '') {
  const listeners = new Map();
  const classes = new Set((attributes.match(/class="([^"]*)"/)?.[1] || '').split(/\s+/));
  return {
    value: '', checked: false, disabled: false, textContent: '', style: {}, dataset: {},
    classList: {
      toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
      contains: name => classes.has(name), add: name => classes.add(name), remove: name => classes.delete(name),
    },
    setAttribute(name, value) { this[name] = value; },
    removeAttribute(name) { delete this[name]; },
    querySelectorAll: () => [], querySelector: () => null,
    addEventListener(name, handler) { listeners.set(name, handler); },
    async fire(name) { await listeners.get(name)?.({ preventDefault() {}, currentTarget: this }); },
    async click() { await this.fire('click'); },
  };
}

function loadPage(search = '', options = {}) {
  const nodes = new Map([...html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)].map(match => [match[1], element(match[0])]));
  const guestButton = element();
  const requests = [];
  const destinations = [];
  const timers = [];
  const location = { href: `https://test.linglish.local/mobile-auth.html${search}`, origin: 'https://test.linglish.local', pathname: '/mobile-auth.html', search, assign: url => destinations.push(url) };
  let guestAttempts = 0;
  const sandbox = {
    URL, URLSearchParams, Uint8Array, localStorage: storage(), sessionStorage: storage(), location,
    navigator: { userAgent: 'Test mobile' }, innerWidth: 390,
    console: { log() {}, warn() {}, error() {} },
    setTimeout(fn, delay) { timers.push({ fn, delay }); },
    addEventListener() {},
    document: {
      getElementById: id => nodes.get(id) || null,
      querySelector: selector => selector === '.guest-btn' ? guestButton : null,
      querySelectorAll: () => [],
    },
    fetch: async (url, init = {}) => {
      requests.push({ url, init });
      let status = 200;
      let payload = {};
      if (url === '/auth/guest') {
        guestAttempts += 1;
        status = options.failFirstGuest && guestAttempts === 1 ? 503 : 200;
        payload = status === 200 ? { access_token: 'test.guest.token', guest_id: 'test-guest' } : { message: 'TEMPORARILY_UNAVAILABLE' };
      } else if (url === '/auth/profile') payload = { user: { id: 1 } };
      else if (url === '/video-resources?lite=1') payload = { items: [{ id: 374, status: 'ready', video_path: '/videos/374.mp4', has_subtitles: true }] };
      else if (url === '/auth/login' || url === '/auth/register') payload = { access_token: 'test.account.token' };
      return { ok: status < 400, status, json: async () => payload };
    },
  };
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  for (const script of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    const source = script[1].match(/src="([^"?]+)(?:\?[^" ]*)?"/)?.[1];
    if (source?.endsWith('/first-lesson-entry.js') && !options.missingEntry) {
      vm.runInContext(fs.readFileSync(path.join(frontend, source), 'utf8'), context);
    } else if (!source && script[2].includes('const safeStorage =')) {
      vm.runInContext(script[2], context, { filename: 'mobile-auth.inline.js' });
    }
  }
  return {
    nodes, requests, destinations, guestButton, location,
    flushRedirects() { timers.filter(timer => timer.delay === 500).forEach(timer => timer.fn()); },
    trial() { const button = nodes.get('auth-first-lesson'); assert.ok(button, 'the first-lesson button must exist outside the auth forms'); return button; },
  };
}

test('trial waits for a click and asks for an account instead of creating a guest', async () => {
  const page = loadPage('?next=%2Fpricing.html%3Fintent%3Dplans%23plans');
  assert.equal(page.requests.some(r => r.url === '/auth/guest'), false);
  await Promise.all([page.trial().click(), page.trial().click()]);
  assert.equal(page.requests.filter(r => r.url === '/auth/guest').length, 0);
  assert.deepEqual(page.destinations, ['./mobile-auth.html?mode=register']);
  const events = page.requests.filter(r => r.url === '/track/event').map(r => JSON.parse(r.init.body));
  assert.ok(events.some(e => e.event_name === 'first_lesson_login_required' && e.properties.source === 'mobile_auth_first_lesson'));
});

test('trial is available from the registration tab without submitting a registration', async () => {
  const page = loadPage('?mode=register');
  assert.equal(page.nodes.get('register-form').classList.contains('active'), true);
  await page.trial().click();
  assert.equal(page.requests.some(r => r.url === '/auth/register'), false);
  assert.equal(page.destinations.length, 1);
});

test('trial without an account stays on registration and does not create a guest', async () => {
  const page = loadPage('', { failFirstGuest: true });
  await page.trial().click();
  assert.equal(page.requests.filter(r => r.url === '/auth/guest').length, 0);
  assert.deepEqual(page.destinations, ['./mobile-auth.html?mode=register']);
  assert.equal(page.trial().disabled, false);
});

test('a missing entry script reports the problem without breaking login', async () => {
  const page = loadPage('', { missingEntry: true });
  await page.trial().click();
  assert.equal(page.destinations.length, 0);
  assert.ok(page.nodes.get('toast').textContent.length > 0);
  assert.equal(page.nodes.get('login-form').classList.contains('active'), true);
});

for (const action of ['login', 'register', 'guest']) {
  for (const [next, expected] of [
    ['/pricing.html?intent=plans#plans', '/pricing.html?intent=plans#plans'],
    ['/game.html?chapter=2', '/game.html?chapter=2'],
    ['https://untrusted.example/', action === 'register' ? 'welcome.html?from=register' : `index-desktop.html?from=${action}`],
  ]) {
    test(`${action} preserves safe return paths and rejects external redirects: ${next}`, async () => {
      const page = loadPage(`?next=${encodeURIComponent(next)}`);
      if (action === 'guest') {
        await page.guestButton.click();
        page.flushRedirects();
        assert.equal(page.requests.some(r => r.url === '/auth/guest'), false);
        assert.equal(page.location.href, `https://test.linglish.local/mobile-auth.html?next=${encodeURIComponent(next)}`);
        assert.ok(page.nodes.get('toast').textContent.length > 0);
        return;
      }
      {
        page.nodes.get(`${action}-account`).value = 'fixture@example.invalid';
        page.nodes.get(`${action}-password`).value = 'fixture-password';
        if (action === 'register') {
          page.nodes.get('register-confirm-password').value = 'fixture-password';
          page.nodes.get('agree-terms').checked = true;
        }
        await page.nodes.get(`${action}-form`).fire('submit');
      }
      page.flushRedirects();
      assert.equal(page.location.href, expected);
      assert.equal(page.destinations.length, 0, 'ordinary authentication must not become a first-lesson redirect');
    });
  }
}
