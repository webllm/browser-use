import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const entryPath = path.join(repositoryRoot, 'dist', 'cli-entry.js');
const configuredSamples = Number(
  process.env.BROWSER_USE_CLI_STARTUP_SAMPLES ?? 7
);
const sampleCount = Number.isInteger(configuredSamples)
  ? Math.min(25, Math.max(5, configuredSamples))
  : 7;
const processTimeoutMs = 15_000;

const scenarios = [
  {
    name: 'help',
    args: ['--help'],
    kind: 'exit',
    expectedOutput: 'Usage:',
    p50BudgetMs: 300,
    p95BudgetMs: 900,
  },
  {
    name: 'version',
    args: ['--version'],
    kind: 'exit',
    expectedOutput: /^\d+\.\d+\.\d+/,
    p50BudgetMs: 300,
    p95BudgetMs: 900,
  },
  {
    name: 'cli-mcp',
    args: ['--cli-mcp'],
    kind: 'mcp',
    p50BudgetMs: 1_500,
    p95BudgetMs: 3_500,
  },
];

const percentile = (values, quantile) => {
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * quantile;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  if (lowerIndex === upperIndex) {
    return sorted[lowerIndex];
  }
  const weight = position - lowerIndex;
  return sorted[lowerIndex] * (1 - weight) + sorted[upperIndex] * weight;
};

const matchesExpectedOutput = (output, expected) =>
  typeof expected === 'string'
    ? output.includes(expected)
    : expected.test(output);

const runExitSample = (scenario) =>
  new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const child = spawn(process.execPath, [entryPath, ...scenario.args], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        ANONYMIZED_TELEMETRY: 'false',
        BROWSER_USE_LOGGING_LEVEL: 'result',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${scenario.name} exceeded ${processTimeoutMs}ms`));
    }, processTimeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      if (code !== 0 || signal !== null) {
        reject(
          new Error(
            `${scenario.name} exited with code=${code} signal=${signal}: ${stderr.trim()}`
          )
        );
        return;
      }
      if (!matchesExpectedOutput(stdout, scenario.expectedOutput)) {
        reject(
          new Error(
            `${scenario.name} did not produce its expected output: ${stdout.trim()}`
          )
        );
        return;
      }
      resolve(performance.now() - startedAt);
    });
  });

const runMcpSample = (scenario, sampleIndex) =>
  new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const requestId = sampleIndex + 1;
    const child = spawn(process.execPath, [entryPath, ...scenario.args], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        ANONYMIZED_TELEMETRY: 'false',
        BROWSER_USE_LOGGING_LEVEL: 'result',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let readinessMs = null;
    let settled = false;

    const settle = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (error) {
        reject(error);
      } else {
        resolve(readinessMs);
      }
    };
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      settle(
        new Error(
          `${scenario.name} did not answer initialize within ${processTimeoutMs}ms: ${stderr.trim()}`
        )
      );
    }, processTimeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      const lines = stdout.split('\n');
      stdout = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }
        try {
          const payload = JSON.parse(line);
          if (payload.id === requestId && payload.result) {
            readinessMs = performance.now() - startedAt;
            child.kill('SIGTERM');
            return;
          }
        } catch {
          // Ignore non-protocol stdout until timeout reports the full context.
        }
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.once('error', (error) => settle(error));
    child.once('close', (code, signal) => {
      if (readinessMs !== null) {
        settle(null);
        return;
      }
      settle(
        new Error(
          `${scenario.name} exited before initialize response (code=${code}, signal=${signal}): ${stderr.trim()}`
        )
      );
    });

    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: requestId,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'browser-use-startup-check', version: '1' },
        },
      })}\n`
    );
  });

if (!fs.existsSync(entryPath)) {
  throw new Error(`Missing ${entryPath}. Run "pnpm build" first.`);
}

const failures = [];
process.stdout.write(`CLI cold-start budget (${sampleCount} samples)\n`);

for (const scenario of scenarios) {
  const samples = [];
  for (let index = 0; index < sampleCount; index += 1) {
    samples.push(
      scenario.kind === 'mcp'
        ? await runMcpSample(scenario, index)
        : await runExitSample(scenario)
    );
  }
  const p50 = percentile(samples, 0.5);
  const p95 = percentile(samples, 0.95);
  const passed = p50 <= scenario.p50BudgetMs && p95 <= scenario.p95BudgetMs;
  process.stdout.write(
    `${passed ? 'ok' : 'FAIL'} ${scenario.name.padEnd(8)} ` +
      `p50=${p50.toFixed(1)}ms/${scenario.p50BudgetMs}ms ` +
      `p95=${p95.toFixed(1)}ms/${scenario.p95BudgetMs}ms\n`
  );
  if (!passed) {
    failures.push(scenario.name);
  }
}

if (failures.length > 0) {
  throw new Error(`CLI startup budget exceeded: ${failures.join(', ')}`);
}
