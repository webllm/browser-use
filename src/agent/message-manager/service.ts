import {
  ContentPartImageParam,
  ContentPartTextParam,
  SystemMessage,
  UserMessage,
  type Message,
} from '../../llm/messages.js';
import type { BaseChatModel } from '../../llm/base.js';
import {
  ActionResult,
  AgentOutput,
  AgentStepInfo,
  MessageCompactionSettings,
  redactSensitiveDataFromString,
} from '../views.js';
import { BrowserStateSummary } from '../../browser/views.js';
import { FileSystem } from '../../filesystem/file-system.js';
import { AgentMessagePrompt } from '../prompts.js';
import { MessageManagerState, HistoryItem } from './views.js';
import { match_url_with_domain_pattern } from '../../utils.js';
import { createLogger } from '../../logging-config.js';

const logger = createLogger('browser_use.agent.message_manager');

export class MessageManager {
  private task: string;
  private systemPrompt: SystemMessage;
  private sensitiveDataDescription = '';
  private lastInputMessages: Message[] = [];
  private includeAttributes: string[];
  last_state_message_text: string | null = null;

  constructor(
    task: string,
    systemMessage: SystemMessage,
    private readonly fileSystem: FileSystem,
    private readonly state: MessageManagerState = new MessageManagerState(),
    private readonly useThinking = true,
    includeAttributes: string[] | null = null,
    private readonly sensitiveData?: Record<
      string,
      string | Record<string, string>
    >,
    private readonly maxHistoryItems: number | null = null,
    private readonly visionDetailLevel: 'auto' | 'low' | 'high' = 'auto',
    private readonly includeToolCallExamples = false,
    private readonly includeRecentEvents = false,
    private readonly sampleImages: Array<
      ContentPartTextParam | ContentPartImageParam
    > | null = null,
    private readonly llmScreenshotSize: [number, number] | null = null
  ) {
    if (this.maxHistoryItems != null && this.maxHistoryItems <= 5) {
      throw new Error('max_history_items must be null or greater than 5');
    }

    this.task = task;
    this.systemPrompt = systemMessage;
    this.includeAttributes = includeAttributes ?? [];

    if (!this.state.history.system_message) {
      this.setMessageWithType(this.systemPrompt, 'system');
    }
  }

  get agent_history_description() {
    const compactedPrefix = this.state.compacted_memory
      ? `<compacted_memory>\n${this.state.compacted_memory}\n</compacted_memory>\n`
      : '';

    if (this.maxHistoryItems == null) {
      return (
        compactedPrefix +
        this.state.agent_history_items
          .map((item) => item.to_string())
          .join('\n')
      );
    }

    const totalItems = this.state.agent_history_items.length;
    if (totalItems <= this.maxHistoryItems) {
      return (
        compactedPrefix +
        this.state.agent_history_items
          .map((item) => item.to_string())
          .join('\n')
      );
    }

    const recentItemLimit = this.maxHistoryItems - 1;
    const archiveBatchSize = Math.max(1, Math.floor(recentItemLimit / 2));
    const nonInitialItemCount = totalItems - 1;
    const archiveBatchCount = Math.ceil(
      (nonInitialItemCount - recentItemLimit) / archiveBatchSize
    );
    const omittedItemCount = archiveBatchCount * archiveBatchSize;
    const omissionSegments = this.getHistoryOmissionSegments(
      archiveBatchCount,
      archiveBatchSize
    );
    const parts: string[] = [];
    parts.push(this.state.agent_history_items[0].to_string());
    parts.push(
      ...omissionSegments.map(
        (segmentSize) =>
          `<sys>[... ${segmentSize} archived history items omitted...]</sys>`
      )
    );
    parts.push(
      ...this.state.agent_history_items
        .slice(1 + omittedItemCount)
        .map((item) => item.to_string())
    );
    return compactedPrefix + parts.join('\n');
  }

  private getHistoryOmissionSegments(
    archiveBatchCount: number,
    archiveBatchSize: number
  ): number[] {
    const segments: number[] = [];
    let remainingBatches = archiveBatchCount;
    let segmentBatches = 1;
    while (segmentBatches * 2 <= remainingBatches) {
      segmentBatches *= 2;
    }
    while (segmentBatches >= 1) {
      if (remainingBatches >= segmentBatches) {
        segments.push(segmentBatches * archiveBatchSize);
        remainingBatches -= segmentBatches;
      }
      segmentBatches /= 2;
    }
    return segments;
  }

  add_new_task(new_task: string) {
    const normalizedTask = `<follow_up_user_request> ${new_task.trim()} </follow_up_user_request>`;
    if (!this.task.includes('<initial_user_request>')) {
      this.task = `<initial_user_request>${this.task}</initial_user_request>`;
    }
    this.task += `\n${normalizedTask}`;
    this.state.agent_history_items.push(
      new HistoryItem(null, null, null, null, null, null, normalizedTask)
    );
  }

  private updateAgentHistoryDescription(
    model_output: AgentOutput | null,
    result: ActionResult[] | null,
    step_info: AgentStepInfo | null
  ) {
    const results = result ?? [];
    const stepNumber = step_info?.step_number ?? null;
    this.state.read_state_description = '';
    this.state.read_state_images = [];

    let actionResults = '';
    let readStateIndex = 0;
    results.forEach((action) => {
      if (
        action.include_extracted_content_only_once &&
        action.extracted_content
      ) {
        this.state.read_state_description += `<read_state_${readStateIndex}>\n${action.extracted_content}\n</read_state_${readStateIndex}>\n`;
        readStateIndex += 1;
      }
      if (Array.isArray(action.images) && action.images.length > 0) {
        this.state.read_state_images.push(...action.images);
      }

      if (action.long_term_memory) {
        actionResults += `${action.long_term_memory}\n`;
      } else if (
        action.extracted_content &&
        !action.include_extracted_content_only_once
      ) {
        actionResults += `${action.extracted_content}\n`;
      }

      if (action.error) {
        const err =
          action.error.length > 200
            ? `${action.error.slice(0, 100)}......${action.error.slice(-100)}`
            : action.error;
        actionResults += `${err}\n`;
      }
    });

    const MAX_CONTENT_SIZE = 60000;
    if (this.state.read_state_description.length > MAX_CONTENT_SIZE) {
      this.state.read_state_description = `${this.state.read_state_description.slice(0, MAX_CONTENT_SIZE)}\n... [Content truncated at 60k characters]`;
    }
    this.state.read_state_description =
      this.state.read_state_description.trim();

    let normalizedActionResults = actionResults
      ? `Result\n${actionResults}`.trim()
      : null;
    if (normalizedActionResults) {
      if (normalizedActionResults.length > MAX_CONTENT_SIZE) {
        normalizedActionResults = `${normalizedActionResults.slice(0, MAX_CONTENT_SIZE)}\n... [Content truncated at 60k characters]`;
      }
    }

    if (!model_output) {
      if (stepNumber != null) {
        if (stepNumber === 0 && normalizedActionResults) {
          this.state.agent_history_items.push(
            new HistoryItem(
              stepNumber,
              null,
              null,
              null,
              normalizedActionResults,
              null,
              null
            )
          );
        } else if (stepNumber > 0) {
          this.state.agent_history_items.push(
            new HistoryItem(
              stepNumber,
              null,
              null,
              null,
              null,
              'Agent failed to output in the right format.',
              null
            )
          );
        }
      }
      return;
    }

    const brain = model_output.current_state;
    this.state.agent_history_items.push(
      new HistoryItem(
        stepNumber,
        brain.evaluation_previous_goal,
        brain.memory,
        brain.next_goal,
        normalizedActionResults,
        null,
        null
      )
    );
  }

  private getSensitiveDataDescription(
    currentUrl: string,
    sensitiveData:
      | Record<string, string | Record<string, string>>
      | undefined = this.sensitiveData
  ) {
    const placeholders = new Set<string>();
    if (!sensitiveData) {
      return '';
    }
    for (const [key, value] of Object.entries(sensitiveData)) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        if (
          currentUrl &&
          match_url_with_domain_pattern(currentUrl, key, true)
        ) {
          Object.keys(value).forEach((entry) => placeholders.add(entry));
        }
      } else if (typeof value === 'string') {
        placeholders.add(key);
      }
    }
    if (!placeholders.size) {
      return '';
    }
    const placeholderList = `[${Array.from(placeholders)
      .sort()
      .map((placeholder) => `'${placeholder.replaceAll("'", "\\'")}'`)
      .join(', ')}]`;
    return `Here are placeholders for sensitive data:\n${placeholderList}\nTo use them, write <secret>the placeholder name</secret>`;
  }

  prepare_step_state(
    browser_state_summary: BrowserStateSummary,
    model_output: AgentOutput | null = null,
    result: ActionResult[] | null = null,
    step_info: AgentStepInfo | null = null,
    sensitive_data: Record<
      string,
      string | Record<string, string>
    > | null = null
  ) {
    this.state.history.context_messages = [];
    this.updateAgentHistoryDescription(model_output, result, step_info);

    const effectiveSensitiveData = sensitive_data ?? this.sensitiveData;
    if (effectiveSensitiveData) {
      this.sensitiveDataDescription = this.getSensitiveDataDescription(
        browser_state_summary.url,
        effectiveSensitiveData
      );
    }
  }

  async maybe_compact_messages(
    llm: BaseChatModel | null,
    settings: MessageCompactionSettings | null,
    step_info: AgentStepInfo | null = null
  ) {
    if (!settings || !settings.enabled || !llm || !step_info) {
      return false;
    }

    const stepsSince =
      step_info.step_number - (this.state.last_compaction_step ?? 0);
    if (stepsSince < settings.compact_every_n_steps) {
      return false;
    }

    const historyItems = this.state.agent_history_items;
    const fullHistoryText = historyItems
      .map((item) => item.to_string())
      .join('\n')
      .trim();
    const triggerCharCount = settings.trigger_char_count ?? 40000;
    if (fullHistoryText.length < triggerCharCount) {
      return false;
    }

    logger.debug(
      `Compacting message history (items=${historyItems.length}, chars=${fullHistoryText.length})`
    );

    const compactionSections: string[] = [];
    if (this.state.compacted_memory) {
      compactionSections.push(
        `<previous_compacted_memory>\n${this.state.compacted_memory}\n</previous_compacted_memory>`
      );
    }
    compactionSections.push(
      `<agent_history>\n${fullHistoryText}\n</agent_history>`
    );
    if (settings.include_read_state && this.state.read_state_description) {
      compactionSections.push(
        `<read_state>\n${this.state.read_state_description}\n</read_state>`
      );
    }
    let compactionInput = compactionSections.join('\n\n');

    if (this.sensitiveData) {
      const filtered = this.filterSensitiveData(
        new UserMessage(compactionInput)
      );
      compactionInput = filtered.text;
    }

    let systemPrompt =
      'You are summarizing an agent run for prompt compaction.\n' +
      'Capture task requirements, key facts, decisions, partial progress, errors, and next steps.\n' +
      'Preserve important entities, values, URLs, and file paths.\n' +
      'Return plain text only. Do not include tool calls or JSON.';
    if (settings.summary_max_chars) {
      systemPrompt += ` Keep under ${settings.summary_max_chars} characters if possible.`;
    }

    let summary: string;
    try {
      const response = await llm.ainvoke([
        new SystemMessage(systemPrompt),
        new UserMessage(compactionInput),
      ]);
      summary = String(response?.completion ?? '').trim();
    } catch (error) {
      logger.warning(
        `Failed to compact messages: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return false;
    }

    if (!summary) {
      return false;
    }

    if (
      settings.summary_max_chars &&
      summary.length > settings.summary_max_chars
    ) {
      summary = `${summary.slice(0, settings.summary_max_chars).trimEnd()}…`;
    }

    this.state.compacted_memory = summary;
    this.state.compaction_count += 1;
    this.state.last_compaction_step = step_info.step_number;

    const keepLast = Math.max(0, settings.keep_last_items);
    if (historyItems.length > keepLast + 1) {
      if (keepLast === 0) {
        this.state.agent_history_items = [historyItems[0]];
      } else {
        this.state.agent_history_items = [
          historyItems[0],
          ...historyItems.slice(-keepLast),
        ];
      }
    }

    logger.debug(
      `Compaction complete (summary_chars=${summary.length}, history_items=${this.state.agent_history_items.length})`
    );

    return true;
  }

  create_state_messages(
    browser_state_summary: BrowserStateSummary,
    model_output: AgentOutput | null = null,
    result: ActionResult[] | null = null,
    step_info: AgentStepInfo | null = null,
    use_vision: boolean | 'auto' = true,
    page_filtered_actions: string | null = null,
    sensitive_data: Record<
      string,
      string | Record<string, string>
    > | null = null,
    available_file_paths: string[] | null = null,
    include_recent_events: boolean | null = null,
    plan_description: string | null = null,
    unavailable_skills_info: string | null = null,
    skip_state_update = false
  ) {
    if (!skip_state_update) {
      this.prepare_step_state(
        browser_state_summary,
        model_output,
        result,
        step_info,
        sensitive_data
      );
    }

    const screenshots: string[] = [];
    let includeScreenshotRequested = false;
    if (result) {
      for (const actionResult of result) {
        if ((actionResult.metadata as any)?.include_screenshot) {
          includeScreenshotRequested = true;
          break;
        }
      }
    }

    let includeScreenshot = false;
    if (use_vision === true) {
      includeScreenshot = true;
    } else if (use_vision === 'auto') {
      includeScreenshot = includeScreenshotRequested;
    }

    if (includeScreenshot && browser_state_summary.screenshot) {
      screenshots.push(browser_state_summary.screenshot);
    }
    const effectiveUseVision = screenshots.length > 0;

    const includeRecentEvents =
      include_recent_events ?? this.includeRecentEvents;

    const prompt = new AgentMessagePrompt({
      browser_state_summary,
      file_system: this.fileSystem,
      agent_history_description: this.agent_history_description,
      read_state_description: this.state.read_state_description,
      task: this.task,
      include_attributes: this.includeAttributes,
      step_info,
      page_filtered_actions,
      sensitive_data: this.sensitiveDataDescription,
      available_file_paths,
      screenshots,
      vision_detail_level: this.visionDetailLevel,
      include_recent_events: includeRecentEvents,
      sample_images: this.sampleImages,
      read_state_images: this.state.read_state_images,
      llm_screenshot_size: this.llmScreenshotSize,
      plan_description,
      unavailable_skills_info,
    });
    const message = prompt.get_user_message(effectiveUseVision);
    this.last_state_message_text = this.extractStateMessageText(message);
    this.setMessageWithType(message, 'state');
  }

  get_messages() {
    logger.debug('');
    this.lastInputMessages = this.state.history.get_messages();
    return this.lastInputMessages;
  }

  private setMessageWithType(
    message: SystemMessage | UserMessage,
    messageType: 'system' | 'state'
  ) {
    if (messageType === 'system') {
      this.state.history.system_message = message;
    } else {
      const filtered = this.sensitiveData
        ? this.filterSensitiveData(message)
        : message;
      this.state.history.state_message = filtered;
    }
  }

  private addContextMessage(message: SystemMessage | UserMessage) {
    this.state.history.context_messages.push(message);
  }

  _add_context_message(message: SystemMessage | UserMessage) {
    this.addContextMessage(message);
  }

  private extractStateMessageText(message: UserMessage | SystemMessage) {
    if (typeof message.content === 'string') {
      return message.content;
    }
    if (!Array.isArray(message.content)) {
      return null;
    }
    return message.content
      .map((part) => {
        if (part instanceof ContentPartTextParam) {
          return part.text;
        }
        return null;
      })
      .filter((part): part is string => typeof part === 'string')
      .join('\n');
  }

  private filterSensitiveData(message: SystemMessage | UserMessage) {
    if (!this.sensitiveData) {
      return message;
    }

    const replaceSensitive = (value: string) =>
      redactSensitiveDataFromString(value, this.sensitiveData ?? null);

    if (typeof message.content === 'string') {
      message.content = replaceSensitive(message.content);
    } else if (Array.isArray(message.content)) {
      message.content = message.content.map((part) => {
        if (part instanceof ContentPartTextParam) {
          part.text = replaceSensitive(part.text);
        }
        return part;
      });
    }
    return message;
  }
}
