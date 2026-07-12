import { is_running_in_docker } from '../config.js';

export abstract class BaseTelemetryEvent {
  abstract name: string;

  properties(): Record<string, unknown> {
    const entries = Object.entries(this as Record<string, unknown>).filter(
      ([key]) => key !== 'name'
    );
    return {
      ...Object.fromEntries(entries),
      is_docker: is_running_in_docker(),
    };
  }
}

type BaseSequence = Array<string | null | undefined> | undefined;
const REDACTED_TELEMETRY_VALUE = '<redacted>';

const redactSequence = (value: BaseSequence): BaseSequence => {
  if (!Array.isArray(value)) {
    return value;
  }
  return value.map((entry) =>
    entry == null ? entry : REDACTED_TELEMETRY_VALUE
  );
};

const summarizeActionHistory = (
  value: Array<Array<Record<string, unknown>> | null> | undefined
) => {
  if (!Array.isArray(value)) {
    return value;
  }
  return value.map((step) => {
    if (!Array.isArray(step)) {
      return step;
    }
    return step.map((action) => ({
      action:
        action && typeof action === 'object'
          ? (Object.keys(action)[0] ?? 'unknown')
          : 'unknown',
    }));
  });
};

const redactNullableString = (value: string | null | undefined) =>
  value ? REDACTED_TELEMETRY_VALUE : null;

export interface AgentTelemetryPayload {
  task: string;
  model: string;
  model_provider: string;
  max_steps: number;
  max_actions_per_step: number;
  use_vision: boolean | 'auto';
  version: string;
  source: string;
  cdp_url: string | null;
  agent_type: string | null;
  action_errors: BaseSequence;
  action_history: Array<Array<Record<string, unknown>> | null> | undefined;
  urls_visited: BaseSequence;
  steps: number;
  total_input_tokens: number;
  total_output_tokens: number;
  prompt_cached_tokens: number;
  total_tokens: number;
  total_duration_seconds: number;
  success: boolean | null;
  final_result_response: string | null;
  error_message: string | null;
  judge_verdict?: boolean | null;
  judge_reasoning?: string | null;
  judge_failure_reason?: string | null;
  judge_reached_captcha?: boolean | null;
  judge_impossible_task?: boolean | null;
}

export class AgentTelemetryEvent
  extends BaseTelemetryEvent
  implements AgentTelemetryPayload
{
  name = 'agent_event';
  task: string;
  model: string;
  model_provider: string;
  max_steps: number;
  max_actions_per_step: number;
  use_vision: boolean | 'auto';
  version: string;
  source: string;
  cdp_url: string | null;
  agent_type: string | null;
  action_errors: BaseSequence;
  action_history: Array<Array<Record<string, unknown>> | null> | undefined;
  urls_visited: BaseSequence;
  steps: number;
  total_input_tokens: number;
  total_output_tokens: number;
  prompt_cached_tokens: number;
  total_tokens: number;
  total_duration_seconds: number;
  success: boolean | null;
  final_result_response: string | null;
  error_message: string | null;
  judge_verdict: boolean | null;
  judge_reasoning: string | null;
  judge_failure_reason: string | null;
  judge_reached_captcha: boolean | null;
  judge_impossible_task: boolean | null;

  constructor(payload: AgentTelemetryPayload) {
    super();
    this.task = payload.task ? REDACTED_TELEMETRY_VALUE : '';
    this.model = payload.model;
    this.model_provider = payload.model_provider;
    this.max_steps = payload.max_steps;
    this.max_actions_per_step = payload.max_actions_per_step;
    this.use_vision = payload.use_vision;
    this.version = payload.version;
    this.source = payload.source;
    this.cdp_url = redactNullableString(payload.cdp_url);
    this.agent_type = payload.agent_type;
    this.action_errors = redactSequence(payload.action_errors);
    this.action_history = summarizeActionHistory(payload.action_history);
    this.urls_visited = redactSequence(payload.urls_visited);
    this.steps = payload.steps;
    this.total_input_tokens = payload.total_input_tokens;
    this.total_output_tokens = payload.total_output_tokens;
    this.prompt_cached_tokens = payload.prompt_cached_tokens;
    this.total_tokens = payload.total_tokens;
    this.total_duration_seconds = payload.total_duration_seconds;
    this.success = payload.success;
    this.final_result_response = redactNullableString(
      payload.final_result_response
    );
    this.error_message = redactNullableString(payload.error_message);
    this.judge_verdict = payload.judge_verdict ?? null;
    this.judge_reasoning = redactNullableString(payload.judge_reasoning);
    this.judge_failure_reason = redactNullableString(
      payload.judge_failure_reason
    );
    this.judge_reached_captcha = payload.judge_reached_captcha ?? null;
    this.judge_impossible_task = payload.judge_impossible_task ?? null;
  }
}

export interface MCPClientTelemetryPayload {
  server_name: string;
  command: string;
  tools_discovered: number;
  version: string;
  action: string;
  tool_name?: string | null;
  duration_seconds?: number | null;
  error_message?: string | null;
}

export class MCPClientTelemetryEvent
  extends BaseTelemetryEvent
  implements MCPClientTelemetryPayload
{
  name = 'mcp_client_event';
  server_name: string;
  command: string;
  tools_discovered: number;
  version: string;
  action: string;
  tool_name: string | null;
  duration_seconds: number | null;
  error_message: string | null;

  constructor(payload: MCPClientTelemetryPayload) {
    super();
    this.server_name = payload.server_name ? REDACTED_TELEMETRY_VALUE : '';
    this.command = payload.command ? REDACTED_TELEMETRY_VALUE : '';
    this.tools_discovered = payload.tools_discovered;
    this.version = payload.version;
    this.action = payload.action;
    this.tool_name = payload.tool_name ?? null;
    this.duration_seconds = payload.duration_seconds ?? null;
    this.error_message = redactNullableString(payload.error_message);
  }
}

export interface MCPServerTelemetryPayload {
  version: string;
  action: string;
  tool_name?: string | null;
  duration_seconds?: number | null;
  error_message?: string | null;
  parent_process_cmdline?: string | null;
}

export class MCPServerTelemetryEvent
  extends BaseTelemetryEvent
  implements MCPServerTelemetryPayload
{
  name = 'mcp_server_event';
  version: string;
  action: string;
  tool_name: string | null;
  duration_seconds: number | null;
  error_message: string | null;
  parent_process_cmdline: string | null;

  constructor(payload: MCPServerTelemetryPayload) {
    super();
    this.version = payload.version;
    this.action = payload.action;
    this.tool_name = payload.tool_name ?? null;
    this.duration_seconds = payload.duration_seconds ?? null;
    this.error_message = redactNullableString(payload.error_message);
    this.parent_process_cmdline = redactNullableString(
      payload.parent_process_cmdline
    );
  }
}

export interface CLITelemetryPayload {
  version: string;
  action: string;
  mode: string;
  model?: string | null;
  model_provider?: string | null;
  duration_seconds?: number | null;
  error_message?: string | null;
}

export class CLITelemetryEvent
  extends BaseTelemetryEvent
  implements CLITelemetryPayload
{
  name = 'cli_event';
  version: string;
  action: string;
  mode: string;
  model: string | null;
  model_provider: string | null;
  duration_seconds: number | null;
  error_message: string | null;

  constructor(payload: CLITelemetryPayload) {
    super();
    this.version = payload.version;
    this.action = payload.action;
    this.mode = payload.mode;
    this.model = payload.model ?? null;
    this.model_provider = payload.model_provider ?? null;
    this.duration_seconds = payload.duration_seconds ?? null;
    this.error_message = redactNullableString(payload.error_message);
  }
}
