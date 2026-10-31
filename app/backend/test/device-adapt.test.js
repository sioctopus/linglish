const test = require('node:test');
const assert = require('node:assert/strict');
const { Writable } = require('node:stream');

const LxDevice = require('../../frontend/js/device-adapt');
const { injectDeviceAdapt, registerStaticRoutes } = require('../routes/static');

test('phone, tablet and Mac tiers follow viewport width', () => {
  assert.equal(LxDevice.classify({
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit Mobile',
    viewportWidth: 390,
    pointer: 'coarse',
    hover: 'none'
  }).tier, 'phone');

  assert.equal(LxDevice.classify({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
    viewportWidth: 390
  }).os, 'ios');

  assert.equal(LxDevice.classify({
    userAgent: 'Mozilla/5.0 (Linux; Android 13; YouhuaPad) AppleWebKit',
    viewportWidth: 800,
    maxTouchPoints: 5,
    pointer: 'coarse',
    hover: 'none'
  }).tier, 'tablet-portrait');

  assert.equal(LxDevice.classify({
    userAgent: 'Mozilla/5.0 (Linux; Android 13; YouhuaPad) AppleWebKit',
    viewportWidth: 1280,
    maxTouchPoints: 5,
    pointer: 'coarse',
    hover: 'none'
  }).tier, 'tablet-landscape');

  assert.equal(LxDevice.classify({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    viewportWidth: 834,
    maxTouchPoints: 5,
    pointer: 'coarse',
    hover: 'none'
  }).tier, 'tablet-portrait');

  const mac = LxDevice.classify({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    viewportWidth: 1440,
    maxTouchPoints: 0,
    pointer: 'fine',
    hover: 'hover'
  });
  assert.equal(mac.tier, 'desktop');
  assert.equal(mac.os, 'mac');

  const windows = LxDevice.classify({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit Chrome/130.0.0.0',
    viewportWidth: 1440,
    maxTouchPoints: 0,
    pointer: 'fine',
    hover: 'hover'
  });
  assert.equal(windows.tier, 'desktop');
  assert.equal(windows.os, 'windows');
  assert.equal(windows.form, 'desktop');
});

test('phones and tablets install to the home screen, desktops install to the desktop', () => {
  const phone = LxDevice.installTarget(LxDevice.classify({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
    viewportWidth: 390,
    pointer: 'coarse',
    hover: 'none'
  }));
  assert.equal(phone.surface, 'home');
  assert.equal(phone.manifest, '/manifest.json');

  const android = LxDevice.installTarget(LxDevice.classify({
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit Mobile',
    viewportWidth: 390,
    pointer: 'coarse',
    hover: 'none'
  }));
  assert.equal(android.surface, 'home');

  const ipad = LxDevice.installTarget(LxDevice.classify({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    viewportWidth: 1180,
    maxTouchPoints: 5,
    pointer: 'coarse',
    hover: 'none'
  }));
  assert.equal(ipad.surface, 'home');
  assert.equal(ipad.manifest, '/manifest.json');

  const desktop = LxDevice.installTarget(LxDevice.classify({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    viewportWidth: 1440,
    pointer: 'fine',
    hover: 'hover'
  }));
  assert.equal(desktop.surface, 'desktop');
  assert.equal(desktop.manifest, '/manifest-desktop.json');
  assert.deepEqual(LxDevice.installTarget(null), desktop);
});

test('viewport keeps an existing zoom lock and adds the safe-area flag', () => {
  const meta = {
    content: 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no',
    getAttribute(name) { return name === 'content' ? this.content : null; },
    setAttribute(name, value) { if (name === 'content') this.content = value; }
  };
  LxDevice.ensureViewport({
    head: { appendChild() {} },
    querySelector() { return meta; }
  });
  assert.match(meta.content, /viewport-fit=cover/);
  assert.match(meta.content, /user-scalable=no/);
  assert.match(meta.content, /interactive-widget=resizes-content/);
});

test('frontend html is served with the shared device adaptation', async () => {
  const once = injectDeviceAdapt('<head><title>x</title></head><body></body>');
  assert.equal(injectDeviceAdapt(once), once);

  const response = new CaptureResponse();
  const request = { method: 'GET', url: '/router.html', headers: {} };
  const url = new URL('http://127.0.0.1/router.html');
  const served = await registerStaticRoutes(url.pathname, request, response, url);
  assert.equal(served, true);
  assert.match(response.body(), /\/js\/device-adapt\.js\?v=2026103001/);
  assert.match(response.body(), /\/styles\/device-adapt\.css\?v=2026103001/);
  assert.equal(response.body().split('data-lx-device-adapt').length - 1, 2);
  assert.doesNotMatch(response.body(), /install-desktop\.js/);

  const mobile = injectDeviceAdapt('<head><title>x</title></head><body></body>', 'mobile-today.html');
  assert.match(mobile, /apple-touch-icon/);
  assert.match(mobile, /apple-mobile-web-app-capable/);
  assert.match(mobile, /\/js\/install-desktop\.js\?v=2026103001/);
  assert.equal(injectDeviceAdapt(mobile, 'mobile-today.html'), mobile);
});

class CaptureResponse extends Writable {
  constructor() {
    super();
    this.headers = new Map();
    this.chunks = [];
  }

  _write(chunk, _encoding, callback) {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }

  setHeader(name, value) { this.headers.set(name.toLowerCase(), value); }
  getHeader(name) { return this.headers.get(name.toLowerCase()); }

  writeHead(status, headers) {
    this.statusCode = status;
    Object.entries(headers || {}).forEach(([name, value]) => this.setHeader(name, value));
    return this;
  }

  body() { return Buffer.concat(this.chunks).toString('utf8'); }
}
