const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { PassThrough, Readable } = require('node:stream');

const ipLocationPath = require.resolve('../utils/ip-location');
require.cache[ipLocationPath] = {
  id: ipLocationPath,
  filename: ipLocationPath,
  loaded: true,
  exports: {
    getIPLocation: async () => null,
    getIPLocationsBatch: async () => new Map(),
  },
};

const { buildGuestLoginProperties, registerAuthRoutes } = require('../routes/auth');
const { parseOptionalJsonBody } = require('../utils/parsers');
const { analyticsSubjectKeySql, guestVisitorLinksSql } = require('../data-store/queries/analytics');
const authService = require('../services/auth');
const dataStore = require('../data-store');

function guestRequest(body = '') {
  const req = Readable.from(body ? [Buffer.from(body)] : []);
  req.method = 'POST';
  req.headers = { 'user-agent': 'test' };
  req.socket = { remoteAddress: '127.0.0.1' };
  return req;
}

function guestResponse() {
  return {
    headersSent: false,
    writableEnded: false,
    writeHead(statusCode) { this.statusCode = statusCode; },
    end(payload) {
      this.payload = JSON.parse(payload);
      this.writableEnded = true;
    },
  };
}

function openGuestRequest(chunks = []) {
  const req = new PassThrough();
  req.method = 'POST';
  req.headers = { 'user-agent': 'test' };
  req.socket = { remoteAddress: '127.0.0.1' };
  for (const chunk of chunks) req.write(chunk);
  return req;
}

async function within(promise, milliseconds) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${milliseconds}ms`)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server.listening) return resolve();
    server.close(resolve);
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  });
}

test('guest login properties keep a valid visitor id', () => {
  assert.deepEqual(buildGuestLoginProperties({
    ip: '127.0.0.1', userAgent: 'test', visitorId: 'llv_abcdefghijkl',
  }), {
    ip: '127.0.0.1', user_agent: 'test', visitor_id: 'llv_abcdefghijkl',
  });
});

test('guest login properties omit an invalid visitor id', () => {
  assert.deepEqual(buildGuestLoginProperties({
    ip: '127.0.0.1', userAgent: 'test', visitorId: 'invalid',
  }), {
    ip: '127.0.0.1', user_agent: 'test',
  });
});

test('analytics subject identity prefers visitor over user', () => {
  assert.equal(
    analyticsSubjectKeySql('e'),
    "COALESCE('v:' || NULLIF(e.properties->>'visitor_id', ''), 'u:' || e.user_id::text, 'e:' || e.id::text)",
  );
});

test('optional JSON parsing treats whitespace and malformed metadata as absent', async () => {
  assert.deepEqual(await parseOptionalJsonBody(guestRequest(' \n\t ')), {});
  assert.deepEqual(await parseOptionalJsonBody(guestRequest('{visitor_id:')), {});
});

test('optional JSON parsing drains oversized metadata without retaining it', async () => {
  const chunks = [
    Buffer.from('{"visitor_id":"llv_abcdefghijkl","padding":"'),
    Buffer.alloc(128, 'x'),
    Buffer.from('"}'),
  ];
  let consumed = 0;
  async function* source() {
    for (const chunk of chunks) {
      consumed += chunk.length;
      yield chunk;
    }
  }

  const parsed = await parseOptionalJsonBody(Readable.from(source()), { maxBytes: 64 });

  assert.deepEqual(parsed, {});
  assert.equal(consumed, chunks.reduce((total, chunk) => total + chunk.length, 0));
});

test('optional JSON parsing returns as soon as metadata exceeds the limit without waiting for the tail', async () => {
  const req = openGuestRequest([
    Buffer.from('{"visitor_id":"llv_abcdefghijkl","padding":"'),
    Buffer.alloc(128, 'x'),
  ]);

  try {
    const parsed = await within(
      parseOptionalJsonBody(req, { maxBytes: 64, timeoutMs: 1000 }),
      100,
    );

    assert.deepEqual(parsed, {});
    assert.ok(req.listenerCount('error') > 0, 'background disposal must absorb request errors');
  } finally {
    req.destroy();
  }
});

test('optional JSON parsing times out stalled metadata without failing the guest request', async () => {
  const req = openGuestRequest([Buffer.from('{"visitor_id":"llv_abc')]);

  try {
    const parsed = await within(
      parseOptionalJsonBody(req, { maxBytes: 8 * 1024, timeoutMs: 20 }),
      100,
    );

    assert.deepEqual(parsed, {});
  } finally {
    req.destroy();
  }
});

test('guest route refuses account creation even when the request body is still arriving', async () => {
  const originals = {
    register: authService.register,
    login: authService.login,
    recordLoginSession: dataStore.recordLoginSession,
    createEvent: dataStore.createEvent,
  };
  let registerCalls = 0;
  let resolveRouteDone;
  const routeDone = new Promise((resolve) => { resolveRouteDone = resolve; });
  authService.register = async () => {
    registerCalls += 1;
    return { id: 42 };
  };
  authService.login = async () => ({ user_id: 42, access_token: 'guest-token' });
  dataStore.recordLoginSession = async () => {};
  dataStore.createEvent = async () => {};

  const server = http.createServer(async (req, res) => {
    try {
      await registerAuthRoutes('/auth/guest', req, res, new URL(req.url, 'http://localhost'));
    } finally {
      resolveRouteDone();
    }
  });
  let clientRequest;

  try {
    await listen(server);
    const startedAt = Date.now();
    const responsePromise = new Promise((resolve, reject) => {
      clientRequest = http.request({
        hostname: '127.0.0.1',
        port: server.address().port,
        path: '/auth/guest',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(64 * 1024),
          Connection: 'keep-alive',
        },
      }, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.once('aborted', () => reject(new Error('response aborted')));
        response.once('error', reject);
        response.once('end', () => resolve({
          statusCode: response.statusCode,
          headers: response.headers,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
        }));
      });
      clientRequest.once('error', reject);
      clientRequest.write(Buffer.alloc(9 * 1024, 'x'));
    });

    const response = await within(responsePromise, 1500);
    assert.ok(Date.now() - startedAt < 1000);
    assert.equal(response.statusCode, 403);
    assert.equal(response.body.message, 'GUEST_LOGIN_DISABLED');
    assert.equal(registerCalls, 0);
  } finally {
    if (clientRequest) clientRequest.destroy();
    await within(routeDone, 1500).catch(() => {});
    await closeServer(server);
    authService.register = originals.register;
    authService.login = originals.login;
    dataStore.recordLoginSession = originals.recordLoginSession;
    dataStore.createEvent = originals.createEvent;
  }
});

test('guest login linkage gives a visitor identity to practice completion events', () => {
  assert.equal(
    analyticsSubjectKeySql('completion', 'guest_link'),
    "COALESCE('v:' || NULLIF(completion.properties->>'visitor_id', ''), 'v:' || guest_link.visitor_id, 'u:' || completion.user_id::text, 'e:' || completion.id::text)",
  );
  assert.match(guestVisitorLinksSql(), /event_name = 'guest_login'/);
  assert.match(guestVisitorLinksSql(), /NULLIF\(properties->>'visitor_id', ''\) IS NOT NULL/);
});

test('guest login accepts an empty body and omits invalid visitor ids without failing', async () => {
  const originals = {
    register: authService.register,
    login: authService.login,
    recordLoginSession: dataStore.recordLoginSession,
    createEvent: dataStore.createEvent,
  };
  const events = [];
  authService.register = async () => ({ id: 42 });
  authService.login = async () => ({ user_id: 42, access_token: 'guest-token' });
  dataStore.recordLoginSession = async () => {};
  dataStore.createEvent = async (event) => { events.push(event); };

  try {
    const emptyResponse = guestResponse();
    assert.equal(await registerAuthRoutes('/auth/guest', guestRequest(), emptyResponse), true);
    assert.equal(emptyResponse.statusCode, 403);
    assert.equal(emptyResponse.payload.message, 'GUEST_LOGIN_DISABLED');

    const validResponse = guestResponse();
    assert.equal(await registerAuthRoutes(
      '/auth/guest',
      guestRequest(JSON.stringify({ visitor_id: 'llv_abcdefghijkl' })),
      validResponse,
    ), true);
    assert.equal(validResponse.statusCode, 403);

    const invalidResponse = guestResponse();
    assert.equal(await registerAuthRoutes(
      '/auth/guest',
      guestRequest(JSON.stringify({ properties: { visitor_id: 'invalid' } })),
      invalidResponse,
    ), true);
    assert.equal(invalidResponse.statusCode, 403);
    assert.equal(events.length, 0);
  } finally {
    authService.register = originals.register;
    authService.login = originals.login;
    dataStore.recordLoginSession = originals.recordLoginSession;
    dataStore.createEvent = originals.createEvent;
  }
});

test('guest login treats malformed optional metadata as absent', async () => {
  const originals = {
    register: authService.register,
    login: authService.login,
    recordLoginSession: dataStore.recordLoginSession,
    createEvent: dataStore.createEvent,
  };
  const events = [];
  authService.register = async () => ({ id: 42 });
  authService.login = async () => ({ user_id: 42, access_token: 'guest-token' });
  dataStore.recordLoginSession = async () => {};
  dataStore.createEvent = async (event) => { events.push(event); };

  try {
    const response = guestResponse();
    assert.equal(await registerAuthRoutes('/auth/guest', guestRequest('{visitor_id:'), response), true);
    assert.equal(response.statusCode, 403);
    assert.equal(events.length, 0);
  } finally {
    authService.register = originals.register;
    authService.login = originals.login;
    dataStore.recordLoginSession = originals.recordLoginSession;
    dataStore.createEvent = originals.createEvent;
  }
});

test('guest login treats whitespace-only optional metadata as absent', async () => {
  const originals = {
    register: authService.register,
    login: authService.login,
    recordLoginSession: dataStore.recordLoginSession,
    createEvent: dataStore.createEvent,
  };
  const events = [];
  authService.register = async () => ({ id: 42 });
  authService.login = async () => ({ user_id: 42, access_token: 'guest-token' });
  dataStore.recordLoginSession = async () => {};
  dataStore.createEvent = async (event) => { events.push(event); };

  try {
    const response = guestResponse();
    assert.equal(await registerAuthRoutes('/auth/guest', guestRequest(' \n\t '), response), true);
    assert.equal(response.statusCode, 403);
    assert.equal(events.length, 0);
  } finally {
    authService.register = originals.register;
    authService.login = originals.login;
    dataStore.recordLoginSession = originals.recordLoginSession;
    dataStore.createEvent = originals.createEvent;
  }
});

test('guest login drains oversized optional metadata and omits its visitor id', async () => {
  const originals = {
    register: authService.register,
    login: authService.login,
    recordLoginSession: dataStore.recordLoginSession,
    createEvent: dataStore.createEvent,
  };
  const events = [];
  authService.register = async () => ({ id: 42 });
  authService.login = async () => ({ user_id: 42, access_token: 'guest-token' });
  dataStore.recordLoginSession = async () => {};
  dataStore.createEvent = async (event) => { events.push(event); };

  try {
    const body = JSON.stringify({ visitor_id: 'llv_abcdefghijkl', padding: 'x'.repeat(9 * 1024) });
    const response = guestResponse();
    assert.equal(await registerAuthRoutes('/auth/guest', guestRequest(body), response), true);
    assert.equal(response.statusCode, 403);
    assert.equal(events.length, 0);
  } finally {
    authService.register = originals.register;
    authService.login = originals.login;
    dataStore.recordLoginSession = originals.recordLoginSession;
    dataStore.createEvent = originals.createEvent;
  }
});
