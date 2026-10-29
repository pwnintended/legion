/**
 * Checks a workflow file the way the assistant needs after writing one: type-check it against the SDK, load it,
 * then dry-run it — fake engines answer with schema-shaped samples, gates approve, git and the shell are
 * simulated — so wrong property names, broken control flow and duplicate step keys show up before a real run
 * spends tokens.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { defaultScript, FakeEngine, sampleFromSchema } from '../engine/fake/index.ts';
import type { Effort, EngineKind } from '../engine/types.ts';
import type { GitOps, Interaction, InteractionAnswer, RunEvent, RunHost, StepTier, Worktree } from './host.ts';
import { Journal } from './journal.ts';
import { builtinSourceDir, loadWorkflow, PACKAGE_ROOT, SDK_TYPES, workflowName } from './loader.ts';
import { executeInRun } from './runtime.ts';

export interface ValidationReport {
  ok: boolean;
  file: string;
  typeErrors: string[];
  loadError: string | null;
  dryRun: { ok: boolean; error: string | null; input: unknown; steps: string[]; agents: AgentSeen[] } | null;
}

/** An agent step the dry run reached, with the model and effort the workflow's code asks for. */
export interface AgentSeen {
  key: string;
  step: string;
  engine: EngineKind;
  tier: StepTier | null;
  model: string | null;
  effort: Effort | null;
}

const require = createRequire(import.meta.url);

export async function validateWorkflow(
  file: string,
  opts: { repo: string; dryRun?: boolean; typecheck?: boolean } = { repo: process.cwd() },
): Promise<ValidationReport> {
  const report: ValidationReport = { ok: false, file, typeErrors: [], loadError: null, dryRun: null };
  // Compiled builtins are checked through their TypeScript sources.
  const source = file.endsWith('.js') ? join(builtinSourceDir(), `${workflowName(file)}.ts`) : file;
  report.typeErrors = opts.typecheck !== false && existsSync(source) ? await typecheck(source) : [];
  let def: Awaited<ReturnType<typeof loadWorkflow>>;
  try {
    def = await loadWorkflow(file);
  } catch (err) {
    report.loadError = err instanceof Error ? err.message : String(err);
    return report;
  }
  if (opts.dryRun !== false) report.dryRun = await dryRun(def, opts.repo);
  report.ok = report.typeErrors.length === 0 && report.dryRun?.ok !== false;
  return report;
}

export function formatReport(report: ValidationReport): string {
  const lines: string[] = [report.ok ? `✓ ${report.file} is valid` : `✗ ${report.file} has problems`];
  if (report.typeErrors.length) lines.push('', 'Type errors:', ...report.typeErrors.map((e) => `  ${e}`));
  if (report.loadError) lines.push('', `Load error: ${report.loadError}`);
  if (report.dryRun) {
    lines.push(
      '',
      `Dry run (fake agents, approved gates, simulated git/shell) with input ${JSON.stringify(report.dryRun.input)}:`,
    );
    lines.push(...report.dryRun.steps.map((s) => `  ${s}`));
    lines.push(report.dryRun.ok ? '  → finished' : `  → failed: ${report.dryRun.error}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// type-check
// ---------------------------------------------------------------------------------------------

function tscPath(): string {
  return join(dirname(require.resolve('typescript/package.json')), 'bin', 'tsc');
}

async function typecheck(file: string): Promise<string[]> {
  const dir = mkdtempSync(join(tmpdir(), 'legion-check-'));
  try {
    const zodDir = dirname(require.resolve('zod/package.json'));
    let nodeTypes: string | null = null;
    try {
      nodeTypes = dirname(require.resolve('@types/node/package.json'));
    } catch {
      // Installed without dev dependencies: workflows type-check without Node's types.
    }
    const tsconfig = {
      compilerOptions: {
        target: 'ES2024',
        lib: ['ES2024'],
        module: 'preserve',
        moduleResolution: 'bundler',
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        allowImportingTsExtensions: true,
        erasableSyntaxOnly: true,
        verbatimModuleSyntax: true,
        types: nodeTypes ? ['node'] : [],
        ...(nodeTypes ? { typeRoots: [dirname(nodeTypes)] } : {}),
        paths: { legion: [SDK_TYPES], zod: [zodDir], 'zod/*': [`${zodDir}/*`] },
      },
      files: [file],
    };
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify(tsconfig));
    const output = await new Promise<string>((resolve) => {
      const child = spawn(process.execPath, [tscPath(), '-p', join(dir, 'tsconfig.json'), '--pretty', 'false'], {
        cwd: PACKAGE_ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      child.stdout.on('data', (c: Buffer) => {
        out += c.toString('utf8');
      });
      child.stderr.on('data', (c: Buffer) => {
        out += c.toString('utf8');
      });
      child.on('close', () => resolve(out));
      child.on('error', (err) => resolve(`tsc failed to start: ${err.message}`));
    });
    return diagnosticsFor(output, file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The diagnostics about `file` (errors inside Legion's own sources are not the workflow author's problem). tsc
 * prints paths relative to its working directory.
 */
export function diagnosticsFor(output: string, file: string, cwd = PACKAGE_ROOT): string[] {
  const target = canonical(file);
  const errors: string[] = [];
  let keep = false;
  for (const line of output.split('\n')) {
    const m = /^(\S.*?)\((\d+),(\d+)\): (error TS\d+: .*)$/.exec(line);
    if (m) {
      keep = canonical(resolve(cwd, m[1] as string)) === target;
      if (keep) errors.push(`line ${m[2]}:${m[3]} ${m[4]}`);
    } else if (keep && line.trim()) {
      errors[errors.length - 1] += `\n    ${line.trim()}`;
    } else if (/^error TS\d+/.test(line)) {
      errors.push(line);
    }
  }
  return errors;
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

// ---------------------------------------------------------------------------------------------
// dry run
// ---------------------------------------------------------------------------------------------

async function dryRun(
  def: Awaited<ReturnType<typeof loadWorkflow>>,
  repo: string,
): Promise<NonNullable<ValidationReport['dryRun']>> {
  let input: unknown = def.example;
  if (input === undefined) {
    try {
      input = sampleFromSchema(z.toJSONSchema(def.input) as Record<string, unknown>);
    } catch {
      input = {};
    }
  }
  const steps: string[] = [];
  const agents: AgentSeen[] = [];
  const parsed = def.input.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: `example input does not match the input schema: ${parsed.error.message}`,
      input,
      steps,
      agents,
    };
  }
  const dir = mkdtempSync(join(tmpdir(), 'legion-dry-'));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const engines = new Map<EngineKind, FakeEngine>();
    const host: RunHost = {
      repo,
      dryRun: true,
      maxAgents: 8,
      approvals: 'auto',
      agentModel(req) {
        agents.push(req);
        return { model: req.model, effort: req.effort };
      },
      git: simulatedGit(repo),
      account: () => ({
        account: {
          kind: 'claude',
          name: 'dry',
          dir: null,
          token: null,
          env: {},
          remote: false,
          enabled: true,
          source: 'implicit',
        },
      }),
      cooldown() {},
      engine(kind) {
        let engine = engines.get(kind);
        if (!engine) {
          engine = new FakeEngine(kind, defaultScript, `dry-${kind}`);
          engines.set(kind, engine);
        }
        return engine;
      },
      emit(event: RunEvent) {
        if (event.type === 'step' && event.status !== 'started') {
          steps.push(
            `${event.status === 'failed' ? '✗' : '✓'} ${event.kind} ${event.key}${event.detail ? ` (${event.detail})` : ''}`,
          );
        } else if (event.type === 'log') {
          steps.push(`· ${event.message}`);
        }
      },
      async sh() {
        return { code: 0, stdout: '', stderr: '' };
      },
      async interact<I extends Interaction>(interaction: I): Promise<InteractionAnswer<I>> {
        const answer =
          interaction.kind === 'gate'
            ? { choice: 'approve', note: null }
            : interaction.kind === 'ask'
              ? { answer: interaction.options[0] ?? 'example answer' }
              : interaction.kind === 'questions'
                ? {
                    answers: Object.fromEntries(
                      interaction.questions.map((q) => [q.id, [q.options[0]?.label ?? 'example answer']]),
                    ),
                  }
                : { behavior: 'allow', scope: 'once', updatedInput: null };
        return answer as InteractionAnswer<I>;
      },
    };
    await executeInRun({ runId: 'dry-run', host, journal: new Journal(dir), signal: controller.signal }, () =>
      def.run(parsed.data),
    );
    return { ok: true, error: null, input, steps, agents };
  } catch (err) {
    const error = controller.signal.aborted
      ? 'timed out after 30s (an endless loop?)'
      : err instanceof Error
        ? err.message
        : String(err);
    return { ok: false, error, input, steps, agents };
  } finally {
    clearTimeout(timer);
    rmSync(dir, { recursive: true, force: true });
  }
}

function simulatedGit(repo: string): GitOps {
  const wt = (runId: string, name: string): Worktree => ({
    name,
    branch: `legion/${runId}/${name}`,
    path: join(repo, '.legion', 'dry-run', name),
    baseSha: '0000000',
    baseBranch: 'main',
  });
  return {
    integration: async (runId) => wt(runId, 'integration'),
    worktree: async (runId, name) => wt(runId, name),
    commit: async () => ({ sha: '1111111' }),
    squashMerge: async () => ({ ok: true, sha: '2222222' }),
    mergeInto: async () => ({ ok: true, sha: '3333333' }),
    finishMerge: async () => ({ sha: '4444444' }),
    diff: async () => 'diff --git a/example b/example\n',
    changedFiles: async () => ['example'],
    draftPr: async () => ({ url: 'https://github.invalid/dry-run/pull/1' }),
    mergeToBase: async () => ({ sha: '5555555' }),
    remove: async () => {},
    restore: async () => {},
  };
}
