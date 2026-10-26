import { describe, expect, it } from 'vitest';
import { setTomlValue } from './config-file.ts';

const doc = `# top
[assistant]
engine = "claude"            # who you talk to
# model  = "opus"            # optional

[workflows]
maxAgents = 4                # at once
`;

describe('setTomlValue', () => {
  it('replaces a value and keeps its comment in place', () => {
    const out = setTomlValue(doc, 'workflows', 'maxAgents', 12);
    expect(out).toContain('maxAgents = 12               # at once');
    expect(out).toContain('# top');
  });

  it('uncomments a commented-out key, and comments it out again on removal', () => {
    const on = setTomlValue(doc, 'assistant', 'model', 'sonnet');
    expect(on).toContain('model  = "sonnet"          # optional');
    const off = setTomlValue(on, 'assistant', 'model', null);
    expect(off).toContain('# model  = "sonnet"');
  });

  it('adds missing keys to their section and missing sections at the end', () => {
    const out = setTomlValue(doc, 'assistant', 'effort', 'high');
    expect(out).toMatch(/# model {2}= "opus" {12}# optional\neffort = "high"\n\n\[workflows\]/);
    expect(setTomlValue('', 'claude', 'default', 'claude-2')).toBe('[claude]\ndefault = "claude-2"\n');
  });

  it('addresses nested and quoted tables', () => {
    let out = setTomlValue('', ['workflow', '*', 'codex'], 'effort', 'high');
    out = setTomlValue(out, ['workflow', 'feature', 'agent', 'plan'], 'model', 'opus');
    expect(out).toBe('[workflow."*".codex]\neffort = "high"\n\n[workflow.feature.agent.plan]\nmodel = "opus"\n');
  });

  it('refuses to write a value it cannot place', () => {
    const inline = '[workflow.feature]\nclaude = { model = "opus" }\n';
    expect(() => setTomlValue(inline, ['workflow', 'feature', 'claude'], 'model', 'sonnet')).toThrow(/by hand/);
  });
});
