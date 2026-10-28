/**
 * The box image: the snapshot remote mode starts every box from, made by the box agent (the builtin `box` workflow).
 * What it holds is described by two files the box agent maintains in the project, which are worth committing:
 *
 * - `.legion/box/provision.sh`: an idempotent script that installs the project's toolchain and dependencies.
 * - `.legion/box/env.sh`: sourced before every command in a box (PATH and the like).
 *
 * Which snapshot is current is per machine and account: `.legion/box/image.local.json` (gitignored).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface BoxImage {
  snapshot: string;
  /** Where the image's warm clone of the repository is (it becomes the worktree of a box made from it). */
  clone: string;
  /** When it was made, and the run that made it. */
  builtAt: number;
  runId: string;
  /** What the box agent was asked to add, and what it reported. */
  requests: string[];
  summary: string;
}

export const BOX_DIR = join('.legion', 'box');
export const PROVISION_FILE = join(BOX_DIR, 'provision.sh');
export const ENV_FILE = join(BOX_DIR, 'env.sh');
const IMAGE_FILE = join(BOX_DIR, 'image.local.json');

export function readImage(repo: string): BoxImage | null {
  try {
    const image = JSON.parse(readFileSync(join(repo, IMAGE_FILE), 'utf8')) as BoxImage;
    return typeof image.snapshot === 'string' && typeof image.clone === 'string' ? image : null;
  } catch {
    return null;
  }
}

export function writeImage(repo: string, image: BoxImage): void {
  const file = join(repo, IMAGE_FILE);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(image, null, 2)}\n`);
}

/** The box files in `dir` (a checkout or a worktree); null for one that is missing. */
export function readBoxFiles(dir: string): { provision: string | null; env: string | null } {
  const read = (rel: string) => (existsSync(join(dir, rel)) ? readFileSync(join(dir, rel), 'utf8') : null);
  return { provision: read(PROVISION_FILE), env: read(ENV_FILE) };
}

/** Writes the box files that are given into `dir`; returns the paths it changed. */
export function writeBoxFiles(dir: string, files: { provision: string | null; env: string | null }): string[] {
  const changed: string[] = [];
  for (const [rel, text] of [
    [PROVISION_FILE, files.provision],
    [ENV_FILE, files.env],
  ] as const) {
    if (text === null) continue;
    const file = join(dir, rel);
    if (existsSync(file) && readFileSync(file, 'utf8') === text) continue;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text, { mode: rel === PROVISION_FILE ? 0o755 : 0o644 });
    changed.push(rel);
  }
  return changed;
}
