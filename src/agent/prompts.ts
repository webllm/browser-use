import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Image, createCanvas } from 'canvas';
import {
  SystemMessage,
  UserMessage,
  ContentPartTextParam,
  ContentPartImageParam,
  ImageURL,
} from '../llm/messages.js';
import { observe_debug } from '../observability.js';
import { is_new_tab_page, sanitize_surrogates } from '../utils.js';
import { createLogger } from '../logging-config.js';
import type { AgentStepInfo } from './views.js';
import type { BrowserStateSummary } from '../browser/views.js';
import type { FileSystem } from '../filesystem/file-system.js';
import { DOMElementNode, DOMTextNode } from '../dom/views.js';

const logger = createLogger('browser_use.agent.prompts');

const readPromptTemplate = (filename: string) => {
  const filePath = fileURLToPath(new URL(filename, import.meta.url));
  return fs.readFileSync(filePath, 'utf-8');
};

export class SystemPrompt {
  private promptTemplate = '';
  private systemMessage: SystemMessage;

  constructor(
    private readonly maxActionsPerStep = 3,
    private readonly overrideSystemMessage: string | null = null,
    private readonly extendSystemMessage: string | null = null,
    private readonly useThinking = true,
    private readonly flashMode = false,
    private readonly isAnthropic = false,
    private readonly isBrowserUseModel = false,
    private readonly modelName: string | null = null
  ) {
    if (overrideSystemMessage !== null) {
      this.promptTemplate = overrideSystemMessage;
    } else {
      this.loadPromptTemplate();
    }

    let prompt = this.promptTemplate.replace(
      '{max_actions}',
      String(this.maxActionsPerStep)
    );
    if (this.extendSystemMessage) {
      prompt += `\n${this.extendSystemMessage}`;
    }
    this.systemMessage = new SystemMessage(prompt);
    this.systemMessage.cache = true;
  }

  private isAnthropic45Model() {
    if (!this.modelName) {
      return false;
    }
    const modelLower = this.modelName.toLowerCase();
    const isOpus45 =
      modelLower.includes('opus') &&
      (modelLower.includes('4.5') || modelLower.includes('4-5'));
    const isHaiku45 =
      modelLower.includes('haiku') &&
      (modelLower.includes('4.5') || modelLower.includes('4-5'));
    return isOpus45 || isHaiku45;
  }

  private loadPromptTemplate() {
    let templateName = './system_prompt.md';
    if (this.isBrowserUseModel) {
      if (this.flashMode) {
        templateName = './system_prompt_browser_use_flash.md';
      } else if (this.useThinking) {
        templateName = './system_prompt_browser_use.md';
      } else {
        templateName = './system_prompt_browser_use_no_thinking.md';
      }
    } else if (this.flashMode && this.isAnthropic45Model()) {
      templateName = './system_prompt_anthropic_flash.md';
    } else if (this.flashMode && this.isAnthropic) {
      templateName = './system_prompt_flash_anthropic.md';
    } else if (this.flashMode) {
      templateName = './system_prompt_flash.md';
    } else if (!this.useThinking) {
      templateName = './system_prompt_no_thinking.md';
    }

    try {
      this.promptTemplate = readPromptTemplate(templateName);
    } catch (error) {
      throw new Error(
        `Failed to load system prompt template: ${(error as Error).message}`,
        { cause: error }
      );
    }
  }

  get_system_message() {
    return this.systemMessage;
  }
}

interface AgentMessagePromptInit {
  browser_state_summary: BrowserStateSummary;
  file_system: FileSystem;
  agent_history_description?: string | null;
  read_state_description?: string | null;
  task?: string | null;
  include_attributes?: string[] | null;
  step_info?: AgentStepInfo | null;
  page_filtered_actions?: string | null;
  max_clickable_elements_length?: number;
  sensitive_data?: string | null;
  available_file_paths?: string[] | null;
  screenshots?: string[] | null;
  vision_detail_level?: 'auto' | 'low' | 'high';
  include_recent_events?: boolean;
  sample_images?: Array<ContentPartTextParam | ContentPartImageParam> | null;
  read_state_images?: Array<Record<string, unknown>> | null;
  llm_screenshot_size?: [number, number] | null;
  unavailable_skills_info?: string | null;
  plan_description?: string | null;
}

export class AgentMessagePrompt {
  private readonly browserState: BrowserStateSummary;
  private readonly fileSystem: FileSystem;
  private readonly agentHistoryDescription: string | null;
  private readonly readStateDescription: string | null;
  private readonly task: string | null;
  private readonly includeAttributes?: string[] | null;
  private readonly stepInfo?: AgentStepInfo | null;
  private readonly pageFilteredActions: string | null;
  private readonly maxClickableElementsLength: number;
  private readonly sensitiveData: string | null;
  private readonly availableFilePaths?: string[] | null;
  private readonly screenshots: string[];
  private readonly visionDetailLevel: 'auto' | 'low' | 'high';
  private readonly includeRecentEvents: boolean;
  private readonly sampleImages: Array<
    ContentPartTextParam | ContentPartImageParam
  >;
  private readonly readStateImages: Array<Record<string, unknown>>;
  private readonly llmScreenshotSize: [number, number] | null;
  private readonly unavailableSkillsInfo: string | null;
  private readonly planDescription: string | null;

  constructor(init: AgentMessagePromptInit) {
    this.browserState = init.browser_state_summary;
    this.fileSystem = init.file_system;
    this.agentHistoryDescription = init.agent_history_description ?? null;
    this.readStateDescription = init.read_state_description ?? null;
    this.task = init.task ?? null;
    this.includeAttributes = init.include_attributes ?? null;
    this.stepInfo = init.step_info ?? null;
    this.pageFilteredActions = init.page_filtered_actions ?? null;
    this.maxClickableElementsLength =
      init.max_clickable_elements_length ?? 40000;
    this.sensitiveData = init.sensitive_data ?? null;
    this.availableFilePaths = init.available_file_paths ?? null;
    this.screenshots = init.screenshots ?? [];
    this.visionDetailLevel = init.vision_detail_level ?? 'auto';
    this.includeRecentEvents = init.include_recent_events ?? false;
    this.sampleImages = init.sample_images ?? [];
    this.readStateImages = init.read_state_images ?? [];
    this.llmScreenshotSize = init.llm_screenshot_size ?? null;
    this.unavailableSkillsInfo = init.unavailable_skills_info ?? null;
    this.planDescription = init.plan_description ?? null;
  }

  private extractPageStatistics() {
    const stats = {
      links: 0,
      iframes: 0,
      shadow_open: 0,
      shadow_closed: 0,
      scroll_containers: 0,
      images: 0,
      interactive_elements: 0,
      total_elements: 0,
      text_chars: 0,
    };

    const root = this.browserState.element_tree;
    if (!root) {
      return stats;
    }

    const traverseNode = (node: DOMElementNode) => {
      stats.total_elements += 1;

      const tag = String(node.tag_name ?? '').toLowerCase();
      if (tag === 'a') {
        stats.links += 1;
      } else if (tag === 'iframe' || tag === 'frame') {
        stats.iframes += 1;
      } else if (tag === 'img') {
        stats.images += 1;
      }

      if (node.is_interactive) {
        stats.interactive_elements += 1;
      }

      if (node.shadow_root) {
        // The TS DOM snapshot currently tracks presence of a shadow root, but
        // does not expose open-vs-closed mode; count these as open for parity.
        stats.shadow_open += 1;
      }

      for (const child of node.children) {
        if (child instanceof DOMElementNode) {
          traverseNode(child);
        } else if (child instanceof DOMTextNode && child.is_visible) {
          stats.text_chars += child.text.trim().length;
        }
      }
    };

    traverseNode(root);
    return stats;
  }

  private browserStateDescription() {
    const pageStats = this.extractPageStatistics();
    let statsText = '<page_stats>';
    const pendingRequestCount =
      this.browserState.pending_network_requests?.length ?? 0;
    if (pageStats.total_elements < 10) {
      statsText += 'Page appears empty - consider waiting - ';
    } else if (
      // Low text density only means "still loading" while requests are in flight.
      pendingRequestCount > 0 &&
      pageStats.total_elements > 20 &&
      pageStats.text_chars < pageStats.total_elements * 5
    ) {
      statsText +=
        `${pendingRequestCount} network request(s) in flight and little text rendered - ` +
        'page may still be loading, consider waiting - ';
    }
    statsText += `${pageStats.links} links, ${pageStats.interactive_elements} interactive, ${pageStats.iframes} iframes`;
    if (pageStats.shadow_open > 0 || pageStats.shadow_closed > 0) {
      statsText += `, ${pageStats.shadow_open} shadow(open), ${pageStats.shadow_closed} shadow(closed)`;
    }
    if (pageStats.images > 0) {
      statsText += `, ${pageStats.images} images`;
    }
    statsText += `, ${pageStats.total_elements} total elements`;
    statsText += '</page_stats>\n';

    let elementsText = this.browserState.llm_representation(
      this.includeAttributes ?? undefined
    );
    let truncatedText = '';
    if (elementsText.length > this.maxClickableElementsLength) {
      elementsText = elementsText.slice(0, this.maxClickableElementsLength);
      truncatedText = ` (truncated to ${this.maxClickableElementsLength} characters)`;
    }

    let hasContentAbove = false;
    let hasContentBelow = false;

    const pi = this.browserState.page_info;
    let pageInfoText = '';
    if (pi) {
      const pagesAbove =
        pi.viewport_height > 0 ? pi.pixels_above / pi.viewport_height : 0;
      const pagesBelow =
        pi.viewport_height > 0 ? pi.pixels_below / pi.viewport_height : 0;
      hasContentAbove = pagesAbove > 0;
      hasContentBelow = pagesBelow > 0;
      pageInfoText = '<page_info>';
      pageInfoText += `${pagesAbove.toFixed(1)} above, `;
      pageInfoText += `${pagesBelow.toFixed(1)} below `;
      pageInfoText += '</page_info>\n';
    }

    if (elementsText) {
      if (!hasContentAbove) {
        elementsText = `[Start of page]\n${elementsText}`;
      }

      if (!hasContentBelow) {
        elementsText = `${elementsText}\n[End of page]`;
      }
    } else {
      elementsText = 'empty page';
    }

    let tabsText = '';
    const resolveTabIdentifier = (tab: { page_id: number; tab_id?: string }) =>
      typeof tab.tab_id === 'string' && tab.tab_id.trim()
        ? tab.tab_id.trim().slice(-4)
        : String(tab.page_id);
    const currentTabCandidates: string[] = [];
    for (const tab of this.browserState.tabs) {
      if (
        tab.url === this.browserState.url &&
        tab.title === this.browserState.title
      ) {
        currentTabCandidates.push(resolveTabIdentifier(tab));
      }
    }
    const currentTabId =
      currentTabCandidates.length === 1 ? currentTabCandidates[0] : null;
    for (const tab of this.browserState.tabs) {
      tabsText += `Tab ${resolveTabIdentifier(tab)}: ${tab.url} - ${tab.title.slice(0, 30)}\n`;
    }

    const currentTabText =
      currentTabId !== null ? `Current tab: ${currentTabId}` : '';
    const pdfMessage = this.browserState.is_pdf_viewer
      ? 'PDF viewer cannot be rendered. In this page, DO NOT use the extract action as PDF content cannot be rendered. Use the read_file action on the downloaded PDF in available_file_paths to read the full text content.\n\n'
      : '';
    const recentEventsText =
      this.includeRecentEvents && this.browserState.recent_events
        ? `Recent browser events: ${this.browserState.recent_events}\n`
        : '';
    const stateErrorText = this.browserState.state_error
      ? `<browser_state_error>${this.browserState.state_error}</browser_state_error>\n`
      : '';

    let closedPopupsText = '';
    if (
      Array.isArray(this.browserState.closed_popup_messages) &&
      this.browserState.closed_popup_messages.length > 0
    ) {
      closedPopupsText = 'Auto-closed JavaScript dialogs:\n';
      for (const popupMessage of this.browserState.closed_popup_messages) {
        closedPopupsText += `  - ${popupMessage}\n`;
      }
      closedPopupsText += '\n';
    }

    return `${statsText}${currentTabText}
Available tabs:
${tabsText}
${pageInfoText}
${stateErrorText}${recentEventsText}${closedPopupsText}${pdfMessage}Interactive elements${truncatedText}:
${elementsText}
`;
  }

  private currentDateString() {
    const now = new Date();
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  }

  private userRequestDescription() {
    return `<user_request>
${this.task ?? ''}
</user_request>

`;
  }

  private stepMetaDescription() {
    let stepInfoDescription =
      this.stepInfo != null
        ? `Step${this.stepInfo.step_number + 1} maximum:${this.stepInfo.max_steps}\n`
        : '';
    stepInfoDescription += `Today:${this.currentDateString()}`;

    return `<step_info>${stepInfoDescription}</step_info>
`;
  }

  private agentStateDescription() {
    const todoContents = this.fileSystem.get_todo_contents();
    const todoText = todoContents || '[empty todo.md, fill it when applicable]';

    let agentState = `<file_system>
${this.fileSystem.describe()}
</file_system>
<todo_contents>
${todoText}
</todo_contents>
`;
    if (this.planDescription) {
      agentState += `<plan>
${this.planDescription}
</plan>
`;
    }

    if (this.sensitiveData) {
      agentState += `<sensitive_data>${this.sensitiveData}</sensitive_data>
`;
    }

    if (this.availableFilePaths?.length) {
      agentState += `<available_file_paths>${this.availableFilePaths.join('\n')}
Use with absolute paths</available_file_paths>
`;
    }

    return agentState;
  }

  private resizeScreenshotForLlm(screenshotB64: string) {
    if (!this.llmScreenshotSize) {
      return screenshotB64;
    }

    try {
      const [targetWidth, targetHeight] = this.llmScreenshotSize;
      const image = new Image();
      image.src = Buffer.from(screenshotB64, 'base64');

      if (image.width === targetWidth && image.height === targetHeight) {
        return screenshotB64;
      }

      logger.info(
        `Resizing screenshot from ${image.width}x${image.height} to ${targetWidth}x${targetHeight} for LLM`
      );

      const canvas = createCanvas(targetWidth, targetHeight);
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0, targetWidth, targetHeight);
      return canvas.toBuffer('image/png').toString('base64');
    } catch (error) {
      logger.warning(
        `Failed to resize screenshot: ${(error as Error).message}, using original`
      );
      return screenshotB64;
    }
  }

  // @ts-ignore - Decorator type mismatch with TypeScript strict mode
  @observe_debug({
    name: 'agent_message_prompt:get_user_message',
    ignore_input: true,
    ignore_output: true,
  })
  get_user_message(use_vision = true) {
    if (
      is_new_tab_page(this.browserState.url) &&
      this.stepInfo &&
      this.stepInfo.step_number === 0 &&
      this.browserState.tabs.length === 1
    ) {
      use_vision = false;
    }

    let stateDescription = this.userRequestDescription();

    stateDescription += `<agent_history>
${(this.agentHistoryDescription ?? '').trim()}
</agent_history>

`;
    stateDescription += `<agent_state>
${this.agentStateDescription().trim()}
</agent_state>
`;
    stateDescription += `<browser_state>
${this.browserStateDescription().trim()}
</browser_state>
`;

    const readState = (this.readStateDescription ?? '').trim();
    if (readState) {
      stateDescription += `<read_state>
${readState}
</read_state>
`;
    }

    if (this.pageFilteredActions) {
      stateDescription += `<page_specific_actions>
${this.pageFilteredActions}
</page_specific_actions>
`;
    }

    if (this.unavailableSkillsInfo) {
      stateDescription += `\n${this.unavailableSkillsInfo}\n`;
    }

    stateDescription += this.stepMetaDescription();

    stateDescription = sanitize_surrogates(stateDescription);

    const hasReadStateImages = this.readStateImages.length > 0;
    if (
      (use_vision === true && this.screenshots.length > 0) ||
      hasReadStateImages
    ) {
      const parts: Array<ContentPartTextParam | ContentPartImageParam> = [
        new ContentPartTextParam(stateDescription),
      ];
      parts.push(...this.sampleImages);

      this.screenshots.forEach((shot, index) => {
        const label =
          index === this.screenshots.length - 1
            ? 'Current screenshot:'
            : 'Previous screenshot:';
        const processedScreenshot = this.resizeScreenshotForLlm(shot);
        parts.push(new ContentPartTextParam(label));
        parts.push(
          new ContentPartImageParam(
            new ImageURL(
              `data:image/png;base64,${processedScreenshot}`,
              this.visionDetailLevel,
              'image/png'
            )
          )
        );
      });

      for (const imageInfo of this.readStateImages) {
        const imageName =
          typeof imageInfo.name === 'string' ? imageInfo.name : 'unknown';
        const imageData =
          typeof imageInfo.data === 'string' ? imageInfo.data : null;
        if (!imageData) {
          continue;
        }
        const mediaType = imageName.toLowerCase().endsWith('.png')
          ? 'image/png'
          : 'image/jpeg';
        parts.push(new ContentPartTextParam(`Image from file: ${imageName}`));
        parts.push(
          new ContentPartImageParam(
            new ImageURL(
              `data:${mediaType};base64,${imageData}`,
              this.visionDetailLevel,
              mediaType
            )
          )
        );
      }
      const message = new UserMessage(parts);
      message.cache = true;
      return message;
    }

    const message = new UserMessage(stateDescription);
    message.cache = true;
    return message;
  }
}

export const get_rerun_summary_prompt = (
  originalTask: string,
  totalSteps: number,
  successCount: number,
  errorCount: number
) =>
  `You are analyzing the completion of a rerun task. Based on the screenshot and execution info, provide a summary.

Original task: ${originalTask}

Execution statistics:
- Total steps: ${totalSteps}
- Successful steps: ${successCount}
- Failed steps: ${errorCount}

Analyze the screenshot to determine:
1. Whether the task completed successfully
2. What the final state shows
3. Overall completion status (complete/partial/failed)

Respond with:
- summary: A clear, concise summary of what happened during the rerun
- success: Whether the task completed successfully (true/false)
- completion_status: One of "complete", "partial", or "failed"`;

export const get_rerun_summary_message = (
  prompt: string,
  screenshotB64: string | null = null
) => {
  if (screenshotB64) {
    const parts: Array<ContentPartTextParam | ContentPartImageParam> = [
      new ContentPartTextParam(prompt),
      new ContentPartImageParam(
        new ImageURL(`data:image/png;base64,${screenshotB64}`)
      ),
    ];
    return new UserMessage(parts);
  }
  return new UserMessage(prompt);
};

export const get_ai_step_system_prompt = () =>
  `
You are an expert at extracting data from webpages.

<input>
You will be given:
1. A query describing what to extract
2. The markdown of the webpage (filtered to remove noise)
3. Optionally, a screenshot of the current page state
</input>

<instructions>
- Extract information from the webpage that is relevant to the query
- ONLY use the information available in the webpage - do not make up information
- If the information is not available, mention that clearly
- If the query asks for all items, list all of them
</instructions>

<output>
- Present ALL relevant information in a concise way
- Do not use conversational format - directly output the relevant information
- If information is unavailable, state that clearly
</output>
`.trim();

export const get_ai_step_user_prompt = (
  query: string,
  statsSummary: string,
  content: string
) =>
  `<query>
${query}
</query>

<content_stats>
${statsSummary}
</content_stats>

<webpage_content>
${content}
</webpage_content>`;
