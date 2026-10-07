import { describe, expect, it } from 'vitest';
import { formatResearchReport, REPORT_MAX_CHARS } from './research';

describe('formatResearchReport', () => {
  it('renders summary, findings with evidence and sources, and open questions', () => {
    const text = formatResearchReport('Auth flow', {
      summary: 'Sessions are cookie based.',
      findings: [
        { claim: 'Login lives in src/auth.ts', evidence: '`login()` sets the cookie.', sources: ['src/auth.ts'] },
        { claim: 'No refresh tokens', evidence: '', sources: [] },
      ],
      openQuestions: ['Is the cookie HttpOnly in production?'],
      confidence: 'medium',
    });
    expect(text).toContain('**Research: Auth flow** (confidence medium)');
    expect(text).toContain('Sessions are cookie based.');
    expect(text).toContain('- **Login lives in src/auth.ts**\n  `login()` sets the cookie.\n  Sources: `src/auth.ts`');
    expect(text).toContain('- **No refresh tokens**');
    expect(text).toContain('**Open questions**\n\n- Is the cookie HttpOnly in production?');
  });

  it('stays bounded', () => {
    const text = formatResearchReport('Big', {
      summary: 'x'.repeat(REPORT_MAX_CHARS * 2),
      findings: [],
      openQuestions: [],
      confidence: 'low',
    });
    expect(text.length).toBeLessThanOrEqual(REPORT_MAX_CHARS + 50);
  });
});
