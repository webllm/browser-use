#!/usr/bin/env tsx
/**
 * Reproduces the bu-2-0 model bug where it emits `{input_text: {index: true}}`
 * instead of `{index: <integer>}` on multi-action batches involving login forms.
 *
 * Pydantic in upstream python silently coerces `True -> 1` (lax mode default),
 * masking this bug. zod in TS rejects strictly.
 *
 * Usage:
 *   BROWSER_USE_API_KEY=bu_... tsx test/fixtures/repro-boolean-index-bug.ts
 *
 * Exit code 0 = bug reproduced; 1 = bug NOT reproduced (or HTTP error).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(HERE, 'bu-2-0-boolean-index-bug.json');
const ENDPOINT = 'https://llm.api.browser-use.com/v1/chat/completions';

function readRequestBody(): Record<string, unknown> {
  const raw = fs.readFileSync(FIXTURE_PATH, 'utf-8');
  const data = JSON.parse(raw);
  const body = data?.request?.body;
  if (!body || typeof body !== 'object' || !Array.isArray(body.messages) || !body.output_format) {
    throw new Error(`fixture at ${FIXTURE_PATH} missing required request.body fields (messages, output_format)`);
  }
  return body;
}

function findBuggyAction(completion: any): { actionName: string; params: any } | null {
  const actions = completion?.action;
  if (!Array.isArray(actions)) return null;
  for (const a of actions) {
    if (typeof a !== 'object' || a == null) continue;
    for (const [name, params] of Object.entries(a)) {
      if (params && typeof params === 'object' && typeof (params as any).index === 'boolean') {
        return { actionName: name, params };
      }
    }
  }
  return null;
}

async function main() {
  const apiKey = process.env.BROWSER_USE_API_KEY;
  if (!apiKey) {
    console.error('error: BROWSER_USE_API_KEY env var is required');
    process.exit(2);
  }

  const requestBody = readRequestBody();
  console.log(`POST ${ENDPOINT}`);
  console.log(`model=${requestBody.model}, messages.length=${(requestBody.messages as unknown[]).length}, request_type=${requestBody.request_type}`);

  const startedAt = Date.now();
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
  });

  const elapsedMs = Date.now() - startedAt;
  console.log(`HTTP ${response.status} in ${elapsedMs}ms`);

  if (!response.ok) {
    const txt = await response.text();
    console.error('non-2xx response body:');
    console.error(txt);
    process.exit(1);
  }

  const body = (await response.json()) as any;
  const completion = body?.completion ?? body?.result?.completion ?? body;
  const buggy = findBuggyAction(completion);

  const outPath = path.join(HERE, `repro-output-${Date.now()}.json`);
  fs.writeFileSync(
    outPath,
    JSON.stringify({ elapsedMs, httpStatus: response.status, completion, detectedBug: buggy }, null, 2),
  );
  console.log(`saved raw response to: ${outPath}`);

  if (buggy) {
    console.log('\nBUG REPRODUCED ✓');
    console.log(`  action=${buggy.actionName}`);
    console.log(`  params=${JSON.stringify(buggy.params)}`);
    console.log(`  index slot type=${typeof buggy.params.index} (expected number)`);
    process.exit(0);
  } else {
    console.log('\nBUG NOT REPRODUCED - model emitted valid integer indices this time');
    console.log(`completion.action: ${JSON.stringify(completion?.action ?? completion).slice(0, 500)}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('unexpected error:', err);
  process.exit(3);
});
