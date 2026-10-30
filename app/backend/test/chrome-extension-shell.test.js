const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const extensionRoot = path.resolve(__dirname, '../../extension');
const frontendRoot = path.resolve(__dirname, '../../frontend');

function readExt(name) {
  return fs.readFileSync(path.join(extensionRoot, name), 'utf8');
}

function existsExt(name) {
  return fs.existsSync(path.join(extensionRoot, name));
}

test('chrome extension MV3 manifest exposes launcher + YouTube helper', () => {
  const manifest = JSON.parse(readExt('manifest.json'));

  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.name, 'Linglish');
  assert.equal(manifest.action.default_popup, 'popup.html');
  assert.equal(manifest.background.service_worker, 'background.js');
  assert.ok(manifest.permissions.includes('storage'));
  assert.ok(manifest.permissions.includes('contextMenus'));
  assert.ok(manifest.host_permissions.some((item) => item.includes('localhost:4000')));
  assert.ok(manifest.host_permissions.some((item) => item.includes('youtube.com')));
  assert.ok(
    manifest.content_scripts.some((entry) =>
      entry.js.includes('content/youtube.js') &&
      entry.matches.some((m) => m.includes('youtube.com'))
    )
  );
  assert.ok(
    manifest.content_scripts.some((entry) =>
      entry.js.includes('content/site-bridge.js') &&
      entry.matches.some((m) => m.includes('localhost:4000'))
    )
  );
  assert.ok(manifest.externally_connectable.matches.some((m) => m.includes('localhost:4000')));
});

test('chrome extension package files and icons exist', () => {
  for (const name of [
    'config.js',
    'background.js',
    'popup.html',
    'popup.js',
    'popup.css',
    'content/youtube.js',
    'content/youtube.css',
    'content/site-bridge.js',
    'icons/icon-16.png',
    'icons/icon-32.png',
    'icons/icon-48.png',
    'icons/icon-128.png',
  ]) {
    assert.ok(existsExt(name), name);
  }
});

test('extension config and background call existing YouTube import API', () => {
  const config = readExt('config.js');
  const background = readExt('background.js');
  const popup = readExt('popup.js');
  const youtube = readExt('content/youtube.js');

  assert.match(config, /ORIGIN:\s*'http:\/\/localhost:4000'/);
  assert.match(config, /video-reader-desktop\.html/);
  assert.match(background, /\/youtube\/import/);
  assert.match(background, /Authorization:\s*`Bearer/);
  assert.match(background, /IMPORT_YOUTUBE/);
  assert.match(background, /SET_SESSION/);
  assert.match(background, /linglish-save-youtube/);
  assert.match(popup, /OPEN_LOGIN/);
  assert.match(popup, /IMPORT_YOUTUBE/);
  assert.match(youtube, /存到 Linglish/);
});

test('site auth bridge page exists for extension login handoff', () => {
  const bridge = fs.readFileSync(path.join(frontendRoot, 'extension-bridge.html'), 'utf8');
  assert.match(bridge, /扩展已连接|Chrome 扩展登录桥/);
  assert.match(bridge, /auth-manager\.js/);
  assert.match(bridge, /desktop-auth\.html\?next=\/extension-bridge\.html/);
});

test('CORS allows chrome-extension origins for helper fetches', () => {
  const cors = fs.readFileSync(path.join(__dirname, '../utils/cors.js'), 'utf8');
  assert.match(cors, /isChromeExtensionOrigin/);
  assert.match(cors, /chrome-extension:\/\//);
});
