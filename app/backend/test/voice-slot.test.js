const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const slot = require(path.resolve(__dirname, '../../frontend/js/video-reader/voice-slot.js'));

test('only the latest speak claim stays current', () => {
  let now = 1000;
  const voice = slot.createVoiceSlot(() => now);
  const first = voice.claim('at');
  const second = voice.claim('Welcome back');
  assert.equal(voice.isCurrent(first), false);
  assert.equal(voice.isCurrent(second), true);
  voice.release();
  assert.equal(voice.isCurrent(second), false);
});

test('a second click on the same text restarts after the coalesce window', () => {
  let now = 1000;
  const voice = slot.createVoiceSlot(() => now);
  const first = voice.claim('at');
  assert.equal(voice.claim('at'), 0);
  now += 280;
  const again = voice.claim('at');
  assert.notEqual(again, 0);
  assert.equal(voice.isCurrent(first), false);
  assert.equal(voice.isCurrent(again), true);
});

test('video learning wires dictionary speech and video playback to one slot', () => {
  const frontend = path.resolve(__dirname, '../../frontend');
  const desktop = fs.readFileSync(path.join(frontend, 'video-reader-desktop.html'), 'utf8');
  const mobile = fs.readFileSync(path.join(frontend, 'video-reader.html'), 'utf8');
  const main = fs.readFileSync(path.join(frontend, 'js/video-reader/main.js'), 'utf8');
  const controls = fs.readFileSync(path.join(frontend, 'js/video-reader/pro-controls.js'), 'utf8');

  assert.match(desktop, /js\/video-reader\/voice-slot\.js/);
  assert.match(desktop, /dictVoiceSlot\.claim\(word\)/);
  assert.match(desktop, /function hideDrawer\(\) \{[\s\S]*?stopSpokenAudio\(\)/);
  assert.match(controls, /bridge\.stopDictAudio\(\)/);
  const scriptOrder = [...mobile.matchAll(/<script[^>]+src="([^"]+)"/g)].map((match) => match[1]);
  const slotIndex = scriptOrder.findIndex((src) => src.includes('voice-slot.js'));
  const mainIndex = scriptOrder.findIndex((src) => src.includes('/video-reader/main.js'));
  assert.ok(slotIndex >= 0 && mainIndex > slotIndex);
  assert.match(main, /dictVoiceSlot\.claim\(lemma\)/);
  assert.match(main, /pauseLearningVideoForWord\(\)/);
});
