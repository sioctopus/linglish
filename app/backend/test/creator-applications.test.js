const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { Readable } = require('node:stream');

function loadModule(relative, overrides) {
  const filename = path.resolve(__dirname, relative);
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, Buffer, URL, console, process: { env: {} },
    require: name => Object.hasOwn(overrides, name) ? overrides[name] : localRequire(name),
  }, { filename });
  return module.exports;
}

function harness({ user = { id: '7', email: 'member@example.com' }, store = {} } = {}) {
  const auth = loadModule('../middleware/auth.js', {
    '../services/auth': { requireUser: async token => {
      if (token !== 'session' || !user) throw new Error('UNAUTHORIZED');
      return user;
    } },
  });
  const { registerCreatorRoutes } = loadModule('../routes/creators.js', {
    '../middleware/auth': auth,
    '../data-store': store,
  });
  return async (route, { method = 'GET', body, token = 'session', raw, headers = {} } = {}) => {
    const req = Readable.from([Buffer.from(raw ?? (body ? JSON.stringify(body) : ''))]);
    req.method = method;
    req.headers = { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers };
    const res = {
      headersSent: false, writableEnded: false,
      setHeader() {},
      writeHead(status, headers) { this.status = status; this.headers = headers; },
      end(value) { this.body = JSON.parse(value); this.writableEnded = true; },
    };
    const url = new URL(route, 'http://localhost');
    const handled = await registerCreatorRoutes(url.pathname, req, res, url);
    return { status: res.status, body: res.body, handled };
  };
}

const valid = { display_name: 'A learner', bio: 'I make short English lessons.', topic: 'Daily English', sample_url: 'https://example.com/lesson', rights_confirmed: true };

test('creator applications require a registered account and reject guest accounts', async () => {
  const unauthenticated = harness({ user: null });
  assert.equal((await unauthenticated('/api/creator/application')).status, 401);
  const guest = harness({ user: { id: '8', email: 'guest_a123@temp.linglish.local', is_admin: true } });
  for (const method of ['GET', 'POST']) {
    assert.equal((await guest('/api/creator/application', { method, body: valid })).status, 403);
  }
});

test('own application lookup uses the authenticated identity and returns no private account fields', async () => {
  const request = harness({ store: { getCreatorApplication: async id => {
    assert.equal(id, '7');
    return { id: '2', user_id: '7', display_name: 'A learner', status: 'pending', revision: 1, email: 'private@example.com', password_hash: 'secret' };
  } } });
  const result = await request('/api/creator/application?user_id=8');
  assert.equal(result.status, 200);
  assert.equal(result.body.application.user_id, '7');
  assert.equal(result.body.application.email, undefined);
  assert.equal(result.body.application.password_hash, undefined);
  const missing = harness({ store: { getCreatorApplication: async () => null } });
  assert.equal((await missing('/api/creator/application')).body.application, null);
});

test('cookie credentials cannot authorize creator writes from a simple cross-origin request', async () => {
  const request = harness({ user: { id: '9', is_admin: true }, store: {
    getCreatorApplication: async () => null,
    submitCreatorApplication: async () => ({ application: { status: 'pending' }, created: true }),
    reviewCreatorApplication: async () => ({ status: 'approved' }),
  } });
  const options = { token: null, headers: { cookie: 'linglish_token=session', origin: 'https://untrusted.example.com', 'content-type': 'text/plain' } };
  assert.equal((await request('/api/creator/application', options)).status, 200);
  assert.equal((await request('/api/creator/application', { ...options, method: 'POST', body: valid })).status, 401);
  assert.equal((await request('/admin/creator-applications/2/review', { ...options, method: 'POST', body: { decision: 'approved', expected_revision: 1 } })).status, 401);
  for (const authorization of ['session', 'Basic session', 'Bearer', 'Bearer session extra', 'Bearer   ']) {
    const malformed = { ...options, headers: { ...options.headers, authorization }, method: 'POST' };
    assert.equal((await request('/api/creator/application', { ...malformed, body: valid })).status, 401, authorization);
    assert.equal((await request('/admin/creator-applications/2/review', { ...malformed, body: { decision: 'approved', expected_revision: 1 } })).status, 401, authorization);
  }
});

test('submission cannot set ownership, approval, reviewer, admin or membership privileges', async () => {
  const request = harness({ store: { submitCreatorApplication() { assert.fail('invalid requests must not reach storage'); } } });
  for (const injection of [{ user_id: 8 }, { status: 'approved' }, { is_admin: true }, { membership_type: 'admin' }, { reviewed_by: 7 }, { revision: 100 }]) {
    const result = await request('/api/creator/application', { method: 'POST', body: { ...valid, ...injection } });
    assert.equal(result.status, 400, JSON.stringify(injection));
  }
});

test('submission validates required text, exact rights consent, and public HTTP sample links without fetching them', async () => {
  const request = harness({ store: { submitCreatorApplication() { assert.fail('invalid requests must not reach storage'); } } });
  for (const body of [
    { ...valid, display_name: '' }, { ...valid, display_name: 'a'.repeat(81) },
    { ...valid, bio: 'a'.repeat(1201) }, { ...valid, topic: {} },
    { ...valid, rights_confirmed: 'true' }, { ...valid, rights_confirmed: false },
    ...['javascript:alert(1)', 'file:///tmp/test', 'http://localhost/', 'http://127.1/', 'http://10.0.0.1/', 'http://[::1]/', 'https://user:pass@example.com/', 'https://printer.local./', 'https://printer/', `https://example.com/${'字'.repeat(300)}`].map(sample_url => ({ ...valid, sample_url })),
  ]) assert.equal((await request('/api/creator/application', { method: 'POST', body })).status, 400);
  assert.equal((await request('/api/creator/application', { method: 'POST', raw: '{' })).status, 400);
  assert.equal((await request('/api/creator/application', { method: 'POST', raw: ' '.repeat(17 * 1024) })).status, 413);
});

test('valid submission trims text and uses only server-authenticated ownership', async () => {
  const request = harness({ store: { submitCreatorApplication: async (id, payload) => {
    assert.equal(id, '7');
    assert.equal(payload.display_name, 'A learner');
    assert.equal(payload.sample_url, null);
    return { application: { id: '3', user_id: id, ...payload, status: 'pending', revision: 1 }, created: true };
  } } });
  const result = await request('/api/creator/application', { method: 'POST', body: { ...valid, display_name: ' A learner ', sample_url: '' } });
  assert.equal(result.status, 201);
  assert.equal(result.body.application.status, 'pending');
});

test('admin inbox and review rely on the database admin flag and reject guest and self-assigned admin identities', async () => {
  for (const user of [{ id: '7', role: 'admin', membership_type: 'admin', is_admin: false }, { id: '8', email: 'guest_a123@temp.linglish.local', is_admin: true }]) {
    const request = harness({ user });
    assert.equal((await request('/admin/creator-applications')).status, 403);
    assert.equal((await request('/admin/creator-applications/2/review', { method: 'POST', body: { decision: 'approved', expected_revision: 1 } })).status, 403);
  }
});

test('admin review requires a revision and uses the authenticated reviewer identity', async () => {
  const request = harness({ user: { id: '9', is_admin: true }, store: { reviewCreatorApplication: async (id, options) => {
    assert.equal(id, '2');
    assert.equal(options.reviewer_id, '9');
    assert.equal(options.expected_revision, 1);
    return { id, status: options.decision, revision: 2 };
  } } });
  for (const body of [{ decision: 'approved' }, { decision: 'pending', expected_revision: 1 }, { decision: 'approved', expected_revision: 1, reviewer_id: 7 }]) {
    assert.equal((await request('/admin/creator-applications/2/review', { method: 'POST', body })).status, 400);
  }
  const result = await request('/admin/creator-applications/2/review', { method: 'POST', body: { decision: 'approved', expected_revision: 1 } });
  assert.equal(result.status, 200);
  assert.equal(result.body.application.status, 'approved');
});

test('datastore failure closes creator routes and does not expose SQL internals', async () => {
  const request = harness({ store: { getCreatorApplication: async () => { throw new Error('SELECT private_column FROM missing_table'); } } });
  const result = await request('/api/creator/application');
  assert.equal(result.status, 500);
  assert.equal(result.body.message, 'CREATOR_APPLICATION_FAILED');
});
