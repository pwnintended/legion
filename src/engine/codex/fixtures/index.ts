/**
 * Sanitized `codex app-server` transcripts recorded live with codex-cli 0.160.0 (gpt-6.1-sol, effort low).
 * Each line: `{dir: 'out' | 'in', msg}` — `out` = Legion → codex, `in` = codex → Legion. Temp paths are
 * replaced by `/tmp/legion-fixture` (the session cwd) and `/tmp/legion-codex-home`.
 *
 * | fixture    | what happens                                                                        |
 * |------------|-------------------------------------------------------------------------------------|
 * | plain      | read-only, "reply pong"                                                             |
 * | command    | read-only, runs `ls`                                                                |
 * | filechange | workspace-write, creates hello.txt + edits README.md (apply_patch), then a command   |
 * | structured | outputSchema {sum, greeting}                                                        |
 * | approval   | workspace-write + on-request, network command → requestApproval (id 0) → decline    |
 * | interrupt  | `sleep 20` interrupted mid-command (no item/completed for the command)               |
 * | steer      | turn/steer during `sleep 6`, then a second turn/start                               |
 * | mcp        | Legion MCP over streamable HTTP + bearer token env var, report_progress tool call   |
 * | remember   | first turn of a thread ("remember zebra")                                           |
 * | resume     | thread/resume of `remember` in a new process, answers "zebra"                       |
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const FIXTURE_DIR = import.meta.dirname;
export const FIXTURE_CWD = '/tmp/legion-fixture';
export const REPLAY_SERVER = join(FIXTURE_DIR, 'replay-app-server.mjs');

export const FIXTURES = [
  'plain',
  'command',
  'filechange',
  'structured',
  'approval',
  'interrupt',
  'steer',
  'mcp',
  'remember',
  'resume',
] as const;
export type FixtureName = (typeof FIXTURES)[number];

export interface TranscriptEntry {
  dir: 'in' | 'out';
  msg: { id?: string | number; method?: string; params?: unknown; result?: unknown; error?: unknown };
}

export function fixturePath(name: FixtureName): string {
  return join(FIXTURE_DIR, `${name}.jsonl`);
}

export function loadFixture(name: FixtureName): TranscriptEntry[] {
  return readFileSync(fixturePath(name), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as TranscriptEntry);
}
