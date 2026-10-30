/* global chrome */

(function linglishYouTubeHelper() {
  const BTN_ID = 'linglish-save-btn';
  let lastHref = '';
  let busy = false;

  function currentWatchUrl() {
    return location.href;
  }

  function isWatchPage() {
    return /[?&]v=/.test(location.search) || /\/(shorts|live)\//.test(location.pathname);
  }

  function send(type, payload = {}) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type, ...payload }, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, message: chrome.runtime.lastError.message });
          return;
        }
        resolve(response || { ok: false });
      });
    });
  }

  function ensureButton() {
    if (!isWatchPage()) {
      const existing = document.getElementById(BTN_ID);
      if (existing) existing.remove();
      return;
    }

    let btn = document.getElementById(BTN_ID);
    if (btn) return btn;

    btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.type = 'button';
    btn.className = 'linglish-yt-save';
    btn.textContent = '存到 Linglish';
    btn.addEventListener('click', onSaveClick);

    // Prefer the like/share chip row; avoid full-width wrappers that stretch the pill.
    const mount =
      document.querySelector('#top-level-buttons-computed') ||
      document.querySelector('#menu-container #top-level-buttons-computed') ||
      document.querySelector('ytd-menu-renderer #top-level-buttons-computed') ||
      document.querySelector('#actions ytd-menu-renderer') ||
      document.querySelector('#owner');
    if (mount) {
      btn.classList.remove('is-fixed');
      mount.prepend(btn);
    } else {
      btn.classList.add('is-fixed');
      document.documentElement.appendChild(btn);
    }
    return btn;
  }

  async function onSaveClick(event) {
    event.preventDefault();
    event.stopPropagation();
    if (busy) return;
    const btn = event.currentTarget;
    busy = true;
    const prev = btn.textContent;
    btn.textContent = '保存中…';
    btn.disabled = true;

    const result = await send('IMPORT_YOUTUBE', {
      url: currentWatchUrl(),
      openLogin: true,
    });

    if (result.needLogin) {
      btn.textContent = '请先登录';
      setTimeout(() => {
        btn.textContent = prev;
        btn.disabled = false;
        busy = false;
      }, 1200);
      return;
    }

    if (!result.ok) {
      btn.textContent = '保存失败';
      setTimeout(() => {
        btn.textContent = prev;
        btn.disabled = false;
        busy = false;
      }, 1600);
      return;
    }

    btn.textContent = result.alreadyExists ? '已在库中' : '已保存';
    if (result.learnUrl) {
      await send('OPEN_LEARN', { url: result.learnUrl });
    }
    setTimeout(() => {
      btn.textContent = prev;
      btn.disabled = false;
      busy = false;
    }, 1400);
  }

  function tick() {
    if (location.href !== lastHref) {
      lastHref = location.href;
      const old = document.getElementById(BTN_ID);
      if (old) old.remove();
    }
    ensureButton();
  }

  tick();
  setInterval(tick, 1200);
  document.addEventListener('yt-navigate-finish', tick);
})();
