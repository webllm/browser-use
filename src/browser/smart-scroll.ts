export const MAX_SMART_SCROLL_ELEMENTS = 10_000;

export const SMART_SCROLL_JS = `(dy) => {
  const bigEnough = (element) =>
    element.clientHeight >= window.innerHeight * 0.5;
  let remainingChecks = ${MAX_SMART_SCROLL_ELEMENTS};
  const canScroll = (element) => {
    if (!element || remainingChecks <= 0) return false;
    remainingChecks -= 1;
    return (
      /(auto|scroll|overlay)/.test(getComputedStyle(element).overflowY) &&
      element.scrollHeight > element.clientHeight &&
      bigEnough(element)
    );
  };

  let candidate = document.activeElement;
  let element = null;
  while (candidate && remainingChecks > 0) {
    if (canScroll(candidate)) {
      element = candidate;
      break;
    }
    if (candidate === document.body) break;
    candidate = candidate.parentElement;
  }

  if (!element && remainingChecks > 0) {
    const root = document.body || document.documentElement;
    if (root && typeof document.createTreeWalker === 'function') {
      const walker = document.createTreeWalker(
        root,
        NodeFilter.SHOW_ELEMENT
      );
      candidate = walker.nextNode();
      while (candidate && remainingChecks > 0) {
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
