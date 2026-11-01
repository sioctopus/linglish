const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const defaults = require('../../frontend/js/video-reader/media-library-defaults.js');

test('desktop refreshes an outdated recommended channel without changing a custom subscription', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../frontend/js/pages/video-reader-desktop-app.js'), 'utf8');
  const begin = source.indexOf('function ensureDefaultMediaLibraries() {');
  const end = source.indexOf('\n    let coverHydratePromise', begin);
  assert.ok(begin >= 0 && end > begin);
  const custom = { channelId: 'own-channel', title: 'My own lesson', pageUrl: 'https://www.youtube.com/@my-own-lesson', videos: [{ id: 'keep-this' }] };
  const stores = new Map([
    ['channels', [{ defaultId: 'miss-honey-yt', channelId: 'seed:youtube:miss-honey-yt', handle: 'MissHoneyEnglish', pageUrl: 'https://www.youtube.com/@MissHoneyEnglish', seeded: true, favorite: true, videos: [], hydrateFailed: true, hydrateError: '不能访问内网地址' }, custom]],
    ['podcasts', []],
  ]);
  const versions = new Map([['version', 'previous-catalog']]);
  const context = vm.createContext({ mediaDefaults: defaults, CHANNEL_STORE_KEY: 'channels', PODCAST_STORE_KEY: 'podcasts', MEDIA_DEFAULTS_VERSION_KEY: 'version', MEDIA_STORE_LIMIT: 120,
    localStorage: { getItem: key => versions.get(key), setItem: (key, value) => versions.set(key, value) },
    readStore: key => stores.get(key), writeStore: (key, value) => stores.set(key, value), hydrateMediaCovers() {},
  });
  vm.runInContext(source.slice(begin, end) + '\nensureDefaultMediaLibraries();', context);
  const channels = JSON.parse(JSON.stringify(stores.get('channels')));
  const honey = channels.find(item => item.defaultId === 'miss-honey-yt');
  assert.equal(honey.pageUrl, 'https://www.youtube.com/@Slow_English_Podcast');
  assert.equal(honey.favorite, true);
  assert.equal(honey.hydrateFailed, false);
  assert.equal(honey.hydrateError, '');
  assert.deepEqual(channels.find(item => item.channelId === 'own-channel'), custom);
});
