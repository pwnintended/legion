/**
 * MCP servers the user already has configured for Claude Code, offered for import into Legion's registry:
 * `mcpServers` in `~/.claude.json` (user scope) and the project's `.mcp.json`. Nothing is used until it is
 * imported and granted; a server that does not fit the registry's shape (sse, bad name) is skipped.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { McpServerNameSchema, McpServerSchema } from '@shared/domain';
import type { DiscoveredMcpServer } from '@shared/rpc';

export type { DiscoveredMcpServer };

async function readServers(file: string): Promise<Record<string, unknown>> {
  const text = await readFile(file, 'utf8').catch(() => null);
  if (text === null) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    const servers = (parsed as { mcpServers?: unknown } | null)?.mcpServers;
    return servers && typeof servers === 'object' && !Array.isArray(servers)
      ? (servers as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export async function discoverMcpServers(home: string, repoPath: string | null): Promise<DiscoveredMcpServer[]> {
  const sources: { file: string; source: string }[] = [{ file: join(home, '.claude.json'), source: '~/.claude.json' }];
  if (repoPath) sources.push({ file: join(repoPath, '.mcp.json'), source: '.mcp.json' });
  const found = new Map<string, DiscoveredMcpServer>();
  for (const { file, source } of sources) {
    for (const [name, raw] of Object.entries(await readServers(file))) {
      if (!McpServerNameSchema.safeParse(name).success || !raw || typeof raw !== 'object') continue;
      // Claude Code's stdio entries may leave `type` out.
      const withType = { type: 'command' in raw ? 'stdio' : undefined, ...raw };
      const parsed = McpServerSchema.safeParse(withType);
      if (parsed.success && !found.has(name)) found.set(name, { name, server: parsed.data, source });
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}
