/**
 * Desktop video-reader: Hold to record (mouse or Space) with KTV karaoke fill.
 * Same pipeline as mobile — VoiceChatCoach live ASR match + AI陪练 replay.
 */
(function (root) {
  'use strict';

  const HOLD_IDLE = 'Hold to record';
  const HOLD_WARM = 'Opening mic…';
  const HOLD_ACTIVE = 'Release to send';

  let holdBtn = null;
  let labelEl = null;
  let pointerDown = false;
  let pointerId = null;
  let spaceDown = false;
  let hearBtn = null;

  function toast(msg, kind) {
    try {
      if (typeof root.showToast === 'function') {
        root.showToast(msg, kind || 'info');
        return;
      }
    } catch (_) {}
  }

  function setLabel(text) {
    if (!holdBtn) return;
    if (!labelEl) {
      labelEl = holdBtn.querySelector('[data-hold-label]');
      if (!labelEl) {
        holdBtn.textContent = '';
        labelEl = document.createElement('span');
        labelEl.setAttribute('data-hold-label', '');
        holdBtn.appendChild(labelEl);
      }
    }
    labelEl.textContent = text;
  }

  function setUi(holding, warming) {
    if (!holdBtn) return;
    holdBtn.classList.toggle('is-holding', !!holding && !warming);
    holdBtn.classList.toggle('is-mic-warming', !!warming);
    if (warming) {
      setLabel(HOLD_WARM);
      holdBtn.setAttribute('aria-label', '开麦中');
    } else if (holding) {
      setLabel(HOLD_ACTIVE);
      holdBtn.setAttribute('aria-label', '松开结束跟读');
    } else {
      setLabel(HOLD_IDLE);
      holdBtn.setAttribute('aria-label', '按住跟读');
    }
  }

  root.syncDesktopHoldUi = function syncDesktopHoldUi(holding, warming) {
    setUi(holding, warming);
  };

  root.syncDesktopHearMe = function syncDesktopHearMe(enabled) {
    ensureHearButton();
    if (hearBtn) hearBtn.disabled = !enabled;
  };

  function bridge() {
    return root.LinglishVoiceChatBridge || null;
  }

  function canUseVoiceHold() {
    const b = bridge();
    return !!(b && typeof b.beginHold === 'function');
  }

  function isTypingTarget(target) {
    if (!target || !target.tagName) return false;
    const tag = String(target.tagName).toUpperCase();
    if (['INPUT', 'TEXTAREA', 'SELECT', 'AUDIO', 'VIDEO', 'SUMMARY', 'A'].includes(tag)) return true;
    if (tag === 'BUTTON' && target !== holdBtn) return true;
    if (typeof target.closest === 'function' && target.closest('.topbar, .goal-studio, summary, audio, video')) return true;
    if (target.isContentEditable) return true;
    return false;
  }

  function clearDesktopKaraoke() {
    document.querySelectorAll(
      '#caption-bar .coach-row.is-karaoke, #caption-bar .lyric-line.is-karaoke, #transcript-list .seg-text.is-karaoke, #transcript-list .text.is-karaoke'
    ).forEach((el) => {
      el.classList.remove('is-karaoke');
      const idx = Number(
        (el.closest('[data-index]') && el.closest('[data-index]').getAttribute('data-index'))
        || el.getAttribute('data-index')
      );
      const st = (root.__vrdPro && root.__vrdPro.state) || root.state || {};
      const seg = Number.isFinite(idx) ? (st.currentSegments || [])[idx] : null;
      if (seg) el.textContent = seg.text || seg.en || el.textContent;
    });
    // Coaching dock MutationObserver / next frame restores clickable words.
    try {
      if (root.LinglishCoachingDock && typeof root.LinglishCoachingDock.sync === 'function') {
        root.LinglishCoachingDock.sync();
      }
    } catch (_) {}
  }

  function paintDesktopKaraoke(detail) {
    if (!detail || !detail.holding) {
      clearDesktopKaraoke();
      return;
    }
    const idx = Number(detail.index);
    const html = detail.html
      || (root.LinglishVoiceChatCoach && typeof root.LinglishVoiceChatCoach.karaokeEnHtml === 'function'
        ? root.LinglishVoiceChatCoach.karaokeEnHtml(detail.text || '', detail.hitCount || 0, detail.partial || 0)
        : '');
    if (!html || !Number.isFinite(idx)) return;

    const targets = [];
    const captionCurrent = document.querySelector(
      '#caption-bar .coach-row.is-current, #caption-bar .coach-row.is-depth-0, #lyric-current'
    );
    if (captionCurrent) {
      const di = Number(captionCurrent.getAttribute('data-index'));
      if (!Number.isFinite(di) || di === idx) targets.push(captionCurrent);
    }
    const seg = document.querySelector(
      '#transcript-list .seg[data-index="' + idx + '"] .text, #transcript-list .seg[data-index="' + idx + '"] .seg-text, #transcript-list .seg[data-index="' + idx + '"] .en'
    );
    if (seg) targets.push(seg);

    targets.forEach((el) => {
      el.classList.add('is-karaoke');
      el.innerHTML = html;
    });
  }

  async function beginHold(event) {
    const b = bridge();
    if (!canUseVoiceHold()) {
      toast('跟读组件还没加载，请强制刷新后再试', 'warn');
      return;
    }
    setUi(true, true);
    try {
      if (typeof b.sync === 'function') b.sync();
      const chat = typeof b.getChat === 'function' ? b.getChat() : null;
      const idx = (() => {
        try {
          const vrp = root.__vrdPro;
          if (vrp && typeof vrp.currentSegmentIndexByTime === 'function') {
            let t = 0;
            const el = vrp.playerEl || document.getElementById('player');
            if (el && Number.isFinite(Number(el.currentTime))) t = Number(el.currentTime);
            return vrp.currentSegmentIndexByTime(t);
          }
        } catch (_) {}
        return -1;
      })();
      if (chat && typeof chat.lockPracticeTarget === 'function' && idx >= 0) {
        try {
          const sheet = document.getElementById('desktop-voice-session');
          const open = sheet && !sheet.hidden;
          chat.lockPracticeTarget(idx, { silent: true, skipSeed: !open });
        } catch (_) {}
      }
      await b.beginHold(event);
      setUi(true, false);
      if (!pointerDown && !spaceDown && typeof b.endHold === 'function') {
        await b.endHold(event);
        setUi(false, false);
      }
    } catch (err) {
      console.warn('[DeskHold] begin failed', err);
      setUi(false, false);
      toast('跟读失败，请再按住试一次', 'warn');
    }
  }

  async function endHold(event) {
    const b = bridge();
    if (!b || typeof b.endHold !== 'function') {
      setUi(false, false);
      return;
    }
    try {
      await b.endHold(event);
    } catch (_) {}
    setUi(false, false);
  }

  function onDown(event) {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (pointerDown || spaceDown) return;
    event.preventDefault();
    pointerDown = true;
    pointerId = event.pointerId;
    try {
      if (holdBtn && typeof holdBtn.setPointerCapture === 'function') {
        holdBtn.setPointerCapture(event.pointerId);
      }
    } catch (_) {}
    beginHold(event);
  }

  function onUp(event) {
    if (event && pointerId != null && event.pointerId !== pointerId) return;
    if (event) {
      event.preventDefault();
      try {
        if (holdBtn && pointerId != null && typeof holdBtn.releasePointerCapture === 'function') {
          holdBtn.releasePointerCapture(pointerId);
        }
      } catch (_) {}
    }
    pointerId = null;
    if (!pointerDown) return;
    pointerDown = false;
    endHold(event);
  }

  function onSpaceDown(event) {
    if (event.code !== 'Space' && event.key !== ' ') return;
    if (event.repeat || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    if (document.documentElement?.dataset.learningFocus === 'first-lesson') return;
    if (isTypingTarget(event.target)) return;
    if (pointerDown || spaceDown) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    spaceDown = true;
    beginHold(event);
  }

  function onSpaceUp(event) {
    if (event.code !== 'Space' && event.key !== ' ') return;
    if (!spaceDown) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    spaceDown = false;
    endHold(event);
  }

  function ensureHearButton() {
    if (hearBtn && hearBtn.isConnected) return hearBtn;
    const dock = document.getElementById('desk-speak-dock');
    if (!dock) return null;
    hearBtn = document.getElementById('desk-hear-me');
    if (!hearBtn) {
      hearBtn = document.createElement('button');
      hearBtn.type = 'button';
      hearBtn.id = 'desk-hear-me';
      hearBtn.className = 'desk-hear-btn';
      hearBtn.textContent = '听我的跟读';
      hearBtn.disabled = true;
      hearBtn.title = '回听刚才 Hold 录下的声音';
      dock.appendChild(hearBtn);
      hearBtn.addEventListener('click', async () => {
        let url = '';
        try {
          if (typeof root.resolvePlayableShadowUrl === 'function') {
            url = await root.resolvePlayableShadowUrl();
          }
        } catch (_) {}
        if (!url) {
          url = root.__lastShadowUrl
            || ((root.__vrdPro && root.__vrdPro.state && root.__vrdPro.state.lastRecordingUrl) || '');
        }
        if (!url) {
          toast('还没有跟读录音', 'warn');
          return;
        }
        try {
          const audio = new Audio(url);
          audio.play().catch(() => toast('回听失败，请再试一次', 'warn'));
        } catch (_) {
          toast('回听失败，请再试一次', 'warn');
        }
      });
    }
    return hearBtn;
  }

  function bind() {
    holdBtn = document.getElementById('desk-hold');
    if (!holdBtn) return;
    if (holdBtn.dataset.xHoldBound === '1') return;
    holdBtn.dataset.xHoldBound = '1';
    labelEl = holdBtn.querySelector('[data-hold-label]');
    setUi(false, false);
    holdBtn.addEventListener('pointerdown', onDown);
    holdBtn.addEventListener('pointerup', onUp);
    holdBtn.addEventListener('pointercancel', onUp);
    holdBtn.addEventListener('lostpointercapture', onUp);
    holdBtn.addEventListener('contextmenu', (event) => event.preventDefault());

    // Space = Hold (capture so it wins over play/pause).
    document.addEventListener('keydown', onSpaceDown, true);
    document.addEventListener('keyup', onSpaceUp, true);

    root.addEventListener('linglish:voice-live-match', (event) => {
      try { paintDesktopKaraoke(event && event.detail); } catch (_) {}
    });

    ensureHearButton();
  }

  function boot() {
    bind();
    // Bridge mounts after scripts load; sync once ready.
    const trySync = () => {
      const b = bridge();
      if (b && typeof b.sync === 'function') {
        try { b.sync(); } catch (_) {}
      }
    };
    trySync();
    setTimeout(trySync, 400);
    setTimeout(trySync, 1200);
  }

  root.LinglishDesktopXHold = { boot, bind, beginHold, endHold };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(typeof window !== 'undefined' ? window : globalThis);
