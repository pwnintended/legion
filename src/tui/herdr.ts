/**
 * Herdr (herdr.dev, a terminal workspace manager for agents) shows each pane's agent state and notifies when an
 * agent in a background pane finishes or needs the user. Inside a Herdr pane, Legion reports its own state over
 * Herdr's socket: `blocked` while a gate, question or approval waits for the user, `working` while the assistant,
 * a lead or a run is busy, `idle` otherwise. Workers starting and stopping inside a run never show; the user hears
 * from Herdr only when Legion needs them. (Workers get no `HERDR_*` env, so their own Herdr hooks stay quiet.)
 */
import { createConnection } from 'node:net';
import type { UiInteraction, UiState } from './store.ts';

export type HerdrState = 'idle' | 'working' | 'blocked';

export interface Attention {
  state: HerdrState;
  message: string | null;
}

/** What Legion needs from the user right now. */
export function attention(
  ui: Pick<UiState, 'interactions' | 'team'>,
  assistantBusy: boolean,
  activeRuns: number,
): Attention {
  const head = ui.interactions[0];
  if (head) return { state: 'blocked', message: describe(head) };
  const leadsBusy = ui.team.some((r) => r.status === 'working' || r.status === 'starting');
  return { state: assistantBusy || leadsBusy || activeRuns > 0 ? 'working' : 'idle', message: null };
}

function describe(i: UiInteraction): string {
  if (i.source === 'assistant') return `approve ${i.approval.tool}`;
  if (i.source === 'question') return i.questions[0]?.question ?? 'question';
  const it = i.pending.interaction;
  switch (it.kind) {
    case 'gate':
      return it.title;
    case 'ask':
      return it.question;
    case 'approval':
      return `approve ${it.tool}`;
    case 'questions':
      return it.questions[0]?.question ?? 'question';
  }
}

/** One request to Herdr's socket API. */
export type HerdrSend = (method: string, params: Record<string, unknown>) => Promise<void>;

const SOURCE = 'legion';
const AGENT = 'legion';
/** How long Legion must stay idle before Herdr hears it: a run finishing wakes the assistant right after. */
const IDLE_SETTLE_MS = 750;

export class HerdrReporter {
  private last: Attention | null = null;
  private timer: NodeJS.Timeout | null = null;
  private paused = false;
  private seq = Date.now() * 1000;
  /** Requests go out one at a time, in order. */
  private chain: Promise<void> = Promise.resolve();
  private readonly pane: string;
  private readonly send: HerdrSend;
  private readonly read: () => Attention;
  private readonly settleMs: number;

  constructor(pane: string, send: HerdrSend, read: () => Attention, settleMs = IDLE_SETTLE_MS) {
    this.pane = pane;
    this.send = send;
    this.read = read;
    this.settleMs = settleMs;
  }

  /** Inside a Herdr pane, a reporter over its socket; otherwise null. */
  static fromEnv(read: () => Attention, env: NodeJS.ProcessEnv = process.env): HerdrReporter | null {
    const { HERDR_ENV, HERDR_SOCKET_PATH: socket, HERDR_PANE_ID: pane } = env;
    if (HERDR_ENV !== '1' || !socket || !pane) return null;
    return new HerdrReporter(pane, socketSend(socket), read);
  }

  /** Call when anything `read` looks at may have changed. */
  changed = (): void => {
    if (this.paused) return;
    const next = this.read();
    if (next.state === 'idle' && this.last && this.last.state !== 'idle') {
      this.timer ??= setTimeout(() => {
        this.timer = null;
        if (!this.paused) this.report(this.read());
      }, this.settleMs);
      return;
    }
    this.report(next);
  };

  /** Hands the pane to Herdr's own detection (an agent CLI takes the terminal) until `resume`. */
  pause(): void {
    this.paused = true;
    this.cancelTimer();
    this.last = null;
    this.enqueue('pane.release_agent', {});
  }

  resume(): void {
    this.paused = false;
    this.changed();
  }

  /** Releases the pane; resolves once Herdr has it (or could not be reached). */
  close(): Promise<void> {
    this.pause();
    return this.chain;
  }

  private report(next: Attention): void {
    this.cancelTimer();
    if (this.last && this.last.state === next.state && this.last.message === next.message) return;
    this.last = next;
    this.enqueue('pane.report_agent', { state: next.state, ...(next.message ? { message: next.message } : {}) });
  }

  private enqueue(method: string, params: Record<string, unknown>): void {
    const full = { pane_id: this.pane, source: SOURCE, agent: AGENT, seq: ++this.seq, ...params };
    this.chain = this.chain.then(() => this.send(method, full)).catch(() => {});
  }

  private cancelTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

/** Newline-delimited JSON over the Unix socket; one reply per request. Never throws: Herdr may be gone. */
function socketSend(path: string, timeoutMs = 500): HerdrSend {
  let n = 0;
  return (method, params) =>
    new Promise((resolve) => {
      const socket = createConnection(path);
      const done = () => {
        clearTimeout(timer);
        socket.destroy();
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      timer.unref();
      socket.on('connect', () => socket.write(`${JSON.stringify({ id: `${SOURCE}:${++n}`, method, params })}\n`));
      socket.on('data', done);
      socket.on('error', done);
      socket.on('end', done);
    });
}
