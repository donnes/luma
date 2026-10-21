// Injected by WebAppActivity into T3 Code's web client on every page load.
// Runs twice per load (commit and finish), so everything is idempotent.
(() => {
  // Too early in the load; onPageFinished runs this again.
  if (!document.head) return;
  // Lay the page out 1280px wide; the WebView scales it to the 1080p screen,
  // so T3 Code's desktop layout reads at 1.5x from the couch.
  const VIEWPORT = 'width=1280';
  let meta = document.querySelector('meta[name="viewport"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'viewport';
    document.head.append(meta);
  }
  if (meta.content !== VIEWPORT) meta.content = VIEWPORT;

  if (!document.getElementById('luma-tv')) {
    const style = document.createElement('style');
    style.id = 'luma-tv';
    style.textContent = window.__lumaTVCSS || '';
    document.head.append(style);
  }
  document.documentElement.classList.add('luma-tv');

  if (window.__lumaTV) return;
  window.__lumaTV = true;

  // --- Pairing ---------------------------------------------------------------
  // The server sends unpaired browsers to /pair. An empty token field there
  // means the session is gone, so Luma mints a new code and opens the page
  // again. The activity ignores this while it's handing a code over itself.
  setInterval(() => {
    const token = document.getElementById('pairing-token');
    if (location.pathname === '/pair' && token && !token.value) window.LumaWeb?.repair();
  }, 1000);

  // --- D-pad navigation --------------------------------------------------------
  const FOCUSABLE = [
    'a[href]',
    'button:not([disabled])',
    'input:not([type="hidden"]):not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[contenteditable="true"]',
    '[tabindex]:not([tabindex="-1"])',
    '[role="button"]',
    '[role="menuitem"]',
    '[role="menuitemradio"]',
    '[role="menuitemcheckbox"]',
    '[role="option"]',
    '[role="tab"]',
    '[role="switch"]',
    '[role="checkbox"]',
    '[role="radio"]',
  ].join(',');
  // Out of the tab order on purpose: drag handles, and the inactive items of
  // roving-focus groups, which are entered through their active item.
  const SKIP = '[tabindex="-1"]';
  // Non-modal dialogs (toasts like "Update available") don't take over the remote.
  const LAYERS =
    ':is([role="dialog"],[role="alertdialog"]):not([aria-modal="false"]),[role="menu"],[role="listbox"]';
  const KEYS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };

  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
  };

  // Dialogs and menus trap focus like they do for a keyboard: only the
  // topmost open one is navigable.
  const scope = () => {
    const layers = [...document.querySelectorAll(LAYERS)].filter(visible);
    return layers.at(-1) || document.body;
  };

  const candidates = (root) =>
    [...root.querySelectorAll(FOCUSABLE)].filter(
      (el) => !el.matches(SKIP) && !el.closest('[aria-hidden="true"],[inert]') && visible(el),
    );

  const isText = (el) =>
    el instanceof HTMLTextAreaElement ||
    el?.isContentEditable ||
    (el instanceof HTMLInputElement &&
      !['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'file', 'color'].includes(
        el.type,
      ));

  // Arrows edit text until the caret reaches the edge they point past.
  const keepsKey = (el, dir) => {
    if (!isText(el)) return false;
    if (el instanceof HTMLInputElement && (dir === 'up' || dir === 'down')) return false;
    const backward = dir === 'up' || dir === 'left';
    if (el.isContentEditable) {
      // Rich editors (the composer): is there text between the caret and that edge?
      const selection = getSelection();
      if (!selection?.rangeCount) return false;
      const caret = selection.getRangeAt(0);
      const rest = document.createRange();
      rest.selectNodeContents(el);
      if (backward) rest.setEnd(caret.startContainer, caret.startOffset);
      else rest.setStart(caret.endContainer, caret.endOffset);
      return rest.toString().length > 0;
    }
    const { selectionStart, selectionEnd, value } = el;
    // Some input types (email, number) expose no caret.
    if (selectionStart === null) return dir === 'left' || dir === 'right';
    return backward ? selectionStart > 0 : selectionEnd < value.length;
  };

  const distance = (from, to, dir) => {
    const horizontal = dir === 'left' || dir === 'right';
    const ahead =
      dir === 'right'
        ? to.left - from.right
        : dir === 'left'
          ? from.left - to.right
          : dir === 'down'
            ? to.top - from.bottom
            : from.top - to.bottom;
    if (ahead < -4) return Infinity;
    // Gap between the two rects across the direction of travel; 0 when they line up.
    const across = horizontal
      ? Math.max(0, from.top - to.bottom, to.top - from.bottom)
      : Math.max(0, from.left - to.right, to.left - from.right);
    return Math.max(0, ahead) + across * 3;
  };

  const scrollable = (el) => {
    for (let node = el; node && node !== document.body; node = node.parentElement) {
      const { overflowY } = getComputedStyle(node);
      if (/(auto|scroll)/.test(overflowY) && node.scrollHeight > node.clientHeight + 1) return node;
    }
    return document.scrollingElement;
  };

  const focus = (el) => {
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };

  const move = (dir) => {
    const root = scope();
    const items = candidates(root);
    const current = document.activeElement;
    const focused = current && current !== document.body && root.contains(current);
    // Nothing focused yet: start from the middle of the screen (or the open
    // dialog), so the first press lands near where the eye already is.
    const area = root === document.body ? null : root.getBoundingClientRect();
    const x = area ? (area.left + area.right) / 2 : innerWidth / 2;
    const y = area ? (area.top + area.bottom) / 2 : innerHeight / 2;
    const from = focused
      ? current.getBoundingClientRect()
      : { left: x, right: x, top: y, bottom: y };
    let best = null;
    let bestScore = Infinity;
    for (const el of items) {
      if (focused && (el === current || el.contains(current) || current.contains(el))) continue;
      const score = distance(from, el.getBoundingClientRect(), dir);
      if (score < bestScore) {
        best = el;
        bestScore = score;
      }
    }
    if (best) {
      focus(best);
      return;
    }
    if (!focused) {
      if (items[0]) focus(items[0]);
      return;
    }
    // Nothing further that way: scroll long content (chat logs) instead.
    if (dir === 'up' || dir === 'down') {
      const box = scrollable(current);
      box?.scrollBy({ top: (dir === 'up' ? -1 : 1) * box.clientHeight * 0.6, behavior: 'smooth' });
    }
  };

  // Widgets that move focus with arrows themselves. They get the key first;
  // if focus stays put (an edge of the widget), the D-pad moves on.
  const COMPOSITE =
    '[role="menu"],[role="menubar"],[role="listbox"],[role="tablist"],[role="radiogroup"],' +
    '[role="grid"],[role="tree"],[role="toolbar"],[role="slider"],[aria-activedescendant],' +
    '[aria-expanded="true"][aria-haspopup]';

  // Capture phase: dialogs stop arrow keys from bubbling to the window.
  window.addEventListener(
    'keydown',
    (event) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      const active = document.activeElement;
      const dir = KEYS[event.key];
      if (!dir || keepsKey(active, dir)) return;
      if (active?.closest(COMPOSITE)) {
        setTimeout(() => {
          if (document.activeElement === active) move(dir);
        });
        return;
      }
      // The D-pad owns this key: menu buttons would also open on ArrowDown.
      event.preventDefault();
      event.stopPropagation();
      move(dir);
    },
    true,
  );

  // --- Back ------------------------------------------------------------------
  // Returns true when the page handled Back; false lets the activity close.
  // The activity says whether there's history: it forgets the pairing pages.
  window.__lumaBack = (canGoBack) => {
    const active = document.activeElement;
    const layer = [...document.querySelectorAll(LAYERS)].filter(visible).at(-1);
    if (layer) {
      (layer.contains(active) ? active : layer).dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          code: 'Escape',
          keyCode: 27,
          bubbles: true,
          cancelable: true,
        }),
      );
      return true;
    }
    if (canGoBack) {
      history.back();
      return true;
    }
    return false;
  };
})();
