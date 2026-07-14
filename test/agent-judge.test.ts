import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Agent } from '../src/agent/service.js';
import {
  ActionResult,
  AgentHistory,
  AgentStepInfo,
} from '../src/agent/views.js';
import { BrowserStateHistory } from '../src/browser/views.js';
import type { BaseChatModel } from '../src/llm/base.js';
import {
  construct_judge_messages,
  construct_simple_judge_messages,
} from '../src/agent/judge.js';

const createLlm = (completion: unknown, provider = 'test') => {
  const ainvoke = vi.fn(
    async (
      _messages: unknown[],
      _outputFormat?: unknown,
      _options?: Record<string, unknown>
    ) => ({ completion, usage: null })
  );
  const llm = {
    model: 'gpt-test',
    get provider() {
      return provider;
    },
    get name() {
      return 'test';
    },
    get model_name() {
      return 'gpt-test';
    },
    ainvoke,
  } as unknown as BaseChatModel;
  return { llm, ainvoke };
};

describe('Agent full judge alignment', () => {
  it('adds screenshot image parts for full judge when vision is enabled', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-msg-test-'));
    try {
      const screenshotPath = path.join(tempDir, 'shot.png');
      fs.writeFileSync(
        screenshotPath,
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      );

      const messages = construct_judge_messages({
        task: 'Validate output',
        final_result: 'done',
        agent_steps: ['Step 1: clicked'],
        screenshot_paths: [screenshotPath],
        use_vision: true,
      });
      const userMessage = messages[1] as any;
      expect(Array.isArray(userMessage.content)).toBe(true);
      const imageParts = userMessage.content.filter(
        (part: any) => part?.type === 'image_url'
      );
      expect(imageParts.length).toBe(1);
      expect(String(imageParts[0].image_url?.url ?? '')).toContain(
        'data:image/png;base64,'
      );

      const noVisionMessages = construct_judge_messages({
        task: 'Validate output',
        final_result: 'done',
        agent_steps: ['Step 1: clicked'],
        screenshot_paths: [screenshotPath],
        use_vision: false,
      });
      const noVisionUser = noVisionMessages[1] as any;
      const noVisionImageParts = noVisionUser.content.filter(
        (part: any) => part?.type === 'image_url'
      );
      expect(noVisionImageParts.length).toBe(0);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('ignores unsafe screenshot files and caps judge image count', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-msg-test-'));
    try {
      const screenshotPath = path.join(tempDir, 'shot.png');
      const textPath = path.join(tempDir, 'secret.txt');
      fs.writeFileSync(
        screenshotPath,
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      );
      fs.writeFileSync(textPath, 'not an image');
      const cappedMessages = construct_judge_messages({
        task: 'Validate output',
        final_result: 'done',
        agent_steps: [],
        screenshot_paths: [textPath, ...new Array(20).fill(screenshotPath)],
        max_images: Number.POSITIVE_INFINITY,
        use_vision: true,
      });
      const imageParts = (cappedMessages[1] as any).content.filter(
        (part: any) => part?.type === 'image_url'
      );

      expect(imageParts).toHaveLength(10);
      expect(
        imageParts.every((part: any) =>
          String(part.image_url?.url ?? '').startsWith('data:image/png;base64,')
        )
      ).toBe(true);

      const unsafeMessages = construct_judge_messages({
        task: 'Validate output',
        final_result: 'done',
        agent_steps: [],
        screenshot_paths: [textPath],
        use_vision: true,
      });
      expect(
        (unsafeMessages[1] as any).content.filter(
          (part: any) => part?.type === 'image_url'
        )
      ).toHaveLength(0);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('bounds judge trajectory, ground truth, and date text before prompting', () => {
    const messages = construct_judge_messages({
      task: 'Validate output',
      final_result: 'done',
      agent_steps: ['x'.repeat(50_000), 'unread-tail'],
      screenshot_paths: [],
      ground_truth: 'g'.repeat(50_000),
      use_vision: false,
    });
    const userContent = (messages[1] as any).content[0].text as string;

    expect(userContent).not.toContain('unread-tail');
    expect(userContent.match(/\.\.\.\[text truncated\]\.\.\./g)).toHaveLength(
      2
    );

    const simpleMessages = construct_simple_judge_messages({
      task: 'Validate output',
      final_result: 'done',
      current_date: 'd'.repeat(1_000),
    });
    expect((simpleMessages[0] as any).content.length).toBeLessThan(10_000);
    expect((simpleMessages[0] as any).content).toContain(
      '...[text truncated]...'
    );
  });

  it('runs full judge after done in takeStep when use_judge is enabled', async () => {
    const { llm: mainLlm, ainvoke: mainInvoke } = createLlm(
      '{"is_correct": true, "reason": ""}'
    );
    const { llm: judgeLlm, ainvoke: judgeInvoke } = createLlm(
      JSON.stringify({
        reasoning: 'Agent skipped required field',
        verdict: false,
        failure_reason: 'Missing required field',
        impossible_task: false,
        reached_captcha: false,
      })
    );

    const agent = new Agent({
      task: 'Extract all required fields',
      llm: mainLlm,
      judge_llm: judgeLlm,
      use_judge: true,
    });
    try {
      vi.spyOn(agent as any, '_step').mockImplementation(async () => {
        agent.history.add_item(
          new AgentHistory(
            null,
            [
              new ActionResult({
                is_done: true,
                success: true,
                extracted_content: 'Only partial fields',
              }),
            ],
            new BrowserStateHistory(
              'https://example.com',
              'Example',
              [],
              [],
              null
            ),
            null
          )
        );
      });
      vi.spyOn(agent, 'log_completion').mockResolvedValue(undefined as any);

      const [isDone] = await agent.takeStep(new AgentStepInfo(0, 3));

      expect(isDone).toBe(true);
      expect(mainInvoke).toHaveBeenCalledTimes(1);
      expect(judgeInvoke).toHaveBeenCalledTimes(1);
      const finalResult = agent.history.history[0].result[0];
      expect(finalResult.judgement).toMatchObject({
        verdict: false,
        failure_reason: 'Missing required field',
      });
    } finally {
      await agent.close();
    }
  });

  it('skips full judge after done when use_judge is disabled', async () => {
    const { llm: mainLlm, ainvoke: mainInvoke } = createLlm(
      '{"is_correct": true, "reason": ""}'
    );
    const { llm: judgeLlm, ainvoke: judgeInvoke } =
      createLlm('{"verdict": false}');

    const agent = new Agent({
      task: 'Extract all required fields',
      llm: mainLlm,
      judge_llm: judgeLlm,
      use_judge: false,
    });
    try {
      vi.spyOn(agent as any, '_step').mockImplementation(async () => {
        agent.history.add_item(
          new AgentHistory(
            null,
            [
              new ActionResult({
                is_done: true,
                success: true,
                extracted_content: 'Final result',
              }),
            ],
            new BrowserStateHistory(
              'https://example.com',
              'Example',
              [],
              [],
              null
            ),
            null
          )
        );
      });
      vi.spyOn(agent, 'log_completion').mockResolvedValue(undefined as any);

      await agent.takeStep(new AgentStepInfo(0, 2));

      expect(mainInvoke).toHaveBeenCalledTimes(1);
      expect(judgeInvoke).toHaveBeenCalledTimes(0);
      const finalResult = agent.history.history[0].result[0];
      expect(finalResult.judgement).toBeNull();
    } finally {
      await agent.close();
    }
  });

  it('builds simple judge prompt with explicit date and response tag', () => {
    const messages = construct_simple_judge_messages({
      task: 'Task',
      final_result: 'Result',
      current_date: '2026-02-08',
    });
    const systemText = (messages[0] as any).text as string;
    const userText = (messages[1] as any).text as string;
    expect(systemText).toContain("Today's date is 2026-02-08");
    expect(userText).toContain('<agent_final_response>');
  });

  it('passes request_type=judge for browser-use provider in full judge', async () => {
    const { llm: mainLlm } = createLlm('{"is_correct": true, "reason": ""}');
    const { llm: judgeLlm, ainvoke: judgeInvoke } = createLlm(
      JSON.stringify({
        reasoning: 'ok',
        verdict: true,
        failure_reason: '',
        impossible_task: false,
        reached_captcha: false,
      }),
      'browser-use'
    );
    const agent = new Agent({
      task: 'Verify',
      llm: mainLlm,
      judge_llm: judgeLlm,
      use_judge: true,
    });
    try {
      vi.spyOn(agent as any, '_step').mockImplementation(async () => {
        agent.history.add_item(
          new AgentHistory(
            null,
            [
              new ActionResult({
                is_done: true,
                success: true,
                extracted_content: 'done',
              }),
            ],
            new BrowserStateHistory(
              'https://example.com',
              'Example',
              [],
              [],
              null
            ),
            null
          )
        );
      });
      vi.spyOn(agent, 'log_completion').mockResolvedValue(undefined as any);

      await agent.takeStep(new AgentStepInfo(0, 1));

      expect(judgeInvoke).toHaveBeenCalledTimes(1);
      const thirdArg = judgeInvoke.mock.calls[0]?.[2] as any;
      expect(thirdArg).toMatchObject({
        request_type: 'judge',
        session_id: agent.session_id,
      });
    } finally {
      await agent.close();
    }
  });
});
