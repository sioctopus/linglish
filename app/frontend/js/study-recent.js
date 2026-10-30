(function (root) {
  'use strict';

  const KEY = 'linglish.study.recent.v1';
  const LIMIT = 40;
  const PREVIEW_COUNT = 3;

  function read() {
    try {
      const raw = root.localStorage.getItem(KEY);
      const list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list.filter((item) => item && item.id != null) : [];
    } catch (_) {
      return [];
    }
  }

  function write(list) {
    try {
      root.localStorage.setItem(KEY, JSON.stringify(list.slice(0, LIMIT)));
    } catch (_) {}
  }

  function list() {
    return read().sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
  }

  function get(id) {
    return list().find((item) => String(item.id) === String(id)) || null;
  }

  function latest() {
    return list()[0] || null;
  }

  function record(entry) {
    if (!entry || entry.id == null || entry.id === '') return null;
    const id = String(entry.id);
    const now = Date.now();
    const prev = get(id) || {};
    const next = {
      id,
      title: String(entry.title || prev.title || ('视频 ' + id)),
      thumb: entry.thumb || prev.thumb || '',
      seconds: Number.isFinite(Number(entry.seconds)) ? Math.max(0, Math.round(Number(entry.seconds))) : Number(prev.seconds || 0),
      percent: Number.isFinite(Number(entry.percent)) ? Math.max(0, Math.min(100, Math.round(Number(entry.percent)))) : Number(prev.percent || 0),
      // Keep playable pointers so history can reopen yt: / pod: without re-picking.
      audioUrl: entry.audioUrl || prev.audioUrl || '',
      transcriptUrl: entry.transcriptUrl || prev.transcriptUrl || '',
      youtube_video_id: entry.youtube_video_id || prev.youtube_video_id || '',
      showTitle: entry.showTitle || prev.showTitle || '',
      updatedAt: now,
    };
    if (String(next.thumb).indexOf('data:') === 0) next.thumb = prev.thumb && String(prev.thumb).indexOf('data:') !== 0 ? prev.thumb : '';
    const rest = read().filter((item) => String(item.id) !== id);
    rest.unshift(next);
    write(rest);
    return next;
  }

  function touch(id, patch) {
    const prev = get(id);
    if (!prev) return null;
    return record(Object.assign({}, prev, patch || {}, { id: prev.id, title: prev.title, thumb: prev.thumb }));
  }

  function clock(seconds) {
    const total = Math.max(0, Math.round(Number(seconds) || 0));
    const min = Math.floor(total / 60);
    const sec = String(total % 60).padStart(2, '0');
    return min + ':' + sec;
  }

  function escapeHtml(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function progressLabel(item) {
    const progress = Number(item.percent) > 0
      ? (Number(item.percent) >= 90 ? '已学完' : ('已学 ' + item.percent + '%'))
      : '刚打开';
    const where = Number(item.seconds) > 1 ? (' · ' + clock(item.seconds)) : '';
    return progress + where + ' · 接着学';
  }

  function itemButtonHtml(item) {
    const thumb = item.thumb
      ? '<img class="study-recent-thumb" alt="" src="' + escapeHtml(item.thumb) + '">'
      : '<span class="study-recent-thumb"></span>';
    return '<button type="button" class="study-recent-item" data-recent-id="' + escapeHtml(item.id) + '">'
      + thumb
      + '<span class="study-recent-copy"><span class="study-recent-title">' + escapeHtml(item.title) + '</span>'
      + '<span class="study-recent-meta">' + escapeHtml(progressLabel(item)) + '</span></span></button>';
  }

  function ensureStyle() {
    if (document.getElementById('study-recent-style')) return;
    const style = document.createElement('style');
    style.id = 'study-recent-style';
    style.textContent = [
      '.study-recent{margin:10px 0 12px;}',
      '.study-recent-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin:0 0 6px;font-size:12px;font-weight:800;color:#64748b;}',
      '.study-recent-head span:last-child{font-weight:600;}',
      '.study-recent-item{display:flex;align-items:center;gap:8px;width:100%;margin:0 0 6px;padding:8px;border:1px solid #e2e8f0;border-radius:12px;background:#fff;text-align:left;cursor:pointer;}',
      '.study-recent-item:hover{border-color:#99f6e4;background:#f0fdfa;}',
      '.study-recent-thumb{width:72px;height:40px;flex:0 0 auto;border-radius:8px;object-fit:cover;background:#0f172a;}',
      '.study-recent-copy{min-width:0;}',
      '.study-recent-title{font-size:13px;line-height:1.35;font-weight:750;color:#0f172a;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}',
      '.study-recent-meta{margin-top:2px;font-size:11px;font-weight:700;color:#0f766e;}',
      '.study-recent-more{display:flex;align-items:center;justify-content:center;width:100%;min-height:40px;margin:2px 0 0;padding:0 12px;border:1px dashed #cbd5e1;border-radius:12px;background:#f8fafc;color:#0f766e;font:inherit;font-size:13px;font-weight:750;cursor:pointer;}',
      '.study-recent-more:hover,.study-recent-more:active{border-color:#99f6e4;background:#f0fdfa;}',
      '.study-recent-sheet{position:fixed;inset:0;z-index:2400;display:flex;align-items:flex-end;justify-content:center;}',
      '.study-recent-sheet[hidden]{display:none!important;}',
      '.study-recent-sheet-backdrop{position:absolute;inset:0;border:0;background:rgba(15,23,42,.42);cursor:pointer;}',
      '.study-recent-sheet-panel{position:relative;z-index:1;display:flex;flex-direction:column;width:min(100%,440px);max-height:min(78vh,640px);margin:0;padding:14px 14px calc(14px + env(safe-area-inset-bottom,0px));border-radius:18px 18px 0 0;background:#fff;box-shadow:0 -12px 36px rgba(15,23,42,.18);}',
      '.study-recent-sheet-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:0 0 10px;}',
      '.study-recent-sheet-title{margin:0;color:#0f172a;font-size:16px;font-weight:800;}',
      '.study-recent-sheet-close{min-width:40px;min-height:36px;border:0;border-radius:10px;background:#f1f5f9;color:#475569;font:inherit;font-size:13px;font-weight:700;cursor:pointer;}',
      '.study-recent-sheet-hint{margin:0 0 10px;color:#64748b;font-size:12px;font-weight:600;}',
      '.study-recent-sheet-list{flex:1 1 auto;min-height:0;overflow:auto;-webkit-overflow-scrolling:touch;}',
      '.study-recent-sheet-empty{padding:28px 8px;color:#94a3b8;font-size:14px;text-align:center;}',
      '.study-recent--modal [data-study-recent-list]{display:flex;gap:8px;overflow:auto;padding-bottom:4px;}',
      '.study-recent--modal .study-recent-item{min-width:240px;width:240px;margin:0;}',
      '.study-recent--modal .study-recent-more{min-width:96px;width:auto;flex:0 0 auto;margin:0;}',
      '[data-theme="dark"] .study-recent-item{background:#111827;border-color:#334155;}',
      '[data-theme="dark"] .study-recent-title{color:#e2e8f0;}',
      '[data-theme="dark"] .study-recent-head{color:#94a3b8;}',
      '[data-theme="dark"] .study-recent-more{background:#0f172a;border-color:#334155;color:#5eead4;}',
      '[data-theme="dark"] .study-recent-sheet-panel{background:#0f172a;}',
      '[data-theme="dark"] .study-recent-sheet-title{color:#e2e8f0;}',
      '[data-theme="dark"] .study-recent-sheet-close{background:#1e293b;color:#cbd5e1;}',
    ].join('');
    document.head.appendChild(style);
  }

  function closeHistorySheet() {
    const sheet = document.getElementById('study-recent-history-sheet');
    if (sheet) sheet.hidden = true;
  }

  function openHistorySheet(onPick) {
    ensureStyle();
    let sheet = document.getElementById('study-recent-history-sheet');
    if (!sheet) {
      sheet = document.createElement('div');
      sheet.id = 'study-recent-history-sheet';
      sheet.className = 'study-recent-sheet';
      sheet.hidden = true;
      sheet.innerHTML = ''
        + '<button type="button" class="study-recent-sheet-backdrop" data-recent-close aria-label="关闭"></button>'
        + '<div class="study-recent-sheet-panel" role="dialog" aria-label="学习历史">'
        + '<div class="study-recent-sheet-head">'
        + '<h3 class="study-recent-sheet-title">学习历史</h3>'
        + '<button type="button" class="study-recent-sheet-close" data-recent-close>关闭</button>'
        + '</div>'
        + '<p class="study-recent-sheet-hint">按最近学习记录选择，点一条接着学</p>'
        + '<div class="study-recent-sheet-list" data-recent-history-list></div>'
        + '</div>';
      document.body.appendChild(sheet);
      sheet.addEventListener('click', (event) => {
        if (event.target.closest('[data-recent-close]')) {
          closeHistorySheet();
          return;
        }
        const button = event.target.closest('[data-recent-id]');
        if (!button) return;
        const entry = get(button.getAttribute('data-recent-id'));
        if (!entry) return;
        closeHistorySheet();
        if (typeof sheet._onPick === 'function') sheet._onPick(entry);
      });
    }
    sheet._onPick = onPick;
    const box = sheet.querySelector('[data-recent-history-list]');
    const items = list();
    if (!box) return;
    if (!items.length) {
      box.innerHTML = '<div class="study-recent-sheet-empty">还没有学习记录</div>';
    } else {
      box.innerHTML = items.map(itemButtonHtml).join('');
    }
    sheet.hidden = false;
  }

  function render(host, onPick, options) {
    if (!host) return;
    ensureStyle();
    const previewCount = Math.max(1, Number((options && options.previewCount) || PREVIEW_COUNT));
    const all = list();
    const items = all.slice(0, previewCount);
    if (!items.length) {
      host.hidden = true;
      return;
    }
    host.hidden = false;
    const box = host.querySelector('[data-study-recent-list]') || host;
    const showMore = all.length > previewCount;
    box.innerHTML = items.map(itemButtonHtml).join('')
      + (showMore
        ? '<button type="button" class="study-recent-more" data-recent-more>更多历史 · ' + all.length + '</button>'
        : '');

    if (box.dataset.recentWired === '1') return;
    box.dataset.recentWired = '1';
    box.addEventListener('click', (event) => {
      const moreBtn = event.target.closest('[data-recent-more]');
      if (moreBtn) {
        event.preventDefault();
        openHistorySheet(onPick);
        return;
      }
      const button = event.target.closest('[data-recent-id]');
      if (!button || typeof onPick !== 'function') return;
      const entry = get(button.getAttribute('data-recent-id'));
      if (entry) onPick(entry);
    });
  }

  root.LinglishStudyRecent = {
    list,
    get,
    latest,
    record,
    touch,
    render,
    openHistorySheet,
    closeHistorySheet,
    PREVIEW_COUNT,
  };
})(typeof window !== 'undefined' ? window : globalThis);
