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
      if (window.AuthManager && typeof window.AuthManager.clearToken === 'function') {
        // A rejected request only forgets this page's copy. It must not revoke
        // the server session, or a phone, browser, and installed client that
        // are still signed in get logged out together.
        window.AuthManager.clearToken({ skipRevoke: true, skipMediaSession: true });
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
  function requestUrl(input) {
    try {
      if (typeof input === 'string') return input;
      if (input && typeof input.url === 'string') return input.url;
    } catch (_) { }
    return '';
  }
  function isAuthPage() {
    const path = String(location.pathname || '').toLowerCase();
    return /\/(?:desktop-auth|mobile-auth|reset-password|verify-email)\.html$/.test(path);
  }
  function ignoresSessionExpiry(url) {
    return /\/auth\/(?:login|register|guest|refresh|logout|password-reset|email-verification|oauth)(?:\/|\?|$)/.test(url)
      || /\/track\/event(?:\?|$)/.test(url);
  }

  let _authHandlerTriggered = false;

  function isShellPreview() {
    try {
      return new URLSearchParams(window.location.search).get('shell_preview') === '1';
    } catch (_) {
      return false;
    }
  }

  function logoutExpired(res) {
    const msg = (res.status === 401) ? tExpired() : tBanned();
    try { alert(msg); } catch (_) { }
    clearTokens();
    try { setTimeout(() => { window.location.href = redirectPath(); }, 200); } catch (_) { }
  }

  async function recoverSession(res, input, init) {
    if (!res || (res.status !== 401 && res.status !== 403)) return null;

    // Layout preview / guest: stay on page even when APIs return 401
    if (isShellPreview()) return null;
    const isGuest = typeof window.GuestCheck !== 'undefined' && window.GuestCheck.isGuest && window.GuestCheck.isGuest();
    if (isGuest && res.status === 401) {
      return null;
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
      if (!isBanned) return null;
    }

    if (_authHandlerTriggered) return null;
    _authHandlerTriggered = true;

    if (res.status === 401 && window.AuthManager && typeof window.AuthManager.ensureSession === 'function') {
      try {
        const renewed = await window.AuthManager.ensureSession({ force: true });
        const expired = !window.AuthManager.isTokenExpired || window.AuthManager.isTokenExpired(renewed);
        if (renewed && !expired && !(init && init.__linglishAuthRetried)) {
          _authHandlerTriggered = false;
          const headers = new Headers((init && init.headers) || undefined);
          headers.set('Authorization', 'Bearer ' + renewed);
          const retryInit = Object.assign({}, init, { headers: headers, __linglishAuthRetried: true });
          return originalFetch(input, retryInit);
        }
        if (window.AuthManager.isLoggedIn && window.AuthManager.isLoggedIn()) {
          _authHandlerTriggered = false;
          return null;
        }
      } catch (_) { }
    }

    logoutExpired(res);
    return null;
  }

  async function handleAuth(res) {
    await recoverSession(res, '', null);
  }

  if (window.__auth_helper_installed__) return;
  window.__auth_helper_installed__ = true;

  const originalFetch = window.fetch ? window.fetch.bind(window) : null;
  if (!originalFetch) return;
  window.fetch = function authWrappedFetch(input, init) {
    return originalFetch(input, init).then(async (res) => {
      try {
        if (!ignoresSessionExpiry(requestUrl(input)) && !isAuthPage()) {
          const recovered = await recoverSession(res, input, init);
          if (recovered) return recovered;
        }
      } catch (_) { }
      return res;
    });
  };

  // Expose minimal API if needed elsewhere
  window.AuthUtil = { clearTokens, handleAuth, redirectPath };
})();
