/** Small presentational primitives shared by chrome, layout and tiles. */
import type { EngineKind } from '@shared/domain';
import type { ReactNode } from 'react';
import { commandTooltip, shortcutFor } from '../app/commands';
import { ENGINE_LABEL, engineTone, type StatusChip, type Tone } from '../layout/describe';

const TONE_COLOR: Record<Tone, string> = {
  claude: 'var(--mauve)',
  codex: 'var(--teal)',
  ok: 'var(--green)',
  run: 'var(--blue)',
  warn: 'var(--peach)',
  bad: 'var(--red)',
  idle: 'var(--surface2)',
  accent: 'var(--lavender)',
};

export function toneColor(tone: Tone): string {
  return TONE_COLOR[tone];
}

export function Chip({
  tone,
  live,
  children,
  title,
}: {
  tone: Tone;
  live?: boolean;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span className={`chip chip-${tone}`} title={title}>
      {live ? <span className="dot live" /> : null}
      {children}
    </span>
  );
}

export function StatusChipView({ status }: { status: StatusChip }) {
  return (
    <Chip tone={status.tone} live={status.live}>
      {status.label}
    </Chip>
  );
}

export function EngineChip({ engine, text }: { engine: EngineKind; text?: string }) {
  return <Chip tone={engineTone(engine)}>{text ?? ENGINE_LABEL[engine]}</Chip>;
}

export function Dot({ color, live }: { color: string; live?: boolean }) {
  return <span className={live ? 'dot live' : 'dot'} style={{ color }} />;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <span className="kbd">{children}</span>;
}

/** The key cap for a registered command, if it has a binding. */
export function CommandKbd({ id }: { id: string }) {
  const shortcut = shortcutFor(id);
  return shortcut ? <Kbd>{shortcut}</Kbd> : null;
}

export function Bar({ pct, color, width = 40 }: { pct: number; color: string; width?: number }) {
  return (
    <span className="bar" style={{ width }}>
      <span style={{ width: `${Math.max(0, Math.min(100, pct))}%`, background: color }} />
    </span>
  );
}

export { commandTooltip };
