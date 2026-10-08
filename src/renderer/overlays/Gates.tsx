/**
 * Settings → Gates: per project, the checks every task passes before review and merge. Edits the `gates` key
 * (and moves legacy `verify` entries) of the project's legion.json through `projects.gates` /
 * `projects.setGates`; legion.json stays the single source of truth. Unlike the other sections it saves with a
 * button, against the revision it loaded, so it never overwrites edits made to the file in the meantime.
 */
import type { GateSource, ProjectGates } from '@shared/domain';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { rpc, useData, useUi } from '../app/hooks';
import { selectProjects } from '../app/projects';
import { errorMessage } from '../tiles/session/actions';
import {
  addCommand,
  addGlob,
  type CommandRow,
  detectedState,
  discardEdits,
  EMPTY_SESSION,
  editSession,
  effectiveGates,
  type GatesForm,
  type GatesLoad,
  type GatesSaveState,
  type GatesSession,
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
import { Segmented, Select, Switch } from './SettingsControls';

const SOURCE: Record<GateSource, { label: string; tone: string; title: string }> = {
  config: { label: 'gates.commands', tone: 'run', title: 'Defined in legion.json gates.commands' },
  verify: { label: 'verify', tone: 'warn', title: 'Legacy legion.json verify entry' },
  detected: { label: 'detected', tone: 'accent', title: 'Detected from package.json scripts' },
  task: { label: 'task', tone: 'idle', title: "The task's own verify command" },
  builtin: { label: 'built-in', tone: 'idle', title: "Legion's own check" },
};

function SourceBadge({ source }: { source: GateSource }) {
  const s = SOURCE[source];
  return (
    <span className={`chip chip-${s.tone}`} title={s.title} data-source={source}>
      {s.label}
    </span>
  );
}

export function GatesSection() {
  const projects = useData(selectProjects);
  const activeProjectId = useUi((s) => s.activeProjectId);
  const [chosen, setChosen] = useState<string | null>(null);
  const projectId =
    projects.find((p) => p.id === chosen)?.id ??
    projects.find((p) => p.id === activeProjectId)?.id ??
    projects[0]?.id ??
    null;
  const [session, setSession] = useState<GatesSession>(EMPTY_SESSION);
  // Request generations: a response applies only while its ticket is current (gates-model.ts).
  const generation = useRef(0);

  const fetchGates = useCallback((id: string) => {
    const { session: next, ticket } = startLoad(id, ++generation.current);
    setSession(next);
    rpc('projects.gates', { projectId: id }).then(
      (data) => setSession((s) => loadDone(s, ticket, data)),
      (error) => setSession((s) => loadFailed(s, ticket, errorMessage(error))),
    );
  }, []);

  useEffect(() => {
    if (projectId) fetchGates(projectId);
  }, [projectId, fetchGates]);

  const save = () => {
    const started = startSave(session, ++generation.current);
    if (!started) return;
    const { ticket, request } = started;
    setSession(started.session);
    rpc('projects.setGates', request).then(
      (data) => setSession((s) => saveDone(s, ticket, data)),
      (error) => {
        const conflict = (error as { code?: unknown } | null)?.code === 'conflict';
        const message = conflict
          ? 'legion.json changed on disk since it was loaded, so nothing was written. Reload to see the current file (your edits here are discarded).'
          : `Couldn't save: ${errorMessage(error)}`;
        setSession((s) => saveFailed(s, ticket, message, conflict));
      },
    );
  };

  // Only what was loaded for the selected project (the session catches up one effect after a switch).
  const current = projectId !== null && session.projectId === projectId;
  const load: GatesLoad = current ? session.load : { status: 'loading' };
  const data = load.status === 'ready' ? load.data : null;
  return (
    <section className="st-section" data-section="gates" aria-labelledby="st-gates" data-testid="settings-gates">
      <h2 id="st-gates" className="st-h">
        Gates
      </h2>
      <p className="st-lede">
        The checks every task passes before review and merge: commands (tests, typecheck, lint), the scope check and the
        secret scan. They live in the project's legion.json, so edits here change that file and apply to the next
        verify. Saved with the button below, not as you go.
      </p>
      {projectId === null ? (
        <div className="st-note ac-empty">Add a project to configure its gates.</div>
      ) : (
        <>
          <div className="st-row">
            <div className="min-w-0 flex-1">
              <div className="st-label">Project</div>
              <div className="st-note truncate" title={data?.path}>
                {data ? (
                  <>
                    <span className="mono">{data.path}</span>
                    {data.exists ? null : ' · not created yet, saving creates it'}
                  </>
                ) : (
                  'legion.json at the repository root.'
                )}
              </div>
            </div>
            {data ? (
              <span className={`chip ${data.exists ? 'chip-ok' : 'chip-idle'}`} data-testid="gates-file">
                {data.exists ? 'legion.json found' : 'no legion.json'}
              </span>
            ) : null}
            <Select
              label="Project"
              value={projectId}
              options={projects.map((p) => ({ value: p.id, label: p.name }))}
              onChange={setChosen}
            />
          </div>
          {load.status === 'loading' ? (
            <div className="st-note ac-empty">Loading…</div>
          ) : load.status === 'error' ? (
            <ReloadError message={`Couldn't read the gates: ${load.message}`} onReload={() => fetchGates(projectId)} />
          ) : load.data.error ? (
            <ReloadError
              message={`legion.json is invalid, so it can't be edited here: ${load.data.error}`}
              onReload={() => fetchGates(projectId)}
            />
          ) : session.form ? (
            <GatesEditor
              key={projectId}
              data={load.data}
              form={session.form}
              save={session.save}
              edit={(update) => setSession((s) => editSession(s, update))}
              onSave={save}
              onDiscard={() => setSession(discardEdits)}
              onReload={() => fetchGates(projectId)}
            />
          ) : null}
        </>
      )}
    </section>
  );
}

function ReloadError({ message, onReload }: { message: string; onReload: () => void }) {
  return (
    <div className="st-card mt-2 flex items-start gap-3" role="alert">
      <span className="st-error min-w-0 flex-1">{message}</span>
      <button type="button" className="btn btn-sm flex-none" onClick={onReload}>
        Reload
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// The form
// ---------------------------------------------------------------------------------------------

function GatesEditor({
  data,
  form,
  save,
  edit,
  onSave,
  onDiscard,
  onReload,
}: {
  data: ProjectGates;
  form: GatesForm;
  save: GatesSaveState;
  edit: (update: (form: GatesForm) => GatesForm) => void;
  onSave: () => void;
  onDiscard: () => void;
  onReload: () => void;
}) {
  const id = useId();
  const errors = useMemo(() => validateGatesForm(form), [form]);
  const invalid = hasErrors(errors);
  const dirty = useMemo(() => isDirty(form), [form]);
  const effective = useMemo(() => effectiveGates(form, data.detected), [form, data.detected]);
  const saving = save.kind === 'saving';
  const commands = form.commands.filter((c) => !c.off);
  const suppressed = form.commands.filter((c) => c.off);
  const verifyName = (command: string) =>
    data.resolved.find((g) => g.source === 'verify' && g.command === command)?.name ?? null;

  return (
    <form
      aria-label="Gates"
      aria-busy={saving}
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
    >
      {/* Locked while saving: the form is what is being written. */}
      <fieldset className="m-0 min-w-0 border-0 p-0" disabled={saving}>
        {/* Detection --------------------------------------------------------------------------- */}
        <div className="st-sub">Detected</div>
        <div className="st-row">
          <div className="min-w-0 flex-1">
            <div className="st-label">Detect gates</div>
            <div className="st-note">
              Test, typecheck and lint from package.json scripts
              {data.packageManager ? (
                <>
                  , run with <span className="mono">{data.packageManager}</span>
                </>
              ) : (
                ' (no package manager found)'
              )}
              . A configured or verify gate with the same name replaces a detected one.
            </div>
          </div>
          <Switch label="Detect gates" checked={form.detect} onChange={(detect) => edit((f) => ({ ...f, detect }))} />
        </div>
        {data.detected.length === 0 ? (
          <div className="st-note ac-empty">Nothing detected in this project.</div>
        ) : (
          <ul className="ac-list" aria-label="Detected gates">
            {data.detected.map((spec) => {
              const state = detectedState(form, spec);
              return (
                <li key={spec.name} className="ac-server" data-gate={spec.name} data-state={state}>
                  <span className="ac-server-main">
                    <span className="ac-server-name">{spec.name}</span>
                    <span className="ac-server-sum mono" title={spec.command}>
                      {spec.command}
                    </span>
                  </span>
                  <SourceBadge source="detected" />
                  <span className={`chip ${state === 'runs' ? 'chip-ok' : 'chip-idle'}`}>
                    {state === 'runs'
                      ? 'runs'
                      : state === 'replaced'
                        ? 'replaced'
                        : state === 'suppressed'
                          ? 'suppressed'
                          : 'detection off'}
                  </span>
                  {state === 'suppressed' ? (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => edit((f) => restoreGate(f, spec.name))}
                    >
                      Restore
                    </button>
                  ) : state === 'runs' ? (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      aria-label={`Suppress ${spec.name}`}
                      title={`Write "${spec.name}": false to gates.commands`}
                      onClick={() => edit((f) => suppressGate(f, spec.name))}
                    >
                      Suppress
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}

        {/* gates.commands ---------------------------------------------------------------------- */}
        <div className="st-sub">Commands</div>
        <p className="st-lede">
          Your own gates in <span className="mono">gates.commands</span>. A failing blocking gate sends the task back to
          its coder; a non-blocking one only warns.
        </p>
        {commands.length === 0 ? (
          <div className="st-note ac-empty">No configured gates.</div>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Configured gates">
            {commands.map((row) => (
              <CommandEditor
                key={row.id}
                row={row}
                error={errors.commands[row.id]}
                onChange={(patch) => edit((f) => updateCommand(f, row.id, patch))}
                onRemove={() => edit((f) => removeCommand(f, row.id))}
              />
            ))}
          </ul>
        )}
        <div className="ac-actions">
          <button type="button" className="btn btn-sm" onClick={() => edit(addCommand)}>
            Add gate
          </button>
        </div>
        {suppressed.length > 0 ? (
          <ul className="ac-list mt-2" aria-label="Suppressed gates">
            {suppressed.map((row) => (
              <li key={row.id} className="ac-server" data-gate={row.name}>
                <span className="ac-server-main">
                  <span className="ac-server-name">{row.name}</span>
                  <span className="ac-server-sum">
                    Suppressed: never runs, even when detected.
                    {errors.commands[row.id]?.name ? (
                      <span className="st-error"> {errors.commands[row.id]?.name}</span>
                    ) : null}
                  </span>
                </span>
                <SourceBadge source="config" />
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => edit((f) => removeCommand(f, row.id))}
                >
                  Restore
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        {/* legacy verify ----------------------------------------------------------------------- */}
        {form.verify.length > 0 || form.baseVerify.length > 0 ? (
          <>
            <div className="st-sub">Legacy verify</div>
            <p className="st-lede">
              Entries of legion.json <span className="mono">verify</span>. They still run as blocking gates; move them
              into <span className="mono">gates.commands</span> to name them or make them non-blocking.
            </p>
            {form.verify.length === 0 ? (
              <div className="st-note ac-empty">All verify entries moved.</div>
            ) : (
              <ul className="ac-list" aria-label="Verify entries">
                {form.verify.map((command, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: verify entries have no id and may repeat
                  <li key={`${index}:${command}`} className="ac-server">
                    <span className="ac-server-main">
                      <span className="ac-server-name">{verifyName(command) ?? 'verify'}</span>
                      <span className="ac-server-sum mono" title={command}>
                        {command}
                      </span>
                    </span>
                    <SourceBadge source="verify" />
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => edit((f) => moveVerify(f, index, verifyName(command) ?? undefined))}
                    >
                      Move to gates.commands
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      aria-label={`Remove ${command}`}
                      onClick={() => edit((f) => removeVerify(f, index))}
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : null}

        {/* built-in gates ---------------------------------------------------------------------- */}
        <div className="st-sub">Built-in</div>
        <div className="st-row">
          <div className="min-w-0 flex-1">
            <div className="st-label" id={`${id}-scope`}>
              Scope
            </div>
            <div className="st-note">
              Changes outside the task's declared files: fail the task, or only report them.
            </div>
          </div>
          <Segmented<'block' | 'warn'>
            labelledBy={`${id}-scope`}
            value={form.scope}
            options={[
              { value: 'block', label: 'Block' },
              { value: 'warn', label: 'Warn' },
            ]}
            onChange={(scope) => edit((f) => ({ ...f, scope }))}
          />
        </div>
        <div className="st-row">
          <div className="min-w-0 flex-1">
            <div className="st-label" id={`${id}-secrets`}>
              Secret scan
            </div>
            <div className="st-note">Likely secrets on the lines a task adds.</div>
          </div>
          <Segmented<'block' | 'warn' | 'off'>
            labelledBy={`${id}-secrets`}
            value={form.secretsMode}
            options={[
              { value: 'block', label: 'Block' },
              { value: 'warn', label: 'Warn' },
              { value: 'off', label: 'Off' },
            ]}
            onChange={(secretsMode) => edit((f) => ({ ...f, secretsMode }))}
          />
        </div>
        <div className="st-label mt-2">Never scan</div>
        <div className="st-note">Globs of files the secret scan skips, e.g. test fixtures.</div>
        {form.allow.length > 0 ? (
          <ul className="mt-2 mb-0 flex list-none flex-col gap-2 p-0" aria-label="Secret scan allowlist">
            {form.allow.map((g, index) => (
              <li key={g.id} className="flex items-start gap-2">
                <div className="st-field flex-1">
                  <div className="st-input" data-invalid={Boolean(errors.allow[g.id])}>
                    <input
                      className="mono"
                      aria-label={`Allowlist glob ${index + 1}`}
                      aria-invalid={Boolean(errors.allow[g.id])}
                      value={g.glob}
                      placeholder="fixtures/**"
                      spellCheck={false}
                      autoComplete="off"
                      onChange={(e) => edit((f) => updateGlob(f, g.id, e.target.value))}
                    />
                  </div>
                  {errors.allow[g.id] ? <span className="st-error">{errors.allow[g.id]}</span> : null}
                </div>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm mt-1"
                  aria-label={`Remove glob ${g.glob || index + 1}`}
                  onClick={() => edit((f) => removeGlob(f, g.id))}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="ac-actions">
          <button type="button" className="btn btn-sm" onClick={() => edit(addGlob)}>
            Add glob
          </button>
        </div>

        {/* what runs --------------------------------------------------------------------------- */}
        <div className="st-sub">What every task runs</div>
        <p className="st-lede">With these settings, before a task's own verify commands.</p>
        <ul className="ac-list" aria-label="Effective gates" data-testid="gates-effective">
          {effective.map((g) => (
            <li key={g.name} className="ac-server">
              <span className="ac-server-main">
                <span className="ac-server-name">{g.name}</span>
                <span className="ac-server-sum mono" title={g.command}>
                  {g.command}
                </span>
              </span>
              {g.blocking ? null : <span className="chip chip-idle">warn only</span>}
              <SourceBadge source={g.source} />
            </li>
          ))}
          <li className="ac-server">
            <span className="ac-server-main">
              <span className="ac-server-name">scope</span>
              <span className="ac-server-sum">
                {form.scope === 'block' ? 'blocks' : 'warns'} on out-of-scope changes
              </span>
            </span>
            <SourceBadge source="builtin" />
          </li>
          <li className="ac-server">
            <span className="ac-server-main">
              <span className="ac-server-name">secrets</span>
              <span className="ac-server-sum">
                {form.secretsMode === 'off'
                  ? 'off'
                  : `${form.secretsMode === 'block' ? 'blocks' : 'warns'} on likely secrets`}
              </span>
            </span>
            <SourceBadge source="builtin" />
          </li>
        </ul>
      </fieldset>

      {/* save -------------------------------------------------------------------------------- */}
      {save.kind === 'error' ? <ReloadError message={save.message} onReload={onReload} /> : null}
      <div className="ac-actions items-center">
        <button
          type="submit"
          className="btn btn-sm btn-primary"
          disabled={invalid || !dirty || saving}
          data-testid="gates-save"
        >
          {saving ? 'Saving…' : data.exists ? 'Save to legion.json' : 'Create legion.json'}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" disabled={!dirty || saving} onClick={onDiscard}>
          Discard
        </button>
        <span className={invalid ? 'st-error' : 'st-note'} aria-live="polite">
          {invalid
            ? 'Fix the marked fields to save.'
            : save.kind === 'saved' && !dirty
              ? 'Saved.'
              : dirty
                ? 'Unsaved changes.'
                : null}
        </span>
      </div>
    </form>
  );
}

function CommandEditor({
  row,
  error,
  onChange,
  onRemove,
}: {
  row: CommandRow;
  error: { name?: string; run?: string } | undefined;
  onChange: (patch: Partial<Pick<CommandRow, 'name' | 'run' | 'blocking'>>) => void;
  onRemove: () => void;
}) {
  const id = useId();
  const label = row.name.trim() || 'new gate';
  return (
    <li
      className="grid grid-cols-[150px_minmax(0,1fr)_auto] items-start gap-2"
      data-gate={row.name}
      data-testid="gate-row"
    >
      <div className="st-field">
        <div className="st-input" data-invalid={Boolean(error?.name)}>
          <input
            id={`${id}-name`}
            className="mono"
            aria-label={`Name of ${label}`}
            aria-invalid={Boolean(error?.name)}
            value={row.name}
            placeholder="name"
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => onChange({ name: e.target.value })}
          />
        </div>
        {error?.name ? <span className="st-error">{error.name}</span> : null}
      </div>
      <div className="st-field">
        <div className="st-input" data-invalid={Boolean(error?.run)}>
          <input
            className="mono"
            aria-label={`Command of ${label}`}
            aria-invalid={Boolean(error?.run)}
            value={row.run}
            placeholder="pnpm test"
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => onChange({ run: e.target.value })}
          />
        </div>
        {error?.run ? <span className="st-error">{error.run}</span> : null}
      </div>
      <div className="flex h-8 items-center gap-2">
        <span className="st-note">Blocking</span>
        <Switch
          label={`${label} blocks the task`}
          checked={row.blocking}
          onChange={(blocking) => onChange({ blocking })}
        />
        <SourceBadge source="config" />
        <button type="button" className="btn btn-ghost btn-sm" aria-label={`Remove ${label}`} onClick={onRemove}>
          Remove
        </button>
      </div>
    </li>
  );
}
