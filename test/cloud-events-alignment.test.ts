import { describe, expect, it } from 'vitest';
import {
  CreateAgentOutputFileEvent,
  CreateAgentTaskEvent,
  CreateAgentStepEvent,
  UpdateAgentTaskEvent,
  UpdateAgentSessionEvent,
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
