(function (root, factory) {
  const tour = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = {
      computeTourPosition: tour.computeTourPosition,
      shouldStartTour: tour.shouldStartTour,
      isUsableRect: tour.isUsableRect,
    };
  } else {
    root.LinglishTour = tour;
    root.startLinglishTour = tour.startTour;
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const STYLE_ID = 'linglish-tour-style';
  const INVITE_DELAY_MS = 1200;

  function shouldStartTour(search) {
    return new URLSearchParams(search || '').get('focus') !== 'first_lesson';
  }

  function isUsableRect(rect) {
    return Boolean(rect) && rect.width > 4 && rect.height > 4;
  }

  function computeTourPosition({ targetRect, tooltipRect, viewport, padding }) {
    const tooltipWidth = Math.min(tooltipRect.width, Math.max(0, viewport.width - padding * 2));
    const tooltipHeight = Math.min(tooltipRect.height, Math.max(0, viewport.height - padding * 2));
    const spaceBelow = viewport.height - targetRect.bottom;
    const placeBelow = spaceBelow > tooltipHeight + padding;
    const candidateTop = placeBelow
      ? targetRect.bottom + padding
      : targetRect.top - tooltipHeight - padding;
    const maxTop = Math.max(padding, viewport.height - tooltipHeight - padding);
    const tooltipTop = Math.min(Math.max(candidateTop, padding), maxTop);
    const maxLeft = Math.max(padding, viewport.width - tooltipWidth - padding);
    const tooltipLeft = Math.min(Math.max(targetRect.left, padding), maxLeft);

    return { tooltipTop, tooltipLeft, tooltipWidth, tooltipHeight };
  }

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .tour-overlay { position: fixed; inset: 0; z-index: 9998; background: transparent; }
      .tour-highlight {
        position: fixed; z-index: 9999; pointer-events: none;
        border-radius: 14px;
        box-shadow: 0 0 0 9999px rgba(15, 23, 42, 0.5), 0 0 0 2px rgba(255, 255, 255, 0.85);
        transition: top .22s ease, left .22s ease, width .22s ease, height .22s ease;
      }
      .tour-tooltip, .tour-invite {
        position: fixed; box-sizing: border-box; z-index: 10000;
        background: #fff; color: #0f172a; border-radius: 16px;
        box-shadow: 0 18px 44px rgba(15, 23, 42, 0.22), 0 0 0 1px rgba(15, 23, 42, 0.05);
        font-family: inherit;
        animation: tour-in .2s ease both;
      }
      .tour-tooltip {
        width: min(320px, calc(100vw - 32px));
        max-height: calc(100vh - 32px); overflow-y: auto;
        padding: 16px 16px 14px; display: grid; gap: 8px;
        transition: top .22s ease, left .22s ease;
      }
      .tour-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
      .tour-count { font-size: 12px; font-weight: 700; color: #0f766e; letter-spacing: .02em; }
      .tour-title { font-weight: 700; font-size: 16px; line-height: 1.3; }
      .tour-text { font-size: 14px; line-height: 1.5; color: #475569; }
      .tour-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
      .tour-btn {
        min-height: 40px; padding: 0 16px; border: 0; border-radius: 999px;
        font: inherit; font-size: 14px; font-weight: 650; cursor: pointer;
        transition: transform .15s ease, background-color .15s ease;
      }
      .tour-btn:active { transform: scale(.97); }
      .tour-btn:focus-visible, .tour-close:focus-visible { outline: 3px solid rgba(14, 165, 233, .4); outline-offset: 2px; }
      .tour-btn.primary { background: linear-gradient(135deg, #0d9488, #2dd4bf); color: #fff; }
      .tour-btn.ghost { background: transparent; color: #475569; }
      .tour-btn.ghost:hover { background: #f1f5f9; }
      .tour-btn[hidden] { display: none; }
      .tour-close {
        width: 32px; height: 32px; margin: -6px -6px 0 0; border: 0; border-radius: 999px;
        background: transparent; color: #64748b; font-size: 20px; line-height: 1; cursor: pointer;
      }
      .tour-close:hover { background: #f1f5f9; }
      .tour-invite {
        left: 50%; transform: translateX(-50%);
        bottom: calc(16px + env(safe-area-inset-bottom, 0px));
        width: min(420px, calc(100vw - 24px));
        display: flex; align-items: center; gap: 12px; padding: 12px 8px 12px 16px;
      }
      .tour-invite-text { flex: 1 1 auto; min-width: 0; display: grid; gap: 2px; }
      .tour-invite-text strong { font-size: 14px; }
      .tour-invite-text span { font-size: 13px; color: #64748b; }
      @keyframes tour-in { from { opacity: 0; translate: 0 8px; } to { opacity: 1; translate: 0 0; } }
      @media (prefers-reduced-motion: reduce) {
        .tour-highlight, .tour-tooltip, .tour-invite { transition: none; animation: none; }
      }
    `;
    document.head.appendChild(style);
  }

  function getUserKey() {
    try {
      return localStorage.getItem('userEmail') ||
        sessionStorage.getItem('userEmail') ||
        localStorage.getItem('userId') ||
        sessionStorage.getItem('userId') ||
        'anon';
    } catch (_) {
      return 'anon';
    }
  }

  function isDone(storageKey) {
    try {
      const globalKey = `linglish_tour_done_${getUserKey()}`;
      return localStorage.getItem(globalKey) === 'done' || localStorage.getItem(storageKey) === 'done';
    } catch (_) {
      return false;
    }
  }

  function markDone(storageKey) {
    try {
      localStorage.setItem(storageKey, 'done');
      localStorage.setItem(`linglish_tour_done_${getUserKey()}`, 'done');
    } catch (_) { }
  }

  function findTarget(step) {
    const el = step && document.querySelector(step.target);
    return el && isUsableRect(el.getBoundingClientRect()) ? el : null;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function runTour(steps, storageKey) {
    const usable = steps.filter((step) => findTarget(step));
    if (!usable.length) {
      markDone(storageKey);
      return;
    }

    let current = 0;
    const overlay = el('div', 'tour-overlay');
    const highlight = el('div', 'tour-highlight');
    const tooltip = el('div', 'tour-tooltip');
    tooltip.setAttribute('role', 'dialog');
    tooltip.setAttribute('aria-modal', 'true');

    const head = el('div', 'tour-head');
    const count = el('span', 'tour-count');
    const close = el('button', 'tour-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', '关闭引导');
    head.append(count, close);

    const title = el('div', 'tour-title');
    const text = el('div', 'tour-text');
    const actions = el('div', 'tour-actions');
    const backBtn = el('button', 'tour-btn ghost', '上一步');
    const nextBtn = el('button', 'tour-btn primary', '下一步');
    backBtn.type = 'button';
    nextBtn.type = 'button';
    actions.append(backBtn, nextBtn);
    tooltip.append(head, title, text, actions);

    function finish() {
      markDone(storageKey);
      overlay.remove();
      highlight.remove();
      tooltip.remove();
      window.removeEventListener('resize', positionStep);
      window.removeEventListener('scroll', positionStep, true);
      document.removeEventListener('keydown', onKey);
    }

    function positionStep() {
      const target = findTarget(usable[current]);
      if (!target) return;
      const rect = target.getBoundingClientRect();
      const pad = 6;
      highlight.style.top = `${Math.max(rect.top - pad, 8)}px`;
      highlight.style.left = `${Math.max(rect.left - pad, 8)}px`;
      highlight.style.width = `${Math.min(rect.width + pad * 2, window.innerWidth - 16)}px`;
      highlight.style.height = `${Math.min(rect.height + pad * 2, window.innerHeight - 16)}px`;
      const pos = computeTourPosition({
        targetRect: rect,
        tooltipRect: tooltip.getBoundingClientRect(),
        viewport: { width: window.innerWidth, height: window.innerHeight },
        padding: 16,
      });
      tooltip.style.top = `${pos.tooltipTop}px`;
      tooltip.style.left = `${pos.tooltipLeft}px`;
    }

    function renderStep() {
      const step = usable[current];
      const target = findTarget(step);
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      count.textContent = usable.length > 1 ? `${current + 1} / ${usable.length}` : '';
      title.textContent = step.title || '';
      text.textContent = step.text || '';
      backBtn.hidden = current === 0;
      nextBtn.textContent = current === usable.length - 1 ? '知道了' : '下一步';
      positionStep();
      setTimeout(positionStep, 260);
      nextBtn.focus({ preventScroll: true });
    }

    function onKey(event) {
      if (event.key === 'Escape') finish();
    }

    backBtn.addEventListener('click', () => {
      if (current > 0) {
        current -= 1;
        renderStep();
      }
    });
    nextBtn.addEventListener('click', () => {
      if (current < usable.length - 1) {
        current += 1;
        renderStep();
      } else {
        finish();
      }
    });
    close.addEventListener('click', finish);
    overlay.addEventListener('click', finish);
    document.addEventListener('keydown', onKey);

    document.body.append(overlay, highlight, tooltip);
    window.addEventListener('resize', positionStep);
    window.addEventListener('scroll', positionStep, true);
    renderStep();
  }

  /* A sheet or dialog already owns the screen; the invitation must not stack on top of it. */
  function hasBlockingLayer() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // Whatever sits at the centre of the screen: if it lives in a large fixed layer, a dialog is up.
    let node = document.elementFromPoint(vw / 2, vh / 2);
    while (node && node !== document.body && node !== document.documentElement) {
      if (getComputedStyle(node).position === 'fixed') {
        const rect = node.getBoundingClientRect();
        if (rect.width * rect.height > vw * vh * 0.4) return true;
      }
      node = node.parentElement;
    }
    return Array.from(document.querySelectorAll('dialog[open], [aria-modal="true"]')).some((modal) => {
      if (modal.closest('[hidden], [aria-hidden="true"]')) return false;
      const style = getComputedStyle(modal);
      return style.visibility !== 'hidden' && modal.getClientRects().length > 0;
    });
  }

  /* First visit: a small, non-blocking invitation instead of a full-screen takeover.
     The page stays usable; the guided tour only runs if the learner asks for it. */
  function startTour(steps, storageKey) {
    if (!Array.isArray(steps) || steps.length === 0) return;
    if (isDone(storageKey)) return;
    injectStyles();
    let attempts = 0;

    const offer = () => {
      if (isDone(storageKey) || !steps.some((step) => findTarget(step))) return;
      if (hasBlockingLayer()) {
        attempts += 1;
        if (attempts < 30) setTimeout(offer, 2000);
        return;
      }
      const invite = el('div', 'tour-invite');
      invite.setAttribute('role', 'status');
      const copy = el('div', 'tour-invite-text');
      copy.append(el('strong', '', '第一次用这一页？'), el('span', '', '花 20 秒看看各个按钮在哪。'));
      const go = el('button', 'tour-btn primary', '带我看看');
      const dismiss = el('button', 'tour-close', '×');
      go.type = 'button';
      dismiss.type = 'button';
      dismiss.setAttribute('aria-label', '不用了');
      invite.append(copy, go, dismiss);

      const close = () => invite.remove();
      go.addEventListener('click', () => {
        close();
        runTour(steps, storageKey);
      });
      dismiss.addEventListener('click', () => {
        markDone(storageKey);
        close();
      });
      document.body.appendChild(invite);
    };
    setTimeout(offer, INVITE_DELAY_MS);
  }

  return { computeTourPosition, shouldStartTour, isUsableRect, startTour, runTour };
});
