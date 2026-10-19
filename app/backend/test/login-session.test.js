const test = require('node:test');
const assert = require('node:assert/strict');

process.env.AUTH_TOKEN_SECRET = process.env.AUTH_TOKEN_SECRET || 'login-session-test-secret-0123456789abcdef';

const dataStore = require('../data-store');
const authService = require('../services/auth');
const loginSession = require('../services/login-session');
const oauthService = require('../services/oauth');

const DAY = 24 * 60 * 60;

function nearly(actual, expected, slack = 5) {
  assert.ok(Math.abs(actual - expected) <= slack, `expected ${actual} within ${slack} of ${expected}`);
}

test('login session renews quietly for 30 days, stops at 90, and keeps data credentials to 1 hour', async () => {
  const originalQuery = dataStore.query;
  const originalFind = dataStore.findUserById;
  const originalProbe = oauthService.probeStoredGoogleGrant;
  dataStore.query = async () => {
    throw new Error('DB_DISABLED_IN_UNIT_TEST');
  };
  dataStore.findUserById = async (id) => ({
    id,
    email: 'learner@example.test',
    status: 'active',
    password_hash: 'x',
  });
  oauthService.probeStoredGoogleGrant = async () => 'valid';
  loginSession.resetForTests();

  try {
    const user = { id: 42, email: 'learner@example.test' };
    const deviceId = 'device-one-123456';
    const issued = await authService.issueLoginCredentials(user, {
      deviceId,
      provider: 'password',
    });

    const access = authService.decodeToken(issued.access_token);
    const refresh = authService.decodeToken(issued.refresh_token);
    nearly(access.exp - access.iat, 60 * 60);
    nearly(refresh.exp - refresh.iat, 30 * DAY);
    nearly(refresh.abs - refresh.iat, 90 * DAY);
    assert.equal(access.sid, refresh.sid);
    assert.equal(access.typ, undefined);
    assert.equal(refresh.typ, 'refresh');
    assert.equal(issued.device_id, deviceId);
    assert.equal(issued.expires_in, 60 * 60);

    const sessionUser = await authService.requireUser(issued.access_token);
    assert.equal(sessionUser.email, 'learner@example.test');
    await assert.rejects(
      () => authService.requireUser(issued.refresh_token),
      (err) => err.message === 'INVALID_TOKEN',
    );

    const legacy = authService.createAccessTokenForUser({ id: 9, email: 'learner@example.test' });
    assert.equal((await authService.requireUser(legacy)).id, 9);

    const record = loginSession._memory.get(access.sid);
    const now = Math.floor(Date.now() / 1000);
    record.absoluteExp = now + 10 * DAY;
    record.slidingExp = now + DAY;
    const extended = await authService.refreshLogin(issued.refresh_token, deviceId);
    const extendedRefresh = authService.decodeToken(extended.refresh_token);
    assert.equal(extendedRefresh.exp, record.absoluteExp);
    assert.equal(extendedRefresh.abs, record.absoluteExp);
    await authService.requireUser(extended.access_token);

    await assert.rejects(
      () => authService.refreshLogin(extended.refresh_token, 'another-device-9999'),
      (err) => err.message === 'TOKEN_EXPIRED',
    );

    record.slidingExp = now - 5;
    record.absoluteExp = now - 5;
    await assert.rejects(
      () => authService.refreshLogin(extended.refresh_token, deviceId),
      (err) => err.message === 'TOKEN_EXPIRED',
    );

    const google = await authService.issueLoginCredentials(user, {
      deviceId,
      provider: 'google',
    });
    oauthService.probeStoredGoogleGrant = async () => 'revoked';
    await assert.rejects(
      () => authService.refreshLogin(google.refresh_token, deviceId),
      (err) => err.message === 'GOOGLE_AUTHORIZATION_REVOKED',
    );
    await assert.rejects(
      () => authService.requireUser(google.access_token),
      (err) => err.message === 'TOKEN_EXPIRED',
    );

    const phone = await authService.issueLoginCredentials(user, {
      deviceId: 'phone-device-000001',
      provider: 'password',
    });
    const laptop = await authService.issueLoginCredentials(user, {
      deviceId: 'laptop-device-00002',
      provider: 'password',
    });
    await assert.rejects(
      () => authService.requireUser(phone.access_token),
      (err) => err.message === 'TOKEN_EXPIRED',
    );
    assert.equal((await authService.requireUser(laptop.access_token)).id, 42);

    const logout = await authService.issueLoginCredentials(user, { deviceId, provider: 'guest' });
    await authService.revokeSessionToken(logout.access_token);
    await assert.rejects(
      () => authService.requireUser(logout.access_token),
      (err) => err.message === 'TOKEN_EXPIRED',
    );
    await assert.rejects(
      () => authService.refreshLogin(logout.refresh_token, deviceId),
      (err) => err.message === 'TOKEN_EXPIRED',
    );
  } finally {
    dataStore.query = originalQuery;
    dataStore.findUserById = originalFind;
    oauthService.probeStoredGoogleGrant = originalProbe;
    loginSession.resetForTests();
  }
});
