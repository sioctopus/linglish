/**
 * Short UI audio cues (mic-ready ding, etc.)
 * Safe no-op when AudioContext is unavailable or blocked.
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.LinglishAudioCues = api;
})(typeof window !== 'undefined' ? window : null, function (root) {
  'use strict';

  let sharedCtx = null;

  function audioContext() {
    if (!root) return null;
    const AC = root.AudioContext || root.webkitAudioContext;
    if (!AC) return null;
    if (!sharedCtx) {
      try { sharedCtx = new AC(); } catch (_) { return null; }
    }
    return sharedCtx;
  }

  /**
   * Soft “ready to speak” ding when shadowing / recording starts.
   */
  function playMicReadyCue() {
    try {
      const ctx = audioContext();
      if (!ctx) return false;
      if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
        ctx.resume().catch(function () {});
      }
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(920, now);
      osc.frequency.exponentialRampToValueAtTime(640, now + 0.09);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.1, now + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.13);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.15);
      return true;
    } catch (_) {
      return false;
    }
  }

  return { playMicReadyCue };
});
