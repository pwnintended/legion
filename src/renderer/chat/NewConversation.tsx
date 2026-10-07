/**
 * A project's page in the chat view: start a conversation about it (the assistant answers, researches, and turns
 * it into a run when you want the work done), and pick up an earlier one. Branch and engine options live in the
 * full composer (⌘N); the repository itself is one click away (Repository, ⌘E).
 */
import type { Project, Run } from '@shared/domain';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { openComposer } from '../app/composer-seed';
import { selectRunList, tasksOfRun } from '../app/data';
import { rpc, useData, useNow, useSettings } from '../app/hooks';
import { projectOfRun } from '../app/projects';
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
import type { AttachmentDraft } from '../attachments/model';
import { Icon } from '../chrome/icons';
import { runStatusLine } from '../chrome/run-status';
import { Kbd } from '../chrome/ui';
import { formatDuration } from '../layout/describe';
import { errorMessage } from '../tiles/session/actions';
import './chat.css';

const drafts = new Map<string, { draft: AttachmentDraft; text: string }>();
function promptDraft(projectId: string) {
  let entry = drafts.get(projectId);
  if (!entry) {
    entry = { draft: createDraft(), text: '' };
    drafts.set(projectId, entry);
  }
  return entry;
}

export function NewConversation({ projectId }: { projectId: string }) {
  const project = useData((s) => s.projects[projectId] ?? null);
  if (!project) return null;
  return <Page project={project} />;
}

function Page({ project }: { project: Project }) {
  const entry = promptDraft(project.id);
  const settings = useSettings();
  const branch = useData((s) => s.projectStatus[project.id]?.branch ?? null);
  const runs = useData(useShallow((s) => selectRunList(s).filter((r) => projectOfRun(s, r)?.id === project.id)));
  const [text, setText] = useState(entry.text);
  const [state, setState] = useState<{ status: 'idle' | 'sending' } | { status: 'error'; message: string }>({
    status: 'idle',
  });
  const ref = useRef<HTMLTextAreaElement>(null);
  const { items } = useDraft(entry.draft);
  const uploading = items.some((i) => i.status === 'uploading');
  const drop = useFileDrop((data) => {
    const { folders, files } = splitDrop(data);
    if (folders.length) entry.draft.report("Folders can't be attached. Drop files instead.");
    if (files.length) void entry.draft.addFiles(files);
  });
  const viaAssistant = settings?.assistant.enabled !== false;

  // biome-ignore lint/correctness/useExhaustiveDependencies: grow with the text
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(320, Math.max(96, el.scrollHeight))}px`;
  }, [text]);

  const update = (value: string) => {
    setText(value);
    entry.text = value;
  };
  const ready = text.trim().length > 0 && !uploading && state.status !== 'sending';

  const start = async () => {
    if (!ready) return;
    setState({ status: 'sending' });
    try {
      const prompt = text.trim();
      const attachmentIds = entry.draft.ids;
      const run = viaAssistant
        ? await rpc('runs.chat', {
            repoPath: project.path,
            baseRef: null,
            prompt,
            engine: settings?.roles.assistant.engine ?? 'claude',
            model: null,
            attachmentIds,
          })
        : await rpc('runs.create', {
            repoPath: project.path,
            baseRef: null,
            title: null,
            issueText: prompt,
            issueUrl: null,
            plannerEngine: settings?.roles.planner.engine ?? 'claude',
            plannerModel: null,
            skipClarify: false,
            attachmentIds,
          });
      entry.draft.clear();
      update('');
      setState({ status: 'idle' });
      adoptRun(run);
      actions.setActiveRun(run.id);
      actions.setView('chat');
    } catch (error) {
      setState({ status: 'error', message: errorMessage(error) });
    }
  };

  return (
    <div className="ch ch-new" data-testid="new-conversation">
      <div className="ch-scroll">
        <div className="ch-new-col">
          <h1 className="ch-new-title">{project.name}</h1>
          <p className="ch-new-sub mono">
            {branch ? (
              <>
                <Icon name="branch" size={11} /> {branch}
                <span aria-hidden="true"> · </span>
              </>
            ) : null}
            {project.path}
          </p>
          <form
            className="ch-composer ch-new-composer"
            {...drop.handlers}
            onSubmit={(event) => {
              event.preventDefault();
              void start();
            }}
          >
            <AttachmentTray draft={entry.draft} size="sm" returnFocus={() => ref.current?.focus()} />
            <textarea
              ref={ref}
              className="ch-input"
              value={text}
              placeholder={
                viaAssistant
                  ? 'What should change? Describe it like an issue, or ask about the code first.'
                  : 'What should change? The planner reads the repo and drafts a plan for your sign-off.'
              }
              aria-label={`Start a conversation about ${project.name}`}
              data-testid="new-conversation-input"
              // biome-ignore lint/a11y/noAutofocus: the page exists to write this
              autoFocus
              onChange={(event) => update(event.target.value)}
              onPaste={(event) => void pasteInto(entry.draft, event)}
              onKeyDown={(event) => {
                if (attachShortcut(entry.draft, event)) return;
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  if (!event.repeat) void start();
                }
              }}
            />
            <div className="ch-composer-row">
              <AttachButton draft={entry.draft} testId="new-conversation-attach" />
              <button
                type="button"
                className="ch-link"
                onClick={() => openComposer({ repoPath: project.path, text: text.trim() || null })}
              >
                Branch and engine…
              </button>
              <span className="ch-composer-hint" aria-hidden="true">
                Nothing runs until you approve a plan
              </span>
              <button
                type="submit"
                className="btn btn-primary btn-sm"
                disabled={!ready}
                data-testid="new-conversation-send"
              >
                {state.status === 'sending' ? 'Starting…' : viaAssistant ? 'Start' : 'Plan it'}
                <Kbd>⌘⏎</Kbd>
              </button>
            </div>
            {drop.dragging ? (
              <div className="at-drop">
                <Icon name="paperclip" size={16} />
                Drop to attach
              </div>
            ) : null}
          </form>
          {state.status === 'error' ? (
            <p className="ch-error" role="alert">
              Couldn't start: {state.message}
            </p>
          ) : null}
          {runs.length ? <Recent runs={runs} /> : null}
        </div>
      </div>
    </div>
  );
}

function Recent({ runs }: { runs: Run[] }) {
  const now = useNow(60_000);
  return (
    <section className="ch-recent" aria-label="Conversations">
      <h2 className="ch-recent-title">Conversations</h2>
      <ul>
        {runs.slice(0, 12).map((run) => (
          <RecentRow key={run.id} run={run} now={now} />
        ))}
      </ul>
    </section>
  );
}

function RecentRow({ run, now }: { run: Run; now: number }) {
  const counts = useData(
    useShallow((s) => {
      const tasks = tasksOfRun(s.tasks, run.id);
      const agents = Object.values(s.attempts).filter((a) => a.runId === run.id && a.status === 'running').length;
      const urgent = Object.values(s.inbox).filter((i) => i.runId === run.id && i.resolvedAt === null).length;
      return {
        merged: tasks.filter((t) => t.status === 'merged').length,
        total: tasks.length,
        agents,
        urgent: urgent || (s.summaries[run.id]?.openInbox ?? 0),
      };
    }),
  );
  const status = useMemo(
    () => runStatusLine(run, counts.agents, counts.merged, counts.total, counts.urgent),
    [run, counts],
  );
  return (
    <li>
      <button
        type="button"
        className="ch-recent-row"
        onClick={() => {
          actions.setActiveRun(run.id);
          actions.setView('chat');
        }}
      >
        <span className="ch-recent-name">{run.title}</span>
        <span className="ch-recent-status" data-tone={status.tone}>
          {status.live ? <span className="dot live" aria-hidden="true" /> : null}
          {status.text}
        </span>
        <span className="ch-recent-when">{formatDuration(now - run.updatedAt)} ago</span>
      </button>
    </li>
  );
}
