const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '../../frontend/sw.js'), 'utf8');

function serviceWorker() {
  const listeners = new Map();
  const entries = new Map();
  const calls = { network: 0, matched: 0, deleted: [] };
  let account = 'author';
  let cacheControl = 'public, max-age=3600';
  const caches = {
    async keys() { return [...entries.keys()]; },
    async delete(name) { calls.deleted.push(name); return entries.delete(name); },
    async match(request) {
      calls.matched += 1;
      for (const cache of entries.values()) {
        if (cache.has(request.url)) return cache.get(request.url).clone();
      }
      return undefined;
    },
    async open(name) {
      if (!entries.has(name)) entries.set(name, new Map());
      const cache = entries.get(name);
      return {
        async addAll() {},
        async match(request) { calls.matched += 1; return cache.get(request.url)?.clone(); },
        async put(request, response) { cache.set(request.url, response.clone()); },
      };
    },
  };
  vm.runInNewContext(source, {
    self: {
      addEventListener: (type, listener) => listeners.set(type, listener),
      skipWaiting: async () => {}, clients: { claim: async () => {} },
    },
    caches, URL, Promise, location: { origin: 'https://app.example.test' },
    async fetch() {
      calls.network += 1;
      return new Response(account === 'author' ? 'private image bytes' : 'Unauthorized', {
        status: account === 'author' ? 200 : 401,
        headers: { 'Cache-Control': cacheControl },
      });
    },
  });
  return {
    entries, calls,
    changeAccount() { account = 'another-user'; },
    setCacheControl(value) { cacheControl = value; },
    async request(pathname, headers = {}) {
      let response;
      listeners.get('fetch')({
        request: new Request(`https://app.example.test${pathname}`, { headers }),
        respondWith(value) { response = Promise.resolve(value); },
      });
      const result = await response;
      await new Promise(resolve => setImmediate(resolve));
      return result;
    },
    async activate() {
      let completion;
      listeners.get('activate')({ waitUntil(value) { completion = value; } });
      await completion;
    },
  };
}

test('a private note image is reauthorized after switching accounts without reading a cache', async () => {
  const worker = serviceWorker();
  assert.equal((await worker.request('/note-images/note-private.jpg')).status, 200);
  worker.changeAccount();
  assert.equal((await worker.request('/note-images/note-private.jpg')).status, 401);
  assert.equal(worker.calls.network, 2);
  assert.equal(worker.calls.matched, 0);
  assert.equal(worker.entries.size, 0);
});

test('an Authorization request bypasses cache even outside known protected paths', async () => {
  const worker = serviceWorker();
  const headers = { Authorization: 'Bearer account-token' };
  assert.equal((await worker.request('/custom-image.jpg', headers)).status, 200);
  worker.changeAccount();
  assert.equal((await worker.request('/custom-image.jpg', headers)).status, 401);
  assert.equal(worker.calls.network, 2);
  assert.equal(worker.calls.matched, 0);
  assert.equal(worker.entries.size, 0);
});

for (const control of ['private, max-age=3600', 'no-store', 'public, no-store']) {
  for (const [pathname, headers] of [
    ['/custom-image.jpg', {}],
    ['/custom-page.html', { Accept: 'text/html' }],
    ['/tts/generate?text=private', {}],
  ]) {
    test(`the worker never retains a ${control} response for ${pathname}`, async () => {
      const worker = serviceWorker();
      worker.setCacheControl(control);
      assert.equal((await worker.request(pathname, headers)).status, 200);
      assert.equal([...worker.entries.values()].reduce((count, entries) => count + entries.size, 0), 0);
      worker.changeAccount();
      assert.equal((await worker.request(pathname, headers)).status, 401);
      assert.equal(worker.calls.network, 2);
    });
  }
}

test('activation removes all previous runtime and core versions including the image-caching worker', async () => {
  const worker = serviceWorker();
  const previous = ['rt-v1.0.7-20261018001', 'core-v1.0.7-20261018001', 'rt-v1.0.6-20260822001'];
  for (const name of previous) worker.entries.set(name, new Map());
  worker.entries.set('other-app-cache', new Map());
  await worker.activate();
  assert.deepEqual(worker.calls.deleted.sort(), previous.sort());
  assert.equal(worker.entries.has('other-app-cache'), true);
});
