/**
 * Linglish shared UI icons — stroke set, 24×24 viewBox.
 * Usage:
 *   LxIcon.html('play')
 *   LxIcon.html('mic', { size: 20, className: 'lx-icon--lg' })
 *   <span data-lx-icon="home"></span>  // auto-hydrated on DOMContentLoaded
 */
(function (global) {
  'use strict';

  const PATHS = {
    // navigation
    home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>',
    back: '<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>',
    'arrow-left': '<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>',
    'chevron-right': '<path d="m9 18 6-6-6-6"/>',
    'chevron-left': '<path d="m15 18-6-6 6-6"/>',
    'chevron-down': '<path d="m6 9 6 6 6-6"/>',
    'chevron-up': '<path d="m18 15-6-6-6 6"/>',
    close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
    menu: '<path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h16"/>',

    // playback / speaking
    play: '<path d="M8 5.5v13l11-6.5-11-6.5z"/>',
    pause: '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
    mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/><path d="M9 21h6"/>',
    'mic-off': '<path d="m2 2 20 20"/><path d="M9 5a3 3 0 0 1 6 0v5a3 3 0 0 1-.3 1.3"/><path d="M12 18a7 7 0 0 0 7-7"/><path d="M5 11a7 7 0 0 0 7 7"/><path d="M12 18v3"/><path d="M9 21h6"/>',
    volume: '<path d="M4 10v4h4l5 5V5l-5 5H4z"/><path d="M16 9a4 4 0 0 1 0 6"/><path d="M18.5 6.5a8 8 0 0 1 0 11"/>',
    'volume-off': '<path d="M4 10v4h4l5 5V5l-5 5H4z"/><path d="m22 9-6 6"/><path d="m16 9 6 6"/>',
    prev: '<path d="M19 5v14l-10-7 10-7z"/><path d="M5 5v14"/>',
    next: '<path d="M5 5v14l10-7L5 5z"/><path d="M19 5v14"/>',
    replay: '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 5v5h5"/>',
    loop: '<path d="m17 2 4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>',
    headphones: '<path d="M4 14v-2a8 8 0 0 1 16 0v2"/><path d="M4 14v4a2 2 0 0 0 2 2h1v-6H6a2 2 0 0 0-2 2z"/><path d="M20 14v4a2 2 0 0 1-2 2h-1v-6h1a2 2 0 0 1 2 2z"/>',
    focus: '<circle cx="12" cy="12" r="3"/><path d="M12 3v2"/><path d="M12 19v2"/><path d="M3 12h2"/><path d="M19 12h2"/><path d="m5.6 5.6 1.4 1.4"/><path d="m17 17 1.4 1.4"/><path d="m5.6 18.4 1.4-1.4"/><path d="m17 7 1.4-1.4"/>',

    // actions
    save: '<path d="M5 4h11l3 3v13H5V4z"/><path d="M8 4v5h7V4"/><path d="M8 14h8v5H8z"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.2 1.2"/><path d="M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.2-1.2"/>',
    download: '<path d="M12 4v12"/><path d="m7 11 5 5 5-5"/><path d="M5 20h14"/>',
    upload: '<path d="M12 20V8"/><path d="m7 13 5-5 5 5"/><path d="M5 4h14"/>',
    trash: '<path d="M4 7h16"/><path d="M9 7V5h6v2"/><path d="M7 7l1 13h8l1-13"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="m13 7 4 4"/>',
    plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
    check: '<path d="m5 12 5 5L20 7"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M12 3v2"/><path d="M12 19v2"/><path d="m4.9 6.5 1.7 1"/><path d="m17.4 16.5 1.7 1"/><path d="M3 12h2"/><path d="M19 12h2"/><path d="m4.9 17.5 1.7-1"/><path d="m17.4 7.5 1.7-1"/>',
    bookmark: '<path d="M7 4h10a1 1 0 0 1 1 1v15l-6-3.5L6 20V5a1 1 0 0 1 1-1z"/>',
    star: '<path d="m12 3 2.6 5.4 6 .9-4.3 4.2 1 6L12 16.8 6.7 19.5l1-6L3.4 9.3l6-.9L12 3z"/>',
    send: '<path d="m4 11 15-7-7 15-2-6-6-2z"/>',
    share: '<circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="m8.2 13.2 7.6 4.4"/><path d="m15.8 6.4-7.6 4.4"/>',

    // content / product
    video: '<rect x="3" y="6" width="13" height="12" rx="2"/><path d="m16 10 5-3v10l-5-3v-4z"/>',
    book: '<path d="M5 4h9a3 3 0 0 1 3 3v13H8a3 3 0 0 0-3 3V4z"/><path d="M5 20a3 3 0 0 1 3-3h12"/>',
    books: '<path d="M5 5h5v15H5z"/><path d="M10 7h5v13h-5z"/><path d="M15 6h4v14h-4z"/>',
    file: '<path d="M7 3h7l4 4v14H7V3z"/><path d="M14 3v5h5"/>',
    image: '<rect x="4" y="5" width="16" height="14" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="m4 16 5-4 4 3 3-2 4 3"/>',
    document: '<path d="M7 3h7l4 4v14H7V3z"/><path d="M14 3v5h5"/><path d="M9 13h6"/><path d="M9 17h6"/>',
    library: '<path d="M4 5h4v15H4z"/><path d="M10 5h4v15h-4z"/><path d="M16 5h4v15h-4z"/>',
    channel: '<path d="M4 8h16v10H4z"/><path d="M8 8V6h8v2"/><circle cx="12" cy="13" r="2"/>',
    user: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/>',
    users: '<circle cx="9" cy="8" r="3"/><circle cx="17" cy="9" r="2.5"/><path d="M3 20a6 6 0 0 1 12 0"/><path d="M14 20a5 5 0 0 1 7 0"/>',
    crown: '<path d="m4 16 2-9 4 4 2-6 2 6 4-4 2 9H4z"/><path d="M4 16h16v3H4z"/>',
    gem: '<path d="M7 4h10l4 6-9 11L3 10l4-6z"/><path d="M3 10h18"/><path d="M12 21 8 10h8l-4 11z"/>',

    // mobile tab metaphors (chrome replacements for emoji)
    today: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/>',
    explore: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18"/><path d="M12 3a14 14 0 0 0 0 18"/>',
    power: '<path d="M13 3 5 14h7l-1 7 8-11h-7l1-7z"/>',
    arena: '<rect x="3" y="7" width="18" height="12" rx="2"/><path d="M8 7V5h8v2"/><path d="M9 12h6"/><path d="M12 10v4"/>',
    growth: '<path d="M12 21V10"/><path d="M12 14c-4 0-7-2-7-6 4 0 7 2 7 6z"/><path d="M12 12c4 0 7-2 7-6-4 0-7 2-7 6z"/><path d="M8 21h8"/>',
    message: '<path d="M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9l-4 3v-3H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z"/>',
    chart: '<path d="M4 20h16"/><path d="M7 16V10"/><path d="M12 16V6"/><path d="M17 16v-4"/>',
    spark: '<path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z"/><path d="m19 15 .8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15z"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.7 2.2c-.8.5-1.2 1-1.2 2"/><path d="M12 17h.01"/>',
    alert: '<path d="M12 4 3 19h18L12 4z"/><path d="M12 10v4"/><path d="M12 17h.01"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><path d="M12 8h.01"/>',
    lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    translate: '<path d="M5 7h8"/><path d="M9 5v2"/><path d="m7 7 3 8"/><path d="m13 7-1.5 4"/><path d="M14 17h6"/><path d="m17 13 3 8"/><path d="m14 21 1.5-4"/>',
    workbench: '<rect x="3" y="4" width="18" height="6" rx="1"/><path d="M5 10v8a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-8"/><path d="M10 14h4"/>',
    materials: '<path d="M5 5h10l4 4v10H5V5z"/><path d="M15 5v4h4"/><path d="M8 13h8"/><path d="M8 17h5"/>',
  };

  const ALIASES = {
    'arrow-back': 'back',
    speaker: 'volume',
    mute: 'volume-off',
    skipBack: 'prev',
    skipForward: 'next',
    refresh: 'replay',
    gear: 'settings',
    trash2: 'trash',
    pencil: 'edit',
    target: 'today',
    globe: 'explore',
    zap: 'power',
    plant: 'growth',
    chat: 'message',
    vip: 'crown',
    warning: 'alert',
    question: 'help',
    stats: 'chart',
    magic: 'spark',
  };

  function resolveName(name) {
    const key = String(name || '').trim();
    return ALIASES[key] || key;
  }

  function html(name, opts) {
    opts = opts || {};
    const id = resolveName(name);
    const inner = PATHS[id];
    if (!inner) {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[LxIcon] unknown icon:', name);
      }
      return '';
    }
    const size = opts.size || opts.width || null;
    const cls = ['lx-icon', opts.className || opts.cls || ''].filter(Boolean).join(' ');
    const label = opts.label || opts['aria-label'];
    const attrs = [
      `class="${cls}"`,
      'viewBox="0 0 24 24"',
      'fill="none"',
      'stroke="currentColor"',
      'stroke-width="2"',
      'stroke-linecap="round"',
      'stroke-linejoin="round"',
      'focusable="false"',
    ];
    if (size) {
      attrs.push(`width="${size}"`, `height="${size}"`);
    }
    if (label) {
      attrs.push(`role="img"`, `aria-label="${String(label).replace(/"/g, '&quot;')}"`);
    } else {
      attrs.push('aria-hidden="true"');
    }
    if (opts.title) {
      return `<svg ${attrs.join(' ')}><title>${String(opts.title).replace(/</g, '&lt;')}</title>${inner}</svg>`;
    }
    return `<svg ${attrs.join(' ')}>${inner}</svg>`;
  }

  function set(el, name, opts) {
    if (!el) return el;
    el.innerHTML = html(name, opts);
    return el;
  }

  function hydrate(root) {
    const scope = root && root.querySelectorAll ? root : document;
    scope.querySelectorAll('[data-lx-icon]').forEach((node) => {
      const name = node.getAttribute('data-lx-icon');
      if (!name) return;
      const size = Number(node.getAttribute('data-lx-size')) || undefined;
      const label = node.getAttribute('data-lx-label') || undefined;
      const className = node.getAttribute('data-lx-class') || undefined;
      node.innerHTML = html(name, { size, label, className });
    });
  }

  const api = {
    PATHS,
    ALIASES,
    names: Object.keys(PATHS),
    html,
    set,
    hydrate,
    has(name) {
      return Boolean(PATHS[resolveName(name)]);
    },
  };

  global.LxIcon = api;

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => hydrate(document));
    } else {
      hydrate(document);
    }
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
