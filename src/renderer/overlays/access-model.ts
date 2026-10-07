/**
 * Pure helpers for the Access settings (MCP servers and skills per agent): turning the add-server form into
 * a registry entry, and the small list edits behind the toggles. Mirrors `McpServerNameSchema` and
 * `McpServerSchema` (shared/domain.ts) without importing them: values from there pull zod into this chunk.
 */
import type { McpServer } from '@shared/domain';
import type { Parsed } from './settings-model';

const NAME = /^[A-Za-z][A-Za-z0-9-]{0,39}$/;

export function parseServerName(text: string, taken: readonly string[]): Parsed<string> {
  const name = text.trim();
  if (!NAME.test(name)) return { ok: false, message: 'Letters, digits and "-", starting with a letter (max 40).' };
  if (name.toLowerCase() === 'legion') return { ok: false, message: "'legion' is reserved for Legion's own server." };
  if (taken.includes(name)) return { ok: false, message: `There is already a server called ${name}.` };
  return { ok: true, value: name };
}

/** `Key: value` (headers) or `KEY=value` (env) per line; blank lines are skipped. */
export function parsePairs(text: string, separator: ':' | '='): Parsed<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [i, raw] of text.split('\n').entries()) {
    const line = raw.trim();
    if (line === '') continue;
    const at = line.indexOf(separator);
    if (at <= 0)
      return { ok: false, message: `Line ${i + 1}: use ${separator === ':' ? 'Name: value' : 'NAME=value'}.` };
    out[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return { ok: true, value: out };
}

export function formatPairs(pairs: Record<string, string>, separator: ':' | '='): string {
  return Object.entries(pairs)
    .map(([key, value]) => (separator === ':' ? `${key}: ${value}` : `${key}=${value}`))
    .join('\n');
}

/** Split a command line on whitespace; quotes group (`--flag "a b"`). */
export function parseArgs(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) out.push(match[1] ?? match[2] ?? match[3] ?? '');
  return out;
}

export function formatArgs(args: readonly string[]): string {
  return args.map((arg) => (/[\s"']/.test(arg) || arg === '' ? JSON.stringify(arg) : arg)).join(' ');
}

export interface ServerForm {
  type: 'http' | 'stdio';
  url: string;
  /** `Name: value` per line. */
  headers: string;
  /** Executable followed by its arguments. */
  command: string;
  /** `NAME=value` per line. */
  env: string;
}

export const EMPTY_FORM: ServerForm = { type: 'http', url: '', headers: '', command: '', env: '' };

export function serverFromForm(form: ServerForm): Parsed<McpServer> {
  if (form.type === 'http') {
    const url = form.url.trim();
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('protocol');
    } catch {
      return { ok: false, message: 'Enter a full http(s) URL, e.g. https://mcp.example.com/mcp.' };
    }
    const headers = parsePairs(form.headers, ':');
    if (!headers.ok) return headers;
    return { ok: true, value: { type: 'http', url, headers: headers.value } };
  }
  const [command, ...args] = parseArgs(form.command);
  if (!command) return { ok: false, message: 'Enter the command that starts the server, e.g. npx -y @acme/mcp.' };
  const env = parsePairs(form.env, '=');
  if (!env.ok) return env;
  return { ok: true, value: { type: 'stdio', command, args, env: env.value } };
}

export function formFromServer(server: McpServer): ServerForm {
  return server.type === 'http'
    ? { ...EMPTY_FORM, type: 'http', url: server.url, headers: formatPairs(server.headers, ':') }
    : {
        ...EMPTY_FORM,
        type: 'stdio',
        command: formatArgs([server.command, ...server.args]),
        env: formatPairs(server.env, '='),
      };
}

/** One-line description of a server for the registry list (never shows header or env values). */
export function serverSummary(server: McpServer): string {
  if (server.type === 'http') {
    const n = Object.keys(server.headers).length;
    return n > 0 ? `${server.url} · ${n} header${n === 1 ? '' : 's'}` : server.url;
  }
  return formatArgs([server.command, ...server.args]);
}

/** `list` with `name` added or removed, in a stable order (registry order for servers, name order for skills). */
export function toggled(list: readonly string[], name: string, order: readonly string[] = []): string[] {
  const next = list.includes(name) ? list.filter((n) => n !== name) : [...list, name];
  const rank = (n: string) => {
    const i = order.indexOf(n);
    return i === -1 ? order.length : i;
  };
  return next.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}
