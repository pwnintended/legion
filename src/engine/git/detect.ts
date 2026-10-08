import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type GateSpec, PackageManagerSchema } from '@shared/domain';
import { detectLockfile, type PackageManager } from './provision';

// ---------------------------------------------------------------------------------------------
// Project gate detection: one detector per ecosystem; add an ecosystem by appending to DETECTORS.
// ---------------------------------------------------------------------------------------------

export interface ProjectDetector {
  id: string;
  detect(dir: string): Promise<GateSpec[]>;
}

/** The script `npm init` writes when there are no tests. */
const NPM_PLACEHOLDER_TEST = 'echo "Error: no test specified" && exit 1';

/** Gate name -> script names to look for, in order of preference. */
const NODE_GATES: readonly { name: string; scripts: readonly string[] }[] = [
  { name: 'test', scripts: ['test'] },
  { name: 'typecheck', scripts: ['typecheck', 'type-check'] },
  { name: 'lint', scripts: ['lint'] },
];

interface PackageJson {
  packageManager?: unknown;
  scripts?: unknown;
}

/** `<dir>/package.json` as an object, or null when it is missing or not a JSON object. */
async function readPackageJson(dir: string): Promise<PackageJson | null> {
  let raw: string;
  try {
    raw = await readFile(join(dir, 'package.json'), 'utf8');
  } catch {
    return null;
  }
  try {
    const json: unknown = JSON.parse(raw);
    return json && typeof json === 'object' && !Array.isArray(json) ? (json as PackageJson) : null;
  } catch {
    return null;
  }
}

/** The command that runs package.json script `script` with `pm`. */
function scriptCommand(pm: PackageManager, script: string): string {
  switch (pm) {
    case 'pnpm':
      return script === 'test' ? 'pnpm test' : `pnpm run ${script}`;
    case 'npm':
      return script === 'test' ? 'npm test' : `npm run ${script}`;
    case 'yarn':
      return `yarn ${script}`;
    case 'bun':
      // `bun test` is bun's own test runner, not the package.json script.
      return `bun run ${script}`;
  }
}

async function packageManagerFor(dir: string, pkg: PackageJson | null): Promise<PackageManager | null> {
  if (typeof pkg?.packageManager === 'string') {
    const parsed = PackageManagerSchema.safeParse(pkg.packageManager.split('@')[0]);
    if (parsed.success) return parsed.data;
  }
  const lock = await detectLockfile(dir);
  if (lock) return lock.manager;
  return pkg ? 'npm' : null;
}

/**
 * The package manager of the project in `dir`: package.json `packageManager` (e.g. `pnpm@9`), else the
 * lockfile, else npm when a package.json exists; null otherwise.
 */
export async function detectPackageManager(dir: string): Promise<PackageManager | null> {
  return packageManagerFor(dir, await readPackageJson(dir));
}

const nodeDetector: ProjectDetector = {
  id: 'node',
  async detect(dir) {
    const pkg = await readPackageJson(dir);
    if (!pkg?.scripts || typeof pkg.scripts !== 'object') return [];
    const scripts = pkg.scripts as Record<string, unknown>;
    const pm = (await packageManagerFor(dir, pkg)) ?? 'npm';
    const gates: GateSpec[] = [];
    for (const { name, scripts: candidates } of NODE_GATES) {
      const script = candidates.find((s) => {
        const body = scripts[s];
        return typeof body === 'string' && body.trim() !== '' && body.trim() !== NPM_PLACEHOLDER_TEST;
      });
      if (script) gates.push({ name, command: scriptCommand(pm, script), blocking: true, source: 'detected' });
    }
    return gates;
  },
};

export const DETECTORS: readonly ProjectDetector[] = [nodeDetector];

/** The gates every detector in {@link DETECTORS} finds in `dir`, concatenated in registry order. */
export async function detectProjectGates(dir: string): Promise<GateSpec[]> {
  const results = await Promise.all(DETECTORS.map((d) => d.detect(dir)));
  return results.flat();
}
