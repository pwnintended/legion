/**
 * Edits single settings in a config file without disturbing the rest: comments, spacing and other keys stay as
 * the user wrote them. A commented-out key (`# model = "opus"`) is uncommented in place; removing a key comments
 * it out, so its line stays as a hint.
 */
import { parse } from 'smol-toml';

export type TomlScalar = string | number | boolean;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function format(value: TomlScalar): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

/** A table path as a TOML header name: `workflow."*".agent.plan`. */
export function tableName(path: readonly string[]): string {
  return path.map((p) => (/^[A-Za-z0-9_-]+$/.test(p) ? p : JSON.stringify(p))).join('.');
}

/**
 * Sets `key` in the table at `path` (`['workflow', 'feature', 'claude']`), or removes it with null. The table is
 * found by its `[header]`; a value set some other way (an inline table, a dotted key) makes the result invalid,
 * which the final check turns into an error rather than a broken file.
 */
export function setTomlValue(
  text: string,
  path: string | readonly string[],
  key: string,
  value: TomlScalar | null,
): string {
  const parts = typeof path === 'string' ? [path] : path;
  const section = tableName(parts);
  const lines = text.split('\n');
  const header = new RegExp(`^\\s*\\[\\s*${escapeRe(section)}\\s*\\]\\s*(#.*)?$`);
  const start = lines.findIndex((l) => header.test(l));
  const assignment = new RegExp(
    `^(\\s*)(#\\s*)?(${escapeRe(key)})(\\s*=\\s*)("(?:[^"\\\\]|\\\\.)*"|'[^']*'|[^\\s#]+)(\\s*#.*)?$`,
  );

  const unplaceable = () =>
    new Error(`Could not set ${section}.${key} in the config file; edit it by hand (/config edit)`);
  let existing: unknown;
  try {
    existing = getPath(parse(text) as Record<string, unknown>, [...parts, key]);
  } catch {
    throw unplaceable();
  }

  if (start === -1) {
    // Set some other way (an inline table, dotted keys): do not add a second definition.
    if (existing !== undefined) throw unplaceable();
    if (value === null) return text;
    const body = text.replace(/\n*$/, '');
    return `${body}${body ? '\n\n' : ''}[${section}]\n${key} = ${format(value)}\n`;
  }
  let end = lines.findIndex((l, i) => i > start && /^\s*\[/.test(l));
  if (end === -1) end = lines.length;

  let active = -1;
  let commented = -1;
  for (let i = start + 1; i < end; i++) {
    const m = assignment.exec(lines[i] ?? '');
    if (!m) continue;
    if (m[2] === undefined) active = i;
    else if (commented === -1) commented = i;
  }
  const at = active !== -1 ? active : commented;
  if (at !== -1) {
    const m = assignment.exec(lines[at] ?? '') as RegExpExecArray;
    const [, indent = '', hash = '', name, eq, old = '', comment = ''] = m;
    if (value === null) {
      if (active !== -1) lines[at] = `${indent}# ${name}${eq}${old}${comment}`;
    } else {
      // Keep a trailing comment in its column.
      const prefix = `${indent}${name}${eq}${format(value)}`;
      const note = comment.trimStart();
      // An uncommented line loses its `# `, so its comment moves left with it.
      const column = `${indent}${hash}${name}${eq}${old}`.length + comment.length - note.length - hash.length;
      lines[at] = note ? `${prefix}${' '.repeat(Math.max(1, column - prefix.length))}${note}` : prefix;
    }
  } else if (existing !== undefined) {
    throw unplaceable();
  } else if (value !== null) {
    let last = end - 1;
    while (last > start && !(lines[last] ?? '').trim()) last--;
    lines.splice(last + 1, 0, `${key} = ${format(value)}`);
  }
  const out = lines.join('\n');
  let check: unknown;
  try {
    check = getPath(parse(out) as Record<string, unknown>, [...parts, key]);
  } catch {
    check = Symbol('invalid');
  }
  if (value === null ? check !== undefined : check !== value) {
    throw unplaceable();
  }
  return out;
}

/** `a.b` in a parsed TOML document. */
export function getPath(doc: Record<string, unknown>, path: string | readonly string[]): unknown {
  let cur: unknown = doc;
  for (const part of typeof path === 'string' ? path.split('.') : path) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}
