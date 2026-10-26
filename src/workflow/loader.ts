/**
 * Finds and loads workflow files. Three places, first match by name wins:
 * 1. project: `<repo>/.legion/workflows/<name>.ts` (committed with the repo)
 * 2. user: `~/.config/legion/workflows/<name>.ts`
 * 3. builtin: shipped with Legion (`builtin/workflows`)
 *
 * Workflow files import `legion` (and `zod`) without having them installed: a module resolution hook maps those
 * specifiers to Legion's own copies, so a workflow shares the SDK instance (and its AsyncLocalStorage) with the
 * runtime executing it. Files are plain TypeScript run through Node's type stripping (erasable syntax only).
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isWorkflowDefinition, type WorkflowDefinition } from '../sdk/index.ts';

export type WorkflowSource = 'project' | 'user' | 'builtin';

export interface WorkflowFile {
  name: string;
  source: WorkflowSource;
  file: string;
  /** Lower-priority files with the same name that this one overrides. */
  shadows: { source: WorkflowSource; file: string }[];
}

const SELF_IS_TS = import.meta.url.endsWith('.ts');

/** Legion's package root (the directory with its package.json). */
export const PACKAGE_ROOT = (() => {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        if ((JSON.parse(readFileSync(pkg, 'utf8')) as { name?: string }).name === 'legion') return dir;
      } catch {
        // Keep walking.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error('Cannot find the legion package root');
    dir = parent;
  }
})();

export const SDK_URL = new URL(`../sdk/index.${SELF_IS_TS ? 'ts' : 'js'}`, import.meta.url).href;
/** The SDK's type entry, for type-checking workflow files. */
export const SDK_TYPES = SELF_IS_TS ? fileURLToPath(SDK_URL) : join(PACKAGE_ROOT, 'dist', 'src', 'sdk', 'index.d.ts');

export function builtinDir(): string {
  return SELF_IS_TS ? join(PACKAGE_ROOT, 'builtin', 'workflows') : join(PACKAGE_ROOT, 'dist', 'builtin', 'workflows');
}

/** Where the TypeScript sources of the builtins live (for `eject`, and as examples for the assistant). */
export function builtinSourceDir(): string {
  return join(PACKAGE_ROOT, 'builtin', 'workflows');
}

export function configHome(): string {
  return process.env.XDG_CONFIG_HOME
    ? join(process.env.XDG_CONFIG_HOME, 'legion')
    : join(homedir(), '.config', 'legion');
}

export function projectWorkflowDir(repo: string): string {
  return join(repo, '.legion', 'workflows');
}

export function userWorkflowDir(): string {
  return join(configHome(), 'workflows');
}

let hooksInstalled = false;

/** Maps `legion` and `zod` imports in workflow files to Legion's own modules. Idempotent. */
export function installSdkResolution(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === 'legion') {
        return { url: SDK_URL, shortCircuit: true, format: SELF_IS_TS ? 'module-typescript' : 'module' };
      }
      // Resolve zod as if Legion imported it (workflow files have no node_modules of their own).
      if (specifier === 'zod' || specifier.startsWith('zod/')) {
        return nextResolve(specifier, { ...context, parentURL: import.meta.url });
      }
      return nextResolve(specifier, context);
    },
  });
}

function filesIn(dir: string, exts: readonly string[]): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => exts.includes(extname(f)) && !f.startsWith('_') && !/\.(test|d)\.[jt]s$/.test(f))
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

export function workflowName(file: string): string {
  return basename(file, extname(file));
}

/** Every workflow visible from `repo`, by name, with the winning file first. */
export function listWorkflowFiles(repo: string): WorkflowFile[] {
  const layers: [WorkflowSource, string[]][] = [
    ['project', filesIn(projectWorkflowDir(repo), ['.ts'])],
    ['user', filesIn(userWorkflowDir(), ['.ts'])],
    ['builtin', filesIn(builtinDir(), SELF_IS_TS ? ['.ts'] : ['.js'])],
  ];
  const byName = new Map<string, WorkflowFile>();
  for (const [source, files] of layers) {
    for (const file of files) {
      const name = workflowName(file);
      const existing = byName.get(name);
      if (existing) existing.shadows.push({ source, file });
      else byName.set(name, { name, source, file, shadows: [] });
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function findWorkflow(repo: string, nameOrPath: string): WorkflowFile | null {
  if (nameOrPath.includes('/') || nameOrPath.endsWith('.ts')) {
    const file = resolve(repo, nameOrPath);
    return existsSync(file) ? { name: workflowName(file), source: 'project', file, shadows: [] } : null;
  }
  return listWorkflowFiles(repo).find((w) => w.name === nameOrPath) ?? null;
}

/** The TypeScript source of a workflow (builtins run compiled, but their sources ship too). */
export function workflowSource(w: WorkflowFile): string {
  return w.source === 'builtin' ? join(builtinSourceDir(), `${w.name}.ts`) : w.file;
}

/** Copies a workflow into the project's `.legion/workflows` so it can be edited there; the copy then wins. */
export function ejectWorkflow(repo: string, name: string, as?: string): { path: string; from: WorkflowFile } {
  const found = findWorkflow(repo, name);
  if (!found) throw new Error(`No workflow named "${name}"`);
  const dir = projectWorkflowDir(repo);
  const target = join(dir, `${as ?? found.name}.ts`);
  if (existsSync(target)) throw new Error(`${target} already exists`);
  mkdirSync(dir, { recursive: true });
  const source = workflowSource(found);
  copyFileSync(source, target);
  // Helpers it imports (`./_tasks.ts`) come along unless the project has its own.
  for (const m of readFileSync(source, 'utf8').matchAll(/from '\.\/(_[\w-]+\.ts)'/g)) {
    const helper = m[1] as string;
    if (!existsSync(join(dir, helper))) copyFileSync(join(dirname(source), helper), join(dir, helper));
  }
  return { path: target, from: found };
}

/** Imports a workflow file fresh (edits since the last load are picked up). */
export async function loadWorkflow(file: string): Promise<WorkflowDefinition> {
  installSdkResolution();
  // The query busts Node's module cache after edits. Vitest's transformer infers the language from the URL, so
  // there the plain URL is used (tests do not edit workflows mid-run).
  const base = pathToFileURL(file).href;
  const url = process.env.VITEST ? base : `${base}?v=${statSync(file).mtimeMs}`;
  const mod = (await import(url)) as { default?: unknown };
  if (!isWorkflowDefinition(mod.default)) {
    throw new Error(`${file} must \`export default workflow({...}, async (input) => {...})\` (imported from 'legion')`);
  }
  return mod.default;
}
