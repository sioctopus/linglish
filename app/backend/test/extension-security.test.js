const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const extension = path.resolve(__dirname, '../../extension');
const read = name => fs.readFileSync(path.join(extension, name), 'utf8');

function background() {
  const listeners = {};
  const store = { authToken: 'test-account-token', userEmail: 'learner@example.test' };
  const chrome = {
    runtime: {
      id: 'a'.repeat(32),
      onInstalled: { addListener() {} }, onStartup: { addListener() {} },
      onMessage: { addListener(fn) { listeners.internal = fn; } },
      onMessageExternal: { addListener(fn) { listeners.external = fn; } },
    },
    contextMenus: { onClicked: { addListener() {} } },
    storage: { local: {
      async get() { return { ...store }; },
      async set(values) { Object.assign(store, values); },
      async remove(keys) { keys.forEach(key => delete store[key]); },
      async setAccessLevel() {},
    } },
    tabs: { async create() {} },
  };
  const context = vm.createContext({ chrome, URL, console, importScripts() {},
    LINGLISH_CONFIG: { ORIGIN: 'http://localhost:4000', PATHS: {} },
  });
  vm.runInContext(read('background.js'), context);
  const send = (kind, message, sender) => new Promise(resolve => listeners[kind](message, sender, resolve));
  return { send, store };
}

test('YouTube content scripts cannot read or replace the extension account token', async () => {
  const bg = background();
  const sender = { id: 'a'.repeat(32), url: 'https://www.youtube.com/watch?v=abcdefghijk', tab: { id: 1 } };
  assert.equal((await bg.send('internal', { type: 'GET_SESSION' }, sender)).ok, false);
  assert.equal((await bg.send('internal', { type: 'SET_SESSION', token: 'replacement' }, sender)).ok, false);
  assert.equal(bg.store.authToken, 'test-account-token');
});

test('extension popup receives login status without a raw account token', async () => {
  const bg = background();
  const value = await bg.send('internal', { type: 'GET_SESSION' }, { id: 'a'.repeat(32), url: `chrome-extension://${'a'.repeat(32)}/popup.html` });
  assert.equal(value.loggedIn, true);
  assert.equal(value.token, undefined);
});

test('external messages and learn links are confined to the configured site', async () => {
  const bg = background();
  assert.equal((await bg.send('external', { type: 'SET_SESSION', token: 'replacement' }, { url: 'http://attacker.example/' })).ok, false);
  assert.equal(bg.store.authToken, 'test-account-token');
  const popup = { id: 'a'.repeat(32), url: `chrome-extension://${'a'.repeat(32)}/popup.html` };
  assert.equal((await bg.send('internal', { type: 'OPEN_LEARN', url: 'https://attacker.example/' }, popup)).ok, false);
});

test('site bridge clears the extension session after a website logout', () => {
  const messages = [];
  const storage = { getItem() { return null; } };
  vm.runInNewContext(read('content/site-bridge.js'), {
    chrome: { runtime: { sendMessage(message, callback) { messages.push(message); callback({ ok: true }); } } },
    localStorage: storage, sessionStorage: storage,
    document: { documentElement: { dataset: {} } },
    window: { addEventListener() {} }, setInterval() {},
  });
  assert.equal(messages.at(-1)?.type, 'CLEAR_SESSION');
});

test('extension bridge inline script parses and never sends tokens to a query-selected extension', () => {
  const source = fs.readFileSync(path.join(extension, '../frontend/extension-bridge.html'), 'utf8');
  for (const match of source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    new vm.Script(match[1]);
  }
  assert.doesNotMatch(source, /searchParams.*get\(['"]ext['"]\)|sendMessage\(extId/);
});
