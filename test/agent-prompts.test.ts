import { describe, expect, it } from 'vitest';
import { AgentMessagePrompt, SystemPrompt } from '../src/agent/prompts.js';
import { BrowserStateSummary } from '../src/browser/views.js';
import { DOMElementNode, DOMState, DOMTextNode } from '../src/dom/views.js';
import { ContentPartTextParam } from '../src/llm/messages.js';
import { Image, createCanvas } from 'canvas';

describe('AgentMessagePrompt browser state enrichment', () => {
  it('includes recent events and popup messages, without pending/pagination sections', () => {
    const root = new DOMElementNode(true, null, 'body', '/body', {}, []);
    const domState = new DOMState(root, {});
    const browserState = new BrowserStateSummary(domState, {
      url: 'https://example.com/list',
      title: 'List',
      tabs: [{ page_id: 0, url: 'https://example.com/list', title: 'List' }],
      recent_events:
        '[{"event_type":"tab_switched","timestamp":"2026-01-01T00:00:00Z"}]',
      pending_network_requests: [
        {
          url: 'https://example.com/api/items',
          method: 'GET',
          loading_duration_ms: 120,
          resource_type: 'fetch',
        },
      ],
      pagination_buttons: [
        {
          button_type: 'next',
          backend_node_id: 8,
          text: 'Next',
          selector: '/html/body/nav/button[2]',
          is_disabled: false,
        },
      ],
      closed_popup_messages: ['[alert] Session expired soon'],
    });

    const prompt = new AgentMessagePrompt({
      browser_state_summary: browserState,
      file_system: {
        describe: () => '/tmp',
        get_todo_contents: () => '',
      } as any,
      task: 'test',
      include_recent_events: true,
    });

    const userMessage = prompt.get_user_message(false) as any;
    const content = String(userMessage.content ?? '');

    expect(content).toContain('Recent browser events:');
    expect(content).toContain('Auto-closed JavaScript dialogs:');
    expect(content).not.toContain('Pending network requests:');
    expect(content).not.toContain('Detected pagination buttons:');
  });

  it('includes python-style page stats summary', () => {
    const root = new DOMElementNode(true, null, 'body', '/body', {}, []);
    const link = new DOMElementNode(true, root, 'a', '/body/a[1]', {}, []);
    link.is_interactive = true;
    const iframe = new DOMElementNode(
      true,
      root,
      'iframe',
      '/body/iframe[1]',
      {},
      []
    );
    const image = new DOMElementNode(true, root, 'img', '/body/img[1]', {}, []);
    const button = new DOMElementNode(
      true,
      root,
      'button',
      '/body/button[1]',
      {},
      []
    );
    button.is_interactive = true;
    button.shadow_root = true;
    root.children = [link, iframe, image, button];

    const domState = new DOMState(root, {});
    const browserState = new BrowserStateSummary(domState, {
      url: 'https://example.com/list',
      title: 'List',
      tabs: [{ page_id: 0, url: 'https://example.com/list', title: 'List' }],
    });

    const prompt = new AgentMessagePrompt({
      browser_state_summary: browserState,
      file_system: {
        describe: () => '/tmp',
        get_todo_contents: () => '',
      } as any,
      task: 'test',
    });

    const userMessage = prompt.get_user_message(false) as any;
    const content = String(userMessage.content ?? '');

    expect(content).toContain('<page_stats>');
    expect(content).toContain('1 links, 2 interactive, 1 iframes');
    expect(content).toContain('1 shadow(open), 0 shadow(closed)');
    expect(content).toContain('1 images, 5 total elements');
  });

  it('suggests waiting on sparse pages only while requests are in flight', () => {
    const buildPrompt = (pending: number) => {
      const root = new DOMElementNode(true, null, 'body', '/body', {}, []);
      root.children = Array.from({ length: 30 }, (_, index) => {
        const div = new DOMElementNode(
          true,
          root,
          'div',
          `/body/div[${index + 1}]`,
          {},
          []
        );
        div.children = [new DOMTextNode(true, div, 'x')];
        return div;
      });
      const browserState = new BrowserStateSummary(new DOMState(root, {}), {
        url: 'https://example.com/app',
        title: 'App',
        tabs: [{ page_id: 0, url: 'https://example.com/app', title: 'App' }],
        pending_network_requests: Array.from({ length: pending }, () => ({
          url: 'https://example.com/api',
          method: 'GET',
          loading_duration_ms: 50,
          resource_type: 'fetch',
        })),
      });
      return String(
        (
          new AgentMessagePrompt({
            browser_state_summary: browserState,
            file_system: {
              describe: () => '/tmp',
              get_todo_contents: () => '',
            } as any,
            task: 'test',
          }).get_user_message(false) as any
        ).content ?? ''
      );
    };

    expect(buildPrompt(2)).toContain(
      '2 network request(s) in flight and little text rendered - page may still be loading, consider waiting'
    );
    expect(buildPrompt(0)).not.toContain('consider waiting');
  });

  it('suggests waiting on empty pages', () => {
    const root = new DOMElementNode(true, null, 'body', '/body', {}, []);
    const browserState = new BrowserStateSummary(new DOMState(root, {}), {
      url: 'https://example.com/blank',
      title: 'Blank',
      tabs: [],
    });
    const content = String(
      (
        new AgentMessagePrompt({
          browser_state_summary: browserState,
          file_system: {
            describe: () => '/tmp',
            get_todo_contents: () => '',
          } as any,
          task: 'test',
        }).get_user_message(false) as any
      ).content ?? ''
    );

    expect(content).toContain('Page appears empty - consider waiting - ');
  });

  it('tells the model when browser state capture failed', () => {
    const root = new DOMElementNode(true, null, 'body', '/body', {}, []);
    const browserState = new BrowserStateSummary(new DOMState(root, {}), {
      url: 'https://example.com/slow',
      title: 'Slow',
      tabs: [{ page_id: 0, url: 'https://example.com/slow', title: 'Slow' }],
      state_error: 'Browser state capture timed out.',
    });

    const prompt = new AgentMessagePrompt({
      browser_state_summary: browserState,
      file_system: {
        describe: () => '/tmp',
        get_todo_contents: () => '',
      } as any,
      task: 'test',
    });

    const content = String(
      (prompt.get_user_message(false) as any).content ?? ''
    );
    expect(content).toContain(
      '<browser_state_error>Browser state capture timed out.</browser_state_error>'
    );
  });

  it('does not include recent events by default', () => {
    const root = new DOMElementNode(true, null, 'body', '/body', {}, []);
    const domState = new DOMState(root, {});
    const browserState = new BrowserStateSummary(domState, {
      url: 'https://example.com/list',
      title: 'List',
      tabs: [{ page_id: 0, url: 'https://example.com/list', title: 'List' }],
      recent_events: '[{"event_type":"tab_switched"}]',
    });

    const prompt = new AgentMessagePrompt({
      browser_state_summary: browserState,
      file_system: {
        describe: () => '/tmp',
        get_todo_contents: () => '',
      } as any,
      task: 'test',
    });

    const userMessage = prompt.get_user_message(false) as any;
    const content = String(userMessage.content ?? '');
    expect(content).not.toContain('Recent browser events:');
  });

  it('renders tab_id values in tab listings when available', () => {
    const root = new DOMElementNode(true, null, 'body', '/body', {}, []);
    const domState = new DOMState(root, {});
    const browserState = new BrowserStateSummary(domState, {
      url: 'https://example.com/list',
      title: 'List',
      tabs: [
        {
          page_id: 0,
          tab_id: 'a1b2',
          url: 'https://example.com/list',
          title: 'List',
        },
      ],
    });

    const prompt = new AgentMessagePrompt({
      browser_state_summary: browserState,
      file_system: {
        describe: () => '/tmp',
        get_todo_contents: () => '',
      } as any,
      task: 'test',
    });

    const userMessage = prompt.get_user_message(false) as any;
    const content = String(userMessage.content ?? '');

    expect(content).toContain('Tab a1b2: https://example.com/list');
    expect(content).toContain('Current tab: a1b2');
  });

  it('uses last 4 characters for long tab ids', () => {
    const root = new DOMElementNode(true, null, 'body', '/body', {}, []);
    const domState = new DOMState(root, {});
    const browserState = new BrowserStateSummary(domState, {
      url: 'https://example.com/list',
      title: 'List',
      tabs: [
        {
          page_id: 0,
          tab_id: 'target-1234abcd',
          url: 'https://example.com/list',
          title: 'List',
        },
      ],
    });

    const prompt = new AgentMessagePrompt({
      browser_state_summary: browserState,
      file_system: {
        describe: () => '/tmp',
        get_todo_contents: () => '',
      } as any,
      task: 'test',
    });

    const userMessage = prompt.get_user_message(false) as any;
    const content = String(userMessage.content ?? '');
    expect(content).toContain('Tab abcd: https://example.com/list');
    expect(content).toContain('Current tab: abcd');
  });

  it('injects current plan block into agent state', () => {
    const root = new DOMElementNode(true, null, 'body', '/body', {}, []);
    const domState = new DOMState(root, {});
    const browserState = new BrowserStateSummary(domState, {
      url: 'https://example.com',
      title: 'Example',
      tabs: [{ page_id: 0, url: 'https://example.com', title: 'Example' }],
    });

    const prompt = new AgentMessagePrompt({
      browser_state_summary: browserState,
      file_system: {
        describe: () => '/tmp',
        get_todo_contents: () => '',
      } as any,
      task: 'test',
      plan_description: '[>] 0: open page\n[ ] 1: extract table',
    });

    const userMessage = prompt.get_user_message(false) as any;
    const content = String(userMessage.content ?? '');
    expect(content).toContain('<plan>');
    expect(content).toContain('[>] 0: open page');
    expect(content).toContain('[ ] 1: extract table');
  });

  it('includes read_state_images even when use_vision is disabled', () => {
    const root = new DOMElementNode(true, null, 'body', '/body', {}, []);
    const domState = new DOMState(root, {});
    const browserState = new BrowserStateSummary(domState, {
      url: 'https://example.com',
      title: 'Example',
      tabs: [{ page_id: 0, url: 'https://example.com', title: 'Example' }],
    });

    const prompt = new AgentMessagePrompt({
      browser_state_summary: browserState,
      file_system: {
        describe: () => '/tmp',
        get_todo_contents: () => '',
      } as any,
      task: 'test',
      screenshots: [],
      read_state_images: [{ name: 'chart.png', data: 'ZmFrZS1iYXNlNjQ=' }],
    });

    const userMessage = prompt.get_user_message(false) as any;
    expect(Array.isArray(userMessage.content)).toBe(true);
    const imageParts = userMessage.content.filter((part: any) =>
      part?.image_url?.url?.startsWith?.('data:image/png;base64,')
    );
    expect(imageParts).toHaveLength(1);
  });

  it('includes python-aligned pdf guidance in browser state', () => {
    const root = new DOMElementNode(true, null, 'body', '/body', {}, []);
    const domState = new DOMState(root, {});
    const browserState = new BrowserStateSummary(domState, {
      url: 'https://example.com/file.pdf',
      title: 'PDF Viewer',
      tabs: [
        {
          page_id: 0,
          url: 'https://example.com/file.pdf',
          title: 'PDF Viewer',
        },
      ],
      is_pdf_viewer: true,
    });

    const prompt = new AgentMessagePrompt({
      browser_state_summary: browserState,
      file_system: {
        describe: () => '/tmp',
        get_todo_contents: () => '',
      } as any,
      task: 'read pdf',
    });

    const userMessage = prompt.get_user_message(false) as any;
    const content = String(userMessage.content ?? '');
    expect(content).toContain('PDF viewer cannot be rendered.');
    expect(content).toContain('DO NOT use the extract action');
    expect(content).toContain('Use the read_file action');
    expect(content).toContain('read the full text content');
  });

  it('includes sample_images and resizes screenshots for llm_screenshot_size', () => {
    const root = new DOMElementNode(true, null, 'body', '/body', {}, []);
    const domState = new DOMState(root, {});
    const browserState = new BrowserStateSummary(domState, {
      url: 'https://example.com',
      title: 'Example',
      tabs: [{ page_id: 0, url: 'https://example.com', title: 'Example' }],
    });

    const sourceCanvas = createCanvas(4, 2);
    const sourceCtx = sourceCanvas.getContext('2d');
    sourceCtx.fillStyle = '#ff0000';
    sourceCtx.fillRect(0, 0, 4, 2);
    const screenshotB64 = sourceCanvas.toBuffer('image/png').toString('base64');

    const prompt = new AgentMessagePrompt({
      browser_state_summary: browserState,
      file_system: {
        describe: () => '/tmp',
        get_todo_contents: () => '',
      } as any,
      task: 'test',
      screenshots: [screenshotB64],
      sample_images: [new ContentPartTextParam('Sample image context')],
      llm_screenshot_size: [2, 1],
    });

    const userMessage = prompt.get_user_message(true) as any;
    expect(Array.isArray(userMessage.content)).toBe(true);

    const parts = userMessage.content as any[];
    const sampleTextPart = parts.find(
      (part) => part?.type === 'text' && part?.text === 'Sample image context'
    );
    expect(sampleTextPart).toBeTruthy();

    const screenshotPart = parts.find(
      (part) =>
        part?.type === 'image_url' &&
        String(part?.image_url?.url ?? '').startsWith('data:image/png;base64,')
    );
    expect(screenshotPart).toBeTruthy();

    const resizedBase64 = String(screenshotPart.image_url.url).split(',')[1];
    const resizedImage = new Image();
    resizedImage.src = Buffer.from(resizedBase64, 'base64');
    expect(resizedImage.width).toBe(2);
    expect(resizedImage.height).toBe(1);
  });

  it('formats step info and available file paths using c011 prompt style', () => {
    const root = new DOMElementNode(true, null, 'body', '/body', {}, []);
    const domState = new DOMState(root, {});
    const browserState = new BrowserStateSummary(domState, {
      url: 'https://example.com',
      title: 'Example',
      tabs: [{ page_id: 0, url: 'https://example.com', title: 'Example' }],
    });

    const prompt = new AgentMessagePrompt({
      browser_state_summary: browserState,
      file_system: {
        describe: () => '/tmp',
        get_todo_contents: () => '',
      } as any,
      task: 'test',
      step_info: { step_number: 0, max_steps: 5 } as any,
      available_file_paths: ['/tmp/report.pdf'],
    });

    const userMessage = prompt.get_user_message(false) as any;
    const content = String(userMessage.content ?? '');

    const userRequestIndex = content.indexOf('<user_request>');
    const agentHistoryIndex = content.indexOf('<agent_history>');
    const agentStateIndex = content.indexOf('<agent_state>');
    const browserStateIndex = content.indexOf('<browser_state>');
    const stepInfoIndex = content.indexOf('<step_info>');

    expect(userRequestIndex).toBeGreaterThanOrEqual(0);
    expect(agentHistoryIndex).toBeGreaterThan(userRequestIndex);
    expect(agentStateIndex).toBeGreaterThan(agentHistoryIndex);
    expect(browserStateIndex).toBeGreaterThan(agentStateIndex);
    expect(stepInfoIndex).toBeGreaterThan(browserStateIndex);
    expect(content).toContain('<step_info>Step1 maximum:5');
    expect(content).toMatch(/Today:\d{4}-\d{2}-\d{2}/);
    expect(content).toContain(
      '<available_file_paths>/tmp/report.pdf\nUse with absolute paths</available_file_paths>'
    );

    const agentState = content.match(
      /<agent_state>\n([\s\S]*?)\n<\/agent_state>/
    )?.[1];
    expect(agentState).toBeTruthy();
    expect(agentState).not.toContain('<user_request>');
    expect(agentState).not.toContain('<step_info>');
  });

  it('injects unavailable skills info and sanitizes invalid surrogates', () => {
    const root = new DOMElementNode(true, null, 'body', '/body', {}, []);
    const domState = new DOMState(root, {});
    const browserState = new BrowserStateSummary(domState, {
      url: 'https://example.com',
      title: 'Example',
      tabs: [{ page_id: 0, url: 'https://example.com', title: 'Example' }],
    });

    const prompt = new AgentMessagePrompt({
      browser_state_summary: browserState,
      file_system: {
        describe: () => '/tmp',
        get_todo_contents: () => '',
      } as any,
      task: 'test',
      unavailable_skills_info:
        'Unavailable Skills (missing required cookies):\n  - private_area ("Private Area")\n    Missing cookies: broken-\uD800-cookie',
    });

    const userMessage = prompt.get_user_message(false) as any;
    const content = String(userMessage.content ?? '');
    expect(content).toContain('Unavailable Skills (missing required cookies):');
    expect(content).toContain('private_area ("Private Area")');
    expect(content.includes('\uD800')).toBe(false);
  });
});

describe('SystemPrompt template selection parity', () => {
  it('keeps the default thinking prompt aligned with grounding and shadow DOM guidance', () => {
    const prompt = new SystemPrompt();
    const text = prompt.get_system_message().text;

    expect(text).toContain('tree-style XML format');
    expect(text).toContain('`|SHADOW(open)|` or `|SHADOW(closed)|`');
    expect(text).toContain('Blocking error check:');
    expect(text).toContain('Elements inside shadow DOM');
  });

  it('keeps the no-thinking prompt aligned with automatic captcha handling', () => {
    const prompt = new SystemPrompt(3, null, null, false);
    const text = prompt.get_system_message().text;

    expect(text).toContain('CAPTCHAs are automatically solved by the browser.');
    expect(text).toContain('Verify data grounding:');
    expect(text).toContain('Blocking error check:');
  });

  it('uses browser-use thinking template for browser-use models', () => {
    const prompt = new SystemPrompt(
      5,
      null,
      null,
      true,
      false,
      false,
      true,
      'browser-use/agent'
    );
    expect(prompt.get_system_message().text).toContain(
      'You are a browser-use agent operating in thinking mode.'
    );
  });

  it('uses browser-use flash template in flash mode', () => {
    const prompt = new SystemPrompt(
      5,
      null,
      null,
      true,
      true,
      false,
      true,
      'browser-use/agent'
    );
    expect(prompt.get_system_message().text).toContain(
      'You are a browser-use agent operating in flash mode.'
    );
  });

  it('uses anthropic flash template for anthropic models in flash mode', () => {
    const prompt = new SystemPrompt(
      5,
      null,
      null,
      true,
      true,
      true,
      false,
      'claude-3-7-sonnet'
    );
    expect(prompt.get_system_message().text).toContain(
      'You must call the AgentOutput tool with the following schema for the arguments'
    );
  });

  it('uses anthropic 4.5 flash template for opus/haiku 4.5 models', () => {
    const prompt = new SystemPrompt(
      5,
      null,
      null,
      true,
      true,
      true,
      false,
      'claude-opus-4.5'
    );
    expect(prompt.get_system_message().text).toContain(
      'Operating effectively in an agent loop with persistent state'
    );
  });

  it('keeps the generic flash prompt aligned with blocking-error and grounding checks', () => {
    const prompt = new SystemPrompt(3, null, null, true, true);
    const text = prompt.get_system_message().text;

    expect(text).toContain('BLOCKING ERROR CHECK:');
    expect(text).toContain('DATA GROUNDING:');
  });

  it('keeps the anthropic 4.5 flash prompt aligned with automatic captcha handling', () => {
    const prompt = new SystemPrompt(
      3,
      null,
      null,
      true,
      true,
      true,
      false,
      'claude-opus-4.5'
    );
    const text = prompt.get_system_message().text;

    expect(text).toContain('CAPTCHAs are automatically solved by the browser.');
    expect(text).toContain('Are there any obstacles (popups, login walls)?');
    expect(text).toContain('Blocking error check:');
    expect(text).toContain('1. <user_request>: Your ultimate objective.');
    expect(text).toContain(
      '3. <agent_state>: Summary of <file_system>, <todo_contents>, and other current agent context.'
    );
    expect(text).not.toContain('Current <user_request>');
  });
});
