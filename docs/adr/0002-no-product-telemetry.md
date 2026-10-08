---
type: adr
title: ADR-0002 — Send no product telemetry
description: Removes anonymous usage telemetry from the TypeScript port and keeps it out when porting upstream changes.
owner: '@unadlib'
status: accepted
risk_level: medium
tags: [privacy, telemetry, compatibility]
---

## Context

The Python upstream reports anonymous usage telemetry to its own PostHog
project, enabled by default and disabled with `ANONYMIZED_TELEMETRY=false`.
This repository had ported that client with the upstream project key, so
agent runs, MCP client calls, and MCP server activity from this unofficial
TypeScript port were reported to the official project's analytics. Agent
events included the task, action history, visited URLs, and the final result.

This port is maintained independently of the official project. Sending its
users' usage data to a third party's analytics misattributes the data, implies
an affiliation that does not exist, and is not something users of this package
expect.

## Decision

- The package sends no product telemetry. The PostHog client, the telemetry
  module and its `browser-use/telemetry` export, and the
  `ANONYMIZED_TELEMETRY` setting are removed.
- `ChatBrowserUse` sends `anonymized_telemetry: false` with each request, so
  the hosted service is asked not to collect telemetry for this client.
- Cloud sync is unaffected: it remains an explicit feature that only sends
  agent events after the user signs in to Browser Use Cloud and passes a sync
  instance. `BROWSER_USE_CLOUD_SYNC` now defaults to `true` on its own instead
  of following the removed telemetry setting.
- When porting upstream changes, skip telemetry clients, events, and settings.

## Consequences

- Breaking for code that imported `browser-use/telemetry`,
  `ProductTelemetry`, `productTelemetry`, or the telemetry event classes from
  the package root. No replacement is provided.
- Setting `ANONYMIZED_TELEMETRY` has no effect.
- Usage of this port cannot be measured from telemetry; feedback comes from
  issues and download statistics instead.

## Verification

- `grep -ri posthog src` finds nothing, and `posthog-node` is no longer a
  dependency.
- `test/llm-browser-use-alignment.test.ts` checks that `ChatBrowserUse`
  requests carry `anonymized_telemetry: false`.
