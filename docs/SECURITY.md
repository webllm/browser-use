# Security Guide

Browser-Use handles sensitive operations including browser automation, credential management, and API keys. This guide covers security best practices and features.

## Table of Contents

- [Sensitive Data Management](#sensitive-data-management)
- [API Key Protection](#api-key-protection)
- [Domain Restrictions](#domain-restrictions)
- [Browser Security](#browser-security)
- [Network Security](#network-security)
- [Logging and Telemetry](#logging-and-telemetry)
- [Production Deployment](#production-deployment)
- [Security Checklist](#security-checklist)

---

## Sensitive Data Management

### Sensitive Data Map

Browser-Use provides secure credential handling through the `sensitive_data` option:

```typescript
import { Agent } from 'browser-use';

const agent = new Agent({
  task: 'Login to the dashboard',
  llm,
  sensitive_data: {
    // Domain-scoped credentials
    '*.example.com': {
      username: 'user@example.com',
      password: 'secure-password-123',
    },
    // Global credentials (available on all domains)
    api_key: 'sk-secret-key',
  },
});
```

### How It Works

1. **Masking in Logs**: Sensitive values are automatically masked in logs and conversation history
2. **Domain Scoping**: Domain-scoped credentials are only available on matching domains
3. **Secret Placeholders**: Use `<secret>key</secret>` pattern in prompts to reference credentials
4. **Memory Isolation**: Sensitive data is not included in LLM context
5. **Unlocked Sensitive Data Warning**: Browser-Use warns when `sensitive_data` is configured without `allowed_domains`

If `sensitive_data` is provided without `allowed_domains`, Agent construction continues but logs a security warning. For production credentialed tasks, configure `allowed_domains` so navigation is locked to trusted domains.

```typescript
const agent = new Agent({
  task: 'Log in and fetch invoices',
  llm,
  sensitive_data: { password: 'secret' },
  browser_session: new BrowserSession({
    browser_profile: new BrowserProfile({
      allowed_domains: ['example.com', '*.example.com'],
    }),
  }),
});
```

### Domain Patterns

```typescript
const sensitiveData = {
  // Exact domain match
  'example.com': { ... },

  // Wildcard subdomain
  '*.example.com': { ... },  // Matches app.example.com, api.example.com, etc.

  // Multiple domains (use separate entries)
  'site1.com': { ... },
  'site2.com': { ... },

  // Global (no domain prefix)
  'global_api_key': 'value'
};
```

### Usage in Actions

```typescript
// In custom actions, check for sensitive data availability
controller.registry.action('Login with credentials', {
  param_model: z.object({
    username_field: z.number(),
    password_field: z.number(),
  }),
})(async function login(params, ctx) {
  if (!ctx.has_sensitive_data) {
    return new ActionResult({
      error: 'No credentials configured for this domain',
    });
  }

  // Credentials are automatically injected based on current domain
  // The LLM uses <secret>username</secret> pattern

  return new ActionResult({
    extracted_content: 'Login attempted',
  });
});
```

---

## API Key Protection

### Environment Variables

Always use environment variables for API keys:

```bash
# .env file (never commit!)
OPENAI_API_KEY=sk-your-openai-key
ANTHROPIC_API_KEY=sk-ant-your-anthropic-key
GOOGLE_API_KEY=your-google-key
```

```typescript
import 'dotenv/config';
import { ChatOpenAI } from 'browser-use/llm/openai';

const llm = new ChatOpenAI({
  model: 'gpt-4o',
  apiKey: process.env.OPENAI_API_KEY, // Never hardcode!
});
```

### Configuration File Security

If using the config file (`~/.config/browseruse/config.json`):

1. **Set proper permissions**:

   ```bash
   chmod 600 ~/.config/browseruse/config.json
   ```

2. **Use environment variable references**:
   ```json
   {
     "llm": {
       "openai": {
         "api_key": "${OPENAI_API_KEY}"
       }
     }
   }
   ```

### MCP Server Configuration

For Claude Desktop, use environment variable references:

```json
{
  "mcpServers": {
    "browser-use": {
      "command": "npx",
      "args": ["browser-use", "--mcp"],
      "env": {
        "OPENAI_API_KEY": "${OPENAI_API_KEY}"
      }
    }
  }
}
```

---

## Domain Restrictions

### Allowed Domains

Restrict browser navigation to specific domains:

```bash
# Environment variable
BROWSER_USE_ALLOWED_DOMAINS=*.example.com,*.trusted.org,api.mysite.com
```

```typescript
// Programmatic configuration
const profile = new BrowserProfile({
  allowed_domains: ['*.example.com', '*.trusted.org', 'api.mysite.com'],
});
```

```bash
# CLI
npx browser-use --allowed-domains "*.example.com,*.trusted.org" -p "Complete login flow"
```

Avoid running production credentialed tasks without `allowed_domains`; unlocked `sensitive_data` is warning-only and does not stop navigation by itself.

### Domain Patterns

| Pattern           | Matches                      |
| ----------------- | ---------------------------- |
| `example.com`     | Only example.com             |
| `*.example.com`   | Any subdomain of example.com |
| `*.*.example.com` | Two-level subdomains         |
| `*`               | All domains (default)        |

### Action Domain Restrictions

Restrict custom actions to specific domains:

```typescript
controller.registry.action('Perform admin action', {
  param_model: z.object({ ... }),
  allowed_domains: ['admin.example.com', 'dashboard.example.com']
})(async function admin_action(params, ctx) {
  // Only available on admin.example.com and dashboard.example.com
});
```

---

## Browser Security

### Sandbox Mode

Always enable the Chromium sandbox in production:

```typescript
const profile = new BrowserProfile({
  chromium_sandbox: true, // Default: true
});
```

If Chromium cannot launch with sandboxing (for example, restricted Linux CI/AppArmor
environments), browser-use retries once with `chromium_sandbox: false` and logs a warning.
Treat this warning as a deployment hardening signal, not as a normal steady state.

For Docker/CI, you may need to disable sandboxing explicitly (with appropriate container security):

```typescript
const profile = new BrowserProfile({
  chromium_sandbox: false, // Only in Docker
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
});
```

### Headless Mode

Use headless mode in production:

```typescript
const profile = new BrowserProfile({
  headless: true,
});
```

Or via environment variable:

```bash
BROWSER_USE_HEADLESS=true
```

### Security Features

```typescript
const profile = new BrowserProfile({
  // Keep security features enabled (defaults)
  disable_security: false,
  ignore_https_errors: false,

  // Stealth mode (avoid detection but maintain security)
  stealth: true,
});
```

### Dangerous Options

These options should only be used in development/testing:

```typescript
// DANGEROUS - Only for testing!
const profile = new BrowserProfile({
  disable_security: true, // Disables web security
  ignore_https_errors: true, // Accepts invalid certificates
});
```

---

## Network Security

### Proxy Configuration

Use proxies for network isolation:

```typescript
const profile = new BrowserProfile({
  proxy: {
    server: 'http://proxy.internal:8080',
    bypass: 'localhost,127.0.0.1', // Bypass for local
    username: 'proxy-user',
    password: 'proxy-pass',
  },
});
```

### HTTPS Enforcement

```typescript
const profile = new BrowserProfile({
  // Reject invalid HTTPS certificates
  ignore_https_errors: false,

  // Custom headers for security
  extra_http_headers: {
    'Strict-Transport-Security': 'max-age=31536000',
  },
});
```

### Request Filtering

For advanced request filtering, use Playwright's route API:

```typescript
const session = new BrowserSession({ browser_profile: profile });
await session.start();

const page = await session.get_current_page();

// Block requests to untrusted domains
await page.route('**/*', (route) => {
  const url = new URL(route.request().url());
  const allowedDomains = ['example.com', 'trusted.org'];

  if (allowedDomains.some((d) => url.hostname.endsWith(d))) {
    route.continue();
  } else {
    route.abort();
  }
});
```

---

## Logging and Telemetry

### Log Levels

Control logging verbosity:

```bash
# Minimal logging in production
BROWSER_USE_LOGGING_LEVEL=warning

# Options: debug, info, warning, error
```

### Sensitive Data in Logs

Browser-Use automatically masks sensitive data in logs:

```
INFO [agent] Filling field with <MASKED>
INFO [agent] Navigating to https://example.com/login?token=<MASKED>
```

### Telemetry

Disable telemetry if needed:

```bash
ANONYMIZED_TELEMETRY=false
```

Telemetry data collected (when enabled):

- Tool usage counts
- Session durations
- Success/failure rates
- Model/provider information (no content)

**Not collected:**

- URLs visited
- Page content
- Credentials or sensitive data
- Personal information

---

## Production Deployment

### Docker Security

```dockerfile
FROM node:20-slim

# Run as non-root user
RUN useradd -m -s /bin/bash appuser

# Install dependencies
RUN apt-get update && apt-get install -y \
    chromium \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Set environment
ENV BROWSER_USE_HEADLESS=true
ENV IN_DOCKER=true

# Copy application
WORKDIR /app
COPY --chown=appuser:appuser . .

# Switch to non-root user
USER appuser

# Install dependencies
RUN npm ci --production

CMD ["node", "dist/index.js"]
```

### Kubernetes Security

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: browser-use
spec:
  securityContext:
    runAsNonRoot: true
    runAsUser: 1000
  containers:
    - name: browser-use
      image: your-image
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities:
          drop:
            - ALL
      env:
        - name: OPENAI_API_KEY
          valueFrom:
            secretKeyRef:
              name: api-keys
              key: openai
        - name: BROWSER_USE_HEADLESS
          value: 'true'
      resources:
        limits:
          memory: '2Gi'
          cpu: '1'
```

### Secrets Management

Use secret management services:

```typescript
// AWS Secrets Manager example
import { SecretsManager } from '@aws-sdk/client-secrets-manager';

async function getApiKey() {
  const client = new SecretsManager({ region: 'us-east-1' });
  const secret = await client.getSecretValue({
    SecretId: 'browser-use/api-keys',
  });
  return JSON.parse(secret.SecretString!);
}

const secrets = await getApiKey();
const llm = new ChatOpenAI({
  model: 'gpt-4o',
  apiKey: secrets.OPENAI_API_KEY,
});
```

---

## Security Checklist

### Development

- [ ] Use `.env` files for API keys (add to `.gitignore`)
- [ ] Never commit credentials to version control
- [ ] Use domain restrictions for testing
- [ ] Review logs for sensitive data leakage

### Staging

- [ ] Enable headless mode
- [ ] Configure proxy if needed
- [ ] Test with production-like security settings
- [ ] Verify domain restrictions work correctly

### Production

- [ ] Use environment variables or secret management
- [ ] Enable Chromium sandbox (or use secure containers)
- [ ] Set `BROWSER_USE_HEADLESS=true`
- [ ] Configure domain restrictions
- [ ] Disable telemetry if required by policy
- [ ] Set appropriate log levels
- [ ] Use HTTPS only
- [ ] Run as non-root user
- [ ] Implement network segmentation
- [ ] Regular security audits

### Code Review

- [ ] No hardcoded credentials
- [ ] Sensitive data uses masking patterns
- [ ] Custom actions have appropriate domain restrictions
- [ ] Error messages don't leak sensitive information
- [ ] File operations are properly sandboxed

---

## Reporting Security Issues

If you discover a security vulnerability:

1. **Do not** open a public GitHub issue
2. Report it privately to the maintainers of this TypeScript port
   ([webllm/browser-use](https://github.com/webllm/browser-use)), for example
   through a GitHub security advisory. This port is not maintained by the
   official browser-use project, so do not send reports about it to them;
   vulnerabilities in the Python library follow that project's own process.
3. Include:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if any)

Security issues will be addressed promptly and credited appropriately.
