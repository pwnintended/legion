import type { ReviewCriterion, ReviewFinding, ReviewVerdict, TaskNode, TaskStatus } from '@shared/domain';
import type { ScopeReport } from '../scope';

/** What a session is started with (`SessionOptions.systemPrompt` / `.prompt`). */
export interface AgentPrompt {
  /** Appended to the engine's own system prompt: role, rules, output contract. */
  readonly systemPrompt: string;
  /** The first user message: the concrete job and its context. */
  readonly prompt: string;
}

/**
 * Legion MCP tool names as the engine exposes them (Claude: `mcp__legion__mark_task_done`, Codex: its own
 * naming). The adapter knows; prompts default to the bare names.
 */
export interface ToolNames {
  readonly markTaskDone: string;
  readonly requestHumanInput: string;
  readonly reportProgress: string;
  readonly askLead: string;
  readonly listAgents: string;
  readonly sendMessage: string;
  readonly planStatus: string;
  readonly readPlan: string;
  readonly addTask: string;
  readonly amendTask: string;
  readonly cancelTask: string;
  readonly spawnResearch: string;
  readonly waitForReply: string;
  readonly startImplementation: string;
  readonly runStatus: string;
  readonly present: string;
}

export const DEFAULT_TOOL_NAMES: ToolNames = {
  markTaskDone: 'mark_task_done',
  requestHumanInput: 'request_human_input',
  reportProgress: 'report_progress',
  askLead: 'ask_lead',
  listAgents: 'list_agents',
  sendMessage: 'send_message',
  planStatus: 'plan_status',
  readPlan: 'read_plan',
  addTask: 'add_task',
  amendTask: 'amend_task',
  cancelTask: 'cancel_task',
  spawnResearch: 'spawn_research',
  waitForReply: 'wait_for_reply',
  startImplementation: 'start_implementation',
  runStatus: 'run_status',
  present: 'present',
};

/** A file the human attached to the run (sent with the agent's first message by the adapter). */
export interface AttachmentNote {
  readonly name: string;
  readonly kind: 'image' | 'text' | 'file';
  readonly mime: string;
}

export interface IssueInput {
  readonly title: string;
  readonly text: string;
  readonly url: string | null;
  /** Files attached to the run; the prompt lists them, the adapter sends their content. */
  readonly attachments?: readonly AttachmentNote[];
}

export interface RepoInput {
  /** Branch/ref the work is based on. */
  readonly baseRef: string;
  /** `legion.json` verify commands (run on every task and on integration). */
  readonly verifyCommands?: readonly string[];
  readonly setupCommands?: readonly string[];
  readonly installCommand?: string | null;
  /** Free-form conventions (e.g. a summary of CLAUDE.md / AGENTS.md / CONTRIBUTING.md). */
  readonly conventions?: string | null;
}

export interface QuestionAnswerInput {
  readonly question: string;
  readonly answer: string;
}

export interface VerifyResultInput {
  readonly command: string;
  /** null = killed / timed out. */
  readonly exitCode: number | null;
  readonly outputTail: string;
  readonly durationMs?: number | null;
}

export interface UpstreamSummary {
  readonly nodeId: string;
  readonly title: string;
  /** The coder's `mark_task_done` summary (as merged). */
  readonly summary: string;
  readonly files?: readonly string[];
}

export interface ClarifyPromptInput {
  readonly issue: IssueInput;
  readonly repo: RepoInput;
  /** Default 5 (the schema's maximum). */
  readonly maxQuestions?: number;
}

export interface PlanPromptInput {
  readonly issue: IssueInput;
  readonly repo: RepoInput;
  readonly answers: readonly QuestionAnswerInput[];
  /** Soft cap on the number of tasks. Default 12. */
  readonly maxTasks?: number;
  /** Set when revising: the previous plan and the human's feedback. */
  readonly revision?: {
    readonly previousMarkdown: string;
    readonly previousNodes: readonly TaskNode[];
    readonly feedback: string;
  } | null;
  /** Set when the previous output failed validation: the errors to fix. */
  readonly validationErrors?: readonly string[] | null;
}

export interface CoderPromptInput {
  readonly issue: IssueInput;
  readonly repo: RepoInput;
  readonly node: TaskNode;
  /** Plan summary (the plan markdown or its first section). */
  readonly planSummary: string;
  /** Worktree path of the whole plan (`PLAN_FILE`), when Legion wrote it. */
  readonly planFile?: string | null;
  readonly upstream: readonly UpstreamSummary[];
  /** 1-based attempt number; >1 means a retry from a reset worktree. */
  readonly attempt: number;
  readonly previousFailure?: string | null;
  readonly tools?: ToolNames;
  /** The session also has the task-report output schema; ask for it as the final message. */
  readonly structuredReport?: boolean;
  /** The coder reports to an implementation lead it can ask (`ask_lead`). */
  readonly lead?: boolean;
}

/** One task on the lead's board. */
export interface BoardRow {
  readonly nodeId: string;
  readonly title: string;
  readonly status: TaskStatus;
  readonly dependsOn: readonly string[];
  readonly progress: string | null;
  readonly error: string | null;
  /** The coder's latest report summary, when it finished a turn. */
  readonly summary: string | null;
}

export interface LeadPromptInput {
  readonly issue: IssueInput;
  readonly planMarkdown: string;
  readonly nodes: readonly TaskNode[];
  readonly tools?: ToolNames;
  /** The lead reports to an assistant that talks to the human (decisions go through it). */
  readonly parent?: boolean;
}

export interface AssistantPromptInput {
  /** The human's first message. */
  readonly message: string;
  readonly repo: RepoInput;
  readonly projectName: string;
  readonly tools?: ToolNames;
}

export interface AssistantWakeInput {
  /** Rendered queued messages (`renderMessages`), or null. */
  readonly messages: string | null;
  /** One line per conversation change since the last wake (run status, things waiting for the human). */
  readonly changes: readonly string[];
  readonly tools?: ToolNames;
}

export interface LeadWakeInput {
  /** Rendered queued messages (`renderMessages`), or null. */
  readonly messages: string | null;
  /** One line per board change since the last wake. */
  readonly changes: readonly string[];
  readonly board: readonly BoardRow[];
  readonly tools?: ToolNames;
  readonly parent?: boolean;
}

export interface ResearcherPromptInput {
  readonly title: string;
  readonly brief: string;
  readonly repo: RepoInput;
  /** Who asked (role label), so the report is pitched right. */
  readonly requester: string;
  readonly tools?: ToolNames;
}

export interface ResearchLeadPromptInput extends ResearcherPromptInput {
  /** Researchers the lead may have running at once. */
  readonly maxResearchers: number;
}

export interface FixerPromptInput {
  readonly node: TaskNode;
  /** Blocker/major findings to address. */
  readonly findings: readonly ReviewFinding[];
  readonly unmetCriteria: readonly ReviewCriterion[];
  readonly failedVerify: readonly VerifyResultInput[];
  /** 1-based fix round and the maximum. */
  readonly round: number;
  readonly maxRounds: number;
  /** Post-merge failure: Legion merged this ref into the task branch before the fix. */
  readonly mergedIntegrationRef?: string | null;
  readonly humanNote?: string | null;
  readonly tools?: ToolNames;
  readonly structuredReport?: boolean;
}

export interface ReviewerPromptInput {
  readonly issue: IssueInput;
  readonly node: TaskNode;
  readonly planSummary: string;
  readonly upstream: readonly UpstreamSummary[];
  /** `git diff startSha..HEAD` (clipped by the builder). */
  readonly diff: string;
  readonly startSha: string;
  readonly verify: readonly VerifyResultInput[];
  readonly scope: ScopeReport;
  readonly coderSummary?: string | null;
  /** 0 = first review; n = after the n-th fix round. */
  readonly round: number;
  readonly previousFindings?: readonly ReviewFinding[];
}

export interface ResolverPromptInput {
  /** The task being merged (its worktree is the cwd). */
  readonly node: TaskNode;
  /** Already-merged tasks whose changes collide with it. */
  readonly otherNodes: readonly TaskNode[];
  readonly conflictFiles: readonly string[];
  /** Integration ref that was merged into the task branch, leaving conflict markers. */
  readonly integrationRef: string;
  readonly installCommand?: string | null;
  readonly attempt: number;
  readonly previousFailure?: string | null;
  readonly tools?: ToolNames;
  readonly structuredReport?: boolean;
}

export interface FinalTaskInput {
  readonly node: TaskNode;
  readonly status: TaskStatus;
  readonly summary: string | null;
  readonly verdict: ReviewVerdict | null;
}

export interface FinalizerPromptInput {
  readonly issue: IssueInput;
  readonly planMarkdown: string;
  readonly baseRef: string;
  readonly integrationRef: string;
  readonly tasks: readonly FinalTaskInput[];
  /** `git diff --stat base...integration`. */
  readonly diffStat: string;
  /** `git diff base...integration` (clipped by the builder). */
  readonly diff: string;
  readonly verify: readonly VerifyResultInput[];
}

export interface PrTaskRow {
  readonly nodeId: string;
  readonly title: string;
  readonly status: TaskStatus;
  readonly coderEngine: string;
  readonly reviewerEngine: string | null;
  readonly verdict: ReviewVerdict | null;
  readonly fixRounds: number;
}

export interface PrBodyInput {
  readonly runId: string;
  readonly title: string;
  readonly issueUrl: string | null;
  /** e.g. `#123` or `owner/repo#123`; adds `Closes …`. */
  readonly closes?: string | null;
  readonly baseRef: string;
  readonly integrationBranch: string;
  /** Markdown summary of the change (plan summary or the finalizer's summary). */
  readonly summary: string;
  readonly tasks: readonly PrTaskRow[];
  readonly verification: readonly VerifyResultInput[];
  readonly minorFindings: readonly { readonly nodeId: string | null; readonly finding: ReviewFinding }[];
  readonly notes?: readonly string[];
  /** Names of the files attached to the run (listed, not uploaded). */
  readonly attachments?: readonly string[];
  /** Conventional-commit style prefix (`feat`, `fix`, ...) if the repo uses it. */
  readonly titlePrefix?: string | null;
}
