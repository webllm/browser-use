import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { BaseChatModel } from '../src/llm/base.js';
import { Agent } from '../src/agent/service.js';
import {
  ActionResult,
  AgentHistory,
  AgentHistoryList,
  AgentOutput,
  redactSensitiveDataFromString,
} from '../src/agent/views.js';
import { BrowserStateHistory } from '../src/browser/views.js';
import { DOMHistoryElement } from '../src/dom/history-tree-processor/view.js';
import { ActionModel } from '../src/controller/registry/views.js';
import {
  _private_for_tests,
  detect_variables_in_history,
} from '../src/agent/variable-detector.js';

class StubLLM implements BaseChatModel {
  model = 'stub-model';
  provider = 'stub';

  get name() {
    return this.model;
  }

  get model_name() {
    return this.model;
  }

  async ainvoke(): Promise<any> {
    return { completion: 'ok', usage: null, stop_reason: null };
  }
}

const createHistory = () => {
  const emailElement = new DOMHistoryElement(
    'input',
    '//*[@id="email"]',
    1,
    [],
    {
      type: 'email',
      id: 'email',
    }
  );
  const firstNameElement = new DOMHistoryElement(
    'input',
    '//*[@id="first_name"]',
    2,
    [],
    {
      name: 'first_name',
      placeholder: 'First name',
    }
  );

  const step1 = new AgentHistory(
    new AgentOutput({
      action: [
        new ActionModel({ input: { index: 1, text: 'old@example.com' } }),
      ],
    }),
    [new ActionResult({ extracted_content: 'ok' })],
    new BrowserStateHistory(
      'https://example.com/form',
      'Form',
      [],
      [emailElement]
    )
  );
  const step2 = new AgentHistory(
    new AgentOutput({
      action: [new ActionModel({ input: { index: 2, text: 'John' } })],
    }),
    [new ActionResult({ extracted_content: 'ok' })],
    new BrowserStateHistory(
      'https://example.com/form',
      'Form',
      [],
      [firstNameElement]
    )
  );

  return new AgentHistoryList([step1, step2]);
};

describe('Agent variable alignment', () => {
  it('detects reusable variables from history and prioritizes element attributes', () => {
    const history = createHistory();
    const detected = detect_variables_in_history(history);

    expect(detected.email?.original_value).toBe('old@example.com');
    expect(detected.first_name?.original_value).toBe('John');
    expect(detected.email?.format).toBe('email');

    const attrPriority = _private_for_tests.detectVariableType(
      'Test',
      new DOMHistoryElement('input', '//*[@id="test"]', 1, [], {
        type: 'email',
      })
    );
    expect(attrPriority).toEqual(['email', 'email']);
  });

  it('substitutes detected variables without mutating original history', () => {
    const agent = new Agent({
      task: 'variable substitution',
      llm: new StubLLM(),
    });
    const originalHistory = createHistory();

    const substituted = (agent as any)._substitute_variables_in_history(
      originalHistory,
      {
        email: 'new@example.com',
        first_name: 'Jane',
      }
    ) as AgentHistoryList;

    const originalStep1 = (
      originalHistory.history[0].model_output!.action[0] as any
    ).model_dump().input.text;
    const originalStep2 = (
      originalHistory.history[1].model_output!.action[0] as any
    ).model_dump().input.text;
    const substitutedStep1 = (
      substituted.history[0].model_output!.action[0] as any
    ).model_dump().input.text;
    const substitutedStep2 = (
      substituted.history[1].model_output!.action[0] as any
    ).model_dump().input.text;

    expect(originalStep1).toBe('old@example.com');
    expect(originalStep2).toBe('John');
    expect(substitutedStep1).toBe('new@example.com');
    expect(substitutedStep2).toBe('Jane');
  });

  it('applies variable substitutions when loading and rerunning history', async () => {
    const agent = new Agent({
      task: 'load and rerun with variables',
      llm: new StubLLM(),
    });
    const history = createHistory();

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-use-vars-'));
    const historyPath = path.join(tempDir, 'AgentHistory.json');
    history.save_to_file(historyPath);

    const rerunSpy = vi.spyOn(agent, 'rerun_history').mockResolvedValueOnce([]);

    await agent.load_and_rerun(historyPath, {
      variables: { email: 'loaded@example.com' },
    });

    const passedHistory = rerunSpy.mock.calls[0]?.[0] as AgentHistoryList;
    const updatedText = (
      passedHistory.history[0].model_output!.action[0] as any
    ).model_dump().input.text;
    expect(updatedText).toBe('loaded@example.com');

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('filters sensitive input values when saving history', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-use-vars-'));
    const historyPath = path.join(tempDir, 'AgentHistory.json');
    const password = 'super-secret-password';

    const history = new AgentHistoryList([
      new AgentHistory(
        new AgentOutput({
          action: [new ActionModel({ input: { index: 1, text: password } })],
        }),
        [new ActionResult({ extracted_content: password })],
        new BrowserStateHistory('https://example.com', 'Page', [], [])
      ),
      new AgentHistory(
        new AgentOutput({
          action: [new ActionModel({ search_google: { query: password } })],
        }),
        [new ActionResult({ extracted_content: 'search done' })],
        new BrowserStateHistory('https://example.com', 'Page', [], [])
      ),
    ]);

    history.save_to_file(historyPath, { password });
    const serialized = JSON.parse(fs.readFileSync(historyPath, 'utf-8'));

    expect(serialized.history[0].model_output.action[0].input.text).toBe(
      '<secret>password</secret>'
    );
    expect(serialized.history[0].result[0].extracted_content).toBe(
      '<secret>password</secret>'
    );
    expect(
      serialized.history[1].model_output.action[0].search_google.query
    ).toBe('<secret>password</secret>');
    if (process.platform !== 'win32') {
      expect(fs.statSync(historyPath).mode & 0o777).toBe(0o600);
    }

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('redacts every domain-scoped secret when placeholder names repeat', () => {
    const redacted = redactSensitiveDataFromString(
      'first=alpha-secret second=beta-secret',
      {
        'a.example': { password: 'alpha-secret' },
        'b.example': { password: 'beta-secret' },
      }
    );

    expect(redacted).toBe(
      'first=<secret>password</secret> second=<secret>password</secret>'
    );
  });

  it('does not reprocess placeholders inserted by an earlier secret match', () => {
    expect(
      redactSensitiveDataFromString('token=alpha-secret', {
        a: 'alpha-secret',
        marker: 'a',
      })
    ).toBe('token=<secret>a</secret>');
  });

  it('matches overlapping and regex-significant secrets literally', () => {
    expect(
      redactSensitiveDataFromString('first=a+b second=a+ tail=[x]', {
        long: 'a+b',
        short: 'a+',
        brackets: '[x]',
      })
    ).toBe(
      'first=<secret>long</secret> second=<secret>short</secret> tail=<secret>brackets</secret>'
    );
  });

  it('caps redacted output expansion', () => {
    const redacted = redactSensitiveDataFromString(
      'a'.repeat(1_000),
      { ['x'.repeat(256)]: 'a' },
      100
    );

    expect(redacted).toHaveLength(100);
    expect(redacted.startsWith('<secret>')).toBe(true);
  });

  it('redacts sensitive values at arbitrary array nesting depth', () => {
    const history = new AgentHistoryList([
      new AgentHistory(
        null,
        [
          new ActionResult({
            metadata: { nested: [['deep-secret']] },
          }),
        ],
        new BrowserStateHistory('about:blank', 'Blank', [], [])
      ),
    ]);

    const serialized = history.model_dump({ password: 'deep-secret' });

    expect(
      (serialized.history[0]!.result[0]!.metadata as any).nested[0][0]
    ).toBe('<secret>password</secret>');
    expect(JSON.stringify(serialized)).not.toContain('deep-secret');
  });

  it('bounds cyclic and deeply nested history metadata during redaction', () => {
    const metadata: Record<string, unknown> = {
      reflected: 'deep-secret',
      ['deep-secret-key']: 1n,
    };
    metadata.self = metadata;
    let nested = metadata;
    for (let depth = 0; depth < 110; depth += 1) {
      const child: Record<string, unknown> = {};
      nested.child = child;
      nested = child;
    }
    const history = new AgentHistoryList([
      new AgentHistory(
        null,
        [new ActionResult({ metadata })],
        new BrowserStateHistory('about:blank', 'Blank', [], [])
      ),
    ]);

    const serialized = JSON.stringify(
      history.model_dump({ password: 'deep-secret' })
    );

    expect(serialized).not.toContain('deep-secret');
    expect(serialized).toContain('<secret>password</secret>');
    expect(serialized).toContain('[Circular]');
    expect(serialized).toContain('[Truncated]');
  });

  it('bounds cyclic history metadata even without sensitive data', () => {
    const metadata: Record<string, unknown> = {};
    metadata.self = metadata;
    const history = new AgentHistoryList([
      new AgentHistory(
        null,
        [new ActionResult({ metadata })],
        new BrowserStateHistory('about:blank', 'Blank', [], [])
      ),
    ]);

    expect(JSON.stringify(history.model_dump())).toContain('[Circular]');
  });

  it('omits usage from serialized history for python parity', () => {
    const history = createHistory();
    (history as any).usage = { total_tokens: 42 };

    const serialized = history.model_dump();
    expect(serialized.history.length).toBe(2);
    expect(Object.prototype.hasOwnProperty.call(serialized, 'usage')).toBe(
      false
    );
  });
});
