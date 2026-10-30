/**
 * Desktop install affordance for the web app.
 * Chromium (Chrome / Edge) uses beforeinstallprompt, the same path as X and YouTube.
 * Other browsers get the manual install steps for that browser.
 */
(function () {
  'use strict';

  var deferredPrompt = null;
  var slot = null;
  var button = null;
  var panel = null;
  var restingParent = null;

  function text(zh, en) {
    var lang = (document.documentElement.lang || '').toLowerCase();
    return lang.indexOf('en') === 0 ? en : zh;
  }

  function isStandalone() {
    var media = window.matchMedia;
    if (typeof media === 'function') {
      if (media.call(window, '(display-mode: standalone)').matches) return true;
      if (media.call(window, '(display-mode: window-controls-overlay)').matches) return true;
      if (media.call(window, '(display-mode: minimal-ui)').matches) return true;
    }
    return window.navigator.standalone === true;
  }

  function browserKind() {
    var ua = navigator.userAgent || '';
    if (/Edg\//.test(ua)) return 'edge';
    if (/Chrome\//.test(ua) && !/OPR\/|Opera/.test(ua)) return 'chrome';
    if (/Safari\//.test(ua) && !/Chrome\/|Chromium\//.test(ua)) return 'safari';
    if (/Firefox\//.test(ua)) return 'firefox';
    return 'other';
  }

  function currentTarget() {
    var info = window.LxDevice && window.LxDevice.apply ? window.LxDevice.apply(window) : null;
    if (window.LxDevice && window.LxDevice.installTarget) return window.LxDevice.installTarget(info);
    return { surface: 'desktop', manifest: '/manifest-desktop.json' };
  }

  function isHomeSurface(target) {
    if (target && target.surface === 'home') return true;
    // Fallback when device adapt is unavailable: hide install UI on touch phones/tablets.
    try {
      if (window.matchMedia('(pointer: coarse)').matches && window.innerWidth <= 1024) return true;
    } catch (_) {}
    var form = document.documentElement.getAttribute('data-lx-form') || '';
    return form === 'phone' || form === 'tablet' || form.indexOf('tablet') === 0;
  }

  function osName() {
    var os = document.documentElement.getAttribute('data-lx-os') || '';
    if (os && os !== 'other') return os;
    var ua = navigator.userAgent || '';
    if (/Windows/i.test(ua)) return 'windows';
    if (/Macintosh|Mac OS X/i.test(ua) && !/iPad|iPhone|Android/i.test(ua)) return 'mac';
    if (/CrOS/i.test(ua)) return 'chromeos';
    if (/Linux/i.test(ua) && !/Android/i.test(ua)) return 'linux';
    return os || 'other';
  }

  function isDesktopComputer() {
    var os = osName();
    return os === 'windows' || os === 'mac' || os === 'chromeos' || os === 'linux';
  }

  // Safari on a Mac has no install event, but File → Add to Dock still installs.
  function isMacSafari() {
    return browserKind() === 'safari' && osName() === 'mac' && isDesktopComputer();
  }

  function canOfferDesktopInstall() {
    if (window.top !== window.self || isStandalone()) return false;
    if (!isDesktopComputer()) return false;
    if (isHomeSurface(currentTarget())) return false;
    return true;
  }

  function ensureManifest(target) {
    if (target.surface === 'home') target.manifest = '/manifest.json';
    var existing = document.querySelector('link[rel="manifest"]');
    if (existing) {
      var href = existing.getAttribute('href') || '';
      if (href.indexOf(target.manifest) === -1) existing.href = target.manifest;
      return;
    }
    var link = document.createElement('link');
    link.rel = 'manifest';
    link.href = target.manifest;
    document.head.appendChild(link);
  }

  function ensureStyles() {
    if (document.querySelector('link[data-install-desktop]')) return;
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = '/css/install-desktop.css?v=4';
    link.setAttribute('data-install-desktop', '1');
    document.head.appendChild(link);
  }

  function registerWorker() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(function () {});
  }

  function hideInstall() {
    if (slot) slot.hidden = true;
  }

  function setExpanded(open) {
    if (!button || !panel) return;
    panel.hidden = !open;
    button.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function manualSteps(target) {
    var kind = browserKind();
    var os = document.documentElement.getAttribute('data-lx-os') || '';
    if (target.surface === 'home') {
      if (os === 'ios' || kind === 'safari') {
        return text(
          '点分享按钮，选择「添加到主屏幕」，再点「添加」。iPhone 和 iPad 都用这一步。',
          'Tap Share, choose Add to Home Screen, then tap Add. This is the same step on iPhone and iPad.'
        );
      }
      if (os === 'android') {
        return text(
          '点浏览器菜单里的「安装应用」或「添加到主屏幕」。安卓手机会把 Linglish 放到主屏幕。',
          'Open the browser menu and choose Install app or Add to Home screen.'
        );
      }
      return text(
        '点浏览器菜单里的「安装应用」或「添加到主屏幕」。',
        'Open the browser menu and choose Install app or Add to Home screen.'
      );
    }
    if (kind === 'chrome' || kind === 'edge') {
      return text(
        '如果没有弹出安装窗口，点地址栏右侧的安装图标，或打开浏览器菜单，选择「安装 Linglish」。Windows 和 Mac 都是这个入口。',
        'If no install window appears, use the install icon in the address bar, or open the browser menu and choose “Install Linglish”.'
      );
    }
    if (kind === 'safari') {
      return text(
        '在 Safari 中打开「文件」，选择「添加到程序坞」。',
        'In Safari, open File and choose Add to Dock.'
      );
    }
    return text(
      '请用 Chrome 或 Edge 打开这个页面，再点「安装到桌面」。',
      'Open this page in Chrome or Edge, then choose Install to desktop.'
    );
  }

  function renderCopy() {
    if (!button || !panel) return;
    var target = currentTarget();
    var home = target.surface === 'home';
    var label = home ? text('添加到主屏幕', 'Add to Home Screen') : text('安装到桌面', 'Install app');
    button.querySelector('.lx-install-desktop-label').textContent = label;
    button.title = home
      ? text('把 Linglish 加到主屏幕，用独立窗口打开', 'Add Linglish to the home screen and open it in its own window')
      : text('把 Linglish 安装到桌面，用独立窗口打开', 'Install Linglish and open it in its own window');
    panel.querySelector('[data-install-title]').textContent = label;
    panel.querySelector('[data-install-body]').textContent = home
      ? text(
        '加上之后，Linglish 会出现在主屏幕上，并用自己的窗口打开。这仍是现在的网站。',
        'After adding it, Linglish appears on the home screen and opens in its own window. It is still this website.'
      )
      : text(
        '安装后，Linglish 会出现在桌面和开始菜单里，并用自己的窗口打开。这不是单独的客户端。',
        'After installing, Linglish shows up on the desktop and in the Start menu, and opens in its own window. It is still this website.'
      );
    panel.querySelector('[data-install-steps]').textContent = manualSteps(target);
    panel.querySelector('[data-install-close]').setAttribute('aria-label', text('关闭', 'Close'));
  }

  function installNow() {
    if (!deferredPrompt) {
      setExpanded(panel.hidden);
      return;
    }
    var promptEvent = deferredPrompt;
    deferredPrompt = null;
    setExpanded(false);
    promptEvent.prompt();
    var choice = promptEvent.userChoice;
    if (choice && typeof choice.then === 'function') {
      choice.then(function (result) {
        if (result && result.outcome === 'accepted') hideInstall();
      }).catch(function () {});
    }
  }

  function mount() {
    if (document.getElementById('lx-install-desktop')) return;

    slot = document.createElement('span');
    slot.id = 'lx-install-desktop';
    slot.className = 'lx-install-desktop-slot';

    button = document.createElement('button');
    button.type = 'button';
    button.className = 'lx-install-desktop';
    button.setAttribute('aria-haspopup', 'dialog');
    button.setAttribute('aria-expanded', 'false');
    button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v9A1.5 1.5 0 0 1 18.5 16h-13A1.5 1.5 0 0 1 4 14.5v-9Z" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8 20h8M12 16v4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M12 7.2v4.2M9.8 9.6 12 11.8l2.2-2.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg><span class="lx-install-desktop-label"></span>';

    panel = document.createElement('div');
    panel.className = 'lx-install-panel';
    panel.hidden = true;
    panel.setAttribute('role', 'dialog');
    panel.innerHTML = '<div class="lx-install-panel-head"><strong data-install-title></strong><button type="button" data-install-close>×</button></div><p data-install-body></p><p data-install-steps></p>';

    slot.appendChild(button);
    slot.appendChild(panel);
    renderCopy();

    button.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      renderCopy();
      installNow();
    });
    panel.querySelector('[data-install-close]').addEventListener('click', function (event) {
      event.stopPropagation();
      setExpanded(false);
    });
    document.addEventListener('click', function (event) {
      if (!slot || slot.hidden || panel.hidden) return;
      if (!slot.contains(event.target)) setExpanded(false);
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') setExpanded(false);
    });

    var target = currentTarget();
    var shellHost = document.getElementById('lx-shell-install-host');
    var navbar = document.querySelector('.navbar');
    var topNav = document.querySelector('body > .topbar > .nav, header.topbar > .nav, header.topbar > .nav-actions');
    if (shellHost) {
      restingParent = shellHost;
      slot.classList.add('lx-install-desktop-slot--shell');
    } else if (target.surface === 'home') {
      restingParent = document.body;
      slot.classList.add('lx-install-desktop-slot--float', 'lx-install-desktop-slot--home');
    } else {
      restingParent = navbar || topNav || document.body;
      if (!navbar && topNav) slot.classList.add('lx-install-desktop-slot--bar');
      if (!navbar && !topNav) slot.classList.add('lx-install-desktop-slot--float');
    }
    restingParent.appendChild(slot);
    placeInstall();

    if (window.MutationObserver) {
      new MutationObserver(renderCopy).observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['lang']
      });
      new MutationObserver(placeInstall).observe(document.body, {
        attributes: true,
        attributeFilter: ['class']
      });
    }
  }

  function placeInstall() {
    if (!slot) return;
    var focusHead = document.body.classList.contains('focus-mode')
      ? document.querySelector('.transcript .header-top')
      : null;
    var modeToggle = focusHead && focusHead.querySelector('.mode-toggle');
    var videoEntry = focusHead && focusHead.querySelector('#focus-video-entry');
    if (focusHead && modeToggle) {
      slot.classList.add('lx-install-desktop-slot--focus');
      slot.classList.remove('lx-install-desktop-slot--bar', 'lx-install-desktop-slot--float');
      focusHead.insertBefore(slot, videoEntry || modeToggle);
      return;
    }
    slot.classList.remove('lx-install-desktop-slot--focus');
    if (!restingParent) return;
    var inBar = restingParent !== document.body && !restingParent.classList.contains('navbar');
    slot.classList.toggle('lx-install-desktop-slot--bar', inBar);
    slot.classList.toggle('lx-install-desktop-slot--float', restingParent === document.body);
    restingParent.appendChild(slot);
  }

  function reveal() {
    var target = currentTarget();
    if (isHomeSurface(target)) {
      hideInstall();
      return;
    }
    if (!canOfferDesktopInstall() || (!deferredPrompt && !isMacSafari())) {
      hideInstall();
      return;
    }
    ensureStyles();
    mount();
    if (slot) slot.hidden = false;
  }

  function boot() {
    if (window.top !== window.self) return;
    if (isStandalone()) return;
    var target = currentTarget();
    ensureManifest(target);
    registerWorker();
    window.addEventListener('resize', reveal);
    // Phones and tablets: no install control, so it never takes space.
    if (isHomeSurface(target)) return;
    reveal();
    if (!navigator.getInstalledRelatedApps) return;
    navigator.getInstalledRelatedApps().then(function (apps) {
      if (Array.isArray(apps) && apps.some(function (app) { return app && app.platform === 'webapp'; })) {
        hideInstall();
      }
    }).catch(function () {});
  }

  window.addEventListener('beforeinstallprompt', function (event) {
    event.preventDefault();
    deferredPrompt = event;
    reveal();
  });

  window.addEventListener('appinstalled', function () {
    deferredPrompt = null;
    hideInstall();
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
