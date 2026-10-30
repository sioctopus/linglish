const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const frontend = path.resolve(__dirname, '../../frontend');
const guardPath = path.join(frontend, 'js/video-reader/video-selection-guard.js');
const pagePath = path.join(frontend, 'video-reader-desktop.html');

test('only the latest video selection may update asynchronous player state', () => {
  assert.equal(fs.existsSync(guardPath), true, 'video selection guard module should exist');
  const { createVideoSelectionGuard } = require(guardPath);
  const guard = createVideoSelectionGuard();

  const first = guard.begin(123);
  const latest = guard.begin(162);

  assert.equal(guard.isCurrent(first), false);
  assert.equal(guard.isCurrent(latest), true);
  assert.equal(guard.isCurrent(latest, 123), false);
  assert.equal(guard.isCurrent(latest, 162), true);
});

test('clearing the current video invalidates pending asynchronous work', () => {
  assert.equal(fs.existsSync(guardPath), true, 'video selection guard module should exist');
  const { createVideoSelectionGuard } = require(guardPath);
  const guard = createVideoSelectionGuard();
  const pending = guard.begin('123');

  guard.invalidate();

  assert.equal(guard.isCurrent(pending), false);
});

test('starting or clearing a selection fully releases the previous players', () => {
  assert.equal(fs.existsSync(guardPath), true, 'video selection guard module should exist');
  const { createVideoSelectionLifecycle } = require(guardPath);
  const released = { local: 0, youtube: 0, transcript: 0, seek: 0 };
  const lifecycle = createVideoSelectionLifecycle({
    unloadLocal: () => { released.local += 1; },
    destroyYouTube: () => { released.youtube += 1; },
    clearTranscript: () => { released.transcript += 1; },
    cancelPendingLocalSeek: () => { released.seek += 1; },
  });

  const first = lifecycle.begin(123);
  const latest = lifecycle.begin(162);

  assert.equal(lifecycle.isCurrent(first), false);
  assert.equal(lifecycle.isCurrent(latest, 162), true);
  assert.deepEqual(released, { local: 2, youtube: 2, transcript: 2, seek: 2 });

  lifecycle.invalidate();
  assert.equal(lifecycle.isCurrent(latest), false);
  assert.deepEqual(released, { local: 3, youtube: 3, transcript: 3, seek: 3 });
});

test('desktop reader guards both player and transcript commits with the selection token', () => {
  const html = fs.readFileSync(pagePath, 'utf8');

  assert.match(html, /js\/video-reader\/video-selection-guard\.js/);
  assert.match(html, /js\/app\/youtube-player\.js\?v=20260803/);
  assert.doesNotMatch(html, /youtube-player\.js\?v=1(?:[\"'])/);
  assert.match(html, /videoSelectionGuard\.begin\(v\.id\)/);
  assert.match(html, /createVideoSelectionLifecycle\(\{/);
  assert.match(html, /unloadLocal:\s*\(\)\s*=>\s*\{/);
  assert.match(html, /playerEl\.removeAttribute\('src'\)/);
  assert.match(html, /destroyYouTube:\s*\(\)\s*=>\s*\{[\s\S]*youtubePlayer\.destroy\(\)/);
  assert.match(html, /cancelPendingLocalSeek:\s*\(\)\s*=>\s*\{[\s\S]*removeEventListener\('loadedmetadata'/);
  assert.match(
    html,
    /clearTranscript:\s*\(\)\s*=>\s*\{[\s\S]*state\.currentSegments\s*=\s*\[\][\s\S]*renderTranscript\(\)[\s\S]*renderActiveSubtitle\(-1\)/
  );
  assert.match(html, /function applyPendingSeekToLocal\(selectionToken\)/);
  assert.match(html, /videoSelectionGuard\.isCurrent\(selectionToken,\s*expectedVideoId\)/);
  assert.match(html, /catch \(error\) \{[\s\S]*if \(!isCurrentSelection\(\)\) return;[\s\S]*youtubePlayer\.destroy\(\)/);
  assert.match(html, /loadVideoDetails\(v\.id,\s*selectionToken\)/);
  assert.match(html, /async function loadVideoDetails\(id,\s*selectionToken/);
  assert.match(html, /videoSelectionGuard\.isCurrent\(selectionToken,\s*id\)/);
  assert.match(html, /videoSelectionGuard\.invalidate\(\)/);
});
