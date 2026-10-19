/* 从页面 A 进入页面 B：返回按钮回到 A。没有站内上一页时，沿用链接自己的地址。 */
(function () {
  if (window.__linglishNavBack) return;
  window.__linglishNavBack = true;

  var PHRASES = {
    '返回': 1,
    '返回首页': 1,
    '返回主页': 1,
    '←返回': 1,
    '←返回首页': 1,
    '←返回主页': 1,
    'Back': 1,
    '←Back': 1,
    '←BacktoApp': 1,
    'BacktoApp': 1,
    'BacktoHome': 1,
    'Backtolearning': 1
  };

  function flat(value) {
    return String(value || '').replace(/\s+/g, '');
  }

  function skipHref(el) {
    if (!el || el.tagName !== 'A') return false;
    var href = el.getAttribute('href');
    if (href == null) return true;
    href = href.trim();
    return !href || href === '#' || href.charAt(0) === '#' || /^javascript:/i.test(href);
  }

  function isBackControl(el) {
    if (!el || el.dataset.nav === 'home' || el.dataset.nav === 'manual') return false;
    if (el.dataset.nav === 'back') return !skipHref(el);
    if (el.classList && (el.classList.contains('brand') || el.classList.contains('logo') || el.classList.contains('wb-brand'))) return false;
    var text = flat(el.textContent);
    var aria = flat(el.getAttribute('aria-label'));
    var title = flat(el.getAttribute('title'));
    var label = aria || text;
    if (!PHRASES[label] && (text === '←' || text === '‹' || text === '') && PHRASES[title]) label = title;
    if (!PHRASES[label]) return false;
    if (skipHref(el)) return false;
    if (el.tagName === 'BUTTON' && label !== '返回首页' && label !== '返回主页' && label !== '←返回首页' && label !== '←返回主页') return false;
    return true;
  }

  function cameFromHere() {
    try {
      var ref = document.referrer;
      if (!ref) return false;
      return new URL(ref).origin === window.location.origin && window.history.length > 1;
    } catch (err) {
      return false;
    }
  }

  document.addEventListener('click', function (event) {
    if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    var el = event.target && event.target.closest ? event.target.closest('a, button') : null;
    if (!isBackControl(el) || !cameFromHere()) return;
    event.preventDefault();
    event.stopPropagation();
    window.history.back();
  }, true);
})();
