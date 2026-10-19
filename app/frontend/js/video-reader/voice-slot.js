(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.LinglishVoiceSlot = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  function createVoiceSlot(now) {
    const clock = typeof now === 'function' ? now : function () { return Date.now(); };
    let generation = 0;
    let activeText = '';
    let startedAt = 0;

    return {
      claim(text, coalesceMs) {
        const key = String(text || '');
        const wait = Number(coalesceMs);
        const windowMs = Number.isFinite(wait) ? wait : 280;
        const t = clock();
        if (key && key === activeText && t - startedAt < windowMs) return 0;
        generation += 1;
        activeText = key;
        startedAt = t;
        return generation;
      },
      release() {
        generation += 1;
        activeText = '';
        startedAt = 0;
        return generation;
      },
      isCurrent(token) {
        return token > 0 && token === generation;
      },
    };
  }

  return { createVoiceSlot };
});
