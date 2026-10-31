/**
 * Desktop learning navigation helpers (shared shell wiring).
 * Kept small: library pills and side entries open the video browser when present.
 */
(function (root) {
  'use strict';

  function bindOpen(id, view) {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('click', (event) => {
      event.preventDefault();
      if (typeof root.openVideoBrowser === 'function') {
        if (view && root.vbState) root.vbState.libraryView = view;
        root.openVideoBrowser();
        return;
      }
      if (view === 'channels' && typeof root.openChannelBrowser === 'function') {
        root.openChannelBrowser();
        return;
      }
      if (view === 'podcasts' && typeof root.openPodcastBrowser === 'function') {
        root.openPodcastBrowser();
      }
    });
  }

  function boot() {
    bindOpen('open-video-browser', 'videos');
    bindOpen('open-channel-browser', 'channels');
    bindOpen('open-podcast-browser', 'podcasts');
    bindOpen('lx-side-open-videos', 'videos');
    bindOpen('lx-side-open-channels', 'channels');
    bindOpen('lx-side-open-podcasts', 'podcasts');
    bindOpen('lx-bottom-library', 'videos');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(typeof window !== 'undefined' ? window : this);
