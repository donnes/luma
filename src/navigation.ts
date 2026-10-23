export type Direction = 'left' | 'right' | 'up' | 'down';

// Remote keys arrive as key codes: 461 is LG's Back, 10009 Samsung's. 457 is
// LG's Menu (≡). Samsung remotes send Tools (10135) or the red key (403, the
// same on LG), which Smart Remotes reach from their on-screen keypad. Fire TV
// forwards its Menu button as ContextMenu.
const backCodes = new Set([461, 10009]);
const menuCodes = new Set([457, 10135, 403]);

/** Takes DOM and React key events alike. */
export const isBackKey = (event: Pick<KeyboardEvent, 'key' | 'keyCode'>) =>
  event.key === 'Escape' || backCodes.has(event.keyCode);

/** The remote's Menu button, or M on a keyboard outside a text field. */
export const isMenuKey = (event: KeyboardEvent) =>
  event.key === 'ContextMenu' ||
  menuCodes.has(event.keyCode) ||
  (event.key.toLowerCase() === 'm' && !(event.target instanceof HTMLInputElement));

export interface FocusRect {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

// Rank by directional distance, with a strong preference for the same row or
// column. Geometry makes navigation work with grids, input cards and dialogs.
export function nextFocus(
  current: FocusRect,
  candidates: FocusRect[],
  direction: Direction,
): string | null {
  const horizontal = direction === 'left' || direction === 'right';
  const sign = direction === 'left' || direction === 'up' ? -1 : 1;
  const cx = current.x + current.width / 2;
  const cy = current.y + current.height / 2;
  let best: { id: string; score: number } | undefined;
  for (const item of candidates) {
    if (item.id === current.id) continue;
    const dx = item.x + item.width / 2 - cx;
    const dy = item.y + item.height / 2 - cy;
    const forward = (horizontal ? dx : dy) * sign;
    if (forward < 3) continue;
    const cross = Math.abs(horizontal ? dy : dx);
    const aligned = horizontal
      ? Math.abs(dy) < (current.height + item.height) / 2
      : Math.abs(dx) < (current.width + item.width) / 2;
    const score = forward + cross * 2.8 + (aligned ? 0 : 1200);
    if (!best || score < best.score) best = { id: item.id, score };
  }
  return best?.id ?? null;
}

interface FocusEntry {
  node: HTMLElement;
  rect: FocusRect;
}
interface FocusSnapshot {
  entries: FocusEntry[];
  rects: FocusRect[];
  main: HTMLElement | null;
  bounds: FocusRect;
  scrollTop: number;
  scrollLeft: number;
}

let snapshot: FocusSnapshot | null = null;
let observedScope: HTMLElement | Document | null = null;
let mutations: MutationObserver | undefined;
let sizes: ResizeObserver | undefined;
const invalidate = () => {
  snapshot = null;
};

function measureFocus(scope: HTMLElement | Document): FocusSnapshot {
  if (!mutations) {
    mutations = new MutationObserver(invalidate);
    sizes = new ResizeObserver(invalidate);
    window.addEventListener('resize', invalidate);
    window.addEventListener('scroll', invalidate, true);
    document.fonts.addEventListener('loadingdone', invalidate);
  }
  if (scope !== observedScope) {
    mutations.disconnect();
    sizes?.disconnect();
    mutations.observe(scope, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: [
        'class',
        'style',
        'hidden',
        'disabled',
        'data-focusable',
        'data-focus-up',
        'data-focus-down',
        'data-focus-left',
        'data-focus-right',
        'data-focus-scroll-top',
      ],
    });
    sizes?.observe(scope instanceof HTMLElement ? scope : document.documentElement);
    observedScope = scope;
    invalidate();
  }
  // Keyboard repeats can arrive before observer callbacks or scroll events.
  if (
    mutations.takeRecords().length ||
    (snapshot?.main &&
      (snapshot.main.scrollTop !== snapshot.scrollTop ||
        snapshot.main.scrollLeft !== snapshot.scrollLeft))
  )
    invalidate();
  if (snapshot) return snapshot;

  const entries: FocusEntry[] = [];
  for (const node of scope.querySelectorAll<HTMLElement>('[data-focusable]:not([disabled])')) {
    const box = node.getBoundingClientRect();
    if (!box.width || !box.height) continue;
    entries.push({
      node,
      rect: {
        id: node.dataset.focusable!,
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
      },
    });
  }
  const main = document.querySelector<HTMLElement>('main');
  const box = main?.getBoundingClientRect();
  if (main) sizes?.observe(main);
  snapshot = {
    entries,
    rects: entries.map((entry) => entry.rect),
    main,
    bounds: {
      id: 'viewport',
      x: box?.x ?? 0,
      y: box?.y ?? 0,
      width: box?.width ?? window.innerWidth,
      height: box?.height ?? window.innerHeight,
    },
    scrollTop: main?.scrollTop ?? 0,
    scrollLeft: main?.scrollLeft ?? 0,
  };
  return snapshot;
}

export function moveFocus(direction: Direction): void {
  const scope =
    document.querySelector<HTMLElement>('[data-focus-scope="dialog"]') ??
    document.querySelector('main')?.parentElement ??
    document;
  const measured = measureFocus(scope);
  const current = measured.entries.find((entry) => entry.node === document.activeElement);
  if (!current) {
    measured.entries[0]?.node.focus();
    return;
  }
  // Explicit entry/return routes take priority over geometry when a page has a
  // preferred control column. Left/right still follow the spatial layout.
  const route = current.node
    .closest(`[data-focus-${direction}]`)
    ?.getAttribute(`data-focus-${direction}`);
  const preferred = route ? measured.entries.find((entry) => entry.rect.id === route) : undefined;
  const target = preferred?.rect.id ?? nextFocus(current.rect, measured.rects, direction);
  const entry = preferred ?? measured.entries.find((entry) => entry.rect.id === target);
  if (entry) {
    entry.node.focus({ preventScroll: true });
    if (entry.node.closest('[data-focus-scroll-top="true"]'))
      measured.main?.scrollTo({ top: 0, behavior: 'instant' });
    const bounds = measured.main?.contains(entry.node)
      ? measured.bounds
      : { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
    let box = entry.rect;
    if (
      measured.main &&
      (measured.main.scrollTop !== measured.scrollTop ||
        measured.main.scrollLeft !== measured.scrollLeft)
    ) {
      const currentBox = entry.node.getBoundingClientRect();
      box = {
        id: entry.rect.id,
        x: currentBox.x,
        y: currentBox.y,
        width: currentBox.width,
        height: currentBox.height,
      };
      invalidate();
    }
    if (
      box.x < bounds.x ||
      box.y < bounds.y ||
      box.x + box.width > bounds.x + bounds.width ||
      box.y + box.height > bounds.y + bounds.height
    ) {
      entry.node.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
      invalidate();
    }
  }
}
