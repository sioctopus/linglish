/**
 * Compact app bar for phones and tablet portrait (≤1023px).
 *
 * Desktop pages keep their full toolbar. On narrow screens the toolbar collapses to
 * back · current task · more, and every secondary entry moves into a bottom sheet.
 * Entries are moved, never deleted: each sheet row proxies a click to the original
 * control, so existing listeners, links and analytics keep working.
 *
 * Usage:
 *   LxCompactNav.mount({
 *     bar: '.topbar',
 *     title: 'AI 陪练',                       // optional centre title
 *     keep: ['[data-nav="back"]', '#study-switch'],
 *     hide: ['.brand', '.daily-goal'],       // hidden on compact, not offered in the sheet
 *     sheet: ['[data-nav="home"]', '.pill-browser', ...]  // offered in the "更多" sheet
 *   });
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && root.document) root.LxCompactNav = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const COMPACT_QUERY = '(max-width: 1023px)';
  const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu;

  /** @param {string} text */
  function cleanLabel(text) {
    return String(text || '').replace(EMOJI, '').replace(/\s+/g, ' ').trim();
  }

  /** @param {Element} node */
  function labelFor(node) {
    const candidates = [
      node.getAttribute('data-compact-label'),
      node.textContent,
      node.getAttribute('aria-label'),
      node.getAttribute('title'),
    ];
    for (const candidate of candidates) {
      const label = cleanLabel(candidate);
      if (label) return label;
    }
    return '';
  }

  function queryAll(scope, selectors) {
    const out = [];
    (selectors || []).forEach((selector) => {
      scope.querySelectorAll(selector).forEach((node) => {
        if (!out.includes(node)) out.push(node);
      });
    });
    return out;
  }

  function buildSheet(doc) {
    const sheet = doc.createElement('div');
    sheet.className = 'lx-more-sheet';
    sheet.hidden = true;
    sheet.innerHTML =
      '<button type="button" class="lx-more-backdrop" aria-label="关闭"></button>' +
      '<div class="lx-more-panel" role="dialog" aria-modal="true" aria-label="更多" tabindex="-1">' +
      '<div class="lx-more-grip" aria-hidden="true"></div>' +
      '<div class="lx-more-list"></div>' +
      '<button type="button" class="lx-more-cancel">取消</button>' +
      '</div>';
    doc.body.appendChild(sheet);
    return sheet;
  }

  let activeClose = null;

  // Both menus and pickers are modal: keep keyboard/scroll interaction in the sheet.
  function containModal(doc, sheet, close) {
    if (activeClose) activeClose();
    activeClose = close;
    const panel = sheet.querySelector('.lx-more-panel');
    const previousOverflow = doc.body.style.overflow;
    const siblings = Array.from(doc.body.children).filter((node) => node !== sheet);
    const previousInert = siblings.map((node) => node.inert);
    siblings.forEach((node) => { node.inert = true; });
    doc.body.style.overflow = 'hidden';
    function onKey(event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      } else if (event.key === 'Tab') {
        const buttons = Array.from(panel.querySelectorAll('button:not(:disabled), a[href], [tabindex="0"]'))
          .filter((node) => node.getClientRects().length && !node.closest('[hidden], [inert]'));
        const first = buttons[0] || panel;
        const last = buttons[buttons.length - 1] || panel;
        if (!panel.contains(doc.activeElement) || doc.activeElement === panel
          || (event.shiftKey && doc.activeElement === first) || (!event.shiftKey && doc.activeElement === last)) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        }
      }
    }
    doc.addEventListener('keydown', onKey);
    panel.focus({ preventScroll: true });
    return () => {
      doc.removeEventListener('keydown', onKey);
      siblings.forEach((node, index) => { node.inert = previousInert[index]; });
      doc.body.style.overflow = previousOverflow;
      if (activeClose === close) activeClose = null;
    };
  }

  function mount(options) {
    const doc = document;
    const bar = typeof options.bar === 'string' ? doc.querySelector(options.bar) : options.bar;
    if (!bar || bar.dataset.lxCompactMounted) return null;
    bar.dataset.lxCompactMounted = '1';

    const keep = queryAll(bar, options.keep);
    const hide = queryAll(bar, options.hide);
    const sheetItems = queryAll(bar, options.sheet).filter((node) => !keep.includes(node));
    keep.forEach((node) => node.setAttribute('data-compact-keep', ''));
    hide.concat(sheetItems).forEach((node) => node.setAttribute('data-compact-hide', ''));

    let title = null;
    if (options.title) {
      title = doc.createElement('div');
      title.className = 'lx-compact-title';
      title.textContent = options.title;
      bar.appendChild(title);
    }

    const moreBtn = doc.createElement('button');
    moreBtn.type = 'button';
    moreBtn.className = 'lx-compact-more';
    moreBtn.setAttribute('aria-label', '更多');
    moreBtn.setAttribute('aria-haspopup', 'dialog');
    moreBtn.setAttribute('aria-expanded', 'false');
    moreBtn.innerHTML =
      '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true">' +
      '<circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>';
    bar.appendChild(moreBtn);

    const sheet = buildSheet(doc);
    const list = sheet.querySelector('.lx-more-list');
    let lastFocus = null;
    let hideTimer = null;
    let openFrame = null;
    let releaseModal = null;
    let enabled = options.enabled !== false;

    function render() {
      list.textContent = '';
      sheetItems.forEach((source) => {
        if (source.hidden || source.closest('[hidden]:not([data-compact-hide])')) return;
        const label = labelFor(source);
        if (!label) return;
        const row = doc.createElement('button');
        row.type = 'button';
        row.className = 'lx-more-item';
        row.disabled = Boolean(source.disabled || source.getAttribute('aria-disabled') === 'true');
        const iconBox = doc.createElement('span');
        iconBox.className = 'lx-more-icon';
        iconBox.setAttribute('aria-hidden', 'true');
        const named = source.getAttribute('data-compact-icon');
        const icons = window.LxIcon;
        if (named && icons && typeof icons.html === 'function' && icons.has(named)) {
          iconBox.innerHTML = icons.html(named, { size: 22 });
        } else {
          const icon = source.querySelector('svg, [data-lx-icon]');
          if (icon) iconBox.appendChild(icon.cloneNode(true));
        }
        const text = doc.createElement('span');
        text.className = 'lx-more-label';
        text.textContent = label;
        row.append(iconBox, text);
        if (source.classList.contains('active') || source.getAttribute('aria-current')) {
          row.classList.add('is-current');
        }
        row.addEventListener('click', () => {
          close();
          source.click();
        });
        list.appendChild(row);
      });
    }

    function open() {
      if (!enabled || !media.matches) return;
      clearTimeout(hideTimer);
      cancelAnimationFrame(openFrame);
      if (releaseModal) return;
      render();
      lastFocus = doc.activeElement;
      sheet.hidden = false;
      openFrame = requestAnimationFrame(() => sheet.classList.add('is-open'));
      moreBtn.setAttribute('aria-expanded', 'true');
      releaseModal = containModal(doc, sheet, close);
    }

    function close() {
      if (sheet.hidden) return;
      cancelAnimationFrame(openFrame);
      clearTimeout(hideTimer);
      sheet.classList.remove('is-open');
      moreBtn.setAttribute('aria-expanded', 'false');
      hideTimer = setTimeout(() => { sheet.hidden = true; }, 200);
      if (releaseModal) { releaseModal(); releaseModal = null; }
      if (lastFocus && lastFocus.isConnected && typeof lastFocus.focus === 'function') lastFocus.focus({ preventScroll: true });
    }

    moreBtn.addEventListener('click', open);
    sheet.querySelector('.lx-more-backdrop').addEventListener('click', close);
    sheet.querySelector('.lx-more-cancel').addEventListener('click', close);
    const media = window.matchMedia(COMPACT_QUERY);
    const sync = () => {
      const active = enabled && media.matches;
      bar.classList.toggle('lx-compact-bar', active);
      doc.documentElement.classList.toggle('lx-has-compact-bar', active);
      if (!active) close();
    };
    if (typeof media.addEventListener === 'function') media.addEventListener('change', sync);
    else if (typeof media.addListener === 'function') media.addListener(sync);
    sync();

    return { open, close, sheet, moreBtn, setEnabled(value) { enabled = Boolean(value); sync(); } };
  }

  /**
   * One-off choice sheet (e.g. textbook + method picker).
   * @param {{ title?: string, sections: Array<{ title?: string, rows: Array<{ label: string, current?: boolean, onSelect: () => void }> }> }} config
   */
  function openPicker(config) {
    const doc = document;
    const sheet = doc.createElement('div');
    sheet.className = 'lx-more-sheet lx-picker';
    const backdrop = doc.createElement('button');
    backdrop.type = 'button';
    backdrop.className = 'lx-more-backdrop';
    backdrop.setAttribute('aria-label', '关闭');
    const panel = doc.createElement('div');
    panel.className = 'lx-more-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-label', config.title || '选择');
    panel.tabIndex = -1;
    const grip = doc.createElement('div');
    grip.className = 'lx-more-grip';
    panel.appendChild(grip);
    if (config.title) {
      const heading = doc.createElement('div');
      heading.className = 'lx-picker-title';
      heading.textContent = config.title;
      panel.appendChild(heading);
    }
    const lastFocus = doc.activeElement;
    let closed = false;
    let releaseModal = null;
    let openFrame = null;

    function close() {
      if (closed) return;
      closed = true;
      cancelAnimationFrame(openFrame);
      sheet.classList.remove('is-open');
      if (releaseModal) releaseModal();
      setTimeout(() => sheet.remove(), 200);
      if (lastFocus && lastFocus.isConnected && typeof lastFocus.focus === 'function') lastFocus.focus({ preventScroll: true });
    }

    (config.sections || []).forEach((section) => {
      if (!section.rows || !section.rows.length) return;
      if (section.title) {
        const label = doc.createElement('div');
        label.className = 'lx-picker-section';
        label.textContent = section.title;
        panel.appendChild(label);
      }
      const group = doc.createElement('div');
      group.className = 'lx-picker-group';
      section.rows.forEach((row) => {
        const option = doc.createElement('button');
        option.type = 'button';
        option.className = 'lx-picker-row' + (row.current ? ' is-current' : '');
        option.setAttribute('aria-pressed', row.current ? 'true' : 'false');
        option.textContent = row.label;
        option.addEventListener('click', () => {
          close();
          row.onSelect();
        });
        group.appendChild(option);
      });
      panel.appendChild(group);
    });

    const cancel = doc.createElement('button');
    cancel.type = 'button';
    cancel.className = 'lx-more-cancel';
    cancel.textContent = '取消';
    cancel.addEventListener('click', close);
    backdrop.addEventListener('click', close);
    panel.appendChild(cancel);
    sheet.append(backdrop, panel);
    doc.body.appendChild(sheet);
    releaseModal = containModal(doc, sheet, close);
    openFrame = requestAnimationFrame(() => sheet.classList.add('is-open'));
    return { close };
  }

  return { mount, openPicker, cleanLabel, COMPACT_QUERY };
});
