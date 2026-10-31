(function () {
  'use strict';

  var body = document.body;
  if (!body || !body.classList.contains('lx-shell')) return;

  var STORAGE_RAIL = 'linglish_shell_rail';
  var menuBtn = document.getElementById('lx-shell-menu');
  var scrim = document.getElementById('lx-shell-scrim');
  var accountBtn = document.getElementById('lx-shell-account-btn');
  var accountMenu = document.getElementById('lx-shell-account-menu');

  function isDesktop() {
    return window.matchMedia('(min-width: 1024px)').matches;
  }

  function setOpen(open) {
    body.classList.toggle('lx-shell--open', open);
    if (menuBtn) menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function setRail(rail) {
    body.classList.toggle('lx-shell--rail', rail);
    try {
      localStorage.setItem(STORAGE_RAIL, rail ? '1' : '0');
    } catch (_) {}
  }

  function closeAccount() {
    if (accountMenu) accountMenu.hidden = true;
    if (accountBtn) accountBtn.setAttribute('aria-expanded', 'false');
  }

  if (menuBtn) {
    menuBtn.addEventListener('click', function () {
      if (isDesktop()) {
        setRail(!body.classList.contains('lx-shell--rail'));
        return;
      }
      setOpen(!body.classList.contains('lx-shell--open'));
    });
  }

  if (scrim) {
    scrim.addEventListener('click', function () {
      setOpen(false);
    });
  }

  if (accountBtn && accountMenu) {
    accountBtn.addEventListener('click', function (event) {
      event.stopPropagation();
      var next = accountMenu.hidden;
      accountMenu.hidden = !next;
      accountBtn.setAttribute('aria-expanded', next ? 'true' : 'false');
    });
    document.addEventListener('click', function (event) {
      if (!accountMenu.hidden && !accountMenu.contains(event.target) && event.target !== accountBtn) {
        closeAccount();
      }
    });
  }

  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;
    setOpen(false);
    closeAccount();
  });

  try {
    if (isDesktop()) {
      var storedRail = localStorage.getItem(STORAGE_RAIL);
      // Default to compact rail (online-like simple chrome). Explicit "0" keeps expanded.
      if (storedRail === null || storedRail === '1') setRail(true);
      else setRail(false);
    }
  } catch (_) {
    if (isDesktop()) setRail(true);
  }

  window.addEventListener('resize', function () {
    if (isDesktop()) setOpen(false);
  });

  var side = document.getElementById('lx-shell-side');
  if (side) {
    side.addEventListener('click', function (event) {
      var link = event.target.closest('a');
      if (link && !isDesktop()) setOpen(false);
    });
  }
})();
