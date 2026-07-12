export const MAX_SMART_SCROLL_ELEMENTS = 10_000;

export const SMART_SCROLL_JS = `(dy) => {
  const bigEnough = (element) =>
    element.clientHeight >= window.innerHeight * 0.5;
  const canScroll = (element) =>
    element &&
    /(auto|scroll|overlay)/.test(getComputedStyle(element).overflowY) &&
    element.scrollHeight > element.clientHeight &&
    bigEnough(element);

  let element = document.activeElement;
  while (
    element &&
    !canScroll(element) &&
    element !== document.body
  ) {
    element = element.parentElement;
  }

  if (!canScroll(element)) {
    element = null;
    const root = document.body || document.documentElement;
    if (root && typeof document.createTreeWalker === 'function') {
      const walker = document.createTreeWalker(
        root,
        NodeFilter.SHOW_ELEMENT
      );
      let visited = 0;
      let candidate = walker.nextNode();
      while (candidate && visited < ${MAX_SMART_SCROLL_ELEMENTS}) {
        visited += 1;
        if (canScroll(candidate)) {
          element = candidate;
          break;
        }
        candidate = walker.nextNode();
      }
    }
  }

  element =
    element ||
    document.scrollingElement ||
    document.documentElement;
  if (
    element === document.scrollingElement ||
    element === document.documentElement ||
    element === document.body
  ) {
    window.scrollBy(0, dy);
  } else {
    element.scrollBy(0, dy);
  }
}`;
