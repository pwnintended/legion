/**
 * Composer (⌘N): describe the work or paste a GitHub / Linear URL, pick a repository (recent, found on this
 * Mac, a typed path, Browse… ⌘O, or a folder dropped from Finder), a base branch and the planner engine, then
 * ⌘⏎ creates the run and focuses its workspace. Screenshots and files attach by paste (⌘V), drop or the Attach
 * button (⌘⇧A). The draft, attachments included, survives closing the overlay.
 */
import type { EngineKind } from '@shared/domain';
import type { EngineInfo } from '@shared/engine';
import type { DiscoveredRepo, RecentRepo, RepoBranches, RepoInspection } from '@shared/rpc';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { seededBase, seededText, takeComposerSeed } from '../app/composer-seed';
import { rpc, useActiveRun, useEngines, useSettings } from '../app/hooks';
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
import { Kbd } from '../chrome/ui';
import { errorMessage } from '../tiles/session/actions';
import { BranchPicker, RepoPicker } from './Picker';
import { abbreviatePath, baseName, mergeRepos, pathFromFileUrl } from './picker-model';
import { OverlayPanel } from './Shell';

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

/** Discovery is cached by the engine; keep the last answer here too so reopening ⌘N is instant. */
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
      return 'Use a full path, starting with / or ~/.';
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

export function ComposerOverlay() {
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
  const [engine, setEngine] = useState<EngineKind>(saved.engine ?? settings?.roles.planner.engine ?? 'claude');
  const [clarify, setClarify] = useState(saved.clarify);
  const [recent, setRecent] = useState<RecentRepo[]>([]);
  const [found, setFound] = useState<DiscoveredRepo[]>(lastFound ?? []);
  const [discovering, setDiscovering] = useState(lastFound === null);
  const [home, setHome] = useState<string | null>(lastHome);
  const [inspect, setInspect] = useState<Inspect>({ status: 'idle' });
  const [branches, setBranches] = useState<{ root: string; value: RepoBranches } | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [creating, setCreating] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
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
  }, [root]);

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

  const activeRepo = activeRun?.repoPath ?? null;
  const repoLists = useMemo(
    () => mergeRepos(recent, found, activeRepo ? [activeRepo] : []),
    [recent, found, activeRepo],
  );

  const selectRepo = (path: string) => {
    setSubmitError(null);
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

  const link = detectIssueLink(text);
  const repoError = !repoPath
    ? 'Choose a repository.'
    : inspect.status === 'error'
      ? inspect.message
      : inspection && !inspection.isGitRepo
        ? repoProblem(inspection)
        : null;
  const textError = text.trim() ? null : 'Describe the work or paste an issue URL.';
  const engineInfo = engines.list.find((e) => e.kind === engine);
  const engineError =
    engines.status === 'ready' && !engineState(engineInfo).ok
      ? `${engine === 'codex' ? 'Codex' : 'Claude Code'} is ${engineState(engineInfo).note}.`
      : null;
  const ready = !textError && !repoError && !engineError && inspect.status !== 'loading' && !uploading;
  const blocked = textError
    ? 'Describe the work first'
    : !repoPath
      ? 'Choose a repository first'
      : inspect.status === 'loading'
        ? 'Checking the repository…'
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
      const run = await rpc('runs.create', {
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
      label="New run"
      placement="center"
      width={expanded ? 'min(1240px, 100%)' : 'min(920px, 100%)'}
      top={expanded ? 40 : 90}
      testId="composer"
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
          <span className="ovl-title">New run</span>
          <Kbd>⌘N</Kbd>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            style={{ marginLeft: 'auto' }}
            aria-label={expanded ? 'Shrink the composer' : 'Expand the composer'}
            aria-pressed={expanded}
            title={expanded ? 'Shrink  ⌘⇧E' : 'Expand  ⌘⇧E'}
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
              placeholder="Describe an issue or feature, paste a GitHub / Linear URL or a screenshot…"
              aria-invalid={attempted && !!textError}
              aria-describedby={`${ids}-text-note`}
              onChange={(event) => setText(event.target.value)}
            />
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
            <div className="cmp-field cmp-planner">
              <span className="cmp-small" id={`${ids}-engine`}>
                Planner
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
          />
          {engineError ? <span className="cmp-error">{engineError}</span> : null}

          <div className="cmp-foot">
            <label className="cmp-check">
              <input type="checkbox" checked={clarify} onChange={(event) => setClarify(event.target.checked)} />
              Let the planner ask clarifying questions first
            </label>
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
                {creating ? 'Creating…' : 'Plan it'}
                <Kbd>⌘⏎</Kbd>
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
              Couldn't create the run: {submitError}
            </span>
          ) : null}
          <p className="cmp-hint">
            The planner reads the repo{clarify ? ', asks up to 5 clarifying questions,' : ''} then drafts the task DAG
            for your sign-off. Nothing runs until you approve it.
          </p>
        </form>
        {drop.dragging ? <DropHint intent={dragIntent(drop.dragging)} /> : null}
      </div>
    </OverlayPanel>
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
}: {
  id: string;
  inspect: Inspect;
  path: string | null;
  home: string | null;
  error: string | null;
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
      {r.defaultBranch ? (
        <>
          {sep}
          <span>
            default <span className="mono cmp-mono">{r.defaultBranch}</span>
          </span>
        </>
      ) : null}
      {sep}
      {gh}
      {r.dirty ? (
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
