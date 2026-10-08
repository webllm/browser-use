---
type: adr
title: ADR-0003 — Launch local browsers on a persistent profile
description: Local browsers run in a Playwright persistent context so user_data_dir persists and default extensions run, matching the Python library's behavior.
owner: '@unadlib'
status: accepted
risk_level: medium
tags: [browser, compatibility, extensions]
---

## Context

The Python library starts Chrome itself with `--user-data-dir` and connects
over CDP, using the browser's default context. As a result:

- a configured `user_data_dir` keeps cookies and logins between sessions;
- with no `user_data_dir`, each session gets a fresh temporary profile;
- the default extensions run on the pages the agent opens, in headless mode
  too, because headless runs use the full Chromium build in new headless mode.

This port launched local browsers with `chromium.launch()` and
`browser.newContext()`. That creates an incognito-like context on a temporary
profile owned by Playwright, so `user_data_dir` was ignored, the default
extensions never ran on agent pages (Playwright only runs extensions in
persistent contexts), and headless runs used the headless shell build, which
cannot run extensions at all.

## Decision

- Local launches use `chromium.launchPersistentContext()` on the profile
  directory. The session keeps the context's `Browser` as `browser`.
- `BrowserProfile.user_data_dir` defaults to `null`, as upstream. A session
  without one launches on a new `browser-use-user-data-dir-*` directory and
  deletes it when the session shuts down.
- If the configured profile is held by another browser (a live
  `SingletonLock`, or a launch error saying the profile is in use), the session
  falls back to a temporary profile and logs a warning.
- Headless launches that load extensions and set no `channel` or
  `executable_path` use the full Chromium build (`channel: 'chromium'`) when
  it is installed. Without extensions they keep the headless shell, which
  starts about twice as fast.
- `storage_state` cannot be passed to a persistent launch. A storage state file
  is loaded by `StorageStateWatchdog` once the browser connects; an in-memory
  object is applied right after launch.
- Remote browsers (`cdp_url`, `wss_url`, or a browser PID) are unchanged.

We keep Playwright's launcher rather than copying upstream's own Chrome
subprocess and CDP connection: a persistent context gives the same profile
behavior while keeping every context option (viewport, user agent,
permissions, headers, downloads) that Playwright applies at launch.

## Consequences

- Sessions with `user_data_dir` now persist cookies and logins there. This
  includes the MCP server's default profile,
  `~/.config/browseruse/profiles/default`.
- Code that read the old default `user_data_dir` path from a new
  `BrowserProfile` now gets `null`.
- Headless runs with extensions use more memory and start more slowly than
  with the headless shell, as upstream's do.
- A session that is never stopped or killed leaves its temporary profile
  behind, as upstream does.

## Verification

- `test/browser-persistent-profile.test.ts` launches real browsers to check
  that cookies survive a restart with the same `user_data_dir`, that default
  sessions do not share data and delete their profiles, that a storage state
  file still loads, and that default extensions run on agent pages headlessly.
- `test/browser-session.test.ts` covers the launch arguments, the temporary
  profile cleanup, the profile-in-use fallback, and the lock check.
