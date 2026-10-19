/**
 * Linglish Workbench app — teacher / blogger content studio MVP.
 */
(function () {
  'use strict';

  const state = {
    tool: 'studio', // studio | class-note
    role: 'teacher',
    templateId: 'intensive-note',
    documentId: null,
    shareToken: null,
    practiceUrl: null,
    sourceText: '',
    annotated: null,
    styles: {
      fontFamily: 'Manrope, "PingFang SC", "Microsoft YaHei", sans-serif',
      fontSize: 18,
      textColor: '#0f172a',
      accentColor: '#0f766e',
      background: '#ffffff',
      highlightColor: '#ccfbf1',
      lineGap: 1.7,
      showPhonetic: true,
      showPos: true,
      showCefr: true,
      showGloss: true,
      orientation: 'portrait',
      themeId: 'teal-day',
      kicker: '',
      density: 'normal',
      align: 'left',
      showMeta: true,
    },
  };

  const els = {};

  function $(id) {
    return document.getElementById(id);
  }

  function normalizeOrient(value) {
    const key = String(value || '').trim().toLowerCase();
    if (key === 'landscape' || key === '16:9' || key === '16x9') return 'landscape';
    if (key === 'story' || key === '9:16' || key === '9x16' || key === 'reels') return 'story';
    return 'portrait';
  }

  function readToken() {
    const keys = ['linglish_token', 'authToken'];
    for (const key of keys) {
      try {
        const value = localStorage.getItem(key) || sessionStorage.getItem(key);
        if (value) return value;
      } catch (_) {}
    }
    return null;
  }

  function authHeaders(json = true) {
    const headers = {};
    if (json) headers['Content-Type'] = 'application/json';
    const token = readToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  }

  function setStatus(message, type = '') {
    if (!els.status) return;
    els.status.textContent = message || '';
    els.status.className = 'wb-status' + (type ? ` ${type}` : '');
  }

  function requireLogin(actionLabel) {
    if (readToken()) return true;
    setStatus(`请先登录后再${actionLabel || '继续'}。`, 'error');
    els.authBanner.hidden = false;
    return false;
  }

  function currentTemplates() {
    return window.WorkbenchTemplates.forRole(state.role);
  }

  function syncRoleUi() {
    els.roleTeacher.classList.toggle('active', state.role === 'teacher');
    els.roleBlogger.classList.toggle('active', state.role === 'blogger');
    const list = currentTemplates();
    if (!list.some((item) => item.id === state.templateId)) {
      state.templateId = list[0]?.id || 'intensive-note';
    }
    els.templateList.innerHTML = list.map((item) => `
      <button type="button" class="wb-template${item.id === state.templateId ? ' active' : ''}" data-template="${item.id}">
        <strong>${item.name}</strong>
        <span>${item.desc}</span>
      </button>`).join('');
  }

  function setTool(tool, options = {}) {
    state.tool = tool === 'class-note' ? 'class-note' : 'studio';
    const isNote = state.tool === 'class-note';
    els.toolStudio.classList.toggle('active', !isNote);
    els.toolClassNote.classList.toggle('active', isNote);
    els.toolStudio.setAttribute('aria-selected', String(!isNote));
    els.toolClassNote.setAttribute('aria-selected', String(isNote));
    els.studio.hidden = isNote;
    els.classNote.hidden = !isNote;
    els.roleSwitch.hidden = isNote;
    document.querySelectorAll('[data-studio-only]').forEach((node) => {
      node.hidden = isNote;
    });
    if (isNote) {
      if (window.WorkbenchClassNote) {
        window.WorkbenchClassNote.activate({ noteId: options.noteId || null });
      }
      if (!options.skipHistory) {
        const noteQ = options.noteId ? `&note=${encodeURIComponent(options.noteId)}` : '';
        try {
          history.replaceState({}, '', `./workbench.html?mode=class-note${noteQ}`);
        } catch (_) {}
      }
    } else {
      if (window.WorkbenchClassNote) window.WorkbenchClassNote.deactivate();
      if (!options.skipHistory) {
        try {
          const keep = state.documentId ? `?id=${encodeURIComponent(state.documentId)}` : '';
          history.replaceState({}, '', `./workbench.html${keep}`);
        } catch (_) {}
      }
    }
  }

  function applyTheme(themeId, options = {}) {
    const theme = window.WorkbenchTemplates.getStyleTheme(themeId);
    state.styles.themeId = theme.id;
    state.styles.fontFamily = theme.fontFamily;
    state.styles.textColor = theme.textColor;
    state.styles.accentColor = theme.accentColor;
    state.styles.background = theme.background;
    state.styles.highlightColor = theme.highlightColor;
    if (els.fontFamily) els.fontFamily.value = theme.fontFamily;
    if (els.textColor) els.textColor.value = theme.textColor;
    if (els.accentColor) els.accentColor.value = theme.accentColor;
    if (els.background) els.background.value = theme.background;
    if (els.highlightColor) els.highlightColor.value = theme.highlightColor;
    renderThemeList();
    if (!options.skipRender) {
      applyCanvasStyles();
      renderPreview();
    }
  }

  function renderThemeList() {
    if (!els.themeList) return;
    const activeId = state.styles.themeId || 'teal-day';
    els.themeList.innerHTML = window.WorkbenchTemplates.STYLE_THEMES.map((theme) => `
      <button type="button" class="wb-theme${theme.id === activeId ? ' active' : ''}"
        data-theme="${window.WorkbenchTemplates.escapeHtml(theme.id)}" role="option"
        aria-selected="${theme.id === activeId ? 'true' : 'false'}">
        <span class="wb-theme-name">${window.WorkbenchTemplates.escapeHtml(theme.name)}</span>
        <span class="wb-theme-desc">${window.WorkbenchTemplates.escapeHtml(theme.desc)}</span>
        <span class="wb-theme-swatches" aria-hidden="true">
          <i style="background:${theme.textColor}" title="文字"></i>
          <i style="background:${theme.accentColor}" title="强调"></i>
          <i style="background:${theme.background};box-shadow:inset 0 0 0 1px #cbd5e1" title="背景"></i>
          <i style="background:${theme.highlightColor}" title="高亮"></i>
        </span>
      </button>`).join('');
  }

  function hexToRgb(hex) {
    const raw = String(hex || '').trim();
    const match = /^#([0-9a-fA-F]{6})$/.exec(raw);
    if (!match) return { r: 15, g: 118, b: 110 };
    const n = parseInt(match[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  function rgba(hex, alpha) {
    const { r, g, b } = hexToRgb(hex);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  function isDarkBackground(hex) {
    const { r, g, b } = hexToRgb(hex);
    return (r * 299 + g * 587 + b * 114) / 1000 < 140;
  }

  function applyCanvasStyles() {
    const canvas = els.canvas;
    canvas.style.fontFamily = state.styles.fontFamily;
    canvas.style.fontSize = `${state.styles.fontSize}px`;
    canvas.style.color = state.styles.textColor;
    canvas.style.background = state.styles.background;
    canvas.style.lineHeight = String(state.styles.lineGap);
    canvas.style.setProperty('--wb-highlight', state.styles.highlightColor);
    canvas.style.setProperty('--wb-accent', state.styles.accentColor);
    // Use rgba() not color-mix() so html2canvas can export.
    canvas.style.setProperty('--wb-block-bg', rgba(state.styles.accentColor, 0.1));
    canvas.style.setProperty('--wb-block-border', rgba(state.styles.accentColor, 0.22));
    if (isDarkBackground(state.styles.background)) {
      canvas.style.setProperty('--wb-sentence-bg', 'rgba(248, 250, 252, 0.06)');
      canvas.style.setProperty('--wb-rule', 'rgba(248, 250, 252, 0.18)');
    } else {
      canvas.style.setProperty('--wb-sentence-bg', 'rgba(15, 23, 42, 0.04)');
      canvas.style.setProperty('--wb-rule', 'rgba(15, 23, 42, 0.15)');
    }
    const orient = normalizeOrient(state.styles.orientation);
    state.styles.orientation = orient;
    const density = ['compact', 'normal', 'relaxed'].includes(state.styles.density)
      ? state.styles.density
      : 'normal';
    const align = state.styles.align === 'center' ? 'center' : 'left';
    canvas.setAttribute('data-orient', orient);
    canvas.setAttribute('data-density', density);
    canvas.setAttribute('data-align', align);
    syncSegGroup(els.orient, 'data-orient', orient);
    syncSegGroup(els.density, 'data-density', density);
    syncSegGroup(els.align, 'data-align', align);
  }

  function syncSegGroup(host, attr, value) {
    if (!host) return;
    host.querySelectorAll(`[${attr}]`).forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute(attr) === value);
    });
  }

  function emptyAnnotated(text) {
    return {
      title: currentTitle() || (text ? text.slice(0, 48) : '未命名内容'),
      level: 'A2',
      sourceText: text || '',
      sentences: [],
      words: {},
      keyExpressions: [],
      vocabList: [],
      dictationList: [],
      shadowingTasks: [],
    };
  }

  function currentTitle() {
    const fromInput = String(els.titleInput?.value || '').trim();
    if (fromInput) return fromInput.slice(0, 200);
    return String(state.annotated?.title || '').trim() || '未命名内容';
  }

  function syncKickerInput() {
    if (!els.kickerInput || document.activeElement === els.kickerInput) return;
    const shown = String(state.styles.kicker || '').trim()
      || window.WorkbenchTemplates.defaultKicker(state.templateId);
    els.kickerInput.value = shown;
  }

  function readKickerFromUi() {
    const value = String(els.kickerInput?.value || '').trim().slice(0, 48);
    const fallback = window.WorkbenchTemplates.defaultKicker(state.templateId);
    state.styles.kicker = value || fallback;
  }

  function syncCanvasField(selector, text) {
    const node = els.canvas?.querySelector(selector);
    if (node) {
      node.textContent = text;
      return true;
    }
    return false;
  }

  function previewData() {
    const text = String(els.sourceText?.value ?? state.sourceText ?? '');
    const title = currentTitle();
    const trimmed = text.trim();
    if (state.annotated && String(state.annotated.sourceText || '').trim() === trimmed && trimmed) {
      return { ...state.annotated, title };
    }
    if (trimmed) {
      return window.WorkbenchTemplates.draftFromText(text, title);
    }
    return emptyAnnotated('');
  }

  function renderPreview() {
    const annotated = previewData();
    if (state.annotated && annotated.kind !== 'workbench-draft') {
      state.annotated.title = annotated.title;
    }
    if (!String(state.styles.kicker || '').trim()) {
      state.styles.kicker = window.WorkbenchTemplates.defaultKicker(state.templateId);
    }
    syncKickerInput();
    els.canvas.innerHTML = window.WorkbenchTemplates.renderTemplate(
      state.templateId,
      annotated,
      state.styles,
      { practiceUrl: state.practiceUrl }
    );
    applyCanvasStyles();
  }

  async function annotate() {
    if (!requireLogin('标注')) return;
    const text = els.sourceText.value.trim();
    if (text.length < 8) {
      setStatus('请粘贴至少一句完整英文。', 'error');
      return;
    }
    state.sourceText = text;
    els.annotateBtn.disabled = true;
    setStatus('正在拆句并标注单词…');
    try {
      const response = await fetch('/api/workbench/annotate', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ text, title: els.titleInput.value.trim() }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || '标注失败');
      state.annotated = data.annotated;
      if (!els.titleInput.value.trim()) els.titleInput.value = data.annotated.title || '';
      renderPreview();
      setStatus(`已标注 ${data.annotated.sentences.length} 句、${Object.keys(data.annotated.words || {}).length} 词。`, 'ok');
    } catch (err) {
      setStatus(err.message || '标注失败', 'error');
    } finally {
      els.annotateBtn.disabled = false;
    }
  }

  function collectPayload() {
    const title = els.titleInput.value.trim() || state.annotated?.title || '工作台内容';
    return {
      title,
      role: state.role,
      templateId: state.templateId,
      sourceText: els.sourceText.value.trim() || state.sourceText,
      annotated: state.annotated,
      styles: { ...state.styles },
    };
  }

  function setSaveButtonsDisabled(disabled) {
    [els.saveBtn, els.saveInlineBtn, els.saveListBtn].forEach((btn) => {
      if (btn) btn.disabled = disabled;
    });
  }

  async function saveDocument() {
    if (!requireLogin('保存')) return;
    const payload = collectPayload();
    if (!payload.sourceText && !payload.annotated) {
      setStatus('请先输入文本并标注。', 'error');
      return;
    }
    if (!payload.annotated) {
      await annotate();
      if (!state.annotated) return;
      payload.annotated = state.annotated;
      payload.sourceText = state.sourceText;
    }
    setSaveButtonsDisabled(true);
    setStatus('正在保存…');
    try {
      const url = state.documentId ? `/api/workbench/${state.documentId}` : '/api/workbench';
      const method = state.documentId ? 'PUT' : 'POST';
      const response = await fetch(url, {
        method,
        headers: authHeaders(),
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || '保存失败');
      state.documentId = data.document.id;
      state.shareToken = data.document.shareToken;
      state.practiceUrl = data.document.practiceUrl;
      history.replaceState({}, '', `./workbench.html?id=${encodeURIComponent(state.documentId)}`);
      setStatus('已保存。', 'ok');
      loadSavedList();
    } catch (err) {
      setStatus(err.message || '保存失败', 'error');
    } finally {
      setSaveButtonsDisabled(false);
    }
  }

  async function createPracticeLink() {
    if (!requireLogin('生成练习链接')) return;
    if (!state.documentId) {
      await saveDocument();
      if (!state.documentId) return;
    }
    els.practiceBtn.disabled = true;
    setStatus('正在生成学生练习链接…');
    try {
      const days = Number(els.expireDays.value) || null;
      const response = await fetch(`/api/workbench/${state.documentId}/practice-link`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(days ? { expiresInDays: days } : {}),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || '生成失败');
      state.practiceUrl = data.practiceUrl;
      state.shareToken = data.document?.shareToken || state.shareToken;
      renderPreview();
      const absolute = new URL(data.practiceUrl, location.href).href;
      els.linkOutput.value = absolute;
      setStatus('练习链接已生成，学生打开即可逐句跟读。', 'ok');
    } catch (err) {
      setStatus(err.message || '生成失败', 'error');
    } finally {
      els.practiceBtn.disabled = false;
    }
  }

  async function copyLink() {
    const value = els.linkOutput.value.trim();
    if (!value) {
      setStatus('请先生成练习链接。', 'error');
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
      setStatus('链接已复制。', 'ok');
    } catch (_) {
      els.linkOutput.select();
      setStatus('请手动复制链接。');
    }
  }

  async function exportLongImage() {
    if (!state.annotated && !els.sourceText.value.trim() && !els.titleInput.value.trim()) {
      setStatus('请先输入标题或英文，再导出长图。', 'error');
      return;
    }
    setStatus('正在导出长图…');
    try {
      if (typeof html2canvas !== 'function') {
        throw new Error('导出组件未加载，请刷新后重试');
      }
      applyCanvasStyles();
      const canvas = await html2canvas(els.canvas, {
        backgroundColor: state.styles.background || '#ffffff',
        scale: 2,
        useCORS: true,
      });
      const link = document.createElement('a');
      const stamp = new Date().toISOString().slice(0, 10);
      link.download = `linglish-workbench-${stamp}.png`;
      link.href = canvas.toDataURL('image/png');
      link.click();
      setStatus('长图已下载。', 'ok');
    } catch (err) {
      setStatus(err.message || '导出失败', 'error');
    }
  }

  async function exportPdf() {
    setStatus('正在准备 PDF…');
    try {
      if (typeof html2canvas !== 'function') throw new Error('导出组件未加载');
      const canvas = await html2canvas(els.canvas, {
        backgroundColor: state.styles.background || '#ffffff',
        scale: 2,
        useCORS: true,
      });
      const image = canvas.toDataURL('image/jpeg', 0.95);
      const printWindow = window.open('', '_blank');
      if (!printWindow) throw new Error('浏览器拦截了弹窗，请允许后重试');
      printWindow.document.write(`<!doctype html><title>Workbench PDF</title>
        <style>body{margin:0;text-align:center;background:#fff}img{max-width:100%;height:auto}</style>
        <img src="${image}" onload="setTimeout(function(){print()},200)">`);
      printWindow.document.close();
      setStatus('已打开打印对话框，可另存为 PDF。', 'ok');
    } catch (err) {
      setStatus(err.message || 'PDF 导出失败', 'error');
    }
  }

  async function speakWord(word) {
    if (!word) return;
    try {
      const response = await fetch('/tts/practice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: word }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.audioUrl) throw new Error(data.message || '发音失败');
      const audio = new Audio(data.audioUrl);
      await audio.play();
    } catch (err) {
      setStatus(err.message || '发音失败', 'error');
    }
  }

  function showWordPop(word, anchor) {
    const info = state.annotated?.words?.[word] || { word };
    els.wordPop.hidden = false;
    els.wordPop.innerHTML = `
      <strong>${window.WorkbenchTemplates.escapeHtml(info.word || word)}</strong>
      <div class="meta">${window.WorkbenchTemplates.escapeHtml([info.phonetic, info.cefr, info.partOfSpeech].filter(Boolean).join(' · '))}</div>
      <p>${window.WorkbenchTemplates.escapeHtml(info.zh || info.definition || '点击下方按钮听发音')}</p>
      <button type="button" class="wb-btn" data-speak="${window.WorkbenchTemplates.escapeHtml(info.word || word)}">发音</button>`;
    const rect = anchor.getBoundingClientRect();
    const top = Math.min(window.innerHeight - 160, rect.bottom + 8);
    const left = Math.min(window.innerWidth - 300, Math.max(12, rect.left));
    els.wordPop.style.top = `${top}px`;
    els.wordPop.style.left = `${left}px`;
  }

  function hideWordPop() {
    els.wordPop.hidden = true;
  }

  async function loadDocument(id) {
    if (!requireLogin('打开内容')) return;
    setStatus('正在加载…');
    try {
      const response = await fetch(`/api/workbench/${id}`, { headers: authHeaders(false) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || '加载失败');
      applyDocument(data.document);
      setStatus('已加载保存的内容。', 'ok');
    } catch (err) {
      setStatus(err.message || '加载失败', 'error');
    }
  }

  async function loadShare(token) {
    setStatus('正在打开分享内容…');
    try {
      const response = await fetch(`/api/workbench/share/${encodeURIComponent(token)}`);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || '分享不存在');
      applyDocument(data.document, { readOnly: true });
      setStatus('只读分享预览。可点击单词发音。', 'ok');
    } catch (err) {
      setStatus(err.message || '打开失败', 'error');
    }
  }

  function applyDocument(doc, options = {}) {
    state.documentId = doc.id || null;
    state.role = doc.role || 'teacher';
    state.templateId = doc.templateId || 'intensive-note';
    state.sourceText = doc.sourceText || '';
    state.annotated = doc.annotated || null;
    state.styles = { ...state.styles, ...(doc.styles || {}) };
    state.shareToken = doc.shareToken || null;
    state.practiceUrl = doc.practiceUrl || null;
    els.sourceText.value = state.sourceText;
    els.titleInput.value = doc.title || '';
    if (!String(state.styles.kicker || '').trim()) {
      state.styles.kicker = window.WorkbenchTemplates.defaultKicker(state.templateId);
    }
    syncKickerInput();
    els.fontSize.value = state.styles.fontSize;
    els.lineGap.value = state.styles.lineGap;
    els.showPhonetic.checked = !!state.styles.showPhonetic;
    els.showPos.checked = state.styles.showPos !== false;
    els.showCefr.checked = !!state.styles.showCefr;
    els.showGloss.checked = !!state.styles.showGloss;
    if (els.showMeta) els.showMeta.checked = state.styles.showMeta !== false;
    state.styles.orientation = normalizeOrient(state.styles.orientation || 'portrait');
    if (!state.styles.density) state.styles.density = 'normal';
    if (!state.styles.align) state.styles.align = 'left';
    if (state.styles.showMeta === undefined) state.styles.showMeta = true;
    if (state.styles.themeId) {
      applyTheme(state.styles.themeId, { skipRender: true });
    } else {
      els.fontFamily.value = state.styles.fontFamily;
      els.textColor.value = toColorInput(state.styles.textColor);
      els.accentColor.value = toColorInput(state.styles.accentColor);
      els.background.value = toColorInput(state.styles.background);
      els.highlightColor.value = toColorInput(state.styles.highlightColor);
      state.styles.themeId = 'teal-day';
      renderThemeList();
    }
    if (state.practiceUrl) {
      els.linkOutput.value = new URL(state.practiceUrl, location.href).href;
    }
    syncRoleUi();
    renderPreview();
    if (options.readOnly) {
      els.canvas.removeAttribute('contenteditable');
      els.sourceText.readOnly = true;
    }
  }

  function toColorInput(value) {
    const raw = String(value || '#000000').trim();
    if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw;
    return '#0f172a';
  }

  async function loadSavedList() {
    if (!readToken()) {
      els.savedList.innerHTML = '<p class="wb-hint">登录后可查看已保存内容。</p>';
      return;
    }
    try {
      const response = await fetch('/api/workbench', { headers: authHeaders(false) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || '读取失败');
      const items = data.items || [];
      if (!items.length) {
        els.savedList.innerHTML = '';
        return;
      }
      els.savedList.innerHTML = items.map((item) => `
        <div class="wb-saved-item">
          <span><strong>${window.WorkbenchTemplates.escapeHtml(item.title)}</strong><br>
          <span class="wb-hint" style="margin:0">${item.role === 'blogger' ? '博主' : '老师'} · ${window.WorkbenchTemplates.escapeHtml(item.templateId)}</span></span>
          <button type="button" data-open-id="${item.id}">打开</button>
        </div>`).join('');
    } catch (_) {
      els.savedList.innerHTML = '<p class="wb-hint">暂时读不到已保存列表。</p>';
    }
  }

  async function deleteCurrent() {
    if (!state.documentId) {
      setStatus('当前没有已保存内容。', 'error');
      return;
    }
    if (!requireLogin('删除')) return;
    if (!window.confirm('确认删除这份工作台内容？')) return;
    try {
      const response = await fetch(`/api/workbench/${state.documentId}`, {
        method: 'DELETE',
        headers: authHeaders(false),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || '删除失败');
      state.documentId = null;
      state.practiceUrl = null;
      history.replaceState({}, '', './workbench.html');
      setStatus('已删除。', 'ok');
      loadSavedList();
    } catch (err) {
      setStatus(err.message || '删除失败', 'error');
    }
  }

  function readStylesFromUi() {
    state.styles.fontSize = Number(els.fontSize.value) || 18;
    state.styles.lineGap = Number(els.lineGap.value) || 1.7;
    state.styles.showPhonetic = els.showPhonetic.checked;
    state.styles.showPos = els.showPos.checked;
    state.styles.showCefr = els.showCefr.checked;
    state.styles.showGloss = els.showGloss.checked;
    state.styles.showMeta = els.showMeta ? els.showMeta.checked : true;
    const activeOrient = els.orient?.querySelector('[data-orient].active');
    state.styles.orientation = normalizeOrient(activeOrient?.getAttribute('data-orient'));
    const activeDensity = els.density?.querySelector('[data-density].active');
    state.styles.density = activeDensity?.getAttribute('data-density') || 'normal';
    const activeAlign = els.align?.querySelector('[data-align].active');
    state.styles.align = activeAlign?.getAttribute('data-align') === 'center' ? 'center' : 'left';
    // Colors + font come from the fixed theme template.
    const theme = window.WorkbenchTemplates.getStyleTheme(state.styles.themeId || 'teal-day');
    state.styles.themeId = theme.id;
    state.styles.fontFamily = theme.fontFamily;
    state.styles.textColor = theme.textColor;
    state.styles.accentColor = theme.accentColor;
    state.styles.background = theme.background;
    state.styles.highlightColor = theme.highlightColor;
    if (!String(state.styles.kicker || '').trim()) {
      state.styles.kicker = window.WorkbenchTemplates.defaultKicker(state.templateId);
    }
  }

  function bindSegGroup(host, attr, onPick) {
    host?.addEventListener('click', (event) => {
      const btn = event.target.closest(`[${attr}]`);
      if (!btn || !host.contains(btn)) return;
      host.querySelectorAll(`[${attr}]`).forEach((item) => {
        item.classList.toggle('active', item === btn);
      });
      onPick(btn.getAttribute(attr));
    });
  }

  function bindEvents() {
    els.toolStudio.addEventListener('click', () => setTool('studio'));
    els.toolClassNote.addEventListener('click', () => setTool('class-note'));
    els.roleTeacher.addEventListener('click', () => {
      state.role = 'teacher';
      syncRoleUi();
      renderPreview();
    });
    els.roleBlogger.addEventListener('click', () => {
      state.role = 'blogger';
      syncRoleUi();
      renderPreview();
    });
    els.templateList.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-template]');
      if (!btn) return;
      const nextId = btn.getAttribute('data-template');
      const prevDefault = window.WorkbenchTemplates.defaultKicker(state.templateId);
      const current = String(state.styles.kicker || '').trim();
      state.templateId = nextId;
      if (!current || current === prevDefault) {
        state.styles.kicker = window.WorkbenchTemplates.defaultKicker(nextId);
      }
      syncRoleUi();
      renderPreview();
    });
    bindSegGroup(els.orient, 'data-orient', () => {
      readStylesFromUi();
      applyCanvasStyles();
      renderPreview();
    });
    bindSegGroup(els.density, 'data-density', () => {
      readStylesFromUi();
      applyCanvasStyles();
    });
    bindSegGroup(els.align, 'data-align', () => {
      readStylesFromUi();
      applyCanvasStyles();
    });
    els.themeList?.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-theme]');
      if (!btn) return;
      applyTheme(btn.getAttribute('data-theme'));
    });
    els.annotateBtn.addEventListener('click', annotate);
    const onSave = () => {
      saveDocument().catch(() => {});
    };
    els.saveBtn?.addEventListener('click', onSave);
    els.saveInlineBtn?.addEventListener('click', onSave);
    els.saveListBtn?.addEventListener('click', onSave);
    els.practiceBtn.addEventListener('click', createPracticeLink);
    els.copyLinkBtn.addEventListener('click', copyLink);
    els.exportPngBtn.addEventListener('click', exportLongImage);
    els.exportPdfBtn.addEventListener('click', exportPdf);
    els.deleteBtn.addEventListener('click', deleteCurrent);
    els.loginBtn?.addEventListener('click', () => {
      location.href = './desktop-auth.html?next=' + encodeURIComponent('/workbench');
    });

    ['fontSize', 'lineGap', 'showPhonetic', 'showPos', 'showCefr', 'showGloss', 'showMeta']
      .forEach((key) => {
        if (!els[key]) return;
        els[key].addEventListener('change', () => {
          readStylesFromUi();
          renderPreview();
        });
        els[key].addEventListener('input', () => {
          readStylesFromUi();
          applyCanvasStyles();
        });
      });

    els.canvas.addEventListener('click', (event) => {
      const speakBtn = event.target.closest('[data-speak]');
      if (speakBtn) {
        speakWord(speakBtn.getAttribute('data-speak'));
        return;
      }
      const wordEl = event.target.closest('.wb-word');
      if (!wordEl) {
        hideWordPop();
        return;
      }
      const word = wordEl.getAttribute('data-word');
      showWordPop(word, wordEl);
      speakWord(word);
    });

    els.wordPop.addEventListener('click', (event) => {
      const speakBtn = event.target.closest('[data-speak]');
      if (speakBtn) speakWord(speakBtn.getAttribute('data-speak'));
    });

    document.addEventListener('click', (event) => {
      if (event.target.closest('.wb-word') || event.target.closest('#wb-word-pop')) return;
      hideWordPop();
    });

    els.savedList.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-open-id]');
      if (!btn) return;
      loadDocument(btn.getAttribute('data-open-id'));
    });

    els.titleInput.addEventListener('input', () => {
      const value = currentTitle();
      if (state.annotated) state.annotated.title = value;
      if (!syncCanvasField('[data-editable="title"]', value)) renderPreview();
    });
    els.titleInput.addEventListener('change', () => {
      const value = currentTitle();
      if (state.annotated) state.annotated.title = value;
      renderPreview();
    });

    els.kickerInput?.addEventListener('input', () => {
      readKickerFromUi();
      if (!syncCanvasField('[data-editable="kicker"]', state.styles.kicker)) renderPreview();
    });
    els.kickerInput?.addEventListener('change', () => {
      readKickerFromUi();
      renderPreview();
    });

    let sourceTimer = 0;
    els.sourceText.addEventListener('input', () => {
      state.sourceText = els.sourceText.value;
      // If user edits text after AI annotate, fall back to live draft until re-annotate.
      if (state.annotated && String(state.annotated.sourceText || '').trim() !== String(els.sourceText.value || '').trim()) {
        state.annotated = null;
      }
      window.clearTimeout(sourceTimer);
      sourceTimer = window.setTimeout(() => renderPreview(), 80);
    });

    els.canvas.addEventListener('focusout', (event) => {
      const kickerEl = event.target.closest?.('[data-editable="kicker"]');
      if (kickerEl) {
        const value = String(kickerEl.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 48);
        state.styles.kicker = value || window.WorkbenchTemplates.defaultKicker(state.templateId);
        if (els.kickerInput) els.kickerInput.value = state.styles.kicker;
        return;
      }
      const titleEl = event.target.closest?.('[data-editable="title"]');
      if (titleEl) {
        const value = String(titleEl.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200);
        if (value) {
          els.titleInput.value = value;
          if (state.annotated) state.annotated.title = value;
        }
      }
    });

    // Typing on the canvas title/kicker also updates the left fields live.
    els.canvas.addEventListener('input', (event) => {
      const kickerEl = event.target.closest?.('[data-editable="kicker"]');
      if (kickerEl) {
        const value = String(kickerEl.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 48);
        state.styles.kicker = value || window.WorkbenchTemplates.defaultKicker(state.templateId);
        if (els.kickerInput && document.activeElement !== els.kickerInput) {
          els.kickerInput.value = state.styles.kicker;
        } else if (els.kickerInput && document.activeElement === kickerEl) {
          els.kickerInput.value = state.styles.kicker;
        }
        return;
      }
      const titleEl = event.target.closest?.('[data-editable="title"]');
      if (titleEl) {
        const value = String(titleEl.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200);
        if (!value) return;
        if (els.titleInput && document.activeElement !== els.titleInput) {
          els.titleInput.value = value;
        } else if (els.titleInput) {
          els.titleInput.value = value;
        }
        if (state.annotated) state.annotated.title = value;
      }
    });
  }

  function cacheElements() {
    els.toolStudio = $('wb-tool-studio');
    els.toolClassNote = $('wb-tool-class-note');
    els.studio = $('wb-studio');
    els.classNote = $('wb-class-note');
    els.roleSwitch = $('wb-role-switch');
    els.roleTeacher = $('wb-role-teacher');
    els.roleBlogger = $('wb-role-blogger');
    els.templateList = $('wb-template-list');
    els.sourceText = $('wb-source-text');
    els.titleInput = $('wb-title');
    els.kickerInput = $('wb-kicker');
    els.annotateBtn = $('wb-annotate-btn');
    els.saveBtn = $('wb-save-btn');
    els.saveInlineBtn = $('wb-save-inline-btn');
    els.saveListBtn = $('wb-save-list-btn');
    els.practiceBtn = $('wb-practice-btn');
    els.copyLinkBtn = $('wb-copy-link-btn');
    els.exportPngBtn = $('wb-export-png');
    els.exportPdfBtn = $('wb-export-pdf');
    els.deleteBtn = $('wb-delete-btn');
    els.linkOutput = $('wb-link-output');
    els.expireDays = $('wb-expire-days');
    els.canvas = $('wb-canvas');
    els.status = $('wb-status');
    els.savedList = $('wb-saved-list');
    els.authBanner = $('wb-auth-banner');
    els.loginBtn = $('wb-login-btn');
    els.wordPop = $('wb-word-pop');
    els.fontFamily = $('wb-font-family');
    els.fontSize = $('wb-font-size');
    els.textColor = $('wb-text-color');
    els.accentColor = $('wb-accent-color');
    els.background = $('wb-bg-color');
    els.highlightColor = $('wb-highlight-color');
    els.lineGap = $('wb-line-gap');
    els.showPhonetic = $('wb-show-phonetic');
    els.showPos = $('wb-show-pos');
    els.showCefr = $('wb-show-cefr');
    els.showGloss = $('wb-show-gloss');
    els.showMeta = $('wb-show-meta');
    els.orient = $('wb-orient');
    els.density = $('wb-density');
    els.align = $('wb-align');
    els.themeList = $('wb-theme-list');
  }

  async function boot() {
    cacheElements();
    bindEvents();
    applyTheme(state.styles.themeId || 'teal-day', { skipRender: true });
    syncRoleUi();
    renderPreview();

    const loggedIn = Boolean(readToken());
    els.authBanner.hidden = loggedIn;
    if (loggedIn) loadSavedList();

    const params = new URLSearchParams(location.search);
    const mode = params.get('mode');
    const noteId = params.get('note');
    const share = params.get('share');
    const id = params.get('id');

    if (mode === 'class-note' || noteId) {
      setTool('class-note', { noteId, skipHistory: true });
      return;
    }

    setTool('studio', { skipHistory: true });
    if (share) {
      await loadShare(share);
    } else if (id) {
      await loadDocument(id);
    } else if (params.get('import') === '1' || params.get('text')) {
      const imported = await applyExternalImport(params);
      if (!imported) {
        setStatus('粘贴英文 → AI 标注 → 选模板 → 导出或生成练习链接。');
      }
    } else {
      setStatus('粘贴英文 → AI 标注 → 选模板 → 导出或生成练习链接。');
    }
  }

  async function applyExternalImport(params) {
    let payload = null;
    if (window.WorkbenchImport && typeof window.WorkbenchImport.consume === 'function') {
      payload = window.WorkbenchImport.consume();
    }
    if (!payload) {
      const text = String(params.get('text') || '').trim();
      if (!text) return false;
      payload = {
        text,
        title: String(params.get('title') || '').trim(),
        template: params.get('template') || 'intensive-note',
        orient: params.get('orient') || params.get('orientation') || 'story',
        annotate: params.get('annotate') !== '0',
        source: params.get('from') || '',
      };
    }

    const text = String(payload.text || '').trim();
    if (!text) return false;

    const allowed = (window.WorkbenchTemplates?.TEMPLATES || []).map((item) => item.id);
    const templateId = allowed.includes(payload.template) ? payload.template : 'intensive-note';
    state.role = 'teacher';
    state.templateId = templateId;
    state.documentId = null;
    state.shareToken = null;
    state.practiceUrl = null;
    state.sourceText = text;
    state.annotated = null;
    state.styles.orientation = normalizeOrient(payload.orient || params.get('orient') || 'story');
    state.styles.kicker = window.WorkbenchTemplates.defaultKicker(templateId);

    if (els.sourceText) els.sourceText.value = text;
    if (els.titleInput) {
      els.titleInput.value = String(payload.title || '').trim() || text.slice(0, 48);
    }
    syncRoleUi();
    syncKickerInput();
    renderPreview();

    const wantAnnotate = payload.annotate !== false;
    if (wantAnnotate && readToken()) {
      await annotate();
      setStatus('已从学习内容导入并完成标注，可直接导出。', 'ok');
    } else if (wantAnnotate && !readToken()) {
      setStatus('已导入正文（草稿预览）。登录后点「AI 标注」可补全词性与释义。');
    } else {
      setStatus('已从学习内容导入，可调整样式后导出。', 'ok');
    }
    return true;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
