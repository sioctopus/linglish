/* global chrome, importScripts */
importScripts('config.js');

const MENU_SAVE_ID = 'linglish-save-youtube';
const STORAGE_KEYS = {
  token: 'authToken',
  email: 'userEmail',
};

// Content scripts only use messages; account credentials stay in trusted contexts.
chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });

function origin() {
  return (globalThis.LINGLISH_CONFIG && globalThis.LINGLISH_CONFIG.ORIGIN) || 'http://localhost:4000';
}

function paths() {
  return (globalThis.LINGLISH_CONFIG && globalThis.LINGLISH_CONFIG.PATHS) || {};
}

function siteUrl(pathnameAndQuery) {
  const base = origin().replace(/\/$/, '');
  const path = String(pathnameAndQuery || '/').startsWith('/')
    ? pathnameAndQuery
    : `/${pathnameAndQuery}`;
  return `${base}${path}`;
}

function isSiteSender(sender) {
  try {
    return new URL(sender.url || '').origin === new URL(origin()).origin;
  } catch (_) {
    return false;
  }
}

function isExtensionPage(sender) {
  return sender.id === chrome.runtime.id
    && String(sender.url || '').startsWith(`chrome-extension://${chrome.runtime.id}/`)
    && !sender.tab;
}

function isYouTubeSender(sender) {
  try {
    const url = new URL(sender.url || '');
    return sender.id === chrome.runtime.id && url.protocol === 'https:'
      && ['www.youtube.com', 'youtube.com', 'm.youtube.com'].includes(url.hostname);
  } catch (_) {
    return false;
  }
}

function safeLearnUrl(raw) {
  const url = new URL(String(raw || ''), origin());
  if (url.origin !== new URL(origin()).origin || url.username || url.password) {
    throw new Error('Invalid learning URL');
  }
  return url.toString();
}

function extractYouTubeId(url) {
  try {
    const u = new URL(String(url || ''));
    if (!/(^|\.)youtube\.com$/i.test(u.hostname) && !/^youtu\.be$/i.test(u.hostname)) {
      return '';
    }
    if (/^youtu\.be$/i.test(u.hostname)) {
      return (u.pathname.split('/').filter(Boolean)[0] || '').trim();
    }
    const v = u.searchParams.get('v');
    if (v) return v.trim();
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts[0] === 'shorts' || parts[0] === 'embed' || parts[0] === 'live') {
      return (parts[1] || '').trim();
    }
  } catch (_) {
    /* ignore */
  }
  return '';
}

function youtubeWatchUrl(videoId) {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
}

async function getSession() {
  const data = await chrome.storage.local.get([STORAGE_KEYS.token, STORAGE_KEYS.email]);
  return {
    token: data[STORAGE_KEYS.token] || '',
    email: data[STORAGE_KEYS.email] || '',
  };
}

async function setSession({ token, email }) {
  const next = {};
  if (token) next[STORAGE_KEYS.token] = String(token);
  if (email != null) next[STORAGE_KEYS.email] = String(email || '');
  await chrome.storage.local.set(next);
}

async function clearSession() {
  await chrome.storage.local.remove([STORAGE_KEYS.token, STORAGE_KEYS.email]);
}

async function openPath(pathnameAndQuery) {
  await chrome.tabs.create({ url: siteUrl(pathnameAndQuery) });
}

async function openLogin() {
  const next = encodeURIComponent(paths().bridge || '/extension-bridge.html');
  await openPath(`${paths().auth || '/desktop-auth.html'}?next=${next}`);
}

async function importYouTube(url) {
  const videoId = extractYouTubeId(url);
  if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return { ok: false, status: 400, message: 'Not a YouTube watch URL' };
  }

  const { token } = await getSession();
  if (!token) {
    return { ok: false, status: 401, message: 'NOT_LOGGED_IN', needLogin: true };
  }

  const watchUrl = youtubeWatchUrl(videoId);
  let response;
  try {
    response = await fetch(siteUrl('/youtube/import'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        url: watchUrl,
        language: 'en',
        mode: 'permanent',
      }),
    });
  } catch (err) {
    return { ok: false, status: 0, message: err?.message || 'NETWORK_ERROR' };
  }

  const body = await response.json().catch(() => ({}));
  if (response.status === 401) {
    await clearSession();
    return { ok: false, status: 401, message: body.message || 'UNAUTHORIZED', needLogin: true };
  }
  if (!response.ok) {
    return { ok: false, status: response.status, message: body.message || 'Import failed' };
  }

  const resourceId = body?.video?.id;
  const learnPath = resourceId
    ? `${paths().video || '/video-reader-desktop.html'}?videoId=${encodeURIComponent(resourceId)}`
    : (paths().video || '/video-reader-desktop.html');

  return {
    ok: true,
    status: response.status,
    alreadyExists: Boolean(body.alreadyExists),
    videoId: resourceId,
    youtubeVideoId: videoId,
    learnUrl: siteUrl(learnPath),
    message: body.message || 'Saved',
  };
}

function ensureContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_SAVE_ID,
      title: '存到 Linglish',
      contexts: ['page', 'link', 'video'],
      documentUrlPatterns: [
        'https://www.youtube.com/*',
        'https://youtube.com/*',
        'https://m.youtube.com/*',
      ],
    });
  });
}

chrome.runtime.onInstalled.addListener(() => {
  ensureContextMenus();
});

chrome.runtime.onStartup.addListener(() => {
  ensureContextMenus();
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_SAVE_ID) return;
  const targetUrl = info.linkUrl || info.pageUrl || tab?.url || '';
  const result = await importYouTube(targetUrl);
  if (result.needLogin) {
    await openLogin();
    return;
  }
  if (result.ok && result.learnUrl) {
    await chrome.tabs.create({ url: result.learnUrl });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const type = message && message.type;
  (async () => {
    const popup = isExtensionPage(sender);
    const site = sender.id === chrome.runtime.id && isSiteSender(sender);
    const youtube = isYouTubeSender(sender);
    const allowed = popup || (site && ['SET_SESSION', 'CLEAR_SESSION'].includes(type))
      || (youtube && ['IMPORT_YOUTUBE', 'OPEN_LEARN'].includes(type));
    if (!allowed) {
      sendResponse({ ok: false, message: 'Forbidden message' });
      return;
    }
    if (type === 'GET_SESSION') {
      const session = await getSession();
      sendResponse({ ok: true, loggedIn: Boolean(session.token), email: session.email, origin: origin() });
      return;
    }
    if (type === 'SET_SESSION') {
      await setSession({ token: message.token, email: message.email });
      sendResponse({ ok: true });
      return;
    }
    if (type === 'CLEAR_SESSION') {
      await clearSession();
      sendResponse({ ok: true });
      return;
    }
    if (type === 'OPEN_PATH') {
      await openPath(message.path || paths().home);
      sendResponse({ ok: true });
      return;
    }
    if (type === 'OPEN_LOGIN') {
      await openLogin();
      sendResponse({ ok: true });
      return;
    }
    if (type === 'OPEN_LEARN') {
      if (message.url) await chrome.tabs.create({ url: safeLearnUrl(message.url) });
      else if (message.videoId) {
        await openPath(
          `${paths().video || '/video-reader-desktop.html'}?videoId=${encodeURIComponent(message.videoId)}`
        );
      }
      sendResponse({ ok: true });
      return;
    }
    if (type === 'IMPORT_YOUTUBE') {
      const result = await importYouTube(message.url || '');
      if (result.needLogin && message.openLogin !== false) {
        await openLogin();
      }
      sendResponse(result);
      return;
    }
    sendResponse({ ok: false, message: 'Unknown message' });
  })().catch((err) => {
    sendResponse({ ok: false, message: err?.message || 'Background error' });
  });
  return true;
});

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  const type = message && message.type;
  (async () => {
    if (!isSiteSender(sender)) {
      sendResponse({ ok: false, message: 'Forbidden origin' });
      return;
    }
    if (type === 'SET_SESSION' || type === 'AUTH_TOKEN') {
      await setSession({ token: message.token, email: message.email });
      sendResponse({ ok: true });
      return;
    }
    if (type === 'CLEAR_SESSION') {
      await clearSession();
      sendResponse({ ok: true });
      return;
    }
    if (type === 'PING') {
      sendResponse({ ok: true, name: 'Linglish' });
      return;
    }
    sendResponse({ ok: false, message: 'Unknown external message' });
  })().catch((err) => {
    sendResponse({ ok: false, message: err?.message || 'Background error' });
  });
  return true;
});
