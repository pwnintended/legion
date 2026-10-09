/**
 * A project's prompt additions as Settings → Agents edits them (`projects.prompts` / `projects.setPrompts`):
 * legion.json `prompts`, per role, added after that role's system prompt in this repository
 * (`core/prompts/layers.ts`). Writing replaces only that key, through legion-file.ts.
 */
import { type ProjectPrompts, type PromptsConfig, PromptsConfigSchema, type Role } from '@shared/domain';
import { RpcError } from '@shared/rpc-transport';
import { z } from 'zod';
import { editLegionJson, legionPath, parseConfig, readRaw, revisionOf } from './legion-file';

/** The project's legion.json prompts. Never throws on a bad file. */
export async function readProjectPrompts(root: string): Promise<ProjectPrompts> {
  const path = legionPath(root);
  const raw = await readRaw(path);
  const parsed = raw === null ? null : parseConfig(raw);
  return {
    path,
    exists: raw !== null,
    revision: raw === null ? null : revisionOf(raw),
    error: parsed && 'error' in parsed ? parsed.error : null,
    prompts: (parsed && 'config' in parsed ? parsed.config.prompts : null) ?? {},
  };
}

export interface WriteProjectPromptsInput {
  /** The revision the caller read (`ProjectPrompts.revision`); null when the file was absent. */
  revision: string | null;
  /** Per role, the new text; '' or null removes that role's entry. Roles not given keep theirs. */
  prompts: Partial<Record<Role, string | null>>;
}

/** `json` with `prompts` merged, blank entries dropped and the key removed once empty; other keys in place. */
function rebuild(json: Record<string, unknown>, changes: WriteProjectPromptsInput['prompts']): Record<string, unknown> {
  const current = PromptsConfigSchema.safeParse(json.prompts ?? {});
  const next: Record<string, string> = { ...(current.success ? current.data : {}) };
  for (const [role, text] of Object.entries(changes)) {
    if (text?.trim()) next[role] = text.trim();
    else delete next[role];
  }
  // No prototype: a `__proto__` key stays an own key instead of hitting the prototype setter.
  const out: Record<string, unknown> = Object.create(null);
  const keep = Object.keys(next).length > 0;
  for (const [key, value] of Object.entries(json)) {
    if (key === 'prompts') {
      if (keep) out.prompts = next;
    } else {
      out[key] = value;
    }
  }
  if (keep && !Object.hasOwn(out, 'prompts')) out.prompts = next;
  return out;
}

/**
 * Change the `prompts` key of `<root>/legion.json`, creating the file when absent. `conflict` when the file no
 * longer matches `revision`; `bad_request` for a text over the limit or a file that can't be edited.
 */
export async function writeProjectPrompts(root: string, input: WriteProjectPromptsInput): Promise<ProjectPrompts> {
  const changes = z.partialRecord(z.string(), z.string().nullable()).parse(input.prompts);
  const merged: PromptsConfig = {};
  for (const [role, text] of Object.entries(changes)) if (text?.trim()) merged[role as Role] = text.trim();
  const valid = PromptsConfigSchema.safeParse(merged);
  if (!valid.success) throw new RpcError('bad_request', `invalid prompts: ${z.prettifyError(valid.error)}`);
  await editLegionJson(root, input.revision, (json) => rebuild(json, input.prompts));
  return readProjectPrompts(root);
}
