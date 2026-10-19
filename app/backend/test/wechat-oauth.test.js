const test = require('node:test');
const assert = require('node:assert/strict');

const oauthService = require('../services/oauth');

test('wechat QR login uses the official website connect URL', () => {
  const url = new URL(oauthService.buildWechatAuthUrl('state-token', {
    appId: 'wx-test-app',
    callbackUrl: 'http://localhost:4000/auth/oauth/wechat/callback',
  }));

  assert.equal(`${url.origin}${url.pathname}`, 'https://open.weixin.qq.com/connect/qrconnect');
  assert.equal(url.searchParams.get('appid'), 'wx-test-app');
  assert.equal(url.searchParams.get('scope'), 'snsapi_login');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('state'), 'state-token');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:4000/auth/oauth/wechat/callback');
  assert.equal(url.hash, '#wechat_redirect');
});

test('wechat login stays off until the switch and both credentials are present', () => {
  const previous = {
    enabled: process.env.ENABLE_WECHAT_OAUTH,
    appId: process.env.WECHAT_APP_ID,
    secret: process.env.WECHAT_APP_SECRET,
  };
  try {
    delete process.env.ENABLE_WECHAT_OAUTH;
    delete process.env.WECHAT_APP_ID;
    delete process.env.WECHAT_APP_SECRET;
    assert.equal(oauthService.isWechatConfigured(), false);

    process.env.ENABLE_WECHAT_OAUTH = 'true';
    process.env.WECHAT_APP_ID = 'wx-test-app';
    assert.equal(oauthService.isWechatConfigured(), false);

    process.env.WECHAT_APP_SECRET = 'test-secret';
    assert.equal(oauthService.isWechatConfigured(), true);
  } finally {
    if (previous.enabled == null) delete process.env.ENABLE_WECHAT_OAUTH;
    else process.env.ENABLE_WECHAT_OAUTH = previous.enabled;
    if (previous.appId == null) delete process.env.WECHAT_APP_ID;
    else process.env.WECHAT_APP_ID = previous.appId;
    if (previous.secret == null) delete process.env.WECHAT_APP_SECRET;
    else process.env.WECHAT_APP_SECRET = previous.secret;
  }
});
