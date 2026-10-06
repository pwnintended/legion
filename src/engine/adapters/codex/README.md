# adapters/codex

Codex adapter: implements `AgentEngine` (`@shared/engine`) over `codex app-server` (JSON-RPC 2.0 on stdio).
Generated protocol types go in `protocol/` (`codex app-server generate-ts --experimental`, committed;
excluded from Biome).

Owns: thread start/resume, `turn/start` with `outputSchema`, sandbox/approval policy per
`PermissionProfile`, `item/*/requestApproval` → `approval_request` events, rate-limit notifications →
`rate_limit` events, config isolation (Legion-owned `CODEX_HOME` or `--ignore-user-config`), `probe()`.
Conformance: behave like `adapters/fake`. Live tests: `*.live.test.ts`, low effort, tiny prompts.
