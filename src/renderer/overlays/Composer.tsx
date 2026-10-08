/**
 * Composer, in two modes:
 * - `session` (⌘⇧N): a direct session. Say what you want, pick a repository and an engine; ⌘⏎ opens one agent
 *   working in that checkout (`runs.session`), no plan.
 * - `run` ("Branch and engine…" from a new conversation, "Start a run about these lines"): describe the work or
 *   paste a GitHub / Linear URL, pick a base branch and the planner engine; ⌘⏎ starts the assistant or the planner.
 * Both pick a repository the same way (recent, found on this Mac, a typed path, Browse… ⌘O, or a folder dropped
 * from Finder) and focus the new run. Screenshots and files attach by paste (⌘V), drop or the Attach button (⌘⇧A).
 * The draft, attachments included, survives closing the overlay and switching modes. In a session, `/` (Claude) or
 * `$` (Codex) offers the skills the agent can be asked for (`skills.invocable`).
 */
import type { EngineKind } from '@shared/domain';
import type { EngineInfo } from '@shared/engine';
import { examplePath, separator } from '@shared/paths';
import type { AvailableSkill, DiscoveredRepo, RecentRepo, RepoBranches, RepoInspection } from '@shared/rpc';
import { type ReactNode, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { seededBase, seededText, takeComposerSeed } from '../app/composer-seed';
import { rpc, useActiveRun, useEngines, useSettings } from '../app/hooks';
import { formatChord } from '../app/keys';
import { OS } from '../app/platform';
import { adoptRun } from '../app/run-actions';
import { actions } from '../app/store';
import {
  AttachButton,
  AttachmentTray,
  attachShortcut,
  createDraft,
  pasteInto,
  splitDrop,
  useDraft,
  useFileDrop,
} from '../attachments/Attachments';
import { dragIntent } from '../attachments/model';
import { Icon } from '../chrome/icons';
import { CommandKbd, Kbd } from '../chrome/ui';
import { errorMessage } from '../tiles/session/actions';
import { BranchPicker, RepoPicker } from './Picker';
import { abbreviatePath, baseName, mergeRepos, pathFromFileUrl } from './picker-model';
import { OverlayPanel } from './Shell';
import { applySkill, rankSkills, type SkillQuery, skillQuery, skillSigil } from './skill-complete';

interface Draft {
  text: string;
  repoPath: string | null;
  base: string;
  engine: EngineKind | null;
  clarify: boolean;
}
let saved: Draft = { text: '', repoPath: null, base: '', engine: null, clarify: true };
/** The composer's attachments: kept (uploaded drafts) while the overlay is closed. */
const savedAttachments = createDraft();

export interface IssueLink {
  url: string;
  provider: 'github' | 'linear';
  label: string;
}

/** A GitHub issue/PR or Linear issue URL in the text, if any. */

const EXPANDED_KEY = 'legion.composer.expanded';

function readExpanded(): boolean {
  try {
    return localStorage.getItem(EXPANDED_KEY) === '1';
  } catch {
    return false;
  }
}

export function detectIssueLink(text: string): IssueLink | null {
  const gh = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(issues|pull)\/(\d+)/.exec(text);
  if (gh) return { url: gh[0], provider: 'github', label: `${gh[1]}/${gh[2]}#${gh[4]}` };
  const linear = /https:\/\/linear\.app\/([\w-]+)\/issue\/([A-Z][A-Z0-9]*-\d+)[\w/-]*/.exec(text);
  if (linear) return { url: linear[0], provider: 'linear', label: linear[2] ?? 'Linear issue' };
  return null;
}

function engineState(info: EngineInfo | undefined): { ok: boolean; note: string } {
  if (!info) return { ok: false, note: 'not detected' };
  if (!info.installed) return { ok: false, note: 'not installed' };
  if (info.loggedIn === false) return { ok: false, note: 'not logged in' };
  return { ok: true, note: info.version ? `v${info.version}` : 'ready' };
}

type Inspect =
  | { status: 'idle' | 'loading' }
  | { status: 'done'; result: RepoInspection }
  | { status: 'error'; message: string };

/** Discovery is cached by the engine; keep the last answer here too so reopening ⌘⇧N is instant. */
let lastFound: DiscoveredRepo[] | null = null;
let lastHome: string | null = null;

/** Render `code` spans in a message as inline code. */
function withCode(text: string): React.ReactNode {
  const parts = text.split('`');
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: static split of one message
      <code key={i} className="cmp-code">
        {part}
      </code>
    ) : (
      part
    ),
  );
}

/** An actionable sentence for why a folder can't be used (`code` marks commands). */
export function repoProblem(inspection: RepoInspection): string {
  switch (inspection.error) {
    case 'not a git repository':
      return 'Not a git repository. Run `git init` there, or pick another folder.';
    case 'not a directory':
      return inspection.exists
        ? 'Not a folder. Pick or drop a folder.'
        : "That folder doesn't exist. Pick another one.";
    case 'path must be absolute':
      return `Use a full path, like ${examplePath(OS, 'folder')} or ~${separator(OS)}src.`;
    default:
      return inspection.error ?? 'Not a git repository. Pick another folder.';
  }
}

type LegionWindow = Window & {
  legion?: {
    pickDirectory?: (o: { title?: string; defaultPath?: string }) => Promise<string | null>;
    pathForFile?: (file: File) => string;
  };
};

export type ComposerMode = 'session' | 'run';

/** ⌘⇧N: the composer for a direct session. */
export function SessionComposerOverlay() {
  return <Composer mode="session" />;
}

/** The composer for a planned run (the assistant or the planner). */
export function ComposerOverlay() {
  return <Composer mode="run" />;
}

function Composer({ mode }: { mode: ComposerMode }) {
  const session = mode === 'session';
  const ids = useId();
  const activeRun = useActiveRun();
  const engines = useEngines();
  const settings = useSettings();
  // Opened from a project (or "Start a run about this…"): that project, plus any reference text.
  const [seed] = useState(takeComposerSeed);
  const [text, setText] = useState(() => seededText(saved.text, seed));
  const [repoPath, setRepoPath] = useState<string | null>(
    seed?.repoPath ?? saved.repoPath ?? activeRun?.repoPath ?? null,
  );
  const [base, setBase] = useState(() => seededBase(saved.base, saved.repoPath, seed));
  const [engine, setEngine] = useState<EngineKind>(
    saved.engine ?? settings?.roles[session ? 'session' : 'planner'].engine ?? 'claude',
  );
  const [clarify, setClarify] = useState(saved.clarify);
  // With the assistant on (Settings → Agents), the prompt starts a conversation; off, it goes to the planner.
  const viaAssistant = !session && settings?.assistant.enabled !== false;
  const [recent, setRecent] = useState<RecentRepo[]>([]);
  const [found, setFound] = useState<DiscoveredRepo[]>(lastFound ?? []);
  const [discovering, setDiscovering] = useState(lastFound === null);
  const [home, setHome] = useState<string | null>(lastHome);
  const [inspect, setInspect] = useState<Inspect>({ status: 'idle' });
  const [branches, setBranches] = useState<{ root: string; value: RepoBranches } | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [creating, setCreating] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const [expanded, setExpanded] = useState(readExpanded);
  const attachments = useDraft(savedAttachments);
  const uploading = attachments.items.some((i) => i.status === 'uploading');
  const drop = useFileDrop((data) => {
    const { folders, files } = splitDrop(data);
    const folder = folders[0] ?? (files.length === 0 ? pathFromFileUrl(data.getData('text/uri-list')) : null);
    if (folder) selectRepo(folder);
    if (files.length) void savedAttachments.addFiles(files);
  });

  useEffect(() => {
    saved = { text, repoPath, base, engine, clarify };
  }, [text, repoPath, base, engine, clarify]);

  useEffect(() => {
    let cancelled = false;
    rpc('repos.recent', {})
      .then((list) => {
        if (cancelled) return;
        setRecent(list);
        setRepoPath((current) => current ?? list[0]?.path ?? null);
      })
      .catch(() => {});
    rpc('app.info', {})
      .then((info) => {
        lastHome = info.homeDir ?? null;
        if (!cancelled) setHome(lastHome);
      })
      .catch(() => {});
    rpc('repos.discover', {})
      .then((list) => {
        lastFound = list;
        if (!cancelled) setFound(list);
      })
      .catch(() => {})
      .finally(() => !cancelled && setDiscovering(false));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!repoPath) {
      setInspect({ status: 'idle' });
      return;
    }
    let cancelled = false;
    setInspect({ status: 'loading' });
    rpc('repos.inspect', { path: repoPath }).then(
      (result) => !cancelled && setInspect({ status: 'done', result }),
      (error: unknown) => !cancelled && setInspect({ status: 'error', message: errorMessage(error) }),
    );
    return () => {
      cancelled = true;
    };
  }, [repoPath]);

  const inspection = inspect.status === 'done' ? inspect.result : null;
  const root = inspection?.isGitRepo ? inspection.root : null;
  // Runs branch from a commit: a fresh `git init` needs its first one (Legion can make it).
  const noCommits = !!root && !inspection?.headSha;
  const checkedOut = inspection?.currentBranch ?? null;
  const headSha = inspection?.headSha ?? null;

  // biome-ignore lint/correctness/useExhaustiveDependencies: the branches appear with the first commit (`headSha`).
  useEffect(() => {
    if (!root) return;
    let cancelled = false;
    rpc('repos.branches', { path: root }).then(
      (value) => !cancelled && setBranches({ root, value }),
      () => !cancelled && setBranches({ root, value: { current: null, default: null, local: [], remote: [] } }),
    );
    return () => {
      cancelled = true;
    };
  }, [root, headSha]);

  // A repo that inspects fine is recorded as recent by the engine: refresh the list so it shows up there.
  useEffect(() => {
    if (!root) return;
    let cancelled = false;
    rpc('repos.recent', {})
      .then((list) => !cancelled && setRecent(list))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [root]);

  // The skills a session here can be asked for (they differ per engine).
  const [skills, setSkills] = useState<AvailableSkill[]>([]);
  useEffect(() => {
    setSkills([]);
    if (!session || !root) return;
    let cancelled = false;
    rpc('skills.invocable', { repoPath: root, engine })
      .then((list) => !cancelled && setSkills(list))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [session, root, engine]);
  const skillMenu = useSkillMenu(textRef, text, setText, session ? skills : [], skillSigil(engine));

  const activeRepo = activeRun?.repoPath ?? null;
  const repoLists = useMemo(
    () => mergeRepos(recent, found, activeRepo ? [activeRepo] : []),
    [recent, found, activeRepo],
  );

  const selectRepo = (path: string) => {
    setSubmitError(null);
    setCommitError(null);
    if (path === repoPath) return;
    setRepoPath(path);
    setBase('');
  };

  const chooseFolder = async () => {
    const legion = (window as LegionWindow).legion;
    const parent = repoPath ? repoPath.replace(/\/[^/]+\/?$/, '') : undefined;
    const picked = await legion?.pickDirectory?.({ title: 'Choose a repository', defaultPath: parent || undefined });
    if (picked) selectRepo(picked);
  };

  const initialCommit = async () => {
    if (!root || committing) return;
    setCommitting(true);
    setCommitError(null);
    setSubmitError(null);
    try {
      setInspect({ status: 'done', result: await rpc('repos.initialCommit', { path: root }) });
    } catch (error) {
      setCommitError(errorMessage(error));
    } finally {
      setCommitting(false);
    }
  };

  const link = session ? null : detectIssueLink(text);
  const repoError = !repoPath
    ? 'Choose a repository.'
    : inspect.status === 'error'
      ? inspect.message
      : inspection && !inspection.isGitRepo
        ? repoProblem(inspection)
        : noCommits
          ? session
            ? 'No commits yet. A session needs a first commit to start from.'
            : 'No commits yet. Agents work on branches cut from a commit.'
          : null;
  const textError = text.trim()
    ? null
    : session
      ? 'Say what the session should do.'
      : 'Describe the work or paste an issue URL.';
  const engineInfo = engines.list.find((e) => e.kind === engine);
  const engineError =
    engines.status === 'ready' && !engineState(engineInfo).ok
      ? `${engine === 'codex' ? 'Codex' : 'Claude Code'} is ${engineState(engineInfo).note}.`
      : null;
  const ready = !textError && !repoError && !engineError && inspect.status !== 'loading' && !uploading;
  const blocked = textError
    ? session
      ? 'Say what to do first'
      : 'Describe the work first'
    : !repoPath
      ? 'Choose a repository first'
      : inspect.status === 'loading'
        ? 'Checking the repository…'
        : noCommits
          ? 'Create the first commit first'
          : repoError
            ? 'Pick a git repository first'
            : engineError
              ? engineError
              : uploading
                ? 'Attachments are still uploading…'
                : null;
  const branchState = branches && branches.root === root ? branches.value : null;

  const submit = async () => {
    setAttempted(true);
    setSubmitError(null);
    if (!ready || creating || !repoPath) {
      if (textError) textRef.current?.focus();
      return;
    }
    setCreating(true);
    try {
      const run = session
        ? await rpc('runs.session', {
            repoPath: inspection?.root ?? repoPath,
            prompt: text.trim(),
            engine,
            model: null,
            attachmentIds: savedAttachments.ids,
          })
        : viaAssistant
          ? await rpc('runs.chat', {
              repoPath: inspection?.root ?? repoPath,
              baseRef: base.trim() || null,
              prompt: text.trim(),
              engine,
              model: null,
              attachmentIds: savedAttachments.ids,
            })
          : await rpc('runs.create', {
              repoPath: inspection?.root ?? repoPath,
              baseRef: base.trim() || null,
              title: null,
              issueText: text.trim(),
              issueUrl: link?.url ?? null,
              plannerEngine: engine,
              plannerModel: null,
              skipClarify: !clarify,
              attachmentIds: savedAttachments.ids,
            });
      saved = { text: '', repoPath, base: '', engine, clarify };
      savedAttachments.clear();
      actions.closeOverlay();
      // Into the store first: the run's `run.updated` may still be on its way, and an active run the store
      // doesn't know is replaced by the first run of the list on the next data event.
      adoptRun(run);
      actions.setActiveRun(run.id);
      actions.setView('chat');
    } catch (error) {
      setSubmitError(errorMessage(error));
    } finally {
      setCreating(false);
    }
  };

  const toggleExpanded = () => {
    setExpanded((value) => {
      const next = !value;
      try {
        localStorage.setItem(EXPANDED_KEY, next ? '1' : '0');
      } catch {}
      return next;
    });
    textRef.current?.focus();
  };

  const statusId = `${ids}-repo-status`;
  return (
    <OverlayPanel
      label={session ? 'New session' : 'New run'}
      placement="center"
      width={expanded ? 'min(1240px, 100%)' : 'min(920px, 100%)'}
      top={expanded ? 40 : 90}
      testId={session ? 'session-composer' : 'composer'}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          void submit();
        } else if (event.key.toLowerCase() === 'e' && (event.metaKey || event.ctrlKey) && event.shiftKey) {
          event.preventDefault();
          toggleExpanded();
        } else if (event.key.toLowerCase() === 'o' && (event.metaKey || event.ctrlKey) && !event.shiftKey) {
          event.preventDefault();
          void chooseFolder();
        } else {
          attachShortcut(savedAttachments, event);
        }
      }}
    >
      {/* A drop target for files (attachments) and folders (the repository) from Finder. */}
      <div
        className="cmp-root"
        data-expanded={expanded || undefined}
        {...drop.handlers}
        onPaste={(event) => {
          if (pasteInto(savedAttachments, event)) setSubmitError(null);
        }}
      >
        <div className="ovl-head ovl-head-plain">
          <span className="ovl-title">{session ? 'New session' : 'New run'}</span>
          {session ? <CommandKbd id="composer.open" /> : null}
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            style={{ marginLeft: 'auto' }}
            aria-label={expanded ? 'Shrink the composer' : 'Expand the composer'}
            aria-pressed={expanded}
            title={`${expanded ? 'Shrink' : 'Expand'}  ${formatChord('Mod+Shift+E')}`}
            data-testid="composer-expand"
            onClick={toggleExpanded}
          >
            <Icon name={expanded ? 'minimize' : 'maximize'} size={14} />
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            aria-label="Close"
            onClick={() => actions.closeOverlay()}
          >
            <Icon name="close" size={14} />
          </button>
        </div>
        <form
          className="cmp"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label htmlFor={`${ids}-text`} className="cmp-label">
            What should happen?
          </label>
          <div className="cmp-text-wrap" data-invalid={attempted && !!textError}>
            <textarea
              id={`${ids}-text`}
              ref={textRef}
              className="field cmp-text"
              rows={10}
              value={text}
              data-autofocus
              spellCheck
              placeholder={
                session
                  ? `Ask about the code or describe a change. Type ${skillSigil(engine)} for a skill, paste a screenshot if it helps…`
                  : 'Describe an issue or feature, paste a GitHub / Linear URL or a screenshot…'
              }
              aria-invalid={attempted && !!textError}
              aria-describedby={`${ids}-text-note`}
              {...skillMenu.inputProps(`${ids}-skills`)}
              onChange={(event) => {
                setText(event.target.value);
                skillMenu.noteCaret(event.target);
              }}
            />
            {skillMenu.open ? <SkillList id={`${ids}-skills`} menu={skillMenu} /> : null}
            {link ? (
              <span className="cmp-link" data-testid="composer-link">
                <Icon name={link.provider === 'github' ? 'pr' : 'list'} size={12} />
                {link.provider === 'github' ? 'GitHub' : 'Linear'} · {link.label}
              </span>
            ) : null}
            <AttachButton draft={savedAttachments} label="Attach" className="cmp-attach" />
          </div>
          <span id={`${ids}-text-note`} className="cmp-error" hidden={!(attempted && textError)}>
            {textError}
          </span>
          <AttachmentTray draft={savedAttachments} returnFocus={() => textRef.current?.focus()} />

          <div className="cmp-row">
            <div className="cmp-field cmp-repo">
              <label htmlFor={`${ids}-repo`} className="cmp-small">
                Repository
              </label>
              <RepoPicker
                id={`${ids}-repo`}
                value={repoPath}
                valueName={repoPath ? (inspection?.root ? baseName(inspection.root) : baseName(repoPath)) : null}
                home={home}
                recent={repoLists.recent}
                found={repoLists.found}
                discovering={discovering}
                invalid={repoPath && repoError ? true : attempted && !!repoError}
                describedBy={statusId}
                onChange={selectRepo}
                onBrowse={() => void chooseFolder()}
              />
            </div>
            {session ? null : (
              <div className="cmp-field cmp-base">
                <label htmlFor={`${ids}-base`} className="cmp-small">
                  Base branch
                </label>
                <BranchPicker
                  id={`${ids}-base`}
                  value={base}
                  branches={branchState}
                  loading={!!root && !branchState}
                  disabled={!root}
                  disabledReason="Choose a repository first"
                  onChange={setBase}
                />
              </div>
            )}
            <div className="cmp-field cmp-planner">
              <span className="cmp-small" id={`${ids}-engine`}>
                {session ? 'Engine' : 'Planner'}
              </span>
              <div className="segs cmp-segs" role="radiogroup" aria-labelledby={`${ids}-engine`}>
                {(['claude', 'codex'] as const).map((kind) => {
                  const st = engineState(engines.list.find((e) => e.kind === kind));
                  const known = engines.status === 'ready';
                  return (
                    // biome-ignore lint/a11y/useSemanticElements: a segmented control, not native radios
                    <button
                      key={kind}
                      type="button"
                      role="radio"
                      aria-checked={engine === kind}
                      className="seg cmp-seg"
                      data-engine={kind}
                      title={known ? `${kind === 'claude' ? 'Claude Code' : 'Codex'} · ${st.note}` : undefined}
                      // Keep focus in the text field on click, so ⌘⏎ still submits.
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => setEngine(kind)}
                      onKeyDown={(event) => {
                        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                          event.preventDefault();
                          setEngine(kind === 'claude' ? 'codex' : 'claude');
                        }
                      }}
                    >
                      {engine === kind ? <span className="seg-pill" /> : null}
                      <span
                        className="dot"
                        style={{
                          width: 6,
                          height: 6,
                          color: !known ? 'var(--overlay0)' : st.ok ? 'var(--green)' : 'var(--red)',
                        }}
                      />
                      {kind === 'claude' ? 'Claude' : 'Codex'}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          <RepoStatus
            id={statusId}
            inspect={inspect}
            path={repoPath}
            home={home}
            error={repoPath ? repoError : attempted ? repoError : null}
            session={session}
            fix={
              noCommits ? (
                <>
                  <button
                    type="button"
                    className="btn btn-sm"
                    data-testid="repo-initial-commit"
                    disabled={committing}
                    title="git add -A && git commit -m 'Initial commit' (.gitignore applies)"
                    onClick={() => void initialCommit()}
                  >
                    {committing ? 'Committing…' : 'Commit its files as "Initial commit"'}
                  </button>
                  {commitError ? <span className="cmp-error">{commitError}</span> : null}
                </>
              ) : null
            }
          />
          {engineError ? <span className="cmp-error">{engineError}</span> : null}

          <div className="cmp-foot">
            {viaAssistant || session ? null : (
              <label className="cmp-check">
                <input type="checkbox" checked={clarify} onChange={(event) => setClarify(event.target.checked)} />
                Let the planner ask clarifying questions first
              </label>
            )}
            <span className="cmp-submit-wrap" data-blocked={!!blocked && !creating}>
              <button
                type="submit"
                className="btn btn-primary cmp-submit"
                disabled={creating}
                aria-disabled={!ready}
                aria-describedby={blocked ? `${ids}-blocked` : undefined}
                data-ready={ready}
                data-testid="composer-submit"
              >
                {creating
                  ? session
                    ? 'Starting…'
                    : 'Creating…'
                  : session
                    ? 'Start'
                    : viaAssistant
                      ? 'Ask'
                      : 'Plan it'}
                <Kbd chord="Mod+Enter" />
              </button>
              {blocked && !creating ? (
                <span id={`${ids}-blocked`} role="tooltip" className="cmp-tip" data-testid="composer-blocked">
                  {blocked}
                </span>
              ) : null}
            </span>
          </div>
          {submitError ? (
            <span className="cmp-error" role="alert">
              Couldn't {session ? 'start the session' : 'create the run'}: {submitError}
            </span>
          ) : null}
          <p className="cmp-hint">
            {session
              ? `The agent works in your checkout${checkedOut ? ` on ${checkedOut}` : ''}, no worktree and no plan. Its edits land as they are; committing is up to you.`
              : viaAssistant
                ? 'The assistant answers, researches the repo when needed, and hands a brief to the planner when you want the work done. Nothing runs until you approve the plan.'
                : `The planner reads the repo${clarify ? ', asks up to 5 clarifying questions,' : ''} then drafts the task DAG for your sign-off. Nothing runs until you approve it.`}
          </p>
        </form>
        {drop.dragging ? <DropHint intent={dragIntent(drop.dragging)} /> : null}
      </div>
    </OverlayPanel>
  );
}

type SkillMenu = ReturnType<typeof useSkillMenu>;

/** The skill suggestions for a textarea: where the reference is, which skills match, and the keys that pick one. */
function useSkillMenu(
  textRef: React.RefObject<HTMLTextAreaElement | null>,
  text: string,
  setText: (text: string) => void,
  skills: readonly AvailableSkill[],
  sigil: '/' | '$',
) {
  const [caret, setCaret] = useState<number | null>(null);
  const [active, setActive] = useState(0);
  // Esc hides the list until the reference changes.
  const [dismissed, setDismissed] = useState<string | null>(null);
  const placed = useRef<number | null>(null);

  const at: SkillQuery | null = caret === null ? null : skillQuery(text, caret, sigil);
  const key = at ? `${at.start}:${at.query}` : null;
  const matches = useMemo(() => (at ? rankSkills(skills, at.query) : []), [skills, at?.query, at]);
  const open = !!at && matches.length > 0 && dismissed !== key;

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new query starts at the best match.
  useEffect(() => setActive(0), [key]);
  // After a pick, put the caret behind the inserted name.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the picked text has rendered.
  useLayoutEffect(() => {
    const el = textRef.current;
    if (placed.current === null || !el) return;
    el.setSelectionRange(placed.current, placed.current);
    setCaret(placed.current);
    placed.current = null;
  }, [text]);

  const noteCaret = (el: HTMLTextAreaElement) =>
    setCaret(el.selectionStart === el.selectionEnd ? el.selectionStart : null);

  const pick = (skill: AvailableSkill) => {
    if (!at) return;
    const next = applySkill(text, at, skill.name, sigil);
    placed.current = next.caret;
    setText(next.text);
    textRef.current?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!open || event.nativeEvent.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
    const move = (delta: number) => setActive((i) => (i + delta + matches.length) % matches.length);
    if (event.key === 'ArrowDown') move(1);
    else if (event.key === 'ArrowUp') move(-1);
    else if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey) {
      const skill = matches[Math.min(active, matches.length - 1)];
      if (skill) pick(skill);
    } else if (event.key === 'Escape') setDismissed(key);
    else return;
    event.preventDefault();
    event.stopPropagation();
  };

  return {
    open,
    matches,
    active: Math.min(active, matches.length - 1),
    sigil,
    pick,
    noteCaret,
    setActive,
    /** Where the list goes: by the line the reference is on, in the text wrap's coordinates. */
    anchor: (): CaretPoint | null => {
      const el = textRef.current;
      return el && at ? caretPoint(el, at.start) : null;
    },
    inputProps: (listId: string) => ({
      'aria-autocomplete': 'list' as const,
      'aria-controls': open ? listId : undefined,
      'aria-expanded': open,
      'aria-activedescendant': open ? `${listId}-${Math.min(active, matches.length - 1)}` : undefined,
      // While the list is up, its keys (Esc above all) are the text field's, not the overlay's.
      'data-local-keys': open || undefined,
      onKeyDown,
      onSelect: (event: React.SyntheticEvent<HTMLTextAreaElement>) => noteCaret(event.currentTarget),
      onBlur: () => setCaret(null),
      onFocus: (event: React.FocusEvent<HTMLTextAreaElement>) => noteCaret(event.currentTarget),
    }),
  };
}

interface CaretPoint {
  /** Top and bottom of the line, left of the character, in the textarea's offset parent. */
  top: number;
  bottom: number;
  left: number;
  /** Room below the line inside the textarea. */
  below: number;
}

/** Where `index` sits in a textarea, relative to its offset parent (a hidden mirror of the text measures it). */
function caretPoint(el: HTMLTextAreaElement, index: number): CaretPoint {
  const style = getComputedStyle(el);
  const mirror = document.createElement('div');
  for (const prop of [
    'boxSizing',
    'width',
    'paddingTop',
    'paddingRight',
    'paddingBottom',
    'paddingLeft',
    'borderTopWidth',
    'borderRightWidth',
    'borderBottomWidth',
    'borderLeftWidth',
    'fontFamily',
    'fontSize',
    'fontWeight',
    'lineHeight',
    'letterSpacing',
    'tabSize',
  ] as const) {
    mirror.style[prop] = style[prop];
  }
  Object.assign(mirror.style, {
    position: 'absolute',
    visibility: 'hidden',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'break-word',
    top: '0',
    left: '-9999px',
  });
  mirror.textContent = el.value.slice(0, index);
  const mark = document.createElement('span');
  mark.textContent = '\u200b';
  mirror.appendChild(mark);
  document.body.appendChild(mirror);
  const line = Number.parseFloat(style.lineHeight) || mark.offsetHeight;
  const top = mark.offsetTop - el.scrollTop;
  const left = mark.offsetLeft - el.scrollLeft;
  mirror.remove();
  return {
    top: el.offsetTop + top,
    bottom: el.offsetTop + top + line,
    left: el.offsetLeft + left,
    below: el.clientHeight - top - line,
  };
}

/** Height the list may take (its max-height plus a gap). */
const LIST_ROOM = 240;

function SkillList({ id, menu }: { id: string; menu: SkillMenu }) {
  const listRef = useRef<HTMLDivElement>(null);
  const point = menu.anchor();
  // Under the line, or above it when the text field has no room left below.
  const above = !!point && point.below < LIST_ROOM && point.top > LIST_ROOM;
  useLayoutEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[id="${CSS.escape(`${id}-${menu.active}`)}"]`)?.scrollIntoView({
      block: 'nearest',
    });
  }, [id, menu.active]);
  return (
    <div
      ref={listRef}
      id={id}
      role="listbox"
      aria-label="Skills"
      className="cmp-skills"
      data-testid="composer-skills"
      data-side={above ? 'top' : 'bottom'}
      style={
        point
          ? {
              top: above ? undefined : point.bottom + 4,
              bottom: above ? `calc(100% - ${point.top - 4}px)` : undefined,
              left: `max(0px, min(${point.left - 6}px, calc(100% - 360px)))`,
            }
          : undefined
      }
    >
      {menu.matches.map((skill, i) => (
        // biome-ignore lint/a11y/useKeyWithClickEvents: the keyboard picks from the text field (aria-activedescendant)
        <div
          key={skill.name}
          id={`${id}-${i}`}
          role="option"
          tabIndex={-1}
          aria-selected={i === menu.active}
          className="pk-row pk-row-tight cmp-skill"
          data-active={i === menu.active}
          title={skill.description || undefined}
          // Keep focus (and the caret) in the text field.
          onMouseDown={(event) => event.preventDefault()}
          onMouseMove={() => i !== menu.active && menu.setActive(i)}
          onClick={() => menu.pick(skill)}
        >
          <span className="pk-main">
            <span className="pk-name mono">
              {menu.sigil}
              {skill.name}
            </span>
            {skill.description ? <span className="pk-path">{skill.description}</span> : null}
          </span>
          {skill.scope === 'project' ? <span className="pk-tag pk-tag-quiet">repo</span> : null}
        </div>
      ))}
    </div>
  );
}

function DropHint({ intent }: { intent: 'files' | 'either' }) {
  return (
    <div className="cmp-drop" data-testid="composer-drop" data-intent={intent}>
      <span className="cmp-drop-marks">
        <span className="cmp-drop-mark">
          <Icon name="paperclip" size={19} />
        </span>
        {intent === 'either' ? (
          <span className="cmp-drop-mark cmp-drop-mark-alt">
            <Icon name="folder" size={19} />
          </span>
        ) : null}
      </span>
      <span className="cmp-drop-title">{intent === 'files' ? 'Drop to attach' : 'Drop files or a folder'}</span>
      <span className="cmp-drop-sub">
        {intent === 'files'
          ? 'Images up to 10 MB · text, code and PDFs up to 2 MB'
          : 'Files are attached for the agents · a folder becomes the repository'}
      </span>
    </div>
  );
}

function RepoStatus({
  id,
  inspect,
  path,
  home,
  error,
  fix = null,
  session = false,
}: {
  id: string;
  inspect: Inspect;
  path: string | null;
  home: string | null;
  error: string | null;
  /** A direct session works in the checkout: say which branch it is on, and nothing about PRs or worktrees. */
  session?: boolean;
  /** An action that resolves `error` (e.g. the first commit). */
  fix?: ReactNode;
}) {
  if (inspect.status === 'loading')
    return (
      <div id={id} className="cmp-status faint" data-testid="repo-status" data-state="loading">
        <span className="dot live" style={{ width: 6, height: 6, color: 'var(--overlay2)' }} />
        Checking {path ? abbreviatePath(path, home) : 'the repository'}…
      </div>
    );
  if (error)
    return (
      <div id={id} className="cmp-status cmp-status-bad" data-testid="repo-status" data-state="error" role="alert">
        <Icon name="alert" size={12} className="flex-none" />
        <span className="min-w-0">{withCode(error)}</span>
        {fix ? <span className="cmp-fix">{fix}</span> : null}
      </div>
    );
  if (inspect.status !== 'done' || !inspect.result.isGitRepo)
    return <div id={id} className="cmp-status" data-testid="repo-status" data-state="idle" />;
  const r = inspect.result;
  const sep = <span className="cmp-sep">·</span>;
  const gh = !r.hasGh ? (
    <span className="cmp-warn" title="Legion opens the draft PR with the GitHub CLI">
      gh not installed: {withCode('`brew install gh` before the PR step')}
    </span>
  ) : r.ghAuthenticated === false ? (
    <span className="cmp-warn" title="Legion opens the draft PR with the GitHub CLI">
      gh not signed in: {withCode('run `gh auth login` before the PR step')}
    </span>
  ) : (
    <span className="cmp-ok-text">gh {r.ghAuthenticated ? 'authenticated' : 'ready'}</span>
  );
  return (
    <div id={id} className="cmp-status" data-testid="repo-status" data-state="ok">
      <span className="cmp-ok flex-none">
        <Icon name="check" size={12} strokeWidth={2.6} />
      </span>
      <span className="cmp-ok-text">Git repo</span>
      {r.github ? (
        <>
          {sep}
          <span className="mono cmp-mono" title={`github.com/${r.github.owner}/${r.github.name}`}>
            {r.github.owner}/{r.github.name}
          </span>
        </>
      ) : null}
      {session ? (
        <>
          {sep}
          {r.currentBranch ? (
            <span>
              on <span className="mono cmp-mono">{r.currentBranch}</span>
            </span>
          ) : (
            <span className="cmp-warn">detached HEAD</span>
          )}
          {r.dirty ? (
            <>
              {sep}
              <span className="faint" title="The session works in this checkout, alongside your changes">
                has uncommitted changes
              </span>
            </>
          ) : null}
        </>
      ) : null}
      {!session && r.defaultBranch ? (
        <>
          {sep}
          <span>
            default <span className="mono cmp-mono">{r.defaultBranch}</span>
          </span>
        </>
      ) : null}
      {session ? null : (
        <>
          {sep}
          {gh}
        </>
      )}
      {!session && r.dirty ? (
        <>
          {sep}
          <span className="faint" title="Legion works in its own worktrees; your checkout is never touched">
            uncommitted changes left alone
          </span>
        </>
      ) : null}
    </div>
  );
}
