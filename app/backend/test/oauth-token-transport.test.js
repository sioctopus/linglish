const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const ACCOUNT_SECRET = 'account-secret-0123456789abcdef0123456789abcdef';
const SCOPED_SECRET = 'scoped-secret-0123456789abcdef0123456789abcdef';

process.env.AUTH_TOKEN_SECRET = ACCOUNT_SECRET;
process.env.SCOPED_TOKEN_SECRET = SCOPED_SECRET;

const dataStore = require('../data-store');
const authService = require('../services/auth');
const oauthService = require('../services/oauth');
const { registerOAuthRoutes } = require('../routes/oauth');

function scopedTokens() {
  return require('../services/scoped-browser-token');
}

function decodePayload(token) {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
}

function signFixture(payload, secret = SCOPED_SECRET) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const data = `${header}.${body}`;
  const signature = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${signature}`;
}

function makeResponse() {
  return {
    statusCode: null,
    headers: {},
    headersSent: false,
    writableEnded: false,
    body: null,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    getHeader(name) { return this.headers[name.toLowerCase()]; },
    writeHead(status, headers = {}) {
      this.statusCode = status;
      for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
      this.headersSent = true;
    },
    end(payload) {
      this.body = payload && String(payload).startsWith('{') ? JSON.parse(payload) : payload || null;
      this.writableEnded = true;
    },
  };
}

function makeRequest({ method = 'GET', url = '/', cookie = '', headers = {} } = {}) {
  return {
    method,
    url,
    headers: {
      ...(cookie ? { cookie } : {}),
      'user-agent': 'task-2b-test',
      ...headers,
    },
    socket: { remoteAddress: '127.0.0.1' },
  };
}

function setCookieValues(res) {
  const value = res.getHeader('set-cookie');
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function cookiePair(res, name) {
  const value = setCookieValues(res).find(item => String(item).startsWith(`${name}=`));
  return value ? String(value).split(';')[0] : null;
}

const originals = {
  isGoogleEnabled: oauthService.isGoogleEnabled,
  isGoogleConfigured: oauthService.isGoogleConfigured,
  createOAuthState: oauthService.createOAuthState,
  buildGoogleAuthUrl: oauthService.buildGoogleAuthUrl,
  verifyOAuthState: oauthService.verifyOAuthState,
  exchangeGoogleCode: oauthService.exchangeGoogleCode,
  getGoogleUserProfile: oauthService.getGoogleUserProfile,
  handleOAuthLogin: oauthService.handleOAuthLogin,
  recordLoginSession: dataStore.recordLoginSession,
  createEvent: dataStore.createEvent,
  findUserById: dataStore.findUserById,
  query: dataStore.query,
  registerOAuthBootstrapJti: oauthService.registerOAuthBootstrapJti,
  consumeOAuthBootstrapJti: oauthService.consumeOAuthBootstrapJti,
};

test.afterEach(() => {
  Object.assign(oauthService, {
    isGoogleEnabled: originals.isGoogleEnabled,
    isGoogleConfigured: originals.isGoogleConfigured,
    createOAuthState: originals.createOAuthState,
    buildGoogleAuthUrl: originals.buildGoogleAuthUrl,
    verifyOAuthState: originals.verifyOAuthState,
    exchangeGoogleCode: originals.exchangeGoogleCode,
    getGoogleUserProfile: originals.getGoogleUserProfile,
    handleOAuthLogin: originals.handleOAuthLogin,
    registerOAuthBootstrapJti: originals.registerOAuthBootstrapJti,
    consumeOAuthBootstrapJti: originals.consumeOAuthBootstrapJti,
  });
  dataStore.recordLoginSession = originals.recordLoginSession;
  dataStore.createEvent = originals.createEvent;
  dataStore.findUserById = originals.findUserById;
  dataStore.query = originals.query;
  process.env.SCOPED_TOKEN_SECRET = SCOPED_SECRET;
  delete process.env.OAUTH_ALLOW_LEGACY_FRAGMENT;
});

test.after(async () => {
  try { await dataStore.pool.end(); } catch (_) { /* already closed */ }
});

test('OAuth bootstrap credentials have a maximum accepted age of 60 seconds', () => {
  const {
    createOAuthBootstrapToken,
    verifyOAuthBootstrapToken,
  } = scopedTokens();
  const token = createOAuthBootstrapToken(
    { id: 7 },
    { now: () => 1_000, secret: SCOPED_SECRET, isNew: true, redirectUrl: '/welcome.html' },
  );
  const payload = decodePayload(token);

  assert.deepEqual(Object.keys(payload).sort(), [
    'aud', 'exp', 'iat', 'is_new', 'jti', 'nbf', 'purpose', 'redirect_url', 'sub', 'typ', 'ver',
  ]);
  assert.equal(payload.typ, 'scoped-browser');
  assert.equal(payload.aud, 'oauth-session');
  assert.equal(payload.purpose, 'oauth_bootstrap');
  assert.equal(payload.sub, '7');
  assert.equal(payload.iat, 1_000);
  assert.equal(payload.nbf, 1_000);
  assert.equal(payload.exp, 1_060);
  assert.equal(payload.ver, 1);
  assert.match(payload.jti, /^[a-f0-9]{32}$/);

  assert.equal(
    verifyOAuthBootstrapToken(token, { now: () => 1_060, secret: SCOPED_SECRET }).sub,
    '7',
  );
  assert.throws(
    () => verifyOAuthBootstrapToken(token, { now: () => 1_061, secret: SCOPED_SECRET }),
    /TOKEN_EXPIRED/,
  );
});

test('OAuth bootstrap strips authentication-reserved redirect fragments before signing', () => {
  const { createOAuthBootstrapToken, verifyOAuthBootstrapToken } = scopedTokens();
  const token = createOAuthBootstrapToken(
    { id: 7 },
    {
      now: () => 1_000,
      secret: SCOPED_SECRET,
      isNew: false,
      redirectUrl: '/today.html?next=%2Flesson#section=review&token=attacker&access_token=also-bad',
    },
  );
  const payload = verifyOAuthBootstrapToken(token, { now: () => 1_001, secret: SCOPED_SECRET });
  assert.equal(payload.redirect_url, '/today.html?next=%2Flesson#section=review');
});

test('OAuth bootstrap verification rejects tampering, wrong purpose or audience, and future claims', () => {
  const { verifyOAuthBootstrapToken } = scopedTokens();
  const base = {
    typ: 'scoped-browser',
    aud: 'oauth-session',
    purpose: 'oauth_bootstrap',
    sub: '7',
    iat: 1_000,
    nbf: 1_000,
    exp: 1_060,
    ver: 1,
    jti: '0123456789abcdef0123456789abcdef',
    is_new: false,
    redirect_url: '/index-desktop.html',
  };
  const options = { now: () => 1_010, secret: SCOPED_SECRET };
  const valid = signFixture(base);
  const tampered = `${valid.slice(0, -1)}${valid.endsWith('a') ? 'b' : 'a'}`;

  assert.throws(() => verifyOAuthBootstrapToken(tampered, options), /INVALID_TOKEN/);
  for (const payload of [
    { ...base, purpose: 'ws_ticket' },
    { ...base, aud: 'group-chat' },
    { ...base, typ: 'JWT' },
    { ...base, ver: 2 },
    { ...base, iat: 1_041, nbf: 1_041, exp: 1_101 },
  ]) {
    assert.throws(() => verifyOAuthBootstrapToken(signFixture(payload), options), /INVALID_TOKEN/);
  }
});

test('scoped credentials require an explicit secret of at least 32 bytes in development too', () => {
  const { createOAuthBootstrapToken } = scopedTokens();
  const previous = process.env.SCOPED_TOKEN_SECRET;
  delete process.env.SCOPED_TOKEN_SECRET;

  try {
    assert.throws(
      () => createOAuthBootstrapToken({ id: 7 }, { now: () => 1_000 }),
      /SCOPED_TOKEN_SECRET_REQUIRED/,
    );
    assert.throws(
      () => createOAuthBootstrapToken({ id: 7 }, { now: () => 1_000, secret: 'too-short' }),
      /SCOPED_TOKEN_SECRET_INVALID/,
    );
  } finally {
    process.env.SCOPED_TOKEN_SECRET = previous;
  }
});

test('OAuth bootstrap cookies use separate production and local names with exact attributes', () => {
  const { serializeOAuthBootstrapCookie, serializeOAuthTransactionCookie } = scopedTokens();
  const production = serializeOAuthBootstrapCookie('abc.def.ghi', { production: true });
  assert.equal(
    production,
    '__Host-linglish_oauth_bootstrap=abc.def.ghi; Max-Age=60; Path=/; HttpOnly; Secure; SameSite=Lax',
  );
  assert.doesNotMatch(production, /Domain=/i);

  const local = serializeOAuthBootstrapCookie('abc.def.ghi', { production: false });
  assert.equal(
    local,
    'linglish_oauth_bootstrap_dev=abc.def.ghi; Max-Age=60; Path=/; HttpOnly; SameSite=Lax',
  );
  assert.doesNotMatch(local, /(?:^|; )Secure(?:;|$)/);

  assert.equal(
    serializeOAuthTransactionCookie('nonce', { production: true }),
    '__Host-linglish_oauth_tx=nonce; Max-Age=600; Path=/; HttpOnly; Secure; SameSite=Lax',
  );
  assert.equal(
    serializeOAuthTransactionCookie('nonce', { production: false }),
    'linglish_oauth_tx_dev=nonce; Max-Age=600; Path=/; HttpOnly; SameSite=Lax',
  );
});

test('ordinary account authentication rejects an OAuth scoped token even with the account secret', async () => {
  const { createOAuthBootstrapToken } = scopedTokens();
  const token = createOAuthBootstrapToken(
    { id: 7 },
    {
      now: () => Math.floor(Date.now() / 1_000),
      secret: ACCOUNT_SECRET,
      isNew: false,
      redirectUrl: '/index-desktop.html',
    },
  );
  await assert.rejects(() => authService.requireUser(token), /INVALID_TOKEN/);
});

test('only an explicit cookie_v1 request records the new flow and callback redirects without an account token', async () => {
  let capturedExtra = null;
  let verifiedBinding = null;
  let registeredBootstrap = null;
  oauthService.isGoogleEnabled = () => true;
  oauthService.isGoogleConfigured = () => true;
  oauthService.createOAuthState = async (_provider, _redirect, extra) => {
    capturedExtra = extra;
    return 'state-value';
  };
  oauthService.buildGoogleAuthUrl = () => 'https://accounts.example.test/oauth';

  const startRes = makeResponse();
  assert.equal(await registerOAuthRoutes(
    '/auth/oauth/google',
    makeRequest({ url: '/auth/oauth/google?redirect=%2Ftoday.html&flow=cookie_v1' }),
    startRes,
    new URL('http://localhost/auth/oauth/google?redirect=%2Ftoday.html&flow=cookie_v1'),
  ), true);
  assert.equal(capturedExtra.flow, 'cookie_v1');
  assert.match(capturedExtra.oauth_tx_hash, /^[a-f0-9]{64}$/);
  const transactionCookie = cookiePair(startRes, 'linglish_oauth_tx_dev');
  assert.match(transactionCookie, /^linglish_oauth_tx_dev=[A-Za-z0-9_-]{43}$/);

  oauthService.verifyOAuthState = async (_state, _provider, options) => {
    verifiedBinding = options?.transactionHash;
    if (verifiedBinding !== capturedExtra.oauth_tx_hash) throw new Error('INVALID_OR_EXPIRED_STATE');
    return {
      redirect_url: '/today.html?from=oauth#token=reserved',
      extra_data: { mobile: false, flow: 'cookie_v1', oauth_tx_hash: capturedExtra.oauth_tx_hash },
    };
  };
  oauthService.registerOAuthBootstrapJti = async (jti, exp) => {
    registeredBootstrap = { jti, exp };
  };
  oauthService.exchangeGoogleCode = async () => ({ accessToken: 'google-access' });
  oauthService.getGoogleUserProfile = async () => ({ email: 'oauth@example.test', name: 'OAuth User' });
  oauthService.handleOAuthLogin = async () => ({
    user: { id: 7, email: 'oauth@example.test', status: 'active' },
    isNewUser: false,
  });
  dataStore.recordLoginSession = async () => {};
  dataStore.createEvent = async () => {};

  const callbackRes = makeResponse();
  assert.equal(await registerOAuthRoutes(
    '/auth/oauth/google/callback',
    makeRequest({
      url: '/auth/oauth/google/callback?code=ok&state=state-value',
      cookie: transactionCookie,
    }),
    callbackRes,
    new URL('http://localhost/auth/oauth/google/callback?code=ok&state=state-value'),
  ), true);
  assert.equal(callbackRes.statusCode, 302);
  assert.doesNotMatch(callbackRes.getHeader('location'), /[#?&]token=/i);
  assert.match(callbackRes.getHeader('location'), /oauth=cookie_v1/);
  assert.ok(cookiePair(callbackRes, 'linglish_oauth_bootstrap_dev'));
  assert.ok(setCookieValues(callbackRes).some(value => /^linglish_oauth_tx_dev=; Max-Age=0;/.test(value)));
  assert.match(verifiedBinding, /^[a-f0-9]{64}$/);
  assert.match(registeredBootstrap.jti, /^[a-f0-9]{32}$/);
  assert.ok(Number.isInteger(registeredBootstrap.exp));
  assert.equal(callbackRes.getHeader('cache-control'), 'no-store');
  assert.equal(callbackRes.getHeader('referrer-policy'), 'no-referrer');
});

test('OAuth state is bound to browser A and browser B cannot consume it', async () => {
  let capturedExtra = null;
  oauthService.isGoogleEnabled = () => true;
  oauthService.isGoogleConfigured = () => true;
  oauthService.createOAuthState = async (_provider, _redirect, extra) => {
    capturedExtra = extra;
    return 'browser-bound-state';
  };
  oauthService.buildGoogleAuthUrl = () => 'https://accounts.example.test/oauth';

  const startRes = makeResponse();
  await registerOAuthRoutes(
    '/auth/oauth/google',
    makeRequest({ url: '/auth/oauth/google?flow=cookie_v1' }),
    startRes,
    new URL('http://localhost/auth/oauth/google?flow=cookie_v1'),
  );
  const browserACookie = cookiePair(startRes, 'linglish_oauth_tx_dev');
  let consumed = false;
  oauthService.verifyOAuthState = async (_state, _provider, options) => {
    if (options?.transactionHash !== capturedExtra.oauth_tx_hash) {
      throw new Error('INVALID_OR_EXPIRED_STATE');
    }
    if (consumed) throw new Error('INVALID_OR_EXPIRED_STATE');
    consumed = true;
    return {
      redirect_url: '/today.html',
      extra_data: { mobile: false, flow: 'cookie_v1', oauth_tx_hash: capturedExtra.oauth_tx_hash },
    };
  };
  oauthService.exchangeGoogleCode = async () => ({ accessToken: 'google-access' });
  oauthService.getGoogleUserProfile = async () => ({ email: 'oauth@example.test', name: 'OAuth User' });
  oauthService.handleOAuthLogin = async () => ({
    user: { id: 7, email: 'oauth@example.test', status: 'active' },
    isNewUser: false,
  });
  oauthService.registerOAuthBootstrapJti = async () => {};
  dataStore.recordLoginSession = async () => {};
  dataStore.createEvent = async () => {};

  const browserB = makeResponse();
  await registerOAuthRoutes(
    '/auth/oauth/google/callback',
    makeRequest({ url: '/auth/oauth/google/callback?code=ok&state=browser-bound-state' }),
    browserB,
    new URL('http://localhost/auth/oauth/google/callback?code=ok&state=browser-bound-state'),
  );
  assert.match(browserB.getHeader('location'), /error=oauth_expired/);
  assert.equal(consumed, false);
  assert.ok(setCookieValues(browserB).some(value => /^linglish_oauth_tx_dev=; Max-Age=0;/.test(value)));

  const browserA = makeResponse();
  await registerOAuthRoutes(
    '/auth/oauth/google/callback',
    makeRequest({
      url: '/auth/oauth/google/callback?code=ok&state=browser-bound-state',
      cookie: browserACookie,
    }),
    browserA,
    new URL('http://localhost/auth/oauth/google/callback?code=ok&state=browser-bound-state'),
  );
  assert.equal(consumed, true);
  assert.match(browserA.getHeader('location'), /oauth=cookie_v1/);
});

test('OAuth state binding and bootstrap replay use atomic oauth_states deletes with separate provider namespaces', async () => {
  const calls = [];
  dataStore.query = async (sql, values) => {
    calls.push({ sql, values });
    if (/DELETE FROM oauth_states/.test(sql)) {
      return { rows: [{ state: values[0], provider: values[1], extra_data: {} }] };
    }
    return { rows: [] };
  };

  await oauthService.verifyOAuthState('a'.repeat(64), 'google', {
    transactionHash: 'b'.repeat(64),
  });
  await oauthService.registerOAuthBootstrapJti('c'.repeat(32), 2_000);
  await oauthService.consumeOAuthBootstrapJti('c'.repeat(32));

  assert.match(calls[0].sql, /^DELETE FROM oauth_states/i);
  assert.match(calls[0].sql, /extra_data\s*->>\s*'oauth_tx_hash'/i);
  assert.deepEqual(calls[0].values, ['a'.repeat(64), 'google', 'b'.repeat(64)]);
  assert.match(calls[1].sql, /^INSERT INTO oauth_states/i);
  assert.equal(calls[1].values[1], 'oauth_bootstrap');
  assert.match(calls[2].sql, /^DELETE FROM oauth_states/i);
  assert.deepEqual(calls[2].values, ['c'.repeat(32), 'oauth_bootstrap']);
});

test('omitted or unknown flow is legacy, is recorded without cookie_v1, and requires the rolling flag', async () => {
  let capturedExtra = null;
  oauthService.isGoogleEnabled = () => true;
  oauthService.isGoogleConfigured = () => true;
  oauthService.createOAuthState = async (_provider, _redirect, extra) => {
    capturedExtra = extra;
    return 'legacy-state';
  };
  oauthService.buildGoogleAuthUrl = () => 'https://accounts.example.test/oauth';

  const disabledStart = makeResponse();
  await registerOAuthRoutes(
    '/auth/oauth/google',
    makeRequest({ url: '/auth/oauth/google?flow=unknown' }),
    disabledStart,
    new URL('http://localhost/auth/oauth/google?flow=unknown'),
  );
  assert.equal(disabledStart.statusCode, 403);

  process.env.OAUTH_ALLOW_LEGACY_FRAGMENT = 'true';
  const enabledStart = makeResponse();
  await registerOAuthRoutes(
    '/auth/oauth/google',
    makeRequest({ url: '/auth/oauth/google?redirect=%2Findex-desktop.html' }),
    enabledStart,
    new URL('http://localhost/auth/oauth/google?redirect=%2Findex-desktop.html'),
  );
  assert.equal(enabledStart.statusCode, 302);
  assert.equal(capturedExtra.flow, undefined);
  assert.match(capturedExtra.oauth_tx_hash, /^[a-f0-9]{64}$/);
  const transactionCookie = cookiePair(enabledStart, 'linglish_oauth_tx_dev');

  oauthService.verifyOAuthState = async () => ({
    redirect_url: '/index-desktop.html',
    extra_data: { mobile: false, oauth_tx_hash: capturedExtra.oauth_tx_hash },
  });
  oauthService.exchangeGoogleCode = async () => ({ accessToken: 'google-access' });
  oauthService.getGoogleUserProfile = async () => ({ email: 'legacy@example.test', name: 'Legacy User' });
  oauthService.handleOAuthLogin = async () => ({
    user: { id: 7, email: 'legacy@example.test', status: 'active' },
    isNewUser: false,
  });
  dataStore.recordLoginSession = async () => {};
  dataStore.createEvent = async () => {};

  const enabledRes = makeResponse();
  await registerOAuthRoutes(
    '/auth/oauth/google/callback',
    makeRequest({
      url: '/auth/oauth/google/callback?code=ok&state=legacy-state',
      cookie: transactionCookie,
    }),
    enabledRes,
    new URL('http://localhost/auth/oauth/google/callback?code=ok&state=legacy-state'),
  );
  assert.match(enabledRes.getHeader('location'), /#token=/i);
  assert.equal(enabledRes.getHeader('cache-control'), 'no-store');
  assert.equal(enabledRes.getHeader('referrer-policy'), 'no-referrer');
});

test('cookie_v1 initiation and callback return a generic 503 when scoped-token configuration is invalid', async () => {
  oauthService.isGoogleEnabled = () => true;
  oauthService.isGoogleConfigured = () => true;
  let stateCreations = 0;
  oauthService.createOAuthState = async () => {
    stateCreations += 1;
    return 'configured-state';
  };
  oauthService.buildGoogleAuthUrl = () => 'https://accounts.example.test/oauth';

  delete process.env.SCOPED_TOKEN_SECRET;
  const missingRes = makeResponse();
  await registerOAuthRoutes(
    '/auth/oauth/google',
    makeRequest({ url: '/auth/oauth/google?flow=cookie_v1' }),
    missingRes,
    new URL('http://localhost/auth/oauth/google?flow=cookie_v1'),
  );
  assert.equal(missingRes.statusCode, 503);
  assert.equal(stateCreations, 0);
  assert.doesNotMatch(JSON.stringify(missingRes.body), /SCOPED_TOKEN_SECRET/i);

  process.env.SCOPED_TOKEN_SECRET = SCOPED_SECRET;
  const startRes = makeResponse();
  await registerOAuthRoutes(
    '/auth/oauth/google',
    makeRequest({ url: '/auth/oauth/google?flow=cookie_v1' }),
    startRes,
    new URL('http://localhost/auth/oauth/google?flow=cookie_v1'),
  );
  const transactionCookie = cookiePair(startRes, 'linglish_oauth_tx_dev');
  oauthService.verifyOAuthState = async () => ({
    redirect_url: '/today.html',
    extra_data: { mobile: false, flow: 'cookie_v1' },
  });
  oauthService.exchangeGoogleCode = async () => ({ accessToken: 'google-access' });
  oauthService.getGoogleUserProfile = async () => ({ email: 'oauth@example.test', name: 'OAuth User' });
  oauthService.handleOAuthLogin = async () => ({
    user: { id: 7, email: 'oauth@example.test', status: 'active' },
    isNewUser: false,
  });
  dataStore.recordLoginSession = async () => {};
  dataStore.createEvent = async () => {};
  process.env.SCOPED_TOKEN_SECRET = 'too-short';

  const callbackRes = makeResponse();
  await registerOAuthRoutes(
    '/auth/oauth/google/callback',
    makeRequest({
      url: '/auth/oauth/google/callback?code=ok&state=config-state',
      cookie: transactionCookie,
    }),
    callbackRes,
    new URL('http://localhost/auth/oauth/google/callback?code=ok&state=config-state'),
  );
  assert.equal(callbackRes.statusCode, 503);
  assert.doesNotMatch(JSON.stringify(callbackRes.body), /SCOPED_TOKEN_SECRET/i);
  assert.ok(setCookieValues(callbackRes).some(value => /^linglish_oauth_tx_dev=; Max-Age=0;/.test(value)));
});

test('POST /auth/oauth/session returns the established account JSON and clears its cookie on success or failure', async () => {
  const {
    createOAuthBootstrapToken,
    serializeOAuthBootstrapCookie,
  } = scopedTokens();
  dataStore.findUserById = async id => String(id) === '7'
    ? { id: 7, email: 'oauth@example.test', status: 'active', password_hash: 'hidden' }
    : null;
  oauthService.consumeOAuthBootstrapJti = async () => true;
  const bootstrap = createOAuthBootstrapToken(
    { id: 7 },
    {
      isNew: false,
      redirectUrl: '/today.html?from=oauth',
      secret: SCOPED_SECRET,
    },
  );
  const cookie = serializeOAuthBootstrapCookie(bootstrap, { production: false }).split(';')[0];
  const successRes = makeResponse();

  assert.equal(await registerOAuthRoutes(
    '/auth/oauth/session',
    makeRequest({ method: 'POST', url: '/auth/oauth/session', cookie }),
    successRes,
    new URL('http://localhost/auth/oauth/session'),
  ), true);
  assert.equal(successRes.statusCode, 200);
  assert.notEqual(successRes.body.access_token, successRes.body.refresh_token);
  const refreshPayload = authService.decodeToken(successRes.body.refresh_token);
  assert.equal(refreshPayload.typ, 'refresh');
  assert.equal(refreshPayload.sub, 7);
  assert.equal(successRes.body.user_id, 7);
  assert.equal(successRes.body.is_new, false);
  assert.equal(successRes.body.user.email, 'oauth@example.test');
  assert.equal(successRes.body.redirect_url, '/today.html?from=oauth');
  assert.equal(authService.decodeToken(successRes.body.access_token).sub, 7);
  assert.equal(
    successRes.getHeader('set-cookie'),
    'linglish_oauth_bootstrap_dev=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax',
  );
  assert.equal(successRes.getHeader('cache-control'), 'no-store');

  const failureRes = makeResponse();
  assert.equal(await registerOAuthRoutes(
    '/auth/oauth/session',
    makeRequest({ method: 'POST', url: '/auth/oauth/session' }),
    failureRes,
    new URL('http://localhost/auth/oauth/session'),
  ), true);
  assert.equal(failureRes.statusCode, 401);
  assert.equal(
    failureRes.getHeader('set-cookie'),
    'linglish_oauth_bootstrap_dev=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax',
  );
});

test('POST /auth/oauth/session atomically consumes bootstrap jti across sequential and concurrent replay', async () => {
  const { createOAuthBootstrapToken, serializeOAuthBootstrapCookie } = scopedTokens();
  dataStore.findUserById = async id => String(id) === '7'
    ? { id: 7, email: 'oauth@example.test', status: 'active', password_hash: 'hidden' }
    : null;
  const available = new Set();
  oauthService.consumeOAuthBootstrapJti = async (jti) => {
    if (!available.delete(jti)) throw new Error('OAUTH_BOOTSTRAP_REPLAYED');
    await Promise.resolve();
    return true;
  };

  function issueCookie() {
    const token = createOAuthBootstrapToken(
      { id: 7 },
      { isNew: false, redirectUrl: '/today.html', secret: SCOPED_SECRET },
    );
    available.add(decodePayload(token).jti);
    return serializeOAuthBootstrapCookie(token, { production: false }).split(';')[0];
  }

  async function exchange(cookie) {
    const res = makeResponse();
    await registerOAuthRoutes(
      '/auth/oauth/session',
      makeRequest({ method: 'POST', url: '/auth/oauth/session', cookie }),
      res,
      new URL('http://localhost/auth/oauth/session'),
    );
    return res;
  }

  const sequentialCookie = issueCookie();
  const first = await exchange(sequentialCookie);
  const replay = await exchange(sequentialCookie);
  assert.deepEqual([first.statusCode, replay.statusCode], [200, 401]);

  const concurrentCookie = issueCookie();
  const concurrent = await Promise.all([exchange(concurrentCookie), exchange(concurrentCookie)]);
  assert.deepEqual(concurrent.map(res => res.statusCode).sort(), [200, 401]);
  for (const res of [first, replay, ...concurrent]) {
    assert.equal(
      res.getHeader('set-cookie'),
      'linglish_oauth_bootstrap_dev=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax',
    );
  }
});
