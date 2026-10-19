const test = require('node:test');
const assert = require('node:assert/strict');

const { registerCoachingRoutes } = require('../routes/coaching');

function response() {
  return {
    headersSent: false,
    writableEnded: false,
    statusCode: 0,
    payload: null,
    writeHead(statusCode) { this.statusCode = statusCode; this.headersSent = true; },
    end(body) {
      this.payload = JSON.parse(body);
      this.writableEnded = true;
    },
  };
}

function member(type, status = 'active') {
  return {
    id: 8,
    membership_type: type,
    subscription_status: status,
    membership_expires_at: '2099-01-01T00:00:00.000Z',
  };
}

test('free viewers cannot request coaching explain or translate', async () => {
  const res = response();
  const handled = await registerCoachingRoutes('/api/coaching/sentence', { method: 'POST' }, res, null, {
    authenticate: async () => ({ id: 1, membership_type: 'free', subscription_status: 'none' }),
    parseBody: async () => ({ action: 'explain', text: 'Hello.' }),
    model: async () => { throw new Error('should not call the model'); },
  });
  assert.equal(handled, true);
  assert.equal(res.statusCode, 402);
  assert.equal(res.payload.code, 'COACHING_MEMBERSHIP_REQUIRED');
});

test('premium members receive an explanation for the current sentence', async () => {
  const res = response();
  await registerCoachingRoutes('/api/coaching/sentence', { method: 'POST' }, res, null, {
    authenticate: async () => member('svip'),
    parseBody: async () => ({ action: 'explain', text: 'Could you say that again?', word: 'again' }),
    model: async (input) => `先抓住 ${input.word}，再整句重读。`,
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.explanation, '先抓住 again，再整句重读。');
  assert.equal(res.payload.source, 'ai');
});

test('members can translate a sentence through the coaching route', async () => {
  const res = response();
  await registerCoachingRoutes('/api/coaching/sentence', { method: 'POST' }, res, null, {
    authenticate: async () => member('vip'),
    parseBody: async () => ({ action: 'translate', text: 'I missed the bus.' }),
    translate: async () => ({ translation: '我错过了公交车。', source: 'test' }),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.translation, '我错过了公交车。');
  assert.equal(res.payload.source, 'test');
});

test('coaching route ignores unrelated paths and rejects unknown actions', async () => {
  const skipped = await registerCoachingRoutes('/dictionary/bus', { method: 'GET' }, response(), null, {});
  assert.equal(skipped, false);
  const res = response();
  await registerCoachingRoutes('/api/coaching/sentence', { method: 'POST' }, res, null, {
    authenticate: async () => member('vip'),
    parseBody: async () => ({ action: 'sing', text: 'Hello.' }),
  });
  assert.equal(res.statusCode, 400);
});
