/**
 * Composer (⌘N): describe the work or paste a GitHub / Linear URL, pick a repository (recent repos or a folder),
 * a base branch and the planner engine, then ⌘⏎ creates the run and focuses its workspace. The draft survives
 * closing the overlay.
 */
import type { EngineKind } from '@shared/domain';
import type { EngineInfo } from '@shared/engine';
import type { RecentRepo, RepoInspection } from '@shared/rpc';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { rpc, useActiveRun, useEngines, useSettings } from '../app/hooks';
import { adoptRun } from '../app/run-actions';
import { actions } from '../app/store';
import { Icon } from '../chrome/icons';
import { Kbd } from '../chrome/ui';
import { errorMessage } from '../tiles/session/actions';
import { Glyph } from '../tiles/session/glyphs';
import { OverlayPanel } from './Shell';

interface Draft {
  text: string;
  repoPath: string | null;
  base: string;
  engine: EngineKind | null;
  clarify: boolean;
}
let saved: Draft = { text: '', repoPath: null, base: '', engine: null, clarify: true };

const CHOOSE = '__choose__';

export interface IssueLink {
  url: string;
  provider: 'github' | 'linear';
  label: string;
}

/** A GitHub issue/PR or Linear issue URL in the text, if any. */
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

function repoName(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts.slice(-2).join('/');
}

type Inspect =
  | { status: 'idle' | 'loading' }
  | { status: 'done'; result: RepoInspection }
  | { status: 'error'; message: string };

export function ComposerOverlay() {
  const ids = useId();
  const activeRun = useActiveRun();
  const engines = useEngines();
  const settings = useSettings();
  const [text, setText] = useState(saved.text);
  const [repoPath, setRepoPath] = useState<string | null>(saved.repoPath ?? activeRun?.repoPath ?? null);
  const [base, setBase] = useState(saved.base);
  const [engine, setEngine] = useState<EngineKind>(saved.engine ?? settings?.roles.planner.engine ?? 'claude');
  const [clarify, setClarify] = useState(saved.clarify);
  const [recent, setRecent] = useState<RecentRepo[]>([]);
  const [inspect, setInspect] = useState<Inspect>({ status: 'idle' });
  const [attempted, setAttempted] = useState(false);
  const [creating, setCreating] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

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

  const repos = useMemo(() => {
    const list = recent.map((r) => ({ path: r.path, label: repoName(r.path) }));
    for (const path of [activeRun?.repoPath, repoPath]) {
      if (path && !list.some((r) => r.path === path)) list.unshift({ path, label: repoName(path) });
    }
    return list;
  }, [recent, activeRun?.repoPath, repoPath]);

  const link = detectIssueLink(text);
  const inspection = inspect.status === 'done' ? inspect.result : null;
  const repoError = !repoPath
    ? 'Choose a repository.'
    : inspect.status === 'error'
      ? inspect.message
      : inspection && !inspection.isGitRepo
        ? (inspection.error ?? 'Not a git repository.')
        : null;
  const textError = text.trim() ? null : 'Describe the work or paste an issue URL.';
  const engineInfo = engines.list.find((e) => e.kind === engine);
  const engineError =
    engines.status === 'ready' && !engineState(engineInfo).ok
      ? `${engine === 'codex' ? 'Codex' : 'Claude Code'} is ${engineState(engineInfo).note}.`
      : null;
  const ready = !textError && !repoError && !engineError && inspect.status !== 'loading';

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
      });
      saved = { text: '', repoPath, base: '', engine, clarify };
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

  const chooseFolder = async () => {
    const legion = (window as Window & { legion?: { pickDirectory?: (o: object) => Promise<string | null> } }).legion;
    const picked = await legion?.pickDirectory?.({ title: 'Choose a repository', defaultPath: repoPath ?? undefined });
    if (picked) setRepoPath(picked);
  };

  return (
    <OverlayPanel
      label="New run"
      placement="center"
      width={660}
      top={110}
      testId="composer"
      onKeyDown={(event) => {
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          void submit();
        }
      }}
    >
      <div className="ovl-head ovl-head-plain">
        <span className="ovl-title">New run</span>
        <Kbd>⌘N</Kbd>
        <button
          type="button"
          className="btn btn-ghost btn-icon"
          style={{ marginLeft: 'auto' }}
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
            rows={5}
            value={text}
            data-autofocus
            spellCheck
            placeholder="Describe an issue or feature, or paste a GitHub / Linear URL…"
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
        </div>
        <span id={`${ids}-text-note`} className="cmp-error" hidden={!(attempted && textError)}>
          {textError}
        </span>

        <div className="cmp-row">
          <div className="cmp-field cmp-grow">
            <label htmlFor={`${ids}-repo`} className="cmp-small">
              Repository
            </label>
            <div className="select-wrap">
              <select
                id={`${ids}-repo`}
                className="field field-select"
                value={repoPath ?? ''}
                aria-invalid={attempted && !!repoError}
                onChange={(event) => {
                  if (event.target.value === CHOOSE) void chooseFolder();
                  else setRepoPath(event.target.value || null);
                }}
              >
                {repoPath ? null : <option value="">Choose a repository…</option>}
                {repos.map((r) => (
                  <option key={r.path} value={r.path}>
                    {r.label}
                  </option>
                ))}
                <option value={CHOOSE}>Choose folder…</option>
              </select>
              <Glyph name="chevronDown" size={12} className="select-chevron" />
            </div>
          </div>
          <div className="cmp-field">
            <label htmlFor={`${ids}-base`} className="cmp-small">
              Base
            </label>
            <input
              id={`${ids}-base`}
              className="field field-base mono"
              value={base}
              list={`${ids}-branches`}
              spellCheck={false}
              autoComplete="off"
              placeholder={inspection?.defaultBranch ?? 'main'}
              onChange={(event) => setBase(event.target.value)}
            />
            <datalist id={`${ids}-branches`}>
              {[inspection?.defaultBranch, inspection?.currentBranch]
                .filter((b, i, all): b is string => !!b && all.indexOf(b) === i)
                .map((b) => (
                  <option key={b} value={b} />
                ))}
            </datalist>
          </div>
          <div className="cmp-field">
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

        <RepoStatus inspect={inspect} error={attempted ? repoError : inspect.status === 'error' ? repoError : null} />
        {engineError ? <span className="cmp-error">{engineError}</span> : null}

        <div className="cmp-foot">
          <label className="cmp-check">
            <input type="checkbox" checked={clarify} onChange={(event) => setClarify(event.target.checked)} />
            Let the planner ask clarifying questions first
          </label>
          <button
            type="submit"
            className="btn btn-primary cmp-submit"
            disabled={creating}
            aria-disabled={!ready}
            data-ready={ready}
          >
            {creating ? 'Creating…' : 'Plan it'}
            <Kbd>⌘⏎</Kbd>
          </button>
        </div>
        {submitError ? (
          <span className="cmp-error" role="alert">
            Couldn't create the run: {submitError}
          </span>
        ) : null}
        <p className="cmp-hint">
          The planner reads the repo{clarify ? ', asks up to 5 clarifying questions,' : ''} then drafts the task DAG for
          your sign-off. Nothing runs until you approve it.
        </p>
      </form>
    </OverlayPanel>
  );
}

function RepoStatus({ inspect, error }: { inspect: Inspect; error: string | null }) {
  if (error)
    return (
      <span className="cmp-status cmp-status-bad" data-testid="repo-status">
        <Icon name="alert" size={12} />
        {error}
      </span>
    );
  if (inspect.status === 'loading')
    return (
      <span className="cmp-status faint" data-testid="repo-status">
        <span className="dot live" style={{ width: 6, height: 6 }} />
        Inspecting repository…
      </span>
    );
  if (inspect.status !== 'done' || !inspect.result.isGitRepo) return <span className="cmp-status" />;
  const r = inspect.result;
  const parts = [
    r.github ? `${r.github.owner}/${r.github.name}` : (r.root ?? r.path),
    r.defaultBranch ? `default ${r.defaultBranch}` : null,
    r.currentBranch && r.currentBranch !== r.defaultBranch ? `on ${r.currentBranch}` : null,
  ].filter(Boolean);
  return (
    <span className="cmp-status" data-testid="repo-status">
      <span className="tl-ok flex-none">
        <Icon name="check" size={12} strokeWidth={2.4} />
      </span>
      <span className="muted min-w-0 truncate" title={parts.join(' · ')}>
        {parts.join(' · ')}
      </span>
      {r.hasGh ? (
        <span className="faint flex-none">gh ready</span>
      ) : (
        <span className="cmp-warn flex-none">gh not found: the PR step will need it</span>
      )}
      {r.dirty ? (
        <span className="faint flex-none" title="uncommitted changes stay untouched (Legion works in worktrees)">
          uncommitted changes stay untouched
        </span>
      ) : null}
    </span>
  );
}
