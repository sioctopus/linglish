(function () {
  const roots = Array.from(document.querySelectorAll('.upload-switch'));
  if (!roots.length) return;

  function bindSwitch(root) {
    const trigger = root.querySelector('.upload-switch-trigger');
    const menu = root.querySelector('.upload-switch-menu');
    if (!trigger || !menu) return null;

    function setMenuOpen(open) {
      menu.hidden = !open;
      trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
    }

    trigger.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const willOpen = menu.hidden;
      roots.forEach((other) => {
        if (other === root || typeof other.__setMenuOpen !== 'function') return;
        other.__setMenuOpen(false);
      });
      setMenuOpen(willOpen);
    });

    document.addEventListener('click', (event) => {
      if (!root.contains(event.target)) setMenuOpen(false);
    });

    menu.addEventListener('click', () => setMenuOpen(false));
    root.__setMenuOpen = setMenuOpen;
    return setMenuOpen;
  }

  const closers = roots.map(bindSwitch).filter(Boolean);
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    closers.forEach((close) => close(false));
  });
})();
