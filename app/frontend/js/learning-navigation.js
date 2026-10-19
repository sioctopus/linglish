/* Keep the same controls and listeners when the learning header becomes compact. */
(function () {
  'use strict';

  const header = document.querySelector('body > .topbar');
  const nav = header && header.querySelector('.nav');
  if (!nav || !window.matchMedia) return;

  const compact = window.matchMedia('(max-width: 1439px)');
  const more = document.createElement('details');
  more.className = 'learning-more';
  const trigger = document.createElement('summary');
  const tools = document.createElement('div');
  tools.className = 'learning-tools';
  tools.id = 'learning-tools';
  trigger.setAttribute('aria-controls', tools.id);
  tools.setAttribute('role', 'group');
  more.append(trigger, tools);
  nav.appendChild(more);
  const slots = new Map();

  function updateLabels() {
    const english = (document.documentElement.lang || '').startsWith('en');
    trigger.textContent = english ? '··· More' : '··· 更多';
    trigger.setAttribute('aria-label', english ? 'More learning tools' : '更多学习工具');
    tools.setAttribute('aria-label', english ? 'Learning tools' : '学习工具');
  }

  function remember(node) {
    if (node === more || slots.has(node) || node.matches('.study-switch, [data-learning-primary]')) return;
    const position = document.createComment('learning-tool');
    nav.insertBefore(position, node);
    slots.set(node, position);
  }

  function sync() {
    for (const node of Array.from(nav.children)) remember(node);
    if (!compact.matches) {
      const restoreFocus = more.contains(document.activeElement);
      more.open = false;
      for (const [node, position] of slots) {
        if (node.parentNode !== nav && node.parentNode !== tools) continue;
        if (position.nextSibling !== node) position.after(node);
      }
      if (restoreFocus) nav.querySelector('[data-learning-primary="library"]')?.focus();
    } else {
      for (const node of slots.keys()) {
        if (node.parentNode !== nav && node.parentNode !== tools) continue;
        if (node.parentNode !== tools) tools.appendChild(node);
      }
    }
  }

  document.addEventListener('click', (event) => {
    if (!more.open) return;
    const link = event.target.closest('a');
    if (!more.contains(event.target) || (link && tools.contains(link))) more.open = false;
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !more.open) return;
    more.open = false;
    trigger.focus();
    event.stopPropagation();
  });
  // The player's global Space shortcut must not intercept the native disclosure.
  trigger.addEventListener('keydown', (event) => {
    if (event.key === ' ' || event.key === 'Enter') event.stopPropagation();
  });
  more.addEventListener('toggle', () => {
    trigger.setAttribute('aria-expanded', String(more.open));
  });
  if (compact.addEventListener) compact.addEventListener('change', sync);
  else compact.addListener(sync);
  new MutationObserver(sync).observe(nav, { childList: true });
  new MutationObserver(updateLabels).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
  updateLabels();
  sync();
  document.body.classList.add('learning-nav-ready');
})();
