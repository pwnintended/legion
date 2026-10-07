/**
 * Helpers that build the exact client-side configuration strings an adapter passes to the CLIs so they
 * connect to the Legion MCP server. Server key is always `legion` (Claude tool names: `mcp__legion__*`).
 */

export const MCP_SERVER_NAME = 'legion';

/** Tool names as Claude Code sees them (for `--allowedTools` / `--permission-prompt-tool`). */
export const CLAUDE_TOOL_NAMES = {
  reportProgress: 'mcp__legion__report_progress',
  requestHumanInput: 'mcp__legion__request_human_input',
  approve: 'mcp__legion__approve',
  markTaskDone: 'mcp__legion__mark_task_done',
  listAgents: 'mcp__legion__list_agents',
  sendMessage: 'mcp__legion__send_message',
  waitForReply: 'mcp__legion__wait_for_reply',
  askLead: 'mcp__legion__ask_lead',
  planStatus: 'mcp__legion__plan_status',
  readPlan: 'mcp__legion__read_plan',
  addTask: 'mcp__legion__add_task',
  amendTask: 'mcp__legion__amend_task',
  cancelTask: 'mcp__legion__cancel_task',
  spawnResearch: 'mcp__legion__spawn_research',
  startImplementation: 'mcp__legion__start_implementation',
  runStatus: 'mcp__legion__run_status',
  present: 'mcp__legion__present',
} as const;

/**
 * JSON for `claude --strict-mcp-config --mcp-config <json>`. The token travels in an Authorization header.
 * Tip: set `MCP_TOOL_TIMEOUT` (ms) in the Claude process env so `request_human_input` may wait for hours.
 */
export function claudeMcpConfig(url: string, token: string): string {
  return JSON.stringify({
    mcpServers: {
      [MCP_SERVER_NAME]: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } },
    },
  });
}

/** Default Codex per-tool-call timeout: 24h, so a human can take their time. */
export const CODEX_TOOL_TIMEOUT_SEC = 86_400;

/**
 * Codex `-c key=value` overrides (values are TOML; JSON strings are valid TOML basic strings). The token itself
 * is never on the command line: Codex reads it from the environment variable `envVarName`, which the adapter
 * must set in the child's env. Returns the flat argv fragment: `['-c', 'k=v', '-c', ...]`.
 */
export function codexMcpConfigOverrides(
  url: string,
  envVarName: string,
  toolTimeoutSec = CODEX_TOOL_TIMEOUT_SEC,
): string[] {
  const p = `mcp_servers.${MCP_SERVER_NAME}`;
  const kv = [
    `${p}.url=${JSON.stringify(url)}`,
    `${p}.bearer_token_env_var=${JSON.stringify(envVarName)}`,
    `${p}.default_tools_approval_mode="approve"`,
    `${p}.tool_timeout_sec=${Math.trunc(toolTimeoutSec)}`,
  ];
  return kv.flatMap((s) => ['-c', s]);
}
