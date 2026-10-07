/**
 * Project overview tile: who/what/where at a glance (branch, remote, gh, size, languages, last commit), the
 * next steps as quiet buttons (New run ⌘N with this project, Go to file ⌘P, Search ⌘⇧F, Terminal, Finder) and
 * the README rendered underneath.
 */
import type { LanguageStat, ProjectInfo } from '@shared/rpc';
import { commandTooltip, executeCommand } from '../../app/commands';
import { useNow } from '../../app/hooks';
import { newRunInProject } from '../../app/project-actions';
import { Icon } from '../../chrome/icons';
import { CommandKbd } from '../../chrome/ui';
import type { TileProps } from '../../layout/types';
import { abbreviatePath } from '../../overlays/picker-model';
import { Glyph } from '../session/glyphs';
import {
  formatBytes,
  formatCount,
  languageColor,
  openUrl,
  relativeTime,
  revealInFinder,
  SkeletonRows,
  useFile,
  useHomeDir,
  useProject,
  useProjectInfo,
} from './kit';
import { RepoMarkdown } from './RepoMarkdown';

function LanguageBar({ languages }: { languages: LanguageStat[] }) {
  const byBytes = languages.some((l) => l.bytes > 0);
  const weight = (l: LanguageStat) => (byBytes ? l.bytes : l.files);
  const total = languages.reduce((sum, l) => sum + weight(l), 0);
  if (total === 0) return null;
  const shown = languages.filter((l) => weight(l) / total >= 0.005).slice(0, 8);
  const legend = shown.slice(0, 4);
  const rest = 1 - legend.reduce((sum, l) => sum + weight(l) / total, 0);
  return (
    <div className="ph-langs" data-testid="project-languages">
      <div className="ph-langbar" role="img" aria-label="Languages">
        {shown.map((l, i) => (
          <span
            key={l.name}
            title={`${l.name} ${((weight(l) / total) * 100).toFixed(1)}%`}
            style={{ flexGrow: weight(l), background: languageColor(l.name, i) }}
          />
        ))}
      </div>
      <div className="ph-legend">
        {legend.map((l, i) => (
          <span key={l.name}>
            <span className="dot" style={{ color: languageColor(l.name, i), width: 6, height: 6 }} />
            {l.name}
            <span className="faint">{Math.max(1, Math.round((weight(l) / total) * 100))}%</span>
          </span>
        ))}
        {rest > 0.01 && languages.length > legend.length ? (
          <span className="faint">other {Math.round(rest * 100)}%</span>
        ) : null}
      </div>
    </div>
  );
}

function Facts({ info, now }: { info: ProjectInfo; now: number }) {
  const sep = <span className="ph-sep" aria-hidden="true" />;
  const last = info.lastCommit;
  return (
    <>
      <div className="ph-facts">
        {info.currentBranch ? (
          <span className="ph-fact mono" title={`On ${info.currentBranch}`}>
            <Glyph name="branch" size={12} />
            {info.currentBranch}
          </span>
        ) : (
          <span className="ph-fact faint">detached HEAD</span>
        )}
        {info.dirty ? (
          <span className="ph-fact ph-dirty" title="Tracked files have uncommitted changes (Legion leaves them alone)">
            <span className="dot" style={{ width: 6, height: 6 }} />
            uncommitted changes
          </span>
        ) : null}
        {info.defaultBranch && info.defaultBranch !== info.currentBranch ? (
          <span className="ph-fact faint">
            default <span className="mono">{info.defaultBranch}</span>
          </span>
        ) : null}
        {info.github ? (
          <button
            type="button"
            className="ph-fact ph-link"
            onClick={() => openUrl(`https://github.com/${info.github?.owner}/${info.github?.name}`)}
            title="Open on GitHub"
          >
            <Icon name="pr" size={12} />
            <span className="mono">
              {info.github.owner}/{info.github.name}
            </span>
            <Icon name="external" size={11} className="faint" />
          </button>
        ) : info.remotes[0] ? (
          <span className="ph-fact mono faint" title={info.remotes[0].url}>
            {info.remotes[0].name}
          </span>
        ) : (
          <span className="ph-fact faint">no remote</span>
        )}
        {info.github ? (
          !info.hasGh ? (
            <span
              className="ph-fact ph-warn"
              title="Legion lists pull requests and opens draft PRs with the GitHub CLI"
            >
              gh not installed
            </span>
          ) : info.ghAuthenticated === false ? (
            <span className="ph-fact ph-warn" title="Run `gh auth login` to see pull requests here">
              gh signed out
            </span>
          ) : (
            <span className="ph-fact ph-ok">
              <Icon name="check" size={11} strokeWidth={2.6} />
              gh
            </span>
          )
        ) : null}
      </div>
      <div className="ph-stats">
        <span>
          <strong>{formatCount(info.fileCount)}</strong> files
        </span>
        {sep}
        <span>{formatBytes(info.totalBytes)}</span>
        {info.commitCount !== null ? (
          <>
            {sep}
            <span>
              <strong>{formatCount(info.commitCount)}</strong> commits
            </span>
          </>
        ) : null}
        {last ? (
          <>
            {sep}
            <span className="truncate" title={`${last.subject} · ${last.shortSha}`}>
              last commit {relativeTime(last.date, now)} by {last.author}
            </span>
          </>
        ) : null}
      </div>
    </>
  );
}

function Readme({ projectId, path }: { projectId: string; path: string }) {
  const file = useFile(projectId, path);
  return (
    <section className="ph-readme" aria-label={path} data-testid="project-readme">
      <div className="ph-readme-head">
        <Icon name="book" size={13} />
        <span className="mono">{path}</span>
      </div>
      {file.data?.kind === 'text' && file.data.text !== null ? (
        <RepoMarkdown projectId={projectId} path={path} text={file.data.text} />
      ) : file.error ? (
        <p className="ph-empty-note">Couldn't read the README: {file.error}</p>
      ) : (
        <SkeletonRows rows={8} />
      )}
    </section>
  );
}

export default function ProjectTile({ params }: TileProps<'project'>) {
  const { projectId } = params;
  const project = useProject(projectId);
  const info = useProjectInfo(projectId);
  const now = useNow(60_000);
  const home = useHomeDir();
  const data = info.data;
  if (!project) return <div className="ph-empty">This project was removed from Legion.</div>;
  return (
    <div className="ph-scroll" data-testid="project-overview">
      <header className="ph-hero">
        <div className="ph-title-row">
          <h1 className="ph-name">{project.name}</h1>
          {project.pinned ? <Icon name="pin" size={13} className="faint" /> : null}
        </div>
        <button
          type="button"
          className="ph-path mono"
          onClick={() => revealInFinder(project.path)}
          title="Reveal in Finder"
        >
          {abbreviatePath(project.path, home)}
        </button>
        {data ? (
          data.exists ? (
            <Facts info={data} now={now} />
          ) : (
            <p className="ph-warn-note">
              <Icon name="alert" size={13} />
              The folder is gone or no longer a git repository.
            </p>
          )
        ) : info.error ? (
          <p className="ph-warn-note">{info.error}</p>
        ) : (
          <SkeletonRows rows={2} />
        )}
        {data?.exists ? <LanguageBar languages={data.languages} /> : null}
        <div className="ph-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => newRunInProject(projectId)}
            title={commandTooltip('composer.open', 'New run in this project')}
            data-testid="project-new-run"
          >
            <Icon name="plus" strokeWidth={2.4} />
            New run
            <CommandKbd id="composer.open" />
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => void executeCommand('file.goto')}
            title={commandTooltip('file.goto')}
          >
            <Icon name="file" size={13} />
            Go to file
            <CommandKbd id="file.goto" />
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => void executeCommand('project.search')}
            title={commandTooltip('project.search')}
          >
            <Icon name="search" size={13} />
            Search
            <CommandKbd id="project.search" />
          </button>
          <span className="ph-actions-gap" />
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            aria-label="Open a terminal in the project"
            title="Open a terminal here"
            onClick={() => void executeCommand('tile.newTerminal')}
          >
            <Icon name="terminal" size={14} />
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            aria-label="Reveal in Finder"
            title="Reveal in Finder"
            onClick={() => revealInFinder(project.path)}
          >
            <Icon name="folderOpen" size={14} />
          </button>
        </div>
      </header>
      {data?.readme ? (
        <Readme projectId={projectId} path={data.readme} />
      ) : data ? (
        <section className="ph-readme ph-readme-none">
          <Icon name="book" size={16} />
          <p>No README at the root. Browse the files on the right, or start a run to write one.</p>
        </section>
      ) : null}
    </div>
  );
}
