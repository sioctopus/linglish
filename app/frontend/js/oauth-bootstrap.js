(function (global) {
  'use strict';

  const FLOW_PARAMETER = 'oauth';
  const FLOW_VALUE = 'cookie_v1';
  const cookieFlowActive = hasCookieFlowMarker();

  function hasCookieFlowMarker() {
    try {
      return new URLSearchParams(global.location.search || '').get(FLOW_PARAMETER) === FLOW_VALUE;
    } catch (_) {
      return false;
    }
  }

  function clearCookieFlowMarker() {
    try {
      const url = new URL(global.location.href);
      url.searchParams.delete(FLOW_PARAMETER);
      global.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    } catch (_) { }
  }

  function writeStorage(storage, key, value) {
    try {
      if (storage && value != null) storage.setItem(key, String(value));
    } catch (_) { }
  }

  async function persistAccountSession(payload) {
    const token = payload && (payload.access_token || payload.token);
    if (!token) throw new Error('OAUTH_SESSION_INVALID');

    if (global.AuthManager && typeof global.AuthManager.saveLogin === 'function') {
      await global.AuthManager.saveLogin(payload, true);
    } else if (global.AuthManager && typeof global.AuthManager.setToken === 'function') {
      await global.AuthManager.setToken(token, true);
    } else {
      writeStorage(global.localStorage, 'linglish_token', token);
      writeStorage(global.localStorage, 'authToken', token);
    }

    const user = payload.user || {};
    if (user.email) writeStorage(global.localStorage, 'userEmail', user.email);
    if (user.membership_type) writeStorage(global.localStorage, 'membership_type', user.membership_type);
    try {
      global.localStorage.removeItem('is_guest');
      global.localStorage.removeItem('guest_id');
      global.sessionStorage.removeItem('is_guest');
      global.sessionStorage.removeItem('guest_id');
    } catch (_) { }
    return token;
  }

  function dispatchResult(name, detail) {
    try {
      if (typeof global.CustomEvent === 'function' && global.document) {
        global.document.dispatchEvent(new global.CustomEvent(name, { detail }));
      }
    } catch (_) { }
  }

  function buildRetryUrl() {
    const current = new URL(global.location.href);
    current.searchParams.delete(FLOW_PARAMETER);
    current.hash = '';
    const params = new URLSearchParams({
      flow: FLOW_VALUE,
      redirect: `${current.pathname}${current.search}`,
    });
    if (current.pathname === '/mobile-auth.html') params.set('mobile', '1');
    return `/auth/oauth/google?${params.toString()}`;
  }

  function retryOAuth() {
    const target = buildRetryUrl();
    if (typeof global.location.assign === 'function') global.location.assign(target);
    else global.location.href = target;
  }

  async function showRetryableError() {
    if (!global.document) return;
    let terminal = global.document.getElementById('oauthErrorBanner');
    if (!terminal && !global.document.body && typeof global.document.addEventListener === 'function') {
      await new Promise(resolve => {
        global.document.addEventListener('DOMContentLoaded', resolve, { once: true });
      });
      terminal = global.document.getElementById('oauthErrorBanner');
    }
    if (!terminal && global.document.body && typeof global.document.createElement === 'function') {
      terminal = global.document.createElement('div');
      terminal.id = 'oauth-session-error';
      terminal.style.cssText = 'margin:16px;padding:12px;border:1px solid #dc2626;border-radius:8px;background:#fef2f2;color:#991b1b;';
      global.document.body.prepend(terminal);
    }
    if (!terminal || typeof global.document.createElement !== 'function') return;
    const message = global.document.createElement('span');
    message.textContent = '登录会话未完成，请重试。';
    const button = global.document.createElement('button');
    button.type = 'button';
    button.textContent = '重试 Google 登录';
    button.style.cssText = 'margin-left:12px;';
    button.addEventListener('click', retryOAuth);
    if (typeof terminal.replaceChildren === 'function') terminal.replaceChildren(message, button);
    else {
      terminal.textContent = '';
      terminal.append(message, button);
    }
    if (terminal.classList) terminal.classList.add('show');
  }

  async function exchange() {
    try {
      const response = await global.fetch('/auth/oauth/session', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Accept': 'application/json' },
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload) {
        throw new Error('OAUTH_SESSION_FAILED');
      }
      await persistAccountSession(payload);
      clearCookieFlowMarker();
      dispatchResult('linglish:oauth-session', {
        ok: true,
        is_new: payload.is_new === true,
        user_id: payload.user_id,
      });
      return payload;
    } catch (err) {
      clearCookieFlowMarker();
      const result = { error: 'OAUTH_SESSION_FAILED' };
      await showRetryableError();
      dispatchResult('linglish:oauth-session-error', result);
      return result;
    }
  }

  const api = {
    exchange,
    isCookieFlow: () => cookieFlowActive,
    retry: retryOAuth,
    ready: cookieFlowActive ? exchange() : Promise.resolve(null),
  };
  global.LinglishOAuthBootstrap = api;
})(window);
