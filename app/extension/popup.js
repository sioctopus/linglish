/* global chrome, LINGLISH_CONFIG */

const statusEl = document.getElementById('status');
const authBtn = document.getElementById('auth-btn');
const saveBtn = document.getElementById('save-btn');
const hintEl = document.getElementById('hint');

function paths() {
  return (LINGLISH_CONFIG && LINGLISH_CONFIG.PATHS) || {};
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

async function refreshSession() {
  const session = await send('GET_SESSION');
  const loggedIn = Boolean(session.loggedIn);
  if (loggedIn) {
    statusEl.textContent = session.email ? `已登录 · ${session.email}` : '已登录';
    authBtn.textContent = '退出扩展登录';
    authBtn.dataset.mode = 'logout';
  } else {
    statusEl.textContent = '未登录（保存视频前请先登录）';
    authBtn.textContent = '登录 Linglish';
    authBtn.dataset.mode = 'login';
  }
  return session;
}

async function detectYouTubeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url || '';
  const isYouTube = /youtube\.com\/(watch|shorts|live)/i.test(url) || /youtu\.be\//i.test(url);
  saveBtn.hidden = !isYouTube;
  if (isYouTube) {
    hintEl.textContent = '当前是 YouTube 页面，可一键存到学习库。';
  } else {
    hintEl.textContent = '在 YouTube 视频页也可点页面上的「存到 Linglish」。';
  }
  return { tab, url, isYouTube };
}

document.querySelectorAll('[data-path]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const key = btn.getAttribute('data-path');
    const map = paths();
    const path = map[key] || map.home || '/index-desktop.html';
    await send('OPEN_PATH', { path });
    window.close();
  });
});

authBtn.addEventListener('click', async () => {
  if (authBtn.dataset.mode === 'logout') {
    await send('CLEAR_SESSION');
    await refreshSession();
    return;
  }
  await send('OPEN_LOGIN');
  window.close();
});

saveBtn.addEventListener('click', async () => {
  const { url } = await detectYouTubeTab();
  saveBtn.disabled = true;
  saveBtn.textContent = '保存中…';
  const result = await send('IMPORT_YOUTUBE', { url, openLogin: true });
  if (result.needLogin) {
    window.close();
    return;
  }
  if (!result.ok) {
    statusEl.textContent = result.message || '保存失败';
    saveBtn.disabled = false;
    saveBtn.textContent = '保存当前 YouTube';
    return;
  }
  statusEl.textContent = result.alreadyExists ? '已在库中，正在打开…' : '已保存，正在打开…';
  if (result.learnUrl) {
    await send('OPEN_LEARN', { url: result.learnUrl });
  }
  window.close();
});

refreshSession();
detectYouTubeTab();
