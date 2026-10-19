const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const frontend = path.resolve(__dirname, '../../frontend');
const standalone = fs.readFileSync(path.join(frontend, 'class-note.html'), 'utf8');
const moduleSource = fs.readFileSync(path.join(frontend, 'js/workbench/class-note.js'), 'utf8');
const authSource = fs.readFileSync(path.join(frontend, 'js/auth-manager.js'), 'utf8');
function token(exp) { return `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ sub: 7, exp })).toString('base64url')}.fixture`; }
const accessToken = token(Math.floor(Date.now() / 1000) + 3600);
const renewedToken = token(Math.floor(Date.now() / 1000) + 7200);
function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
}
function element() {
  const listeners = new Map();
  let html = '';
  let image = null;
  return {
    hidden: false, value: '', textContent: '', files: [], disabled: false, style: {}, dataset: {},
    classList: { add() {}, remove() {} },
    addEventListener(type, handler) { listeners.set(type, handler); },
    async fire(type) { return listeners.get(type)?.({ preventDefault() {}, currentTarget: this }); },
    get innerHTML() { return html; },
    set innerHTML(value) { html = value; image = /<img\b/.test(value) ? { hidden: true, src: '' } : null; },
    querySelector(selector) { return selector.startsWith('img') ? image : null; },
    image: () => image,
  };
}
function harness(kind, options = {}) {
  const nodes = new Map();
  const getNode = id => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); };
  const requests = [];
  const created = [];
  const revoked = [];
  const pageListeners = new Map();
  let articleAttempts = 0;
  let imageResponse = options.imageResponse;
  class TestURL extends URL {
    static createObjectURL(blob) { const url = `blob:private-note-${created.length + 1}`; created.push({ url, blob }); return url; }
    static revokeObjectURL(url) { revoked.push(url); }
  }
  const sandbox = {
    URL: TestURL, URLSearchParams, Headers, Uint8Array, atob, Blob, Promise,
    navigator: { cookieEnabled: false },
    localStorage: storage({ authToken: accessToken, linglish_token: accessToken, linglish_refresh_token: 'refresh-fixture' }),
    sessionStorage: storage(),
    location: { origin: 'https://app.example.test', search: options.reopen ? '?id=7' : '', replace() {} },
    history: { replaceState() {} },
    console: { log() {}, warn() {}, error() {} },
    FormData: class { append() {} },
    addEventListener(type, handler) { pageListeners.set(type, handler); },
    document: {
      cookie: '', title: '', getElementById: getNode,
      querySelectorAll: selector => selector.includes('[data-line]') ? [{ value: 'Milk please' }] : [],
    },
    fetch: async (url, init = {}) => {
      const requestUrl = new URL(String(url), 'https://app.example.test');
      const auth = new Headers(init.headers).get('Authorization');
      requests.push({ pathname: requestUrl.pathname, url: String(url), auth, init });
      if (requestUrl.pathname === '/auth/refresh') return { ok: true, status: 200, json: async () => ({ access_token: renewedToken, refresh_token: 'rotated-fixture' }) };
      if (requestUrl.pathname === '/class-notes') return { ok: true, status: 201, json: async () => ({ note: { id: 7, word: 'milk' } }) };
      if (requestUrl.pathname === '/articles/7') {
        articleAttempts += 1;
        const authorized = Boolean(auth) && !(options.refresh && articleAttempts === 1);
        return {
          ok: authorized, status: authorized ? 200 : 401,
          json: async () => authorized ? { id: 7, content: JSON.stringify({ kind: 'class-note', word: 'milk', lines: ['Milk please'], image: '/note-images/private-card.png' }) } : { message: 'UNAUTHORIZED' },
        };
      }
      if (requestUrl.pathname === '/note-images/private-card.png') {
        if (imageResponse) return imageResponse;
        return { ok: Boolean(auth), status: auth ? 200 : 401, blob: async () => new Blob(['private image'], { type: 'image/png' }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    },
  };
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(authSource, context);
  if (kind === 'workbench') {
    vm.runInContext(moduleSource, context);
    sandbox.WorkbenchClassNote.activate(options.reopen ? { noteId: 7 } : {});
  } else {
    for (const match of standalone.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
      if (!/\bsrc=/.test(match[1]) && match[2].trim()) vm.runInContext(match[2], context);
    }
    if (!options.reopen) vm.runInContext('bindComposer();', context);
  }
  const prefix = kind === 'workbench' ? 'wb-cn-' : '';
  return {
    sandbox, nodes, requests, created, revoked,
    image: () => getNode(prefix + 'note').image(),
    async submit() {
      getNode(prefix + 'word').value = 'milk';
      getNode(prefix + 'photo').files = [{ name: 'card.png' }];
      await getNode(kind === 'workbench' ? 'wb-cn-form' : 'note-form').fire('submit');
    },
    async flush() { for (let i = 0; i < 5; i += 1) await new Promise(resolve => setImmediate(resolve)); },
    hide() { if (kind === 'workbench') sandbox.WorkbenchClassNote.deactivate(); else pageListeners.get('pagehide')?.(); },
    resume() { if (kind === 'workbench') sandbox.WorkbenchClassNote.activate(); else pageListeners.get('pageshow')?.({ persisted: true }); },
    edit() { if (kind === 'workbench') return getNode('wb-cn-edit-btn').fire('click'); return vm.runInContext('showComposer(lastNote);', context); },
  };
}

for (const kind of ['standalone', 'workbench']) {
  for (const reopen of [false, true]) {
    test(`${kind} ${reopen ? 'owner reopening' : 'first creation'} reads the private article and image with a localStorage credential and no cookie`, async () => {
      const h = harness(kind, { reopen, refresh: true });
      if (!reopen) await h.submit();
      await h.flush();
      const reads = h.requests.filter(r => r.pathname === '/articles/7');
      assert.ok(reads.length >= 1, 'the saved article must be read back');
      assert.equal(reads[0].auth, `Bearer ${accessToken}`);
      assert.equal(h.requests.filter(r => r.pathname === '/auth/refresh').length, 1, 'an article 401 must trigger shared session renewal');
      assert.equal(reads.at(-1).auth, `Bearer ${renewedToken}`);
      const image = h.requests.find(r => r.pathname === '/note-images/private-card.png');
      assert.ok(image, 'the private image must be fetched with credentials');
      assert.equal(image.auth, `Bearer ${renewedToken}`);
      assert.equal(h.created.length, 1);
      assert.equal(h.image().src, h.created[0].url, 'only the authenticated blob URL is attached to the image');
      assert.equal(h.sandbox.document.cookie, '', 'the image flow must not depend on a media cookie');
      h.hide();
      assert.deepEqual(h.revoked, [h.created[0].url], 'leaving or unloading releases the private image URL');
    });
  }
  test(`${kind} editing a note releases its image and fences late private-image responses`, async () => {
    let finishImage;
    const imageResponse = new Promise(resolve => { finishImage = resolve; });
    const h = harness(kind, { reopen: true, imageResponse });
    await h.flush();
    assert.ok(h.requests.some(r => r.pathname === '/note-images/private-card.png'), 'the image request must be pending before editing');
    await h.edit();
    finishImage({ ok: true, status: 200, blob: async () => new Blob(['late private image']) });
    await h.flush();
    assert.equal(h.created.length, 0, 'an abandoned view must not retain a new private blob URL');
  });
}

test('the standalone note page loads AuthManager before its private article requests', () => {
  const manager = standalone.indexOf('src="./js/auth-manager.js');
  const inline = standalone.indexOf('const params = new URLSearchParams');
  assert.ok(manager >= 0 && manager < inline);
});

for (const kind of ['standalone', 'workbench']) {
  test(`${kind} returning to an existing view replaces a revoked private image URL`, async () => {
    const h = harness(kind, { reopen: true });
    await h.flush();
    assert.equal(h.created.length, 1);
    h.hide();
    h.resume();
    await h.flush();
    assert.equal(h.created.length, 2, 'returning to the view must acquire a new private blob URL');
    assert.equal(h.image().src, h.created[1].url);
    assert.deepEqual(h.revoked, [h.created[0].url]);
  });
}
