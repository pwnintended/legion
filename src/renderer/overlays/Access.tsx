/**
 * Settings → Access: which MCP servers and skills each agent role gets. Two parts: the registry of MCP
 * servers (defined once, with import from the user's Claude Code config) and, per project, the servers and
 * skills of every role. Nothing is shared by default. All of it goes through `settings.set`
 * (`mcpServers`, `access`), so the changes also reach sessions started afterwards, not running ones.
 */
import type { AgentAccess, McpServer, Role, Settings, SettingsPatch } from '@shared/domain';
import type { AvailableSkill, DiscoveredMcpServer } from '@shared/rpc';
import { useEffect, useId, useMemo, useState } from 'react';
import { rpc, useData, useUi } from '../app/hooks';
import { selectProjects } from '../app/projects';
import { errorMessage } from '../tiles/session/actions';
import {
  EMPTY_FORM,
  formFromServer,
  parseServerName,
  type ServerForm,
  serverFromForm,
  serverSummary,
  toggled,
} from './access-model';
import { Segmented, Select } from './SettingsControls';

type Commit = (patch: SettingsPatch) => Promise<boolean>;

/** The roles that can be given servers and skills (mirrors ACCESS_ROLES: the coordinating ones only talk). */
type AccessRole = Exclude<Role, 'lead' | 'research_lead' | 'assistant'>;
const ACCESS_ROLE_LIST: { role: AccessRole; label: string; note: string }[] = [
  { role: 'planner', label: 'Planner', note: 'Reads the repo and drafts the plan.' },
  { role: 'coder', label: 'Coder', note: 'Edits files in its task worktree.' },
  { role: 'reviewer', label: 'Reviewer', note: 'Reads a coder’s worktree.' },
  { role: 'resolver', label: 'Resolver', note: 'Resolves merge conflicts.' },
  { role: 'finalizer', label: 'Final review', note: 'Reviews the whole branch before the PR.' },
  { role: 'researcher', label: 'Researcher', note: 'Read-only research on a brief.' },
  { role: 'session', label: 'Session', note: 'Edits your checkout in a direct session.' },
];

const NO_ACCESS: AgentAccess = { mcp: [], skills: null };

export function AccessSection({ settings, commit }: { settings: Settings; commit: Commit }) {
  const serverNames = Object.keys(settings.mcpServers).sort();
  return (
    <section className="st-section" data-section="access" aria-labelledby="st-access">
      <h2 id="st-access" className="st-h">
        Access
      </h2>
      <p className="st-lede">
        Agents only get Legion's own tools and the CLI's built-in ones. Add MCP servers here, then choose per project
        which role may use which server and skill. Changes apply to sessions that start afterwards.
      </p>
      <McpServers settings={settings} commit={commit} />
      <ProjectAccess settings={settings} serverNames={serverNames} commit={commit} />
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// MCP server registry
// ---------------------------------------------------------------------------------------------

function McpServers({ settings, commit }: { settings: Settings; commit: Commit }) {
  const servers = Object.entries(settings.mcpServers).sort(([a], [b]) => a.localeCompare(b));
  // `null` = closed; a name = editing it (its name stays); '' = adding.
  const [editing, setEditing] = useState<string | null>(null);
  const activeProjectId = useUi((s) => s.activeProjectId);
  const [found, setFound] = useState<DiscoveredMcpServer[] | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  const discover = async () => {
    setImportError(null);
    try {
      const all = await rpc('mcpServers.discover', { projectId: activeProjectId });
      setFound(all.filter((entry) => !(entry.name in settings.mcpServers)));
    } catch (error) {
      setImportError(errorMessage(error));
    }
  };

  return (
    <>
      <div className="st-sub">MCP servers</div>
      <p className="st-lede">
        Defined once, usable by any project that grants them. A granted server is approved for the role up front, so
        grant read-only servers freely and write-capable ones (issue trackers, GitHub) to the roles that need them.
        Header and environment values are stored as typed.
      </p>
      {servers.length === 0 && editing === null ? (
        <div className="st-note ac-empty">No servers yet.</div>
      ) : (
        <ul className="ac-list" aria-label="MCP servers">
          {servers.map(([name, server]) => (
            <li key={name} className="ac-server" data-testid={`mcp-server-${name}`}>
              <span className="ac-server-main">
                <span className="ac-server-name">{name}</span>
                <span className="ac-server-sum mono" title={serverSummary(server)}>
                  {server.type === 'http' ? 'http' : 'command'} · {serverSummary(server)}
                </span>
              </span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(name)}>
                Edit
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                aria-label={`Remove ${name}`}
                onClick={() => void commit({ mcpServers: { [name]: null } })}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      {editing !== null ? (
        <ServerEditor
          key={editing}
          name={editing}
          initial={editing ? settings.mcpServers[editing] : undefined}
          taken={Object.keys(settings.mcpServers)}
          onCancel={() => setEditing(null)}
          onSave={async (name, server) => {
            const ok = await commit({ mcpServers: { [name]: server } });
            if (ok) setEditing(null);
            return ok;
          }}
        />
      ) : (
        <div className="ac-actions">
          <button type="button" className="btn btn-sm" onClick={() => setEditing('')}>
            Add server
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void discover()}>
            Import from Claude Code
          </button>
        </div>
      )}
      {importError ? <div className="st-error">{importError}</div> : null}
      {found ? (
        <fieldset className="ac-found" aria-label="Servers found in your Claude Code config">
          {found.length === 0 ? (
            <div className="st-note">Nothing new found in ~/.claude.json or the project's .mcp.json.</div>
          ) : (
            found.map((entry) => (
              <div key={entry.name} className="ac-server">
                <span className="ac-server-main">
                  <span className="ac-server-name">{entry.name}</span>
                  <span className="ac-server-sum mono" title={serverSummary(entry.server)}>
                    {entry.source} · {serverSummary(entry.server)}
                  </span>
                </span>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={async () => {
                    if (await commit({ mcpServers: { [entry.name]: entry.server } })) {
                      setFound((list) => list?.filter((e) => e.name !== entry.name) ?? null);
                    }
                  }}
                >
                  Add
                </button>
              </div>
            ))
          )}
        </fieldset>
      ) : null}
    </>
  );
}

function ServerEditor({
  name: initialName,
  initial,
  taken,
  onSave,
  onCancel,
}: {
  name: string;
  initial: McpServer | undefined;
  taken: string[];
  onSave: (name: string, server: McpServer) => Promise<boolean>;
  onCancel: () => void;
}) {
  const id = useId();
  const renaming = initialName !== '';
  const [name, setName] = useState(initialName);
  const [form, setForm] = useState<ServerForm>(initial ? formFromServer(initial) : EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<ServerForm>) => setForm((f) => ({ ...f, ...patch }));

  const submit = async () => {
    const checkedName = renaming ? { ok: true as const, value: initialName } : parseServerName(name, taken);
    if (!checkedName.ok) return setError(checkedName.message);
    const server = serverFromForm(form);
    if (!server.ok) return setError(server.message);
    setError(null);
    setBusy(true);
    const ok = await onSave(checkedName.value, server.value);
    setBusy(false);
    if (!ok) setError('Could not save the server.');
  };

  return (
    <form
      className="st-card ac-editor"
      aria-label={renaming ? `Edit ${initialName}` : 'Add an MCP server'}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="ac-editor-top">
        <label className="st-field" htmlFor={`${id}-name`}>
          <span className="st-field-label">Name</span>
          <input
            id={`${id}-name`}
            className="field ac-input mono"
            value={name}
            disabled={renaming}
            placeholder="linear"
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <Segmented<'http' | 'stdio'>
          labelledBy={`${id}-name`}
          value={form.type}
          options={[
            { value: 'http', label: 'HTTP' },
            { value: 'stdio', label: 'Command' },
          ]}
          onChange={(type) => set({ type })}
        />
      </div>
      {form.type === 'http' ? (
        <>
          <label className="st-field" htmlFor={`${id}-url`}>
            <span className="st-field-label">URL</span>
            <input
              id={`${id}-url`}
              className="field ac-input mono"
              value={form.url}
              placeholder="https://mcp.example.com/mcp"
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => set({ url: e.target.value })}
            />
          </label>
          <label className="st-field" htmlFor={`${id}-headers`}>
            <span className="st-field-label">Headers, one per line</span>
            <textarea
              id={`${id}-headers`}
              className="field ac-input ac-area mono"
              value={form.headers}
              rows={2}
              placeholder="Authorization: Bearer …"
              spellCheck={false}
              onChange={(e) => set({ headers: e.target.value })}
            />
          </label>
        </>
      ) : (
        <>
          <label className="st-field" htmlFor={`${id}-command`}>
            <span className="st-field-label">Command</span>
            <input
              id={`${id}-command`}
              className="field ac-input mono"
              value={form.command}
              placeholder="npx -y @acme/mcp-server"
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => set({ command: e.target.value })}
            />
          </label>
          <label className="st-field" htmlFor={`${id}-env`}>
            <span className="st-field-label">Environment, one per line</span>
            <textarea
              id={`${id}-env`}
              className="field ac-input ac-area mono"
              value={form.env}
              rows={2}
              placeholder="API_KEY=…"
              spellCheck={false}
              onChange={(e) => set({ env: e.target.value })}
            />
          </label>
        </>
      )}
      {error ? <div className="st-error">{error}</div> : null}
      <div className="ac-actions">
        <button type="submit" className="btn btn-sm btn-primary" disabled={busy}>
          {renaming ? 'Save' : 'Add server'}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------------------------
// Per project, per role
// ---------------------------------------------------------------------------------------------

function ProjectAccess({
  settings,
  serverNames,
  commit,
}: {
  settings: Settings;
  serverNames: string[];
  commit: Commit;
}) {
  const projects = useData(selectProjects);
  const activeProjectId = useUi((s) => s.activeProjectId);
  const [chosen, setChosen] = useState<string | null>(null);
  const projectId =
    projects.find((p) => p.id === chosen)?.id ??
    projects.find((p) => p.id === activeProjectId)?.id ??
    projects[0]?.id ??
    null;
  const [skills, setSkills] = useState<AvailableSkill[] | null>(null);
  const [skillError, setSkillError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId) return;
    let alive = true;
    setSkills(null);
    setSkillError(null);
    rpc('skills.list', { projectId }).then(
      (list) => alive && setSkills(list),
      (error) => alive && setSkillError(errorMessage(error)),
    );
    return () => {
      alive = false;
    };
  }, [projectId]);

  return (
    <>
      <div className="st-sub">Per project</div>
      {projectId === null ? (
        <div className="st-note ac-empty">Add a project to choose what its agents may use.</div>
      ) : (
        <>
          <div className="st-row">
            <div className="min-w-0 flex-1">
              <div className="st-label">Project</div>
              <div className="st-note">
                Grants are kept per project. Skills are listed from your skill folders and the repo.
              </div>
            </div>
            <Select
              label="Project"
              value={projectId}
              options={projects.map((p) => ({ value: p.id, label: p.name }))}
              onChange={setChosen}
            />
          </div>
          {skillError ? <div className="st-error">{skillError}</div> : null}
          <div className="ac-roles">
            {ACCESS_ROLE_LIST.map(({ role, label, note }) => (
              <RoleAccess
                key={`${projectId}:${role}`}
                label={label}
                note={note}
                access={settings.access[projectId]?.[role] ?? NO_ACCESS}
                serverNames={serverNames}
                skills={skills}
                onChange={(next) => void commit({ access: { [projectId]: { [role]: next } } })}
              />
            ))}
          </div>
          <p className="st-note ac-foot">
            Lead, research lead and the assistant only talk through Legion, so they never get extra servers or skills.
          </p>
        </>
      )}
    </>
  );
}

function RoleAccess({
  label,
  note,
  access,
  serverNames,
  skills,
  onChange,
}: {
  label: string;
  note: string;
  access: AgentAccess;
  serverNames: string[];
  skills: AvailableSkill[] | null;
  onChange: (next: AgentAccess) => void;
}) {
  const id = useId();
  const skillNames = useMemo(() => (skills ?? []).map((s) => s.name), [skills]);
  // Allowed names that no longer exist on disk stay visible, so they can be removed.
  const shown = useMemo(() => {
    const missing = (access.skills ?? []).filter((n) => !skillNames.includes(n));
    return [
      ...(skills ?? []),
      ...missing.map((name) => ({ name, description: 'Not found on disk.', scope: 'user' as const })),
    ];
  }, [skills, skillNames, access.skills]);
  const unknownServers = access.mcp.filter((n) => !serverNames.includes(n));

  return (
    <div className="ac-role" data-role={label}>
      <div className="ac-role-head">
        <span className="ac-role-name">{label}</span>
        <span className="st-note">{note}</span>
      </div>
      <div className="ac-line">
        <span className="ac-key" id={`${id}-mcp`}>
          MCP
        </span>
        {serverNames.length === 0 ? (
          <span className="st-note">Add a server above to grant it.</span>
        ) : (
          <fieldset className="ac-chips" aria-labelledby={`${id}-mcp`}>
            {serverNames.map((name) => (
              <button
                key={name}
                type="button"
                className="ac-chip"
                aria-pressed={access.mcp.includes(name)}
                onClick={() => onChange({ ...access, mcp: toggled(access.mcp, name, serverNames) })}
              >
                {name}
              </button>
            ))}
          </fieldset>
        )}
        {unknownServers.length > 0 ? (
          <span className="st-note">{unknownServers.join(', ')} no longer exists.</span>
        ) : null}
      </div>
      <div className="ac-line">
        <span className="ac-key" id={`${id}-skills`}>
          Skills
        </span>
        <Segmented<'default' | 'only'>
          labelledBy={`${id}-skills`}
          value={access.skills === null ? 'default' : 'only'}
          options={[
            { value: 'default', label: 'Default' },
            { value: 'only', label: 'Only these' },
          ]}
          onChange={(mode) => onChange({ ...access, skills: mode === 'default' ? null : (access.skills ?? []) })}
        />
        {access.skills === null ? (
          <span className="st-note">The CLI’s own set: its bundled skills and the repo’s.</span>
        ) : shown.length === 0 && skills !== null ? (
          <span className="st-note">No skills found. The agent gets none.</span>
        ) : null}
      </div>
      {access.skills !== null && shown.length > 0 ? (
        <fieldset className="ac-chips ac-chips-skills" aria-label={`${label} skills`}>
          {shown.map((skill) => (
            <button
              key={skill.name}
              type="button"
              className="ac-chip"
              title={skill.description}
              data-scope={skill.scope}
              aria-pressed={access.skills?.includes(skill.name)}
              onClick={() => onChange({ ...access, skills: toggled(access.skills ?? [], skill.name, skillNames) })}
            >
              {skill.name}
              {skill.scope === 'project' ? <span className="ac-chip-tag">repo</span> : null}
            </button>
          ))}
        </fieldset>
      ) : null}
    </div>
  );
}
