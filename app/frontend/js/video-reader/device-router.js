(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.VideoReaderDeviceRouter = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function deviceInfo(input) {
    const adapt = typeof module === 'object' && module.exports
      ? require('../device-adapt')
      : (typeof globalThis !== 'undefined' ? globalThis.LxDevice : null);
    if (adapt && typeof adapt.classify === 'function') return adapt.classify(input);
    return null;
  }

  function isMobileTarget({
    userAgent = '',
    viewportWidth,
    mediaMatches = false,
    maxTouchPoints = 0,
    pointer = '',
    hover = ''
  } = {}) {
    const info = deviceInfo({ userAgent, viewportWidth, maxTouchPoints, pointer, hover });
    if (info) return info.tier === 'phone' || info.tier === 'tablet-portrait';
    const narrowViewport =
      mediaMatches === true ||
      (Number.isFinite(Number(viewportWidth)) && Number(viewportWidth) <= 768);
    return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|Silk/i.test(String(userAgent))
      || narrowViewport;
  }

  function pageName(pathname) {
    const match = String(pathname || '').match(/(?:^|\/)(video-reader(?:-desktop)?\.html)$/i);
    return match ? match[1].toLowerCase() : '';
  }

  function hasDesktopOverride(search) {
    try {
      return new URLSearchParams(String(search || '').replace(/^\?/, '')).get('desktop') === '1';
    } catch (_) {
      return /(?:^|[?&])desktop=1(?:&|$)/.test(String(search || ''));
    }
  }

  function getRedirectTarget({
    pathname = '',
    search = '',
    hash = '',
    userAgent = '',
    viewportWidth,
    mediaMatches = false,
    maxTouchPoints = 0,
    pointer = '',
    hover = ''
  } = {}) {
    const currentPage = pageName(pathname);
    if (!currentPage || hasDesktopOverride(search)) return null;

    const mobile = isMobileTarget({
      userAgent,
      viewportWidth,
      mediaMatches,
      maxTouchPoints,
      pointer,
      hover
    });
    const suffix = `${String(search || '')}${String(hash || '')}`;

    if (currentPage === 'video-reader-desktop.html' && mobile) {
      return `./video-reader.html${suffix}`;
    }

    if (currentPage === 'video-reader.html' && !mobile) {
      return `./video-reader-desktop.html${suffix}`;
    }

    return null;
  }

  function redirectIfNeeded(windowObject) {
    try {
      if (!windowObject || !windowObject.location) return null;
      const matches = (query) => (
        typeof windowObject.matchMedia === 'function'
          ? windowObject.matchMedia(query).matches
          : false
      );
      const target = getRedirectTarget({
        pathname: windowObject.location.pathname,
        search: windowObject.location.search,
        hash: windowObject.location.hash,
        userAgent: windowObject.navigator && windowObject.navigator.userAgent,
        viewportWidth: windowObject.innerWidth,
        mediaMatches: matches('(max-width: 768px)'),
        maxTouchPoints: windowObject.navigator && windowObject.navigator.maxTouchPoints,
        pointer: matches('(pointer: coarse)') ? 'coarse' : 'fine',
        hover: matches('(hover: hover)') ? 'hover' : 'none'
      });

      if (target && typeof windowObject.location.replace === 'function') {
        windowObject.location.replace(target);
      }
      return target;
    } catch (error) {
      if (windowObject && windowObject.console && typeof windowObject.console.warn === 'function') {
        windowObject.console.warn('Video reader device routing failed:', error);
      }
      return null;
    }
  }

  return {
    isMobileTarget,
    getRedirectTarget,
    redirectIfNeeded
  };
});
