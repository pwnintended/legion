import type { ProjectPrompts } from '@shared/domain';
import { describe, expect, it } from 'vitest';
import {
  dirtyRoles,
  discardDrafts,
  draftText,
  editDraft,
  loadDone,
  loadFailed,
  saveDone,
  saveFailed,
  startLoad,
  startSave,
} from './prompts-model';

const file = (prompts: ProjectPrompts['prompts'], revision = 'r1'): ProjectPrompts => ({
  path: '/repo/legion.json',
  exists: true,
  revision,
  error: null,
  prompts,
});

describe('project prompts session', () => {
  it('ignores an answer for a project it no longer shows', () => {
    const first = startLoad('a', 1);
    const second = startLoad('b', 2);
    expect(loadDone(second, 1, file({ coder: 'x' }))).toBe(second);
    expect(loadFailed(second, 1, 'gone')).toBe(second);
    expect(loadDone(first, 1, file({})).load.status).toBe('ready');
  });

  it('keeps drafts per role and counts only the ones that differ from the file', () => {
    let s = loadDone(startLoad('a', 1), 1, file({ coder: 'Lint first.' }));
    expect(draftText(s, 'coder')).toBe('Lint first.');
    s = editDraft(s, 'coder', 'Lint first.  ');
    expect(dirtyRoles(s)).toEqual([]);
    s = editDraft(s, 'reviewer', 'Tests before style.');
    s = editDraft(s, 'coder', '');
    expect(dirtyRoles(s).sort()).toEqual(['coder', 'reviewer']);
    expect(draftText(s, 'coder')).toBe('');
    expect(dirtyRoles(discardDrafts(s))).toEqual([]);
  });

  it('saves every changed role at once, a blank one as a removal', () => {
    let s = loadDone(startLoad('a', 1), 1, file({ coder: 'Lint first.' }));
    expect(startSave(s, 2)).toBeNull();
    s = editDraft(editDraft(s, 'coder', ' '), 'reviewer', 'Tests before style.');
    const started = startSave(s, 2);
    expect(started?.request).toEqual({
      projectId: 'a',
      revision: 'r1',
      prompts: { coder: null, reviewer: 'Tests before style.' },
    });
    expect(startSave(started?.session ?? s, 3)).toBeNull();
  });

  it('takes the saved file as the truth, keeping a draft typed while it saved', () => {
    let s = loadDone(startLoad('a', 1), 1, file({}));
    s = editDraft(s, 'coder', 'Lint first.');
    const started = startSave(s, 2);
    if (!started) throw new Error('expected a save');
    s = editDraft(started.session, 'reviewer', 'Typed during the save.');
    s = saveDone(s, 2, file({ coder: 'Lint first.' }, 'r2'));
    expect(s.save.status).toBe('saved');
    expect(s.load.status === 'ready' && s.load.data.revision).toBe('r2');
    expect(dirtyRoles(s)).toEqual(['reviewer']);
  });

  it('reports a failed save and says whether it was a conflict, only for the current save', () => {
    let s = loadDone(startLoad('a', 1), 1, file({}));
    s = editDraft(s, 'coder', 'x');
    const started = startSave(s, 2);
    if (!started) throw new Error('expected a save');
    expect(saveFailed(started.session, 9, 'late', false)).toBe(started.session);
    const failed = saveFailed(started.session, 2, 'changed on disk', true);
    expect(failed.save).toEqual({ status: 'error', message: 'changed on disk', conflict: true });
    expect(dirtyRoles(failed)).toEqual(['coder']);
  });

  it('refuses to save over an invalid file', () => {
    const s = editDraft(
      loadDone(startLoad('a', 1), 1, { ...file({}), error: 'legion.json: invalid JSON' }),
      'coder',
      'x',
    );
    expect(startSave(s, 2)).toBeNull();
  });
});
