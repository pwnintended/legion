/**
 * Settings → Agents: a role list beside the chosen role's detail. The detail sets the role's engine, model and
 * effort, and shows its prompt as a route of layers (core/prompts/layers.ts): Legion's built-in prompt (or the
 * human's replacement), their additions for every project (settings, saved as you go), the project's additions
 * (legion.json `prompts`, saved with a button like Gates), and what the agent receives once they are joined.
 */
import { builtinSystemPrompts } from '@engine/orchestrator/core/prompts/builtin';
import { composeSystemPrompt, missingToolNames, PROMPT_LAYER_HEADINGS } from '@engine/orchestrator/core/prompts/layers';
import type { Effort, EngineKind, Role, RolePrompt, Settings, SettingsPatch } from '@shared/domain';
import type { EngineInfo } from '@shared/engine';
import { type KeyboardEvent, type Ref, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { rpc, useData, useUi } from '../app/hooks';
import { selectProjects } from '../app/projects';
import { actions } from '../app/store';
import { Icon } from '../chrome/icons';
import { errorMessage } from '../tiles/session/actions';
import {
  dirtyRoles,
  discardDrafts,
  draftText,
  EMPTY_PROJECT_PROMPTS,
  editDraft,
  loadDone,
  loadFailed,
  type ProjectPromptsSession,
  saveDone,
  savedText,
  saveFailed,
  startLoad,
  startSave,
} from './prompts-model';
import { Field, Segmented, Select } from './SettingsControls';
import { parseModel } from './settings-model';

type Commit = (patch: SettingsPatch) => Promise<boolean>;

const REAL: readonly ('claude' | 'codex')[] = ['claude', 'codex'];
/** Mirrors EFFORTS and the prompt limits in shared/domain.ts (values from there pull zod into this chunk). */
const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const ADDITION_MAX = 20_000;
const REPLACE_MAX = 60_000;

interface RoleInfo {
  role: Role;
  label: string;
  note: string;
}

/** The roles in the order a run meets them, grouped. */
const GROUPS: { label: string; roles: RoleInfo[] }[] = [
  {
    label: 'Talking with you',
    roles: [
      {
        role: 'assistant',
        label: 'Assistant',
        note: 'Your conversation partner. Starts the work and relays the lead.',
      },
      {
        role: 'session',
        label: 'Session',
        note: 'A direct session: edits your checkout, no plan. Default for new sessions.',
      },
    ],
  },
  {
    label: 'Planning',
    roles: [{ role: 'planner', label: 'Planner', note: 'Asks its clarifying questions and drafts the plan.' }],
  },
  {
    label: 'Building',
    roles: [
      { role: 'lead', label: 'Lead', note: 'Coordinates the coders after approval. Talks, never touches files.' },
      { role: 'coder', label: 'Coder', note: 'Implements every task. Plans never pick an engine or model.' },
      {
        role: 'reviewer',
        label: 'Reviewer',
        note: 'Reviews each task. Always runs on the other engine than its coder.',
      },
      {
        role: 'resolver',
        label: 'Resolver',
        note: 'Resolves merge conflicts between a task and the integration branch.',
      },
      { role: 'finalizer', label: 'Final review', note: 'Reviews the whole change (base…integration) before the PR.' },
    ],
  },
  {
    label: 'Research',
    roles: [
      { role: 'researcher', label: 'Researcher', note: 'Read-only repository and web research on a brief.' },
      { role: 'research_lead', label: 'Research lead', note: 'Splits a broad brief over researchers and synthesises.' },
    ],
  },
];
const ROLES: RoleInfo[] = GROUPS.flatMap((g) => g.roles);
const ENGINE_LABEL: Record<EngineKind, string> = { claude: 'Claude', codex: 'Codex', fake: 'Fake' };

const words = (text: string) => (text.trim() ? text.trim().split(/\s+/).length : 0);
const count = (n: number) => n.toLocaleString('en-US');

function isCustom(prompt: RolePrompt, project: string): boolean {
  return Boolean(prompt.replace !== null || prompt.append.trim() || project.trim());
}

export function AgentsSection({
  settings,
  engines,
  commit,
}: {
  settings: Settings;
  engines: EngineInfo[];
  commit: Commit;
}) {
  const id = useId();
  const [role, setRole] = useState<Role>('planner');
  const projects = useData(selectProjects);
  const activeProjectId = useUi((s) => s.activeProjectId);
  const [chosen, setChosen] = useState<string | null>(null);
  const projectId =
    projects.find((p) => p.id === chosen)?.id ??
    projects.find((p) => p.id === activeProjectId)?.id ??
    projects[0]?.id ??
    null;
  const project = projects.find((p) => p.id === projectId) ?? null;
  const [session, setSession] = useState<ProjectPromptsSession>(EMPTY_PROJECT_PROMPTS);
  const generation = useRef(0);

  const fetchPrompts = useCallback((pid: string) => {
    const ticket = ++generation.current;
    setSession(startLoad(pid, ticket));
    rpc('projects.prompts', { projectId: pid }).then(
      (data) => setSession((s) => loadDone(s, ticket, data)),
      (error) => setSession((s) => loadFailed(s, ticket, errorMessage(error))),
    );
  }, []);

  useEffect(() => {
    if (projectId) fetchPrompts(projectId);
  }, [projectId, fetchPrompts]);

  const saveProject = () => {
    const started = startSave(session, ++generation.current);
    if (!started) return;
    const ticket = generation.current;
    setSession(started.session);
    rpc('projects.setPrompts', started.request).then(
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

  const current = session.projectId === projectId ? session : EMPTY_PROJECT_PROMPTS;
  const dirty = dirtyRoles(current);
  const info = ROLES.find((r) => r.role === role) ?? (ROLES[0] as RoleInfo);
  const listRef = useRef<HTMLDivElement>(null);
  const focusList = () => listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();

  return (
    <section className="st-section ag" data-section="agents" aria-labelledby="st-agents">
      <header className="st-page-head">
        <div className="min-w-0 flex-1">
          <h2 id="st-agents" className="st-h">
            Agents
          </h2>
          <p className="st-lede">
            The engine, model and effort each role runs on, and what it is told. Changes reach the next agent that
            starts; running agents keep the prompt they started with.
          </p>
        </div>
        <div className="ag-planner">
          <span className="st-field-label" id={`${id}-planner`}>
            Default planner
          </span>
          <Segmented<EngineKind>
            labelledBy={`${id}-planner`}
            value={settings.roles.planner.engine}
            options={REAL.map((k) => ({ value: k, label: ENGINE_LABEL[k], engine: k }))}
            onChange={(engine) => void commit({ roles: { planner: { engine } } })}
          />
        </div>
      </header>

      <div className="ag-body">
        <div className="ag-pick">
          <Select
            label="Role"
            value={role}
            options={ROLES.map((r) => ({ value: r.role, label: r.label }))}
            onChange={(value) => setRole(value as Role)}
          />
        </div>
        <RoleList
          ref={listRef}
          settings={settings}
          selected={role}
          projectText={(r) => draftText(current, r)}
          dirty={dirty}
          onSelect={setRole}
        />
        <RoleDetail
          key={role}
          info={info}
          settings={settings}
          engines={engines}
          commit={commit}
          projectName={project?.name ?? null}
          projects={projects.map((p) => ({ value: p.id, label: p.name }))}
          projectId={projectId}
          onProject={setChosen}
          session={current}
          dirty={dirty}
          onDraft={(text) => setSession((s) => editDraft(s, role, text))}
          onSaveProject={saveProject}
          onDiscardProject={() => setSession(discardDrafts)}
          onReloadProject={() => projectId && fetchPrompts(projectId)}
          onLeave={focusList}
        />
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// The role list
// ---------------------------------------------------------------------------------------------

function RoleList({
  ref,
  settings,
  selected,
  projectText,
  dirty,
  onSelect,
}: {
  ref: Ref<HTMLDivElement>;
  settings: Settings;
  selected: Role;
  projectText: (role: Role) => string;
  dirty: readonly Role[];
  onSelect: (role: Role) => void;
}) {
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const i = ROLES.findIndex((r) => r.role === selected);
    const step =
      event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowUp'
          ? -1
          : event.key === 'Home'
            ? -i
            : event.key === 'End'
              ? ROLES.length - 1 - i
              : 0;
    if (event.key === 'Escape') {
      event.preventDefault();
      actions.closeOverlay();
      return;
    }
    if (event.key === 'Enter') {
      // Into the detail: its first editor (the prompt), else its first control.
      event.preventDefault();
      const detail = document.querySelector<HTMLElement>('.ag-detail');
      (
        detail?.querySelector<HTMLElement>('textarea') ?? detail?.querySelector<HTMLElement>('select, input, button')
      )?.focus();
      return;
    }
    if (!step) return;
    event.preventDefault();
    const next = ROLES[Math.min(ROLES.length - 1, Math.max(0, i + step))];
    if (!next) return;
    onSelect(next.role);
    requestAnimationFrame(() =>
      (event.currentTarget as HTMLElement | null)
        ?.querySelector<HTMLElement>(`[data-role-item="${next.role}"]`)
        ?.focus(),
    );
  };
  return (
    <div ref={ref} className="ag-list" role="listbox" aria-label="Roles" data-local-keys onKeyDown={move} tabIndex={-1}>
      {GROUPS.map((group) => (
        <div key={group.label} className="ag-group" role="presentation">
          <div className="ag-group-label" role="presentation">
            {group.label}
          </div>
          {group.roles.map(({ role, label }) => {
            const value = settings.roles[role];
            const model = value.engine === 'fake' ? null : value.models[value.engine];
            const custom = isCustom(value.prompt, projectText(role));
            const unsaved = dirty.includes(role);
            return (
              <div
                key={role}
                role="option"
                aria-selected={role === selected}
                tabIndex={role === selected ? 0 : -1}
                className="ag-item"
                data-role-item={role}
                data-engine={value.engine}
                onClick={() => onSelect(role)}
                onKeyDown={(e) => {
                  if (e.key === ' ') {
                    e.preventDefault();
                    onSelect(role);
                  }
                }}
              >
                <span className="ag-item-name">{label}</span>
                {custom || unsaved ? (
                  <span
                    className="ag-mark"
                    data-unsaved={unsaved || undefined}
                    title={unsaved ? 'Unsaved legion.json changes' : 'Custom prompt'}
                  >
                    <span className="sr-only">{unsaved ? 'unsaved changes' : 'custom prompt'}</span>
                  </span>
                ) : null}
                <span className="ag-item-meta">
                  <span className="ag-engine-dot" aria-hidden="true" />
                  <span className="sr-only">{ENGINE_LABEL[value.engine]}</span>
                  <span className={model ? 'mono' : undefined}>{model ?? 'default'}</span>
                </span>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// The role's detail
// ---------------------------------------------------------------------------------------------

function RoleDetail({
  info,
  settings,
  engines,
  commit,
  projectName,
  projects,
  projectId,
  onProject,
  session,
  dirty,
  onDraft,
  onSaveProject,
  onDiscardProject,
  onReloadProject,
  onLeave,
}: {
  info: RoleInfo;
  settings: Settings;
  engines: EngineInfo[];
  commit: Commit;
  projectName: string | null;
  projects: { value: string; label: string }[];
  projectId: string | null;
  onProject: (id: string) => void;
  session: ProjectPromptsSession;
  dirty: readonly Role[];
  onDraft: (text: string) => void;
  onSaveProject: () => void;
  onDiscardProject: () => void;
  onReloadProject: () => void;
  onLeave: () => void;
}) {
  const { role, label, note } = info;
  const value = settings.roles[role];
  const engineModel = value.engine === 'fake' ? null : value.models[value.engine];
  const variants = useMemo(() => builtinSystemPrompts(role, projectName ?? undefined), [role, projectName]);
  const builtinTexts = useMemo(() => variants.map((v) => v.text), [variants]);
  const [variantId, setVariantId] = useState(variants[0]?.id ?? role);
  const variant = variants.find((v) => v.id === variantId) ?? variants[0];
  const [replaceDraft, setReplaceDraft] = useState<string | null>(value.prompt.replace);
  useEffect(() => setReplaceDraft(value.prompt.replace), [value.prompt.replace]);
  const [appendDraft, setAppendDraft] = useState(value.prompt.append);
  useEffect(() => setAppendDraft(value.prompt.append), [value.prompt.append]);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const projectText = draftText(session, role);
  const replaced = value.prompt.replace !== null;
  const builtin = variant?.text ?? '';

  const setPrompt = (prompt: Partial<RolePrompt>) => commit({ roles: { [role]: { prompt } } });
  const composed = composeSystemPrompt(builtin, {
    replace: replaced ? (replaceDraft ?? '') : null,
    append: appendDraft,
    project: projectText,
  });

  return (
    <div className="ag-detail" data-role={role} data-testid={`role-${role}`}>
      <div className="ag-title">
        <h3 className="ag-name">{label}</h3>
        <p className="ag-note">{note}</p>
      </div>
      <div className="ag-run">
        <div className="st-field">
          <span className="st-field-label" aria-hidden="true">
            Engine
          </span>
          <Select
            label={`${label} engine`}
            value={value.engine}
            options={[
              ...REAL.map((k) => ({ value: k, label: ENGINE_LABEL[k] })),
              ...(value.engine === 'fake' ? [{ value: 'fake', label: 'Fake' }] : []),
            ]}
            onChange={(engine) => void commit({ roles: { [role]: { engine: engine as EngineKind } } })}
          />
        </div>
        <div className="st-field">
          <span className="st-field-label" aria-hidden="true">
            Model
          </span>
          {value.engine === 'fake' ? (
            <span className="st-note ag-na">n/a</span>
          ) : (
            <Field
              // Keyed by engine so the draft never carries one engine's model name over to the other.
              key={value.engine}
              label={`${label} model`}
              hideLabel
              mono
              value={engineModel ?? ''}
              placeholder="CLI default"
              suggestions={engines.find((e) => e.kind === value.engine)?.models}
              parse={parseModel}
              onCommit={(model) => commit({ roles: { [role]: { models: { [value.engine]: model } } } })}
            />
          )}
        </div>
        <div className="st-field">
          <span className="st-field-label" aria-hidden="true">
            Effort
          </span>
          <Select
            label={`${label} effort`}
            value={value.effort ?? ''}
            options={[{ value: '', label: 'default' }, ...EFFORTS.map((e) => ({ value: e, label: e }))]}
            onChange={(effort) => void commit({ roles: { [role]: { effort: (effort || null) as Effort | null } } })}
          />
        </div>
      </div>
      <p className="st-note ag-run-note">
        Each engine keeps its own model for this role
        {role === 'reviewer' || role === 'finalizer' ? ', because a reviewer’s engine depends on its coder' : ''}. Empty
        uses the CLI’s default.
      </p>

      <div className="ag-prompt-head">
        <h4 className="ag-prompt-title">Prompt</h4>
        {variants.length > 1 && !replaced ? (
          <VariantTabs
            variants={variants}
            value={variant?.id ?? ''}
            onChange={setVariantId}
            label={`${label} prompt variant`}
          />
        ) : null}
      </div>

      <ol className="ag-route" aria-label={`${label} prompt, in the order the agent reads it`}>
        {/* 1. Legion's prompt, or the replacement. */}
        <li className="ag-stop" data-state={replaced ? 'set' : 'base'}>
          <span className="ag-ring" aria-hidden="true" />
          {replaced ? (
            <>
              <div className="ag-stop-head">
                <span className="ag-stop-title">Your replacement</span>
                <span className="chip chip-accent">replaces Legion’s prompt</span>
                <span className="flex-1" />
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={() => void setPrompt({ replace: null })}
                >
                  <Icon name="refresh" size={12} />
                  Restore built-in
                </button>
              </div>
              <p className="ag-stop-note">
                Used for every variant of this role, and it won’t follow Legion’s prompt updates. Tool names are written
                plainly; Claude sees them as <span className="mono">mcp__legion__…</span>.
              </p>
              <PromptText
                label={`${label} replacement prompt`}
                value={value.prompt.replace ?? ''}
                max={REPLACE_MAX}
                placeholder="The whole system prompt for this role."
                onDraft={setReplaceDraft}
                onCommit={(text) => setPrompt({ replace: text.trim() ? text : null })}
                onLeave={onLeave}
                rows={14}
              />
              <MissingTools builtins={builtinTexts} replacement={replaceDraft ?? ''} />
              <details className="ag-compare">
                <summary>Legion’s built-in prompt</summary>
                <BuiltinText text={builtin} when={variant?.when ?? ''} />
              </details>
            </>
          ) : (
            <>
              <div className="ag-stop-head">
                <span className="ag-stop-title">Legion’s prompt</span>
                <span className="ag-stop-meta">{count(words(builtin))} words · built in</span>
                <span className="flex-1" />
                {confirmReplace ? null : (
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => setConfirmReplace(true)}>
                    Replace…
                  </button>
                )}
              </div>
              {confirmReplace ? (
                <fieldset className="ag-confirm">
                  <legend className="sr-only">Replace Legion’s prompt</legend>
                  <p className="m-0">
                    You’ll edit a copy of this prompt instead. It applies to every variant of the role and stops
                    following Legion’s prompt updates; your additions still apply. Restore the built-in any time.
                  </p>
                  <div className="ag-confirm-actions">
                    <button
                      type="button"
                      className="btn btn-sm btn-primary"
                      onClick={() => {
                        setConfirmReplace(false);
                        void setPrompt({ replace: variants[0]?.text ?? builtin });
                      }}
                    >
                      Replace with a copy
                    </button>
                    <button type="button" className="btn btn-sm btn-ghost" onClick={() => setConfirmReplace(false)}>
                      Cancel
                    </button>
                  </div>
                </fieldset>
              ) : null}
              <BuiltinText text={builtin} when={variant?.when ?? ''} />
            </>
          )}
        </li>

        {/* 2. Additions in every project. */}
        <li className="ag-stop" data-state={appendDraft.trim() ? 'set' : 'empty'}>
          <span className="ag-ring" aria-hidden="true" />
          <div className="ag-stop-head">
            <span className="ag-stop-title">Your additions</span>
            <span className="ag-stop-meta">every project · saved as you go</span>
          </div>
          <PromptText
            label={`${label} additions for every project`}
            value={value.prompt.append}
            max={ADDITION_MAX}
            placeholder={EXAMPLES[role]}
            onDraft={setAppendDraft}
            onCommit={(text) => setPrompt({ append: text })}
            onLeave={onLeave}
          />
        </li>

        {/* 3. Additions in this project (legion.json). */}
        <li className="ag-stop" data-state={projectText.trim() ? 'set' : 'empty'}>
          <span className="ag-ring" aria-hidden="true" />
          <ProjectLayer
            label={label}
            role={role}
            projects={projects}
            projectId={projectId}
            onProject={onProject}
            session={session}
            dirty={dirty}
            text={projectText}
            onDraft={onDraft}
            onSave={onSaveProject}
            onDiscard={onDiscardProject}
            onReload={onReloadProject}
            onLeave={onLeave}
          />
        </li>

        {/* 4. Joined. */}
        <li className="ag-stop ag-stop-end" data-state="end">
          <span className="ag-ring" aria-hidden="true" />
          <Received
            composed={composed}
            base={replaced ? null : builtin}
            unsaved={dirty.includes(role) || appendDraft !== value.prompt.append}
          />
        </li>
      </ol>
    </div>
  );
}

const EXAMPLES: Record<Role, string> = {
  assistant: 'e.g. Answer in English even when I write in Dutch. Keep replies under five sentences.',
  session: 'e.g. Run the tests you touched before you say you are done.',
  planner: 'e.g. Prefer fewer, larger tasks. Always plan a task for docs when behaviour changes.',
  lead: 'e.g. Tell me when a task needs a second fix round, not only when it fails.',
  coder: 'e.g. Run `pnpm lint --fix` before you call mark_task_done.',
  reviewer: 'e.g. Look for missing tests before style.',
  resolver: 'e.g. Never resolve a conflict in a migration file by hand; ask instead.',
  finalizer: 'e.g. Check that the changelog mentions every user-facing change.',
  researcher: 'e.g. Prefer the official docs over blog posts, and give versions.',
  research_lead: 'e.g. Use at most three researchers.',
};

function VariantTabs({
  variants,
  value,
  onChange,
  label,
}: {
  variants: { id: string; label: string | null }[];
  value: string;
  onChange: (id: string) => void;
  label: string;
}) {
  return (
    <div className="ag-variants" role="tablist" aria-label={label}>
      {variants.map((v) => (
        <button
          key={v.id}
          type="button"
          role="tab"
          aria-selected={v.id === value}
          className="ag-variant"
          onClick={() => onChange(v.id)}
        >
          {v.label}
        </button>
      ))}
    </div>
  );
}

/** Legion's prompt text: the first lines with a fade, the whole text on request. */
function BuiltinText({ text, when }: { text: string; when: string }) {
  const [open, setOpen] = useState(false);
  const long = text.split('\n').length > 7 || text.length > 700;
  return (
    <div className="ag-builtin">
      {when ? <p className="ag-stop-note">{when}</p> : null}
      <div className="ag-text" data-open={open || !long || undefined}>
        {text}
      </div>
      {long ? (
        <button type="button" className="ag-more" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <Icon name="chevronDown" size={12} className={open ? 'rotate-180' : undefined} />
          {open ? 'Show less' : 'Show all'}
        </button>
      ) : null}
    </div>
  );
}

function MissingTools({ builtins, replacement }: { builtins: string[]; replacement: string }) {
  const missing = useMemo(() => missingToolNames(builtins, replacement), [builtins, replacement]);
  if (!missing.length) return null;
  return (
    <p className="ag-missing" role="status">
      <Icon name="alert" size={13} />
      <span>
        No longer mentioned:{' '}
        {missing.map((name, i) => (
          <span key={name}>
            {i ? ', ' : null}
            <code className="mono">{name}</code>
          </span>
        ))}
        . The agent still has these tools, but nothing tells it when to use them.
      </span>
    </p>
  );
}

/**
 * A prompt editor: grows with its text, saves on blur or ⌘⏎ (unless `onCommit` is absent: the caller saves),
 * Esc hands focus back to the role list.
 */
function PromptText({
  label,
  value,
  max,
  placeholder,
  onDraft,
  onCommit,
  onLeave,
  rows = 4,
  disabled,
}: {
  label: string;
  value: string;
  max: number;
  placeholder?: string;
  onDraft?: (text: string) => void;
  onCommit?: (text: string) => Promise<boolean>;
  onLeave: () => void;
  rows?: number;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  const editing = useRef(false);
  // Follow external updates (the engine, another window) unless the user is typing.
  useEffect(() => {
    if (!editing.current) setDraft(value);
  }, [value]);
  const over = draft.length > max;
  const near = draft.length > max * 0.8;
  const commit = async () => {
    editing.current = false;
    if (!onCommit || over || draft === value) return;
    const ok = await onCommit(draft);
    if (!ok) editing.current = true;
  };
  return (
    <div className="ag-editor" data-invalid={over || undefined} data-local-keys>
      <textarea
        aria-label={label}
        className="ag-textarea"
        value={draft}
        placeholder={placeholder}
        spellCheck
        rows={rows}
        disabled={disabled}
        onChange={(e) => {
          editing.current = true;
          setDraft(e.target.value);
          onDraft?.(e.target.value);
        }}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void commit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onLeave();
          }
        }}
      />
      {near ? (
        <span className={over ? 'st-error ag-count' : 'st-note ag-count'}>
          {count(draft.length)} / {count(max)} characters{over ? ': shorten it to save' : ''}
        </span>
      ) : null}
    </div>
  );
}

function ProjectLayer({
  label,
  role,
  projects,
  projectId,
  onProject,
  session,
  dirty,
  text,
  onDraft,
  onSave,
  onDiscard,
  onReload,
  onLeave,
}: {
  label: string;
  role: Role;
  projects: { value: string; label: string }[];
  projectId: string | null;
  onProject: (id: string) => void;
  session: ProjectPromptsSession;
  dirty: readonly Role[];
  text: string;
  onDraft: (text: string) => void;
  onSave: () => void;
  onDiscard: () => void;
  onReload: () => void;
  onLeave: () => void;
}) {
  const load = session.load;
  const data = load.status === 'ready' ? load.data : null;
  const saving = session.save.status === 'saving';
  const others = dirty.filter((r) => r !== role).length;
  const head = (
    <div className="ag-stop-head">
      <span className="ag-stop-title">This project</span>
      <span className="ag-stop-meta">
        legion.json{data && !data.exists ? ' · not created yet, saving creates it' : ''}
      </span>
      <span className="flex-1" />
      {projects.length > 0 && projectId ? (
        <Select label="Project" value={projectId} options={projects} onChange={onProject} />
      ) : null}
    </div>
  );
  if (!projectId) {
    return (
      <>
        {head}
        <p className="ag-stop-note">Add a project to give this role instructions for its repository.</p>
      </>
    );
  }
  return (
    <>
      {head}
      <p className="ag-stop-note">
        Committed with the repository, so everyone who runs Legion on it gets them. Saved with the button.
      </p>
      {load.status === 'loading' ? (
        <div className="st-note ag-loading">Reading legion.json…</div>
      ) : load.status === 'error' ? (
        <ProjectError message={`Couldn't read legion.json: ${load.message}`} onReload={onReload} />
      ) : load.data.error ? (
        <ProjectError
          message={`legion.json is invalid, so it can't be edited here: ${load.data.error}`}
          onReload={onReload}
        />
      ) : (
        <>
          <PromptText
            // Keyed by project so the editor never shows one project's text under another's name.
            key={projectId}
            label={`${label} additions for this project`}
            value={text}
            max={ADDITION_MAX}
            placeholder="Instructions only this repository needs, e.g. its commands or conventions."
            onDraft={onDraft}
            onLeave={onLeave}
            disabled={saving}
          />
          <div className="ag-save">
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={onSave}
              disabled={!dirty.length || saving || text.length > ADDITION_MAX}
            >
              {saving ? 'Saving…' : 'Save to legion.json'}
            </button>
            {dirty.length ? (
              <button type="button" className="btn btn-sm btn-ghost" onClick={onDiscard} disabled={saving}>
                Discard
              </button>
            ) : null}
            <span className="st-note" aria-live="polite">
              {session.save.status === 'saved' && !dirty.length ? (
                <span className="ag-saved">
                  <Icon name="check" size={12} strokeWidth={2.6} /> Saved to legion.json
                </span>
              ) : dirty.length ? (
                others > 0 ? (
                  `Unsaved here and in ${others} other ${others === 1 ? 'role' : 'roles'}; saving writes all of them.`
                ) : dirty.includes(role) ? (
                  'Unsaved changes.'
                ) : (
                  `Unsaved changes in another role.`
                )
              ) : savedText(session, role) ? null : (
                'Nothing here yet.'
              )}
            </span>
          </div>
          {session.save.status === 'error' ? (
            <ProjectError message={session.save.message} onReload={session.save.conflict ? onReload : undefined} />
          ) : null}
        </>
      )}
    </>
  );
}

function ProjectError({ message, onReload }: { message: string; onReload?: () => void }) {
  return (
    <div className="ag-error" role="alert">
      <span className="st-error min-w-0 flex-1">{message}</span>
      {onReload ? (
        <button type="button" className="btn btn-sm flex-none" onClick={onReload}>
          Reload
        </button>
      ) : null}
    </div>
  );
}

/** The joined prompt: Legion's text quiet, the human's own text marked, so the layers stay readable. */
function Received({ composed, base, unsaved }: { composed: string; base: string | null; unsaved: boolean }) {
  const [open, setOpen] = useState(false);
  const own = base !== null && composed.startsWith(base) ? composed.slice(base.length) : null;
  const headings = [PROMPT_LAYER_HEADINGS.append, PROMPT_LAYER_HEADINGS.project];
  return (
    <>
      <div className="ag-stop-head">
        <span className="ag-stop-title">What the agent receives</span>
        <span className="ag-stop-meta">
          {count(words(composed))} words{unsaved ? ' · with your unsaved edits' : ''}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          aria-expanded={open}
          aria-label={open ? 'Hide what the agent receives' : 'Show what the agent receives'}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? 'Hide' : 'Show'}
        </button>
      </div>
      {open ? (
        <div className="ag-text ag-received" data-open>
          {own !== null ? (
            <>
              <span className="ag-quiet">{base}</span>
              {own.trim() ? <span className="ag-own">{own.replace(/^\n+/, '')}</span> : null}
            </>
          ) : (
            composed
          )}
        </div>
      ) : (
        <p className="ag-stop-note">
          Legion’s prompt{base === null ? ' (replaced)' : ''}, then {headings.map((h) => `“${h}”`).join(' and ')} when
          they have text. The task itself follows as the first message.
        </p>
      )}
    </>
  );
}
