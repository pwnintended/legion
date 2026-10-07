/**
 * Controls shared by the settings screens: a validating text field, a select, a segmented control, a switch.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { rpc, useSettings } from '../app/hooks';
import { Glyph } from '../tiles/session/glyphs';
import type { Parsed } from './settings-model';

// ---------------------------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------------------------

/**
 * A text field that validates as you type (shown after the first commit attempt) and saves on blur / ⏎ when
 * valid and changed.
 */
export function Field<T>({
  id: givenId,
  label,
  hideLabel,
  value,
  placeholder,
  parse,
  onCommit,
  hint,
  numeric,
  mono,
  prefix,
  suffix,
  suggestions,
  className,
}: {
  id?: string;
  label: string;
  hideLabel?: boolean;
  value: string;
  placeholder?: string;
  parse: (text: string) => Parsed<T>;
  onCommit: (value: T) => Promise<boolean>;
  hint?: string | null;
  numeric?: boolean;
  mono?: boolean;
  prefix?: string;
  suffix?: string;
  suggestions?: readonly string[];
  className?: string;
}) {
  const autoId = useId();
  const id = givenId ?? autoId;
  const [draft, setDraft] = useState(value);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  // Follow external updates (another window, the engine normalizing a value) unless the user is editing.
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setDraft(value);
  }, [value]);

  const parsed = parse(draft);
  const invalid = touched && !parsed.ok;
  const commit = async () => {
    editing.current = false;
    setTouched(true);
    if (!parsed.ok || draft.trim() === value.trim()) return;
    setBusy(true);
    const ok = await onCommit(parsed.value);
    setBusy(false);
    if (!ok) editing.current = true;
  };
  const listId = suggestions?.length ? `${id}-list` : undefined;
  return (
    <div className={`st-field ${className ?? ''}`}>
      <label htmlFor={id} className={hideLabel ? 'sr-only' : 'st-field-label'}>
        {label}
      </label>
      <div className="st-input" data-invalid={invalid} data-busy={busy}>
        {prefix ? <span className="st-affix">{prefix}</span> : null}
        <input
          id={id}
          className={mono ? 'mono' : undefined}
          value={draft}
          placeholder={placeholder}
          inputMode={numeric ? 'decimal' : undefined}
          spellCheck={false}
          autoComplete="off"
          list={listId}
          aria-invalid={invalid}
          aria-describedby={invalid || hint ? `${id}-msg` : undefined}
          onChange={(e) => {
            editing.current = true;
            setDraft(e.target.value);
          }}
          onBlur={() => void commit()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void commit();
            }
          }}
        />
        {suffix ? <span className="st-affix">{suffix}</span> : null}
      </div>
      {listId ? (
        <datalist id={listId}>
          {suggestions?.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      ) : null}
      {invalid && !parsed.ok ? (
        <span id={`${id}-msg`} className="st-error">
          {parsed.message}
        </span>
      ) : hint ? (
        <span id={`${id}-msg`} className="st-note truncate" title={hint}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}

export function Select({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <div className="select-wrap">
      <select
        aria-label={label}
        className="field field-select st-select"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <Glyph name="chevronDown" size={12} className="select-chevron" />
    </div>
  );
}

/** `settings.permissions.approvals` as a two-way control (Settings, agents tile). */
export function ApprovalsControl({ labelledBy }: { labelledBy: string }) {
  const settings = useSettings();
  if (!settings) return null;
  return (
    <Segmented<'auto' | 'ask'>
      labelledBy={labelledBy}
      // An engine started before this setting existed sends none (the renderer hot-reloads ahead of it).
      value={settings.permissions?.approvals ?? 'auto'}
      options={[
        { value: 'auto', label: 'Auto' },
        { value: 'ask', label: 'Ask me' },
      ]}
      onChange={(approvals) => void rpc('settings.set', { permissions: { approvals } }).catch(() => undefined)}
    />
  );
}

export function Segmented<T extends string>({
  labelledBy,
  value,
  options,
  onChange,
}: {
  labelledBy: string;
  value: T;
  options: { value: T; label: string; engine?: 'claude' | 'codex'; swatch?: [string, string] }[];
  onChange: (value: T) => void;
}) {
  const move = (dir: 1 | -1) => {
    const i = options.findIndex((o) => o.value === value);
    const next = options[(i + dir + options.length) % options.length];
    if (next) onChange(next.value);
  };
  return (
    <div className="segs cmp-segs st-segs flex-none" role="radiogroup" aria-labelledby={labelledBy}>
      {options.map((o) => (
        // biome-ignore lint/a11y/useSemanticElements: a segmented control, not native radios
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          tabIndex={value === o.value ? 0 : -1}
          className="seg cmp-seg"
          data-engine={o.engine}
          onClick={() => onChange(o.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
              e.preventDefault();
              move(e.key === 'ArrowRight' ? 1 : -1);
            }
          }}
        >
          {value === o.value ? <span className="seg-pill" /> : null}
          {o.swatch ? (
            <span className="st-swatch" style={{ background: o.swatch[0], color: o.swatch[1] }} aria-hidden="true" />
          ) : null}
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Switch({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      className="st-switch"
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  );
}
