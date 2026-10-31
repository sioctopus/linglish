(function (global) {
  const STORAGE_KEY = 'linglish-workbench-import';
  const MAX_AGE_MS = 10 * 60 * 1000;
  const EMPTY_HINTS = /选择视频|暂无字幕|先自己说|请从视频|加载中|暂无/;

  const SOURCE_BACK = {
    'daily-speaking': './daily-speaking.html',
    'practice-session': './practice-session-desktop.html',
    'video-reader': './video-reader-desktop.html',
  };

  function writeStore(payload) {
    try {
      global.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
      return true;
    } catch (_) {
      return false;
    }
  }

  function readStore() {
    const keys = ['sessionStorage'];
    for (const name of keys) {
      try {
        const raw = global[name].getItem(STORAGE_KEY);
        if (!raw) continue;
        const data = JSON.parse(raw);
        if (!data || typeof data !== 'object') continue;
        const age = Date.now() - Number(data.ts || 0);
        if (Number.isFinite(age) && age >= 0 && age <= MAX_AGE_MS) return { data, store: name };
      } catch (_) {}
    }
    return null;
  }

  function clearStore() {
    try { global.sessionStorage.removeItem(STORAGE_KEY); } catch (_) {}
    try { global.localStorage.removeItem(STORAGE_KEY); } catch (_) {}
  }

  function openIntensiveNote(options = {}) {
    const text = String(options.text || '').replace(/\s+/g, ' ').trim();
    if (!text || text.length < 2 || EMPTY_HINTS.test(text)) {
      if (typeof options.onEmpty === 'function') options.onEmpty();
      else if (typeof global.alert === 'function') global.alert('请先选中一句英文。');
      return false;
    }

    const payload = {
      text,
      title: String(options.title || '').trim().slice(0, 200),
      template: options.template || 'intensive-note',
      orient: options.orient || 'story',
      annotate: options.annotate !== false,
      source: options.source || '',
      ts: Date.now(),
    };

    if (!writeStore(payload)) {
      if (typeof global.alert === 'function') global.alert('暂时无法保存选中的内容，请允许浏览器存储后重试。');
      return false;
    }

    const query = new URLSearchParams({ import: '1' });
    if (payload.orient) query.set('orient', payload.orient);
    if (payload.template) query.set('template', payload.template);
    if (payload.source) query.set('from', payload.source);
    const url = `./workbench.html?${query.toString()}`;

    // Keep the private session payload in the same tab; noopener tabs cannot inherit it.
    global.location.assign(url);
    return true;
  }

  function consume() {
    const hit = readStore();
    if (!hit) return null;
    clearStore();
    return hit.data;
  }

  function backHrefForSource(source) {
    return SOURCE_BACK[String(source || '')] || './index-desktop.html';
  }

  global.WorkbenchImport = {
    STORAGE_KEY,
    openIntensiveNote,
    consume,
    backHrefForSource,
  };
})(window);
