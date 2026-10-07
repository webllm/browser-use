# Browser

```typescript
import { BrowserProfile, BrowserSession } from 'browser-use';
```

## Profile options

| Option                     | Default                 | Notes                                                                     |
| -------------------------- | ----------------------- | ------------------------------------------------------------------------- |
| `headless`                 | auto                    | `BROWSER_USE_HEADLESS` sets the default                                   |
| `user_data_dir`            | Browser Use profile dir | `null` for a throwaway profile                                            |
| `viewport` / `window_size` | auto                    | `{ width, height }`                                                       |
| `allowed_domains`          | none                    | Patterns like `example.com`, `*.example.com`                              |
| `prohibited_domains`       | none                    | Blocklist patterns                                                        |
| `block_ip_addresses`       | `false`                 | Refuse navigation to raw IPs                                              |
| `downloads_path`           | temp dir                | Where downloads are saved                                                 |
| `proxy`                    | none                    | `{ server, username, password }`                                          |
| `viewport_expansion`       | `500`                   | Pixels beyond the viewport included in DOM state; `-1` for the whole page |
| `highlight_elements`       | `true`                  | Draw index labels on the page                                             |
| `keep_alive`               | `false`                 | Keep the browser open after the agent finishes                            |

## Sessions

```typescript
// Launch and own a browser.
const session = new BrowserSession({
  browser_profile: new BrowserProfile({ headless: true, user_data_dir: null }),
});
await session.start();
await session.navigate_to('https://example.com');
const page = await session.get_current_page(); // Playwright Page
await session.kill();

// Attach to a running Chromium with remote debugging.
const remote = new BrowserSession({ cdp_url: 'http://localhost:9222' });

// Wrap an existing Playwright browser, context, and page.
const wrapped = new BrowserSession({ browser, browser_context: context, page });
await wrapped.start();
```

Useful methods: `navigate_to(url)`, `create_new_tab(url)`,
`switch_to_tab(tabId)`, `close_tab(tabId)`, `get_tabs_info()`,
`get_browser_state_with_recovery()`, `take_screenshot()`, `go_back()`,
`refresh()`, and `get_downloaded_files()`.

## Browser Use Cloud browsers

```typescript
import { CloudBrowserClient } from 'browser-use/browser/cloud';

const cloud = new CloudBrowserClient(); // reads BROWSER_USE_API_KEY
const created = await cloud.create_browser({});
const session = new BrowserSession({ cdp_url: created.cdpUrl });
try {
  await session.start();
  // ...
} finally {
  await session.kill();
  await cloud.stop_browser(created.id);
}
```
