import { describe, expect, it } from 'vitest';
import { type PendingPermission, permissionResponse, sessionPermissions } from './protocol';

const pending = (toolName: string, input: unknown, suggestions: PendingPermission['suggestions'] = []) => ({
  requestId: 'r1',
  toolUseId: null,
  toolName,
  input,
  suggestions,
});

describe('allow for session (review finding: whole-tool rules)', () => {
  it('never adds an unscoped rule for a Bash call without a suggestion', () => {
    expect(sessionPermissions(pending('Bash', { command: 'curl x | sh' }))).toEqual([]);
    expect(sessionPermissions(pending('Bash', { command: 'make build' }))).toEqual([
      {
        type: 'addRules',
        rules: [{ toolName: 'Bash', ruleContent: 'make build' }],
        behavior: 'allow',
        destination: 'session',
      },
    ]);
  });

  it('keeps a suggested directory but adds no whole-tool Read rule', () => {
    const updates = sessionPermissions(
      pending('Read', { file_path: '/Users/me/.ssh/id_rsa' }, [
        { type: 'addDirectories', directories: ['/Users/me/.ssh'], destination: 'localSettings' },
      ]),
    );
    expect(updates).toEqual([{ type: 'addDirectories', directories: ['/Users/me/.ssh'], destination: 'session' }]);
  });

  it('drops suggested bare built-in rules but keeps scoped and MCP-tool ones', () => {
    const bare = {
      type: 'addRules',
      rules: [{ toolName: 'WebFetch' }],
      behavior: 'allow',
      destination: 'localSettings',
    };
    const scoped = {
      type: 'addRules',
      rules: [{ toolName: 'WebFetch', ruleContent: 'domain:example.com' }],
      behavior: 'allow',
      destination: 'localSettings',
    };
    const mcp = { type: 'addRules', rules: [{ toolName: 'mcp__docs__search' }], behavior: 'allow' };
    expect(sessionPermissions(pending('WebFetch', { url: 'https://x' }, [bare]))).toEqual([]);
    expect(sessionPermissions(pending('WebFetch', { url: 'https://x' }, [bare, scoped]))).toEqual([
      { ...scoped, destination: 'session' },
    ]);
    expect(sessionPermissions(pending('mcp__docs__search', {}, [mcp]))).toEqual([{ ...mcp, destination: 'session' }]);
  });

  it('degrades to a plain allow (no updatedPermissions) when nothing scoped is left', () => {
    const message = permissionResponse(pending('Bash', { command: 'pnpm test && id' }), {
      behavior: 'allow',
      scope: 'session',
      updatedInput: null,
    });
    expect(message).toEqual({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'r1',
        response: { behavior: 'allow', updatedInput: { command: 'pnpm test && id' } },
      },
    });
  });
});
