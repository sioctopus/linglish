const test = require('node:test');
const assert = require('node:assert/strict');

let MobileReaderLayout = {};
try {
  MobileReaderLayout = require('../../frontend/js/video-reader/mobile-reader-layout');
} catch (_) {
  // RED phase: behavior assertions below should fail until the helper exists.
}

test('phone layout starts with the video library closed', () => {
  assert.equal(typeof MobileReaderLayout.shouldStartSidebarHidden, 'function');
  assert.equal(MobileReaderLayout.shouldStartSidebarHidden(390), true);
  assert.equal(MobileReaderLayout.shouldStartSidebarHidden(768), true);
});

test('desktop layout preserves the existing sidebar state', () => {
  assert.equal(MobileReaderLayout.shouldStartSidebarHidden(1024), false);
});

test('opening a closed library returns synchronized visual and accessible state', () => {
  assert.deepEqual(MobileReaderLayout.nextSidebarState(true), {
    hidden: false,
    expanded: true,
    label: '关闭视频库',
    text: '关闭'
  });
  assert.deepEqual(MobileReaderLayout.openSidebarState(), {
    hidden: false,
    expanded: true,
    label: '关闭视频库',
    text: '关闭'
  });
});

test('closing an open library returns the reusable closed state', () => {
  const expected = {
    hidden: true,
    expanded: false,
    label: '打开视频库',
    text: '视频库'
  };

  assert.deepEqual(MobileReaderLayout.nextSidebarState(false), expected);
  assert.deepEqual(MobileReaderLayout.closedSidebarState(), expected);
});

test('focused reader leaves transcript height under responsive CSS control', () => {
  assert.equal(
    MobileReaderLayout.usesFocusedTranscriptSizing('video-reader-mobile-focus'),
    true
  );
  assert.equal(
    MobileReaderLayout.usesFocusedTranscriptSizing('legacy-video-reader'),
    false
  );
});
