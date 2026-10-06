import { describe, expect, it } from 'vitest';
import { buildDraftPrArgs, buildPrViewArgs, buildPushArgs, parsePrStatus, parsePrUrl } from './remote';

describe('gh/git argument construction', () => {
  it('push', () => {
    expect(buildPushArgs('legion/r/integration')).toEqual([
      'push',
      '-u',
      'origin',
      'refs/heads/legion/r/integration:refs/heads/legion/r/integration',
    ]);
    expect(buildPushArgs('b', { remote: 'fork', setUpstream: false, forceWithLease: true })).toEqual([
      'push',
      '--force-with-lease',
      'fork',
      'refs/heads/b:refs/heads/b',
    ]);
  });

  it('draft PR', () => {
    expect(
      buildDraftPrArgs({
        base: 'main',
        head: 'legion/r/integration',
        title: 'Fix it',
        bodyFile: '/tmp/body.md',
        labels: ['legion', 'bot'],
      }),
    ).toEqual([
      'pr',
      'create',
      '--draft',
      '--base',
      'main',
      '--head',
      'legion/r/integration',
      '--title',
      'Fix it',
      '--body-file',
      '/tmp/body.md',
      '--label',
      'legion',
      '--label',
      'bot',
    ]);
    expect(buildDraftPrArgs({ base: 'm', head: 'h', title: 't', bodyFile: 'f' })).not.toContain('--label');
  });

  it('pr view / parsing', () => {
    expect(buildPrViewArgs('b')).toEqual(['pr', 'view', 'b', '--json', 'state,url,number,isDraft,mergedAt']);
    expect(parsePrUrl('Creating draft pull request...\n\nhttps://github.com/o/r/pull/42\n')).toEqual({
      url: 'https://github.com/o/r/pull/42',
      number: 42,
    });
    expect(() => parsePrUrl('nothing')).toThrow();
    expect(
      parsePrStatus('{"state":"MERGED","url":"u","number":3,"isDraft":false,"mergedAt":"2026-01-01T00:00:00Z"}'),
    ).toEqual({
      state: 'MERGED',
      url: 'u',
      number: 3,
      isDraft: false,
      mergedAt: '2026-01-01T00:00:00Z',
    });
    expect(parsePrStatus('{"state":"OPEN","url":"u","number":1,"isDraft":true,"mergedAt":null}').mergedAt).toBeNull();
  });
});
