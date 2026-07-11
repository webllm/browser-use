export const getCliUsage = () => `Usage:
  browser-use                    # interactive mode (TTY)
  browser-use doctor
  browser-use install
  browser-use setup [--mode <local|remote|full>]
  browser-use auth codex <login|status|logout|import>
  browser-use skill <show|install>
  browser-use tunnel <port>
  browser-use task <list|status|stop|logs>
  browser-use session <list|get|stop|create|share>
  browser-use profile <list|get|create|update|delete|cookies|sync>
  browser-use run --remote <task>
  browser-use <task>
  browser-use -p "<task>"
  browser-use [options] <task>
  browser-use --mcp
  browser-use --cli-mcp

Options:
  -h, --help                  Show this help message
  --version                   Print version and exit
  --mcp                       Run as MCP server
  --cli-mcp                   Run the minimal coding-agent CLI MCP server
  --json                      Output command results as JSON when supported
  -y, --yes                   Skip optional setup prompts where supported
  --provider <name>           Force provider (openai|anthropic|google|deepseek|groq|openrouter|azure|codex|mistral|cerebras|vercel|oci|ollama|browser-use|aws|aws-anthropic)
  --model <model>             Set model (e.g., gpt-5-mini, codex:gpt-5.5, claude-4-sonnet)
  -p, --prompt <task>         Run a single task
  --mode <name>              Setup mode for setup command (local|remote|full)
  --api-key <value>          Browser Use API key for setup or cloud operations
  --headless                  Run browser in headless mode
  --allowed-domains <items>   Comma-separated allowlist (e.g., example.com,*.example.org)
  --window-width <px>         Browser window width
  --window-height <px>        Browser window height
  --user-data-dir <path>      Chrome user data directory
  --profile-directory <name>  Chrome profile directory (Default, Profile 1, ...)
  --proxy-url <url>           Proxy server URL (e.g., http://proxy.example.com:8080)
  --no-proxy <items>          Comma-separated proxy bypass list
  --proxy-username <value>    Proxy username
  --proxy-password <value>    Proxy password
  --cdp-url <url>             Connect to an existing Chromium instance via CDP
  --debug                     Enable debug logging`;
