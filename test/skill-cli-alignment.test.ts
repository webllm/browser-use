import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { BrowserProfile } from '../src/browser/profile.js';
import { BrowserSession } from '../src/browser/session.js';
import { MAX_CLI_EVAL_OUTPUT_CHARS } from '../src/skill-cli/page-inspection.js';
import {
  Request,
  Response,
  SessionRegistry,
  SkillCliServer,
} from '../src/skill-cli/index.js';

describe('skill-cli alignment', () => {
  it('round-trips protocol request/response JSON payloads', () => {
    const request = new Request({
      id: 'r1',
      action: 'open',
      session: 'default',
      params: { url: 'https://example.com' },
    });
    const parsedRequest = Request.from_json(request.to_json());
    expect(parsedRequest).toEqual(request);

    const response = new Response({
      id: 'r1',
      success: true,
      data: { ok: true },
    });
    const parsedResponse = Response.from_json(response.to_json());
    expect(parsedResponse).toEqual(response);
  });

  it('handles open action through session registry and browser session', async () => {
    const session = new BrowserSession();
    const navigateSpy = vi
      .spyOn(session, 'navigate_to')
      .mockResolvedValue(null as any);
    const registry = new SessionRegistry({
      session_factory: () => session,
    });
    const server = new SkillCliServer({ registry });

    const response = await server.handle_request(
      new Request({
        id: 'r2',
        action: 'open',
        session: 'default',
        params: { url: 'https://example.com' },
      })
    );

    expect(response.success).toBe(true);
    expect(response.data).toEqual({ url: 'https://example.com' });
    expect(navigateSpy).toHaveBeenCalledWith('https://example.com');
  });

  it('returns error response when click target index is not found', async () => {
    const session = new BrowserSession();
    vi.spyOn(session, 'get_dom_element_by_index').mockImplementation(
      async () => null as any
    );
    const registry = new SessionRegistry({
      session_factory: () => session,
    });
    const server = new SkillCliServer({ registry });

    const response = await server.handle_request(
      new Request({
        id: 'r3',
        action: 'click',
        session: 'default',
        params: { index: 99 },
      })
    );

    expect(response.success).toBe(false);
    expect(String(response.error)).toContain('not found');
  });

  it('lists sessions and closes session via close action', async () => {
    const session = new BrowserSession();
    vi.spyOn(session, 'navigate_to').mockResolvedValue(null as any);
    const stopSpy = vi.spyOn(session, 'stop').mockResolvedValue();
    const registry = new SessionRegistry({
      session_factory: () => session,
    });
    const server = new SkillCliServer({ registry });

    await server.handle_request(
      new Request({
        id: 'r4',
        action: 'open',
        session: 'default',
        params: { url: 'https://example.com' },
      })
    );

    const listed = await server.handle_request(
      new Request({
        id: 'r5',
        action: 'sessions',
        session: 'default',
      })
    );
    expect(listed.success).toBe(true);
    expect((listed.data as any).count).toBe(1);

    const closed = await server.handle_request(
      new Request({
        id: 'r6',
        action: 'close',
        session: 'default',
      })
    );
    expect(closed.success).toBe(true);
    expect(stopSpy).toHaveBeenCalledTimes(1);
  });

  it('supports hover, double-click, and right-click actions', async () => {
    const session = new BrowserSession();
    const locator = {
      hover: vi.fn(async () => {}),
      dblclick: vi.fn(async () => {}),
      click: vi.fn(async () => {}),
    };
    const page = {
      url: vi.fn(() => 'https://example.com'),
      waitForLoadState: vi.fn(async () => {}),
    };
    vi.spyOn(session, 'get_dom_element_by_index').mockResolvedValue({} as any);
    vi.spyOn(session, 'get_locate_element').mockResolvedValue(locator as any);
    vi.spyOn(session, 'get_current_page').mockResolvedValue(page as any);
    const validateSpy = vi
      .spyOn(session, 'validate_page_after_action')
      .mockResolvedValue();
    const registry = new SessionRegistry({
      session_factory: () => session,
    });
    const server = new SkillCliServer({ registry });

    const hover = await server.handle_request(
      new Request({
        id: 'r7',
        action: 'hover',
        session: 'default',
        params: { index: 1 },
      })
    );
    const dblclick = await server.handle_request(
      new Request({
        id: 'r8',
        action: 'dblclick',
        session: 'default',
        params: { index: 1 },
      })
    );
    const rightclick = await server.handle_request(
      new Request({
        id: 'r9',
        action: 'rightclick',
        session: 'default',
        params: { index: 1 },
      })
    );

    expect(hover.success).toBe(true);
    expect(dblclick.success).toBe(true);
    expect(rightclick.success).toBe(true);
    expect(locator.hover).toHaveBeenCalledWith({ timeout: 5000 });
    expect(locator.dblclick).toHaveBeenCalledWith({ timeout: 5000 });
    expect(locator.click).toHaveBeenCalledWith({
      button: 'right',
      timeout: 5000,
    });
    expect(validateSpy).toHaveBeenCalledTimes(6);
    expect(validateSpy).toHaveBeenCalledWith(page);
  });

  it('rolls back disallowed navigations from hover actions', async () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({
        allowed_domains: ['https://example.com'],
      }),
    });
    let pageUrl = 'https://example.com/start';
    const page = {
      goto: vi.fn(async (url: string) => {
        pageUrl = url;
      }),
      title: vi.fn(async () => pageUrl),
      url: vi.fn(() => pageUrl),
      waitForLoadState: vi.fn(async () => {}),
    };
    const locator = {
      hover: vi.fn(async () => {
        pageUrl = 'https://evil.test/from-skill-hover?token=secret';
      }),
    };
    vi.spyOn(session, 'get_current_page').mockResolvedValue(page as any);
    vi.spyOn(session, 'get_dom_element_by_index').mockResolvedValue({} as any);
    vi.spyOn(session, 'get_locate_element').mockResolvedValue(locator as any);
    const registry = new SessionRegistry({
      session_factory: () => session,
    });
    const server = new SkillCliServer({ registry });

    const response = await server.handle_request(
      new Request({
        id: 'r10',
        action: 'hover',
        session: 'default',
        params: { index: 1 },
      })
    );

    expect(response.success).toBe(false);
    expect(response.error).toContain('allowed_domains');
    expect(page.goto).toHaveBeenCalledWith(
      'about:blank',
      expect.objectContaining({ waitUntil: 'load' })
    );
    expect(session.active_tab?.url).toBe('about:blank');
  });

  it('supports wait and cookie commands', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-skill-')
    );
    const cookiesPath = path.join(tempDir, 'cookies.json');
    const session = new BrowserSession();
    const waitForElementSpy = vi
      .spyOn(session, 'wait_for_element')
      .mockResolvedValue();
    const waitTextPage = {
      waitForFunction: vi.fn(async () => {}),
      url: () => 'https://example.com',
    };
    vi.spyOn(session, 'get_current_page').mockResolvedValue(
      waitTextPage as any
    );
    const validateSpy = vi
      .spyOn(session, 'validate_page_after_action')
      .mockResolvedValue();
    vi.spyOn(session, 'get_cookies').mockResolvedValue([
      { name: 'sid', value: '123', domain: '.example.com', path: '/' } as any,
      {
        name: 'admin',
        value: '777',
        domain: '.example.com',
        path: '/admin',
      } as any,
      {
        name: 'other',
        value: '999',
        domain: '.elsewhere.test',
        path: '/',
      } as any,
    ]);
    (session as any).browser_context = {
      addCookies: vi.fn(async () => {}),
      clearCookies: vi.fn(async () => {}),
      cookies: vi.fn(async () => [{ name: 'sid', value: '123' }]),
    };
    const registry = new SessionRegistry({
      session_factory: () => session,
    });
    const server = new SkillCliServer({ registry });

    try {
      const waitSelector = await server.handle_request(
        new Request({
          id: 'r10',
          action: 'wait_selector',
          session: 'default',
          params: { selector: '#app', timeout: 2500 },
        })
      );
      const waitText = await server.handle_request(
        new Request({
          id: 'r11',
          action: 'wait_text',
          session: 'default',
          params: { text: 'Ready', timeout: 2500 },
        })
      );
      const cookiesGet = await server.handle_request(
        new Request({
          id: 'r12',
          action: 'cookies_get',
          session: 'default',
        })
      );
      const cookiesExport = await server.handle_request(
        new Request({
          id: 'r13',
          action: 'cookies_export',
          session: 'default',
          params: { file: cookiesPath, url: 'https://example.com/dashboard' },
        })
      );
      const cookiesImport = await server.handle_request(
        new Request({
          id: 'r14',
          action: 'cookies_import',
          session: 'default',
          params: { file: cookiesPath },
        })
      );
      const cookiesClear = await server.handle_request(
        new Request({
          id: 'r15',
          action: 'cookies_clear',
          session: 'default',
          params: { url: 'https://example.com/dashboard' },
        })
      );
      const cookiesSet = await server.handle_request(
        new Request({
          id: 'r16',
          action: 'cookies_set',
          session: 'default',
          params: {
            name: 'sid',
            value: '456',
            same_site: 'Strict',
            expires: 1735689600,
          },
        })
      );

      expect(waitSelector.success).toBe(true);
      expect(waitText.success).toBe(true);
      expect(waitForElementSpy).toHaveBeenCalledWith('#app', 2500);
      expect(validateSpy).toHaveBeenCalledWith(waitTextPage);
      expect(cookiesGet.success).toBe(true);
      expect((cookiesGet.data as any).count).toBe(3);
      expect(cookiesExport.success).toBe(true);
      expect(fs.existsSync(cookiesPath)).toBe(true);
      if (process.platform !== 'win32') {
        expect(fs.statSync(cookiesPath).mode & 0o777).toBe(0o600);
      }
      expect(JSON.parse(fs.readFileSync(cookiesPath, 'utf8'))).toEqual([
        expect.objectContaining({ name: 'sid' }),
      ]);
      expect(cookiesImport.success).toBe(true);
      expect(cookiesSet.success).toBe(true);
      expect((session as any).browser_context.addCookies).toHaveBeenCalledWith([
        expect.objectContaining({
          name: 'sid',
          value: '456',
          sameSite: 'Strict',
          expires: 1735689600,
          url: 'https://example.com',
        }),
      ]);
      expect(cookiesClear.success).toBe(true);
      expect((session as any).browser_context.clearCookies).toHaveBeenCalled();
      expect((session as any).browser_context.addCookies).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ name: 'admin' }),
          expect.objectContaining({ name: 'other' }),
        ])
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('respects domain policy for cookie set and import commands', async () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-use-skill-')
    );
    const cookiesPath = path.join(tempDir, 'cookies.json');
    fs.writeFileSync(
      cookiesPath,
      JSON.stringify([
        { name: 'sid', value: '123', domain: '.example.com', path: '/' },
        { name: 'blocked', value: '1', domain: '.evil.test', path: '/' },
      ])
    );
    const exportPath = path.join(tempDir, 'exported-cookies.json');

    const session = new BrowserSession({
      browser_profile: new BrowserProfile({
        allowed_domains: ['https://example.com'],
      }),
    });
    vi.spyOn(session, 'get_current_page').mockResolvedValue({
      url: () => 'https://example.com',
    } as any);
    vi.spyOn(session, 'get_cookies').mockResolvedValue([
      { name: 'sid', value: '123', domain: '.example.com', path: '/' } as any,
      { name: 'blocked', value: '1', domain: '.evil.test', path: '/' } as any,
    ]);
    (session as any).browser_context = {
      addCookies: vi.fn(async () => {}),
      clearCookies: vi.fn(async () => {}),
    };
    const registry = new SessionRegistry({
      session_factory: () => session,
    });
    const server = new SkillCliServer({ registry });

    try {
      const blockedSet = await server.handle_request(
        new Request({
          id: 'r-cookie-set-blocked',
          action: 'cookies_set',
          session: 'default',
          params: {
            name: 'blocked',
            value: '1',
            url: 'https://evil.test',
          },
        })
      );
      const imported = await server.handle_request(
        new Request({
          id: 'r-cookie-import-filtered',
          action: 'cookies_import',
          session: 'default',
          params: { file: cookiesPath },
        })
      );
      const cookiesGet = await server.handle_request(
        new Request({
          id: 'r-cookie-get-filtered',
          action: 'cookies_get',
          session: 'default',
        })
      );
      const blockedGet = await server.handle_request(
        new Request({
          id: 'r-cookie-get-blocked-url',
          action: 'cookies_get',
          session: 'default',
          params: { url: 'https://evil.test' },
        })
      );
      const cookiesExport = await server.handle_request(
        new Request({
          id: 'r-cookie-export-filtered',
          action: 'cookies_export',
          session: 'default',
          params: { file: exportPath },
        })
      );
      const cookiesClear = await server.handle_request(
        new Request({
          id: 'r-cookie-clear-filtered',
          action: 'cookies_clear',
          session: 'default',
        })
      );

      expect(blockedSet.success).toBe(false);
      expect(String(blockedSet.error)).toContain('Cookie target blocked');
      expect(imported.success).toBe(true);
      expect((imported.data as any).imported).toBe(1);
      expect(cookiesGet.success).toBe(true);
      expect((cookiesGet.data as any).count).toBe(1);
      expect((cookiesGet.data as any).cookies).toEqual([
        { name: 'sid', value: '123', domain: '.example.com', path: '/' },
      ]);
      expect(blockedGet.success).toBe(false);
      expect(String(blockedGet.error)).toContain('Cookie URL blocked');
      expect(cookiesExport.success).toBe(true);
      expect((cookiesExport.data as any).count).toBe(1);
      expect(JSON.parse(fs.readFileSync(exportPath, 'utf8'))).toEqual([
        { name: 'sid', value: '123', domain: '.example.com', path: '/' },
      ]);
      expect(cookiesClear.success).toBe(true);
      expect((cookiesClear.data as any).count).toBe(1);
      expect((session as any).browser_context.clearCookies).toHaveBeenCalled();
      expect((session as any).browser_context.addCookies).toHaveBeenCalledTimes(
        2
      );
      expect(
        (session as any).browser_context.addCookies
      ).toHaveBeenNthCalledWith(1, [
        { name: 'sid', value: '123', domain: '.example.com', path: '/' },
      ]);
      expect(
        (session as any).browser_context.addCookies
      ).toHaveBeenNthCalledWith(2, [
        { name: 'blocked', value: '1', domain: '.evil.test', path: '/' },
      ]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('does not clear blocked subdomain cookies when clearing a parent URL', async () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({
        allowed_domains: ['https://example.com'],
      }),
    });
    vi.spyOn(session, 'get_cookies').mockResolvedValue([
      { name: 'sid', value: '123', domain: '.example.com', path: '/' } as any,
      {
        name: 'blocked',
        value: '1',
        domain: '.evil.example.com',
        path: '/',
      } as any,
    ]);
    (session as any).browser_context = {
      addCookies: vi.fn(async () => {}),
      clearCookies: vi.fn(async () => {}),
    };
    const registry = new SessionRegistry({
      session_factory: () => session,
    });
    const server = new SkillCliServer({ registry });

    const response = await server.handle_request(
      new Request({
        id: 'r-cookie-clear-parent-url',
        action: 'cookies_clear',
        session: 'default',
        params: { url: 'https://example.com' },
      })
    );

    expect(response.success).toBe(true);
    expect((response.data as any).count).toBe(1);
    expect((session as any).browser_context.clearCookies).toHaveBeenCalled();
    expect((session as any).browser_context.addCookies).toHaveBeenCalledWith([
      {
        name: 'blocked',
        value: '1',
        domain: '.evil.example.com',
        path: '/',
      },
    ]);
  });

  it('supports screenshot action with inline and file outputs', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-use-shot-'));
    const screenshotPath = path.join(tempDir, 'capture.png');
    const session = new BrowserSession();
    vi.spyOn(session, 'take_screenshot').mockResolvedValue(
      Buffer.from('fake-png').toString('base64')
    );
    const registry = new SessionRegistry({
      session_factory: () => session,
    });
    const server = new SkillCliServer({ registry });

    try {
      const inline = await server.handle_request(
        new Request({
          id: 'r16',
          action: 'screenshot',
          session: 'default',
        })
      );
      const saved = await server.handle_request(
        new Request({
          id: 'r17',
          action: 'screenshot',
          session: 'default',
          params: { file: screenshotPath },
        })
      );

      expect(inline.success).toBe(true);
      expect((inline.data as any).screenshot).toBeTypeOf('string');
      expect(saved.success).toBe(true);
      expect((saved.data as any).file).toBe(screenshotPath);
      expect(fs.existsSync(screenshotPath)).toBe(true);
      if (process.platform !== 'win32') {
        expect(fs.statSync(screenshotPath).mode & 0o777).toBe(0o600);
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('supports expanded browser control actions', async () => {
    const session = new BrowserSession();
    const node = {} as any;
    vi.spyOn(session, 'get_dom_element_by_index').mockResolvedValue(node);
    const inputSpy = vi
      .spyOn(session, '_input_text_element_node')
      .mockResolvedValue(null as any);
    const scrollSpy = vi.spyOn(session, 'scroll').mockResolvedValue();
    const backSpy = vi.spyOn(session, 'go_back').mockResolvedValue();
    const forwardSpy = vi.spyOn(session, 'go_forward').mockResolvedValue();
    const switchSpy = vi
      .spyOn(session, 'switch_to_tab')
      .mockResolvedValue({} as any);
    const closeTabSpy = vi.spyOn(session, 'close_tab').mockResolvedValue();
    const sendKeysSpy = vi.spyOn(session, 'send_keys').mockResolvedValue();
    const selectSpy = vi
      .spyOn(session, 'select_dropdown_option')
      .mockResolvedValue(['selected'] as any);
    const getPageHtmlSpy = vi
      .spyOn(session, 'get_page_html')
      .mockResolvedValue('<html></html>');
    const pageEvaluate = vi.fn(
      async (fn: (input: any) => unknown, input: any) => await fn(input)
    );
    vi.spyOn(session, 'get_current_page').mockResolvedValue({
      evaluate: pageEvaluate,
    } as any);

    const registry = new SessionRegistry({
      session_factory: () => session,
    });
    const server = new SkillCliServer({ registry });

    const input = await server.handle_request(
      new Request({
        id: 'r18',
        action: 'input',
        session: 'default',
        params: { index: 2, text: 'hello', clear: false },
      })
    );
    const scroll = await server.handle_request(
      new Request({
        id: 'r19',
        action: 'scroll',
        session: 'default',
        params: { direction: 'up', amount: 250 },
      })
    );
    const back = await server.handle_request(
      new Request({
        id: 'r20',
        action: 'back',
        session: 'default',
      })
    );
    const forward = await server.handle_request(
      new Request({
        id: 'r21',
        action: 'forward',
        session: 'default',
      })
    );
    const sw = await server.handle_request(
      new Request({
        id: 'r22',
        action: 'switch',
        session: 'default',
        params: { tab: 3 },
      })
    );
    const closeTab = await server.handle_request(
      new Request({
        id: 'r23',
        action: 'close-tab',
        session: 'default',
      })
    );
    const keys = await server.handle_request(
      new Request({
        id: 'r24',
        action: 'keys',
        session: 'default',
        params: { keys: 'Control+a' },
      })
    );
    const select = await server.handle_request(
      new Request({
        id: 'r25',
        action: 'select',
        session: 'default',
        params: { index: 2, value: 'Option A' },
      })
    );
    const html = await server.handle_request(
      new Request({
        id: 'r26',
        action: 'html',
        session: 'default',
      })
    );
    const evaluated = await server.handle_request(
      new Request({
        id: 'r27',
        action: 'eval',
        session: 'default',
        params: { js: '({ ok: true })' },
      })
    );
    const oversizedEvaluation = await server.handle_request(
      new Request({
        id: 'r27-large',
        action: 'eval',
        session: 'default',
        params: { js: "'x'.repeat(200000)" },
      })
    );

    expect(input.success).toBe(true);
    expect(inputSpy).toHaveBeenCalledWith(node, 'hello', { clear: false });
    expect(input.data).toEqual({ input: 2, characters: 5, clear: false });
    expect(JSON.stringify(input.data)).not.toContain('hello');
    expect(scroll.success).toBe(true);
    expect(scrollSpy).toHaveBeenCalledWith('up', 250);
    expect(back.success).toBe(true);
    expect(backSpy).toHaveBeenCalledTimes(1);
    expect(forward.success).toBe(true);
    expect(forwardSpy).toHaveBeenCalledTimes(1);
    expect(sw.success).toBe(true);
    expect(switchSpy).toHaveBeenCalledWith(3);
    expect(closeTab.success).toBe(true);
    expect(closeTabSpy).toHaveBeenCalledWith(session.active_tab?.target_id);
    expect(keys.success).toBe(true);
    expect(sendKeysSpy).toHaveBeenCalledWith('Control+a');
    expect(keys.data).toEqual({ keys: true });
    expect(select.success).toBe(true);
    expect(selectSpy).toHaveBeenCalledWith(node, 'Option A');
    expect(select.data).toEqual({ index: 2, selected: true });
    expect(JSON.stringify(select.data)).not.toContain('Option A');
    expect(html.success).toBe(true);
    expect((html.data as any).html).toBe('<html></html>');
    expect(getPageHtmlSpy).toHaveBeenCalledTimes(1);
    expect(evaluated.success).toBe(true);
    expect((evaluated.data as any).result).toEqual({ ok: true });
    expect(oversizedEvaluation.success).toBe(true);
    expect((oversizedEvaluation.data as any).truncated).toBe(true);
    expect((oversizedEvaluation.data as any).result.length).toBeLessThanOrEqual(
      MAX_CLI_EVAL_OUTPUT_CHARS
    );
    expect(pageEvaluate).toHaveBeenCalled();
  });

  it('supports get and extract actions', async () => {
    const session = new BrowserSession();
    const node = { xpath: '//*[@data-id="target"]' } as any;
    vi.spyOn(session, 'get_dom_element_by_index').mockResolvedValue(node);
    const validateSpy = vi
      .spyOn(session, 'validate_page_after_action')
      .mockResolvedValue();
    vi.spyOn(session, 'get_current_page').mockResolvedValue({
      title: vi.fn(async () => 'Example Title'),
      evaluate: vi.fn(
        async (_fn: unknown, input: { xpath: string; dataKind: string }) => {
          if (input.dataKind === 'text') {
            return 'Visible text';
          }
          if (input.dataKind === 'attributes') {
            return { 'data-id': 'target' };
          }
          return null;
        }
      ),
    } as any);
    const registry = new SessionRegistry({
      session_factory: () => session,
    });
    const server = new SkillCliServer({ registry });

    const getTitle = await server.handle_request(
      new Request({
        id: 'r28',
        action: 'get_title',
        session: 'default',
      })
    );
    const getText = await server.handle_request(
      new Request({
        id: 'r29',
        action: 'get_text',
        session: 'default',
        params: { index: 4 },
      })
    );
    const getAttributes = await server.handle_request(
      new Request({
        id: 'r30',
        action: 'get_attributes',
        session: 'default',
        params: { index: 4 },
      })
    );
    const extract = await server.handle_request(
      new Request({
        id: 'r31',
        action: 'extract',
        session: 'default',
        params: { query: 'Extract name' },
      })
    );

    expect(getTitle.success).toBe(true);
    expect((getTitle.data as any).title).toBe('Example Title');
    expect(getText.success).toBe(true);
    expect((getText.data as any).text).toBe('Visible text');
    expect(getAttributes.success).toBe(true);
    expect((getAttributes.data as any).attributes).toEqual({
      'data-id': 'target',
    });
    expect(validateSpy).toHaveBeenCalledTimes(6);
    expect(extract.success).toBe(false);
    expect(String(extract.error)).toContain('extract requires agent mode');
  });
});
