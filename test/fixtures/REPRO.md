# Reproduction: bu-2-0 emits `{input_text: {index: true}}`

## What this shows

The browser-use cloud model `bu-2-0` occasionally emits a JSON boolean `true` in the `index` slot of `input_text` actions on multi-action batches involving login forms. This violates the documented schema (`index: integer >= 0`).

## Why upstream python doesn't catch it

`pydantic.model_validate()` in default lax mode silently coerces `True -> 1`, so the python agent types into element-index 1 (often visually close to the intended target on auth0-style login pages) and recovers via subsequent retries. The TypeScript port using zod rejects strictly, leading to the agent looping and force-quitting at `max_failures`.

## How to run

```bash
export BROWSER_USE_API_KEY=bu_...
tsx test/fixtures/repro-boolean-index-bug.ts
```

This replays the captured request from `bu-2-0-boolean-index-bug.json` against the live endpoint and checks the response for `index: <boolean>`.

## Expected output

If the bug reproduces:

```
BUG REPRODUCED ✓
  action=input_text
  params={"index":true,"text":"..."}
  index slot type=boolean (expected number)
```

If the bug doesn't reproduce on this attempt (model is non-deterministic), exit code 1.

## Files

- `bu-2-0-boolean-index-bug.json` — the captured request/response that originally surfaced the bug
- `repro-boolean-index-bug.ts` — replay script
- `repro-output-<timestamp>.json` — written on each run (response capture for sharing); gitignored
