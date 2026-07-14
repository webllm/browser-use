import { describe, expect, it, vi } from 'vitest';
import type { BaseChatModel } from '../src/llm/base.js';
import { Agent } from '../src/agent/service.js';
import { BrowserProfile } from '../src/browser/profile.js';
import { BrowserSession } from '../src/browser/session.js';
import {
  MissingCookieException,
  type SkillService,
} from '../src/skills/index.js';

const createLlm = (): BaseChatModel =>
  ({
    model: 'gpt-test',
    provider: 'test',
    get name() {
      return 'test';
    },
    get model_name() {
      return 'gpt-test';
    },
    ainvoke: vi.fn(async () => ({ completion: 'ok', usage: null })),
  }) as unknown as BaseChatModel;

describe('Agent skills alignment', () => {
  it('rejects simultaneous skills and skill_ids configuration', () => {
    expect(
      () =>
        new Agent({
          task: 'test',
          llm: createLlm(),
          skills: ['skill-a'],
          skill_ids: ['skill-b'],
        })
    ).toThrow('Cannot specify both "skills" and "skill_ids"');
  });

  it('registers skills as actions and forwards parameters plus cookies', async () => {
    const browserSession = new BrowserSession({
      browser_profile: new BrowserProfile({}),
    });
    vi.spyOn(browserSession, 'get_cookies').mockResolvedValue([
      { name: 'auth_token', value: 'cookie-value' } as any,
    ]);

    const skillService: SkillService = {
      get_all_skills: vi.fn(
        async () =>
          [
            {
              id: 'skill-weather',
              title: 'Get Weather Data',
              description: 'Fetch weather for a city',
              parameters: [
                { name: 'city', type: 'string', required: true },
                { name: 'auth_token', type: 'cookie', required: true },
              ],
              output_schema: null,
            },
          ] as any
      ),
      execute_skill: vi.fn(async ({ skill_id, parameters, cookies }) => ({
        success: true,
        result: {
          skill_id,
          parameters,
          cookie_count: cookies.length,
        },
      })),
      close: vi.fn(async () => {}),
    };

    const agent = new Agent({
      task: 'use weather skill',
      llm: createLlm(),
      browser_session: browserSession,
      skill_service: skillService,
    });

    await (agent as any)._register_skills_as_actions();

    const actionInfo = agent.controller.registry.get_action('get_weather_data');
    expect(actionInfo).not.toBeNull();

    const result = (await agent.controller.registry.execute_action(
      'get_weather_data',
      { city: 'Berlin' },
      { browser_session: browserSession }
    )) as any;

    expect(result?.error ?? null).toBeNull();
    expect(typeof result?.extracted_content).toBe('string');
    expect((skillService.execute_skill as any).mock.calls[0][0]).toEqual({
      skill_id: 'skill-weather',
      parameters: { city: 'Berlin' },
      cookies: [{ name: 'auth_token', value: 'cookie-value' }],
    });

    await agent.close();
  });

  it('bounds skill results before storing them in agent history fields', async () => {
    const browserSession = new BrowserSession({
      browser_profile: new BrowserProfile({}),
    });
    vi.spyOn(browserSession, 'get_cookies').mockResolvedValue([]);
    const skillService: SkillService = {
      get_all_skills: vi.fn(async () => [
        {
          id: 'large-result',
          title: 'Large Result',
          description: 'Returns a large result',
          parameters: [],
        },
      ]),
      execute_skill: vi.fn(async () => ({
        success: true,
        result: 'x'.repeat(2 * 1024 * 1024),
      })),
    };
    const agent = new Agent({
      task: 'use large skill',
      llm: createLlm(),
      browser_session: browserSession,
      skill_service: skillService,
    });

    await (agent as any)._register_skills_as_actions();
    const result = (await agent.controller.registry.execute_action(
      'large_result',
      {},
      { browser_session: browserSession }
    )) as any;

    expect(result.extracted_content.length).toBeLessThanOrEqual(256 * 1024);
    expect(result.extracted_content).toContain('Skill result truncated');
    expect(result.long_term_memory.length).toBeLessThanOrEqual(60_000);

    await agent.close();
  });

  it('filters skill cookies by BrowserSession domain policy', async () => {
    const browserSession = new BrowserSession({
      browser_profile: new BrowserProfile({
        allowed_domains: ['https://example.com'],
      }),
    });
    vi.spyOn(browserSession, 'get_cookies').mockResolvedValue([
      {
        name: 'auth_token',
        value: 'allowed-cookie',
        domain: 'example.com',
        path: '/',
      } as any,
      {
        name: 'evil_token',
        value: 'blocked-cookie',
        domain: 'evil.test',
        path: '/',
      } as any,
    ]);

    const skillService: SkillService = {
      get_all_skills: vi.fn(
        async () =>
          [
            {
              id: 'skill-weather',
              title: 'Get Weather Data',
              description: 'Fetch weather for a city',
              parameters: [
                { name: 'city', type: 'string', required: true },
                { name: 'auth_token', type: 'cookie', required: true },
              ],
              output_schema: null,
            },
          ] as any
      ),
      execute_skill: vi.fn(async () => ({
        success: true,
        result: 'ok',
      })),
      close: vi.fn(async () => {}),
    };

    const agent = new Agent({
      task: 'use weather skill',
      llm: createLlm(),
      browser_session: browserSession,
      skill_service: skillService,
    });

    await (agent as any)._register_skills_as_actions();
    await agent.controller.registry.execute_action(
      'get_weather_data',
      { city: 'Berlin' },
      { browser_session: browserSession }
    );

    expect(
      (skillService.execute_skill as any).mock.calls[0][0].cookies
    ).toEqual([{ name: 'auth_token', value: 'allowed-cookie' }]);

    await agent.close();
  });

  it('keeps skills registration retryable when skill list is empty (python c011 parity)', async () => {
    const skillService: SkillService = {
      get_all_skills: vi.fn(async () => []),
      execute_skill: vi.fn(async () => ({ success: true, result: null })),
      close: vi.fn(async () => {}),
    };

    const agent = new Agent({
      task: 'retry empty skills registration',
      llm: createLlm(),
      skill_service: skillService,
    });

    await (agent as any)._register_skills_as_actions();
    expect((agent as any)._skills_registered).toBe(false);
    expect(skillService.get_all_skills).toHaveBeenCalledTimes(1);

    await (agent as any)._register_skills_as_actions();
    expect(skillService.get_all_skills).toHaveBeenCalledTimes(2);

    await agent.close();
  });

  it('maps MissingCookieException to actionable ActionResult error text', async () => {
    const browserSession = new BrowserSession({
      browser_profile: new BrowserProfile({}),
    });
    vi.spyOn(browserSession, 'get_cookies').mockResolvedValue([] as any);

    const skillService: SkillService = {
      get_all_skills: vi.fn(
        async () =>
          [
            {
              id: 'skill-private',
              title: 'Private Skill',
              description: 'Needs auth cookie',
              parameters: [
                { name: 'session_id', type: 'cookie', required: true },
              ],
              output_schema: null,
            },
          ] as any
      ),
      execute_skill: vi.fn(async () => {
        throw new MissingCookieException('session_id', 'Login required first');
      }),
      close: vi.fn(async () => {}),
    };

    const agent = new Agent({
      task: 'use private skill',
      llm: createLlm(),
      browser_session: browserSession,
      skill_service: skillService,
    });

    await (agent as any)._register_skills_as_actions();

    const result = (await agent.controller.registry.execute_action(
      'private_skill',
      {},
      { browser_session: browserSession }
    )) as any;

    expect(result.error).toContain('Missing cookies (session_id)');
    expect(result.error).toContain('Login required first');

    await agent.close();
  });

  it('builds unavailable skill info for missing required cookies', async () => {
    const browserSession = new BrowserSession({
      browser_profile: new BrowserProfile({}),
    });
    vi.spyOn(browserSession, 'get_cookies').mockResolvedValue([
      { name: 'already_present', value: 'ok' } as any,
    ]);

    const skillService: SkillService = {
      get_all_skills: vi.fn(
        async () =>
          [
            {
              id: 'skill-open',
              title: 'Open Skill',
              description: 'No cookies required',
              parameters: [{ name: 'query', type: 'string', required: true }],
              output_schema: null,
            },
            {
              id: 'skill-private',
              title: 'Private Area',
              description: 'Needs authenticated cookie',
              parameters: [
                {
                  name: 'session_id',
                  type: 'cookie',
                  required: true,
                  description: 'Login first',
                },
                {
                  name: 'already_present',
                  type: 'cookie',
                  required: true,
                  description: 'Already set',
                },
              ],
              output_schema: null,
            },
          ] as any
      ),
      execute_skill: vi.fn(async () => ({ success: true, result: null })),
      close: vi.fn(async () => {}),
    };

    const agent = new Agent({
      task: 'inspect missing skills',
      llm: createLlm(),
      browser_session: browserSession,
      skill_service: skillService,
    });

    const unavailableInfo = await (agent as any)._get_unavailable_skills_info();
    expect(unavailableInfo).toContain(
      'Unavailable Skills (missing required cookies):'
    );
    expect(unavailableInfo).toContain('private_area ("Private Area")');
    expect(unavailableInfo).toContain('session_id: Login first');
    expect(unavailableInfo).not.toContain('Open Skill');

    await agent.close();
  });

  it('ignores blocked cookies when building unavailable skill info', async () => {
    const browserSession = new BrowserSession({
      browser_profile: new BrowserProfile({
        allowed_domains: ['https://example.com'],
      }),
    });
    vi.spyOn(browserSession, 'get_cookies').mockResolvedValue([
      {
        name: 'session_id',
        value: 'blocked',
        domain: 'evil.test',
        path: '/',
      } as any,
    ]);

    const skillService: SkillService = {
      get_all_skills: vi.fn(
        async () =>
          [
            {
              id: 'skill-private',
              title: 'Private Area',
              description: 'Needs authenticated cookie',
              parameters: [
                {
                  name: 'session_id',
                  type: 'cookie',
                  required: true,
                  description: 'Login first',
                },
              ],
              output_schema: null,
            },
          ] as any
      ),
      execute_skill: vi.fn(async () => ({ success: true, result: null })),
      close: vi.fn(async () => {}),
    };

    const agent = new Agent({
      task: 'inspect missing skills',
      llm: createLlm(),
      browser_session: browserSession,
      skill_service: skillService,
    });

    const unavailableInfo = await (agent as any)._get_unavailable_skills_info();
    expect(unavailableInfo).toContain('private_area ("Private Area")');
    expect(unavailableInfo).toContain('session_id: Login first');

    await agent.close();
  });

  it('closes injected skill service during agent.close()', async () => {
    const closeSpy = vi.fn(async () => {});
    const skillService: SkillService = {
      get_all_skills: vi.fn(async () => []),
      execute_skill: vi.fn(async () => ({ success: true, result: null })),
      close: closeSpy,
    };

    const agent = new Agent({
      task: 'cleanup',
      llm: createLlm(),
      skill_service: skillService,
    });

    await agent.close();
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});
