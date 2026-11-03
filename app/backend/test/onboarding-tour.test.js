const test = require('node:test');
const assert = require('node:assert/strict');

const { computeTourPosition, shouldStartTour, isUsableRect } = require('../../frontend/js/onboarding-tour.js');

test('the focus product flag skips the generic video library tour and attribution alone does not', () => {
  assert.equal(shouldStartTour('?from=today_first_lesson&focus=first_lesson&videoId=113'), false);
  assert.equal(shouldStartTour('?from=today_first_lesson&videoId=113'), true);
  assert.equal(shouldStartTour('?videoId=113'), true);
});

test('tour tooltip stays inside the viewport for an oversized target', () => {
  const pos = computeTourPosition({
    targetRect: { top: 100, left: 40, right: 280, bottom: 1100, width: 240, height: 1000 },
    tooltipRect: { width: 288, height: 132 },
    viewport: { width: 1280, height: 720 },
    padding: 16,
  });
  assert.ok(pos.tooltipTop >= 16);
  assert.ok(pos.tooltipTop + 132 <= 704);
  assert.ok(pos.tooltipLeft >= 16);
  assert.ok(pos.tooltipLeft + 288 <= 1264);
});

test('tour tooltip uses effective geometry within a small viewport near screen edges', () => {
  const pos = computeTourPosition({
    targetRect: { top: 456, left: 300, right: 320, bottom: 480, width: 20, height: 24 },
    tooltipRect: { width: 360, height: 500 },
    viewport: { width: 320, height: 480 },
    padding: 16,
  });

  assert.equal(pos.tooltipWidth, 288);
  assert.equal(pos.tooltipHeight, 448);
  assert.ok(pos.tooltipTop >= 16);
  assert.ok(pos.tooltipTop + pos.tooltipHeight <= 464);
  assert.ok(pos.tooltipLeft >= 16);
  assert.ok(pos.tooltipLeft + pos.tooltipWidth <= 304);
});

test('tour skips targets that are hidden or collapsed instead of spotlighting the screen corner', () => {
  assert.equal(isUsableRect({ width: 0, height: 0 }), false);
  assert.equal(isUsableRect({ width: 120, height: 2 }), false);
  assert.equal(isUsableRect(null), false);
  assert.equal(isUsableRect({ width: 120, height: 40 }), true);
});
