import { resolveGateSettings } from '@engine/orchestrator/core/gates';
import type { GateSpec, GatesConfig, ProjectGates } from '@shared/domain';
import { describe, expect, it } from 'vitest';
import {
  addCommand,
  addGlob,
  detectedState,
  discardEdits,
  editSession,
  effectiveGates,
  formFromProjectGates,
  type GatesForm,
  gatesConfigFromForm,
  hasErrors,
  isDirty,
  loadDone,
  loadFailed,
  moveVerify,
  removeCommand,
  removeGlob,
  removeVerify,
  restoreGate,
  saveDone,
  saveFailed,
  startLoad,
  startSave,
  suppressGate,
  updateCommand,
  updateGlob,
  validateGatesForm,
} from './gates-model';

const DETECTED: GateSpec[] = [
  { name: 'test', command: 'pnpm test', blocking: true, source: 'detected' },
  { name: 'typecheck', command: 'pnpm typecheck', blocking: true, source: 'detected' },
  { name: 'lint', command: 'pnpm lint', blocking: true, source: 'detected' },
];

function project(gates: GatesConfig | null, verify: string[] = []): ProjectGates {
  return {
    path: '/repo/legion.json',
    exists: true,
    revision: 'abc',
    error: null,
    gates,
    verify,
    detected: DETECTED,
    packageManager: 'pnpm',
    resolved: [],
    settings: resolveGateSettings({ gates, verify }),
  };
}

const row = (form: GatesForm, name: string) => {
  const found = form.commands.find((c) => c.name === name);
  if (!found) throw new Error(`no row ${name}`);
  return found;
};

describe('round trip', () => {
  it.each<[string, GatesConfig | null]>([
    ['no gates', null],
    ['an empty object', {}],
    [
      'every shape',
      {
        detect: false,
        commands: {
          test: 'pnpm test',
          e2e: { run: 'pnpm e2e', blocking: false },
          strict: { run: 'pnpm strict', blocking: true },
          plain: { run: 'pnpm plain' },
          lint: false,
        },
        scope: 'warn',
        secrets: { mode: 'warn', allow: ['fixtures/**'] },
      },
    ],
    ['defaults written out', { detect: true, scope: 'block', secrets: 'block' }],
    ['a bare secrets mode', { secrets: 'off' }],
    ['secrets with only an allowlist', { secrets: { allow: ['a/**', 'b/*.pem'] } }],
    ['secrets with an empty object', { secrets: {} }],
    ['empty commands', { commands: {} }],
  ])('keeps %s as it was', (_, gates) => {
    const form = formFromProjectGates(project(gates, ['pnpm test']));
    expect(gatesConfigFromForm(form)).toEqual({ gates });
    expect(isDirty(form)).toBe(false);
  });
});

describe('edits', () => {
  const base = () =>
    formFromProjectGates(
      project({ commands: { test: 'pnpm test', e2e: { run: 'pnpm e2e', blocking: false } } }, ['pnpm typecheck']),
    );

  it('adds a gate', () => {
    let form = addCommand(base());
    const added = form.commands.at(-1);
    expect(added).toMatchObject({ name: '', run: '' });
    form = updateCommand(form, added?.id ?? '', { name: 'db:check', run: ' pnpm db:check ' });
    expect(gatesConfigFromForm(form).gates?.commands).toEqual({
      test: 'pnpm test',
      e2e: { run: 'pnpm e2e', blocking: false },
      'db:check': 'pnpm db:check',
    });
    expect(isDirty(form)).toBe(true);
  });

  it('renames a gate, keeping its place and value', () => {
    const form = base();
    const next = updateCommand(form, row(form, 'e2e').id, { name: 'browser' });
    expect(Object.entries(gatesConfigFromForm(next).gates?.commands ?? {})).toEqual([
      ['test', 'pnpm test'],
      ['browser', { run: 'pnpm e2e', blocking: false }],
    ]);
  });

  it('edits the command and the blocking flag', () => {
    const form = base();
    let next = updateCommand(form, row(form, 'test').id, { blocking: false });
    next = updateCommand(next, row(next, 'e2e').id, { blocking: true });
    expect(gatesConfigFromForm(next).gates?.commands).toEqual({
      test: { run: 'pnpm test', blocking: false },
      e2e: 'pnpm e2e',
    });
  });

  it('removes a gate, and drops gates once nothing is left', () => {
    const form = base();
    const next = removeCommand(form, row(form, 'e2e').id);
    expect(gatesConfigFromForm(next).gates).toEqual({ commands: { test: 'pnpm test' } });
    const none = formFromProjectGates(project({ commands: { test: 'pnpm test' } }));
    expect(gatesConfigFromForm(removeCommand(none, row(none, 'test').id))).toEqual({
      gates: { commands: {} },
    });
    const fresh = formFromProjectGates(project(null));
    expect(gatesConfigFromForm(removeCommand(addCommand(fresh), `g${fresh.seq + 1}`)).gates).toBeNull();
  });

  it('suppresses and restores a detected gate', () => {
    const form = formFromProjectGates(project(null));
    expect(detectedState(form, DETECTED[2] as GateSpec)).toBe('runs');
    const off = suppressGate(form, 'lint');
    expect(suppressGate(off, 'lint')).toBe(off);
    expect(gatesConfigFromForm(off).gates).toEqual({ commands: { lint: false } });
    expect(detectedState(off, DETECTED[2] as GateSpec)).toBe('suppressed');
    expect(effectiveGates(off, DETECTED).map((g) => g.name)).toEqual(['test', 'typecheck']);
    expect(gatesConfigFromForm(restoreGate(off, 'lint')).gates).toBeNull();
  });

  it('marks detected gates replaced by a configured or verify gate, and off without detection', () => {
    const form = base();
    expect(detectedState(form, DETECTED[0] as GateSpec)).toBe('replaced');
    expect(detectedState(form, DETECTED[1] as GateSpec)).toBe('replaced');
    expect(detectedState(form, DETECTED[2] as GateSpec)).toBe('runs');
    expect(detectedState({ ...form, detect: false }, DETECTED[2] as GateSpec)).toBe('off');
    expect(gatesConfigFromForm({ ...form, detect: false }).gates?.detect).toBe(false);
  });

  it('moves a verify entry into gates.commands', () => {
    const form = base();
    const moved = moveVerify(form, 0);
    expect(moved.verify).toEqual([]);
    expect(gatesConfigFromForm(moved)).toEqual({
      gates: {
        commands: { test: 'pnpm test', e2e: { run: 'pnpm e2e', blocking: false }, typecheck: 'pnpm typecheck' },
      },
      verify: [],
    });
    expect(effectiveGates(moved, []).map((g) => [g.name, g.source])).toEqual([
      ['test', 'config'],
      ['e2e', 'config'],
      ['typecheck', 'config'],
    ]);
    expect(moveVerify(form, 5)).toBe(form);
  });

  it('gives a moved verify entry a free name', () => {
    const form = formFromProjectGates(project({ commands: { test: 'pnpm test:unit' } }, ['pnpm test']));
    expect(gatesConfigFromForm(moveVerify(form, 0)).gates?.commands).toEqual({
      test: 'pnpm test:unit',
      'test-2': 'pnpm test',
    });
  });

  it('removes a verify entry', () => {
    const form = base();
    expect(gatesConfigFromForm(removeVerify(form, 0))).toEqual({ gates: form.base, verify: [] });
  });

  it('sets scope and secret modes and edits the allowlist', () => {
    let form = formFromProjectGates(project(null));
    form = { ...form, scope: 'warn', secretsMode: 'off' };
    expect(gatesConfigFromForm(form).gates).toEqual({ scope: 'warn', secrets: 'off' });
    form = addGlob(form);
    const glob = form.allow.at(-1)?.id ?? '';
    form = updateGlob(form, glob, ' fixtures/** ');
    expect(gatesConfigFromForm(form).gates?.secrets).toEqual({ mode: 'off', allow: ['fixtures/**'] });
    expect(gatesConfigFromForm(removeGlob(form, glob)).gates?.secrets).toBe('off');
  });
});

describe('validateGatesForm', () => {
  it('accepts a valid form', () => {
    const form = formFromProjectGates(project({ commands: { test: 'pnpm test', lint: false } }));
    expect(hasErrors(validateGatesForm(form))).toBe(false);
  });

  it('flags bad, missing and duplicate names', () => {
    let form = formFromProjectGates(project({ commands: { test: 'pnpm test', lint: 'pnpm lint' } }));
    form = updateCommand(form, row(form, 'lint').id, { name: 'test' });
    form = addCommand(form);
    const blank = form.commands.at(-1)?.id ?? '';
    form = updateCommand(form, blank, { run: 'make' });
    form = addCommand(form);
    const bad = form.commands.at(-1)?.id ?? '';
    form = updateCommand(form, bad, { name: 'Bad Name', run: 'make' });
    const errors = validateGatesForm(form);
    expect(hasErrors(errors)).toBe(true);
    const [first, second] = form.commands;
    expect(errors.commands[first?.id ?? '']?.name).toMatch(/more than one/);
    expect(errors.commands[second?.id ?? '']?.name).toMatch(/more than one/);
    expect(errors.commands[blank]?.name).toMatch(/name/);
    expect(errors.commands[bad]?.name).toMatch(/Lowercase/);
    expect(errors.commands[bad]?.run).toBeUndefined();
  });

  it('flags empty commands and globs, but not suppressed names', () => {
    let form = suppressGate(formFromProjectGates(project(null)), 'lint');
    form = addCommand(form);
    const id = form.commands.at(-1)?.id ?? '';
    form = updateCommand(form, id, { name: 'e2e', run: '   ' });
    form = addGlob(form);
    const glob = form.allow.at(-1)?.id ?? '';
    const errors = validateGatesForm(form);
    expect(errors.commands).toEqual({ [id]: { run: 'Enter the command to run.' } });
    expect(errors.allow[glob]).toMatch(/glob/);
  });
});

describe('session', () => {
  const loadedA = (gates: GatesConfig | null = { commands: { test: 'pnpm test' } }) => {
    const { session, ticket } = startLoad('A', 1);
    return loadDone(session, ticket, { ...project(gates), revision: 'rev-a' });
  };
  const editedA = () => editSession(loadedA(), (f) => ({ ...f, scope: 'warn' }));

  it('saves against the loaded revision, only when valid and changed', () => {
    expect(startSave(loadedA(), 2)).toBeNull();
    const started = startSave(editedA(), 2);
    expect(started?.request).toEqual({
      projectId: 'A',
      revision: 'rev-a',
      gates: { commands: { test: 'pnpm test' }, scope: 'warn' },
    });
    expect(started?.session.save.kind).toBe('saving');
    const invalid = editSession(loadedA(), (f) => addCommand(f));
    expect(startSave(invalid, 2)).toBeNull();
    const moved = editSession(loadedA(null), (f) => ({ ...f, verify: [] }));
    expect(startSave(moved, 2)).toBeNull();
  });

  it('ignores edits and a second save while a save is in flight, then rebases on the written file', () => {
    const started = startSave(editedA(), 2);
    if (!started) throw new Error('not started');
    const pending = started.session;
    const edited = editSession(pending, (f) => ({ ...f, detect: false }));
    expect(edited).toBe(pending);
    expect(discardEdits(pending)).toBe(pending);
    expect(startSave(pending, 3)).toBeNull();
    const written = { ...project({ commands: { test: 'pnpm test' }, scope: 'warn' }), revision: 'rev-b' };
    const done = saveDone(pending, started.ticket, written);
    expect(done.save.kind).toBe('saved');
    expect(done.load).toEqual({ status: 'ready', data: written });
    expect(done.form && isDirty(done.form)).toBe(false);
    expect(done.form?.scope).toBe('warn');
    // Editing again clears "saved" and the next save uses the new revision.
    const again = editSession(done, (f) => ({ ...f, detect: false }));
    expect(again.save.kind).toBe('idle');
    expect(startSave(again, 4)?.request.revision).toBe('rev-b');
  });

  it('drops a late save answer once another project is loaded', () => {
    const started = startSave(editedA(), 2);
    if (!started) throw new Error('not started');
    const b = startLoad('B', 3);
    const bLoaded = loadDone(b.session, b.ticket, { ...project({ scope: 'warn' }), revision: 'rev-b' });
    const late = saveDone(bLoaded, started.ticket, { ...project({ detect: false }), revision: 'rev-a2' });
    expect(late).toBe(bLoaded);
    expect(saveFailed(bLoaded, started.ticket, 'boom', false)).toBe(bLoaded);
  });

  it('drops a late load answer for another project or a superseded reload', () => {
    const a = startLoad('A', 1);
    const b = startLoad('B', 2);
    expect(loadDone(b.session, a.ticket, project(null))).toBe(b.session);
    expect(loadFailed(b.session, a.ticket, 'gone')).toBe(b.session);
    const again = startLoad('B', 3);
    expect(loadDone(again.session, b.ticket, project(null))).toBe(again.session);
    const fresh = loadDone(again.session, again.ticket, project(null));
    expect(fresh.load.status).toBe('ready');
    expect(fresh.form).not.toBeNull();
  });

  it('keeps the edits on a failed save and reports a conflict', () => {
    const started = startSave(editedA(), 2);
    if (!started) throw new Error('not started');
    const failed = saveFailed(started.session, started.ticket, 'changed on disk', true);
    expect(failed.save).toEqual({ kind: 'error', message: 'changed on disk', conflict: true });
    expect(failed.form?.scope).toBe('warn');
    expect(discardEdits(failed).form?.scope).toBe('block');
  });

  it('has no form for an invalid legion.json', () => {
    const { session, ticket } = startLoad('A', 1);
    const bad = loadDone(session, ticket, { ...project(null), error: 'Unexpected token' });
    expect(bad.form).toBeNull();
    expect(editSession(bad, (f) => f)).toBe(bad);
    expect(startSave(bad, 2)).toBeNull();
  });
});
