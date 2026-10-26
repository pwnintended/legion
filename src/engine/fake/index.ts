/**
 * A scripted engine: no CLI, no tokens. Dry runs use it to exercise a freshly written workflow end to end, and
 * tests use it to drive the runtime. Without a script, a session answers with a sample that satisfies its output
 * schema (`sampleFromSchema`) or a short text.
 */
import { randomUUID } from 'node:crypto';
import { AsyncQueue } from '../../util/async-queue.ts';
import type {
  AgentEngine,
  AgentEvent,
  AgentSession,
  ApprovalDecision,
  EngineInfo,
  EngineKind,
  EngineProfile,
  JsonSchema,
  SessionOptions,
} from '../types.ts';

export interface FakeTurn {
  /** Assistant text of the turn. */
  text?: string;
  /** Structured output (when the session has an output schema). */
  output?: unknown;
  /** Ask for a tool approval before answering. */
  approval?: { tool: string; input: unknown };
  /** End the turn with an error. */
  error?: string;
}

export interface FakeCall {
  kind: EngineKind;
  sessionId: string;
  resumed: boolean;
  opts: SessionOptions;
  /** Messages sent into the session: the prompt, then follow-ups. */
  prompts: string[];
}

/** Decides each turn. `turn` counts from 0 within the session. */
export type FakeScript = (call: FakeCall, turn: number) => FakeTurn | Promise<FakeTurn>;

export const defaultScript: FakeScript = (call) =>
  call.opts.outputSchema ? { output: sampleFromSchema(call.opts.outputSchema) } : { text: `(fake ${call.kind} reply)` };

export class FakeEngine implements AgentEngine {
  readonly kind: EngineKind;
  readonly profile: EngineProfile;
  readonly calls: FakeCall[] = [];
  private readonly script: FakeScript;

  constructor(kind: EngineKind = 'fake', script: FakeScript = defaultScript, profileName = 'fake') {
    this.kind = kind;
    this.script = script;
    this.profile = { name: profileName, kind, command: 'fake', args: [], env: {} };
  }

  async probe(): Promise<EngineInfo> {
    return {
      kind: this.kind,
      profile: this.profile.name,
      installed: true,
      path: null,
      version: 'fake',
      loggedIn: true,
      error: null,
    };
  }

  async start(opts: SessionOptions): Promise<AgentSession> {
    return this.open(randomUUID(), false, opts);
  }

  async resume(sessionId: string, opts: SessionOptions): Promise<AgentSession> {
    return this.open(sessionId, true, opts);
  }

  private open(sessionId: string, resumed: boolean, opts: SessionOptions): AgentSession {
    const call: FakeCall = { kind: this.kind, sessionId, resumed, opts, prompts: [opts.prompt] };
    this.calls.push(call);
    return new FakeSession(this.kind, call, this.script);
  }
}

class FakeSession implements AgentSession {
  readonly engine: EngineKind;
  readonly id: string;
  private readonly queue = new AsyncQueue<AgentEvent>();
  private readonly call: FakeCall;
  private readonly script: FakeScript;
  private turn = 0;
  private closed = false;
  private pendingApproval: ((d: ApprovalDecision) => void) | null = null;

  constructor(engine: EngineKind, call: FakeCall, script: FakeScript) {
    this.engine = engine;
    this.id = call.sessionId;
    this.call = call;
    this.script = script;
    this.queue.push({ type: 'session_started', sessionId: this.id, model: 'fake', version: null });
    void this.runTurn();
    call.opts.signal?.addEventListener('abort', () => void this.close(), { once: true });
  }

  get events(): AsyncIterable<AgentEvent> {
    return this.queue;
  }

  private async runTurn(): Promise<void> {
    const turn = await this.script(this.call, this.turn++);
    if (this.closed) return;
    if (turn.approval) {
      const requestId = randomUUID();
      const decision = await new Promise<ApprovalDecision>((resolve) => {
        this.pendingApproval = resolve;
        this.queue.push({
          type: 'approval_request',
          requestId,
          tool: turn.approval?.tool ?? 'Bash',
          input: turn.approval?.input ?? null,
          reason: null,
        });
      });
      if (this.closed) return;
      this.queue.push({ type: 'tool_result', id: requestId, ok: decision.behavior === 'allow', output: null });
    }
    if (turn.error) {
      this.queue.push({ type: 'turn_complete', structuredOutput: null, isError: true, reason: turn.error });
      return;
    }
    const text = turn.text ?? (turn.output !== undefined ? JSON.stringify(turn.output) : '');
    if (text) this.queue.push({ type: 'message', text });
    this.queue.push({ type: 'usage', inputTokens: 10, outputTokens: 10, costUsd: 0 });
    this.queue.push({ type: 'turn_complete', structuredOutput: turn.output ?? null, isError: false, reason: null });
  }

  async send(text: string): Promise<void> {
    this.call.prompts.push(text);
    void this.runTurn();
  }

  async interrupt(): Promise<void> {}

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.queue.push({ type: 'exited', code: 0 });
    this.queue.end();
  }

  async respond(_requestId: string, decision: ApprovalDecision): Promise<void> {
    const resolve = this.pendingApproval;
    this.pendingApproval = null;
    resolve?.(decision);
  }
}

/**
 * A value satisfying a strict JSON schema (`util/json-schema.ts`): first enum member, `true` for booleans (so
 * "is it done?" loops finish), distinct strings (`example-1`, `example-2`: they often become ids and step keys),
 * two items per array of objects and none per array of scalars (scalar lists are usually references, like a
 * task's `dependsOn`, that would point at nothing).
 */
export function sampleFromSchema(schema: JsonSchema): unknown {
  let n = 0;
  return sample(schema, schema, 0, () => `example-${++n}`);
}

function sample(schema: JsonSchema, root: JsonSchema, depth: number, str: () => string): unknown {
  if (depth > 12) return null;
  const ref = schema.$ref;
  if (typeof ref === 'string') {
    const name = ref.split('/').pop() ?? '';
    const defs = (root.definitions ?? root.$defs ?? {}) as Record<string, JsonSchema>;
    const target = defs[name];
    return target ? sample(target, root, depth + 1, str) : null;
  }
  if ('const' in schema) return schema.const;
  if (Array.isArray(schema.enum)) return schema.enum[0];
  if (Array.isArray(schema.anyOf)) {
    const options = schema.anyOf as JsonSchema[];
    const nonNull = options.find((o) => o.type !== 'null') ?? options[0];
    return nonNull ? sample(nonNull, root, depth + 1, str) : null;
  }
  const type = Array.isArray(schema.type) ? (schema.type.find((t) => t !== 'null') ?? schema.type[0]) : schema.type;
  switch (type) {
    case 'object': {
      const props = (schema.properties ?? {}) as Record<string, JsonSchema>;
      return Object.fromEntries(Object.entries(props).map(([k, v]) => [k, sample(v, root, depth + 1, str)]));
    }
    case 'array': {
      const items = (schema.items ?? {}) as JsonSchema;
      const scalar = items.type !== 'object' && items.$ref === undefined && items.anyOf === undefined;
      return scalar ? [] : [0, 1].map(() => sample(items, root, depth + 1, str));
    }
    case 'string':
      return str();
    case 'integer':
    case 'number':
      return 1;
    case 'boolean':
      return true;
    case 'null':
      return null;
    default:
      return null;
  }
}
