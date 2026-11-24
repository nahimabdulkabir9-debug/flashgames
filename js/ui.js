// =============================================================
// ui.js — small helpers for building the page safely.
//
// SAFETY RULE for the whole project: user text (nicknames, answers)
// is only ever put on the page with textContent, never innerHTML.
// textContent shows text as plain letters, so if someone types
// <script> as their name it just appears as the word "<script>".
// =============================================================

/**
 * Create an element in one line.
 *   el('button', { class: 'btn', onclick: go }, 'Start')
 * Strings in `children` become text nodes (safe for user input).
 */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2), value);
    } else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** Replace everything inside `container` with the given nodes. */
export function mount(container, ...nodes) {
  container.replaceChildren(...nodes.flat().filter(Boolean));
}

/** Show a short message at the bottom of the screen for a few seconds. */
export function toast(message, ms = 2500) {
  const box = document.getElementById('toast');
  box.textContent = message;
  box.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => box.classList.remove('show'), ms);
}

/**
 * Show a popup over the page. Returns a function that closes it.
 *   showModal({ title: 'Remove Alex?', body: [el('p', {}, '...')],
 *               actions: [{ label: 'Kick', onClick: doKick }, { label: 'Cancel' }] })
 * Every action closes the popup after running its onClick.
 */
export function showModal({ title, body = [], actions = [{ label: 'OK' }] }) {
  const previousFocus = document.activeElement;
  // Keep the page behind the dialog keyboard- and pointer-inert.
  const background = [...document.querySelectorAll('.topbar, #app')]
    .filter((node) => !node.hasAttribute('inert'));
  const close = () => {
    document.removeEventListener('keydown', onKeydown, true);
    overlay.remove();
    background.forEach((node) => node.removeAttribute('inert'));
    if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    else document.querySelector('#app button, #app a')?.focus?.();
  };
  const buttons = actions.map(({ label, onClick, style = '' }) =>
    el('button', {
      class: `btn ${style}`,
      type: 'button',
      onclick: () => { close(); if (onClick) onClick(); },
    }, label));
  const dialog = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title, tabindex: -1 },
    el('h2', {}, title),
    el('div', { class: 'modal-body' }, body),
    el('div', { class: 'stack' }, buttons));
  const overlay = el('div', {
    class: 'overlay',
    onclick: (event) => { if (event.target === overlay) close(); },
  }, dialog);

  // Keep keyboard focus inside the popup until it is closed.
  function focusable() {
    return [...dialog.querySelectorAll('button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
      .filter((node) => !node.disabled);
  }
  function onKeydown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    const items = focusable();
    if (!items.length) { event.preventDefault(); dialog.focus(); return; }
    const first = items[0]; const last = items[items.length - 1];
    if (!dialog.contains(document.activeElement)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault(); first.focus();
    }
  }

  document.body.append(overlay);
  background.forEach((node) => node.setAttribute('inert', ''));
  document.addEventListener('keydown', onKeydown, true);
  buttons[0]?.focus();
  return close;
}

/** Copy text to the clipboard. Returns true if it worked. */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older browsers: select the text in a hidden box and copy it.
    const box = el('textarea', { readonly: true, style: 'position:fixed;opacity:0' });
    box.value = text;
    document.body.append(box);
    box.select();
    const ok = document.execCommand('copy');
    box.remove();
    return ok;
  }
}
