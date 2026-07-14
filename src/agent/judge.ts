import {
  ContentPartImageParam,
  ContentPartTextParam,
  ImageURL,
  SystemMessage,
  UserMessage,
  type Message,
} from '../llm/messages.js';
import { readBoundedScreenshotFileSync } from '../screenshots/file.js';

const MAX_JUDGE_SCREENSHOTS = 10;
const MAX_JUDGE_SCREENSHOT_BYTES = 20 * 1024 * 1024;
export const MAX_JUDGE_TEXT_CHARS = 40_000;
const MAX_SIMPLE_JUDGE_TEXT_CHARS = 20_000;
const MAX_JUDGE_CURRENT_DATE_CHARS = 128;

const truncateText = (
  text: string,
  maxLength: number,
  fromBeginning = false
) => {
  if (text.length <= maxLength) {
    return text;
  }
  if (fromBeginning) {
    return `...[text truncated]${text.slice(-(maxLength - 20))}`;
  }
  return `${text.slice(0, maxLength - 23)}...[text truncated]...`;
};

const joinTextBounded = (values: string[], maxLength: number) => {
  const chunks: string[] = [];
  let remaining = maxLength;
  for (let index = 0; index < values.length && remaining > 0; index += 1) {
    if (index > 0) {
      const separator = '\n'.slice(0, remaining);
      chunks.push(separator);
      remaining -= separator.length;
      if (remaining <= 0) break;
    }
    const value = values[index] ?? '';
    const bounded = value.slice(0, remaining);
    chunks.push(bounded);
    remaining -= bounded.length;
  }
  return chunks.join('');
};

export interface ConstructJudgeMessagesOptions {
  task: string;
  final_result: string;
  agent_steps: string[];
  screenshot_paths: string[];
  max_images?: number;
  ground_truth?: string | null;
  use_vision?: boolean | 'auto';
}

export interface ConstructSimpleJudgeMessagesOptions {
  task: string;
  final_result: string;
  current_date?: string;
}

export const construct_judge_messages = (
  options: ConstructJudgeMessagesOptions
): Message[] => {
  const {
    task,
    final_result,
    agent_steps,
    screenshot_paths,
    max_images = 10,
    ground_truth = null,
    use_vision = true,
  } = options;

  const task_truncated = truncateText(task, MAX_JUDGE_TEXT_CHARS);
  const final_result_truncated = truncateText(
    final_result,
    MAX_JUDGE_TEXT_CHARS
  );
  const steps_text_truncated = truncateText(
    joinTextBounded(agent_steps, MAX_JUDGE_TEXT_CHARS + 1),
    MAX_JUDGE_TEXT_CHARS
  );
  const ground_truth_truncated = ground_truth
    ? truncateText(ground_truth, MAX_JUDGE_TEXT_CHARS)
    : null;

  const encoded_images: ContentPartImageParam[] = [];
  if (use_vision !== false) {
    const boundedMaxImages =
      Number.isSafeInteger(max_images) && max_images >= 0
        ? Math.min(max_images, MAX_JUDGE_SCREENSHOTS)
        : MAX_JUDGE_SCREENSHOTS;
    const selected =
      boundedMaxImages === 0 ? [] : screenshot_paths.slice(-boundedMaxImages);
    let remainingBytes = MAX_JUDGE_SCREENSHOT_BYTES;
    for (const screenshotPath of selected) {
      if (remainingBytes <= 0) break;
      const screenshot = readBoundedScreenshotFileSync(
        screenshotPath,
        remainingBytes
      );
      if (!screenshot) {
        continue;
      }
      remainingBytes -= screenshot.data.length;
      encoded_images.push(
        new ContentPartImageParam(
          new ImageURL(
            `data:${screenshot.mediaType};base64,${screenshot.data.toString('base64')}`,
            'auto',
            screenshot.mediaType
          )
        )
      );
    }
  }

  const ground_truth_section = ground_truth_truncated
    ? `
**GROUND TRUTH VALIDATION (HIGHEST PRIORITY):**
The <ground_truth> section contains verified correct information for this task. This can be:
- Evaluation criteria: Specific conditions that must be met (e.g., "The success popup should show up", "Must extract exactly 5 items")
- Factual answers: The correct answer to a question or information retrieval task (e.g. "10/11/24", "Paris")
- Expected outcomes: What should happen after task completion (e.g., "Google Doc must be created", "File should be downloaded")

The ground truth takes ABSOLUTE precedence over all other evaluation criteria. If the ground truth is not satisfied by the agent's execution and final response, the verdict MUST be false.
`
    : '';

  const system_prompt = `You are an expert judge evaluating browser automation agent performance.

<evaluation_framework>
${ground_truth_section}
**PRIMARY EVALUATION CRITERIA (in order of importance):**
1. **Task Satisfaction (Most Important)**: Did the agent accomplish what the user asked for? Break down the task into the key criteria and evaluate if the agent all of them. Focus on user intent and final outcome.
2. **Output Quality**: Is the final result in the correct format and complete? Does it match exactly what was requested?
3. **Tool Effectiveness**: Did the browser interactions work as expected? Were tools used appropriately? How many % of the tools failed?
4. **Agent Reasoning**: Quality of decision-making, planning, and problem-solving throughout the trajectory.
5. **Browser Handling**: Navigation stability, error recovery, and technical execution. If the browser crashes, does not load or a captcha blocks the task, the score must be very low.

**VERDICT GUIDELINES:**
- true: Task completed as requested, human-like execution, all of the users criteria were met and the agent did not make up any information.
- false: Task not completed, or only partially completed.

**Examples of task completion verdict:**
- If task asks for 10 items and agent finds 4 items correctly: false
- If task completed to full user requirements but with some errors to improve in the trajectory: true
- If task impossible due to captcha/login requirements: false
- If the trajectory is ideal and the output is perfect: true
- If the task asks to search all headphones in amazon under $100 but the agent searches all headphones and the lowest price is $150: false
- If the task asks to research a property and create a google doc with the result but the agents only returns the results in text: false
- If the task asks to complete an action on the page, and the agent reports that the action is completed but the screenshot or page shows the action is not actually complete: false
- If the task asks to use a certain tool or site to complete the task but the agent completes the task without using it: false
- If the task asks to look for a section of a page that does not exist: false
- If the agent concludes the task is impossible but it is not: false
- If the agent concludes the task is impossible and it truly is impossible: false
- If the agent is unable to complete the task because no login information was provided and it is truly needed to complete the task: false

**FAILURE CONDITIONS (automatically set verdict to false):**
- Blocked by captcha or missing authentication
- Output format completely wrong or missing
- Infinite loops or severe technical failures
- Critical user requirements ignored
- Page not loaded
- Browser crashed
- Agent could not interact with required UI elements
- The agent moved on from a important step in the task without completing it
- The agent made up content that is not in the screenshot or the page state
- The agent calls done action before completing all key points of the task

**IMPOSSIBLE TASK DETECTION:**
Set impossible_task to true when the task fundamentally could not be completed due to:
- Vague or ambiguous task instructions that cannot be reasonably interpreted
- Website genuinely broken or non-functional (be conservative - temporary issues don't count)
- Required links/pages truly inaccessible (404, 403, etc.)
- Task requires authentication/login but no credentials were provided
- Task asks for functionality that doesn't exist on the target site
- Other insurmountable external obstacles beyond the agent's control

Do NOT mark as impossible if:
- Agent made poor decisions but task was achievable
- Temporary page loading issues that could be retried
- Agent didn't try the right approach
- Website works but agent struggled with it

**CAPTCHA DETECTION:**
Set reached_captcha to true if:
- Screenshots show captcha challenges (reCAPTCHA, hCaptcha, etc.)
- Agent reports being blocked by bot detection
- Error messages indicate captcha/verification requirements
- Any evidence the agent encountered anti-bot measures during execution

**IMPORTANT EVALUATION NOTES:**
- **evaluate for action** - For each key step of the trace, double check whether the action that the agent tried to performed actually happened. If the required action did not actually occur, the verdict should be false.
- **screenshot is not entire content** - The agent has the entire DOM content, but the screenshot is only part of the content. If the agent extracts information from the page, but you do not see it in the screenshot, you can assume this information is there.
- **Penalize poor tool usage** - Wrong tools, inefficient approaches, ignoring available information.
- **ignore unexpected dates and times** - These agent traces are from varying dates, you can assume the dates the agent uses for search or filtering are correct.
- **IMPORTANT**: be very picky about the user's request - Have very high standard for the agent completing the task exactly to the user's request.
- **IMPORTANT**: be initially doubtful of the agent's self reported success, be sure to verify that its methods are valid and fulfill the user's desires to a tee.
</evaluation_framework>

<response_format>
Respond with EXACTLY this JSON structure (no additional text before or after):

{
  "reasoning": "Breakdown of user task into key points. Detailed analysis covering: what went well, what didn't work, trajectory quality assessment, tool usage evaluation, output quality review, and overall user satisfaction prediction.",
  "verdict": true or false,
  "failure_reason": "Max 5 sentences explanation of why the task was not completed successfully in case of failure. If verdict is true, use an empty string.",
  "impossible_task": true or false,
  "reached_captcha": true or false
}
</response_format>`;

  const ground_truth_prompt = ground_truth_truncated
    ? `
<ground_truth>
${ground_truth_truncated}
</ground_truth>
`
    : '';

  const user_prompt = `<task>
${task_truncated || 'No task provided'}
</task>
${ground_truth_prompt}
<agent_trajectory>
${steps_text_truncated || 'No agent trajectory provided'}
</agent_trajectory>

<final_result>
${final_result_truncated || 'No final result provided'}
</final_result>

${encoded_images.length} screenshots from execution are attached.

Evaluate this agent execution given the criteria and respond with the exact JSON structure requested.`;

  const content_parts: Array<ContentPartTextParam | ContentPartImageParam> = [
    new ContentPartTextParam(user_prompt),
  ];
  content_parts.push(...encoded_images);

  return [new SystemMessage(system_prompt), new UserMessage(content_parts)];
};

export const construct_simple_judge_messages = (
  options: ConstructSimpleJudgeMessagesOptions
): Message[] => {
  const task_truncated = truncateText(
    options.task,
    MAX_SIMPLE_JUDGE_TEXT_CHARS
  );
  const final_result_truncated = truncateText(
    options.final_result,
    MAX_SIMPLE_JUDGE_TEXT_CHARS
  );
  const current_date = truncateText(
    options.current_date ?? new Date().toISOString().slice(0, 10),
    MAX_JUDGE_CURRENT_DATE_CHARS
  );

  const system_prompt = `You are a strict verifier checking whether a browser automation agent actually completed its task.

Today's date is ${current_date}. The agent ran recently - dates near today are expected and NOT fabricated.

Given the task and the agent's final response, determine if the response genuinely satisfies ALL requirements.

Check for these common failure patterns:
1. **Incorrect data**: Wrong number of items, missing filters/criteria, wrong format
2. **Unverified actions**: Agent claims to have submitted a form, posted a comment, or saved a file but there's no evidence
3. **Incomplete results**: Some requirements from the task are not addressed in the response
4. **Fabricated content**: Data that looks plausible but wasn't actually extracted from any page. NOTE: dates and times close to today's date (${current_date}) are NOT fabricated - the agent browses live websites and extracts real-time content.
5. **Partial completion reported as success**: Response acknowledges failure or blockers (captcha, access denied, etc.) but still claims success

Respond with EXACTLY this JSON structure:
{
  "is_correct": true or false,
  "reason": "Brief explanation if not correct, empty string if correct"
}

Be strict: if the response doesn't clearly satisfy every requirement, set is_correct to false.`;

  const user_prompt = `<task>
${task_truncated || 'No task provided'}
</task>

<agent_final_response>
${final_result_truncated || 'No response provided'}
</agent_final_response>

Does the agent's response fully satisfy all requirements of the task? Respond with the JSON structure.`;

  return [new SystemMessage(system_prompt), new UserMessage(user_prompt)];
};
