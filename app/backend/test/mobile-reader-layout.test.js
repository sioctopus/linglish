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

function guidedToolsFixture() {
  const summary = { nodeName: 'SUMMARY' };
  const transcript = { nodeName: 'DIV', id: 'mobile-transcript' };
  const controls = { nodeName: 'DIV', id: 'mobile-player-controls' };
  const session = { nodeName: 'DIV', id: 'mobile-voice-session' };
  const player = { nodeName: 'DIV', id: 'video-wrapper' };
  const coach = { nodeName: 'DIV', id: 'coach-dock' };
  const tools = {
    nodeName: 'DETAILS', open: true,
    childNodes: [summary, transcript, controls, session],
    replaceWith(...nodes) {
      const index = area.children.indexOf(this);
      area.children.splice(index, 1, ...nodes);
      for (const node of nodes) node.parentElement = area;
      this.parentElement = null;
    },
  };
  const area = { children: [player, coach, tools] };
  for (const node of area.children) node.parentElement = area;
  for (const node of tools.childNodes) node.parentElement = tools;
  return { area, player, coach, tools, transcript, controls, session };
}

test('ordinary reader keeps video, captions and recording controls in the original shared stack', () => {
  const f = guidedToolsFixture();
  assert.equal(typeof MobileReaderLayout.configureGuidedTools, 'function');
  assert.equal(MobileReaderLayout.configureGuidedTools(f.tools, false), null);
  assert.deepEqual(f.area.children, [f.player, f.coach, f.transcript, f.controls, f.session]);
  assert.equal(f.transcript.parentElement, f.player.parentElement);
  assert.equal(f.controls.parentElement, f.player.parentElement);
});

test('guided lesson retains its native disclosure without replacing its controls', () => {
  const f = guidedToolsFixture();
  assert.equal(typeof MobileReaderLayout.configureGuidedTools, 'function');
  assert.equal(MobileReaderLayout.configureGuidedTools(f.tools, true), f.tools);
  assert.equal(f.tools.open, false);
  assert.deepEqual(f.tools.childNodes.slice(1), [f.transcript, f.controls, f.session]);
  assert.equal(f.transcript.parentElement, f.tools);
});

test('leaving a guided lesson restores the ordinary stack once without losing node identity', () => {
  const f = guidedToolsFixture();
  assert.equal(typeof MobileReaderLayout.configureGuidedTools, 'function');
  MobileReaderLayout.configureGuidedTools(f.tools, true);
  MobileReaderLayout.configureGuidedTools(f.tools, false);
  const nodes = f.area.children.slice();
  MobileReaderLayout.configureGuidedTools(f.tools, false);
  assert.deepEqual(f.area.children, nodes);
  assert.equal(MobileReaderLayout.configureGuidedTools(null, false), null);
});
