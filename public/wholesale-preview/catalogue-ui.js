// Local catalogue controls. Ordering, prices and identity checks stay in wholesale.js.
export function createCoffeeChoices({ allowed, locked }) {
  const menu = document.createElement('div');
  menu.id = 'coffee-choice-menu'; menu.className = 'coffee-choice-menu';
  menu.setAttribute('popover', 'auto'); menu.setAttribute('role', 'menu');
  document.body.append(menu);
  let opener = null, choose = null, pressedOpenTrigger = false;
  document.addEventListener('pointerdown', event => { pressedOpenTrigger = menu.matches(':popover-open') && !!opener?.contains(event.target); }, true);
  function position() {
    if (!opener?.isConnected) return;
    const box = opener.getBoundingClientRect(), width = Math.min(300, innerWidth - 24);
    menu.style.width = width + 'px'; menu.style.maxHeight = Math.max(80, innerHeight - 32) + 'px';
    menu.style.left = Math.max(12, Math.min(box.right - width, innerWidth - width - 12)) + 'px';
    const height = menu.offsetHeight || 180, below = innerHeight - box.bottom - 16, above = box.top - 16;
    const down = below >= height + 8 || below >= above;
    menu.dataset.side = down ? 'below' : 'above';
    menu.style.top = Math.max(12, Math.min(down ? box.bottom + 8 : box.top - height - 8, innerHeight - height - 12)) + 'px';
  }
  function close(focus = false) {
    const previous = opener;
    if (menu.matches(':popover-open')) menu.hidePopover();
    previous?.setAttribute('aria-expanded', 'false');
    if (focus && previous?.isConnected && !locked()) previous.focus({ preventScroll: true });
  }
  function open(button, { title, options, selected, onChoose }) {
    if (!allowed()) return;
    if (pressedOpenTrigger && opener === button) { pressedOpenTrigger = false; close(true); return; }
    pressedOpenTrigger = false;
    if (menu.matches(':popover-open') && opener === button) { close(true); return; }
    close(); opener = button; choose = onChoose;
    const caption = document.createElement('p'); caption.className = 'coffee-choice-caption'; caption.textContent = title;
    menu.replaceChildren(caption); menu.setAttribute('aria-label', title);
    for (const option of options) {
      const item = document.createElement('button'); item.type = 'button';
      item.dataset.choice = option.id; item.setAttribute('role', 'menuitemradio');
      item.setAttribute('aria-checked', String(option.id === selected));
      const copy = document.createElement('span'), label = document.createElement('strong'); label.textContent = option.label; copy.append(label);
      if (option.hint) { const hint = document.createElement('small'); hint.textContent = option.hint; copy.append(hint); }
      const check = document.createElement('span'); check.className = 'coffee-choice-check'; check.textContent = '✓'; check.setAttribute('aria-hidden', 'true');
      item.append(copy, check); menu.append(item);
    }
    opener.setAttribute('aria-expanded', 'true'); menu.showPopover(); position();
  }
  menu.addEventListener('beforetoggle', event => {
    if (event.newState === 'open' && !allowed()) { event.preventDefault(); return; }
    opener?.setAttribute('aria-expanded', String(event.newState === 'open'));
  });
  menu.addEventListener('toggle', event => {
    if (event.newState !== 'open' || !menu.matches(':popover-open')) return;
    position(); menu.querySelector('[aria-checked="true"]')?.focus({ preventScroll: true });
  });
  menu.addEventListener('click', event => {
    const item = event.target.closest('[data-choice]');
    if (!item || !allowed()) return;
    choose?.(item.dataset.choice); close(true);
  });
  menu.addEventListener('keydown', event => {
    const items = [...menu.querySelectorAll('button')], index = items.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : event.key === 'ArrowDown' ? (index + 1) % items.length : event.key === 'ArrowUp' ? (index + items.length - 1) % items.length : null;
    if (next !== null) { event.preventDefault(); items[next]?.focus(); }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
  });
  window.addEventListener('resize', () => { if (menu.matches(':popover-open')) position(); });
  window.addEventListener('scroll', event => { if (menu.matches(':popover-open') && !menu.contains(event.target)) position(); }, true);
  return { open, close, clear() { close(); opener = choose = null; menu.replaceChildren(); } };
}

export function setupCatalogueSearch() {
  const root = document.querySelector('#catalogue-search'), field = root.querySelector('.search-field');
  const input = root.querySelector('input'), toggle = document.querySelector('#search-toggle'), dismiss = document.querySelector('#search-close');
  const phone = matchMedia('(max-width:700px)');
  function sync() { field.inert = !phone.matches && !root.classList.contains('is-open'); }
  function open(focus = true) {
    root.classList.add('is-open'); toggle.setAttribute('aria-expanded', 'true'); dismiss.hidden = false; sync();
    if (focus) input.focus({ preventScroll: true });
  }
  function close({ clear = false, focus = false } = {}) {
    if (clear) { input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); }
    root.classList.remove('is-open'); toggle.setAttribute('aria-expanded', 'false'); dismiss.hidden = true; sync();
    if (focus && !phone.matches) toggle.focus({ preventScroll: true });
  }
  input.addEventListener('focus', () => open(false));
  toggle.addEventListener('click', () => open());
  dismiss.addEventListener('click', () => close({ clear: true, focus: true }));
  root.addEventListener('keydown', event => { if (event.key === 'Escape' && !phone.matches) { event.preventDefault(); event.stopPropagation(); close({ clear: true, focus: true }); } });
  root.addEventListener('focusout', () => requestAnimationFrame(() => { if (!phone.matches && !root.contains(document.activeElement) && !input.value) close(); }));
  document.addEventListener('pointerdown', event => { if (!phone.matches && !root.contains(event.target) && !input.value) close(); }, true);
  phone.addEventListener('change', () => { if (input.value || document.activeElement === input) open(false); else sync(); });
  sync(); return { open, close, sync };
}
