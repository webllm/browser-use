export const MAX_BROWSER_STATE_URL_CHARS = 16 * 1024;
export const MAX_BROWSER_STATE_TITLE_CHARS = 4 * 1024;
export const MAX_BROWSER_STATE_TABS = 100;
export const MAX_BROWSER_STATE_MESSAGE_CHARS = 8 * 1024;
export const MAX_BROWSER_STATE_MESSAGES = 20;
export const MAX_BROWSER_STATE_RECENT_EVENTS_CHARS = 64 * 1024;
export const MAX_BROWSER_STATE_NETWORK_REQUESTS = 20;
export const MAX_BROWSER_STATE_PAGINATION_BUTTONS = 100;

export const boundBrowserStateText = (
  value: unknown,
  maxChars: number
): string => {
  if (typeof value !== 'string') return '';
  const boundedMaxChars = Number.isFinite(maxChars)
    ? Math.max(0, Math.floor(maxChars))
    : 0;
  return value.slice(0, boundedMaxChars);
};

export const boundBrowserStateUrl = (value: unknown): string =>
  boundBrowserStateText(value, MAX_BROWSER_STATE_URL_CHARS);

export const boundBrowserStateTitle = (value: unknown): string =>
  boundBrowserStateText(value, MAX_BROWSER_STATE_TITLE_CHARS);

export const readBoundedPageTitle = async (page: {
  locator?: (selector: string) => {
    evaluate?: (...args: any[]) => Promise<unknown>;
  };
  title?: () => Promise<unknown>;
}): Promise<string> => {
  if (typeof page.locator === 'function') {
    try {
      const root = page.locator(':root');
      const title = await root.evaluate?.(
        (_root: Element, maxChars: number) => {
          const value =
            typeof document.title === 'string' ? document.title : '';
          return value.slice(0, maxChars);
        },
        MAX_BROWSER_STATE_TITLE_CHARS
      );
      if (typeof title === 'string') {
        return boundBrowserStateTitle(title);
      }
    } catch {
      // Fall back to the browser adapter title API below.
    }
  }

  if (typeof page.title === 'function') {
    const title = await page.title();
    return boundBrowserStateTitle(title);
  }
  return '';
};
