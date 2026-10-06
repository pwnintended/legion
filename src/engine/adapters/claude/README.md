# adapters/claude

Claude Code CLI adapter: implements `AgentEngine` (`@shared/engine`) by spawning the user's `claude`
binary with `-p --input-format stream-json --output-format stream-json --verbose --include-partial-messages`
and translating stream-json + control messages into normalized `AgentEvent`s (architecture §6).

Owns: process lifecycle, permission flags per `PermissionProfile`, `--json-schema` structured output,
`--permission-prompt-tool mcp__legion__approve` wiring, config isolation (`--strict-mcp-config`,
`--setting-sources project`), `probe()` (`claude --version`, auth state without a model turn).
Conformance: behave like `adapters/fake` (see its tests). Live tests: `*.live.test.ts`, `haiku`, tiny prompts.
