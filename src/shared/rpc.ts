/**
 * The renderer ↔ engine contract (architecture §10): one object mapping procedure name → zod input and
 * output. The engine validates both on the server side (`rpc-transport.ts`); the renderer gets static
 * types only.
 *
 * Adding a procedure: add an entry here (input/output schemas, `null`-not-`undefined` conventions), then
 * implement it in the engine with `server.implement('name', handler)`. Until implemented, the engine
 * answers with `RpcError('not_implemented')`.
 *
 * Push events are `ServerEvent` batches (see events.ts); a connection only receives them after
 * calling `subscribe`.
 */
import { z } from 'zod';
import { AttachmentRefSchema } from './attachments';
import {
  AgentMessageSchema,
  AttemptSchema,
  EngineKindSchema,
  InboxItemSchema,
  InboxResolutionSchema,
  McpServerNameSchema,
  McpServerSchema,
  MergeSchema,
  PlanAnnotationSchema,
  PlanSchema,
  PresentationSchema,
  ProjectSchema,
  QuestionAnswerSchema,
  ReviewSchema,
  RunSchema,
  SettingsPatchSchema,
  SettingsSchema,
  TaskNodeSchema,
  TaskSchema,
  TaskStatusSchema,
  TimestampSchema,
  VerificationSchema,
} from './domain';
import { EngineInfoSchema } from './engine';
import { AgentEventSchema, ServerEventSchema } from './events';
import { IdSchema } from './ids';

// ---------------------------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------------------------

const Empty = z.object({});
export const OkSchema = z.object({ ok: z.literal(true) });
export type Ok = z.infer<typeof OkSchema>;

const ByRun = z.object({ runId: IdSchema });
const ByTask = z.object({ taskId: IdSchema });
const ByAttempt = z.object({ attemptId: IdSchema });

export const AppInfoSchema = z.object({
  name: z.string(),
  version: z.string(),
  engineVersion: z.string(),
  /** Versions of the engine's runtime (Electron utilityProcess or plain Node). */
  runtime: z.object({
    node: z.string(),
    electron: z.string().nullable(),
    platform: z.string(),
    arch: z.string(),
  }),
  pid: z.number().int(),
  dataDir: z.string(),
  dbPath: z.string(),
  schemaVersion: z.number().int(),
  startedAt: TimestampSchema,
  /** Head of the event log at the time of the call. */
  headSeq: z.number().int().nonnegative(),
  /** The user's home directory (the UI abbreviates paths to `~/…` and expands typed `~/` paths). */
  homeDir: z.string().nullish(),
});
export type AppInfo = z.infer<typeof AppInfoSchema>;

export const RemoteSchema = z.object({ name: z.string(), url: z.string() });

export const RepoInspectionSchema = z.object({
  /** The path that was asked about. */
  path: z.string(),
  exists: z.boolean(),
  isGitRepo: z.boolean(),
  /** Top-level directory of the work tree. */
  root: z.string().nullable(),
  /** null when HEAD is detached. */
  currentBranch: z.string().nullable(),
  /** null when the repo has no commits yet. */
  headSha: z.string().nullable(),
  /** origin/HEAD if known, else main/master if present, else the current branch. */
  defaultBranch: z.string().nullable(),
  remotes: z.array(RemoteSchema),
  /** owner/name parsed from the origin (or first) GitHub remote. */
  github: z.object({ owner: z.string(), name: z.string() }).nullable(),
  /** Tracked files modified (untracked files ignored). */
  dirty: z.boolean(),
  hasGh: z.boolean(),
  /** `gh` has a github.com login (null: gh missing or not checked). */
  ghAuthenticated: z.boolean().nullish(),
  /** Parsed `legion.json` if present and valid (§9). */
  legionConfig: z
    .object({
      setup: z.array(z.string()).nullable(),
      verify: z.array(z.string()).nullable(),
      copy: z.array(z.string()).nullable(),
      symlink: z.array(z.string()).nullable(),
      highRiskGlobs: z.array(z.string()).nullable(),
      installCommand: z.string().nullable(),
    })
    .nullable(),
  /** Why the path is unusable, if it is. */
  error: z.string().nullable(),
});
export type RepoInspection = z.infer<typeof RepoInspectionSchema>;

export const RecentRepoSchema = z.object({
  path: z.string(),
  name: z.string(),
  lastUsedAt: TimestampSchema,
});
export type RecentRepo = z.infer<typeof RecentRepoSchema>;

export const AvailableSkillSchema = z.object({
  name: z.string(),
  description: z.string(),
  scope: z.enum(['user', 'project']),
});
export type AvailableSkill = z.infer<typeof AvailableSkillSchema>;

export const DiscoveredMcpServerSchema = z.object({
  name: McpServerNameSchema,
  server: McpServerSchema,
  /** Where it was found (`~/.claude.json`, `.mcp.json`). */
  source: z.string(),
});
export type DiscoveredMcpServer = z.infer<typeof DiscoveredMcpServerSchema>;

/** A checkout found by `repos.discover`. */
export const DiscoveredRepoSchema = z.object({
  path: z.string(),
  name: z.string(),
  /** Current branch (null when detached or unknown). */
  branch: z.string().nullable(),
  /** Tracked files modified (false when unknown). */
  dirty: z.boolean(),
  /** Time of the HEAD commit, ms (null when unknown or no commits). */
  lastCommitAt: TimestampSchema.nullable(),
});
export type DiscoveredRepo = z.infer<typeof DiscoveredRepoSchema>;

export const RepoBranchesSchema = z.object({
  current: z.string().nullable(),
  /** origin/HEAD if known, else main/master if present, else the current branch. */
  default: z.string().nullable(),
  /** Local branches, most recently committed first. */
  local: z.array(z.string()),
  /** Remote-tracking branches (`origin/x`), most recently committed first. */
  remote: z.array(z.string()),
});
export type RepoBranches = z.infer<typeof RepoBranchesSchema>;

export const RunSummarySchema = z.object({
  run: RunSchema,
  taskCounts: z.partialRecord(TaskStatusSchema, z.number().int().nonnegative()),
  openInbox: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
});
export type RunSummary = z.infer<typeof RunSummarySchema>;

/** Everything the UI needs to render one run. `seq` = event-log head when the snapshot was read. */
export const RunSnapshotSchema = z.object({
  seq: z.number().int().nonnegative(),
  run: RunSchema,
  plans: z.array(PlanSchema),
  tasks: z.array(TaskSchema),
  attempts: z.array(AttemptSchema),
  reviews: z.array(ReviewSchema),
  inbox: z.array(InboxItemSchema),
  verifications: z.array(VerificationSchema),
  merges: z.array(MergeSchema),
  /** Agent-to-agent messages of the run (§7), oldest first. Optional for older clients' fixtures. */
  messages: z.array(AgentMessageSchema).optional(),
  /** What agents presented to the human (`present`), oldest first. Optional for older clients' fixtures. */
  presentations: z.array(PresentationSchema).optional(),
});
export type RunSnapshot = z.infer<typeof RunSnapshotSchema>;

export const TranscriptEntrySchema = z.object({
  seq: z.number().int().positive(),
  ts: TimestampSchema,
  event: AgentEventSchema,
});
export type TranscriptEntry = z.infer<typeof TranscriptEntrySchema>;

export const DiffTargetSchema = z.discriminatedUnion('kind', [
  /** The task's own changes: startSha..branch HEAD (or working tree while running). */
  z.object({ kind: z.literal('task'), taskId: IdSchema }),
  /** The whole run: base...integration. */
  z.object({ kind: z.literal('run'), runId: IdSchema }),
  /** Arbitrary range inside the run's repo. */
  z.object({ kind: z.literal('range'), runId: IdSchema, from: z.string(), to: z.string() }),
  /** One commit of a project against its first parent (same answer as `git.show`). */
  z.object({ kind: z.literal('commit'), projectId: IdSchema, sha: z.string() }),
]);
export type DiffTarget = z.infer<typeof DiffTargetSchema>;

export const DiffLineSchema = z.object({
  kind: z.enum(['context', 'add', 'del', 'no_newline']),
  oldLine: z.number().int().nullable(),
  newLine: z.number().int().nullable(),
  text: z.string(),
});
export type DiffLine = z.infer<typeof DiffLineSchema>;

export const DiffHunkSchema = z.object({
  oldStart: z.number().int(),
  oldLines: z.number().int(),
  newStart: z.number().int(),
  newLines: z.number().int(),
  /** Text after the second `@@` (usually the enclosing function). */
  header: z.string(),
  lines: z.array(DiffLineSchema),
});
export type DiffHunk = z.infer<typeof DiffHunkSchema>;

export const DiffFileSchema = z.object({
  path: z.string(),
  /** Previous path for renames/copies. */
  oldPath: z.string().nullable(),
  status: z.enum(['added', 'modified', 'deleted', 'renamed', 'copied', 'type_changed']),
  binary: z.boolean(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  hunks: z.array(DiffHunkSchema),
  /** Hunks omitted because the file diff was too large. */
  truncated: z.boolean(),
});
export type DiffFile = z.infer<typeof DiffFileSchema>;

export const DiffResultSchema = z.object({
  from: z.string(),
  to: z.string(),
  files: z.array(DiffFileSchema),
});
export type DiffResult = z.infer<typeof DiffResultSchema>;

/**
 * Terminals: the renderer creates a `MessageChannel` and transfers one port with `terminals.open`
 * (`call(..., { transfer: [port] })`). Raw PTY bytes flow over that port, not the RPC channel:
 * engine → renderer: `{ type: 'data', data: string }` | `{ type: 'exit', code: number | null }`;
 * renderer → engine: `{ type: 'input', data: string }`.
 */
export const TerminalTargetSchema = z.discriminatedUnion('kind', [
  /** A login shell in a directory (task worktree, integration worktree, repo). */
  z.object({ kind: z.literal('shell'), cwd: z.string() }),
  /** Take over an agent session: resume it interactively in its CLI inside a PTY. */
  z.object({ kind: z.literal('attempt'), attemptId: IdSchema }),
]);
export type TerminalTarget = z.infer<typeof TerminalTargetSchema>;

export const TerminalMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('data'), data: z.string() }),
  z.object({ type: z.literal('exit'), code: z.number().int().nullable() }),
  z.object({ type: z.literal('input'), data: z.string() }),
]);
export type TerminalMessage = z.infer<typeof TerminalMessageSchema>;

// ---------------------------------------------------------------------------------------------
// Projects: the repositories in the rail, browsed read-only (files, history, pull requests)
// ---------------------------------------------------------------------------------------------

/** Live git state of a project's checkout, for the rail. */
export const ProjectStatusSchema = z.object({
  projectId: IdSchema,
  /** The checkout is still there and still a git repository. */
  exists: z.boolean(),
  /** null when HEAD is detached or unknown. */
  branch: z.string().nullable(),
  /** Tracked files modified. */
  dirty: z.boolean(),
  /** Commits ahead of / behind the upstream (null without one). */
  ahead: z.number().int().nonnegative().nullable(),
  behind: z.number().int().nonnegative().nullable(),
});
export type ProjectStatus = z.infer<typeof ProjectStatusSchema>;

export const CommitRefSchema = z.object({
  name: z.string(),
  kind: z.enum(['head', 'branch', 'remote', 'tag']),
});
export type CommitRef = z.infer<typeof CommitRefSchema>;

export const CommitSchema = z.object({
  sha: z.string(),
  shortSha: z.string(),
  parents: z.array(z.string()),
  author: z.string(),
  authorEmail: z.string(),
  /** Author date, ms. */
  date: TimestampSchema,
  subject: z.string(),
  /** Branch / tag decorations (`HEAD -> main` is a `head` ref named `main`). */
  refs: z.array(CommitRefSchema),
});
export type Commit = z.infer<typeof CommitSchema>;

export const LanguageStatSchema = z.object({
  name: z.string(),
  files: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
});
export type LanguageStat = z.infer<typeof LanguageStatSchema>;

export const ProjectInfoSchema = z.object({
  project: ProjectSchema,
  exists: z.boolean(),
  currentBranch: z.string().nullable(),
  headSha: z.string().nullable(),
  defaultBranch: z.string().nullable(),
  remotes: z.array(RemoteSchema),
  github: z.object({ owner: z.string(), name: z.string() }).nullable(),
  dirty: z.boolean(),
  hasGh: z.boolean(),
  ghAuthenticated: z.boolean().nullable(),
  /** Repo-relative path of the README at the root, if any. */
  readme: z.string().nullable(),
  /** Tracked + untracked-not-ignored files. */
  fileCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  /** By bytes, largest first (files without a known language are left out). */
  languages: z.array(LanguageStatSchema),
  lastCommit: CommitSchema.nullable(),
  commitCount: z.number().int().nonnegative().nullable(),
});
export type ProjectInfo = z.infer<typeof ProjectInfoSchema>;

export const FileEntrySchema = z.object({
  name: z.string(),
  /** Repo-relative, `/`-separated. */
  path: z.string(),
  /** Symlinks are listed, never followed. */
  type: z.enum(['file', 'dir', 'symlink']),
  /** Bytes (files only). */
  size: z.number().int().nonnegative().nullable(),
});
export type FileEntry = z.infer<typeof FileEntrySchema>;

export const FileListSchema = z.object({
  /** The listed directory ('' = the project root). */
  dir: z.string(),
  /** Directories first, then files; natural, case-insensitive order. */
  entries: z.array(FileEntrySchema),
});
export type FileList = z.infer<typeof FileListSchema>;

export const FileContentSchema = z.object({
  path: z.string(),
  size: z.number().int().nonnegative(),
  /** `too_large`: an image over the image cap (text is truncated instead, see `truncated`). */
  kind: z.enum(['text', 'image', 'binary', 'too_large']),
  /** Text content (`text` only). */
  text: z.string().nullable(),
  /** `utf-8`, `utf-16le` or `latin1` (`text` only). */
  encoding: z.string().nullable(),
  /** Only the first `maxBytes` (cut at a line end) were returned. */
  truncated: z.boolean(),
  image: z.object({ mime: z.string(), base64: z.string() }).nullable(),
});
export type FileContent = z.infer<typeof FileContentSchema>;

export const FileMatchSchema = z.object({
  path: z.string(),
  /** Higher is better. */
  score: z.number(),
  /** Indexes into `path` of the matched characters (for highlighting). */
  positions: z.array(z.number().int().nonnegative()),
});
export type FileMatch = z.infer<typeof FileMatchSchema>;

export const SearchMatchSchema = z.object({
  path: z.string(),
  /** 1-based. */
  line: z.number().int().positive(),
  /** 1-based column of the first match, in characters of the full line. */
  column: z.number().int().positive(),
  /** The line (long lines clipped around the match; `clipStart` = characters cut from the front). */
  text: z.string(),
  clipStart: z.number().int().nonnegative(),
});
export type SearchMatch = z.infer<typeof SearchMatchSchema>;

export const SearchResultSchema = z.object({
  matches: z.array(SearchMatchSchema),
  /** More matches exist than `limit`. */
  truncated: z.boolean(),
  /** Files with at least one returned match. */
  fileCount: z.number().int().nonnegative(),
});
export type SearchResult = z.infer<typeof SearchResultSchema>;

export const PullRequestSummarySchema = z.object({
  number: z.number().int().nonnegative(),
  title: z.string(),
  state: z.enum(['open', 'closed', 'merged']),
  isDraft: z.boolean(),
  /** Head branch. */
  branch: z.string(),
  author: z.string().nullable(),
  url: z.string(),
  updatedAt: TimestampSchema.nullable(),
});
export type PullRequestSummary = z.infer<typeof PullRequestSummarySchema>;

export const PrListSchema = z.object({
  /** gh is installed, signed in and the project has a GitHub remote. */
  available: z.boolean(),
  /** Why not (`gh is not installed`, ...), when unavailable. */
  reason: z.string().nullable(),
  prs: z.array(PullRequestSummarySchema),
});
export type PrList = z.infer<typeof PrListSchema>;

export const CommitDiffSchema = DiffResultSchema.extend({
  commit: CommitSchema.extend({ body: z.string() }),
});
export type CommitDiff = z.infer<typeof CommitDiffSchema>;

const ByProject = z.object({ projectId: IdSchema });

const TerminalSize = { cols: z.number().int().min(1).max(1000), rows: z.number().int().min(1).max(1000) };

/** What `runs.archive` left in place (and why), and cleanup steps that failed. */
export const ArchiveReportSchema = z.object({
  kept: z.array(
    z.object({
      kind: z.enum(['branch', 'worktree']),
      /** Branch name or worktree path. */
      name: z.string(),
      reason: z.string(),
    }),
  ),
  problems: z.array(z.string()),
});
export type ArchiveReport = z.infer<typeof ArchiveReportSchema>;

/** `attachments.get`: the ref plus its content for previews (images as base64, text capped). */
export const AttachmentContentSchema = z.object({
  attachment: AttachmentRefSchema,
  /** Images only. */
  dataBase64: z.string().nullable(),
  /** Text files only, at most `ATTACHMENT_LIMITS.previewChars` characters. */
  text: z.string().nullable(),
  /** The text was cut at the preview limit. */
  truncated: z.boolean(),
});
export type AttachmentContent = z.infer<typeof AttachmentContentSchema>;

/** Attachment ids for `runs.create`, `runs.answerClarify` and `sessions.send` (absent/null = none). */
const AttachmentIds = z.array(IdSchema).max(10).nullish();

// ---------------------------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------------------------

export const rpcContract = {
  // app & engines -------------------------------------------------------------------------------
  'app.info': { input: Empty, output: AppInfoSchema },
  /** Last known probe results (probes lazily on first call). */
  'engines.list': { input: Empty, output: z.array(EngineInfoSchema) },
  /** Re-probe one engine or all of them. */
  'engines.probe': {
    input: z.object({ kind: EngineKindSchema.nullable() }),
    output: z.array(EngineInfoSchema),
  },

  // settings ------------------------------------------------------------------------------------
  'settings.get': { input: Empty, output: SettingsSchema },
  /** Deep-merges the patch, validates, persists, emits `settings.updated`. */
  'settings.set': { input: SettingsPatchSchema, output: SettingsSchema },

  // agent access --------------------------------------------------------------------------------
  /**
   * Skills that can go on a role's allowlist: the user's (`~/.claude/skills`, `~/.agents/skills`) and, with a
   * project, the repo's (`.claude/skills`, `.agents/skills`). A repo skill hides a user skill of the same name.
   */
  'skills.list': {
    input: z.object({ projectId: IdSchema.nullable() }),
    output: z.array(AvailableSkillSchema),
  },
  /** MCP servers already configured for Claude Code (`~/.claude.json`, the project's `.mcp.json`), to import. */
  'mcpServers.discover': {
    input: z.object({ projectId: IdSchema.nullable() }),
    output: z.array(DiscoveredMcpServerSchema),
  },

  // repos ---------------------------------------------------------------------------------------
  /** Read-only inspection; a valid repo is also recorded in recent repos. */
  'repos.inspect': { input: z.object({ path: z.string().min(1) }), output: RepoInspectionSchema },
  /**
   * A repository without commits gets its first one ("Initial commit": its files, `.gitignore` applied), so runs
   * have a commit to branch from. `conflict` when it already has commits. Returns the new inspection.
   */
  'repos.initialCommit': { input: z.object({ path: z.string().min(1) }), output: RepoInspectionSchema },
  'repos.recent': { input: Empty, output: z.array(RecentRepoSchema) },
  /**
   * Checkouts found by a shallow, time-boxed scan of common dev folders (~/Projects, ~/Developer, ...) and the
   * parents of recent repos; newest commit first. Cached for a couple of minutes unless `refresh`.
   */
  'repos.discover': {
    input: z.object({ refresh: z.boolean().nullish() }),
    output: z.array(DiscoveredRepoSchema),
  },
  /** Branches of a repo for the base-branch picker (empty lists for a non-repo). */
  'repos.branches': { input: z.object({ path: z.string().min(1) }), output: RepoBranchesSchema },

  // projects ------------------------------------------------------------------------------------
  /** Pinned first, then in the order they were added. */
  'projects.list': { input: Empty, output: z.array(ProjectSchema) },
  /**
   * Add a checkout (any folder inside one; the top level's real path is stored). Idempotent: an existing
   * project is returned (and touched). `bad_request` when the folder is not a git repository.
   */
  'projects.add': { input: z.object({ path: z.string().min(1) }), output: ProjectSchema },
  /** Forget a project. Nothing on disk changes; its runs stay (with `projectId: null`). */
  'projects.remove': { input: ByProject, output: OkSchema },
  /** Record that the user opened the project (`lastOpenedAt`). */
  'projects.touch': { input: ByProject, output: ProjectSchema },
  'projects.pin': { input: z.object({ projectId: IdSchema, pinned: z.boolean() }), output: ProjectSchema },
  /** Branch / dirty state of one project (or all of them with `projectId: null`), for the rail. */
  'projects.status': {
    input: z.object({ projectId: IdSchema.nullable() }),
    output: z.array(ProjectStatusSchema),
  },
  /** Facts for the project home: branches, remotes, gh, README, languages, size, last commit. */
  'projects.info': { input: ByProject, output: ProjectInfoSchema },

  // project files: read-only, confined to the project root, ignored files invisible ----------------
  /** One directory's entries (`dir: ''` = the root). */
  'files.list': { input: z.object({ projectId: IdSchema, dir: z.string() }), output: FileListSchema },
  /**
   * A file's content: text (encoding detected, cut at `maxBytes`, default 1 MiB), images (png, jpg, gif,
   * webp, svg, ico; up to 8 MiB) as base64, else `binary`. Refused (`bad_request`): paths outside the project,
   * inside `.git`, through a symlink that leaves the root; `not_found`: missing or ignored files.
   */
  'files.read': {
    input: z.object({
      projectId: IdSchema,
      path: z.string().min(1),
      maxBytes: z
        .number()
        .int()
        .min(1)
        .max(8 * 1024 * 1024)
        .nullish(),
    }),
    output: FileContentSchema,
  },
  /** Fuzzy path match over the project's files (cached index), best first. */
  'files.find': {
    input: z.object({ projectId: IdSchema, query: z.string(), limit: z.number().int().min(1).max(500) }),
    output: z.array(FileMatchSchema),
  },
  /** Content search (`git grep` over tracked + untracked-not-ignored text files). */
  'files.search': {
    input: z.object({
      projectId: IdSchema,
      query: z.string().min(1).max(500),
      regex: z.boolean().nullish(),
      caseSensitive: z.boolean().nullish(),
      limit: z.number().int().min(1).max(5000),
    }),
    output: SearchResultSchema,
  },
  /** History of `ref` (default HEAD), newest first. Empty for a repository without commits. */
  'git.log': {
    input: z.object({ projectId: IdSchema, limit: z.number().int().min(1).max(1000), ref: z.string().nullish() }),
    output: z.array(CommitSchema),
  },
  /** One commit and its diff against its first parent (a root commit against the empty tree). */
  'git.show': { input: z.object({ projectId: IdSchema, sha: z.string().min(4) }), output: CommitDiffSchema },
  /** Open pull requests (`gh pr list`); `available: false` with a reason when gh can't answer. */
  'prs.list': { input: ByProject, output: PrListSchema },

  // runs ----------------------------------------------------------------------------------------
  /** Newest first; archived runs only with `includeArchived: true`. */
  'runs.list': {
    input: z.object({ includeArchived: z.boolean().nullish() }),
    output: z.array(RunSummarySchema),
  },
  'runs.get': { input: ByRun, output: RunSnapshotSchema },
  'runs.create': {
    input: z.object({
      repoPath: z.string().min(1),
      /** null = the repo's default branch. */
      baseRef: z.string().nullable(),
      /** null = derived from the issue. */
      title: z.string().nullable(),
      issueText: z.string(),
      issueUrl: z.string().nullable(),
      plannerEngine: EngineKindSchema,
      plannerModel: z.string().nullable(),
      skipClarify: z.boolean(),
      /** Draft attachments (`attachments.add`) for the planner, coders and reviewers. */
      attachmentIds: AttachmentIds,
    }),
    output: RunSchema,
  },
  /** Start a conversation with the assistant (§8.6): a run in `chatting` whose first message is `prompt`. */
  'runs.chat': {
    input: z.object({
      repoPath: z.string().min(1),
      baseRef: z.string().nullable(),
      prompt: z.string().min(1),
      engine: EngineKindSchema,
      model: z.string().nullable(),
      attachmentIds: AttachmentIds,
    }),
    output: RunSchema,
  },
  'runs.answerClarify': {
    input: z.object({ runId: IdSchema, answers: z.array(QuestionAnswerSchema), attachmentIds: AttachmentIds }),
    output: RunSchema,
  },
  /** Human edit of the plan: stores a new plan version (source `user`) after DAG validation. */
  'runs.updatePlan': {
    input: z.object({
      runId: IdSchema,
      /** The version being edited; rejected with `conflict` if it is no longer the latest. */
      basePlanId: IdSchema,
      markdown: z.string(),
      nodes: z.array(TaskNodeSchema),
      /**
       * The edited DAG's annotations. Carries the human's DAG decisions across re-validation: an
       * `[overlap_accepted]` note (from `undoAutoEdge`) keeps that pair unserialized, a dropped
       * `serializing_edge` stays dropped. Absent/null = keep the base version's annotations.
       */
      annotations: z.array(PlanAnnotationSchema).nullish(),
    }),
    output: PlanSchema,
  },
  'runs.approvePlan': { input: z.object({ runId: IdSchema, planId: IdSchema }), output: RunSchema },
  'runs.requestPlanRevision': {
    input: z.object({ runId: IdSchema, planId: IdSchema, feedback: z.string().min(1) }),
    output: RunSchema,
  },
  'runs.pause': { input: ByRun, output: RunSchema },
  'runs.resume': { input: ByRun, output: RunSchema },
  'runs.cancel': { input: ByRun, output: RunSchema },
  /** Human PR gate: push the integration branch and open the draft PR. */
  'runs.createPr': {
    input: z.object({ runId: IdSchema, title: z.string().nullable(), body: z.string().nullable() }),
    output: z.object({ run: RunSchema, url: z.string() }),
  },
  /**
   * Re-read the run's PR from the host (`gh pr view`) and store it in `run.pr`. A merged or closed PR
   * finishes the run and archives it (cleanup, see `runs.archive`). The engine also polls open PRs.
   */
  'runs.refreshPr': { input: ByRun, output: RunSchema },
  /**
   * Clean up a run (§8 step 9) and hide it from `runs.list`. A run that is still active is refused
   * (`failed_precondition`) unless `force: true`, which cancels it first. Closes its sessions and terminals,
   * removes worktrees and local branches **unless they hold work found nowhere else**: a worktree with
   * uncommitted changes and a task branch with work in neither integration nor the base are kept (removed
   * anyway with `force`); the integration branch is deleted only when the PR was merged, or closed with the
   * branch fully pushed, or when it has nothing beyond the base (`force` never deletes it). What was kept is
   * listed in `archiveReport`. Restores `gc.auto`, sets `archived: true`. Idempotent.
   */
  'runs.archive': {
    input: z.object({
      runId: IdSchema,
      force: z.boolean().nullish(),
      /**
       * Remove everything the run left locally, also what a normal archive keeps: dirty worktrees, task branches
       * with unmerged work and the integration branch. Implies `force`. Nothing on the remote is touched (pushed
       * branches, pull requests). Also works on an archived run, to clear what an earlier archive kept.
       */
      discard: z.boolean().nullish(),
    }),
    output: RunSchema.extend({ archiveReport: ArchiveReportSchema.nullish() }),
  },

  // tasks ---------------------------------------------------------------------------------------
  'tasks.retry': {
    input: z.object({ taskId: IdSchema, note: z.string().nullable() }),
    output: TaskSchema,
  },
  /**
   * Start a failed / awaiting_human task over from scratch: fresh worktree from integration, fresh attempt
   * budget, the note (and the last error) as context for the new coder. `tasks.retry` instead resumes the
   * failed step when there is work to keep.
   */
  'tasks.restart': {
    input: z.object({ taskId: IdSchema, note: z.string().nullish() }),
    output: TaskSchema,
  },
  'tasks.skip': { input: ByTask, output: TaskSchema },
  /** For `awaiting_human` tasks (high risk / escalations): approve for the merge queue. */
  'tasks.approveMerge': { input: ByTask, output: TaskSchema },
  /** Send human feedback to the coder session (→ fixing). */
  'tasks.requestChanges': {
    input: z.object({ taskId: IdSchema, feedback: z.string().min(1) }),
    output: TaskSchema,
  },

  // inbox ---------------------------------------------------------------------------------------
  'inbox.list': {
    input: z.object({ runId: IdSchema.nullable(), includeResolved: z.boolean() }),
    output: z.array(InboxItemSchema),
  },
  'inbox.resolve': {
    input: z.object({ itemId: IdSchema, resolution: InboxResolutionSchema }),
    output: InboxItemSchema,
  },

  // live sessions -------------------------------------------------------------------------------
  'sessions.send': {
    input: z.object({
      attemptId: IdSchema,
      text: z.string().min(1),
      priority: z.enum(['now', 'next']),
      attachmentIds: AttachmentIds,
    }),
    output: OkSchema,
  },
  'sessions.interrupt': { input: ByAttempt, output: OkSchema },
  /** Stop the structured session and resume it interactively in a PTY (see `terminals.open`). */
  'sessions.takeover': {
    input: z.object({ attemptId: IdSchema, ...TerminalSize }),
    output: z.object({ terminalId: IdSchema }),
  },

  // agent messages ------------------------------------------------------------------------------
  /** Every message between the run's attempts, oldest first (`core/messaging.ts`). */
  'messages.list': { input: ByRun, output: z.array(AgentMessageSchema) },

  // transcripts & diffs -------------------------------------------------------------------------
  'attempts.get': { input: ByAttempt, output: AttemptSchema },
  'attempts.transcript': {
    input: z.object({
      attemptId: IdSchema,
      /** Return events with seq > sinceSeq. */
      sinceSeq: z.number().int().nonnegative(),
      limit: z.number().int().min(1).max(5000),
    }),
    output: z.object({
      entries: z.array(TranscriptEntrySchema),
      /** True when more entries exist after the last returned one. */
      hasMore: z.boolean(),
    }),
  },
  'diff.get': {
    input: z.object({ target: DiffTargetSchema, contextLines: z.number().int().min(0).max(100) }),
    output: DiffResultSchema,
  },

  // terminals (transfer a MessagePort with `open`) -----------------------------------------------
  /**
   * Open a terminal, or re-attach to a live one: with `terminalId` (e.g. a detached shell, or the
   * terminal returned by `sessions.takeover`) the transferred port is attached to that terminal and
   * `target` is ignored. Absent/null `terminalId` = open (or, for an attempt target, find) by `target`.
   */
  'terminals.open': {
    input: z.object({ target: TerminalTargetSchema, ...TerminalSize, terminalId: IdSchema.nullish() }),
    output: z.object({ terminalId: IdSchema, pid: z.number().int() }),
  },
  'terminals.resize': { input: z.object({ terminalId: IdSchema, ...TerminalSize }), output: OkSchema },
  'terminals.close': { input: z.object({ terminalId: IdSchema }), output: OkSchema },

  // attachments ---------------------------------------------------------------------------------
  /**
   * Store a file as a draft attachment: bytes (`dataBase64`, e.g. a pasted screenshot) or a local file
   * (`path`, from a drop or the file dialog). The type is sniffed from the content; images ≤ 10 MB, text /
   * code / PDF ≤ 2 MB, anything else is refused (`bad_request`). Content-addressed under
   * `<dataDir>/attachments/`; a draft nothing claims within a day is garbage-collected.
   */
  'attachments.add': {
    input: z
      .object({
        name: z.string().min(1),
        /** The clipboard's type, if known (informational: the content decides). */
        mime: z.string().nullish(),
        dataBase64: z.string().nullish(),
        /** Absolute path of a local file. */
        path: z.string().min(1).nullish(),
      })
      .refine((v) => (v.dataBase64 == null) !== (v.path == null), {
        message: 'pass exactly one of dataBase64 and path',
      }),
    output: AttachmentRefSchema,
  },
  /** An attachment with its content for previews. */
  'attachments.get': { input: z.object({ id: IdSchema }), output: AttachmentContentSchema },

  // event stream ----------------------------------------------------------------------------------
  /**
   * Start (or resume) the push stream for this connection. The engine replays events with
   * seq > sinceSeq when it still can (`replayed: true`); otherwise (`replayed: false`) the client must
   * refetch snapshots (`runs.list`, `runs.get`) and ignore events whose seq ≤ the snapshot's seq.
   * Either way, live events with seq > headSeq follow.
   */
  subscribe: {
    input: z.object({ sinceSeq: z.number().int().nonnegative() }),
    output: z.object({ headSeq: z.number().int().nonnegative(), replayed: z.boolean() }),
  },
} as const;

export type RpcContract = typeof rpcContract;
export type ProcedureName = keyof RpcContract;
export type RpcInput<P extends ProcedureName> = z.input<RpcContract[P]['input']>;
export type RpcOutput<P extends ProcedureName> = z.output<RpcContract[P]['output']>;

/** Push channel payload schema (engine → renderer). */
export const rpcEventSchema = ServerEventSchema;

/** Max events replayed by `subscribe` before falling back to `replayed: false`. */
export const MAX_REPLAY_EVENTS = 20_000;
