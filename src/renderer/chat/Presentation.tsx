/**
 * What an agent put in front of the human (`present`): who showed it, its title and caption, and the files
 * themselves. Images are shown, not listed; a markdown document reads inline (clipped, the whole of it opens in
 * the preview); anything else is a file chip. Every file opens in the shared preview.
 */
import type { AttachmentRef } from '@shared/attachments';
import type { Presentation as PresentationRow } from '@shared/domain';
import { useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { rpc, useData } from '../app/hooks';
import { type ChipData, ChipList, chipOfRef, imageUrl, isMarkdownChip, openPreview } from '../attachments/Attachments';
import { formatClock } from '../layout/describe';
import { Markdown } from '../tiles/session/Markdown';
import { type AgentLabel, agentLabel } from './labels';

/** `T3 · Enrollment UI (codex)`: the agent behind something in the conversation, its engine as the world's chip. */
export function AgentName({ agent }: { agent: AgentLabel }) {
  return (
    <span className="ch-agent" data-engine={agent.engine}>
      <span className="ch-agent-name">{agent.name}</span>
      <span className={`chip chip-${agent.engine === 'codex' ? 'codex' : 'claude'}`}>
        {[agent.engine, agent.role].filter(Boolean).join(' · ')}
      </span>
    </span>
  );
}

const plain = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '');

/** A document that opens with the presentation's own title doesn't need to say it twice. */
export function withoutRepeatedTitle(markdown: string, title: string): string {
  const match = /^\s*#\s+(.+)\n+/.exec(markdown);
  return match?.[1] && plain(match[1]) === plain(title) ? markdown.slice(match[0].length) : markdown;
}

const MAX_TILES = 6;

export function Presentation({ presentation }: { presentation: PresentationRow }) {
  const agent = useData(useShallow((s) => agentLabel(s, presentation.attemptId)));
  const chips = useMemo(() => presentation.attachments.map((a) => chipOfRef(a)), [presentation.attachments]);
  const images = presentation.attachments.filter((a) => a.kind === 'image');
  const documents = presentation.attachments.filter((a) => a.kind === 'text');
  const files = presentation.attachments.filter((a) => a.kind === 'file');
  const indexOf = (ref: AttachmentRef) => presentation.attachments.indexOf(ref);
  return (
    <article
      className="ch-show"
      aria-label={`${agent.name} shared ${presentation.title}`}
      data-testid="chat-presentation"
    >
      <header className="ch-card-head">
        <AgentName agent={agent} />
        <span className="ch-dim">shared</span>
        <time className="ch-time">{formatClock(presentation.createdAt)}</time>
      </header>
      <h3 className="ch-show-title">{presentation.title}</h3>
      {presentation.caption ? (
        <div className="ch-show-caption">
          <Markdown text={presentation.caption} streaming={false} caret={false} />
        </div>
      ) : null}
      {images.length ? (
        <div className="ch-gallery" data-count={Math.min(images.length, MAX_TILES)}>
          {images.slice(0, MAX_TILES).map((ref, i) => (
            <Shot
              key={ref.id}
              image={ref}
              more={i === MAX_TILES - 1 && images.length > MAX_TILES ? images.length - MAX_TILES : 0}
              onOpen={(element) => openPreview(chips, indexOf(ref), element)}
            />
          ))}
        </div>
      ) : null}
      {documents.map((ref) => (
        <Doc
          key={ref.id}
          doc={ref}
          title={presentation.title}
          onOpen={(element) => openPreview(chips, indexOf(ref), element)}
        />
      ))}
      {files.length ? <ChipList chips={files.map((f) => chipOfRef(f))} size="sm" label="Shared files" /> : null}
    </article>
  );
}

function useImage(ref: AttachmentRef): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void imageUrl(ref).then((u) => live && setUrl(u));
    return () => {
      live = false;
    };
  }, [ref]);
  return url;
}

function Shot({ image, more, onOpen }: { image: AttachmentRef; more: number; onOpen: (element: HTMLElement) => void }) {
  const url = useImage(image);
  return (
    <button
      type="button"
      className="ch-shot"
      onClick={(event) => onOpen(event.currentTarget)}
      aria-label={`Open ${image.name}`}
      title={image.name}
      data-testid="chat-shot"
    >
      {url ? (
        <img src={url} alt={image.name} draggable={false} />
      ) : (
        <span className="ch-shot-empty" aria-hidden="true" />
      )}
      {more > 0 ? <span className="ch-shot-more">+{more}</span> : null}
    </button>
  );
}

type DocState = { status: 'loading' } | { status: 'ready'; text: string } | { status: 'error' };

function Doc({ doc, title, onOpen }: { doc: AttachmentRef; title: string; onOpen: (element: HTMLElement) => void }) {
  const [state, setState] = useState<DocState>({ status: 'loading' });
  useEffect(() => {
    let live = true;
    rpc('attachments.get', { id: doc.id }).then(
      (content) => live && setState({ status: 'ready', text: content.text ?? '' }),
      () => live && setState({ status: 'error' }),
    );
    return () => {
      live = false;
    };
  }, [doc.id]);
  const chip: ChipData = chipOfRef(doc);
  const markdown = isMarkdownChip(chip);
  return (
    <div className="ch-doc" data-testid="chat-document">
      <div className="ch-doc-head">
        <span className="ch-doc-name mono">{doc.name}</span>
        <button type="button" className="ch-more" onClick={(event) => onOpen(event.currentTarget)}>
          Open
        </button>
      </div>
      <div className="ch-doc-body" data-markdown={markdown}>
        {state.status === 'ready' ? (
          markdown ? (
            <Markdown text={withoutRepeatedTitle(state.text, title).slice(0, 6000)} streaming={false} caret={false} />
          ) : (
            <pre className="mono">{state.text.split('\n').slice(0, 24).join('\n')}</pre>
          )
        ) : state.status === 'error' ? (
          <span className="ch-dim">This file is no longer available.</span>
        ) : (
          <span className="ch-dim">Loading…</span>
        )}
      </div>
    </div>
  );
}
