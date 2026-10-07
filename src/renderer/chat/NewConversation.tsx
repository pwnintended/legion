/**
 * The new-conversation tile of a project's board: start a conversation about the project (the assistant answers,
 * researches, and turns it into a run when you want the work done). Alone on the board it is the project's
 * page; with conversations beside it, it splits in as the master (⌘N) and the conversation it starts takes its
 * place. Branch and engine options live in the full composer; the repository is one click away (⌘E).
 */
import type { Project } from '@shared/domain';
import { type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { openComposer } from '../app/composer-seed';
import { rpc, useData, useSettings } from '../app/hooks';
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
import { boardActions } from '../board/state';
import { Icon } from '../chrome/icons';
import { Kbd } from '../chrome/ui';
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

export function NewConversation({
  project,
  alone,
  focused,
  children,
}: {
  project: Project;
  alone: boolean;
  focused: boolean;
  /** Below the composer (the board's note about hidden conversations that wait). */
  children?: ReactNode;
}) {
  const entry = promptDraft(project.id);
  const settings = useSettings();
  const branch = useData((s) => s.projectStatus[project.id]?.branch ?? null);
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
      boardActions.started(project.id, run.id);
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
              // biome-ignore lint/a11y/noAutofocus: the tile exists to write this (only when it has the focus)
              autoFocus={focused}
              onChange={(event) => update(event.target.value)}
              onPaste={(event) => void pasteInto(entry.draft, event)}
              onKeyDown={(event) => {
                if (attachShortcut(entry.draft, event)) return;
                // Nothing written yet: Esc takes the tile off the board again (it is the page when alone).
                if (event.key === 'Escape' && !alone && !text.trim() && items.length === 0) {
                  event.preventDefault();
                  boardActions.closeNew();
                  return;
                }
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
          {children}
        </div>
      </div>
    </div>
  );
}
