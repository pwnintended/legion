export {
  buildClaudeArgs,
  childEnv,
  HOST_SESSION_ENV_VARS,
  LEGION_MCP_SERVER,
  mcpConfig,
  permissionArgs,
} from './args';
export {
  CLAUDE_MODEL_ALIASES,
  ClaudeEngine,
  type ClaudeEngineOptions,
  type ExecFn,
  parseAuthStatus,
  parseVersion,
  resolveClaudeBinary,
  type SpawnFn,
} from './engine';
export { ClaudeStreamParser, classifyTool, LineBuffer, type ParserOutput } from './parser';
export { type ChildProcessLike, ClaudeSession, DEFAULT_TIMING, type SessionTiming } from './session';
