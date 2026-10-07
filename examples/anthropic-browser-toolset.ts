/**
 * Build a Hacker News reading list with Claude's browser toolset, driven by
 * Browser Use, plus a bounded Bash tool for writing the deliverables.
 *
 * Requires ANTHROPIC_API_KEY and a POSIX host with /bin/bash.
 * Run: npx tsx examples/anthropic-browser-toolset.ts
 */

import Anthropic from '@anthropic-ai/sdk';
import { BrowserProfile } from '../src/browser/profile.js';
import {
  BrowserUseToolset,
  createBashTool,
  runBrowserToolsetConversation,
} from '../src/integrations/anthropic/index.js';

const TASK =
  'Read the first three Hacker News posts and save their titles and URLs to hacker-news.md and hacker-news.json.';

const SYSTEM_PROMPT = 'Complete the task with the browser tools and Bash.';

async function main() {
  const toolset = new BrowserUseToolset({
    // useCloud: true, // Uncomment and set BROWSER_USE_API_KEY to use Browser Use Cloud.
    browserProfile: new BrowserProfile({ headless: false }),
    // These members are disabled by default.
    configs: {
      javascript_exec: { enabled: true },
      file_upload: { enabled: true },
      read_console: { enabled: true },
      read_network: { enabled: true },
    },
    // file_upload may only read local files from these directories.
    uploadRoots: ['uploads', 'outputs'],
  });
  const bash = createBashTool({ outputDir: 'outputs' });
  const client = new Anthropic();

  try {
    const { message } = await runBrowserToolsetConversation({
      client,
      toolset,
      tools: [bash],
      model: 'claude-opus-5-5',
      maxTokens: 32_768,
      maxIterations: 100,
      system: SYSTEM_PROMPT,
      task: TASK,
      onToolResult: (result, toolUse) => {
        console.log(`${toolUse.name}${result.is_error ? ' (failed)' : ''}`);
      },
    });
    console.log(
      message.content
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('\n')
    );
  } finally {
    await toolset.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
