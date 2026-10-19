(function () {
  const root = document.getElementById('study-switch');
  if (!root) return;

  const params = new URLSearchParams(window.location.search);
  const onPractice = /practice-session-desktop\.html$/.test(window.location.pathname);
  const dialogue = params.get('mode') === 'dialogue';
  const pickingForCoach = !onPractice && params.get('returnTo') === 'coach';
  const current = onPractice || pickingForCoach
    ? (dialogue ? 'arena' : 'coach')
    : 'video';

  root.querySelectorAll('[data-study]').forEach((link) => {
    if (link.dataset.study === current) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });

  const title = document.getElementById('coach-brand-title');
  const note = document.getElementById('coach-brand-note');
  if (title && note && onPractice) {
    title.textContent = dialogue ? '实战场' : 'AI陪练';
    note.textContent = dialogue ? '选一段内容，扮演着说' : '选一段内容，听一句跟着说';
  }

  const prefetched = new Set();

  function prefetchDocument(href) {
    try {
      const url = new URL(href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname) return;
      const key = url.pathname + url.search;
      if (prefetched.has(key)) return;
      prefetched.add(key);
      fetch(url.href, { credentials: 'same-origin' }).catch(function () {});
    } catch (_) {}
  }

  function warmTopbar() {
    document.querySelectorAll('.topbar a[href]').forEach((link) => {
      const href = link.getAttribute('href') || '';
      if (!href || href.charAt(0) === '#') return;
      const warm = () => prefetchDocument(href);
      link.addEventListener('pointerenter', warm, { once: true });
      link.addEventListener('pointerdown', warm, { once: true });
    });
    const idle = window.requestIdleCallback || function (fn) { setTimeout(fn, 1); };
    idle(function () {
      document.querySelectorAll('.topbar a[href]').forEach((link) => {
        const href = link.getAttribute('href') || '';
        if (!href || href.charAt(0) === '#') return;
        prefetchDocument(href);
      });
    });
  }

  warmTopbar();

  function numericVideoId() {
    const value = window.LinglishStudyVideoId || params.get('videoId') || '';
    return /^\d+$/.test(String(value)) ? String(value) : '';
  }

  function practiceHref(mode) {
    const videoId = numericVideoId();
    const media = window.LinglishStudyMedia;
    if (!videoId && media && media.audioUrl) {
      try { sessionStorage.setItem('linglish.coach.media', JSON.stringify(media)); } catch (_) {}
      return './practice-session-desktop.html?source=external&mode=' + mode;
    }
    const next = new URLSearchParams({ mode: mode });
    if (videoId) next.set('videoId', videoId);
    return './practice-session-desktop.html?' + next.toString();
  }

  function applyPracticeMode(mode) {
    window.switchPracticeMode(mode);
  }

  window.addEventListener('popstate', function () {
    if (!onPractice || typeof window.switchPracticeMode !== 'function') return;
    const mode = new URLSearchParams(window.location.search).get('mode') === 'dialogue' ? 'dialogue' : 'shadowing';
    window.switchPracticeMode(mode, { history: 'skip' });
  });

  root.addEventListener('click', (event) => {
    const link = event.target.closest('[data-study]');
    if (!link || link.getAttribute('aria-current') === 'page') {
      if (link) event.preventDefault();
      return;
    }
    event.preventDefault();
    const target = link.dataset.study;
    const videoId = numericVideoId();
    if (target === 'video') {
      const next = new URLSearchParams();
      if (videoId) next.set('videoId', videoId);
      window.location.href = './video-reader-desktop.html' + (next.toString() ? '?' + next.toString() : '');
      return;
    }
    const mode = target === 'arena' ? 'dialogue' : 'shadowing';
    if (onPractice && typeof window.switchPracticeMode === 'function') {
      applyPracticeMode(mode);
      return;
    }
    window.location.href = practiceHref(mode);
  });
})();
