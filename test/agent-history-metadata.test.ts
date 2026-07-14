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
