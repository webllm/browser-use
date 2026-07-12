export interface DirectCommandVariant {
  usage: string;
  description: string;
}

export interface DirectCommandDocumentation {
  goal: string;
  usages: readonly string[];
}

export interface DirectCommandSpec {
  name: string;
  variants: readonly DirectCommandVariant[];
  documentation: DirectCommandDocumentation;
}

export const DIRECT_COMMAND_SPECS = [
  {
    name: 'open',
    variants: [{ usage: 'open <url>', description: 'Navigate to URL' }],
    documentation: { goal: 'Navigate', usages: ['open <url>'] },
  },
  {
    name: 'state',
    variants: [{ usage: 'state', description: 'Get current browser state' }],
    documentation: { goal: 'Inspect interactive state', usages: ['state'] },
  },
  {
    name: 'click',
    variants: [
      { usage: 'click <index>', description: 'Click element by DOM index' },
      { usage: 'click <x> <y>', description: 'Click viewport coordinates' },
    ],
    documentation: {
      goal: 'Click',
      usages: ['click <index>', 'click <x> <y>'],
    },
  },
  {
    name: 'input',
    variants: [
      {
        usage: 'input <index> <text>',
        description: 'Replace an element value',
      },
    ],
    documentation: {
      goal: 'Replace an input value',
      usages: ['input <index> <text>'],
    },
  },
  {
    name: 'type',
    variants: [
      { usage: 'type <text>', description: 'Type into focused element' },
    ],
    documentation: {
      goal: 'Type into focused element',
      usages: ['type <text>'],
    },
  },
  {
    name: 'keys',
    variants: [{ usage: 'keys <keys>', description: 'Send keyboard keys' }],
    documentation: { goal: 'Send keys', usages: ['keys <key-sequence>'] },
  },
  {
    name: 'screenshot',
    variants: [
      {
        usage: 'screenshot [path] [--full]',
        description: 'Capture a viewport or full-page screenshot',
      },
    ],
    documentation: {
      goal: 'Capture a screenshot',
      usages: ['screenshot [path] [--full]'],
    },
  },
  {
    name: 'scroll',
    variants: [
      {
        usage: 'scroll [up|down|left|right]',
        description: 'Scroll the page (defaults to down)',
      },
    ],
    documentation: {
      goal: 'Scroll',
      usages: ['scroll [up|down|left|right]'],
    },
  },
  {
    name: 'back',
    variants: [{ usage: 'back', description: 'Go back in history' }],
    documentation: { goal: 'Go back', usages: ['back'] },
  },
  {
    name: 'forward',
    variants: [{ usage: 'forward', description: 'Go forward in history' }],
    documentation: { goal: 'Go forward', usages: ['forward'] },
  },
  {
    name: 'switch',
    variants: [
      {
        usage: 'switch <tab>',
        description: 'Switch to tab index or target id',
      },
    ],
    documentation: { goal: 'Switch tabs', usages: ['switch <tab>'] },
  },
  {
    name: 'close-tab',
    variants: [{ usage: 'close-tab [tab]', description: 'Close a tab' }],
    documentation: { goal: 'Close a tab', usages: ['close-tab [tab]'] },
  },
  {
    name: 'select',
    variants: [
      {
        usage: 'select <index> <value>',
        description: 'Select a dropdown option',
      },
    ],
    documentation: {
      goal: 'Select an option',
      usages: ['select <index> <value>'],
    },
  },
  {
    name: 'wait',
    variants: [
      {
        usage: 'wait selector <css> [timeout]',
        description: 'Wait for a CSS selector',
      },
      { usage: 'wait text <text>', description: 'Wait for visible text' },
    ],
    documentation: {
      goal: 'Wait for UI',
      usages: ['wait selector <css> [timeout]', 'wait text <text>'],
    },
  },
  {
    name: 'hover',
    variants: [
      { usage: 'hover <index>', description: 'Hover element by DOM index' },
    ],
    documentation: { goal: 'Hover an element', usages: ['hover <index>'] },
  },
  {
    name: 'dblclick',
    variants: [
      {
        usage: 'dblclick <index>',
        description: 'Double-click element by DOM index',
      },
    ],
    documentation: {
      goal: 'Double-click an element',
      usages: ['dblclick <index>'],
    },
  },
  {
    name: 'rightclick',
    variants: [
      {
        usage: 'rightclick <index>',
        description: 'Right-click element by DOM index',
      },
    ],
    documentation: {
      goal: 'Right-click an element',
      usages: ['rightclick <index>'],
    },
  },
  {
    name: 'cookies',
    variants: [
      { usage: 'cookies <subcommand>', description: 'Manage browser cookies' },
    ],
    documentation: {
      goal: 'Manage cookies',
      usages: [
        'cookies get [url|--url <url>]',
        'cookies set <name> <value>',
        'cookies clear [--url <url>]',
        'cookies export <file> [--url <url>]',
        'cookies import <file>',
      ],
    },
  },
  {
    name: 'get',
    variants: [
      { usage: 'get title', description: 'Get page title' },
      { usage: 'get html [selector]', description: 'Get page HTML' },
      { usage: 'get text <index>', description: 'Get element text' },
      { usage: 'get value <index>', description: 'Get element value' },
      {
        usage: 'get attributes <index>',
        description: 'Get element attributes',
      },
      { usage: 'get bbox <index>', description: 'Get element bounding box' },
    ],
    documentation: {
      goal: 'Read page or element data',
      usages: [
        'get title',
        'get html [selector]',
        'get text <index>',
        'get value <index>',
        'get attributes <index>',
        'get bbox <index>',
      ],
    },
  },
  {
    name: 'extract',
    variants: [
      {
        usage: 'extract <query>',
        description: 'Explain that extraction requires agent mode',
      },
    ],
    documentation: {
      goal: 'Request extraction handoff',
      usages: ['extract <query>'],
    },
  },
  {
    name: 'html',
    variants: [{ usage: 'html [selector]', description: 'Get page HTML' }],
    documentation: { goal: 'Read markup', usages: ['html [selector]'] },
  },
  {
    name: 'eval',
    variants: [{ usage: 'eval <js>', description: 'Execute JavaScript' }],
    documentation: {
      goal: 'Inspect page JavaScript state',
      usages: ['eval <javascript>'],
    },
  },
  {
    name: 'close',
    variants: [{ usage: 'close', description: 'Close the persistent browser' }],
    documentation: { goal: 'Close the browser', usages: ['close'] },
  },
] as const satisfies readonly DirectCommandSpec[];

export type DirectCommandName = (typeof DIRECT_COMMAND_SPECS)[number]['name'];

const DIRECT_COMMAND_NAMES = new Set<string>(
  DIRECT_COMMAND_SPECS.map((command) => command.name)
);

export const isDirectCommandName = (
  command: string
): command is DirectCommandName => DIRECT_COMMAND_NAMES.has(command);

export const formatDirectUsage = () => {
  const variants = DIRECT_COMMAND_SPECS.reduce<DirectCommandVariant[]>(
    (allVariants, command) => {
      allVariants.push(...command.variants);
      return allVariants;
    },
    []
  );
  const usageWidth = Math.max(
    ...variants.map((variant) => variant.usage.length)
  );
  const commandLines = variants.map(
    (variant) =>
      `  ${variant.usage.padEnd(usageWidth + 2)}${variant.description}`
  );
  return `Usage: browser-use-direct <command> [args]

Commands:
${commandLines.join('\n')}

Flags:
  --remote                Launch browser-use cloud browser`;
};

const escapeMarkdownTableCell = (value: string) =>
  value.replaceAll('\\', '\\\\').replaceAll('|', '\\|');

export const renderDirectSkillCommandTable = () => {
  const rows = DIRECT_COMMAND_SPECS.map((command) => {
    const usages = command.documentation.usages
      .map((usage) => `\`${escapeMarkdownTableCell(usage)}\``)
      .join(' or ');
    return `| ${escapeMarkdownTableCell(command.documentation.goal)} | ${usages} |`;
  });
  return ['| Goal | Command and arguments |', '| --- | --- |', ...rows].join(
    '\n'
  );
};
