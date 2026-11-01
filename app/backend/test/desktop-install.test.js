const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const frontend = path.resolve(__dirname, '../../frontend');

const DESKTOP_PAGES = [
  'index-desktop.html',
  'video-reader-desktop.html',
  'practice-session-desktop.html',
  'video-vocabulary-desktop.html',
  'desktop-auth.html',
  'stats-desktop.html',
  'today.html',
];

function read(name) {
  return fs.readFileSync(path.join(frontend, name), 'utf8');
}

function pngSize(fileName) {
  const bytes = fs.readFileSync(path.join(frontend, fileName));
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

test('desktop install manifest launches the desktop home in a standalone window', () => {
  const manifest = JSON.parse(read('manifest-desktop.json'));

  assert.equal(manifest.id, '/index-desktop.html');
  assert.equal(manifest.start_url, '/index-desktop.html');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.prefer_related_applications, false);
  assert.ok(manifest.icons.some((icon) => icon.sizes === '192x192' && icon.purpose === 'any'));
  assert.ok(manifest.icons.some((icon) => icon.sizes === '512x512' && icon.purpose === 'any'));
  assert.ok(manifest.icons.some((icon) => icon.sizes === '512x512' && icon.purpose === 'maskable'));
  assert.deepEqual(
    manifest.shortcuts.map((item) => item.url),
    [
      '/today.html',
      '/video-reader-desktop.html',
      '/practice-session-desktop.html?mode=shadowing',
    ]
  );
});

test('install icons exist at the sizes Chrome requires', () => {
  assert.deepEqual(pngSize('icon-192x192.png'), { width: 192, height: 192 });
  assert.deepEqual(pngSize('icon-512x512.png'), { width: 512, height: 512 });
  assert.deepEqual(pngSize('icon-maskable-512.png'), { width: 512, height: 512 });
  assert.deepEqual(pngSize('apple-touch-icon.png'), { width: 180, height: 180 });
});

test('desktop pages expose the install manifest and the install control', () => {
  for (const page of DESKTOP_PAGES) {
    const html = read(page);
    assert.match(html, /rel="manifest" href="\/manifest-desktop\.json"/, page);
    assert.match(html, /src="\/js\/install-desktop\.js\?v=2026103001"/, page);
  }
});

test('install control uses the browser install prompt and stays out of an installed window', () => {
  const source = read('js/install-desktop.js');

  assert.match(source, /beforeinstallprompt/);
  assert.match(source, /event\.preventDefault\(\)/);
  assert.match(source, /promptEvent\.prompt\(\)/);
  assert.match(source, /serviceWorker\.register\('\/sw\.js(?:\?v=\d+)?'/);
  assert.match(source, /display-mode: standalone/);
  assert.match(source, /appinstalled/);
  assert.match(source, /安装到桌面/);
  assert.match(source, /添加到主屏幕/);
  assert.match(source, /installTarget/);
  assert.match(source, /manifest\.json/);
  assert.match(source, /window\.top !== window\.self/);
  assert.match(source, /focus-mode/);
  assert.match(source, /\.transcript \.header-top/);
  assert.match(source, /isHomeSurface/);
  assert.match(source, /if \(isHomeSurface\(target\)\)/);
  assert.match(source, /isMacSafari/);
  assert.match(source, /!deferredPrompt && !isMacSafari\(\)/);
  assert.match(source, /isDesktopComputer/);
});
