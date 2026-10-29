import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  askUserAnswerInput,
  askUserQuestions,
  type PendingPermission,
  permissionResponse,
  sessionPermissions,
  userMessage,
} from './protocol.ts';

describe('user messages', () => {
  it('are plain text, or image blocks then the text', () => {
    expect(userMessage('hi')).toMatchObject({ type: 'user', message: { role: 'user', content: 'hi' } });
    const dir = mkdtempSync(join(tmpdir(), 'legion-claude-'));
    try {
      writeFileSync(join(dir, 'a.png'), 'PNG');
      const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'UE5H' } };
      expect(userMessage('look', 'next', [join(dir, 'a.png')]).message).toEqual({
        role: 'user',
        content: [image, { type: 'text', text: 'look' }],
      });
      expect(userMessage('', 'next', [join(dir, 'a.png')]).message).toEqual({ role: 'user', content: [image] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

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

describe('AskUserQuestion', () => {
  const input = {
    questions: [
      {
        question: 'Which pieces?',
        header: 'Pieces',
        multiSelect: true,
        options: [
          { label: 'helmet', description: 'Rigid' },
          { label: 'jacket', description: 'Close-fitting' },
        ],
      },
    ],
  };

  it('maps the tool input to questions keyed by their text', () => {
    expect(askUserQuestions(input)).toEqual([
      {
        id: 'Which pieces?',
        header: 'Pieces',
        question: 'Which pieces?',
        options: [
          { label: 'helmet', description: 'Rigid' },
          { label: 'jacket', description: 'Close-fitting' },
        ],
        multiSelect: true,
        allowOther: true,
        secret: false,
      },
    ]);
    expect(askUserQuestions(null)).toEqual([]);
  });

  it('answers with the questions plus comma-joined labels', () => {
    expect(askUserAnswerInput(input, { 'Which pieces?': ['helmet', 'jacket'] })).toEqual({
      ...input,
      answers: { 'Which pieces?': 'helmet, jacket' },
    });
  });
});
