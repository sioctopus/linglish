(function () {
  const root = document.getElementById('study-switch');
  if (!root) return;

  const LABELS = {
    video: '视频学习',
    coach: 'AI陪练',
    arena: '实战场',
  };

  const pathname = String(window.location.pathname || '');
  const params = new URLSearchParams(window.location.search);
  const onPracticeDesktop = /practice-session-desktop\.html$/i.test(pathname);
  const onPracticeMobile = /(?:^|\/)practice-session\.html$/i.test(pathname);
  const onVideoDesktop = /video-reader-desktop\.html$/i.test(pathname);
  const onVideoMobile = /(?:^|\/)video-reader\.html$/i.test(pathname);
  const onPractice = onPracticeDesktop || onPracticeMobile;
  const onVideoReader = onVideoDesktop || onVideoMobile;
  const mobileSurface = onPracticeMobile || onVideoMobile
    || (!onPracticeDesktop && !onVideoDesktop && (window.matchMedia('(max-width: 768px)').matches || /Mobi|Android|iPhone/i.test(navigator.userAgent || '')));
  const dialogue = params.get('mode') === 'dialogue';
  const pickingForCoach = !onPractice && params.get('returnTo') === 'coach';
  const studyParam = params.get('study');
  const current = onPractice || pickingForCoach
    ? (dialogue ? 'arena' : 'coach')
    : (onVideoReader && (studyParam === 'coach' || studyParam === 'arena') ? studyParam : 'video');

  const trigger = root.querySelector('.study-switch-trigger');
  const menu = root.querySelector('.study-switch-menu');
  const labelEl = root.querySelector('[data-study-label]');

  function markCurrent(target) {
    root.querySelectorAll('[data-study]').forEach((link) => {
      if (link.dataset.study === target) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
    if (labelEl) labelEl.textContent = LABELS[target] || LABELS.video;
  }

  markCurrent(current);

  const title = document.getElementById('coach-brand-title');
  const note = document.getElementById('coach-brand-note');
  if (title && note && onPractice) {
    title.textContent = dialogue ? '实战场' : 'AI陪练';
    note.textContent = dialogue
      ? '沿用视频学习里选中的内容，扮演着说'
      : '沿用视频学习里选中的内容，听一句跟着说';
  }

  function setMenuOpen(open) {
    if (!trigger || !menu) return;
    menu.hidden = !open;
    trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  if (trigger && menu) {
    trigger.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      setMenuOpen(menu.hidden);
    });
    document.addEventListener('click', (event) => {
      if (!root.contains(event.target)) setMenuOpen(false);
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') setMenuOpen(false);
    });
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

  // 视频学习选中内容 = AI陪练 / 实战场的唯一片源（不用 StudyRecent 另起炉灶）
  const LAST_STUDY_MEDIA_KEY = 'linglish.last_study_media.v1';

  function readCanonicalStudyMedia() {
    try {
      const reader = window.LinglishVideoReaderState;
      if (reader && reader.currentVideo && reader.currentVideo.id != null) {
        return {
          id: String(reader.currentVideo.id),
          title: reader.currentVideo.title || reader.currentVideo.original_filename || '',
          youtube_video_id: reader.currentVideo.youtube_video_id || '',
          audioUrl: reader.currentVideo.audioUrl || '',
          transcriptUrl: reader.currentVideo.transcriptUrl || '',
          thumbnail_path: reader.currentVideo.thumbnail_path || '',
        };
      }
      if (reader && reader.selectedVideoId != null && String(reader.selectedVideoId) !== '') {
        return { id: String(reader.selectedVideoId) };
      }
    } catch (_) {}
    try {
      if (window.LinglishStudyMedia && window.LinglishStudyMedia.id) return window.LinglishStudyMedia;
    } catch (_) {}
    try {
      if (window.LinglishStudyVideoId && /^\d+$/.test(String(window.LinglishStudyVideoId))) {
        return { id: String(window.LinglishStudyVideoId) };
      }
    } catch (_) {}
    try {
      const raw = localStorage.getItem(LAST_STUDY_MEDIA_KEY);
      const data = raw ? JSON.parse(raw) : null;
      if (data && data.id != null) return data;
    } catch (_) {}
    const fromUrl = params.get('videoId') || '';
    if (fromUrl) return { id: String(fromUrl), youtube_video_id: params.get('yt') || '' };
    return null;
  }

  function numericVideoId() {
    const media = readCanonicalStudyMedia();
    if (media && /^\d+$/.test(String(media.id || ''))) return String(media.id);
    return '';
  }

  function studyContentId() {
    const media = readCanonicalStudyMedia();
    return media && media.id != null ? String(media.id) : '';
  }

  function hasSelectedStudyContent() {
    const media = readCanonicalStudyMedia();
    if (!media) return false;
    if (media.id != null && String(media.id) !== '') return true;
    return Boolean(media.audioUrl || media.youtube_video_id);
  }

  function openVideoLearningPicker(libSrc) {
    ensureStudyModeApi();
    markCurrent('video');
    if (typeof window.switchVideoStudyMode === 'function') {
      window.switchVideoStudyMode('video');
    }
    showVideoLearning();
    const src = libSrc || 'videos';
    if (mobileSurface && typeof window.openMobileVideoLibrary === 'function') {
      window.openMobileVideoLibrary(src);
      return;
    }
    if (typeof window.openVideoBrowser === 'function') {
      window.openVideoBrowser(src);
    }
  }

  window.LinglishStudySelection = {
    read: readCanonicalStudyMedia,
    contentId: studyContentId,
    hasContent: hasSelectedStudyContent,
    openPicker: openVideoLearningPicker,
  };

  function closeStudyLibraryIfOpen() {
    try {
      if (typeof window.closeMobileVideoLibrary === 'function') window.closeMobileVideoLibrary();
    } catch (_) {}
    try {
      if (typeof window.closeVideoBrowser === 'function') window.closeVideoBrowser();
    } catch (_) {}
  }

  function videoPageHref(videoId) {
    const page = mobileSurface ? './video-reader.html' : './video-reader-desktop.html';
    const next = new URLSearchParams();
    const id = videoId || studyContentId();
    if (id) next.set('videoId', id);
    try {
      const media = window.LinglishStudyMedia;
      if (media && media.youtube_video_id) next.set('yt', String(media.youtube_video_id));
    } catch (_) {}
    return page + (next.toString() ? '?' + next.toString() : '');
  }

  function practicePage(mode) {
    return mobileSurface ? './practice-session.html' : './practice-session-desktop.html';
  }

  function showVideoLearning() {
    try {
      const url = new URL(window.location.href);
      if (url.hash) {
        url.hash = '';
        history.replaceState({}, '', url.pathname + url.search);
      }
    } catch (_) {}
    if (typeof window.setHashView === 'function') window.setHashView('');
    if (!hasSelectedStudyContent() && typeof window.resumeLastStudyVideo === 'function') {
      window.resumeLastStudyVideo();
    }
  }

  function practiceHref(mode) {
    const canonical = readCanonicalStudyMedia();
    const videoId = numericVideoId();
    let media = canonical;
    const page = practicePage(mode);
    if (videoId) {
      return page + '?mode=' + mode + '&videoId=' + encodeURIComponent(videoId);
    }
    // Channel YouTube / podcast stubs — carry 视频学习 snapshot into practice desk.
    const anyId = studyContentId();
    if ((!media || !(media.audioUrl || media.youtube_video_id || media.videoUrl || media.url)) && anyId) {
      const yt = (String(anyId).match(/^yt:([A-Za-z0-9_-]{6,})$/) || [])[1]
        || (canonical && canonical.youtube_video_id)
        || (params.get('yt') || '');
      const current = window.LinglishVideoReaderState && window.LinglishVideoReaderState.currentVideo;
      if (yt || (current && (current.youtube_video_id || current.audioUrl)) || (canonical && (canonical.audioUrl || canonical.youtube_video_id))) {
        media = {
          id: String(anyId),
          title: (current && (current.title || current.original_filename)) || (canonical && canonical.title) || '',
          youtube_video_id: yt || (current && current.youtube_video_id) || (canonical && canonical.youtube_video_id) || '',
          audioUrl: (current && current.audioUrl) || (canonical && canonical.audioUrl) || '',
          transcriptUrl: (current && current.transcriptUrl) || (canonical && canonical.transcriptUrl) || '',
          thumbnail_path: (current && current.thumbnail_path) || (canonical && canonical.thumbnail_path) || '',
        };
      }
    }
    if (media && (media.audioUrl || media.youtube_video_id || media.videoUrl || media.url)) {
      try { sessionStorage.setItem('linglish.coach.media', JSON.stringify(media)); } catch (_) {}
      const next = new URLSearchParams({ source: 'external', mode: mode });
      if (media.id) next.set('videoId', String(media.id));
      if (media.youtube_video_id) next.set('yt', String(media.youtube_video_id));
      return page + '?' + next.toString();
    }
    return page + '?mode=' + mode;
  }

  function applyPracticeMode(mode) {
    window.switchPracticeMode(mode);
  }

  function studyPickHref(target) {
    // Same content across modes: keep videoId / external media; never force a re-pick.
    const id = studyContentId();
    if (target === 'video') return videoPageHref(id);
    // Mobile AI陪练 / 实战场: stay on video-reader so player size + Hold / 字幕操作
    // match 视频学习. Desktop still uses practice desk (角色对话 / 跟读台).
    if (mobileSurface && (target === 'coach' || target === 'arena')) {
      const page = './video-reader.html';
      const next = new URLSearchParams();
      next.set('study', target);
      if (id) next.set('videoId', id);
      try {
        const media = window.LinglishStudyMedia;
        if (media && media.youtube_video_id) next.set('yt', String(media.youtube_video_id));
      } catch (_) {}
      return page + '?' + next.toString();
    }
    if (!mobileSurface) {
      return practiceHref(target === 'arena' ? 'dialogue' : 'shadowing');
    }
    return practiceHref(target === 'arena' ? 'dialogue' : 'shadowing');
  }

  function goPracticeDesk(target) {
    syncStudyMediaFromReader();
    const mode = target === 'arena' ? 'dialogue' : 'shadowing';
    window.location.href = practiceHref(mode);
  }

  function ensureStudyModeApi() {
    if (typeof window.switchVideoStudyMode === 'function') return;
    window.switchVideoStudyMode = function switchVideoStudyMode(target, options) {
      const mode = target === 'coach' || target === 'arena' ? target : 'video';
      document.body.dataset.studyMode = mode;
      document.body.classList.toggle('study-mode-coach', mode === 'coach');
      document.body.classList.toggle('study-mode-arena', mode === 'arena');
      if (!options || options.history !== 'skip') {
        try {
          const url = new URL(window.location.href);
          if (mode === 'video') url.searchParams.delete('study');
          else url.searchParams.set('study', mode);
          history.replaceState({}, '', url);
        } catch (_) {}
      }
      markCurrent(mode);
    };
  }

  function syncStudyMediaFromReader() {
    try {
      const current = window.LinglishVideoReaderState && window.LinglishVideoReaderState.currentVideo;
      if (!current || current.id == null) return;
      if (/^\d+$/.test(String(current.id))) {
        window.LinglishStudyVideoId = String(current.id);
        return;
      }
      window.LinglishStudyMedia = {
        id: String(current.id),
        title: current.title || current.original_filename || '',
        youtube_video_id: current.youtube_video_id || '',
        audioUrl: current.audioUrl || '',
        transcriptUrl: current.transcriptUrl || '',
        external_podcast: Boolean(current.external_podcast),
        external_youtube: Boolean(current.external_youtube || current.youtube_video_id),
        thumbnail_path: current.thumbnail_path || '',
        collection_name: current.collection_name || '',
      };
    } catch (_) {}
  }

  function enterStudyMode(target) {
    const mode = target === 'arena' ? 'arena' : 'coach';
    syncStudyMediaFromReader();
    ensureStudyModeApi();
    // 没有片源：先回视频学习选内容，再进 AI陪练 / 实战场
    if (!hasSelectedStudyContent()) {
      openVideoLearningPicker('videos');
      return;
    }
    markCurrent(mode);
    window.switchVideoStudyMode(mode);
    try {
      if (window.LinglishArenaDialogue && typeof window.LinglishArenaDialogue.sync === 'function') {
        window.LinglishArenaDialogue.sync();
      }
    } catch (_) {}
    closeStudyLibraryIfOpen();
  }

  function refreshStudyHrefs() {
    syncStudyMediaFromReader();
    root.querySelectorAll('[data-study]').forEach((link) => {
      link.setAttribute('href', studyPickHref(link.dataset.study));
    });
  }

  // Keep menu hrefs in sync for long-press / open-in-new-tab.
  refreshStudyHrefs();
  if (trigger) {
    trigger.addEventListener('click', refreshStudyHrefs);
  }

  window.addEventListener('popstate', function () {
    if (onPractice && typeof window.switchPracticeMode === 'function') {
      const mode = new URLSearchParams(window.location.search).get('mode') === 'dialogue' ? 'dialogue' : 'shadowing';
      window.switchPracticeMode(mode, { history: 'skip' });
      return;
    }
    if (onVideoReader && typeof window.switchVideoStudyMode === 'function') {
      const next = new URLSearchParams(window.location.search).get('study');
      window.switchVideoStudyMode(next === 'coach' || next === 'arena' ? next : 'video', { history: 'skip' });
    }
  });

  if (onVideoReader && typeof window.switchVideoStudyMode === 'function' && (current === 'coach' || current === 'arena')) {
    window.switchVideoStudyMode(current, { history: 'skip' });
  }

  root.addEventListener('click', (event) => {
    const link = event.target.closest('[data-study]');
    if (!link) return;
    if (link.getAttribute('aria-current') === 'page') {
      event.preventDefault();
      setMenuOpen(false);
      if (onVideoReader && link.dataset.study === 'video') showVideoLearning();
      return;
    }
    event.preventDefault();
    const target = link.dataset.study;
    setMenuOpen(false);

    if (target === 'video') {
      if (onVideoReader) {
        markCurrent('video');
        showVideoLearning();
        if (typeof window.switchVideoStudyMode === 'function') window.switchVideoStudyMode('video');
        // Keep current content; only open library when nothing is selected yet.
        if (!hasSelectedStudyContent()) {
          if (mobileSurface && typeof window.openMobileVideoLibrary === 'function') {
            window.openMobileVideoLibrary('videos');
          } else if (typeof window.openVideoBrowser === 'function') {
            window.openVideoBrowser('videos');
          }
        } else {
          closeStudyLibraryIfOpen();
        }
        return;
      }
      window.location.href = videoPageHref(studyContentId());
      return;
    }

    // AI陪练 / 实战场
    if (onPractice && typeof window.switchPracticeMode === 'function') {
      const mode = target === 'arena' ? 'dialogue' : 'shadowing';
      markCurrent(target);
      applyPracticeMode(mode);
      return;
    }

    if (onVideoReader) {
      // Mobile AI陪练 / 实战场: same-page player + Hold / 字幕, same as 视频学习.
      if (mobileSurface && (target === 'coach' || target === 'arena')) {
        enterStudyMode(target);
        return;
      }
      goPracticeDesk(target);
      return;
    }

    window.location.href = studyPickHref(target);
  });

  document.addEventListener('click', (event) => {
    const link = event.target.closest('a[href]');
    if (!link || link.closest('#study-switch') || link.dataset.study) return;
    const href = link.getAttribute('href') || '';
    if (!/video-reader(?:-desktop)?\.html/.test(href)) return;
    const id = studyContentId();
    if (!id) return;
    let url;
    try { url = new URL(href, window.location.href); } catch (_) { return; }
    if (url.searchParams.get('videoId') || url.searchParams.get('returnTo') === 'coach') return;
    event.preventDefault();
    url.searchParams.set('videoId', id);
    window.location.href = url.pathname + url.search + url.hash;
  });
})();
