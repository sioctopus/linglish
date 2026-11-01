/* global chrome */

(function linglishSiteBridge() {
  const TOKEN_KEYS = ['authToken', 'linglish_token'];
  const EMAIL_KEYS = ['userEmail'];

  function readStorage(store, keys) {
    try {
      for (const key of keys) {
        const value = store.getItem(key);
        if (value && String(value).trim()) return String(value).trim();
      }
    } catch (_) {
      /* ignore */
    }
    return '';
  }

  function readSession() {
    const token =
      readStorage(localStorage, TOKEN_KEYS) ||
      readStorage(sessionStorage, TOKEN_KEYS);
    const email =
      readStorage(localStorage, EMAIL_KEYS) ||
      readStorage(sessionStorage, EMAIL_KEYS);
    return { token, email };
  }

  function pushSession(session) {
    try {
      chrome.runtime.sendMessage(
        session.token
          ? { type: 'SET_SESSION', token: session.token, email: session.email || '' }
          : { type: 'CLEAR_SESSION' },
        (response) => {
          if (!chrome.runtime.lastError && response && response.ok) {
            document.documentElement.dataset.linglishExtensionBridge = session.token ? '1' : '0';
          }
        }
      );
    } catch (_) {
      /* extension context invalidated */
    }
  }

  function syncNow() {
    pushSession(readSession());
  }

  syncNow();
  setInterval(syncNow, 5000);

  window.addEventListener('storage', (event) => {
    if (!event) return;
    if (TOKEN_KEYS.includes(event.key) || EMAIL_KEYS.includes(event.key)) {
      syncNow();
    }
  });

})();
