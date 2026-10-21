/* Lightweight global auth helper: intercepts fetch 401/403 and shows friendly message */
(function () {
  if (typeof window === 'undefined') return;

  function getLang() {
    try { return (window.i18n && i18n.currentLang) || (navigator.language || 'zh'); } catch (_) { return 'zh'; }
  }
  function tBanned() {
    try {
      if (window.i18n) {
        const v = i18n.t('auth.banned');
        if (v && v !== 'auth.banned') return v;
      }
    } catch (_) { }
    const l = String(getLang()).toLowerCase();
    return l.startsWith('en') ? 'Your account has been banned. Please contact support' : '账户已封禁，请联系管理员';
  }
  function tExpired() {
    try {
      if (window.i18n) {
        const v = i18n.t('upload.login_expired');
        if (v && v !== 'upload.login_expired') return v;
      }
    } catch (_) { }
    const l = String(getLang()).toLowerCase();
    return l.startsWith('en') ? 'Login expired, please log in again' : '登录已过期，请重新登录';
  }
  function clearTokens() {
    try {
      if (window.AuthManager) {
        window.AuthManager.clearToken();
      } else {
        localStorage.removeItem('linglish_token');
        sessionStorage.removeItem('linglish_token');
        localStorage.removeItem('authToken');
        sessionStorage.removeItem('authToken');
      }
    } catch (_) { }
  }
  function redirectPath() {
    try {
      if (window.AUTH_REDIRECT && typeof window.AUTH_REDIRECT === 'string') return window.AUTH_REDIRECT;
      const path = String(location.pathname || '').toLowerCase();
      const isMobilePage = path.includes('mobile-') || (path.includes('video-reader.html') && !path.includes('desktop'));
      const isSmallViewport = typeof window !== 'undefined' && window.innerWidth && window.innerWidth <= 900;
      if (isMobilePage || isSmallViewport) return './mobile-auth.html';
      return './desktop-auth.html';
    } catch (_) { return './desktop-auth.html'; }
  }

  let _authHandlerTriggered = false;

  function isSessionRequest(input) {
    try {
      const target = input && typeof input.url === 'string' ? input.url : input;
      const pathname = new URL(target, window.location.href).pathname;
      return /^\/auth\/(login|register|guest|refresh|oauth\/session)$/.test(pathname);
    } catch (_) { return false; }
  }

  async function handleAuth(res, input) {
    if (!res || (res.status !== 401 && res.status !== 403)) return;
    // Credential entry and session renewal report their own failures to the caller.
    if (res.status === 401 && isSessionRequest(input || res.url)) return;

    // Check if user is a guest - guests can stay on page even with 401
    const isGuest = typeof window.GuestCheck !== 'undefined' && window.GuestCheck.isGuest && window.GuestCheck.isGuest();

    // For guest users with 401, silently return without redirect
    if (isGuest && res.status === 401) {
      return;
    }

    // For 403, only handle if user is actually BANNED
    // Other 403 errors (permission denied, forbidden) should not trigger logout
    let isBanned = false;
    if (res.status === 403) {
      try {
        const data = await res.clone().json();
        const raw = String((data && data.message) || '').toUpperCase();
        isBanned = raw === 'BANNED';
      } catch (_) { }
      // If not banned, don't handle - let the calling code deal with the 403
      if (!isBanned) return;
    }

    // Prevent duplicate alerts when multiple requests fail simultaneously
    if (_authHandlerTriggered) return;
    _authHandlerTriggered = true;

    const msg = (res.status === 401) ? tExpired() : tBanned();
    try { alert(msg); } catch (_) { }
    clearTokens();
    try { setTimeout(() => { window.location.href = redirectPath(); }, 200); } catch (_) { }
  }

  if (window.__auth_helper_installed__) return;
  window.__auth_helper_installed__ = true;

  const originalFetch = window.fetch ? window.fetch.bind(window) : null;
  if (!originalFetch) return;
  window.fetch = function authWrappedFetch(input, init) {
    return originalFetch(input, init).then((res) => {
      try { handleAuth(res, input); } catch (_) { }
      return res;
    });
  };

  // Expose minimal API if needed elsewhere
  window.AuthUtil = { clearTokens, handleAuth, redirectPath };
})();
