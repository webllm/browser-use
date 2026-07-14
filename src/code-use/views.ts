import { uuid7str } from '../utils.js';
import type { UsageSummary } from '../tokens/views.js';
import { readBoundedScreenshotFileSync } from '../screenshots/file.js';

export type CellType = 'code' | 'markdown';
export type ExecutionStatus = 'pending' | 'running' | 'success' | 'error';

export interface CodeCellInit {
  id?: string;
  cell_type?: CellType;
  source: string;
  output?: string | null;
  execution_count?: number | null;
  status?: ExecutionStatus;
  error?: string | null;
  browser_state?: string | null;
}

export class CodeCell {
  id: string;
  cell_type: CellType;
  source: string;
  output: string | null;
  execution_count: number | null;
  status: ExecutionStatus;
  error: string | null;
  browser_state: string | null;

  constructor(init: CodeCellInit) {
    this.id = init.id ?? uuid7str();
    this.cell_type = init.cell_type ?? 'code';
    this.source = init.source;
    this.output = init.output ?? null;
    this.execution_count = init.execution_count ?? null;
    this.status = init.status ?? 'pending';
    this.error = init.error ?? null;
    this.browser_state = init.browser_state ?? null;
  }
}

export interface CodeAgentModelOutput {
  model_output: string;
  full_response: string;
}

export interface CodeAgentResult {
  extracted_content?: string | null;
  error?: string | null;
  is_done: boolean;
  success?: boolean | null;
}

export class CodeAgentState {
  url: string | null;
  title: string | null;
  screenshot_path: string | null;

  constructor(init: {
    url?: string | null;
    title?: string | null;
    screenshot_path?: string | null;
  }) {
    this.url = init.url ?? null;
    this.title = init.title ?? null;
    this.screenshot_path = init.screenshot_path ?? null;
  }

  get_screenshot() {
    if (!this.screenshot_path) {
      return null;
    }
    return (
      readBoundedScreenshotFileSync(this.screenshot_path)?.data.toString(
        'base64'
      ) ?? null
    );
  }
}

export class CodeAgentStepMetadata {
  input_tokens: number | null;
  output_tokens: number | null;
  step_start_time: number;
  step_end_time: number;

  constructor(init: {
    input_tokens?: number | null;
    output_tokens?: number | null;
    step_start_time: number;
    step_end_time: number;
  }) {
    this.input_tokens = init.input_tokens ?? null;
    this.output_tokens = init.output_tokens ?? null;
    this.step_start_time = init.step_start_time;
    this.step_end_time = init.step_end_time;
  }

  get duration_seconds() {
    return this.step_end_time - this.step_start_time;
  }
}

export class CodeAgentHistory {
  model_output: CodeAgentModelOutput | null;
  result: CodeAgentResult[];
  state: CodeAgentState;
  metadata: CodeAgentStepMetadata | null;
  screenshot_path: string | null;

  constructor(init: {
    model_output?: CodeAgentModelOutput | null;
    result?: CodeAgentResult[];
    state: CodeAgentState;
    metadata?: CodeAgentStepMetadata | null;
    screenshot_path?: string | null;
  }) {
    this.model_output = init.model_output ?? null;
    this.result = init.result ?? [];
    this.state = init.state;
    this.metadata = init.metadata ?? null;
    this.screenshot_path = init.screenshot_path ?? null;
  }
}

export class CodeAgentHistoryList {
  constructor(
    private readonly complete_history: CodeAgentHistory[],
    private readonly usage_summary: UsageSummary | null = null
  ) {}

  get history() {
    return this.complete_history;
  }

  get usage() {
    return this.usage_summary;
  }

  final_result() {
    const last = this.complete_history[this.complete_history.length - 1];
    if (!last?.result?.length) {
      return null;
    }
    return last.result[last.result.length - 1].extracted_content ?? null;
  }

  is_done() {
    const last = this.complete_history[this.complete_history.length - 1];
    if (!last?.result?.length) {
      return false;
    }
    return Boolean(last.result[last.result.length - 1].is_done);
  }

  is_successful() {
    const last = this.complete_history[this.complete_history.length - 1];
    if (!last?.result?.length) {
      return null;
    }
    const final = last.result[last.result.length - 1];
    return final.is_done ? (final.success ?? null) : null;
  }

  errors() {
    return this.complete_history.map((entry) => {
      const withError = entry.result.find((result) => Boolean(result.error));
      return withError?.error ?? null;
    });
  }

  has_errors() {
    return this.errors().some((error) => Boolean(error));
  }

  urls() {
    return this.complete_history.map((entry) => entry.state.url);
  }

  action_results() {
    return this.complete_history.flatMap((entry) => entry.result);
  }

  extracted_content() {
    return this.action_results()
      .map((entry) => entry.extracted_content ?? null)
      .filter((entry): entry is string => typeof entry === 'string');
  }

  number_of_steps() {
    return this.complete_history.length;
  }

  total_duration_seconds() {
    return this.complete_history.reduce((sum, entry) => {
      return sum + (entry.metadata?.duration_seconds ?? 0);
    }, 0);
  }
}

export class NotebookSession {
  id: string;
  cells: CodeCell[];
  current_execution_count: number;
  namespace: Record<string, unknown>;
  _complete_history: CodeAgentHistory[];
  _usage_summary: UsageSummary | null;

  constructor(
    init: {
      id?: string;
      cells?: CodeCell[];
      current_execution_count?: number;
      namespace?: Record<string, unknown>;
    } = {}
  ) {
    this.id = init.id ?? uuid7str();
    this.cells = init.cells ?? [];
    this.current_execution_count = init.current_execution_count ?? 0;
    this.namespace = init.namespace ?? {};
    this._complete_history = [];
    this._usage_summary = null;
  }

  add_cell(source: string) {
    const cell = new CodeCell({ source });
    this.cells.push(cell);
    return cell;
  }

  get_cell(cell_id: string) {
    return this.cells.find((cell) => cell.id === cell_id) ?? null;
  }

  get_latest_cell() {
    return this.cells[this.cells.length - 1] ?? null;
  }

  increment_execution_count() {
    this.current_execution_count += 1;
    return this.current_execution_count;
  }

  get history() {
    return new CodeAgentHistoryList(
      this._complete_history,
      this._usage_summary
    );
  }
}
