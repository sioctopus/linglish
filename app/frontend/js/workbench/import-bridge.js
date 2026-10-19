(function (global) {
  const STORAGE_KEY = 'linglish-workbench-import';
  const EMPTY_HINTS = /选择视频|暂无字幕|先自己说|请从视频|加载中|暂无/;

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

    try {
      global.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch (_) {
      if (typeof global.alert === 'function') global.alert('暂时无法保存选中的内容，请允许浏览器存储后重试。');
      return false;
      /* ignore quota */
    }

    const query = new URLSearchParams({ import: '1' });
    if (payload.orient) query.set('orient', payload.orient);
    if (payload.template) query.set('template', payload.template);
    if (payload.source) query.set('from', payload.source);
    const url = `./workbench.html?${query.toString()}`;

    global.location.assign(url);
    return true;
  }

  function consume() {
    try {
      const raw = global.sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      global.sessionStorage.removeItem(STORAGE_KEY);
      const data = JSON.parse(raw);
      if (!data || typeof data !== 'object') return null;
      return data;
    } catch (_) {
      return null;
    }
  }

  global.WorkbenchImport = {
    STORAGE_KEY,
    openIntensiveNote,
    consume,
  };
})(window);
