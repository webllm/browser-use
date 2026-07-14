import fs from 'node:fs';
import path from 'node:path';
import { uuid7str } from '../utils.js';
import { createLogger } from '../logging-config.js';
import { redactSensitiveDataFromString } from './views.js';

const MAX_STRING_LENGTH = 100_000;
const MAX_URL_LENGTH = 100_000;
const MAX_TASK_LENGTH = 100_000;
const MAX_COMMENT_LENGTH = 2_000;
export const MAX_FILE_CONTENT_SIZE = 50 * 1024 * 1024;
const FILE_READ_CHUNK_SIZE = 64 * 1024;
const MAX_LLM_MODEL_LENGTH = 200;
const MAX_END_REASON_LENGTH = 100;

const logger = createLogger('browser_use.agent.cloud_events');

const estimateBase64DecodedBytes = (value: string) =>
  Math.floor((value.length * 3) / 4);

const extractBase64Payload = (value: string) =>
  value.includes(',') ? value.split(',').slice(1).join(',') : value;

const readBoundedOutputFile = async (filePath: string) => {
  const nonBlockingFlag =
    process.platform === 'win32' ? 0 : fs.constants.O_NONBLOCK;
  const handle = await fs.promises.open(
    filePath,
    fs.constants.O_RDONLY | nonBlockingFlag
  );
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new Error(`Agent output path is not a regular file: ${filePath}`);
    }
    if (stats.size >= MAX_FILE_CONTENT_SIZE) {
      return null;
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (totalBytes < MAX_FILE_CONTENT_SIZE) {
      const remaining = MAX_FILE_CONTENT_SIZE - totalBytes;
      const buffer = Buffer.allocUnsafe(
        Math.min(FILE_READ_CHUNK_SIZE, remaining)
      );
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      totalBytes += bytesRead;
      chunks.push(buffer.subarray(0, bytesRead));
    }
    if (totalBytes >= MAX_FILE_CONTENT_SIZE) {
      return null;
    }
    return Buffer.concat(chunks, totalBytes);
  } finally {
    await handle.close();
  }
};

interface AgentReference {
  task_id: string;
  session_id: string;
  task: string;
  llm: { model?: string; model_name?: string };
  state: {
    stopped: boolean;
    paused: boolean;
    n_steps: number;
    model_dump?: () => Record<string, unknown>;
  };
  history: {
    final_result(): string | null;
    is_done(): boolean;
  };
  browser_session: {
    id: string;
    browser_profile?: {
      viewport?: { width: number; height: number };
      user_agent?: string | null;
      headless?: boolean;
      allowed_domains?: string[];
    };
  };
  browser_profile?: {
    viewport?: { width: number; height: number };
    user_agent?: string | null;
    headless?: boolean;
    allowed_domains?: string[];
  };
  cloud_sync?: {
    auth_client?: {
      device_id?: string | null;
    };
  };
  _task_start_time?: number;
  sensitive_data?: Record<string, string | Record<string, string>> | null;
}

interface AgentWithState extends AgentReference {
  state: AgentReference['state'] & {
    model_dump?: () => Record<string, unknown>;
  };
}

const getDeviceId = (agent: AgentReference) =>
  agent.cloud_sync?.auth_client?.device_id ?? null;

const getBrowserProfile = (agent: AgentReference) =>
  agent.browser_profile ?? agent.browser_session?.browser_profile ?? null;

const redactAgentValue = (agent: AgentReference, value: unknown): unknown => {
  if (typeof value === 'string') {
    return redactSensitiveDataFromString(value, agent.sensitive_data ?? null);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactAgentValue(agent, entry));
  }
  if (value && typeof value === 'object') {
    if (value instanceof Date) {
      return value;
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        redactAgentValue(agent, entry),
      ])
    );
  }
  return value;
};

const redactAgentString = (agent: AgentReference, value: string) =>
  redactAgentValue(agent, value) as string;

const serializeAgentState = (agent: AgentWithState) => {
  let state: Record<string, unknown>;
  if (typeof agent.state.model_dump === 'function') {
    state = agent.state.model_dump();
  } else {
    state = {
      stopped: agent.state.stopped,
      paused: agent.state.paused,
      n_steps: agent.state.n_steps,
    };
  }
  return redactAgentValue(agent, state) as Record<string, unknown>;
};

const toDate = (timestamp?: number | null) => {
  if (!timestamp) {
    return null;
  }
  return new Date(timestamp * 1000);
};

export abstract class BaseEvent {
  readonly event_type: string;
  id: string;
  user_id: string;
  device_id: string | null;

  protected constructor(event_type: string, init: Partial<BaseEvent> = {}) {
    this.event_type = event_type;
    this.id = init.id ?? uuid7str();
    this.user_id = init.user_id ?? '';
    this.device_id = init.device_id ?? null;
  }

  toJSON() {
    return {
      event_type: this.event_type,
      id: this.id,
      user_id: this.user_id,
      device_id: this.device_id,
    };
  }
}

export class UpdateAgentTaskEvent extends BaseEvent {
  stopped: boolean | null;
  paused: boolean | null;
  done_output: string | null;
  finished_at: Date | null;
  agent_state: Record<string, unknown> | null;
  user_feedback_type: string | null;
  user_comment: string | null;
  gif_url: string | null;

  constructor(init: Partial<UpdateAgentTaskEvent> & { id: string }) {
    super('UpdateAgentTaskEvent', init);
    this.stopped = init.stopped ?? null;
    this.paused = init.paused ?? null;
    this.done_output = init.done_output ?? null;
    this.finished_at = init.finished_at ?? null;
    this.agent_state = init.agent_state ?? null;
    this.user_feedback_type = init.user_feedback_type ?? null;
    this.user_comment = init.user_comment ?? null;
    this.gif_url = init.gif_url ?? null;
  }

  static fromAgent(agent: AgentWithState): UpdateAgentTaskEvent {
    if (agent._task_start_time == null) {
      throw new Error('Agent must have _task_start_time attribute');
    }
    const finalResult = agent.history.final_result();
    return new UpdateAgentTaskEvent({
      id: String(agent.task_id),
      device_id: getDeviceId(agent),
      stopped: agent.state.stopped,
      paused: agent.state.paused,
      done_output:
        finalResult == null ? null : redactAgentString(agent, finalResult),
      finished_at: agent.history.is_done() ? new Date() : null,
      agent_state: serializeAgentState(agent),
      user_feedback_type: null,
      user_comment: null,
      gif_url: null,
    });
  }

  override toJSON() {
    return {
      ...super.toJSON(),
      stopped: this.stopped,
      paused: this.paused,
      done_output: this.done_output,
      finished_at: this.finished_at?.toISOString() ?? null,
      agent_state: this.agent_state,
      user_feedback_type: this.user_feedback_type,
      user_comment: this.user_comment,
      gif_url: this.gif_url,
    };
  }
}

export class CreateAgentOutputFileEvent extends BaseEvent {
  task_id: string;
  file_name: string;
  file_content: string | null;
  content_type: string | null;
  created_at: Date;

  constructor(init: {
    user_id?: string;
    device_id?: string | null;
    task_id: string;
    id?: string;
    file_name: string;
    file_content?: string | null;
    content_type?: string | null;
    created_at?: Date;
  }) {
    super('CreateAgentOutputFileEvent', init);
    this.task_id = init.task_id;
    this.file_name = init.file_name;
    if (init.file_content != null) {
      const payload = extractBase64Payload(init.file_content);
      const estimatedSize = estimateBase64DecodedBytes(payload);
      if (estimatedSize > MAX_FILE_CONTENT_SIZE) {
        throw new Error(
          `file_content exceeds maximum size of ${MAX_FILE_CONTENT_SIZE} bytes`
        );
      }
      this.file_content = init.file_content;
    } else {
      this.file_content = null;
    }
    this.content_type = init.content_type ?? null;
    this.created_at = init.created_at ?? new Date();
  }

  static async fromAgentAndFile(agent: AgentReference, outputPath: string) {
    const resolved = path.resolve(outputPath);
    const data = await readBoundedOutputFile(resolved);
    const fileContent = data?.toString('base64') ?? null;
    return new CreateAgentOutputFileEvent({
      task_id: String(agent.task_id),
      device_id: getDeviceId(agent),
      file_name: path.basename(resolved),
      file_content: fileContent,
      content_type: 'image/gif',
    });
  }

  override toJSON() {
    return {
      ...super.toJSON(),
      task_id: this.task_id,
      file_name: this.file_name,
      file_content: this.file_content,
      content_type: this.content_type,
      created_at: this.created_at.toISOString(),
    };
  }
}

export class CreateAgentStepEvent extends BaseEvent {
  created_at: Date;
  agent_task_id: string;
  step: number;
  evaluation_previous_goal: string;
  memory: string;
  next_goal: string;
  actions: Array<Record<string, unknown>>;
  screenshot_url: string | null;
  url: string;

  constructor(init: {
    user_id?: string;
    device_id?: string | null;
    agent_task_id: string;
    id?: string;
    step: number;
    evaluation_previous_goal: string;
    memory: string;
    next_goal: string;
    actions: Array<Record<string, unknown>>;
    screenshot_url?: string | null;
    url: string;
    created_at?: Date;
  }) {
    super('CreateAgentStepEvent', init);
    this.created_at = init.created_at ?? new Date();
    this.agent_task_id = init.agent_task_id;
    this.step = init.step;
    this.evaluation_previous_goal = init.evaluation_previous_goal;
    this.memory = init.memory;
    this.next_goal = init.next_goal;
    this.actions = init.actions;
    if (init.screenshot_url?.startsWith('data:')) {
      const payload = extractBase64Payload(init.screenshot_url);
      const estimatedSize = estimateBase64DecodedBytes(payload);
      if (estimatedSize > MAX_FILE_CONTENT_SIZE) {
        throw new Error(
          `screenshot_url exceeds maximum size of ${MAX_FILE_CONTENT_SIZE} bytes`
        );
      }
    }
    this.screenshot_url = init.screenshot_url ?? null;
    this.url = init.url;
  }

  static fromAgentStep(
    agent: AgentWithState,
    model_output: {
      current_state: {
        evaluation_previous_goal: string;
        memory: string;
        next_goal: string;
      };
      action: any[];
    },
    result: Array<unknown>,
    actions_data: Array<Record<string, unknown>>,
    browser_state_summary: { screenshot?: string | null; url: string }
  ) {
    const currentState = model_output.current_state;
    const screenshot = browser_state_summary.screenshot
      ? `data:image/png;base64,${browser_state_summary.screenshot}`
      : null;

    if (browser_state_summary.screenshot) {
      logger.debug(
        `Including screenshot in CreateAgentStepEvent, length: ${browser_state_summary.screenshot.length}`
      );
    } else {
      logger.debug(
        'No screenshot in browser_state_summary for CreateAgentStepEvent'
      );
    }

    return new CreateAgentStepEvent({
      device_id: getDeviceId(agent),
      agent_task_id: String(agent.task_id),
      step: agent.state.n_steps,
      evaluation_previous_goal: redactAgentString(
        agent,
        currentState?.evaluation_previous_goal ?? ''
      ),
      memory: redactAgentString(agent, currentState?.memory ?? ''),
      next_goal: redactAgentString(agent, currentState?.next_goal ?? ''),
      actions: redactAgentValue(agent, actions_data ?? []) as Array<
        Record<string, unknown>
      >,
      url: redactAgentString(agent, browser_state_summary.url ?? ''),
      screenshot_url: screenshot,
    });
  }

  override toJSON() {
    return {
      ...super.toJSON(),
      created_at: this.created_at.toISOString(),
      agent_task_id: this.agent_task_id,
      step: this.step,
      evaluation_previous_goal: this.evaluation_previous_goal,
      memory: this.memory,
      next_goal: this.next_goal,
      actions: this.actions,
      screenshot_url: this.screenshot_url,
      url: this.url,
    };
  }
}

export class CreateAgentTaskEvent extends BaseEvent {
  agent_session_id: string;
  llm_model: string;
  stopped: boolean;
  paused: boolean;
  task: string;
  done_output: string | null;
  scheduled_task_id: string | null;
  started_at: Date;
  finished_at: Date | null;
  agent_state: Record<string, unknown>;
  user_feedback_type: string | null;
  user_comment: string | null;
  gif_url: string | null;

  constructor(init: {
    user_id?: string;
    device_id?: string | null;
    agent_session_id: string;
    id?: string;
    llm_model: string;
    task: string;
    stopped?: boolean;
    paused?: boolean;
    done_output?: string | null;
    scheduled_task_id?: string | null;
    started_at?: Date;
    finished_at?: Date | null;
    agent_state?: Record<string, unknown>;
    user_feedback_type?: string | null;
    user_comment?: string | null;
    gif_url?: string | null;
  }) {
    super('CreateAgentTaskEvent', init);
    this.agent_session_id = init.agent_session_id;
    if (init.llm_model.length > MAX_LLM_MODEL_LENGTH) {
      throw new Error(
        `llm_model exceeds maximum length of ${MAX_LLM_MODEL_LENGTH}`
      );
    }
    if (init.task.length > MAX_TASK_LENGTH) {
      throw new Error(`task exceeds maximum length of ${MAX_TASK_LENGTH}`);
    }
    this.llm_model = init.llm_model;
    this.task = init.task;
    this.stopped = init.stopped ?? false;
    this.paused = init.paused ?? false;
    this.done_output = init.done_output ?? null;
    this.scheduled_task_id = init.scheduled_task_id ?? null;
    this.started_at = init.started_at ?? new Date();
    this.finished_at = init.finished_at ?? null;
    this.agent_state = init.agent_state ?? {};
    this.user_feedback_type = init.user_feedback_type ?? null;
    this.user_comment = init.user_comment ?? null;
    this.gif_url = init.gif_url ?? null;
  }

  static fromAgent(agent: AgentWithState) {
    const startedAt = toDate(agent._task_start_time) ?? new Date();
    return new CreateAgentTaskEvent({
      id: String(agent.task_id),
      device_id: getDeviceId(agent),
      agent_session_id: String(agent.session_id),
      task: redactAgentString(agent, agent.task),
      llm_model: agent.llm.model_name || agent.llm.model || 'unknown',
      agent_state: serializeAgentState(agent),
      stopped: false,
      paused: false,
      started_at: startedAt,
      finished_at: null,
      done_output: null,
      scheduled_task_id: null,
      user_feedback_type: null,
      user_comment: null,
      gif_url: null,
    });
  }

  override toJSON() {
    return {
      ...super.toJSON(),
      agent_session_id: this.agent_session_id,
      llm_model: this.llm_model,
      task: this.task,
      stopped: this.stopped,
      paused: this.paused,
      done_output: this.done_output,
      scheduled_task_id: this.scheduled_task_id,
      started_at: this.started_at.toISOString(),
      finished_at: this.finished_at?.toISOString() ?? null,
      agent_state: this.agent_state,
      user_feedback_type: this.user_feedback_type,
      user_comment: this.user_comment,
      gif_url: this.gif_url,
    };
  }
}

export class CreateAgentSessionEvent extends BaseEvent {
  browser_session_id: string;
  browser_session_live_url: string;
  browser_session_cdp_url: string;
  browser_session_stopped: boolean;
  browser_session_stopped_at: Date | null;
  is_source_api: boolean | null;
  browser_state: Record<string, unknown>;
  browser_session_data: Record<string, unknown> | null;

  constructor(init: {
    user_id?: string;
    device_id?: string | null;
    browser_session_id: string;
    id?: string;
    browser_state?: Record<string, unknown>;
    browser_session_live_url?: string;
    browser_session_cdp_url?: string;
    browser_session_stopped?: boolean;
    browser_session_stopped_at?: Date | null;
    is_source_api?: boolean | null;
    browser_session_data?: Record<string, unknown> | null;
  }) {
    super('CreateAgentSessionEvent', init);
    this.browser_session_id = init.browser_session_id;
    this.browser_session_live_url = init.browser_session_live_url ?? '';
    this.browser_session_cdp_url = init.browser_session_cdp_url ?? '';
    this.browser_session_stopped = init.browser_session_stopped ?? false;
    this.browser_session_stopped_at = init.browser_session_stopped_at ?? null;
    this.is_source_api = init.is_source_api ?? null;
    this.browser_state = init.browser_state ?? {};
    this.browser_session_data = init.browser_session_data ?? null;
  }

  static fromAgent(agent: AgentReference) {
    const profile = getBrowserProfile(agent);
    return new CreateAgentSessionEvent({
      id: String(agent.session_id),
      device_id: getDeviceId(agent),
      browser_session_id: agent.browser_session.id,
      browser_state: {
        viewport: profile?.viewport ?? { width: 1280, height: 720 },
        user_agent: profile?.user_agent ?? null,
        headless: profile?.headless ?? true,
        initial_url: null,
        final_url: null,
        total_pages_visited: 0,
        session_duration_seconds: 0,
      },
      browser_session_data: {
        cookies: [],
        secrets: {},
        allowed_domains: profile?.allowed_domains ?? [],
      },
    });
  }

  override toJSON() {
    return {
      ...super.toJSON(),
      browser_session_id: this.browser_session_id,
      browser_session_live_url: this.browser_session_live_url,
      browser_session_cdp_url: this.browser_session_cdp_url,
      browser_session_stopped: this.browser_session_stopped,
      browser_session_stopped_at:
        this.browser_session_stopped_at?.toISOString() ?? null,
      is_source_api: this.is_source_api,
      browser_state: this.browser_state,
      browser_session_data: this.browser_session_data,
    };
  }
}

export class UpdateAgentSessionEvent extends BaseEvent {
  browser_session_stopped: boolean | null;
  browser_session_stopped_at: Date | null;
  end_reason: string | null;

  constructor(
    init: Partial<UpdateAgentSessionEvent> & { id: string; user_id?: string }
  ) {
    super('UpdateAgentSessionEvent', init);
    this.browser_session_stopped = init.browser_session_stopped ?? null;
    this.browser_session_stopped_at = init.browser_session_stopped_at ?? null;
    if (init.end_reason != null) {
      const endReason = String(init.end_reason);
      if (endReason.length > MAX_END_REASON_LENGTH) {
        throw new Error(
          `end_reason exceeds maximum length of ${MAX_END_REASON_LENGTH}`
        );
      }
      this.end_reason = endReason;
    } else {
      this.end_reason = null;
    }
  }

  override toJSON() {
    return {
      ...super.toJSON(),
      browser_session_stopped: this.browser_session_stopped,
      browser_session_stopped_at:
        this.browser_session_stopped_at?.toISOString() ?? null,
      end_reason: this.end_reason,
    };
  }
}
