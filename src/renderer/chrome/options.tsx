/**
 * Option rows for an agent's question: the clarify tile picks one per question (a radio group), a chat question card
 * sends the one clicked. Options are often whole sentences, so they stack as full-width rows rather than chips.
 * The option text is shown with its `code` spans and a "Recommended" marker lifted into a tag; what is picked or
 * sent is always the option exactly as the agent wrote it.
 */
import { type KeyboardEvent, type ReactNode, useRef } from 'react';
import { Icon } from './icons';

const RECOMMENDED_LEAD = /^\s*recommended\s*[:.–—-]\s*/i;
const RECOMMENDED_TRAIL = /\s*\(recommended\)\s*$/i;

/** Split an option into its display text and whether the agent marked it as recommended. */
export function parseOption(option: string): { text: string; recommended: boolean } {
  const lead = option.replace(RECOMMENDED_LEAD, '');
  const text = lead.replace(RECOMMENDED_TRAIL, '');
  return text !== option && text.trim() ? { text, recommended: true } : { text: option, recommended: false };
}

/** Code spans this long may wrap; shorter ones (identifiers, `{ name, run }`) stay on one line. */
const WRAP_CODE_OVER = 24;

/** Text with `backtick` spans as inline code. An unpaired backtick stays as typed. */
export function codeSpans(text: string): ReactNode[] {
  const parts = text.split('`');
  const nodes: ReactNode[] = [];
  let offset = 0;
  parts.forEach((part, i) => {
    const code = i % 2 === 1 && i < parts.length - 1 && part.length > 0;
    if (code)
      nodes.push(
        <code key={offset} data-wrap={part.length > WRAP_CODE_OVER || undefined}>
          {part}
        </code>,
      );
    else if (i % 2 === 1) nodes.push(i < parts.length - 1 ? `\`${part}\`` : `\`${part}`);
    else nodes.push(part);
    offset += part.length + 1;
  });
  return nodes;
}

function OptionBody({ option }: { option: string }) {
  const { text, recommended } = parseOption(option);
  return (
    <span className="opt-text">
      {recommended ? <span className="opt-tag">recommended</span> : null}
      {codeSpans(text)}
    </span>
  );
}

/**
 * One question's options as a radio group. Clicking the picked option clears it; arrow keys move and pick like
 * native radios; 1–9 pick while focus is in the group. One tab stop per group (the picked option, else the first).
 */
export function OptionRadios({
  options,
  value,
  onChange,
  labelledBy,
}: {
  options: string[];
  value: string | null;
  onChange: (option: string | null) => void;
  labelledBy: string;
}) {
  const group = useRef<HTMLDivElement>(null);
  const tabStop = Math.max(0, value === null ? 0 : options.indexOf(value));
  const pick = (index: number) => {
    const option = options[index];
    if (option === undefined) return;
    onChange(option);
    group.current?.querySelectorAll<HTMLElement>('.opt')[index]?.focus();
  };
  const onKeyDown = (event: KeyboardEvent, index: number) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const last = options.length - 1;
    const move: Record<string, number> = {
      ArrowDown: index === last ? 0 : index + 1,
      ArrowRight: index === last ? 0 : index + 1,
      ArrowUp: index === 0 ? last : index - 1,
      ArrowLeft: index === 0 ? last : index - 1,
      Home: 0,
      End: last,
    };
    const target = move[event.key] ?? (/^[1-9]$/.test(event.key) ? Number(event.key) - 1 : undefined);
    if (target === undefined || target > last) return;
    event.preventDefault();
    pick(target);
  };
  return (
    <div ref={group} className="opt-list" role="radiogroup" aria-labelledby={labelledBy}>
      {options.map((option, i) => {
        const checked = value === option;
        return (
          // biome-ignore lint/a11y/useSemanticElements: styled option rows, not native radios
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={i === tabStop ? 0 : -1}
            className="opt"
            onClick={() => onChange(checked ? null : option)}
            onKeyDown={(event) => onKeyDown(event, i)}
          >
            <span className="opt-mark" aria-hidden="true" />
            <OptionBody option={option} />
          </button>
        );
      })}
    </div>
  );
}

/** Options that answer on click (a chat question card). */
export function OptionButtons({
  options,
  disabled,
  onPick,
}: {
  options: string[];
  disabled?: boolean;
  onPick: (option: string) => void;
}) {
  return (
    <div className="opt-list">
      {options.map((option) => (
        <button key={option} type="button" className="opt" disabled={disabled} onClick={() => onPick(option)}>
          <OptionBody option={option} />
          <Icon name="arrowRight" size={13} className="opt-go" aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}
