/**
 * Signed-in home on phones and tablet portrait (≤1023px).
 *
 * The desktop home doubles as a marketing page. On a phone, a signed-in learner needs
 * "continue where I stopped" and the main practice entries, not the pitch.
 * This module adds html.lx-app-home (styles in styles/home-app.css) and renders a short
 * app header block. Marketing sections are hidden by CSS; every learning entry stays
 * reachable from the tiles or the "更多" sheet.
 */
(function (root) {
  'use strict';

  const COMPACT_QUERY = '(max-width: 1023px)';

  const TILES = [
    { label: '视频学习', icon: 'video', href: './video-reader-desktop.html' },
    { label: '日常口语', icon: 'mic', href: './daily-speaking.html' },
    { label: 'AI 陪练', icon: 'message', href: './practice-session.html?mode=shadowing' },
    { label: '词汇复习', icon: 'book', href: './video-vocabulary-desktop.html' },
    { label: '词汇游戏', icon: 'arena', href: './game.html' },
    { label: '学习文档', icon: 'document', href: './document-import.html' },
    { label: '学习小组', icon: 'users', href: '#community' },
    { label: '成长数据', icon: 'chart', href: './stats-desktop.html' },
  ];

  function greeting(date) {
    const hour = date.getHours();
    if (hour < 5) return '夜深了';
    if (hour < 11) return '早上好';
    if (hour < 13) return '中午好';
    if (hour < 18) return '下午好';
    return '晚上好';
  }

  function icon(name, size) {
    const icons = root.LxIcon;
    return icons && typeof icons.html === 'function' && icons.has(name) ? icons.html(name, { size: size || 22 }) : '';
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function continueTarget() {
    const recent = root.LinglishStudyRecent && typeof root.LinglishStudyRecent.latest === 'function'
      ? root.LinglishStudyRecent.latest()
      : null;
    if (recent && recent.id != null && /^(?:\d+|yt:[\w-]{6,}|pod:.+)$/.test(String(recent.id))) {
      const percent = Math.round(Math.max(0, Math.min(100, Number(recent.percent) || 0)));
      const seconds = Number(recent.seconds);
      const start = Number.isFinite(seconds) && seconds > 1 ? `&startSec=${Math.floor(seconds)}` : '';
      return {
        kicker: '继续上次的视频',
        title: String(recent.title || '上次的视频'),
        meta: percent > 0 ? `已学 ${percent}%` : '从上次停下的地方接着练',
        href: `./video-reader-desktop.html?videoId=${encodeURIComponent(String(recent.id))}${start}`,
      };
    }
    return {
      kicker: '今天的训练',
      title: '先说一句，今天就算开始',
      meta: '听原声 · 跟着说 · 说到 5 句可以停',
      href: './today.html',
    };
  }

  function buildHeader(name) {
    const wrap = el('section', 'lx-home-app');
    wrap.setAttribute('aria-label', '今天');

    const hello = el('div', 'lx-home-hello');
    hello.append(
      el('p', 'lx-home-hello-sub', greeting(new Date())),
      el('h1', 'lx-home-hello-title', name ? `${name}，今天练点什么？` : '今天练点什么？')
    );

    const target = continueTarget();
    const card = el('a', 'lx-home-continue');
    card.href = target.href;
    card.setAttribute('data-track', 'home_app_continue');
    const copy = el('span', 'lx-home-continue-copy');
    copy.append(
      el('span', 'lx-home-continue-kicker', target.kicker),
      el('span', 'lx-home-continue-title', target.title),
      el('span', 'lx-home-continue-meta', target.meta)
    );
    const go = el('span', 'lx-home-continue-go');
    go.setAttribute('aria-hidden', 'true');
    go.innerHTML = icon('play', 22);
    card.append(copy, go);

    const grid = el('nav', 'lx-home-tiles');
    grid.setAttribute('aria-label', '练习入口');
    TILES.forEach((tile) => {
      const link = el('a', 'lx-home-tile');
      link.href = tile.href;
      link.setAttribute('data-track', `home_app_tile_${tile.icon}`);
      const glyph = el('span', 'lx-home-tile-icon');
      glyph.setAttribute('aria-hidden', 'true');
      glyph.innerHTML = icon(tile.icon, 24);
      link.append(glyph, el('span', 'lx-home-tile-label', tile.label));
      grid.appendChild(link);
    });

    const moreTitle = el('h2', 'lx-home-section-title', '社区与计划');
    wrap.append(hello, card, grid);
    return { wrap, moreTitle };
  }

  function isSignedIn(doc) {
    const info = doc.getElementById('user-info');
    return Boolean(info && !info.hidden);
  }

  function mountHeaderMenu(doc) {
    const bar = doc.querySelector('body > nav.navbar');
    if (!bar || !root.LxCompactNav) return null;
    const workbench = doc.getElementById('nav-workbench-link');
    if (workbench) workbench.setAttribute('data-compact-icon', 'settings');
    const vip = doc.getElementById('vip-badge');
    if (vip) {
      vip.setAttribute('data-compact-label', '会员');
      vip.setAttribute('data-compact-icon', 'crown');
    }
    const info = doc.getElementById('user-info');
    if (info) info.setAttribute('data-compact-dissolve', '');
    const logout = doc.getElementById('logout-btn');
    if (logout) logout.setAttribute('data-compact-icon', 'back');
    return root.LxCompactNav.mount({
      bar,
      keep: ['.logo'],
      hide: ['#nav-links', '#guest-actions', '#user-display-name', '#level-switch'],
      sheet: ['#nav-workbench-link', '#vip-badge', '#logout-btn'],
    });
  }

  function mountBottomNav(doc, menu) {
    const nav = el('nav', 'lx-home-bottom-nav');
    nav.setAttribute('aria-label', '主导航');
    [
      { label: '首页', icon: 'home', href: './index-desktop.html', current: true },
      { label: '今日', icon: 'play', href: './today.html' },
      { label: '词汇', icon: 'book', href: './video-vocabulary-desktop.html' },
      { label: '我的', icon: 'users' },
    ].forEach((item) => {
      const node = el(item.href ? 'a' : 'button', 'lx-home-bottom-item');
      if (item.href) node.href = item.href;
      else {
        node.type = 'button';
        node.setAttribute('aria-haspopup', 'dialog');
        node.addEventListener('click', () => menu && menu.open());
      }
      if (item.current) node.setAttribute('aria-current', 'page');
      const glyph = el('span', 'lx-home-bottom-icon');
      glyph.setAttribute('aria-hidden', 'true');
      glyph.innerHTML = icon(item.icon, 22);
      node.append(glyph, el('span', '', item.label));
      nav.appendChild(node);
    });
    doc.body.appendChild(nav);
  }

  function install() {
    const doc = document;
    const media = root.matchMedia(COMPACT_QUERY);
    let built = null;
    let menu = null;

    function apply() {
      const active = media.matches && isSignedIn(doc);
      doc.documentElement.classList.toggle('lx-app-home', active);
      if (menu) menu.setEnabled(active);
      if (!active) return;
      const nameEl = doc.getElementById('user-display-name');
      const name = nameEl ? nameEl.textContent.trim() : '';
      if (built) {
        const title = built.wrap.querySelector('.lx-home-hello-title');
        title.textContent = name ? `${name}，今天练点什么？` : '今天练点什么？';
        return;
      }
      const anchor = doc.getElementById('daily-task');
      if (!anchor || !anchor.parentNode) return;
      built = buildHeader(name);
      anchor.parentNode.insertBefore(built.wrap, anchor);
      const community = doc.getElementById('community');
      if (community && community.parentNode) community.parentNode.insertBefore(built.moreTitle, community);
      menu = mountHeaderMenu(doc);
      mountBottomNav(doc, menu);
    }

    apply();
    const info = doc.getElementById('user-info');
    if (info && root.MutationObserver) {
      new MutationObserver(apply).observe(info, { attributes: true, attributeFilter: ['hidden'], childList: true, characterData: true, subtree: true });
    }
    if (typeof media.addEventListener === 'function') media.addEventListener('change', apply);
  }

  root.LxHomeApp = { greeting, TILES };
  if (root.document) {
    if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', install);
    else install();
  }
})(typeof window !== 'undefined' ? window : globalThis);
