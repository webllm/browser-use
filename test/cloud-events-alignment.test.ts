import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CreateAgentOutputFileEvent,
  CreateAgentSessionEvent,
  CreateAgentTaskEvent,
  CreateAgentStepEvent,
  UpdateAgentTaskEvent,
  UpdateAgentSessionEvent,
  MAX_FILE_CONTENT_SIZE,
  MAX_STRING_LENGTH,
} from '../src/agent/cloud-events.js';

describe('cloud events alignment', () => {
  const oversizedBase64 = 'a'.repeat(
    Math.floor((50 * 1024 * 1024 * 4) / 3) + 2
  );

  it('CreateAgentStepEvent.fromAgentStep includes screenshot as data URL', () => {
    const event = CreateAgentStepEvent.fromAgentStep(
      {
        task_id: 'task-1',
        state: { n_steps: 3 },
        cloud_sync: { auth_client: { device_id: 'device-1' } },
      } as any,
      {
        current_state: {
          evaluation_previous_goal: 'goal-check',
          memory: 'memory-note',
          next_goal: 'next-goal',
        },
        action: [],
      } as any,
      [],
      [{ click: { index: 4 } }],
      {
        screenshot: 'abc123',
        url: 'https://example.com',
      }
    );

    expect(event.screenshot_url).toBe('data:image/png;base64,abc123');
    expect(event.url).toBe('https://example.com');
  });

  it('CreateAgentStepEvent.fromAgentStep keeps screenshot_url null without screenshot', () => {
    const event = CreateAgentStepEvent.fromAgentStep(
      {
        task_id: 'task-2',
        state: { n_steps: 1 },
        cloud_sync: { auth_client: { device_id: 'device-2' } },
      } as any,
      {
        current_state: {
          evaluation_previous_goal: '',
          memory: '',
          next_goal: '',
        },
        action: [],
      } as any,
      [],
      [],
      {
        screenshot: null,
        url: 'https://example.org',
      }
    );

    expect(event.screenshot_url).toBeNull();
  });

  it('redacts sensitive data from cloud task, state, result, and step payloads', () => {
    const agent = {
      task_id: 'task-sensitive',
      session_id: 'session-sensitive',
      task: 'Use deep-secret to sign in',
      llm: { model_name: 'model' },
      sensitive_data: {
        password: 'deep-secret',
      },
      state: {
        stopped: false,
        paused: false,
        n_steps: 2,
        model_dump: () => ({
          last_result: [
            {
              nested: [['server reflected deep-secret']],
            },
          ],
        }),
      },
      history: {
        final_result: () => 'completed with deep-secret',
        is_done: () => true,
      },
      browser_session: {
        id: 'browser-session-sensitive',
      },
      _task_start_time: 1_760_000_000,
    } as any;

    const taskEvent = CreateAgentTaskEvent.fromAgent(agent).toJSON();
    const updateEvent = UpdateAgentTaskEvent.fromAgent(agent).toJSON();
    const stepEvent = CreateAgentStepEvent.fromAgentStep(
      agent,
      {
        current_state: {
          evaluation_previous_goal: 'used deep-secret',
          memory: 'remember deep-secret',
          next_goal: 'submit deep-secret',
        },
        action: [],
      },
      [],
      [{ input: { text: 'deep-secret' } }],
      {
        screenshot: null,
        url: 'https://example.com/?token=deep-secret',
      }
    ).toJSON();
    const serialized = JSON.stringify({ taskEvent, updateEvent, stepEvent });

    expect(serialized).not.toContain('deep-secret');
    expect(taskEvent.task).toBe('Use <secret>password</secret> to sign in');
    expect(updateEvent.done_output).toBe(
      'completed with <secret>password</secret>'
    );
    expect(stepEvent.actions).toEqual([
      { input: { text: '<secret>password</secret>' } },
    ]);
    expect(stepEvent.url).toBe(
      'https://example.com/?token=<secret>password</secret>'
    );
  });

  it('bounds cyclic and deeply nested values while redacting cloud state', () => {
    const cyclicState: Record<string, unknown> = {
      reflected: 'deep-secret',
    };
    cyclicState.self = cyclicState;
    cyclicState['deep-secret-key'] = 1n;
    let nested = cyclicState;
    for (let depth = 0; depth < 60; depth += 1) {
      const child: Record<string, unknown> = {};
      nested.child = child;
      nested = child;
    }

    const event = UpdateAgentTaskEvent.fromAgent({
      task_id: 'task-cyclic',
      session_id: 'session-cyclic',
      task: 'task',
      llm: { model_name: 'model' },
      sensitive_data: { password: 'deep-secret' },
      state: {
        stopped: false,
        paused: false,
        n_steps: 1,
        model_dump: () => cyclicState,
      },
      history: {
        final_result: () => null,
        is_done: () => false,
      },
      browser_session: { id: 'browser-cyclic' },
      _task_start_time: 1_760_000_000,
    } as any).toJSON();

    const serialized = JSON.stringify(event.agent_state);
    expect(serialized).not.toContain('deep-secret');
    expect(serialized).toContain('<secret>password</secret>');
    expect(serialized).toContain('[Circular]');
    expect(serialized).toContain('[Truncated]');
  });

  it('caps nested cloud action collections before serialization', () => {
    const actions = Array.from({ length: 10_100 }, (_, index) => ({ index }));
    const event = CreateAgentStepEvent.fromAgentStep(
      {
        task_id: 'task-many-actions',
        state: { n_steps: 1 },
        cloud_sync: { auth_client: { device_id: 'device-many-actions' } },
      } as any,
      { current_state: {}, action: [] } as any,
      [],
      actions,
      { screenshot: null, url: 'https://example.com' }
    );

    expect(event.actions.length).toBeLessThan(actions.length);
    expect(event.actions.at(-1)).toBe('[Truncated]');
  });

  it('UpdateAgentSessionEvent serializes optional update fields', () => {
    const stoppedAt = new Date('2026-02-10T10:11:12.000Z');
    const event = new UpdateAgentSessionEvent({
      id: 'session-1',
      device_id: 'device-1',
      browser_session_stopped: true,
      browser_session_stopped_at: stoppedAt,
      end_reason: 'completed',
    });

    expect(event.event_type).toBe('UpdateAgentSessionEvent');
    expect(event.toJSON()).toMatchObject({
      event_type: 'UpdateAgentSessionEvent',
      id: 'session-1',
      device_id: 'device-1',
      browser_session_stopped: true,
      browser_session_stopped_at: '2026-02-10T10:11:12.000Z',
      end_reason: 'completed',
    });
  });

  it('UpdateAgentSessionEvent enforces python-aligned end_reason max length', () => {
    expect(
      () =>
        new UpdateAgentSessionEvent({
          id: 'session-2',
          end_reason: 'x'.repeat(101),
        })
    ).toThrow('end_reason exceeds maximum length of 100');
  });

  it('CreateAgentTaskEvent enforces python c011 llm_model max length 200', () => {
    expect(
      () =>
        new CreateAgentTaskEvent({
          agent_session_id: 'session-1',
          llm_model: 'x'.repeat(201),
          task: 'run task',
        })
    ).toThrow('llm_model exceeds maximum length of 200');
  });

  it('CreateAgentTaskEvent accepts 200-character llm_model', () => {
    const event = new CreateAgentTaskEvent({
      agent_session_id: 'session-2',
      llm_model: 'x'.repeat(200),
      task: 'run task',
    });

    expect(event.llm_model.length).toBe(200);
    expect(event.toJSON().llm_model).toHaveLength(200);
  });

  it('CreateAgentTaskEvent enforces python-aligned task max length 100000', () => {
    expect(
      () =>
        new CreateAgentTaskEvent({
          agent_session_id: 'session-3',
          llm_model: 'model',
          task: 'x'.repeat(100_001),
        })
    ).toThrow('task exceeds maximum length of 100000');
  });

  it('CreateAgentTaskEvent.fromAgent validates oversized task without truncating', () => {
    expect(() =>
      CreateAgentTaskEvent.fromAgent({
        task_id: 'task-3',
        session_id: 'session-4',
        task: 'x'.repeat(100_001),
        llm: { model_name: 'model' },
        state: {
          stopped: false,
          paused: false,
          n_steps: 0,
          model_dump: () => ({}),
        },
        history: {
          final_result: () => null,
          is_done: () => false,
        },
        browser_session: {
          id: 'browser-session-1',
        },
        cloud_sync: {
          auth_client: {
            device_id: 'device-4',
          },
        },
        _task_start_time: 1_760_000_000,
      } as any)
    ).toThrow('task exceeds maximum length of 100000');
  });

  it('enforces Python-aligned optional task and identity field lengths', () => {
    expect(
      () =>
        new UpdateAgentTaskEvent({
          id: 'task-fields',
          user_id: 'u'.repeat(256),
        })
    ).toThrow('user_id exceeds maximum length of 255');
    expect(
      () =>
        new UpdateAgentTaskEvent({
          id: 'task-fields',
          done_output: 'x'.repeat(MAX_STRING_LENGTH + 1),
        })
    ).toThrow(`done_output exceeds maximum length of ${MAX_STRING_LENGTH}`);
    expect(
      () =>
        new CreateAgentTaskEvent({
          agent_session_id: 'session-fields',
          llm_model: 'model',
          task: 'task',
          user_feedback_type: 'x'.repeat(11),
        })
    ).toThrow('user_feedback_type exceeds maximum length of 10');
  });

  it('enforces Python-aligned step text, screenshot, and URL lengths', () => {
    const base = {
      agent_task_id: 'task-step-fields',
      step: 1,
      evaluation_previous_goal: '',
      memory: '',
      next_goal: '',
      actions: [],
      url: '',
    };

    expect(
      () =>
        new CreateAgentStepEvent({
          ...base,
          memory: 'x'.repeat(MAX_STRING_LENGTH + 1),
        })
    ).toThrow(`memory exceeds maximum length of ${MAX_STRING_LENGTH}`);
    expect(
      () =>
        new CreateAgentStepEvent({
          ...base,
          screenshot_url: 'x'.repeat(MAX_FILE_CONTENT_SIZE + 1),
        })
    ).toThrow(
      `screenshot_url exceeds maximum length of ${MAX_FILE_CONTENT_SIZE}`
    );
    expect(
      () => new CreateAgentStepEvent({ ...base, url: 'x'.repeat(100_001) })
    ).toThrow('url exceeds maximum length of 100000');
  });

  it('enforces Python-aligned output and browser-session metadata lengths', () => {
    expect(
      () =>
        new CreateAgentOutputFileEvent({
          task_id: 'task-output-fields',
          file_name: 'x'.repeat(256),
        })
    ).toThrow('file_name exceeds maximum length of 255');
    expect(
      () =>
        new CreateAgentSessionEvent({
          browser_session_id: 'x'.repeat(256),
        })
    ).toThrow('browser_session_id exceeds maximum length of 255');
    expect(
      () =>
        new CreateAgentSessionEvent({
          browser_session_id: 'session',
          browser_session_cdp_url: 'x'.repeat(100_001),
        })
    ).toThrow('browser_session_cdp_url exceeds maximum length of 100000');
  });

  it('CreateAgentOutputFileEvent enforces python-aligned 50MB base64 size guard', () => {
    expect(
      () =>
        new CreateAgentOutputFileEvent({
          task_id: 'task-oversized-file',
          file_name: 'big.gif',
          file_content: `data:image/gif;base64,${oversizedBase64}`,
          content_type: 'image/gif',
        })
    ).toThrow('file_content exceeds maximum size of 52428800 bytes');
  });

  it('bounds output files before base64 encoding them', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bu-cloud-file-'));
    const outputPath = path.join(tempDir, 'output.gif');
    fs.writeFileSync(outputPath, 'GIF89a');

    try {
      const smallEvent = await CreateAgentOutputFileEvent.fromAgentAndFile(
        { task_id: 'task-file', browser_session: { id: 'browser' } } as any,
        outputPath
      );
      expect(smallEvent.file_content).toBe(
        Buffer.from('GIF89a').toString('base64')
      );

      fs.truncateSync(outputPath, MAX_FILE_CONTENT_SIZE);
      const oversizedEvent = await CreateAgentOutputFileEvent.fromAgentAndFile(
        { task_id: 'task-file', browser_session: { id: 'browser' } } as any,
        outputPath
      );
      expect(oversizedEvent.file_content).toBeNull();

      await expect(
        CreateAgentOutputFileEvent.fromAgentAndFile(
          { task_id: 'task-file', browser_session: { id: 'browser' } } as any,
          tempDir
        )
      ).rejects.toThrow('not a regular file');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')(
    'does not upload output files through symbolic links',
    async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bu-cloud-file-'));
      const targetPath = path.join(tempDir, 'outside.txt');
      const outputPath = path.join(tempDir, 'output.txt');
      fs.writeFileSync(targetPath, 'must not upload');
      fs.symlinkSync(targetPath, outputPath);

      try {
        await expect(
          CreateAgentOutputFileEvent.fromAgentAndFile(
            { task_id: 'task-file', browser_session: { id: 'browser' } } as any,
            outputPath
          )
        ).rejects.toThrow('not a regular file');
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }
  );

  it('CreateAgentStepEvent enforces python-aligned screenshot data URL size guard', () => {
    expect(
      () =>
        new CreateAgentStepEvent({
          agent_task_id: 'task-oversized-screenshot',
          step: 1,
          evaluation_previous_goal: '',
          memory: '',
          next_goal: '',
          actions: [],
          screenshot_url: `data:image/png;base64,${oversizedBase64}`,
          url: 'https://example.com',
        })
    ).toThrow('screenshot_url exceeds maximum size of 52428800 bytes');
  });
});
