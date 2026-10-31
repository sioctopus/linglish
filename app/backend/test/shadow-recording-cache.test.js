const test = require('node:test');
const assert = require('node:assert/strict');

const cacheApi = require('../../frontend/js/practice/shadow-recording-cache');

function blobLike(text, type) {
  return {
    type: type || 'audio/webm',
    size: String(text || '').length,
    text: () => Promise.resolve(String(text || '')),
  };
}

test('save keeps a recording for 7 days and overwrites the same sentence', async () => {
  const clock = { now: 1_700_000_000_000 };
  const store = cacheApi.createMemoryStore();
  const cache = cacheApi.createShadowRecordingCache(
    { Date: { now: () => clock.now }, URL: { createObjectURL: () => 'blob:a', revokeObjectURL() {} } },
    { store, ttlMs: cacheApi.DEFAULT_TTL_MS },
  );

  const first = await cache.save({
    videoId: 42,
    segmentIndex: 3,
    blob: blobLike('take-1'),
  });
  assert.equal(first.videoId, '42');
  assert.equal(first.segmentIndex, 3);
  assert.equal(first.expiresAt - first.savedAt, cacheApi.DEFAULT_TTL_MS);

  clock.now += 60_000;
  await cache.save({
    videoId: 42,
    segmentIndex: 3,
    blob: blobLike('take-2'),
  });

  const hit = await cache.get({ videoId: 42, segmentIndex: 3 });
  assert.equal(hit.blob.text && await hit.blob.text(), 'take-2');

  const list = await cache.listForVideo(42);
  assert.equal(list.length, 1);
});

test('expired recordings are purged and no longer returned', async () => {
  const clock = { now: 1_700_000_000_000 };
  const store = cacheApi.createMemoryStore();
  const cache = cacheApi.createShadowRecordingCache(
    { Date: { now: () => clock.now } },
    { store, ttlMs: 7 * 24 * 60 * 60 * 1000 },
  );

  await cache.save({ videoId: 'yt:abc', segmentIndex: 0, blob: blobLike('old') });
  clock.now += (7 * 24 * 60 * 60 * 1000) + 1;

  const hit = await cache.get({ videoId: 'yt:abc', segmentIndex: 0 });
  assert.equal(hit, null);

  const latest = await cache.getLatestForVideo('yt:abc');
  assert.equal(latest, null);
});

test('getLatestForVideo prefers the newest sentence take', async () => {
  const clock = { now: 1_700_000_000_000 };
  const store = cacheApi.createMemoryStore();
  const urls = [];
  const cache = cacheApi.createShadowRecordingCache(
    {
      Date: { now: () => clock.now },
      URL: {
        createObjectURL(blob) {
          const url = `blob:${urls.length}:${blob.size}`;
          urls.push(url);
          return url;
        },
        revokeObjectURL() {},
      },
    },
    { store },
  );

  await cache.save({ videoId: 9, segmentIndex: 1, blob: blobLike('one') });
  clock.now += 1000;
  await cache.save({ videoId: 9, segmentIndex: 2, blob: blobLike('two') });

  const latest = await cache.getLatestForVideo(9);
  assert.equal(latest.segmentIndex, 2);

  const state = { lastRecordingUrl: 'blob:stale' };
  assert.equal(cache.applyToState(state, latest), true);
  assert.equal(state.lastRecordingSegmentIndex, 2);
  assert.match(String(state.lastRecordingUrl), /^blob:/);
});
