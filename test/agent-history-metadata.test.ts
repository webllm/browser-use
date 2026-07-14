import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { BrowserStateHistory } from '../src/browser/views.js';
import {
  ActionResult,
  AgentHistory,
  AgentHistoryList,
  AgentOutput,
  MAX_AGENT_HISTORY_FILE_BYTES,
  MAX_LOADED_AGENT_HISTORY_ITEMS,
  StepMetadata,
} from '../src/agent/views.js';

describe('Agent history metadata alignment', () => {
  it('serializes state_message and step_interval in history payload', () => {
    const history = new AgentHistoryList();
    history.add_item(
      new AgentHistory(
        new AgentOutput({ action: [] }),
        [new ActionResult({ extracted_content: 'done', is_done: true })],
        new BrowserStateHistory('https://example.com', 'Example', [], [], null),
        new StepMetadata(10, 15, 1, 3),
        '<agent_state>cached</agent_state>'
      )
    );

    const dumped = history.toJSON();
    expect(dumped.history[0].state_message).toBe(
      '<agent_state>cached</agent_state>'
    );
    expect(dumped.history[0].metadata?.step_interval).toBe(3);
  });

  it('loads state_message and step_interval from saved history file', () => {
    const history = new AgentHistoryList();
    history.add_item(
      new AgentHistory(
        null,
        [new ActionResult({ extracted_content: 'result' })],
        new BrowserStateHistory('https://example.com', 'Example', [], [], null),
        new StepMetadata(1, 2, 1, 1),
        'snapshot text'
      )
    );

    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'agent-history-metadata-')
    );
    const historyDir = path.join(tempDir, 'nested');
    const filePath = path.join(historyDir, 'history.json');

    try {
      history.save_to_file(filePath);
      const loaded = AgentHistoryList.load_from_file(filePath, AgentOutput);
      expect(loaded.history[0].state_message).toBe('snapshot text');
      expect(loaded.history[0].metadata?.step_interval).toBe(1);
      if (process.platform !== 'win32') {
        expect(fs.statSync(historyDir).mode & 0o777).toBe(0o700);
        expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('loads history entries from in-memory payload via load_from_dict', () => {
    const payload = {
      history: [
        {
          model_output: {
            action: [],
          },
          result: [
            {
              extracted_content: 'payload result',
              is_done: true,
              success: true,
            },
          ],
          state: {
            url: 'https://example.com',
            title: 'Example',
            tabs: [],
            interacted_element: [],
            screenshot_path: null,
          },
          metadata: {
            step_start_time: 2,
            step_end_time: 4,
            step_number: 1,
            step_interval: 2,
          },
          state_message: 'payload state',
        },
      ],
    } as const;

    const loaded = AgentHistoryList.load_from_dict(payload as any, AgentOutput);
    expect(loaded.history).toHaveLength(1);
    expect(loaded.history[0].state_message).toBe('payload state');
    expect(loaded.history[0].metadata?.step_interval).toBe(2);
    expect(loaded.final_result()).toBe('payload result');
  });

  it('bounds screenshot reads while preserving history alignment', () => {
    const readers: Array<ReturnType<typeof vi.fn>> = [];
    const items = Array.from({ length: 105 }, () => {
      const state = new BrowserStateHistory('', '', [], [], 'shot.png');
      const reader = vi
        .spyOn(state, 'get_screenshot')
        .mockReturnValue('iVBORw0KGgo=');
      readers.push(reader);
      return new AgentHistory(null, [], state);
    });

    const screenshots = new AgentHistoryList(items).screenshots();

    expect(screenshots).toHaveLength(105);
    expect(screenshots.slice(0, 5)).toEqual(new Array(5).fill(null));
    expect(
      readers.slice(0, 5).every((reader) => reader.mock.calls.length === 0)
    ).toBe(true);
    expect(
      readers.slice(5).every((reader) => reader.mock.calls.length === 1)
    ).toBe(true);
  });

  it('rejects oversized and non-regular history files', () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'agent-history-limits-')
    );
    const filePath = path.join(tempDir, 'history.json');
    fs.writeFileSync(filePath, '{}');
    fs.truncateSync(filePath, MAX_AGENT_HISTORY_FILE_BYTES + 1);

    try {
      expect(() =>
        AgentHistoryList.load_from_file(filePath, AgentOutput)
      ).toThrow(`exceeds ${MAX_AGENT_HISTORY_FILE_BYTES} bytes`);
      expect(() =>
        AgentHistoryList.load_from_file(tempDir, AgentOutput)
      ).toThrow('not a regular file');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects malformed or excessive history collections', () => {
    expect(() =>
      AgentHistoryList.load_from_dict({ history: {} } as any, AgentOutput)
    ).toThrow('payload.history must be an array');
    expect(() =>
      AgentHistoryList.load_from_dict({ history: [null] } as any, AgentOutput)
    ).toThrow('entry 0 must be an object');
    expect(() =>
      AgentHistoryList.load_from_dict(
        { history: [{ result: {} }] } as any,
        AgentOutput
      )
    ).toThrow('entry 0.result must be an array');
    expect(() =>
      AgentHistoryList.load_from_dict(
        {
          history: [
            {
              model_output: { action: new Array(1_001).fill({}) },
            },
          ],
        } as any,
        AgentOutput
      )
    ).toThrow('model_output.action must contain at most 1000 items');
    expect(() =>
      AgentHistoryList.load_from_dict(
        {
          history: new Array(MAX_LOADED_AGENT_HISTORY_ITEMS + 1).fill({}),
        } as any,
        AgentOutput
      )
    ).toThrow(
      `payload.history must contain at most ${MAX_LOADED_AGENT_HISTORY_ITEMS} items`
    );
  });

  it.each([
    [
      { history: [{ result: [{ error: { message: 'boom' } }] }] },
      'result[0].error must be a string or null',
    ],
    [
      { history: [{ model_output: { action: ['click'] } }] },
      'model_output.action[0] must be an object',
    ],
    [
      { history: [{ state: { url: { href: 'https://example.com' } } }] },
      'state.url must be a string or null',
    ],
    [
      {
        history: [
          {
            metadata: {
              step_start_time: 1,
              step_end_time: 2,
              step_number: Number.POSITIVE_INFINITY,
            },
          },
        ],
      },
      'metadata.step_number must be a finite number',
    ],
    [
      { history: [{ state_message: ['not', 'text'] }] },
      'state_message must be a string or null',
    ],
  ])('rejects malformed history field values', (payload, message) => {
    expect(() =>
      AgentHistoryList.load_from_dict(payload as any, AgentOutput)
    ).toThrow(message);
  });

  it('preserves existing history when atomic replacement fails', () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'agent-history-atomic-')
    );
    const filePath = path.join(tempDir, 'history.json');
    fs.writeFileSync(filePath, '{"history":[]}');
    const history = new AgentHistoryList();
    history.add_item(
      new AgentHistory(
        null,
        [new ActionResult({ extracted_content: 'new result' })],
        new BrowserStateHistory('https://example.com', 'Example', [], [])
      )
    );
    const rename = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('injected history replacement failure');
    });

    try {
      expect(() => history.save_to_file(filePath)).toThrow(
        'injected history replacement failure'
      );
    } finally {
      rename.mockRestore();
    }

    try {
      expect(fs.readFileSync(filePath, 'utf8')).toBe('{"history":[]}');
      expect(
        fs.readdirSync(tempDir).filter((entry) => entry.endsWith('.tmp'))
      ).toEqual([]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('parses structured output with explicit parser in get_structured_output', () => {
    const history = new AgentHistoryList<{ value: string }>();
    history.add_item(
      new AgentHistory(
        new AgentOutput({ action: [] }),
        [
          new ActionResult({
            is_done: true,
            success: true,
            extracted_content: '{"value":"ok"}',
          }),
        ],
        new BrowserStateHistory('https://example.com', 'Example', [], [], null)
      )
    );

    const structured = history.get_structured_output({
      parse: (input: string) => JSON.parse(input) as { value: string },
    });

    expect(structured).toEqual({ value: 'ok' });
  });
});
