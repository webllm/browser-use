import { describe, expect, it } from 'vitest';
import { BrowserSession } from '../src/browser/session.js';
import { BrowserProfile } from '../src/browser/profile.js';

describe('Allowed Domains Security', () => {
  it('blocks URLs that only contain allowed domains in query strings', () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({
        allowed_domains: ['example.com'],
      }),
    });

    const isAllowed = (session as any)._is_url_allowed(
      'https://evil.com/?next=https://example.com'
    );
    expect(isAllowed).toBe(false);
  });

  it('allows chrome new-tab URL variants under domain restrictions', () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({
        allowed_domains: ['example.com'],
      }),
    });

    expect((session as any)._is_url_allowed('chrome://newtab')).toBe(true);
    expect((session as any)._is_url_allowed('chrome://newtab/')).toBe(true);
  });

  it('defaults to https-only matching when no scheme is specified', () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({
        allowed_domains: ['example.com'],
      }),
    });

    expect((session as any)._is_url_allowed('https://example.com')).toBe(true);
    expect((session as any)._is_url_allowed('http://example.com')).toBe(false);
  });

  it('supports explicit scheme wildcard patterns', () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({
        allowed_domains: ['http*://example.com'],
      }),
    });

    expect((session as any)._is_url_allowed('https://example.com')).toBe(true);
    expect((session as any)._is_url_allowed('http://example.com')).toBe(true);
  });

  it('blocks prohibited domains when allowlist is not configured', () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({
        prohibited_domains: ['https://evil.com'],
      }),
    });

    expect((session as any)._is_url_allowed('https://evil.com')).toBe(false);
    expect((session as any)._is_url_allowed('https://example.com')).toBe(true);
  });

  it('applies bare root-domain policies consistently to www hosts', () => {
    const prohibitedSession = new BrowserSession({
      browser_profile: new BrowserProfile({
        prohibited_domains: ['example.com'],
      }),
    });
    const allowedSession = new BrowserSession({
      browser_profile: new BrowserProfile({
        allowed_domains: ['example.com'],
      }),
    });

    expect(
      (prohibitedSession as any)._is_url_allowed('https://example.com')
    ).toBe(false);
    expect(
      (prohibitedSession as any)._is_url_allowed('https://www.example.com')
    ).toBe(false);
    expect(
      (prohibitedSession as any)._is_url_allowed('https://mail.example.com')
    ).toBe(true);

    expect((allowedSession as any)._is_url_allowed('https://example.com')).toBe(
      true
    );
    expect(
      (allowedSession as any)._is_url_allowed('https://www.example.com')
    ).toBe(true);
    expect(
      (allowedSession as any)._is_url_allowed('https://mail.example.com')
    ).toBe(false);
  });

  it('does not expand scheme-qualified patterns to www hosts', () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({
        prohibited_domains: ['https://example.com'],
      }),
    });

    expect((session as any)._is_url_allowed('https://www.example.com')).toBe(
      true
    );
  });

  it('blocks prohibited domains written with an equivalent trailing root label', () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({
        prohibited_domains: ['https://evil.com'],
      }),
    });

    expect((session as any)._is_url_allowed('https://evil.com./path')).toBe(
      false
    );
  });

  it('canonicalizes Unicode prohibited domains to their IDNA form', () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({
        prohibited_domains: ['https://例子.测试'],
      }),
    });

    expect(
      (session as any)._is_url_allowed(
        'https://xn--fsqu00a.xn--0zwm56d/private'
      )
    ).toBe(false);
  });

  it('matches bracketed IPv6 prohibited-domain patterns', () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({
        prohibited_domains: ['https://[::1]:443'],
      }),
    });

    expect((session as any)._is_url_allowed('https://[::1]/private')).toBe(
      false
    );
  });

  it('lets prohibited_domains take precedence over allowed_domains', () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({
        allowed_domains: ['*.example.com'],
        prohibited_domains: ['https://admin.example.com'],
      }),
    });

    expect((session as any)._is_url_allowed('https://app.example.com')).toBe(
      true
    );
    expect((session as any)._is_url_allowed('https://admin.example.com')).toBe(
      false
    );
    expect((session as any)._is_url_allowed('https://other.com')).toBe(false);
  });

  it('blocks ip-address URLs when block_ip_addresses is enabled', () => {
    const session = new BrowserSession({
      browser_profile: new BrowserProfile({
        block_ip_addresses: true,
      }),
    });

    expect((session as any)._is_url_allowed('https://127.0.0.1')).toBe(false);
    expect((session as any)._is_url_allowed('https://[::1]')).toBe(false);
    expect((session as any)._is_url_allowed('https://2130706433')).toBe(false);
    expect((session as any)._is_url_allowed('https://0x7f000001')).toBe(false);
    expect((session as any)._is_url_allowed('https://0177.0.0.1')).toBe(false);
    expect((session as any)._is_url_allowed('https://127.1')).toBe(false);
    expect((session as any)._is_url_allowed('https://%31%32%37.0.0.1')).toBe(
      false
    );
    expect((session as any)._is_url_allowed('https://１２７.0.0.1')).toBe(
      false
    );
    expect((session as any)._is_url_allowed('https://127。0。0。1')).toBe(
      false
    );
    expect((session as any)._is_url_allowed('https://example.com')).toBe(true);
  });

  it('blocks opaque data URLs when domain restrictions are active', () => {
    const restrictedSession = new BrowserSession({
      browser_profile: new BrowserProfile({
        allowed_domains: ['https://example.com'],
      }),
    });
    const unrestrictedSession = new BrowserSession({
      browser_profile: new BrowserProfile(),
    });

    expect(
      (restrictedSession as any)._is_url_allowed('data:text/html,<input>')
    ).toBe(false);
    expect(
      (unrestrictedSession as any)._is_url_allowed('data:text/html,<input>')
    ).toBe(true);
  });

  it('validates blob URL origins against domain restrictions', () => {
    const allowlistedSession = new BrowserSession({
      browser_profile: new BrowserProfile({
        allowed_domains: ['https://example.com'],
      }),
    });
    const prohibitedSession = new BrowserSession({
      browser_profile: new BrowserProfile({
        prohibited_domains: ['https://evil.com'],
      }),
    });

    expect(
      (allowlistedSession as any)._is_url_allowed(
        'blob:https://example.com/abc'
      )
    ).toBe(true);
    expect(
      (allowlistedSession as any)._is_url_allowed('blob:https://evil.com/abc')
    ).toBe(false);
    expect(
      (prohibitedSession as any)._is_url_allowed('blob:https://evil.com/abc')
    ).toBe(false);
  });

  it('uses optimized allowlist sets for large domain lists and matches www variants', () => {
    const domains = Array.from({ length: 120 }, (_, idx) => {
      return `site-${idx}.example.com`;
    });
    domains[0] = 'example.com';

    const session = new BrowserSession({
      browser_profile: new BrowserProfile({
        allowed_domains: domains,
      }),
    });

    expect((session as any)._is_url_allowed('https://www.example.com')).toBe(
      true
    );
    expect((session as any)._is_url_allowed('http://www.example.com')).toBe(
      false
    );
    expect((session as any)._is_url_allowed('https://unknown.example')).toBe(
      false
    );
  });

  it('uses optimized prohibited sets for large blocklists', () => {
    const domains = Array.from({ length: 120 }, (_, idx) => {
      return `blocked-${idx}.example.com`;
    });
    domains[0] = 'evil.example.com';
    domains[1] = '例子.测试';

    const session = new BrowserSession({
      browser_profile: new BrowserProfile({
        prohibited_domains: domains,
      }),
    });

    expect(
      (session as any)._is_url_allowed('https://www.evil.example.com')
    ).toBe(false);
    expect((session as any)._is_url_allowed('https://safe.example.com')).toBe(
      true
    );
    expect(
      (session as any)._is_url_allowed('https://evil.example.com./private')
    ).toBe(false);
    expect(
      (session as any)._is_url_allowed(
        'https://xn--fsqu00a.xn--0zwm56d/private'
      )
    ).toBe(false);
  });

  it('keeps wildcard allowlist patterns functional for large lists', () => {
    const domains = Array.from({ length: 120 }, (_, idx) => {
      return `site-${idx}.example.com`;
    });
    domains[0] = '*.example.com';

    const profile = new BrowserProfile({
      allowed_domains: domains,
    });
    const session = new BrowserSession({
      browser_profile: profile,
    });

    expect(Array.isArray(profile.config.allowed_domains)).toBe(true);
    expect((session as any)._is_url_allowed('https://sub.example.com')).toBe(
      true
    );
  });

  it('keeps wildcard blocklist patterns functional for large lists', () => {
    const domains = Array.from({ length: 120 }, (_, idx) => {
      return `blocked-${idx}.example.com`;
    });
    domains[0] = '*.evil.test';

    const profile = new BrowserProfile({
      prohibited_domains: domains,
    });
    const session = new BrowserSession({
      browser_profile: profile,
    });

    expect(Array.isArray(profile.config.prohibited_domains)).toBe(true);
    expect((session as any)._is_url_allowed('https://sub.evil.test')).toBe(
      false
    );
  });
});
