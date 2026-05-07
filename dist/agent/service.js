import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { config as loadEnv } from 'dotenv';
import { z } from 'zod';
import { createLogger } from '../logging-config.js';
import { CONFIG } from '../config.js';
import { EventBus } from '../event-bus.js';
import { uuid7str, SignalHandler, get_browser_use_version, check_latest_browser_use_version, sanitize_surrogates, } from '../utils.js';
import { Controller as DefaultController } from '../controller/service.js';
import { lenientBool } from '../controller/views.js';
import { FileSystem as AgentFileSystem, DEFAULT_FILE_SYSTEM_PATH, } from '../filesystem/file-system.js';
import { SystemPrompt, get_ai_step_system_prompt, get_ai_step_user_prompt, get_rerun_summary_message, get_rerun_summary_prompt, } from './prompts.js';
import { MessageManager } from './message-manager/service.js';
import { BrowserStateHistory } from '../browser/views.js';
import { BrowserSession } from '../browser/session.js';
import { BrowserProfile, DEFAULT_BROWSER_PROFILE } from '../browser/profile.js';
import { HistoryTreeProcessor } from '../dom/history-tree-processor/service.js';
import { DOMHistoryElement } from '../dom/history-tree-processor/view.js';
import { DEFAULT_INCLUDE_ATTRIBUTES, } from '../dom/views.js';
import { extractCleanMarkdownFromHtml } from '../dom/markdown-extractor.js';
import { ChatBrowserUse } from '../llm/browser-use/chat.js';
import { ModelProviderError, ModelRateLimitError } from '../llm/exceptions.js';
import { AssistantMessage, ContentPartTextParam, SystemMessage, UserMessage, } from '../llm/messages.js';
import { getLlmByName } from '../llm/models.js';
import { ActionResult, AgentHistory, AgentHistoryList, AgentOutput, AgentState, AgentStepInfo, AgentError, StepMetadata, ActionModel, PlanItem, defaultMessageCompactionSettings, normalizeMessageCompactionSettings, } from './views.js';
import { detect_variables_in_history, substitute_in_dict, } from './variable-detector.js';
import { CreateAgentOutputFileEvent, CreateAgentSessionEvent, CreateAgentTaskEvent, CreateAgentStepEvent, UpdateAgentTaskEvent, } from './cloud-events.js';
import { create_history_gif } from './gif.js';
import { ScreenshotService } from '../screenshots/service.js';
import { productTelemetry } from '../telemetry/service.js';
import { AgentTelemetryEvent } from '../telemetry/views.js';
import { TokenCost } from '../tokens/service.js';
import { construct_judge_messages, construct_simple_judge_messages, } from './judge.js';
import { CloudSkillService, MissingCookieException, build_skill_parameters_schema, get_skill_slug, } from '../skills/index.js';
loadEnv();
const logger = createLogger('browser_use.agent');
const URL_PATTERN = /https?:\/\/[^\s<>"']+|www\.[^\s<>"']+|[^\s<>"']+\.[a-z]{2,}(?:\/[^\s<>"']*)?/gi;
export const log_response = (response, registry, logInstance = logger) => {
    if (response.current_state.thinking) {
        logInstance.debug(`💡 Thinking:\n${response.current_state.thinking}`);
    }
    const evalGoal = response.current_state.evaluation_previous_goal;
    if (evalGoal) {
        if (evalGoal.toLowerCase().includes('success')) {
            logInstance.info(`  \x1b[32m👍 Eval: ${evalGoal}\x1b[0m`);
        }
        else if (evalGoal.toLowerCase().includes('failure')) {
            logInstance.info(`  \x1b[31m⚠️ Eval: ${evalGoal}\x1b[0m`);
        }
        else {
            logInstance.info(`  ❔ Eval: ${evalGoal}`);
        }
    }
    if (response.current_state.memory) {
        logInstance.info(`  🧠 Memory: ${response.current_state.memory}`);
    }
    const nextGoal = response.current_state.next_goal;
    if (nextGoal) {
        logInstance.info(`  \x1b[34m🎯 Next goal: ${nextGoal}\x1b[0m`);
    }
};
class AsyncMutex {
    locked = false;
    waiters = [];
    async acquire() {
        if (!this.locked) {
            this.locked = true;
            let released = false;
            return () => {
                if (released) {
                    return;
                }
                released = true;
                this.release();
            };
        }
        await new Promise((resolve) => this.waiters.push(resolve));
        this.locked = true;
        let released = false;
        return () => {
            if (released) {
                return;
            }
            released = true;
            this.release();
        };
    }
    release() {
        const next = this.waiters.shift();
        if (next) {
            next();
            return;
        }
        this.locked = false;
    }
}
class ExecutionTimeoutError extends Error {
    constructor() {
        super('Operation timed out');
        this.name = 'ExecutionTimeoutError';
    }
}
const ensureDir = (target) => {
    if (!fs.existsSync(target)) {
        fs.mkdirSync(target, { recursive: true });
    }
};
const resolve_agent_llm = (llm) => {
    if (llm) {
        return llm;
    }
    const defaultLlmName = CONFIG.DEFAULT_LLM.trim();
    if (defaultLlmName) {
        return getLlmByName(defaultLlmName);
    }
    return new ChatBrowserUse();
};
const get_model_timeout = (llm) => {
    const modelName = String(llm?.model ?? '').toLowerCase();
    if (modelName.includes('gemini')) {
        if (modelName.includes('3-pro')) {
            return 90;
        }
        return 75;
    }
    if (modelName.includes('groq')) {
        return 30;
    }
    if (modelName.includes('o3') ||
        modelName.includes('claude') ||
        modelName.includes('sonnet') ||
        modelName.includes('deepseek')) {
        return 90;
    }
    return 75;
};
const defaultAgentOptions = () => ({
    use_vision: true,
    include_recent_events: false,
    sample_images: null,
    llm_screenshot_size: null,
    save_conversation_path: null,
    save_conversation_path_encoding: 'utf-8',
    max_failures: 3,
    directly_open_url: true,
    override_system_message: null,
    extend_system_message: null,
    generate_gif: false,
    available_file_paths: [],
    include_attributes: undefined,
    max_actions_per_step: 5,
    use_thinking: true,
    flash_mode: false,
    use_judge: true,
    ground_truth: null,
    max_history_items: null,
    page_extraction_llm: null,
    fallback_llm: null,
    judge_llm: null,
    skill_ids: null,
    skills: null,
    skill_service: null,
    enable_planning: true,
    planning_replan_on_stall: 3,
    planning_exploration_limit: 5,
    context: null,
    source: null,
    file_system_path: null,
    task_id: null,
    cloud_sync: null,
    calculate_cost: false,
    display_files_in_done_text: true,
    include_tool_call_examples: false,
    session_attachment_mode: 'copy',
    vision_detail_level: 'auto',
    llm_timeout: null,
    step_timeout: 180,
    final_response_after_failure: true,
    message_compaction: true,
    loop_detection_window: 20,
    loop_detection_enabled: true,
    _url_shortening_limit: 25,
});
const AgentLLMOutputSchema = z.object({
    thinking: z.string().optional().nullable(),
    evaluation_previous_goal: z.string().optional().nullable(),
    memory: z.string().optional().nullable(),
    next_goal: z.string().optional().nullable(),
    current_plan_item: z.number().int().optional().nullable(),
    plan_update: z.array(z.string()).optional().nullable(),
    action: z
        .array(z.record(z.string(), z.any()))
        .optional()
        .nullable()
        .default([]),
});
const DoneOnlyLLMOutputSchema = AgentLLMOutputSchema.extend({
    action: z
        .array(z.object({
        done: z.object({}).passthrough(),
    }))
        .optional()
        .nullable()
        .default([]),
});
const SimpleJudgeSchema = z.object({
    // pydantic-parity: bu-2-0 sometimes omits is_correct entirely. python upstream
    // treats missing as False via pydantic; zod hard-rejects without lenientBool,
    // crashing the simple-judge pass and skipping the override. Default false:
    // when the model can't commit, treat the run as not-yet-correct.
    is_correct: lenientBool(false),
    reason: z.string().optional().default(''),
});
const JudgeSchema = z.object({
    reasoning: z.string().optional().nullable().default(''),
    // same parity: missing verdict → false (judge declines to confirm pass)
    verdict: lenientBool(false),
    failure_reason: z.string().optional().nullable().default(''),
    impossible_task: z.boolean().optional().default(false),
    reached_captcha: z.boolean().optional().default(false),
});
const AgentLLMOutputFormat = AgentLLMOutputSchema;
AgentLLMOutputFormat.schema = AgentLLMOutputSchema;
const DoneOnlyLLMOutputFormat = DoneOnlyLLMOutputSchema;
DoneOnlyLLMOutputFormat.schema = DoneOnlyLLMOutputSchema;
const SimpleJudgeOutputFormat = SimpleJudgeSchema;
SimpleJudgeOutputFormat.schema = SimpleJudgeSchema;
const JudgeOutputFormat = JudgeSchema;
JudgeOutputFormat.schema = JudgeSchema;
export class Agent {
    static _sharedSessionStepLocks = new Map();
    static DEFAULT_AGENT_DATA_DIR = path.join(process.cwd(), DEFAULT_FILE_SYSTEM_PATH);
    browser_session = null;
    llm;
    judge_llm;
    unfiltered_actions;
    initial_actions;
    initial_url = null;
    register_new_step_callback;
    register_done_callback;
    register_should_stop_callback;
    register_external_agent_status_raise_error_callback;
    context;
    telemetry;
    eventbus;
    enable_cloud_sync;
    cloud_sync = null;
    file_system = null;
    screenshot_service = null;
    agent_directory;
    _current_screenshot_path = null;
    has_downloads_path = false;
    _last_known_downloads = [];
    version = 'unknown';
    source = 'unknown';
    step_start_time = 0;
    _external_pause_event = {
        resolve: null,
        promise: Promise.resolve(),
    };
    output_model_schema;
    extraction_schema;
    id;
    task_id;
    session_id;
    task;
    controller;
    settings;
    token_cost_service;
    state;
    history;
    _message_manager;
    available_file_paths = [];
    sensitive_data;
    _logger = null;
    _file_system_path = null;
    agent_current_page = null;
    _session_start_time = 0;
    _task_start_time = 0;
    _force_exit_telemetry_logged = false;
    _closePromise = null;
    _hasBrowserSessionClaim = false;
    _sharedPinnedTabId = null;
    _enforceDoneOnlyForCurrentStep = false;
    system_prompt_class;
    ActionModel = ActionModel;
    AgentOutput = AgentOutput;
    DoneActionModel = ActionModel;
    DoneAgentOutput = AgentOutput;
    _fallback_llm = null;
    _using_fallback_llm = false;
    _original_llm = null;
    _url_shortening_limit = 25;
    skill_service = null;
    _skills_registered = false;
    constructor(params) {
        const { task, llm, page = null, browser = null, browser_context = null, browser_profile = null, browser_session = null, tools = null, controller = null, sensitive_data = null, initial_actions = null, directly_open_url = true, register_new_step_callback = null, register_done_callback = null, register_should_stop_callback = null, register_external_agent_status_raise_error_callback = null, output_model_schema = null, extraction_schema = null, use_vision = true, include_recent_events = false, sample_images = null, llm_screenshot_size = null, save_conversation_path = null, save_conversation_path_encoding = 'utf-8', max_failures = 3, override_system_message = null, extend_system_message = null, generate_gif = false, available_file_paths = [], include_attributes, max_actions_per_step = 5, use_thinking = true, flash_mode = false, use_judge = true, ground_truth = null, max_history_items = null, page_extraction_llm = null, fallback_llm = null, judge_llm = null, skill_ids = null, skills = null, skill_service = null, enable_planning = true, planning_replan_on_stall = 3, planning_exploration_limit = 5, context = null, source = null, file_system_path = null, task_id = null, cloud_sync = null, calculate_cost = false, display_files_in_done_text = true, include_tool_call_examples = false, vision_detail_level = 'auto', session_attachment_mode = 'copy', llm_timeout = null, step_timeout = 180, final_response_after_failure = true, message_compaction = true, loop_detection_window = 20, loop_detection_enabled = true, _url_shortening_limit = 25, } = { ...defaultAgentOptions(), ...params };
        const resolvedLlm = resolve_agent_llm(llm);
        const effectivePageExtractionLlm = page_extraction_llm ?? resolvedLlm;
        const effectiveJudgeLlm = judge_llm ?? resolvedLlm;
        const effectiveFlashMode = flash_mode || resolvedLlm?.provider === 'browser-use';
        const effectiveEnablePlanning = effectiveFlashMode
            ? false
            : enable_planning;
        const effectiveLlmTimeout = typeof llm_timeout === 'number'
            ? llm_timeout
            : get_model_timeout(resolvedLlm);
        const normalizedMessageCompaction = this._normalizeMessageCompactionSetting(message_compaction);
        let resolvedLlmScreenshotSize = llm_screenshot_size ?? null;
        if (resolvedLlmScreenshotSize !== null) {
            if (!Array.isArray(resolvedLlmScreenshotSize) ||
                resolvedLlmScreenshotSize.length !== 2) {
                throw new Error('llm_screenshot_size must be a tuple of [width, height]');
            }
            const [width, height] = resolvedLlmScreenshotSize;
            if (!Number.isInteger(width) || !Number.isInteger(height)) {
                throw new Error('llm_screenshot_size dimensions must be integers');
            }
            if (width < 100 || height < 100) {
                throw new Error('llm_screenshot_size dimensions must be at least 100 pixels');
            }
            logger.info(`LLM screenshot resizing enabled: ${width}x${height}`);
        }
        if (resolvedLlmScreenshotSize == null) {
            const modelName = String(resolvedLlm?.model ?? '');
            if (modelName.startsWith('claude-sonnet')) {
                resolvedLlmScreenshotSize = [1400, 850];
                logger.info('Auto-configured LLM screenshot size for Claude Sonnet: 1400x850');
            }
        }
        this.llm = resolvedLlm;
        this.judge_llm = effectiveJudgeLlm;
        this._fallback_llm = fallback_llm;
        this._using_fallback_llm = false;
        this._original_llm = resolvedLlm;
        this._url_shortening_limit = Math.max(0, Math.trunc(_url_shortening_limit));
        this.id = task_id || uuid7str();
        this.task_id = this.id;
        this.session_id = uuid7str();
        this.available_file_paths = available_file_paths || [];
        if (tools && controller) {
            throw new Error('Cannot specify both "tools" and "controller". Use "tools" only.');
        }
        const resolvedController = (tools ??
            controller ??
            new DefaultController({
                exclude_actions: use_vision !== 'auto' ? ['screenshot'] : [],
                display_files_in_done_text,
            }));
        const toolsOutputModel = this._getToolsOutputModelSchema(resolvedController);
        let resolvedOutputModelSchema = output_model_schema ?? null;
        if (resolvedOutputModelSchema &&
            toolsOutputModel &&
            resolvedOutputModelSchema !== toolsOutputModel) {
            this.logger.warning(`output_model_schema (${this._getOutputModelSchemaName(resolvedOutputModelSchema)}) differs from Tools output_model (${this._getOutputModelSchemaName(toolsOutputModel)}). Using Agent output_model_schema.`);
        }
        else if (!resolvedOutputModelSchema && toolsOutputModel) {
            resolvedOutputModelSchema = toolsOutputModel;
        }
        this.output_model_schema = resolvedOutputModelSchema;
        this.extraction_schema = extraction_schema ?? null;
        if (!this.extraction_schema && this.output_model_schema) {
            this.extraction_schema =
                this._getOutputModelSchemaPayload(this.output_model_schema) ?? null;
        }
        this.task = this._enhanceTaskWithSchema(task, this.output_model_schema);
        this.sensitive_data = sensitive_data;
        this.controller = resolvedController;
        const setCoordinateClicking = this.controller
            ?.set_coordinate_clicking;
        if (typeof setCoordinateClicking === 'function') {
            const modelName = String(this.llm?.model ?? '').toLowerCase();
            const supportsCoordinateClicking = [
                'claude-sonnet-4',
                'claude-opus-4',
                'gemini-3-pro',
                'browser-use/',
            ].some((pattern) => modelName.includes(pattern));
            setCoordinateClicking.call(this.controller, supportsCoordinateClicking);
        }
        const structuredOutputActionSchema = this._resolveStructuredOutputActionSchema(this.output_model_schema);
        if (structuredOutputActionSchema) {
            this.controller.use_structured_output_action(structuredOutputActionSchema);
        }
        if (skills && skill_ids) {
            throw new Error('Cannot specify both "skills" and "skill_ids". Use "skills" only.');
        }
        const resolvedSkillIds = skills ?? skill_ids;
        if (skill_service) {
            this.skill_service = skill_service;
        }
        else if (resolvedSkillIds && resolvedSkillIds.length > 0) {
            this.skill_service = new CloudSkillService({
                skill_ids: resolvedSkillIds,
            });
        }
        if (use_vision !== 'auto') {
            const excludeAction = this.controller?.exclude_action;
            if (typeof excludeAction === 'function') {
                excludeAction.call(this.controller, 'screenshot');
            }
            else {
                this.controller.registry.exclude_action?.('screenshot');
            }
        }
        let resolvedInitialActions = initial_actions;
        const hasFollowUpState = Boolean(params.injected_agent_state?.follow_up_task);
        if (directly_open_url &&
            !hasFollowUpState &&
            !resolvedInitialActions?.length) {
            const extractedUrl = this._extract_start_url(task);
            if (extractedUrl) {
                this.initial_url = extractedUrl;
                this.logger.info(`🔗 Found URL in task: ${extractedUrl}, adding as initial action...`);
                resolvedInitialActions = [
                    { go_to_url: { url: extractedUrl, new_tab: false } },
                ];
            }
        }
        this.initial_actions = resolvedInitialActions
            ? this._convertInitialActions(resolvedInitialActions)
            : null;
        this.register_new_step_callback = register_new_step_callback;
        this.register_done_callback = register_done_callback;
        this.register_should_stop_callback = register_should_stop_callback;
        this.register_external_agent_status_raise_error_callback =
            register_external_agent_status_raise_error_callback;
        this.context = context;
        this.agent_directory = Agent.DEFAULT_AGENT_DATA_DIR;
        this.settings = {
            use_vision,
            include_recent_events,
            vision_detail_level,
            save_conversation_path,
            save_conversation_path_encoding,
            max_failures,
            generate_gif,
            override_system_message,
            extend_system_message,
            include_attributes: include_attributes ?? [...DEFAULT_INCLUDE_ATTRIBUTES],
            max_actions_per_step,
            use_thinking,
            flash_mode: effectiveFlashMode,
            use_judge,
            ground_truth,
            max_history_items,
            page_extraction_llm: effectivePageExtractionLlm,
            enable_planning: effectiveEnablePlanning,
            planning_replan_on_stall,
            planning_exploration_limit,
            calculate_cost,
            include_tool_call_examples,
            session_attachment_mode,
            llm_timeout: effectiveLlmTimeout,
            step_timeout,
            final_response_after_failure,
            message_compaction: normalizedMessageCompaction,
            loop_detection_window,
            loop_detection_enabled,
        };
        this.token_cost_service = new TokenCost(calculate_cost);
        if (calculate_cost) {
            this.token_cost_service.initialize().catch((error) => {
                this.logger.debug(`Failed to initialize token cost service: ${error.message}`);
            });
        }
        this.token_cost_service.register_llm(resolvedLlm);
        this.token_cost_service.register_llm(effectivePageExtractionLlm);
        this.token_cost_service.register_llm(effectiveJudgeLlm);
        if (normalizedMessageCompaction?.compaction_llm) {
            this.token_cost_service.register_llm(normalizedMessageCompaction.compaction_llm);
        }
        this.state = params.injected_agent_state || new AgentState();
        this.state.loop_detector.window_size = this.settings.loop_detection_window;
        this.history = new AgentHistoryList([], null);
        this.telemetry = productTelemetry;
        this._file_system_path = file_system_path;
        this.file_system = this._initFileSystem(file_system_path);
        this._setScreenshotService();
        this._setup_action_models();
        this._set_browser_use_version_and_source(source);
        this.browser_session = this._init_browser_session({
            page,
            browser,
            browser_context,
            browser_profile,
            browser_session,
        });
        if (this.browser_session) {
            this.browser_session.llm_screenshot_size = resolvedLlmScreenshotSize;
        }
        this.has_downloads_path = Boolean(this.browser_session?.browser_profile?.downloads_path);
        if (this.has_downloads_path) {
            this._last_known_downloads = [];
            this.logger.debug('📁 Initialized download tracking for agent');
        }
        this.system_prompt_class = new SystemPrompt(this.settings.max_actions_per_step, this.settings.override_system_message, this.settings.extend_system_message, this.settings.use_thinking, this.settings.flash_mode, String(this.llm?.provider ?? '').toLowerCase() === 'anthropic', String(this.llm?.model ?? '')
            .toLowerCase()
            .includes('browser-use/'), String(this.llm?.model ?? ''));
        this._message_manager = new MessageManager(this.task, this.system_prompt_class.get_system_message(), this.file_system, this.state.message_manager_state, this.settings.use_thinking, this.settings.include_attributes, sensitive_data ?? undefined, this.settings.max_history_items, this.settings.vision_detail_level, this.settings.include_tool_call_examples, this.settings.include_recent_events, sample_images ?? null, resolvedLlmScreenshotSize);
        this.unfiltered_actions = this.controller.registry.get_prompt_description();
        this.eventbus = new EventBus(this._buildEventBusName());
        this.enable_cloud_sync = CONFIG.BROWSER_USE_CLOUD_SYNC;
        if (this.enable_cloud_sync || cloud_sync) {
            this.cloud_sync = cloud_sync ?? null;
            if (this.cloud_sync) {
                this.eventbus.on('*', this.cloud_sync.handle_event?.bind(this.cloud_sync) ?? (() => { }));
            }
        }
        this._external_pause_event = {
            resolve: null,
            promise: Promise.resolve(),
        };
        this._session_start_time = 0;
        this._task_start_time = 0;
        this._force_exit_telemetry_logged = false;
        // Security validation for sensitive_data and allowed_domains
        this._validateSecuritySettings();
        this._capture_shared_pinned_tab();
        // LLM verification and setup
        this._verifyAndSetupLlm();
        // Model-specific vision handling
        this._handleModelSpecificVision();
    }
    _normalizeMessageCompactionSetting(messageCompaction) {
        if (messageCompaction == null) {
            return null;
        }
        if (typeof messageCompaction === 'boolean') {
            return normalizeMessageCompactionSettings({
                ...defaultMessageCompactionSettings(),
                enabled: messageCompaction,
            });
        }
        return normalizeMessageCompactionSettings({
            ...defaultMessageCompactionSettings(),
            ...messageCompaction,
        });
    }
    _createSessionIdWithAgentSuffix() {
        const suffix = this.id.slice(-4);
        const generated = uuid7str();
        return `${generated.slice(0, -4)}${suffix}`;
    }
    _buildEventBusName() {
        let agentIdSuffix = String(this.id).slice(-4).replace(/-/g, '_');
        if (agentIdSuffix && /^\d/.test(agentIdSuffix)) {
            agentIdSuffix = `a${agentIdSuffix}`;
        }
        return `Agent_${agentIdSuffix}`;
    }
    _copyBrowserProfile(profile) {
        const source = profile ?? DEFAULT_BROWSER_PROFILE;
        const clonedConfig = typeof structuredClone === 'function'
            ? structuredClone(source.config)
            : JSON.parse(JSON.stringify(source.config));
        return new BrowserProfile(clonedConfig);
    }
    _getBrowserContextFromPage(page, browser_context) {
        if (!page) {
            return browser_context;
        }
        const contextAttr = page.context;
        if (typeof contextAttr === 'function') {
            try {
                const resolved = contextAttr.call(page);
                return resolved ?? browser_context;
            }
            catch {
                return browser_context;
            }
        }
        return contextAttr ?? browser_context;
    }
    _claim_or_isolate_browser_session(browser_session) {
        const claimMode = this.settings.session_attachment_mode === 'shared'
            ? 'shared'
            : 'exclusive';
        this._hasBrowserSessionClaim = false;
        const claimSession = (session) => {
            const claimFn = session.claim_agent ?? session.claimAgent;
            if (typeof claimFn !== 'function') {
                if (this.settings.session_attachment_mode === 'strict' ||
                    this.settings.session_attachment_mode === 'shared') {
                    throw new Error(`session_attachment_mode='${this.settings.session_attachment_mode}' requires BrowserSession.claim_agent()/release_agent() support.`);
                }
                return 'noop';
            }
            const claimed = Boolean(claimFn.call(session, this.id, claimMode));
            return claimed ? 'claimed' : 'failed';
        };
        const getAttachedAgentIds = (session) => {
            const pluralGetter = session.get_attached_agent_ids ??
                session.getAttachedAgentIds;
            if (typeof pluralGetter === 'function') {
                const value = pluralGetter.call(session);
                if (Array.isArray(value)) {
                    return value.filter((item) => typeof item === 'string');
                }
            }
            const singleGetter = session.get_attached_agent_id ??
                session.getAttachedAgentId;
            if (typeof singleGetter !== 'function') {
                return [];
            }
            const value = singleGetter.call(session);
            return typeof value === 'string' ? [value] : [];
        };
        const claimResult = claimSession(browser_session);
        if (claimResult !== 'failed') {
            this._hasBrowserSessionClaim = claimResult === 'claimed';
            return browser_session;
        }
        const currentOwners = getAttachedAgentIds(browser_session);
        const ownerLabel = currentOwners.length > 0 ? currentOwners.join(', ') : 'unknown';
        if (this.settings.session_attachment_mode === 'strict') {
            throw new Error(`BrowserSession is already attached to Agent ${ownerLabel}. Set session_attachment_mode='copy' to allow automatic isolation.`);
        }
        if (this.settings.session_attachment_mode === 'shared') {
            throw new Error(`BrowserSession is already attached in exclusive mode by Agent ${ownerLabel}. Configure all participating agents with session_attachment_mode='shared' or use session_attachment_mode='copy'.`);
        }
        this.logger.warning(`⚠️ BrowserSession is already attached to Agent ${ownerLabel}. Creating an isolated copy for this Agent.`);
        const modelCopyFn = browser_session.model_copy ?? browser_session.modelCopy;
        if (typeof modelCopyFn !== 'function') {
            throw new Error(`BrowserSession is attached to another Agent (${ownerLabel}) and cannot be safely reused. Provide a separate BrowserSession.`);
        }
        const isolated = modelCopyFn.call(browser_session);
        const isolatedClaimResult = claimSession(isolated);
        if (isolatedClaimResult === 'failed') {
            throw new Error('Failed to claim isolated BrowserSession for current Agent');
        }
        this._hasBrowserSessionClaim = isolatedClaimResult === 'claimed';
        return isolated;
    }
    _release_browser_session_claim(browser_session) {
        if (!browser_session || !this._hasBrowserSessionClaim) {
            return;
        }
        const releaseFn = browser_session.release_agent ??
            browser_session.releaseAgent;
        if (typeof releaseFn !== 'function') {
            return;
        }
        const released = releaseFn.call(browser_session, this.id);
        if (!released) {
            this.logger.warning('⚠️ BrowserSession claim was not released because it is currently attached to another Agent.');
        }
        this._hasBrowserSessionClaim = false;
    }
    _has_any_browser_session_attachments(browser_session) {
        if (!browser_session) {
            return false;
        }
        const pluralGetter = browser_session.get_attached_agent_ids ??
            browser_session.getAttachedAgentIds;
        if (typeof pluralGetter === 'function') {
            const value = pluralGetter.call(browser_session);
            if (Array.isArray(value)) {
                return value.some((item) => typeof item === 'string');
            }
        }
        const singleGetter = browser_session.get_attached_agent_id ??
            browser_session.getAttachedAgentId;
        if (typeof singleGetter !== 'function') {
            return false;
        }
        return typeof singleGetter.call(browser_session) === 'string';
    }
    _is_shared_session_mode() {
        return this.settings.session_attachment_mode === 'shared';
    }
    _capture_shared_pinned_tab() {
        if (!this._is_shared_session_mode() || !this.browser_session) {
            return;
        }
        const activeTab = this.browser_session.active_tab;
        const pageId = activeTab?.page_id;
        if (typeof pageId === 'number') {
            this._sharedPinnedTabId = pageId;
        }
    }
    async _restore_shared_pinned_tab_if_needed() {
        if (!this._is_shared_session_mode() || !this.browser_session) {
            return;
        }
        const switchFn = this.browser_session.switch_to_tab ??
            this.browser_session.switchToTab;
        if (typeof switchFn !== 'function') {
            return;
        }
        if (this._sharedPinnedTabId == null) {
            this._capture_shared_pinned_tab();
            return;
        }
        try {
            await switchFn.call(this.browser_session, this._sharedPinnedTabId);
        }
        catch {
            this._capture_shared_pinned_tab();
        }
    }
    async _run_with_shared_session_step_lock(callback) {
        if (!this._is_shared_session_mode() || !this.browser_session) {
            return callback();
        }
        const sessionId = this.browser_session.id;
        let lock = Agent._sharedSessionStepLocks.get(sessionId);
        if (!lock) {
            lock = new AsyncMutex();
            Agent._sharedSessionStepLocks.set(sessionId, lock);
        }
        const release = await lock.acquire();
        try {
            return await callback();
        }
        finally {
            release();
        }
    }
    _cleanup_shared_session_step_lock_if_unused(browser_session) {
        if (!browser_session) {
            return;
        }
        if (this._has_any_browser_session_attachments(browser_session)) {
            return;
        }
        Agent._sharedSessionStepLocks.delete(browser_session.id);
    }
    _init_browser_session(init) {
        let { page, browser, browser_context, browser_profile, browser_session } = init;
        if (browser instanceof BrowserSession) {
            browser_session = browser_session ?? browser;
            browser = null;
        }
        if (browser_session) {
            const ownsResources = browser_session._owns_browser_resources;
            if (ownsResources === false &&
                this.settings.session_attachment_mode === 'copy') {
                this.logger.warning("⚠️ Non-owning BrowserSession detected. session_attachment_mode='copy' will isolate this Agent with a cloned BrowserSession.");
                const modelCopyFn = browser_session.model_copy ??
                    browser_session.modelCopy;
                if (typeof modelCopyFn === 'function') {
                    const isolated = modelCopyFn.call(browser_session);
                    return this._claim_or_isolate_browser_session(isolated);
                }
            }
            return this._claim_or_isolate_browser_session(browser_session);
        }
        const resolvedContext = this._getBrowserContextFromPage(page, browser_context);
        const resolvedProfile = this._copyBrowserProfile(browser_profile);
        return this._claim_or_isolate_browser_session(new BrowserSession({
            browser_profile: resolvedProfile,
            browser: browser ?? null,
            browser_context: resolvedContext,
            page,
            id: this._createSessionIdWithAgentSuffix(),
        }));
    }
    /**
     * Convert dictionary-based actions to ActionModel instances
     */
    _convertInitialActions(actions) {
        const convertedActions = [];
        for (const actionDict of actions) {
            // Each actionDict should have a single key-value pair
            const actionName = Object.keys(actionDict)[0];
            const params = actionDict[actionName];
            try {
                // Get the parameter model for this action from registry
                const actionInfo = this.controller.registry.get_all_actions().get(actionName) ?? null;
                if (!actionInfo) {
                    this.logger.warning(`⚠️ Unknown action "${actionName}" in initial_actions, skipping`);
                    continue;
                }
                const paramModel = actionInfo.paramSchema;
                if (!paramModel) {
                    this.logger.warning(`⚠️ No parameter model for action "${actionName}", using raw params`);
                    convertedActions.push(actionDict);
                    continue;
                }
                // Validate parameters using Zod schema
                const validatedParams = paramModel.parse(params);
                if (!validatedParams ||
                    typeof validatedParams !== 'object' ||
                    Array.isArray(validatedParams)) {
                    this.logger.warning(`⚠️ Parsed params for action "${actionName}" are not an object, skipping`);
                    continue;
                }
                // Create action with validated parameters
                convertedActions.push({
                    [actionName]: validatedParams,
                });
            }
            catch (error) {
                this.logger.error(`❌ Failed to validate initial action "${actionName}": ${error}`);
                // Skip invalid actions
                continue;
            }
        }
        return convertedActions;
    }
    /**
     * Handle model-specific vision capabilities
     * Some models like DeepSeek and Grok don't support vision yet
     */
    _handleModelSpecificVision() {
        const modelName = this.llm.model?.toLowerCase() || '';
        // Handle DeepSeek models
        if (modelName.includes('deepseek') && this.settings.use_vision) {
            this.logger.warning('⚠️ DeepSeek models do not support use_vision=True yet. Setting use_vision=False for now...');
            this.settings.use_vision = false;
        }
        // Handle XAI models that currently do not support vision
        if ((modelName.includes('grok-3') || modelName.includes('grok-code')) &&
            this.settings.use_vision) {
            this.logger.warning('⚠️ This XAI model does not support use_vision=True yet. Setting use_vision=False for now...');
            this.settings.use_vision = false;
        }
    }
    /**
     * Verify that the LLM API keys are setup and the LLM API is responding properly.
     * Also handles model capability detection.
     */
    _verifyAndSetupLlm() {
        // Skip verification if already done or if configured to skip
        if (this.llm._verified_api_keys === true ||
            CONFIG.SKIP_LLM_API_KEY_VERIFICATION) {
            this.llm._verified_api_keys = true;
            return true;
        }
        // Mark as verified
        this.llm._verified_api_keys = true;
        // Log LLM information
        this.logger.debug(`🤖 Using LLM: ${this.llm.model || 'unknown model'}`);
        return true;
    }
    /**
     * Validates security settings when sensitive_data is provided
     * Checks if allowed_domains is properly configured to prevent credential leakage
     */
    _validateSecuritySettings() {
        if (!this.sensitive_data) {
            return;
        }
        // Check if sensitive_data has domain-specific credentials
        const hasDomainSpecificCredentials = Object.values(this.sensitive_data).some((value) => typeof value === 'object' && value !== null);
        const allowedDomainsConfig = this.browser_session?.browser_profile?.config?.allowed_domains;
        const hasAllowedDomains = Array.isArray(allowedDomainsConfig)
            ? allowedDomainsConfig.length > 0
            : Boolean(allowedDomainsConfig);
        // If no allowed_domains are configured, show a security warning
        if (!hasAllowedDomains) {
            this.logger.warning('⚠️ Agent(sensitive_data=••••••••) was provided but Browser(allowed_domains=[...]) is not locked down! ⚠️\n' +
                '          ☠️ If the agent visits a malicious website and encounters a prompt-injection attack, your sensitive_data may be exposed!\n\n' +
                '   \n');
        }
        // If we're using domain-specific credentials, validate domain patterns
        else if (hasDomainSpecificCredentials) {
            const allowedDomains = this.browser_session.browser_profile.config.allowed_domains;
            // Get domain patterns from sensitive_data where value is an object
            const domainPatterns = Object.keys(this.sensitive_data).filter((key) => typeof this.sensitive_data[key] === 'object' &&
                this.sensitive_data[key] !== null);
            // Validate each domain pattern against allowed_domains
            for (const domainPattern of domainPatterns) {
                let isAllowed = false;
                for (const allowedDomain of allowedDomains) {
                    // Special cases that don't require URL matching
                    if (domainPattern === allowedDomain || allowedDomain === '*') {
                        isAllowed = true;
                        break;
                    }
                    // Extract the domain parts, ignoring scheme
                    const patternDomain = domainPattern.includes('://')
                        ? domainPattern.split('://')[1]
                        : domainPattern;
                    const allowedDomainPart = allowedDomain.includes('://')
                        ? allowedDomain.split('://')[1]
                        : allowedDomain;
                    // Check if pattern is covered by an allowed domain
                    // Example: "google.com" is covered by "*.google.com"
                    if (patternDomain === allowedDomainPart ||
                        (allowedDomainPart.startsWith('*.') &&
                            (patternDomain === allowedDomainPart.slice(2) ||
                                patternDomain.endsWith('.' + allowedDomainPart.slice(2))))) {
                        isAllowed = true;
                        break;
                    }
                }
                if (!isAllowed) {
                    this.logger.warning(`⚠️ Domain pattern "${domainPattern}" in sensitive_data is not covered by any pattern in allowed_domains=${JSON.stringify(allowedDomains)}\n` +
                        `   This may be a security risk as credentials could be used on unintended domains.`);
                }
            }
        }
    }
    _initFileSystem(file_system_path) {
        if (this.state.file_system_state && file_system_path) {
            throw new Error('Cannot provide both file_system_state (from agent state) and file_system_path. Restore from state or create new file system, not both.');
        }
        if (this.state.file_system_state) {
            try {
                this.file_system = AgentFileSystem.from_state_sync(this.state.file_system_state);
                this._file_system_path = this.state.file_system_state.base_dir;
                this.logger.debug(`💾 File system restored from state to: ${this._file_system_path}`);
                const timestamp = Date.now();
                this.agent_directory = path.join(os.tmpdir(), `browser_use_agent_${this.id}_${timestamp}`);
                ensureDir(this.agent_directory);
                return this.file_system;
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                this.logger.error(`💾 Failed to restore file system from state: ${message}`);
                throw error;
            }
        }
        const timestamp = Date.now();
        this.agent_directory = path.join(os.tmpdir(), `browser_use_agent_${this.id}_${timestamp}`);
        ensureDir(this.agent_directory);
        const baseDir = file_system_path ?? this.agent_directory;
        ensureDir(baseDir);
        try {
            this.file_system = new AgentFileSystem(baseDir);
            this._file_system_path = baseDir;
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.error(`💾 Failed to initialize file system: ${message}`);
            throw error;
        }
        this.state.file_system_state = this.file_system.get_state();
        this.logger.debug(`💾 File system path: ${this._file_system_path}`);
        return this.file_system;
    }
    _setScreenshotService() {
        try {
            this.screenshot_service = new ScreenshotService(this.agent_directory);
            this.logger.debug(`📸 Screenshot service initialized in: ${path.join(this.agent_directory, 'screenshots')}`);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.error(`📸 Failed to initialize screenshot service: ${message}`);
            throw error;
        }
    }
    get logger() {
        if (!this._logger) {
            const taskIdSuffix = typeof this.task_id === 'string' && this.task_id.length
                ? this.task_id.slice(-4)
                : '----';
            const browserSessionSuffix = typeof this.browser_session?.id === 'string'
                ? this.browser_session.id.slice(-4)
                : typeof this.id === 'string'
                    ? this.id.slice(-4)
                    : '----';
            const focusTargetSuffixRaw = this.browser_session
                ?.agent_focus_target_id;
            const focusTargetSuffix = typeof focusTargetSuffixRaw === 'string' && focusTargetSuffixRaw.length
                ? focusTargetSuffixRaw.slice(-2)
                : '--';
            this._logger = createLogger(`browser_use.Agent🅰 ${taskIdSuffix} ⇢ 🅑 ${browserSessionSuffix} 🅣 ${focusTargetSuffix}`);
        }
        return this._logger;
    }
    get message_manager() {
        return this._message_manager;
    }
    /**
     * Get the browser instance from the browser session
     */
    get browser() {
        if (!this.browser_session) {
            throw new Error('BrowserSession is not set up');
        }
        if (!this.browser_session.browser) {
            throw new Error('Browser is not set up');
        }
        return this.browser_session.browser;
    }
    /**
     * Get the browser context from the browser session
     */
    get browserContext() {
        if (!this.browser_session) {
            throw new Error('BrowserSession is not set up');
        }
        if (!this.browser_session.browser_context) {
            throw new Error('BrowserContext is not set up');
        }
        return this.browser_session.browser_context;
    }
    /**
     * Get the browser profile from the browser session
     */
    get browserProfile() {
        if (!this.browser_session) {
            throw new Error('BrowserSession is not set up');
        }
        return this.browser_session.browser_profile;
    }
    get is_using_fallback_llm() {
        return this._using_fallback_llm;
    }
    get current_llm_model() {
        return typeof this.llm?.model === 'string' ? this.llm.model : 'unknown';
    }
    /**
     * Add a new task to the agent, keeping the same task_id as tasks are continuous
     */
    addNewTask(newTask) {
        // Simply delegate to message manager - no need for new task_id or events
        // The task continues with new instructions, it doesn't end and start a new one
        this.task = newTask;
        this._message_manager.add_new_task(newTask);
        this.state.follow_up_task = true;
        this.state.stopped = false;
        this.state.paused = false;
        this.eventbus = new EventBus(this._buildEventBusName());
    }
    _enhanceTaskWithSchema(task, outputModelSchema) {
        if (!outputModelSchema) {
            return task;
        }
        try {
            const schemaPayload = this._getOutputModelSchemaPayload(outputModelSchema);
            if (schemaPayload == null) {
                return task;
            }
            const schemaJson = JSON.stringify(schemaPayload, null, 2);
            if (!schemaJson) {
                return task;
            }
            const schemaName = typeof outputModelSchema?.name === 'string'
                ? outputModelSchema.name
                : 'StructuredOutput';
            return `${task}\nExpected output format: ${schemaName}\n${schemaJson}`;
        }
        catch (error) {
            this.logger.debug(`Could not parse output schema for task enhancement: ${error instanceof Error ? error.message : String(error)}`);
            return task;
        }
    }
    _getOutputModelSchemaPayload(outputModelSchema) {
        if (outputModelSchema instanceof z.ZodType) {
            try {
                const schema = z.toJSONSchema(outputModelSchema);
                return schema && typeof schema === 'object'
                    ? schema
                    : null;
            }
            catch {
                return null;
            }
        }
        if (typeof outputModelSchema.model_json_schema === 'function') {
            const schema = outputModelSchema.model_json_schema();
            return schema && typeof schema === 'object'
                ? schema
                : null;
        }
        if (outputModelSchema.schema != null) {
            const schemaCandidate = outputModelSchema.schema;
            const schema = (() => {
                if (schemaCandidate instanceof z.ZodType) {
                    return z.toJSONSchema(schemaCandidate);
                }
                if (typeof schemaCandidate?.toJSON === 'function') {
                    return schemaCandidate.toJSON();
                }
                return schemaCandidate;
            })();
            return schema && typeof schema === 'object'
                ? schema
                : null;
        }
        return null;
    }
    _getToolsOutputModelSchema(tools) {
        const getOutputModel = tools?.get_output_model;
        if (typeof getOutputModel !== 'function') {
            return null;
        }
        const outputModel = getOutputModel.call(tools);
        return outputModel == null
            ? null
            : outputModel;
    }
    _getOutputModelSchemaName(outputModelSchema) {
        const explicitName = typeof outputModelSchema?.name === 'string'
            ? outputModelSchema.name
            : null;
        if (explicitName && explicitName.trim().length > 0) {
            return explicitName;
        }
        const ctorName = outputModelSchema?.constructor?.name;
        return typeof ctorName === 'string' && ctorName.trim().length > 0
            ? ctorName
            : 'StructuredOutput';
    }
    _resolveStructuredOutputActionSchema(outputModelSchema) {
        if (!outputModelSchema) {
            return null;
        }
        if (outputModelSchema instanceof z.ZodType) {
            return outputModelSchema;
        }
        const schemaCandidate = outputModelSchema?.schema;
        if (schemaCandidate instanceof z.ZodType) {
            return schemaCandidate;
        }
        return null;
    }
    _extract_start_url(taskText) {
        const taskWithoutEmails = taskText.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '');
        const urlPatterns = [
            /https?:\/\/[^\s<>"']+/g,
            /(?:www\.)?[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*\.[a-zA-Z]{2,}(?:\/[^\s<>"']*)?/g,
        ];
        const excludedExtensions = new Set([
            'pdf',
            'doc',
            'docx',
            'xls',
            'xlsx',
            'ppt',
            'pptx',
            'odt',
            'ods',
            'odp',
            'txt',
            'md',
            'csv',
            'json',
            'xml',
            'yaml',
            'yml',
            'zip',
            'rar',
            '7z',
            'tar',
            'gz',
            'bz2',
            'xz',
            'jpg',
            'jpeg',
            'png',
            'gif',
            'bmp',
            'svg',
            'webp',
            'ico',
            'mp3',
            'mp4',
            'avi',
            'mkv',
            'mov',
            'wav',
            'flac',
            'ogg',
            'py',
            'js',
            'css',
            'java',
            'cpp',
            'bib',
            'bibtex',
            'tex',
            'latex',
            'cls',
            'sty',
            'exe',
            'msi',
            'dmg',
            'pkg',
            'deb',
            'rpm',
            'iso',
            'polynomial',
        ]);
        const excludedWords = ['never', 'dont', "don't", 'not'];
        const foundUrls = [];
        for (const pattern of urlPatterns) {
            for (const match of taskWithoutEmails.matchAll(pattern)) {
                const original = match[0];
                const startIndex = match.index ?? 0;
                let url = original.replace(/[.,;:!?()[\]]+$/g, '');
                const lowerUrl = url.toLowerCase();
                let shouldExclude = false;
                for (const ext of excludedExtensions) {
                    if (lowerUrl.includes(`.${ext}`)) {
                        shouldExclude = true;
                        break;
                    }
                }
                if (shouldExclude) {
                    this.logger.debug(`Excluding URL with file extension from auto-navigation: ${url}`);
                    continue;
                }
                const contextStart = Math.max(0, startIndex - 20);
                const contextText = taskWithoutEmails
                    .slice(contextStart, startIndex)
                    .toLowerCase();
                if (excludedWords.some((word) => contextText.includes(word))) {
                    this.logger.debug(`Excluding URL with word in excluded words from auto-navigation: ${url} (context: "${contextText.trim()}")`);
                    continue;
                }
                if (!url.startsWith('http://') && !url.startsWith('https://')) {
                    url = `https://${url}`;
                }
                foundUrls.push(url);
            }
        }
        const uniqueUrls = Array.from(new Set(foundUrls));
        if (uniqueUrls.length > 1) {
            this.logger.debug(`Multiple URLs found (${foundUrls.length}), skipping directly_open_url to avoid ambiguity`);
            return null;
        }
        return uniqueUrls.length === 1 ? uniqueUrls[0] : null;
    }
    /**
     * Take a step and return whether the task is done and valid
     * @returns Tuple of [is_done, is_valid]
     */
    async takeStep(stepInfo) {
        await this._step(stepInfo ?? null);
        if (this.history.is_done()) {
            await this._run_simple_judge();
            await this.log_completion();
            if (this.settings.use_judge) {
                await this._judge_and_log();
            }
            if (this.register_done_callback) {
                await this.register_done_callback(this.history);
            }
            return [true, true];
        }
        return [false, false];
    }
    /**
     * Remove think tags from text
     */
    _removeThinkTags(text) {
        const THINK_TAGS = /<think>.*?<\/think>/gs;
        const STRAY_CLOSE_TAG = /.*?<\/think>/gs;
        // Step 1: Remove well-formed <think>...</think>
        text = text.replace(THINK_TAGS, '');
        // Step 2: If there's an unmatched closing tag </think>,
        //         remove everything up to and including that.
        text = text.replace(STRAY_CLOSE_TAG, '');
        return text.trim();
    }
    /**
     * Log a comprehensive summary of the next action(s)
     */
    _logNextActionSummary(parsed) {
        if (!parsed.action || parsed.action.length === 0) {
            return;
        }
        const actionCount = parsed.action.length;
        // Collect action details
        const actionDetails = [];
        let lastActionName = 'unknown';
        let lastParamStr = '';
        for (const action of parsed.action) {
            const actionData = action.model_dump();
            const actionName = Object.keys(actionData)[0] || 'unknown';
            const actionParams = actionData[actionName] || {};
            // Format key parameters concisely
            const paramSummary = [];
            if (typeof actionParams === 'object' && actionParams !== null) {
                for (const [key, value] of Object.entries(actionParams)) {
                    if (key === 'index') {
                        paramSummary.push(`#${value}`);
                    }
                    else if (key === 'text' && typeof value === 'string') {
                        const textPreview = value.length > 30 ? value.slice(0, 30) + '...' : value;
                        paramSummary.push(`text="${textPreview}"`);
                    }
                    else if (key === 'url') {
                        paramSummary.push(`url="${value}"`);
                    }
                    else if (key === 'success') {
                        paramSummary.push(`success=${value}`);
                    }
                    else if (typeof value === 'string' ||
                        typeof value === 'number' ||
                        typeof value === 'boolean') {
                        const valStr = String(value);
                        const truncatedVal = valStr.length > 30 ? valStr.slice(0, 30) + '...' : valStr;
                        paramSummary.push(`${key}=${truncatedVal}`);
                    }
                }
            }
            const paramStr = paramSummary.length > 0 ? `(${paramSummary.join(', ')})` : '';
            actionDetails.push(`${actionName}${paramStr}`);
            lastActionName = actionName;
            lastParamStr = paramStr;
        }
        // Create summary based on single vs multi-action
        if (actionCount === 1) {
            this.logger.info(`☝️ Decided next action: ${lastActionName}${lastParamStr}`);
        }
        else {
            const summaryLines = [`✌️ Decided next ${actionCount} multi-actions:`];
            for (let i = 0; i < actionDetails.length; i++) {
                summaryLines.push(`          ${i + 1}. ${actionDetails[i]}`);
            }
            this.logger.info(summaryLines.join('\n'));
        }
    }
    _set_browser_use_version_and_source(sourceOverride) {
        const version = get_browser_use_version();
        let source = 'npm';
        try {
            const projectRoot = process.cwd();
            const repoIndicators = ['.git', 'README.md', 'docs', 'examples'];
            if (repoIndicators.every((indicator) => fs.existsSync(path.join(projectRoot, indicator)))) {
                source = 'git';
            }
        }
        catch (error) {
            this.logger.debug(`Error determining browser-use source: ${error.message}`);
            source = 'unknown';
        }
        if (sourceOverride) {
            source = sourceOverride;
        }
        this.version = version;
        this.source = source;
    }
    /**
     * Setup dynamic action models from controller's registry
     * Initially only include actions with no filters
     */
    _setup_action_models() {
        // Initially only include actions with no filters
        this.ActionModel = this.controller.registry.create_action_model();
        // Create output model with the dynamic actions
        if (this.settings.flash_mode) {
            this.AgentOutput = AgentOutput.type_with_custom_actions_flash_mode(this.ActionModel);
        }
        else if (this.settings.use_thinking) {
            this.AgentOutput = AgentOutput.type_with_custom_actions(this.ActionModel);
        }
        else {
            this.AgentOutput = AgentOutput.type_with_custom_actions_no_thinking(this.ActionModel);
        }
        // Used to force the done action when max_steps is reached
        this.DoneActionModel = this.controller.registry.create_action_model({
            include_actions: ['done'],
        });
        if (this.settings.flash_mode) {
            this.DoneAgentOutput = AgentOutput.type_with_custom_actions_flash_mode(this.DoneActionModel);
        }
        else if (this.settings.use_thinking) {
            this.DoneAgentOutput = AgentOutput.type_with_custom_actions(this.DoneActionModel);
        }
        else {
            this.DoneAgentOutput = AgentOutput.type_with_custom_actions_no_thinking(this.DoneActionModel);
        }
    }
    async _register_skills_as_actions() {
        if (!this.skill_service || this._skills_registered) {
            return;
        }
        const skills = await this.skill_service.get_all_skills();
        if (!skills.length) {
            this.logger.warning('No skills loaded from SkillService');
            return;
        }
        this.logger.info(`🔧 Registering ${skills.length} skill action(s)...`);
        for (const skill of skills) {
            const slug = get_skill_slug(skill, skills);
            const paramSchema = build_skill_parameters_schema(skill.parameters, {
                exclude_cookies: true,
            });
            const description = `${skill.description} (Skill: "${skill.title}")`;
            this.controller.registry.action(description, {
                param_model: paramSchema,
                action_name: slug,
            })(async (params, { browser_session }) => {
                if (!this.skill_service) {
                    return new ActionResult({ error: 'SkillService not initialized' });
                }
                if (!browser_session ||
                    typeof browser_session.get_cookies !== 'function') {
                    return new ActionResult({
                        error: 'Skill execution requires an active BrowserSession.',
                    });
                }
                try {
                    const cookiesRaw = await browser_session.get_cookies();
                    const cookies = Array.isArray(cookiesRaw)
                        ? cookiesRaw
                            .map((cookie) => {
                            const record = cookie && typeof cookie === 'object'
                                ? cookie
                                : null;
                            const name = record && typeof record.name === 'string'
                                ? record.name
                                : null;
                            const value = record && typeof record.value === 'string'
                                ? record.value
                                : '';
                            return name ? { name, value } : null;
                        })
                            .filter((cookie) => cookie != null)
                        : [];
                    const result = await this.skill_service.execute_skill({
                        skill_id: skill.id,
                        parameters: params ?? {},
                        cookies,
                    });
                    if (!result.success) {
                        return new ActionResult({
                            error: result.error ?? 'Skill execution failed',
                        });
                    }
                    const rendered = typeof result.result === 'string'
                        ? result.result
                        : JSON.stringify(result.result ?? {});
                    return new ActionResult({
                        extracted_content: rendered,
                        long_term_memory: rendered,
                    });
                }
                catch (error) {
                    if (error instanceof MissingCookieException) {
                        return new ActionResult({
                            error: `Missing cookies (${error.cookie_name}): ${error.cookie_description}`,
                        });
                    }
                    const message = error instanceof Error
                        ? `${error.name}: ${error.message}`
                        : String(error);
                    return new ActionResult({
                        error: `Skill execution error: ${message}`,
                    });
                }
            });
        }
        this._skills_registered = true;
        this._setup_action_models();
        if (this.initial_actions?.length) {
            const actionDicts = this.initial_actions.map((action) => typeof action?.model_dump === 'function'
                ? action.model_dump({ exclude_unset: true })
                : action);
            this.initial_actions = this._convertInitialActions(actionDicts);
        }
        this.logger.info(`✓ Registered ${skills.length} skill actions`);
    }
    async _get_unavailable_skills_info() {
        if (!this.skill_service || !this.browser_session) {
            return '';
        }
        try {
            const skills = await this.skill_service.get_all_skills();
            if (!skills.length) {
                return '';
            }
            const currentCookies = await this.browser_session.get_cookies();
            const cookieNames = new Set();
            if (Array.isArray(currentCookies)) {
                for (const cookie of currentCookies) {
                    if (!cookie || typeof cookie !== 'object') {
                        continue;
                    }
                    const name = typeof cookie.name === 'string'
                        ? String(cookie.name)
                        : '';
                    if (name) {
                        cookieNames.add(name);
                    }
                }
            }
            const unavailableSkills = [];
            for (const skill of skills) {
                const cookieParams = skill.parameters.filter((param) => param.type === 'cookie');
                if (!cookieParams.length) {
                    continue;
                }
                const missingCookies = [];
                for (const cookieParam of cookieParams) {
                    const isRequired = cookieParam.required !== false;
                    if (isRequired && !cookieNames.has(cookieParam.name)) {
                        missingCookies.push({
                            name: cookieParam.name,
                            description: cookieParam.description || 'No description provided',
                        });
                    }
                }
                if (missingCookies.length) {
                    unavailableSkills.push({
                        id: skill.id,
                        title: skill.title,
                        description: skill.description,
                        missing_cookies: missingCookies,
                    });
                }
            }
            if (!unavailableSkills.length) {
                return '';
            }
            const lines = [
                'Unavailable Skills (missing required cookies):',
            ];
            for (const skillInfo of unavailableSkills) {
                const skillObj = skills.find((entry) => entry.id === skillInfo.id);
                const slug = skillObj
                    ? get_skill_slug(skillObj, skills)
                    : skillInfo.title;
                lines.push('');
                lines.push(`  • ${slug} ("${skillInfo.title}")`);
                lines.push(`    Description: ${skillInfo.description}`);
                lines.push('    Missing cookies:');
                for (const cookie of skillInfo.missing_cookies) {
                    lines.push(`      - ${cookie.name}: ${cookie.description}`);
                }
            }
            return lines.join('\n');
        }
        catch (error) {
            this.logger.error(`Error getting unavailable skills info: ${error instanceof Error
                ? `${error.name}: ${error.message}`
                : String(error)}`);
            return '';
        }
    }
    /**
     * Update action models with page-specific actions
     * Called during each step to filter actions based on current page context
     */
    async _updateActionModelsForPage(page) {
        // Create new action model with current page's filtered actions
        this.ActionModel = this.controller.registry.create_action_model({ page });
        // Update output model with the new actions
        if (this.settings.flash_mode) {
            this.AgentOutput = AgentOutput.type_with_custom_actions_flash_mode(this.ActionModel);
        }
        else if (this.settings.use_thinking) {
            this.AgentOutput = AgentOutput.type_with_custom_actions(this.ActionModel);
        }
        else {
            this.AgentOutput = AgentOutput.type_with_custom_actions_no_thinking(this.ActionModel);
        }
        // Update done action model too
        this.DoneActionModel = this.controller.registry.create_action_model({
            include_actions: ['done'],
            page,
        });
        if (this.settings.flash_mode) {
            this.DoneAgentOutput = AgentOutput.type_with_custom_actions_flash_mode(this.DoneActionModel);
        }
        else if (this.settings.use_thinking) {
            this.DoneAgentOutput = AgentOutput.type_with_custom_actions(this.DoneActionModel);
        }
        else {
            this.DoneAgentOutput = AgentOutput.type_with_custom_actions_no_thinking(this.DoneActionModel);
        }
    }
    async _execute_initial_actions() {
        if (!this.initial_actions?.length || this.state.follow_up_task) {
            return;
        }
        this.logger.debug(`⚡ Executing ${this.initial_actions.length} initial actions...`);
        const result = await this.multi_act(this.initial_actions);
        if (result.length > 0 && this.initial_url && result[0]?.long_term_memory) {
            result[0].long_term_memory = `Found initial url and automatically loaded it. ${result[0].long_term_memory}`;
        }
        this.state.last_result = result;
        const modelOutput = this.settings.flash_mode
            ? new this.AgentOutput({
                evaluation_previous_goal: null,
                memory: 'Initial navigation',
                next_goal: null,
                action: this.initial_actions,
            })
            : new this.AgentOutput({
                evaluation_previous_goal: 'Start',
                memory: null,
                next_goal: 'Initial navigation',
                action: this.initial_actions,
            });
        const timestamp = Date.now() / 1000;
        const metadata = new StepMetadata(timestamp, timestamp, 0, null);
        const stateHistory = new BrowserStateHistory(this.initial_url ?? '', 'Initial Actions', [], Array(this.initial_actions.length).fill(null), null);
        this.history.add_item(new AgentHistory(modelOutput, result, stateHistory, metadata, null));
        this.logger.debug('📝 Saved initial actions to history as step 0');
        this.logger.debug('✅ Initial actions completed');
    }
    async run(max_steps = 500, on_step_start = null, on_step_end = null) {
        let agent_run_error = null;
        this._force_exit_telemetry_logged = false;
        const signal_handler = new SignalHandler({
            pause_callback: this.pause.bind(this),
            resume_callback: this.resume.bind(this),
            custom_exit_callback: () => {
                this._log_agent_event(max_steps, 'SIGINT: Cancelled by user');
                this.telemetry?.flush?.();
                this._force_exit_telemetry_logged = true;
            },
            exit_on_second_int: true,
        });
        signal_handler.register();
        try {
            await this._log_agent_run();
            this.logger.debug(`🔧 Agent setup: Task ID ${this.task_id.slice(-4)}, Session ID ${this.session_id.slice(-4)}, Browser Session ID ${this.browser_session?.id?.slice?.(-4) ?? 'None'}`);
            this._session_start_time = Date.now() / 1000;
            this._task_start_time = this._session_start_time;
            if (!this.state.session_initialized) {
                this.logger.debug('📡 Dispatching CreateAgentSessionEvent...');
                this.eventbus.dispatch(CreateAgentSessionEvent.fromAgent(this));
                this.state.session_initialized = true;
            }
            this.logger.debug('📡 Dispatching CreateAgentTaskEvent...');
            this.eventbus.dispatch(CreateAgentTaskEvent.fromAgent(this));
            if (!this.state.stopped) {
                await this.browser_session?.start();
            }
            await this._register_skills_as_actions();
            try {
                await this._execute_initial_actions();
            }
            catch (error) {
                if (error?.name !== 'InterruptedError') {
                    throw error;
                }
            }
            this.logger.debug(`🔄 Starting main execution loop with max ${max_steps} steps (currently at step ${this.state.n_steps})...`);
            while (this.state.n_steps <= max_steps) {
                const currentStep = this.state.n_steps - 1;
                if (this.state.paused) {
                    this.logger.debug(`⏸️ Step ${this.state.n_steps}: Agent paused, waiting to resume...`);
                    await this.wait_until_resumed();
                    signal_handler.reset();
                }
                if (this.state.consecutive_failures >= this._max_total_failures()) {
                    this.logger.error(`❌ Stopping due to ${this.settings.max_failures} consecutive failures`);
                    agent_run_error = `Stopped due to ${this.settings.max_failures} consecutive failures`;
                    break;
                }
                try {
                    await this._raise_if_stopped_or_paused();
                }
                catch (error) {
                    if (error?.name === 'InterruptedError') {
                        if (this.state.paused) {
                            continue;
                        }
                        if (this.state.stopped) {
                            this.logger.info('🛑 Agent stopped');
                            agent_run_error = 'Agent stopped programmatically';
                        }
                        else {
                            agent_run_error = 'Agent stopped due to external request';
                        }
                        break;
                    }
                    throw error;
                }
                if (on_step_start) {
                    await on_step_start(this);
                }
                this.logger.debug(`🚶 Starting step ${currentStep + 1}/${max_steps}...`);
                const step_info = new AgentStepInfo(currentStep, max_steps);
                const stepAbortController = new AbortController();
                try {
                    await this._executeWithTimeout(this._step(step_info, stepAbortController.signal), this.settings.step_timeout ?? 0, () => stepAbortController.abort());
                    this.logger.debug(`✅ Completed step ${currentStep + 1}/${max_steps}`);
                }
                catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    const isTimeout = error instanceof ExecutionTimeoutError;
                    if (isTimeout) {
                        const timeoutMessage = `Step ${currentStep + 1} timed out after ${this.settings.step_timeout} seconds`;
                        this.logger.error(`⏰ ${timeoutMessage}`);
                        this.state.consecutive_failures += 1;
                        this.state.last_result = [
                            new ActionResult({ error: timeoutMessage }),
                        ];
                        // JavaScript promises are not force-cancelable; stop the run loop
                        // immediately to avoid overlapping timed-out steps with new steps.
                        this.stop();
                        agent_run_error = timeoutMessage;
                        break;
                    }
                    this.logger.error(`❌ Unhandled step error at step ${currentStep + 1}: ${message}`);
                    this.state.consecutive_failures += 1;
                    this.state.last_result = [
                        new ActionResult({
                            error: message || `Unhandled step error at step ${currentStep + 1}`,
                        }),
                    ];
                }
                if (on_step_end) {
                    await on_step_end(this);
                }
                if (this.history.is_done()) {
                    this.logger.debug(`🎯 Task completed after ${currentStep + 1} steps!`);
                    await this._run_simple_judge();
                    await this.log_completion();
                    if (this.settings.use_judge) {
                        await this._judge_and_log();
                    }
                    if (this.register_done_callback) {
                        const maybePromise = this.register_done_callback(this.history);
                        if (maybePromise &&
                            typeof maybePromise.then === 'function') {
                            await maybePromise;
                        }
                    }
                    break;
                }
            }
            if (this.state.n_steps > max_steps &&
                !this.history.is_done() &&
                !agent_run_error) {
                agent_run_error = 'Failed to complete task in maximum steps';
                this.history.add_item(new AgentHistory(null, [
                    new ActionResult({
                        error: agent_run_error,
                        include_in_memory: true,
                    }),
                ], new BrowserStateHistory('', '', [], [], null), null));
                this.logger.info(`❌ ${agent_run_error}`);
            }
            this.logger.debug('📊 Collecting usage summary...');
            this.history.usage =
                (await this.token_cost_service.get_usage_summary());
            if (!this.history._output_model_schema && this.output_model_schema) {
                this.history._output_model_schema = this.output_model_schema;
            }
            this.logger.debug('🏁 Agent.run() completed successfully');
            return this.history;
        }
        catch (error) {
            agent_run_error = error instanceof Error ? error.message : String(error);
            this.logger.error(`Agent run failed with exception: ${agent_run_error}`);
            throw error;
        }
        finally {
            await this.token_cost_service.log_usage_summary();
            signal_handler.unregister();
            if (!this._force_exit_telemetry_logged) {
                try {
                    this._log_agent_event(max_steps, agent_run_error);
                }
                catch (logError) {
                    this.logger.error(`Failed to log telemetry event: ${String(logError)}`);
                }
                finally {
                    try {
                        this.telemetry?.flush?.();
                    }
                    catch (flushError) {
                        this.logger.error(`Failed to flush telemetry client: ${String(flushError)}`);
                    }
                }
            }
            else {
                this.logger.info('Telemetry for force exit (SIGINT) already logged.');
            }
            this.eventbus.dispatch(UpdateAgentTaskEvent.fromAgent(this));
            if (this.settings.generate_gif) {
                let output_path = 'agent_history.gif';
                if (typeof this.settings.generate_gif === 'string') {
                    output_path = this.settings.generate_gif;
                }
                await create_history_gif(this.task, this.history, { output_path });
                if (fs.existsSync(output_path)) {
                    const output_event = await CreateAgentOutputFileEvent.fromAgentAndFile(this, output_path);
                    this.eventbus.dispatch(output_event);
                }
            }
            await this.eventbus.stop();
            await this.close();
        }
    }
    async _executeWithTimeout(promise, timeoutSeconds, onTimeout) {
        if (!timeoutSeconds || timeoutSeconds <= 0) {
            return promise;
        }
        let timeoutHandle = null;
        const timeoutPromise = new Promise((_, reject) => {
            timeoutHandle = setTimeout(() => {
                try {
                    onTimeout?.();
                }
                catch {
                    // Ignore timeout callback errors and preserve timeout semantics.
                }
                reject(new ExecutionTimeoutError());
            }, timeoutSeconds * 1000);
        });
        try {
            return await Promise.race([promise, timeoutPromise]);
        }
        finally {
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
            }
        }
    }
    async _step(step_info = null, signal = null) {
        await this._run_with_shared_session_step_lock(async () => {
            this._throwIfAborted(signal);
            this.step_start_time = Date.now() / 1000;
            let browser_state_summary = null;
            try {
                browser_state_summary = await this._prepare_context(step_info, signal);
                this._throwIfAborted(signal);
                await this._get_next_action(browser_state_summary, signal);
                this._throwIfAborted(signal);
                await this._execute_actions(signal);
                await this._post_process();
            }
            catch (error) {
                if (signal?.aborted) {
                    const message = error instanceof Error ? error.message : String(error);
                    this.logger.debug(`Step aborted before completion: ${message}`);
                }
                else {
                    await this._handle_step_error(error);
                }
            }
            finally {
                await this._finalize(browser_state_summary);
            }
        });
    }
    async _prepare_context(step_info = null, signal = null) {
        if (!this.browser_session) {
            throw new Error('BrowserSession is not set up');
        }
        this._throwIfAborted(signal);
        await this._restore_shared_pinned_tab_if_needed();
        this._throwIfAborted(signal);
        await this.browser_session.wait_if_captcha_solving?.();
        this._throwIfAborted(signal);
        this._log_first_step_startup();
        this.logger.debug(`🌐 Step ${this.state.n_steps}: Getting browser state...`);
        const browser_state_summary = await this.browser_session.get_browser_state_with_recovery?.({
            cache_clickable_elements_hashes: true,
            include_screenshot: true,
            include_recent_events: this.settings.include_recent_events,
            signal,
        });
        this._throwIfAborted(signal);
        const current_page = await this.browser_session.get_current_page?.();
        await this._check_and_update_downloads(`Step ${this.state.n_steps}: after getting browser state`);
        this._log_step_context(current_page, browser_state_summary);
        await this._storeScreenshotForStep(browser_state_summary);
        await this._raise_if_stopped_or_paused();
        this.logger.debug(`📝 Step ${this.state.n_steps}: Updating action models...`);
        this._throwIfAborted(signal);
        await this._updateActionModelsForPage(current_page);
        const page_filtered_actions = this.controller.registry.get_prompt_description(current_page);
        let unavailable_skills_info = null;
        if (this.skill_service) {
            unavailable_skills_info = await this._get_unavailable_skills_info();
        }
        this.logger.debug(`💬 Step ${this.state.n_steps}: Creating state messages for context...`);
        this._message_manager.prepare_step_state(browser_state_summary, this.state.last_model_output, this.state.last_result, step_info, this.sensitive_data ?? null);
        await this._maybe_compact_messages(step_info);
        this._message_manager.create_state_messages(browser_state_summary, this.state.last_model_output, this.state.last_result, step_info, this.settings.use_vision, page_filtered_actions || null, this.sensitive_data ?? null, this.available_file_paths, this.settings.include_recent_events, this._render_plan_description(), unavailable_skills_info, true);
        this._inject_budget_warning(step_info);
        this._inject_replan_nudge();
        this._inject_exploration_nudge();
        this._update_loop_detector_page_state(browser_state_summary);
        this._inject_loop_detection_nudge();
        await this._handle_final_step(step_info);
        await this._handle_failure_limit_recovery();
        return browser_state_summary;
    }
    async _maybe_compact_messages(step_info = null) {
        const settings = this.settings.message_compaction;
        if (!settings || !settings.enabled) {
            return;
        }
        const compactionLlm = settings.compaction_llm ??
            this.settings.page_extraction_llm ??
            this.llm;
        await this._message_manager.maybe_compact_messages(compactionLlm, settings, step_info);
    }
    async _storeScreenshotForStep(browser_state_summary) {
        this._current_screenshot_path = null;
        if (!this.screenshot_service || !browser_state_summary?.screenshot) {
            return;
        }
        try {
            this._current_screenshot_path =
                await this.screenshot_service.store_screenshot(browser_state_summary.screenshot, this.state.n_steps);
            this.logger.debug(`📸 Step ${this.state.n_steps}: Stored screenshot at ${this._current_screenshot_path}`);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.error(`📸 Failed to store screenshot for step ${this.state.n_steps}: ${message}`);
            this._current_screenshot_path = null;
        }
    }
    async _get_next_action(browser_state_summary, signal = null) {
        this._throwIfAborted(signal);
        const input_messages = this._message_manager.get_messages();
        this.logger.debug(`🤖 Step ${this.state.n_steps}: Calling LLM with ${input_messages.length} messages (model: ${this.llm.model})...`);
        let model_output;
        const llmAbortController = new AbortController();
        const removeAbortRelay = this._relayAbortSignal(signal, llmAbortController);
        try {
            model_output = await this._executeWithTimeout(this._get_model_output_with_retry(input_messages, llmAbortController.signal), this.settings.llm_timeout, () => llmAbortController.abort());
        }
        catch (error) {
            if (error instanceof ExecutionTimeoutError) {
                throw new Error(`LLM call timed out after ${this.settings.llm_timeout} seconds. Keep your thinking and output short.`, { cause: error });
            }
            throw error;
        }
        finally {
            removeAbortRelay();
        }
        this._throwIfAborted(signal);
        this.state.last_model_output = model_output;
        let actions = [];
        if (model_output) {
            this._logNextActionSummary(model_output);
            actions = model_output.action.map((a) => a.model_dump());
        }
        await this._raise_if_stopped_or_paused();
        await this._handle_post_llm_processing(browser_state_summary, input_messages, actions);
        await this._raise_if_stopped_or_paused();
    }
    async _execute_actions(signal = null) {
        if (!this.state.last_model_output) {
            throw new Error('No model output to execute actions from');
        }
        this.logger.debug(`⚡ Step ${this.state.n_steps}: Executing ${this.state.last_model_output.action.length} actions...`);
        const result = await this.multi_act(this.state.last_model_output.action.map((a) => a.model_dump()), { signal });
        this.logger.debug(`✅ Step ${this.state.n_steps}: Actions completed`);
        this.state.last_result = result;
    }
    async _post_process() {
        if (!this.browser_session) {
            throw new Error('BrowserSession is not set up');
        }
        await this._check_and_update_downloads('after executing actions');
        if (this.state.last_model_output) {
            this._update_plan_from_model_output(this.state.last_model_output);
        }
        this._update_loop_detector_actions();
        const lastResult = this.state.last_result;
        if (lastResult && lastResult.length === 1 && lastResult[0]?.error) {
            this.state.consecutive_failures += 1;
            this.logger.debug(`🔄 Step ${this.state.n_steps}: Consecutive failures: ${this.state.consecutive_failures}`);
            return;
        }
        if (this.state.consecutive_failures > 0) {
            this.state.consecutive_failures = 0;
            this.logger.debug(`🔄 Step ${this.state.n_steps}: Consecutive failures reset to: ${this.state.consecutive_failures}`);
        }
        if (lastResult &&
            lastResult.length > 0 &&
            lastResult[lastResult.length - 1]?.is_done) {
            const finalResult = lastResult[lastResult.length - 1];
            const success = Boolean(finalResult.success);
            const renderedContent = typeof finalResult.extracted_content === 'string'
                ? finalResult.extracted_content
                : String(finalResult.extracted_content ?? '');
            if (success) {
                this.logger.info(`\n📄 \x1b[32m Final Result:\x1b[0m \n${renderedContent}\n\n`);
            }
            else {
                this.logger.info(`\n📄 \x1b[31m Final Result:\x1b[0m \n${renderedContent}\n\n`);
            }
            const attachments = Array.isArray(finalResult.attachments)
                ? finalResult.attachments
                : [];
            const totalAttachments = attachments.length;
            for (let i = 0; i < attachments.length; i++) {
                const suffix = totalAttachments > 1 ? String(i + 1) : '';
                this.logger.info(`👉 Attachment${suffix ? ` ${suffix}` : ''}: ${attachments[i]}`);
            }
        }
    }
    async multi_act(actions, options = {}) {
        const { signal = null } = options;
        const results = [];
        if (!this.browser_session) {
            throw new Error('BrowserSession is not set up');
        }
        await this._restore_shared_pinned_tab_if_needed();
        // ==================== Execute Actions ====================
        for (let i = 0; i < actions.length; i++) {
            this._throwIfAborted(signal);
            const action = actions[i];
            const actionName = Object.keys(action)[0];
            const actionParams = action[actionName];
            // ==================== Done Action Position Validation ====================
            // ONLY ALLOW TO CALL `done` IF IT IS A SINGLE ACTION
            if (i > 0 && actionName === 'done') {
                const msg = `Done action is allowed only as a single action - stopped after action ${i} / ${actions.length}.`;
                this.logger.info(msg);
                break;
            }
            // ==================== Wait Between Actions ====================
            if (i > 0) {
                // Wait between actions
                const wait_time = this.browser_session?.browser_profile
                    ?.wait_between_actions || 0;
                if (wait_time > 0) {
                    await this._sleep(wait_time, signal);
                }
            }
            // ==================== Execute Action ====================
            try {
                this._throwIfAborted(signal);
                await this._raise_if_stopped_or_paused();
                const preActionPage = await this.browser_session.get_current_page?.();
                const preActionUrl = typeof preActionPage?.url === 'function' ? preActionPage.url() : '';
                const preActionFocusTargetId = this.browser_session.agent_focus_target_id ??
                    this.browser_session.active_tab?.page_id ??
                    null;
                const actResult = await this.controller.registry.execute_action(actionName, actionParams, {
                    browser_session: this.browser_session,
                    page_extraction_llm: this.settings.page_extraction_llm,
                    extraction_schema: this.extraction_schema,
                    sensitive_data: this.sensitive_data,
                    available_file_paths: this.available_file_paths,
                    file_system: this.file_system,
                    context: this.context ?? undefined,
                    signal,
                });
                results.push(actResult);
                // Log action execution
                this.logger.info(`☑️ Executed action ${i + 1}/${actions.length}: ${actionName}(${JSON.stringify(actionParams)})`);
                // Break early if done, error, or last action
                if (results[results.length - 1]?.is_done ||
                    results[results.length - 1]?.error ||
                    i === actions.length - 1) {
                    this._capture_shared_pinned_tab();
                    break;
                }
                const registeredAction = this.controller.registry.get_action?.(actionName);
                const terminatesSequence = Boolean(registeredAction?.terminates_sequence);
                if (terminatesSequence) {
                    this.logger.info(`Action "${actionName}" terminates sequence - skipping ${actions.length - i - 1} remaining action(s)`);
                    this._capture_shared_pinned_tab();
                    break;
                }
                const postActionPage = await this.browser_session.get_current_page?.();
                const postActionUrl = typeof postActionPage?.url === 'function' ? postActionPage.url() : '';
                const postActionFocusTargetId = this.browser_session.agent_focus_target_id ??
                    this.browser_session.active_tab?.page_id ??
                    null;
                if (postActionUrl !== preActionUrl ||
                    postActionFocusTargetId !== preActionFocusTargetId) {
                    this.logger.info(`Page changed after "${actionName}" - skipping ${actions.length - i - 1} remaining action(s)`);
                    this._capture_shared_pinned_tab();
                    break;
                }
                this._capture_shared_pinned_tab();
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                this.logger.error(`❌ Action ${i + 1} failed: ${message}`);
                this._capture_shared_pinned_tab();
                throw error;
            }
        }
        return results;
    }
    async _generate_rerun_summary(originalTask, results, summaryLlm = null, signal = null) {
        if (!this.browser_session) {
            return new ActionResult({
                is_done: true,
                success: false,
                extracted_content: 'Rerun completed without an active browser session.',
                long_term_memory: 'Rerun completed without an active browser session.',
            });
        }
        let screenshotB64 = null;
        try {
            screenshotB64 = await this.browser_session.take_screenshot(false);
        }
        catch (error) {
            this.logger.warning(`Failed to capture screenshot for rerun summary: ${error instanceof Error ? error.message : String(error)}`);
        }
        const errorCount = results.filter((result) => Boolean(result.error)).length;
        const successCount = results.length - errorCount;
        const prompt = get_rerun_summary_prompt(originalTask, results.length, successCount, errorCount);
        const message = get_rerun_summary_message(prompt, screenshotB64);
        const llm = summaryLlm ?? this.llm;
        const parser = {
            parse: (input) => z
                .object({
                summary: z.string(),
                success: z.boolean(),
                completion_status: z.enum(['complete', 'partial', 'failed']),
            })
                .parse(JSON.parse(input)),
        };
        try {
            const response = await llm.ainvoke([message], parser, {
                signal: signal ?? undefined,
            });
            const summary = response.completion;
            if (!summary ||
                typeof summary !== 'object' ||
                typeof summary.summary !== 'string' ||
                typeof summary.success !== 'boolean' ||
                !['complete', 'partial', 'failed'].includes(String(summary.completion_status))) {
                throw new Error('Structured rerun summary response did not match expected schema');
            }
            this.logger.info(`Rerun Summary: ${summary.summary}`);
            this.logger.info(`Rerun Status: ${summary.completion_status} (success=${summary.success})`);
            return new ActionResult({
                is_done: true,
                success: summary.success,
                extracted_content: summary.summary,
                long_term_memory: `Rerun completed with status: ${summary.completion_status}. ${summary.summary.slice(0, 100)}`,
            });
        }
        catch (structuredError) {
            this.logger.debug(`Structured rerun summary failed: ${structuredError instanceof Error
                ? structuredError.message
                : String(structuredError)}, falling back to text response`);
        }
        try {
            const response = await llm.ainvoke([message], undefined, {
                signal: signal ?? undefined,
            });
            const summaryText = typeof response.completion === 'string'
                ? response.completion
                : JSON.stringify(response.completion);
            const completionStatus = errorCount === 0 ? 'complete' : successCount > 0 ? 'partial' : 'failed';
            return new ActionResult({
                is_done: true,
                success: errorCount === 0,
                extracted_content: summaryText,
                long_term_memory: `Rerun completed with status: ${completionStatus}. ${summaryText.slice(0, 100)}`,
            });
        }
        catch (error) {
            this.logger.warning(`Failed to generate rerun summary: ${error instanceof Error ? error.message : String(error)}`);
            return new ActionResult({
                is_done: true,
                success: errorCount === 0,
                extracted_content: `Rerun completed: ${successCount}/${results.length} steps succeeded`,
                long_term_memory: `Rerun completed: ${successCount} steps succeeded, ${errorCount} errors`,
            });
        }
    }
    async _execute_ai_step(query, includeScreenshot = false, extractLinks = false, aiStepLlm = null, signal = null) {
        if (!this.browser_session) {
            return new ActionResult({
                error: 'AI step failed: BrowserSession missing',
            });
        }
        const llm = aiStepLlm ?? this.llm;
        let content;
        let statsSummary;
        let currentUrl = '';
        try {
            const page = await this.browser_session.get_current_page?.();
            if (!page || typeof page.content !== 'function') {
                throw new Error('No page available for markdown extraction');
            }
            if (typeof page.url === 'function') {
                currentUrl = page.url();
            }
            const html = (await page.content()) || '';
            const extracted = extractCleanMarkdownFromHtml(html, {
                extract_links: extractLinks,
            });
            content = extracted.content;
            const contentStats = extracted.stats;
            statsSummary = `Content processed: ${contentStats.original_html_chars.toLocaleString()} HTML chars -> ${contentStats.initial_markdown_chars.toLocaleString()} initial markdown -> ${contentStats.final_filtered_chars.toLocaleString()} filtered markdown`;
            if (contentStats.filtered_chars_removed > 0) {
                statsSummary += ` (filtered ${contentStats.filtered_chars_removed.toLocaleString()} chars of noise)`;
            }
        }
        catch (error) {
            const name = error instanceof Error ? error.name : 'Error';
            const message = error instanceof Error ? error.message : String(error);
            return new ActionResult({
                error: `Could not extract clean markdown: ${name}: ${message}`,
            });
        }
        const safeContent = sanitize_surrogates(content);
        const safeQuery = sanitize_surrogates(query);
        const systemPrompt = get_ai_step_system_prompt();
        const userPrompt = get_ai_step_user_prompt(safeQuery, statsSummary, safeContent);
        let screenshotB64 = null;
        if (includeScreenshot) {
            try {
                screenshotB64 =
                    (await this.browser_session.take_screenshot?.(false)) ?? null;
            }
            catch (error) {
                this.logger.warning(`Failed to capture screenshot for ai_step: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        const userMessage = screenshotB64
            ? get_rerun_summary_message(userPrompt, screenshotB64)
            : new UserMessage(userPrompt);
        try {
            const response = await llm.ainvoke([new SystemMessage(systemPrompt), userMessage], undefined, { signal: signal ?? undefined });
            const completion = typeof response.completion === 'string'
                ? response.completion
                : JSON.stringify(response.completion);
            const extractedContent = `<url>\n${currentUrl}\n</url>\n<query>\n${safeQuery}\n</query>\n<result>\n${completion}\n</result>`;
            const maxMemoryLength = 1000;
            if (extractedContent.length < maxMemoryLength) {
                return new ActionResult({
                    extracted_content: extractedContent,
                    include_extracted_content_only_once: false,
                    long_term_memory: extractedContent,
                });
            }
            if (!this.file_system) {
                return new ActionResult({
                    extracted_content: extractedContent,
                    include_extracted_content_only_once: false,
                    long_term_memory: extractedContent.slice(0, maxMemoryLength),
                });
            }
            const fileName = await this.file_system.save_extracted_content(extractedContent);
            return new ActionResult({
                extracted_content: extractedContent,
                include_extracted_content_only_once: true,
                long_term_memory: `Query: ${query}\nContent in ${fileName} and once in <read_state>.`,
            });
        }
        catch (error) {
            this.logger.warning(`Failed to execute AI step: ${error instanceof Error ? error.message : String(error)}`);
            return new ActionResult({
                error: `AI step failed: ${error instanceof Error ? error.message : String(error)}`,
            });
        }
    }
    async rerun_history(history, options = {}) {
        const { max_retries = 3, skip_failures = false, delay_between_actions = 2, max_step_interval = 45, wait_for_elements = false, summary_llm = null, ai_step_llm = null, signal = null, } = options;
        this._throwIfAborted(signal);
        // Mirror python c011 behavior: rerun should not emit create-session events.
        this.state.session_initialized = true;
        const results = [];
        let previousItem = null;
        let previousStepSucceeded = false;
        try {
            await this.browser_session?.start();
            for (let index = 0; index < history.history.length; index++) {
                this._throwIfAborted(signal);
                const historyItem = history.history[index];
                const goal = historyItem.model_output?.current_state?.next_goal ?? '';
                const stepNumber = historyItem.metadata?.step_number ?? index;
                const stepName = stepNumber === 0 ? 'Initial actions' : `Step ${stepNumber}`;
                const savedInterval = historyItem.metadata?.step_interval;
                let stepDelay = delay_between_actions;
                let delaySource = `using default delay=${this._formatDelaySeconds(stepDelay)}`;
                if (typeof savedInterval === 'number' &&
                    Number.isFinite(savedInterval)) {
                    stepDelay = Math.min(savedInterval, max_step_interval);
                    if (savedInterval > max_step_interval) {
                        delaySource = `capped to ${this._formatDelaySeconds(stepDelay)} (saved was ${savedInterval.toFixed(1)}s)`;
                    }
                    else {
                        delaySource = `using saved step_interval=${this._formatDelaySeconds(stepDelay)}`;
                    }
                }
                this.logger.info(`Replaying ${stepName} (${index + 1}/${history.history.length}) [${delaySource}]: ${goal}`);
                const actions = historyItem.model_output?.action ?? [];
                const hasValidAction = actions.length && !actions.every((action) => action == null);
                if (!historyItem.model_output || !hasValidAction) {
                    this.logger.warning(`${stepName}: No action to replay, skipping`);
                    results.push(new ActionResult({ error: 'No action to replay' }));
                    continue;
                }
                const originalErrors = Array.isArray(historyItem.result)
                    ? historyItem.result
                        .map((result) => result?.error)
                        .filter((error) => typeof error === 'string')
                    : [];
                if (originalErrors.length && skip_failures) {
                    const firstError = originalErrors[0] ?? 'unknown';
                    const preview = firstError.length > 100
                        ? `${firstError.slice(0, 100)}...`
                        : firstError;
                    this.logger.warning(`${stepName}: Original step had error(s), skipping (skip_failures=true): ${preview}`);
                    results.push(new ActionResult({
                        error: `Skipped - original step had error: ${preview}`,
                    }));
                    continue;
                }
                if (this._is_redundant_retry_step(historyItem, previousItem, previousStepSucceeded)) {
                    this.logger.info(`${stepName}: Skipping redundant retry (previous step already succeeded with same element)`);
                    results.push(new ActionResult({
                        extracted_content: 'Skipped - redundant retry of previous step',
                        include_in_memory: false,
                    }));
                    continue;
                }
                let attempt = 0;
                let stepSucceeded = false;
                let menuReopened = false;
                while (attempt < max_retries) {
                    this._throwIfAborted(signal);
                    try {
                        const stepResult = ai_step_llm != null
                            ? await this._execute_history_step(historyItem, stepDelay, signal, wait_for_elements, ai_step_llm)
                            : await this._execute_history_step(historyItem, stepDelay, signal, wait_for_elements);
                        results.push(...stepResult);
                        stepSucceeded = true;
                        break;
                    }
                    catch (error) {
                        const errorMessage = error instanceof Error ? error.message : String(error);
                        if (signal?.aborted ||
                            (error instanceof Error && error.name === 'AbortError')) {
                            throw this._createAbortError();
                        }
                        attempt += 1;
                        if (!menuReopened &&
                            errorMessage.includes('Could not find matching element') &&
                            previousItem &&
                            this._is_menu_opener_step(previousItem)) {
                            const currentElement = this._coerceHistoryElement(historyItem.state?.interacted_element?.[0]);
                            if (this._is_menu_item_element(currentElement)) {
                                this.logger.info('Dropdown may have closed. Attempting to re-open by re-executing previous step...');
                                const reopened = await this._reexecute_menu_opener(previousItem, signal, ai_step_llm);
                                if (reopened) {
                                    menuReopened = true;
                                    attempt -= 1;
                                    stepDelay = 0.5;
                                    this.logger.info('Dropdown re-opened, retrying element match...');
                                    continue;
                                }
                            }
                        }
                        if (attempt === max_retries) {
                            const message = `${stepName} failed after ${max_retries} attempts: ${errorMessage}`;
                            this.logger.error(message);
                            const failure = new ActionResult({ error: message });
                            results.push(failure);
                            if (!skip_failures) {
                                throw new Error(message, { cause: error });
                            }
                        }
                        else {
                            const retryDelay = Math.min(5 * 2 ** Math.max(attempt - 1, 0), 30);
                            this.logger.warning(`${stepName} failed (attempt ${attempt}/${max_retries}), retrying in ${retryDelay}s...`);
                            await this._sleep(retryDelay, signal);
                        }
                    }
                }
                previousItem = historyItem;
                previousStepSucceeded = stepSucceeded;
            }
            const summaryResult = await this._generate_rerun_summary(this.task, results, summary_llm, signal);
            results.push(summaryResult);
            return results;
        }
        finally {
            await this.close();
        }
    }
    async _execute_history_step(historyItem, delaySeconds, signal = null, wait_for_elements = false, ai_step_llm = null) {
        this._throwIfAborted(signal);
        if (!this.browser_session) {
            throw new Error('BrowserSession is not set up');
        }
        await this._sleep(delaySeconds, signal);
        const interactedElements = historyItem.state?.interacted_element ?? [];
        let browser_state_summary = null;
        if (wait_for_elements) {
            const needsElementMatching = this._historyStepNeedsElementMatching(historyItem, interactedElements);
            if (needsElementMatching) {
                const minElements = this._countExpectedElementsFromHistory(historyItem);
                if (minElements > 0) {
                    browser_state_summary = await this._waitForMinimumElements(minElements, 15, 1, signal);
                }
            }
        }
        if (!browser_state_summary) {
            browser_state_summary =
                await this.browser_session.get_browser_state_with_recovery?.({
                    cache_clickable_elements_hashes: false,
                    include_screenshot: false,
                    signal,
                });
        }
        if (!browser_state_summary || !historyItem.model_output) {
            throw new Error('Invalid browser state or model output');
        }
        const results = [];
        const pendingActions = [];
        for (let actionIndex = 0; actionIndex < historyItem.model_output.action.length; actionIndex++) {
            this._throwIfAborted(signal);
            const originalAction = historyItem.model_output.action[actionIndex];
            if (!originalAction) {
                continue;
            }
            const actionPayload = typeof originalAction?.model_dump === 'function'
                ? originalAction.model_dump({ exclude_unset: true })
                : originalAction;
            const actionName = Object.keys(actionPayload ?? {})[0] ?? null;
            if (actionName &&
                ['extract', 'extract_structured_data', 'extract_content'].includes(actionName)) {
                if (pendingActions.length > 0) {
                    this._throwIfAborted(signal);
                    const batchActions = [...pendingActions];
                    pendingActions.length = 0;
                    const batchResults = await this.multi_act(batchActions, { signal });
                    results.push(...batchResults);
                }
                const params = actionPayload[actionName] ?? {};
                const query = typeof params.query === 'string' ? params.query : '';
                const extractLinks = Boolean(params.extract_links);
                this.logger.info(`Using AI step for extract action: ${query.slice(0, 50)}...`);
                const aiResult = await this._execute_ai_step(query, false, extractLinks, ai_step_llm, signal);
                results.push(aiResult);
                continue;
            }
            const updatedAction = await this._update_action_indices(this._coerceHistoryElement(interactedElements[actionIndex]), originalAction, browser_state_summary);
            if (!updatedAction) {
                const historicalElement = this._coerceHistoryElement(interactedElements[actionIndex]);
                const selectorCount = Object.keys(browser_state_summary.selector_map ?? {}).length;
                throw new Error(`Could not find matching element for action ${actionIndex} in current page.\n` +
                    `  Looking for: ${this._formatHistoryElementForError(historicalElement)}\n` +
                    `  Page has ${selectorCount} interactive elements.\n` +
                    '  Tried: EXACT hash → STABLE hash → XPATH → AX_NAME → ATTRIBUTE matching');
            }
            if (typeof updatedAction?.model_dump === 'function') {
                pendingActions.push(updatedAction.model_dump({ exclude_unset: true }));
            }
            else {
                pendingActions.push(updatedAction);
            }
        }
        if (pendingActions.length > 0) {
            this._throwIfAborted(signal);
            const batchActions = [...pendingActions];
            pendingActions.length = 0;
            const batchResults = await this.multi_act(batchActions, { signal });
            results.push(...batchResults);
        }
        return results;
    }
    _historyStepNeedsElementMatching(historyItem, interactedElements) {
        const actions = historyItem.model_output?.action ?? [];
        for (let index = 0; index < actions.length; index++) {
            const action = actions[index];
            if (!action) {
                continue;
            }
            const payload = typeof action.model_dump === 'function'
                ? action.model_dump({ exclude_unset: true })
                : action;
            const actionName = Object.keys(payload ?? {})[0] ?? null;
            if (!actionName) {
                continue;
            }
            if ([
                'click',
                'input',
                'input_text',
                'hover',
                'select_option',
                'select_dropdown_option',
                'drag_and_drop',
            ].includes(actionName)) {
                const historicalElement = this._coerceHistoryElement(interactedElements[index] ?? null);
                if (historicalElement) {
                    return true;
                }
            }
        }
        return false;
    }
    _countExpectedElementsFromHistory(historyItem) {
        if (!historyItem.model_output?.action?.length) {
            return 0;
        }
        let maxIndex = -1;
        for (const action of historyItem.model_output.action) {
            const index = this._extractActionIndex(action);
            if (index != null) {
                maxIndex = Math.max(maxIndex, index);
            }
        }
        if (maxIndex < 0) {
            return 0;
        }
        return Math.min(maxIndex + 1, 50);
    }
    async _waitForMinimumElements(minElements, timeoutSeconds = 30, pollIntervalSeconds = 1, signal = null) {
        if (!this.browser_session) {
            return null;
        }
        const start = Date.now();
        let lastCount = 0;
        let lastState = null;
        while ((Date.now() - start) / 1000 < timeoutSeconds) {
            this._throwIfAborted(signal);
            const state = await this.browser_session.get_browser_state_with_recovery?.({
                cache_clickable_elements_hashes: false,
                include_screenshot: false,
                signal,
            });
            lastState = state ?? null;
            const currentCount = Object.keys(state?.selector_map ?? {}).length;
            if (currentCount >= minElements) {
                this.logger.debug(`Page has ${currentCount} interactive elements (needed ${minElements}), proceeding`);
                return state;
            }
            if (currentCount !== lastCount) {
                const remaining = Math.max(0, timeoutSeconds - (Date.now() - start) / 1000);
                this.logger.debug(`Waiting for elements: ${currentCount}/${minElements} (timeout in ${remaining.toFixed(1)}s)`);
                lastCount = currentCount;
            }
            await this._sleep(pollIntervalSeconds, signal);
        }
        this.logger.warning(`Timeout waiting for ${minElements} elements, proceeding with ${lastCount} elements`);
        return lastState;
    }
    _extractActionIndex(action) {
        if (action && typeof action.get_index === 'function') {
            const index = action.get_index();
            if (typeof index === 'number' && Number.isFinite(index)) {
                return index;
            }
        }
        if (!action || typeof action !== 'object') {
            return null;
        }
        const modelDump = typeof action.model_dump === 'function'
            ? action.model_dump()
            : action;
        if (!modelDump ||
            typeof modelDump !== 'object' ||
            Array.isArray(modelDump)) {
            return null;
        }
        const actionName = Object.keys(modelDump)[0];
        if (!actionName) {
            return null;
        }
        const params = modelDump[actionName];
        const index = params?.index;
        return typeof index === 'number' && Number.isFinite(index) ? index : null;
    }
    _extractActionType(action) {
        if (!action || typeof action !== 'object') {
            return null;
        }
        const modelDump = typeof action.model_dump === 'function'
            ? action.model_dump()
            : action;
        if (!modelDump ||
            typeof modelDump !== 'object' ||
            Array.isArray(modelDump)) {
            return null;
        }
        const actionName = Object.keys(modelDump)[0];
        return actionName ?? null;
    }
    _sameHistoryElement(current, previous) {
        if (!current || !previous) {
            return false;
        }
        if (current.element_hash &&
            previous.element_hash &&
            current.element_hash === previous.element_hash) {
            return true;
        }
        if (current.stable_hash &&
            previous.stable_hash &&
            current.stable_hash === previous.stable_hash) {
            return true;
        }
        if (current.xpath && previous.xpath && current.xpath === previous.xpath) {
            return true;
        }
        if (current.tag_name &&
            previous.tag_name &&
            current.tag_name === previous.tag_name) {
            for (const key of ['name', 'id', 'aria-label']) {
                const currentValue = current.attributes?.[key];
                const previousValue = previous.attributes?.[key];
                if (currentValue &&
                    previousValue &&
                    String(currentValue) === String(previousValue)) {
                    return true;
                }
            }
        }
        return false;
    }
    _is_redundant_retry_step(currentItem, previousItem, previousStepSucceeded) {
        if (!previousItem || !previousStepSucceeded) {
            return false;
        }
        const currentActions = currentItem.model_output?.action ?? [];
        const previousActions = previousItem.model_output?.action ?? [];
        if (!currentActions.length || !previousActions.length) {
            return false;
        }
        const currentActionType = this._extractActionType(currentActions[0]);
        const previousActionType = this._extractActionType(previousActions[0]);
        if (!currentActionType || currentActionType !== previousActionType) {
            return false;
        }
        const currentElement = this._coerceHistoryElement(currentItem.state?.interacted_element?.[0]);
        const previousElement = this._coerceHistoryElement(previousItem.state?.interacted_element?.[0]);
        if (!this._sameHistoryElement(currentElement, previousElement)) {
            return false;
        }
        this.logger.debug(`Detected redundant retry on same element with action "${currentActionType}"`);
        return true;
    }
    _is_menu_opener_step(historyItem) {
        const element = this._coerceHistoryElement(historyItem?.state?.interacted_element?.[0]);
        if (!element) {
            return false;
        }
        const attrs = element.attributes ?? {};
        if (['true', 'menu', 'listbox'].includes(String(attrs['aria-haspopup']))) {
            return true;
        }
        if (attrs['data-gw-click'] === 'toggleSubMenu') {
            return true;
        }
        if (String(attrs.class ?? '').includes('expand-button')) {
            return true;
        }
        if (attrs.role === 'menuitem' &&
            ['false', 'true'].includes(String(attrs['aria-expanded']))) {
            return true;
        }
        if (attrs.role === 'button' &&
            ['false', 'true'].includes(String(attrs['aria-expanded']))) {
            return true;
        }
        return false;
    }
    _is_menu_item_element(element) {
        if (!element) {
            return false;
        }
        const attrs = element.attributes ?? {};
        const role = String(attrs.role ?? '');
        if ([
            'menuitem',
            'option',
            'menuitemcheckbox',
            'menuitemradio',
            'treeitem',
        ].includes(role)) {
            return true;
        }
        const className = String(attrs.class ?? '');
        if (className.includes('gw-action--inner')) {
            return true;
        }
        if (className.toLowerCase().includes('menuitem')) {
            return true;
        }
        if (element.ax_name && element.ax_name.trim()) {
            const lowered = className.toLowerCase();
            if (['dropdown', 'popup', 'menu', 'submenu', 'action'].some((needle) => lowered.includes(needle))) {
                return true;
            }
        }
        return false;
    }
    async _reexecute_menu_opener(openerItem, signal = null, aiStepLlm = null) {
        try {
            this.logger.info('Re-opening dropdown/menu by re-executing previous step...');
            await this._execute_history_step(openerItem, 0.5, signal, false, aiStepLlm);
            await this._sleep(0.3, signal);
            return true;
        }
        catch (error) {
            this.logger.warning(`Failed to re-open dropdown: ${error instanceof Error ? error.message : String(error)}`);
            return false;
        }
    }
    _formatHistoryElementForError(element) {
        if (!element) {
            return '<no element recorded>';
        }
        const parts = [`<${element.tag_name || 'unknown'}>`];
        for (const key of ['name', 'id', 'aria-label', 'type']) {
            const value = element.attributes?.[key];
            if (typeof value === 'string' && value.trim()) {
                parts.push(`${key}="${value}"`);
            }
        }
        if (element.xpath) {
            const xpath = element.xpath.length > 60
                ? `...${element.xpath.slice(-57)}`
                : element.xpath;
            parts.push(`xpath="${xpath}"`);
        }
        if (element.element_hash) {
            parts.push(`hash=${element.element_hash}`);
        }
        if (element.stable_hash) {
            parts.push(`stable_hash=${element.stable_hash}`);
        }
        return parts.join(' ');
    }
    async _update_action_indices(historicalElement, action, browserStateSummary) {
        if (!historicalElement || !browserStateSummary?.selector_map) {
            return action;
        }
        const selectorMap = browserStateSummary.selector_map ?? {};
        if (!Object.keys(selectorMap).length) {
            return action;
        }
        let matchLevel = null;
        let currentNode = null;
        if (historicalElement.element_hash) {
            for (const node of Object.values(selectorMap)) {
                const nodeHash = HistoryTreeProcessor.compute_element_hash(node);
                if (nodeHash === historicalElement.element_hash) {
                    currentNode = node;
                    matchLevel = 'EXACT';
                    break;
                }
            }
        }
        if (!currentNode && historicalElement.stable_hash) {
            for (const node of Object.values(selectorMap)) {
                const stableHash = HistoryTreeProcessor.compute_stable_hash(node);
                if (stableHash === historicalElement.stable_hash) {
                    currentNode = node;
                    matchLevel = 'STABLE';
                    this.logger.info('Element matched at STABLE hash fallback');
                    break;
                }
            }
        }
        if (!currentNode && historicalElement.xpath) {
            for (const node of Object.values(selectorMap)) {
                if (node?.xpath === historicalElement.xpath) {
                    currentNode = node;
                    matchLevel = 'XPATH';
                    this.logger.info(`Element matched at XPATH fallback: ${historicalElement.xpath}`);
                    break;
                }
            }
        }
        if (!currentNode && historicalElement.ax_name) {
            const tagName = historicalElement.tag_name?.toLowerCase();
            const targetAxName = historicalElement.ax_name;
            for (const node of Object.values(selectorMap)) {
                const nodeAxName = HistoryTreeProcessor.get_accessible_name(node);
                if (node?.tag_name?.toLowerCase() === tagName &&
                    typeof nodeAxName === 'string' &&
                    nodeAxName === targetAxName) {
                    currentNode = node;
                    matchLevel = 'AX_NAME';
                    this.logger.info(`Element matched at AX_NAME fallback: ${targetAxName}`);
                    break;
                }
            }
        }
        if (!currentNode && historicalElement.attributes) {
            const tagName = historicalElement.tag_name?.toLowerCase();
            for (const attrKey of ['name', 'id', 'aria-label']) {
                const attrValue = historicalElement.attributes[attrKey];
                if (!attrValue) {
                    continue;
                }
                for (const node of Object.values(selectorMap)) {
                    if (node?.tag_name?.toLowerCase() === tagName &&
                        node?.attributes?.[attrKey] === attrValue) {
                        currentNode = node;
                        matchLevel = 'ATTRIBUTE';
                        this.logger.info(`Element matched via ${attrKey} attribute fallback: ${attrValue}`);
                        break;
                    }
                }
                if (currentNode) {
                    break;
                }
            }
        }
        if (!currentNode || currentNode.highlight_index == null) {
            return null;
        }
        const currentIndex = typeof action?.get_index === 'function' ? action.get_index() : null;
        if (currentIndex !== currentNode.highlight_index &&
            typeof action?.set_index === 'function') {
            action.set_index(currentNode.highlight_index);
            this.logger.info(`Element moved in DOM, updated index from ${currentIndex} to ${currentNode.highlight_index} (matched at ${matchLevel ?? 'UNKNOWN'} level)`);
        }
        return action;
    }
    async load_and_rerun(history_file = null, options = {}) {
        const { variables = null, ...rerunOptions } = options;
        const target = history_file ?? 'AgentHistory.json';
        const history = AgentHistoryList.load_from_file(target, this.AgentOutput);
        const substitutedHistory = variables
            ? this._substitute_variables_in_history(history, variables)
            : history;
        return this.rerun_history(substitutedHistory, rerunOptions);
    }
    detect_variables() {
        return detect_variables_in_history(this.history);
    }
    save_history(file_path = null) {
        const target = file_path ?? 'AgentHistory.json';
        this.history.save_to_file(target, this.sensitive_data ?? null);
    }
    _coerceHistoryElement(element) {
        if (!element) {
            return null;
        }
        if (element instanceof DOMHistoryElement) {
            return element;
        }
        const payload = element;
        return new DOMHistoryElement(payload.tag_name ?? '', payload.xpath ?? '', payload.highlight_index ?? null, payload.entire_parent_branch_path ?? [], payload.attributes ?? {}, payload.shadow_root ?? false, payload.css_selector ?? null, payload.page_coordinates ?? null, payload.viewport_coordinates ?? null, payload.viewport_info ?? null, payload.element_hash != null ? String(payload.element_hash) : null, payload.stable_hash != null ? String(payload.stable_hash) : null, payload.ax_name != null ? String(payload.ax_name) : null);
    }
    _substitute_variables_in_history(history, variables) {
        const detectedVars = detect_variables_in_history(history);
        const valueReplacements = {};
        for (const [varName, newValue] of Object.entries(variables)) {
            const detected = detectedVars[varName];
            if (!detected) {
                this.logger.warning(`Variable "${varName}" not found in history, skipping substitution`);
                continue;
            }
            valueReplacements[detected.original_value] = newValue;
        }
        if (!Object.keys(valueReplacements).length) {
            this.logger.info('No variables to substitute');
            return history;
        }
        const clonedHistory = this._clone_history_for_substitution(history);
        let substitutionCount = 0;
        for (const historyItem of clonedHistory.history) {
            if (!historyItem.model_output?.action?.length) {
                continue;
            }
            for (let actionIndex = 0; actionIndex < historyItem.model_output.action.length; actionIndex += 1) {
                const action = historyItem.model_output.action[actionIndex];
                const actionPayload = typeof action.model_dump === 'function'
                    ? action.model_dump()
                    : action;
                if (!actionPayload ||
                    typeof actionPayload !== 'object' ||
                    Array.isArray(actionPayload)) {
                    continue;
                }
                substitutionCount += substitute_in_dict(actionPayload, valueReplacements);
                const ActionCtor = action?.constructor;
                if (typeof ActionCtor === 'function') {
                    historyItem.model_output.action[actionIndex] = new ActionCtor(actionPayload);
                }
                else {
                    historyItem.model_output.action[actionIndex] = actionPayload;
                }
            }
        }
        this.logger.info(`Substituted ${substitutionCount} value(s) in ${Object.keys(valueReplacements).length} variable type(s) in history`);
        return clonedHistory;
    }
    _clone_history_for_substitution(history) {
        const payload = history.toJSON();
        const historyItems = (payload.history ?? []).map((entry) => {
            const modelOutput = entry.model_output
                ? this.AgentOutput.fromJSON(entry.model_output)
                : null;
            const result = (entry.result ?? []).map((item) => new ActionResult(item));
            const interacted = Array.isArray(entry.state?.interacted_element)
                ? entry.state.interacted_element.map((element) => this._coerceHistoryElement(element))
                : [];
            const state = new BrowserStateHistory(entry.state?.url ?? '', entry.state?.title ?? '', entry.state?.tabs ?? [], interacted, entry.state?.screenshot_path ?? null);
            const metadata = entry.metadata
                ? new StepMetadata(entry.metadata.step_start_time, entry.metadata.step_end_time, entry.metadata.step_number, entry.metadata.step_interval ?? null)
                : null;
            return new AgentHistory(modelOutput, result, state, metadata, entry.state_message ?? null);
        });
        return new AgentHistoryList(historyItems, history.usage ?? null);
    }
    _createAbortError() {
        const error = new Error('Operation aborted');
        error.name = 'AbortError';
        return error;
    }
    _throwIfAborted(signal = null) {
        if (signal?.aborted) {
            throw this._createAbortError();
        }
    }
    _relayAbortSignal(signal, controller) {
        if (!signal) {
            return () => { };
        }
        if (signal.aborted) {
            controller.abort(signal.reason);
            return () => { };
        }
        const handleAbort = () => controller.abort(signal.reason);
        signal.addEventListener('abort', handleAbort, { once: true });
        return () => signal.removeEventListener('abort', handleAbort);
    }
    _formatDelaySeconds(delaySeconds) {
        if (delaySeconds < 1) {
            return `${Math.round(delaySeconds * 1000)}ms`;
        }
        return `${delaySeconds.toFixed(1)}s`;
    }
    async _sleep(seconds, signal = null) {
        if (seconds <= 0) {
            return;
        }
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                cleanup();
                resolve();
            }, seconds * 1000);
            const onAbort = () => {
                clearTimeout(timeout);
                cleanup();
                reject(this._createAbortError());
            };
            const cleanup = () => {
                signal?.removeEventListener('abort', onAbort);
            };
            if (signal) {
                if (signal.aborted) {
                    onAbort();
                    return;
                }
                signal.addEventListener('abort', onAbort, { once: true });
            }
        });
    }
    async wait_until_resumed() {
        if (!this.state.paused) {
            return;
        }
        if (!this._external_pause_event.resolve) {
            this._external_pause_event.promise = new Promise((resolve) => {
                this._external_pause_event.resolve = resolve;
            });
        }
        await this._external_pause_event.promise;
    }
    async log_completion() {
        this.logger.info('✅ Agent completed task');
    }
    pause() {
        if (this.state.paused) {
            return;
        }
        this.state.paused = true;
        this._external_pause_event.promise = new Promise((resolve) => {
            this._external_pause_event.resolve = resolve;
        });
    }
    resume() {
        if (!this.state.paused) {
            return;
        }
        this.state.paused = false;
        this._external_pause_event.resolve?.();
        this._external_pause_event.resolve = null;
        this._external_pause_event.promise = Promise.resolve();
    }
    stop() {
        this.state.stopped = true;
        this.resume();
    }
    async close() {
        if (this._closePromise) {
            await this._closePromise;
            return;
        }
        this._closePromise = (async () => {
            const browser_session = this.browser_session;
            try {
                if (browser_session) {
                    this._release_browser_session_claim(browser_session);
                    if (this._has_any_browser_session_attachments(browser_session)) {
                        this.logger.debug('Skipping BrowserSession shutdown because other attached Agents are still active.');
                    }
                    else {
                        this._cleanup_shared_session_step_lock_if_unused(browser_session);
                        if (typeof browser_session.stop === 'function') {
                            await browser_session.stop();
                        }
                        else if (typeof browser_session.close === 'function') {
                            await browser_session.close();
                        }
                    }
                }
            }
            catch (error) {
                this.logger.error(`Error during agent cleanup: ${error instanceof Error ? error.message : String(error)}`);
            }
            if (this.skill_service &&
                typeof this.skill_service.close === 'function') {
                try {
                    await this.skill_service.close();
                }
                catch (error) {
                    this.logger.error(`Error during skill service cleanup: ${error instanceof Error ? error.message : String(error)}`);
                }
            }
        })();
        await this._closePromise;
    }
    /**
     * Get the trace and trace_details objects for the agent
     * Contains comprehensive metadata about the agent run for debugging and analysis
     */
    get_trace_object() {
        // Helper to extract website from task text
        const extract_task_website = (task_text) => {
            const url_pattern = /https?:\/\/[^\s<>"']+|www\.[^\s<>"']+|[^\s<>"']+\.[a-z]{2,}(?:\/[^\s<>"']*)?/i;
            const match = task_text.match(url_pattern);
            return match ? match[0] : null;
        };
        // Helper to get complete history without screenshots
        const get_complete_history_without_screenshots = (history_data) => {
            if (history_data.history) {
                for (const item of history_data.history) {
                    if (item.state && item.state.screenshot) {
                        item.state.screenshot = null;
                    }
                }
            }
            return JSON.stringify(history_data);
        };
        // Generate autogenerated fields
        const trace_id = uuid7str();
        const timestamp = new Date().toISOString();
        // Collect data
        const structured_output = this.history.structured_output;
        const structured_output_json = structured_output
            ? JSON.stringify(structured_output)
            : null;
        const final_result = this.history.final_result();
        const action_history = this.history.action_history();
        const action_errors = this.history.errors();
        const urls = this.history.urls();
        const usage = this.history.usage;
        // Build trace object
        const trace = {
            // Autogenerated fields
            trace_id,
            timestamp,
            browser_use_version: this.version,
            git_info: null, // Can be enhanced if needed
            // Direct agent properties
            model: this.llm.model || 'unknown',
            settings: this.settings ? JSON.stringify(this.settings) : null,
            task_id: this.task_id,
            task_truncated: this.task.length > 20000 ? this.task.slice(0, 20000) : this.task,
            task_website: extract_task_website(this.task),
            // AgentHistoryList methods
            structured_output_truncated: structured_output_json && structured_output_json.length > 20000
                ? structured_output_json.slice(0, 20000)
                : structured_output_json,
            action_history_truncated: action_history
                ? JSON.stringify(action_history)
                : null,
            action_errors: action_errors ? JSON.stringify(action_errors) : null,
            urls: urls ? JSON.stringify(urls) : null,
            final_result_response_truncated: final_result && final_result.length > 20000
                ? final_result.slice(0, 20000)
                : final_result,
            self_report_completed: this.history.is_done() ? 1 : 0,
            self_report_success: this.history.is_successful() ? 1 : 0,
            duration: this.history.total_duration_seconds(),
            steps_taken: this.history.number_of_steps(),
            usage: usage ? JSON.stringify(usage) : null,
        };
        // Build trace_details object
        const trace_details = {
            // Autogenerated fields (ensure same as trace)
            trace_id,
            timestamp,
            // Direct agent properties
            task: this.task,
            // AgentHistoryList methods
            structured_output: structured_output_json,
            final_result_response: final_result,
            complete_history: get_complete_history_without_screenshots(this.history.model_dump?.() || {}),
        };
        return { trace, trace_details };
    }
    async _log_agent_run() {
        this.logger.info(`\x1b[34m🎯 Task: ${this.task}\x1b[0m`);
        this.logger.debug(`🤖 Browser-Use Library Version ${this.version} (${this.source})`);
        if (CONFIG.BROWSER_USE_VERSION_CHECK &&
            process.env.NODE_ENV !== 'test' &&
            !process.env.VITEST) {
            const latestVersion = await check_latest_browser_use_version();
            if (latestVersion && latestVersion !== this.version) {
                this.logger.info(`📦 Newer version available: ${latestVersion} (current: ${this.version}). Upgrade with: npm install browser-use@${latestVersion}`);
            }
        }
    }
    _createInterruptedError(message = '') {
        const interruptedError = new Error(message);
        interruptedError.name = 'InterruptedError';
        return interruptedError;
    }
    async _raise_if_stopped_or_paused() {
        if (this.register_should_stop_callback) {
            const shouldStop = await this.register_should_stop_callback();
            if (shouldStop) {
                this.logger.info('External callback requested stop');
                this.state.stopped = true;
                throw this._createInterruptedError();
            }
        }
        if (this.register_external_agent_status_raise_error_callback) {
            const shouldRaise = await this.register_external_agent_status_raise_error_callback();
            if (shouldRaise) {
                throw this._createInterruptedError();
            }
        }
        if (this.state.stopped) {
            throw this._createInterruptedError('Agent stopped');
        }
        if (this.state.paused) {
            throw this._createInterruptedError('Agent paused');
        }
    }
    async _handle_post_llm_processing(browser_state_summary, input_messages, _actions = []) {
        if (this.register_new_step_callback && this.state.last_model_output) {
            await this.register_new_step_callback(browser_state_summary, this.state.last_model_output, this.state.n_steps);
        }
        log_response(this.state.last_model_output, this.controller, this.logger);
        if (this.settings.save_conversation_path) {
            const dir = this.settings.save_conversation_path;
            const filepath = path.join(dir, `step_${this.state.n_steps}.json`);
            await fs.promises.mkdir(path.dirname(filepath), { recursive: true });
            await fs.promises.writeFile(filepath, JSON.stringify({
                messages: input_messages,
                response: this.state.last_model_output?.model_dump(),
            }, null, 2), this.settings.save_conversation_path_encoding);
        }
    }
    /** Handle all types of errors that can occur during a step (python c011 parity). */
    async _handle_step_error(error) {
        if (error?.name === 'InterruptedError') {
            const message = error.message
                ? `The agent was interrupted mid-step - ${error.message}`
                : 'The agent was interrupted mid-step';
            this.logger.warning(message);
            return;
        }
        const include_trace = this.logger.level === 'debug';
        const error_msg = AgentError.format_error(error, include_trace);
        const maxTotalFailures = this._max_total_failures();
        const prefix = `❌ Result failed ${this.state.consecutive_failures + 1}/${maxTotalFailures} times: `;
        this.state.consecutive_failures += 1;
        const isFinalFailure = this.state.consecutive_failures >= maxTotalFailures;
        const isParseError = error_msg.includes('Could not parse response') ||
            error_msg.includes('tool_use_failed');
        if (isParseError) {
            const parseLog = `Model: ${this.llm.model} failed`;
            if (isFinalFailure) {
                this.logger.error(parseLog);
            }
            else {
                this.logger.warning(parseLog);
            }
        }
        if (isFinalFailure) {
            this.logger.error(`${prefix}${error_msg}`);
        }
        else {
            this.logger.warning(`${prefix}${error_msg}`);
        }
        this.state.last_result = [new ActionResult({ error: error_msg })];
    }
    async _finalize(browser_state_summary) {
        const step_end_time = Date.now() / 1000;
        this._enforceDoneOnlyForCurrentStep = false;
        if (!this.state.last_result) {
            return;
        }
        if (browser_state_summary) {
            let stepInterval = null;
            if (this.history.history.length > 0) {
                const lastMetadata = this.history.history.at(-1)?.metadata;
                if (lastMetadata) {
                    stepInterval = Math.max(0, lastMetadata.step_end_time - lastMetadata.step_start_time);
                }
            }
            const metadata = new StepMetadata(this.step_start_time, step_end_time, this.state.n_steps, stepInterval);
            await this._make_history_item(this.state.last_model_output, browser_state_summary, this.state.last_result, metadata, this._message_manager.last_state_message_text);
        }
        this._log_step_completion_summary(this.step_start_time, this.state.last_result);
        this.save_file_system_state();
        if (browser_state_summary && this.state.last_model_output) {
            const actions_data = this.state.last_model_output.action.map((action) => typeof action?.model_dump === 'function'
                ? action.model_dump()
                : action);
            const step_event = CreateAgentStepEvent.fromAgentStep(this, this.state.last_model_output, this.state.last_result, actions_data, browser_state_summary);
            this.eventbus.dispatch(step_event);
        }
        this.state.n_steps += 1;
    }
    async _handle_final_step(step_info = null) {
        const isLastStep = Boolean(step_info && step_info.is_last_step());
        this._enforceDoneOnlyForCurrentStep = isLastStep;
        if (isLastStep) {
            const message = 'You reached max_steps - this is your last step. Your only tool available is the "done" tool. No other tool is available. All other tools which you see in history or examples are not available.\n' +
                'If the task is not yet fully finished as requested by the user, set success in "done" to false! E.g. if not all steps are fully completed. Else success to true.\n' +
                'Include everything you found out for the ultimate task in the done text.';
            this._message_manager._add_context_message(new UserMessage(message));
            this.logger.debug('Last step finishing up');
        }
    }
    _max_total_failures() {
        return (this.settings.max_failures +
            Number(this.settings.final_response_after_failure));
    }
    async _handle_failure_limit_recovery() {
        if (!this.settings.final_response_after_failure ||
            this.state.consecutive_failures < this.settings.max_failures) {
            return;
        }
        const message = `You failed ${this.settings.max_failures} times. Therefore we terminate the agent.\n` +
            'Your only tool available is the "done" tool. No other tool is available. All other tools which you see in history or examples are not available.\n' +
            'If the task is not yet fully finished as requested by the user, set success in "done" to false! E.g. if not all steps are fully completed. Else success to true.\n' +
            'Include everything you found out for the ultimate task in the done text.';
        this._message_manager._add_context_message(new UserMessage(message));
        this._enforceDoneOnlyForCurrentStep = true;
        this.logger.debug('Force done action, because we reached max_failures.');
    }
    _update_plan_from_model_output(modelOutput) {
        if (!this.settings.enable_planning) {
            return;
        }
        if (Array.isArray(modelOutput.plan_update)) {
            this.state.plan = modelOutput.plan_update.map((stepText) => new PlanItem({
                text: stepText,
                status: 'pending',
            }));
            this.state.current_plan_item_index = 0;
            this.state.plan_generation_step = this.state.n_steps;
            if (this.state.plan.length > 0) {
                this.state.plan[0].status = 'current';
            }
            this.logger.info(`📋 Plan updated with ${this.state.plan.length} steps`);
            return;
        }
        if (typeof modelOutput.current_plan_item !== 'number' ||
            !this.state.plan ||
            this.state.plan.length === 0) {
            return;
        }
        const oldIndex = this.state.current_plan_item_index;
        const newIndex = Math.max(0, Math.min(modelOutput.current_plan_item, this.state.plan.length - 1));
        for (let i = oldIndex; i < newIndex; i += 1) {
            if (this.state.plan[i] &&
                (this.state.plan[i].status === 'current' ||
                    this.state.plan[i].status === 'pending')) {
                this.state.plan[i].status = 'done';
            }
        }
        if (this.state.plan[newIndex]) {
            this.state.plan[newIndex].status = 'current';
        }
        this.state.current_plan_item_index = newIndex;
    }
    _render_plan_description() {
        if (!this.settings.enable_planning || !this.state.plan) {
            return null;
        }
        const markers = {
            done: '[x]',
            current: '[>]',
            pending: '[ ]',
            skipped: '[-]',
        };
        return this.state.plan
            .map((step, index) => `${markers[step.status] ?? '[ ]'} ${index}: ${step.text}`)
            .join('\n');
    }
    _inject_replan_nudge() {
        if (!this.settings.enable_planning || !this.state.plan) {
            return;
        }
        if (this.settings.planning_replan_on_stall <= 0) {
            return;
        }
        if (this.state.consecutive_failures < this.settings.planning_replan_on_stall) {
            return;
        }
        const message = 'REPLAN SUGGESTED: You have failed ' +
            `${this.state.consecutive_failures} consecutive times. ` +
            'Your current plan may need revision. ' +
            'Output a new `plan_update` with revised steps to recover.';
        this.logger.info(`📋 Replan nudge injected after ${this.state.consecutive_failures} consecutive failures`);
        this._message_manager._add_context_message(new UserMessage(message));
    }
    _inject_exploration_nudge() {
        if (!this.settings.enable_planning || this.state.plan) {
            return;
        }
        if (this.settings.planning_exploration_limit <= 0) {
            return;
        }
        if (this.state.n_steps < this.settings.planning_exploration_limit) {
            return;
        }
        const message = 'PLANNING NUDGE: You have taken ' +
            `${this.state.n_steps} steps without creating a plan. ` +
            'If the task is complex, output a `plan_update` with clear todo items now. ' +
            'If the task is already done or nearly done, call `done` instead.';
        this.logger.info(`📋 Exploration nudge injected after ${this.state.n_steps} steps without a plan`);
        this._message_manager._add_context_message(new UserMessage(message));
    }
    _inject_loop_detection_nudge() {
        if (!this.settings.loop_detection_enabled) {
            return;
        }
        const nudge = this.state.loop_detector.get_nudge_message();
        if (!nudge) {
            return;
        }
        this.logger.info(`🔁 Loop detection nudge injected (repetition=${this.state.loop_detector.max_repetition_count}, stagnation=${this.state.loop_detector.consecutive_stagnant_pages})`);
        this._message_manager._add_context_message(new UserMessage(nudge));
    }
    _update_loop_detector_actions() {
        if (!this.settings.loop_detection_enabled ||
            !this.state.last_model_output) {
            return;
        }
        const exemptActions = new Set(['wait', 'done', 'go_back']);
        for (const action of this.state.last_model_output.action) {
            const actionData = typeof action?.model_dump === 'function'
                ? action.model_dump()
                : action;
            if (!actionData || typeof actionData !== 'object') {
                continue;
            }
            const actionName = Object.keys(actionData)[0] ?? 'unknown';
            if (exemptActions.has(actionName)) {
                continue;
            }
            const rawParams = actionData[actionName];
            const params = rawParams && typeof rawParams === 'object' && !Array.isArray(rawParams)
                ? rawParams
                : {};
            this.state.loop_detector.record_action(actionName, params);
        }
    }
    _update_loop_detector_page_state(browser_state_summary) {
        if (!this.settings.loop_detection_enabled) {
            return;
        }
        const url = browser_state_summary.url ?? '';
        const elementCount = browser_state_summary.selector_map
            ? Object.keys(browser_state_summary.selector_map).length
            : 0;
        const domText = (() => {
            try {
                return (browser_state_summary.element_tree?.clickable_elements_to_string?.() ??
                    '');
            }
            catch {
                return '';
            }
        })();
        this.state.loop_detector.record_page_state(url, domText, elementCount);
    }
    _inject_budget_warning(step_info = null) {
        if (!step_info) {
            return;
        }
        const stepsUsed = step_info.step_number + 1;
        const budgetRatio = stepsUsed / step_info.max_steps;
        if (budgetRatio < 0.75 || step_info.is_last_step()) {
            return;
        }
        const stepsRemaining = step_info.max_steps - stepsUsed;
        const pct = Math.floor(budgetRatio * 100);
        const message = `BUDGET WARNING: You have used ${stepsUsed}/${step_info.max_steps} steps ` +
            `(${pct}%). ${stepsRemaining} steps remaining. ` +
            'If the task cannot be completed in the remaining steps, prioritize: ' +
            '(1) consolidate your results (save to files if the file system is in use), ' +
            '(2) call done with what you have. ' +
            'Partial results are far more valuable than exhausting all steps with nothing saved.';
        this.logger.info(`Step budget warning: ${stepsUsed}/${step_info.max_steps} (${pct}%)`);
        this._message_manager._add_context_message(new UserMessage(message));
    }
    async _run_simple_judge() {
        const lastHistoryItem = this.history.history[this.history.history.length - 1];
        if (!lastHistoryItem || !lastHistoryItem.result.length) {
            return;
        }
        const lastResult = lastHistoryItem.result[lastHistoryItem.result.length - 1];
        if (!lastResult.is_done || !lastResult.success) {
            return;
        }
        const messages = construct_simple_judge_messages({
            task: this.task,
            final_result: this.history.final_result() ?? '',
        });
        try {
            const response = await this.llm.ainvoke(messages, SimpleJudgeOutputFormat);
            const parsed = this._parseCompletionPayload(response.completion);
            if (typeof parsed?.is_correct !== 'boolean') {
                this.logger.debug('Simple judge response missing boolean is_correct; skipping override.');
                return;
            }
            const isCorrect = parsed.is_correct;
            const reason = typeof parsed?.reason === 'string' && parsed.reason.trim()
                ? parsed.reason.trim()
                : 'Task requirements not fully met';
            if (!isCorrect) {
                this.logger.info(`⚠️  Simple judge overriding success to failure: ${reason}`);
                lastResult.success = false;
                const note = `[Simple judge: ${reason}]`;
                if (lastResult.extracted_content) {
                    lastResult.extracted_content += `\n\n${note}`;
                }
                else {
                    lastResult.extracted_content = note;
                }
            }
        }
        catch (error) {
            this.logger.warning(`Simple judge failed with error: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async _judge_trace() {
        const messages = construct_judge_messages({
            task: this.task,
            final_result: this.history.final_result() ?? '',
            agent_steps: this.history.agent_steps(),
            screenshot_paths: this.history
                .screenshot_paths()
                .filter((value) => typeof value === 'string'),
            max_images: 10,
            ground_truth: this.settings.ground_truth,
            use_vision: this.settings.use_vision,
        });
        try {
            const invokeOptions = this.judge_llm?.provider === 'browser-use'
                ? { request_type: 'judge' }
                : undefined;
            const response = await this.judge_llm.ainvoke(messages, JudgeOutputFormat, invokeOptions);
            const parsed = this._parseCompletionPayload(response.completion);
            const validation = JudgeSchema.safeParse(parsed);
            if (!validation.success) {
                this.logger.warning('Judge trace response did not match expected schema; skipping judgement.');
                return null;
            }
            return validation.data;
        }
        catch (error) {
            this.logger.warning(`Judge trace failed: ${error instanceof Error ? error.message : String(error)}`);
            return null;
        }
    }
    async _judge_and_log() {
        const lastHistoryItem = this.history.history[this.history.history.length - 1];
        if (!lastHistoryItem || !lastHistoryItem.result.length) {
            return;
        }
        const lastResult = lastHistoryItem.result[lastHistoryItem.result.length - 1];
        if (!lastResult.is_done) {
            return;
        }
        const judgement = await this._judge_trace();
        lastResult.judgement = judgement;
        if (!judgement) {
            return;
        }
        if (lastResult.success === true && judgement.verdict === true) {
            return;
        }
        let judgeLog = '\n';
        if (lastResult.success === true && judgement.verdict === false) {
            judgeLog += '⚠️  Agent reported success but judge thinks task failed\n';
        }
        judgeLog += `⚖️  Judge Verdict: ${judgement.verdict ? 'PASS' : 'FAIL'}\n`;
        if (judgement.failure_reason) {
            judgeLog += `   Failure Reason: ${judgement.failure_reason}\n`;
        }
        if (judgement.reached_captcha) {
            judgeLog += '   Captcha Detected: Agent encountered captcha challenges\n';
            judgeLog +=
                '   Use Browser Use Cloud for stealth browser infra: https://docs.browser-use.com/customize/browser/remote\n';
        }
        if (judgement.reasoning) {
            judgeLog += `   ${judgement.reasoning}\n`;
        }
        this.logger.info(judgeLog);
    }
    _replace_urls_in_text(text) {
        const replacedUrls = {};
        const shortenedText = text.replace(URL_PATTERN, (originalUrl) => {
            const queryStart = originalUrl.indexOf('?');
            const fragmentStart = originalUrl.indexOf('#');
            let afterPathStart = originalUrl.length;
            if (queryStart !== -1) {
                afterPathStart = Math.min(afterPathStart, queryStart);
            }
            if (fragmentStart !== -1) {
                afterPathStart = Math.min(afterPathStart, fragmentStart);
            }
            const baseUrl = originalUrl.slice(0, afterPathStart);
            const afterPath = originalUrl.slice(afterPathStart);
            if (afterPath.length <= this._url_shortening_limit) {
                return originalUrl;
            }
            const truncatedAfterPath = afterPath.slice(0, this._url_shortening_limit);
            const shortHash = createHash('md5')
                .update(afterPath, 'utf8')
                .digest('hex')
                .slice(0, 7);
            const shortened = `${baseUrl}${truncatedAfterPath}...${shortHash}`;
            if (shortened.length >= originalUrl.length) {
                return originalUrl;
            }
            replacedUrls[shortened] = originalUrl;
            return shortened;
        });
        return [shortenedText, replacedUrls];
    }
    _process_messages_and_replace_long_urls_shorter_ones(inputMessages) {
        const urlsReplaced = {};
        for (const message of inputMessages) {
            if (!message || typeof message !== 'object') {
                continue;
            }
            const role = message.role;
            const isUserOrAssistant = message instanceof UserMessage ||
                message instanceof AssistantMessage ||
                role === 'user' ||
                role === 'assistant';
            if (!isUserOrAssistant) {
                continue;
            }
            if (typeof message.content === 'string') {
                const [updated, replaced] = this._replace_urls_in_text(message.content);
                message.content = updated;
                Object.assign(urlsReplaced, replaced);
                continue;
            }
            if (!Array.isArray(message.content)) {
                continue;
            }
            for (const part of message.content) {
                if (!part || typeof part !== 'object') {
                    continue;
                }
                const isTextPart = part instanceof ContentPartTextParam || part.type === 'text';
                if (!isTextPart || typeof part.text !== 'string') {
                    continue;
                }
                const [updated, replaced] = this._replace_urls_in_text(part.text);
                part.text = updated;
                Object.assign(urlsReplaced, replaced);
            }
        }
        return urlsReplaced;
    }
    _replace_shortened_urls_in_string(text, urlReplacements) {
        let result = text;
        for (const [shortenedUrl, originalUrl] of Object.entries(urlReplacements)) {
            result = result.split(shortenedUrl).join(originalUrl);
        }
        return result;
    }
    _replace_shortened_urls_in_value(value, urlReplacements) {
        if (typeof value === 'string') {
            return this._replace_shortened_urls_in_string(value, urlReplacements);
        }
        if (Array.isArray(value)) {
            for (let i = 0; i < value.length; i += 1) {
                value[i] = this._replace_shortened_urls_in_value(value[i], urlReplacements);
            }
            return value;
        }
        if (!value || typeof value !== 'object') {
            return value;
        }
        for (const [key, nested] of Object.entries(value)) {
            value[key] =
                this._replace_shortened_urls_in_value(nested, urlReplacements);
        }
        return value;
    }
    _parseCompletionPayload(rawCompletion) {
        let parsedCompletion = rawCompletion;
        if (typeof parsedCompletion === 'string') {
            let jsonText = this._removeThinkTags(parsedCompletion.trim());
            // Handle common markdown wrappers like ```json ... ```
            const fencedMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/i);
            if (fencedMatch && fencedMatch[1]) {
                jsonText = fencedMatch[1].trim();
            }
            // If extra text surrounds JSON, try to isolate the first JSON object
            const firstBrace = jsonText.indexOf('{');
            const lastBrace = jsonText.lastIndexOf('}');
            if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
                jsonText = jsonText.slice(firstBrace, lastBrace + 1);
            }
            try {
                parsedCompletion = JSON.parse(jsonText);
            }
            catch (error) {
                throw new Error(`Failed to parse LLM completion as JSON: ${String(error)}`, { cause: error });
            }
        }
        if (!parsedCompletion || typeof parsedCompletion !== 'object') {
            throw new Error('Model completion must be a JSON object');
        }
        return parsedCompletion;
    }
    _isModelActionMissing(actions) {
        if (actions.length === 0) {
            return true;
        }
        return actions.every((entry) => {
            const candidate = entry &&
                typeof entry === 'object' &&
                typeof entry.model_dump === 'function'
                ? entry.model_dump()
                : entry;
            if (!candidate ||
                typeof candidate !== 'object' ||
                Array.isArray(candidate)) {
                return false;
            }
            return Object.keys(candidate).length === 0;
        });
    }
    _getOutputActionNames(doneOnly) {
        const registryActions = this.controller.registry.get_all_actions();
        const modelForStep = doneOnly
            ? this.DoneActionModel
            : this.ActionModel;
        const modelAvailableNames = modelForStep?.available_actions;
        if (Array.isArray(modelAvailableNames) && modelAvailableNames.length > 0) {
            const deduped = Array.from(new Set(modelAvailableNames.filter((name) => typeof name === 'string' &&
                name.trim().length > 0 &&
                registryActions.has(name))));
            if (deduped.length > 0) {
                return deduped;
            }
        }
        if (doneOnly && registryActions.has('done')) {
            return ['done'];
        }
        return Array.from(registryActions.keys());
    }
    _toStrictActionParamSchema(schema) {
        if (schema instanceof z.ZodObject) {
            return schema.strict();
        }
        return schema;
    }
    _buildActionOutputSchema(doneOnly) {
        const registryActions = this.controller.registry.get_all_actions();
        const actionSchemas = this._getOutputActionNames(doneOnly)
            .map((actionName) => {
            const actionInfo = registryActions.get(actionName);
            if (!actionInfo) {
                return null;
            }
            const paramSchema = this._toStrictActionParamSchema(actionInfo.paramSchema);
            return z.object({ [actionName]: paramSchema }).strict();
        })
            .filter((schema) => schema != null);
        if (actionSchemas.length === 0) {
            const doneAction = registryActions.get('done');
            if (doneAction) {
                const doneParams = this._toStrictActionParamSchema(doneAction.paramSchema);
                return z.object({ done: doneParams }).strict();
            }
            return z.object({ done: z.object({}).strict() }).strict();
        }
        if (actionSchemas.length === 1) {
            return actionSchemas[0];
        }
        const [firstActionSchema, secondActionSchema, ...remainingActionSchemas] = actionSchemas;
        return z.union([
            firstActionSchema,
            secondActionSchema,
            ...remainingActionSchemas,
        ]);
    }
    _buildLlmOutputFormat(doneOnly) {
        const schema = z.object({
            thinking: z.string().optional().nullable(),
            evaluation_previous_goal: z.string().optional().nullable(),
            memory: z.string().optional().nullable(),
            next_goal: z.string().optional().nullable(),
            current_plan_item: z.number().int().optional().nullable(),
            plan_update: z.array(z.string()).optional().nullable(),
            action: z
                .array(this._buildActionOutputSchema(doneOnly))
                .optional()
                .nullable(),
        });
        const outputFormat = schema;
        outputFormat.schema = schema;
        return outputFormat;
    }
    async _get_model_output_with_retry(messages, signal = null) {
        const urlReplacements = this._process_messages_and_replace_long_urls_shorter_ones(messages);
        const invokeAndParse = async (inputMessages) => {
            this._throwIfAborted(signal);
            const outputFormat = this._buildLlmOutputFormat(this._enforceDoneOnlyForCurrentStep);
            const completion = await this.llm.ainvoke(inputMessages, outputFormat, {
                signal: signal ?? undefined,
                session_id: this.session_id,
            });
            this._throwIfAborted(signal);
            const parsed = this._parseCompletionPayload(completion.completion);
            if (Object.keys(urlReplacements).length) {
                this._replace_shortened_urls_in_value(parsed, urlReplacements);
            }
            return parsed;
        };
        const invokeAndParseWithFallback = async (inputMessages) => {
            try {
                return await invokeAndParse(inputMessages);
            }
            catch (error) {
                if ((error instanceof ModelRateLimitError ||
                    error instanceof ModelProviderError) &&
                    this._try_switch_to_fallback_llm(error)) {
                    this._throwIfAborted(signal);
                    return await invokeAndParse(inputMessages);
                }
                throw error;
            }
        };
        let parsed_completion = await invokeAndParseWithFallback(messages);
        let rawAction = Array.isArray(parsed_completion?.action)
            ? parsed_completion.action
            : [];
        this.logger.debug(`✅ Step ${this.state.n_steps}: Got LLM response with ${rawAction.length} actions`);
        if (this._isModelActionMissing(rawAction)) {
            this._throwIfAborted(signal);
            this.logger.warning('Model returned empty action. Retrying...');
            const clarificationMessage = new UserMessage('You forgot to return an action. Please respond with a valid JSON action according to the expected schema with your assessment and next actions.');
            parsed_completion = await invokeAndParseWithFallback([
                ...messages,
                clarificationMessage,
            ]);
            rawAction = Array.isArray(parsed_completion?.action)
                ? parsed_completion.action
                : [];
            if (this._isModelActionMissing(rawAction)) {
                this.logger.warning('Model still returned empty after retry. Inserting safe noop action.');
                rawAction = [
                    {
                        done: {
                            success: false,
                            text: 'No next action returned by LLM!',
                        },
                    },
                ];
            }
        }
        const action = this._validateAndNormalizeActions(rawAction);
        const toNullableString = (value) => typeof value === 'string' ? value : null;
        const toNullableNumber = (value) => typeof value === 'number' && Number.isFinite(value)
            ? Math.trunc(value)
            : null;
        const toNullablePlanUpdate = (value) => Array.isArray(value)
            ? value.filter((item) => typeof item === 'string')
            : null;
        const AgentOutputModel = this._enforceDoneOnlyForCurrentStep
            ? (this.DoneAgentOutput ?? this.AgentOutput ?? AgentOutput)
            : (this.AgentOutput ?? AgentOutput);
        return new AgentOutputModel({
            thinking: toNullableString(parsed_completion?.thinking),
            evaluation_previous_goal: toNullableString(parsed_completion?.evaluation_previous_goal),
            memory: toNullableString(parsed_completion?.memory),
            next_goal: toNullableString(parsed_completion?.next_goal),
            current_plan_item: toNullableNumber(parsed_completion?.current_plan_item),
            plan_update: toNullablePlanUpdate(parsed_completion?.plan_update),
            action,
        });
    }
    _try_switch_to_fallback_llm(error) {
        if (this._using_fallback_llm) {
            this.logger.warning(`⚠️ Fallback LLM also failed (${error.name}: ${error.message}), no more fallbacks available`);
            return false;
        }
        const retryableStatusCodes = new Set([401, 402, 429, 500, 502, 503, 504]);
        const statusCode = typeof error.statusCode === 'number' ? error.statusCode : null;
        const isRetryable = error instanceof ModelRateLimitError ||
            (statusCode != null && retryableStatusCodes.has(statusCode));
        if (!isRetryable) {
            return false;
        }
        if (!this._fallback_llm) {
            this.logger.warning(`⚠️ LLM error (${error.name}: ${error.message}) but no fallback_llm configured`);
            return false;
        }
        this._log_fallback_switch(error, this._fallback_llm);
        this.llm = this._fallback_llm;
        this._using_fallback_llm = true;
        this.token_cost_service.register_llm(this._fallback_llm);
        return true;
    }
    _log_fallback_switch(error, fallback) {
        const originalModel = typeof this._original_llm?.model === 'string'
            ? this._original_llm.model
            : 'unknown';
        const fallbackModel = typeof fallback?.model === 'string' ? fallback.model : 'unknown';
        const errorType = error.name || 'Error';
        const statusCode = typeof error.statusCode === 'number' ? error.statusCode : 'N/A';
        this.logger.warning(`⚠️ Primary LLM (${originalModel}) failed with ${errorType} (status=${statusCode}), switching to fallback LLM (${fallbackModel})`);
    }
    _validateAndNormalizeActions(actions) {
        const normalizedActions = [];
        const registryActions = this.controller.registry.get_all_actions();
        const actionAliases = {
            navigate: 'go_to_url',
            input: 'input_text',
            switch: 'switch_tab',
            close: 'close_tab',
            extract: 'extract_structured_data',
            find_text: 'scroll_to_text',
            dropdown_options: 'get_dropdown_options',
            select_dropdown: 'select_dropdown_option',
            replace_file: 'replace_file_str',
        };
        const availableNames = new Set();
        const modelForStep = this._enforceDoneOnlyForCurrentStep
            ? this.DoneActionModel
            : this.ActionModel;
        const modelAvailableNames = modelForStep?.available_actions;
        if (Array.isArray(modelAvailableNames) && modelAvailableNames.length > 0) {
            for (const actionName of modelAvailableNames) {
                if (typeof actionName === 'string' && actionName.trim()) {
                    availableNames.add(actionName);
                }
            }
        }
        else {
            for (const actionName of registryActions.keys()) {
                availableNames.add(actionName);
            }
        }
        for (let i = 0; i < actions.length; i++) {
            const entry = actions[i];
            const candidate = entry &&
                typeof entry === 'object' &&
                typeof entry.model_dump === 'function'
                ? entry.model_dump()
                : entry;
            if (!candidate ||
                typeof candidate !== 'object' ||
                Array.isArray(candidate)) {
                throw new Error(`Invalid action at index ${i}: expected an object with exactly one action key`);
            }
            const actionObject = candidate;
            const keys = Object.keys(actionObject);
            if (keys.length !== 1) {
                throw new Error(`Invalid action at index ${i}: expected exactly one action key, got ${keys.length}`);
            }
            const requestedActionName = keys[0];
            let actionName = requestedActionName;
            if (!availableNames.has(actionName)) {
                const aliasTarget = actionAliases[requestedActionName];
                if (aliasTarget && availableNames.has(aliasTarget)) {
                    actionName = aliasTarget;
                }
            }
            if (!availableNames.has(actionName)) {
                const available = Array.from(availableNames).sort().join(', ');
                throw new Error(`Action '${requestedActionName}' is not available on the current page. Available actions: ${available}`);
            }
            const actionInfo = registryActions.get(actionName);
            if (!actionInfo) {
                throw new Error(`Action '${requestedActionName}' is not registered`);
            }
            const rawParams = (actionObject[requestedActionName] ??
                actionObject[actionName] ??
                {});
            const paramsResult = actionInfo.paramSchema.safeParse(rawParams);
            if (!paramsResult.success) {
                // Surface a human-readable issue list (zod v4 `prettifyError`) plus
                // a corrective hint, rather than the default JSON dump of `.issues`.
                // This Error propagates → `_handle_step_error` writes it into
                // `state.last_result` → `create_state_messages` injects it into the
                // next LLM turn, so the model knows exactly what shape it got wrong.
                const pretty = z.prettifyError(paramsResult.error);
                const sentParams = JSON.stringify(rawParams);
                throw new Error(`Schema validation failed for action '${requestedActionName}'. ` +
                    `You sent: ${sentParams}. Issues:\n${pretty}\n` +
                    `Please retry with parameters matching the action's schema exactly.`);
            }
            normalizedActions.push(new modelForStep({
                [actionName]: paramsResult.data,
            }));
        }
        if (normalizedActions.length === 0) {
            throw new Error('Model output must contain at least one action');
        }
        if (normalizedActions.length > this.settings.max_actions_per_step) {
            this.logger.warning(`Model returned ${normalizedActions.length} actions, trimming to max_actions_per_step=${this.settings.max_actions_per_step}`);
            return normalizedActions.slice(0, this.settings.max_actions_per_step);
        }
        return normalizedActions;
    }
    async _update_action_models_for_page(page) {
        await this._updateActionModelsForPage(page);
    }
    async _check_and_update_downloads(context = '') {
        if (!this.has_downloads_path || !this.browser_session) {
            return;
        }
        try {
            const current_downloads = Array.isArray(this.browser_session.downloaded_files)
                ? [...this.browser_session.downloaded_files]
                : [];
            const changed = current_downloads.length !== this._last_known_downloads.length ||
                current_downloads.some((value, index) => value !== this._last_known_downloads[index]);
            if (changed) {
                this._update_available_file_paths(current_downloads);
                this._last_known_downloads = current_downloads;
                if (context) {
                    this.logger.debug(`📁 ${context}: Updated available files`);
                }
            }
        }
        catch (error) {
            const errorType = error instanceof Error
                ? error.name || 'Error'
                : typeof error === 'object' && error !== null
                    ? (error.constructor?.name ?? 'Error')
                    : 'Error';
            const message = error instanceof Error ? error.message : String(error);
            const errorContext = context ? ` ${context}` : '';
            this.logger.debug(`📁 Failed to check for downloads${errorContext}: ${errorType}: ${message}`);
        }
    }
    _update_available_file_paths(downloads) {
        if (!this.has_downloads_path) {
            return;
        }
        const existing = this.available_file_paths
            ? [...this.available_file_paths]
            : [];
        const known = new Set(existing);
        const new_files = downloads.filter((pathValue) => !known.has(pathValue));
        if (new_files.length) {
            const updated = existing.concat(new_files);
            this.available_file_paths = updated;
            this.logger.info(`📁 Added ${new_files.length} downloaded files to available_file_paths (total: ${updated.length} files)`);
            for (const file_path of new_files) {
                this.logger.info(`📄 New file available: ${file_path}`);
            }
        }
        else {
            this.logger.debug(`📁 No new downloads detected (tracking ${existing.length} files)`);
        }
    }
    _log_step_context(current_page, browser_state_summary) {
        const url = browser_state_summary?.url ?? '';
        const url_short = url.length > 50 ? `${url.slice(0, 50)}...` : url;
        const interactive_count = browser_state_summary?.selector_map
            ? Object.keys(browser_state_summary.selector_map).length
            : 0;
        this.logger.info('\n');
        this.logger.info(`📍 Step ${this.state.n_steps}:`);
        this.logger.debug(`Evaluating page with ${interactive_count} interactive elements on: ${url_short}`);
    }
    _log_first_step_startup() {
        if (this.history.history.length !== 0) {
            return;
        }
        this.logger.info(`Starting a browser-use agent with version ${this.version}, with provider=${this.llm.provider ?? 'unknown'} and model=${this.llm.model}`);
    }
    _log_step_completion_summary(step_start_time, result) {
        if (!result.length) {
            return;
        }
        const step_duration = Date.now() / 1000 - step_start_time;
        const action_count = result.length;
        const success_count = result.filter((r) => !r.error).length;
        const failure_count = action_count - success_count;
        const success_indicator = success_count ? `✅ ${success_count}` : '';
        const failure_indicator = failure_count ? `❌ ${failure_count}` : '';
        const status_parts = [success_indicator, failure_indicator].filter(Boolean);
        const status_str = status_parts.length ? status_parts.join(' | ') : '✅ 0';
        this.logger.info(`📍 Step ${this.state.n_steps}: Ran ${action_count} actions in ${step_duration.toFixed(2)}s: ${status_str}`);
    }
    _log_agent_event(max_steps, agent_run_error) {
        if (!this.telemetry) {
            return;
        }
        const token_summary = this.token_cost_service?.get_usage_tokens_for_model?.(this.llm.model) ?? {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
        };
        const action_history_data = this.history.history.map((historyItem) => {
            if (!historyItem.model_output) {
                return null;
            }
            return historyItem.model_output.action.map((action) => {
                if (typeof action?.model_dump === 'function') {
                    return action.model_dump({ exclude_unset: true });
                }
                return action;
            });
        });
        const final_result = this.history.final_result();
        const final_result_str = final_result != null ? JSON.stringify(final_result) : null;
        const judgement_data = this.history.judgement();
        const judge_verdict = judgement_data && typeof judgement_data.verdict === 'boolean'
            ? judgement_data.verdict
            : null;
        const judge_reasoning = judgement_data && typeof judgement_data.reasoning === 'string'
            ? judgement_data.reasoning
            : null;
        const judge_failure_reason = judgement_data && typeof judgement_data.failure_reason === 'string'
            ? judgement_data.failure_reason
            : null;
        const judge_reached_captcha = judgement_data && typeof judgement_data.reached_captcha === 'boolean'
            ? judgement_data.reached_captcha
            : null;
        const judge_impossible_task = judgement_data && typeof judgement_data.impossible_task === 'boolean'
            ? judgement_data.impossible_task
            : null;
        let cdpHost = null;
        const cdpUrl = this.browser_session?.cdp_url;
        if (typeof cdpUrl === 'string' && cdpUrl) {
            try {
                const parsed = new URL(cdpUrl);
                cdpHost = parsed.hostname || cdpUrl;
            }
            catch {
                cdpHost = cdpUrl;
            }
        }
        this.telemetry.capture(new AgentTelemetryEvent({
            task: this.task,
            model: this.llm.model,
            model_provider: this.llm.provider ?? 'unknown',
            max_steps: max_steps,
            max_actions_per_step: this.settings.max_actions_per_step,
            use_vision: this.settings.use_vision,
            version: this.version,
            source: this.source,
            cdp_url: cdpHost,
            agent_type: null,
            action_errors: this.history.errors(),
            action_history: action_history_data,
            urls_visited: this.history.urls(),
            steps: this.state.n_steps,
            total_input_tokens: token_summary.prompt_tokens ?? 0,
            total_output_tokens: token_summary.completion_tokens ?? 0,
            prompt_cached_tokens: token_summary.prompt_cached_tokens ?? 0,
            total_tokens: token_summary.total_tokens ?? 0,
            total_duration_seconds: this.history.total_duration_seconds(),
            success: this.history.is_successful(),
            final_result_response: final_result_str,
            error_message: agent_run_error,
            judge_verdict,
            judge_reasoning,
            judge_failure_reason,
            judge_reached_captcha,
            judge_impossible_task,
        }));
    }
    async _make_history_item(model_output, browser_state_summary, result, metadata, state_message = null) {
        const interacted_elements = model_output
            ? AgentHistory.get_interacted_element(model_output, browser_state_summary.selector_map)
            : [];
        const state = new BrowserStateHistory(browser_state_summary.url, browser_state_summary.title, browser_state_summary.tabs, interacted_elements, this._current_screenshot_path);
        this.history.add_item(new AgentHistory(model_output, result, state, metadata, state_message));
    }
    save_file_system_state() {
        if (!this.file_system) {
            this.logger.error('💾 File system is not set up. Cannot save state.');
            throw new Error('File system is not set up. Cannot save state.');
        }
        this.state.file_system_state = this.file_system.get_state();
    }
}
