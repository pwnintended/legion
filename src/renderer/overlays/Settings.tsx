/**
 * Settings (⌘,): engines (binary path, detected version and login, enable), agent defaults per role, run
 * limits (concurrency, budget, retries) and appearance. Engine settings go through `settings.get/set` (each
 * valid field saves on commit: blur, ⏎ or a choice); appearance is a renderer preference (prefs.ts).
 */
import type { Effort, EngineKind, Role, Settings, SettingsPatch } from '@shared/domain';
import type { EngineInfo } from '@shared/engine';
import { useEffect, useId, useRef, useState } from 'react';
import { commandTooltip } from '../app/commands';
import { rpc, useEngines, useSettings, useUi } from '../app/hooks';
import { type Flavour, type MotionPref, setPref, usePrefs } from '../app/prefs';
import { actions, dataStore, type SettingsSection } from '../app/store';
import { Icon } from '../chrome/icons';
import { CommandKbd, Dot } from '../chrome/ui';
import { ENGINE_NAME } from '../layout/describe';
import { errorMessage } from '../tiles/session/actions';
import { Glyph } from '../tiles/session/glyphs';
import { OverlayPanel } from './Shell';
import { engineStatus, type Parsed, parseBinaryPath, parseBudget, parseModel, parseWhole } from './settings-model';

const REAL: readonly ('claude' | 'codex')[] = ['claude', 'codex'];
/** Mirrors EFFORTS in shared/domain.ts (not imported: values from there pull zod into this chunk). */
const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const ROLES: { role: Role; label: string; note: string }[] = [
  { role: 'planner', label: 'Planner', note: 'Clarifies and drafts the plan. Default for new runs.' },
  { role: 'coder', label: 'Coder', note: 'Fallback when a plan node names no engine.' },
  { role: 'reviewer', label: 'Reviewer', note: 'Always the other engine than the coder.' },
  { role: 'resolver', label: 'Resolver', note: 'Resolves merge conflicts.' },
  { role: 'finalizer', label: 'Final review', note: 'Reviews base…integration before the PR.' },
];
const SECTIONS: { id: SettingsSection; label: string }[] = [
  { id: 'engines', label: 'Engines' },
  { id: 'agents', label: 'Agents' },
  { id: 'runs', label: 'Runs' },
  { id: 'appearance', label: 'Appearance' },
];

type SaveState = { kind: 'idle' | 'saving' | 'saved' } | { kind: 'error'; message: string };

export function SettingsOverlay() {
  const settings = useSettings();
  const engines = useEngines();
  const requested = useUi((s) => s.settingsSection);
  const [save, setSave] = useState<SaveState>({ kind: 'idle' });
  const [section, setSection] = useState<SettingsSection>(requested ?? 'engines');
  const scrollRef = useRef<HTMLDivElement>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scrollTo = (id: SettingsSection, smooth = true) => {
    setSection(id);
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-section="${id}"]`);
    if (el && scrollRef.current)
      scrollRef.current.scrollTo({ top: el.offsetTop - 12, behavior: smooth ? 'smooth' : 'auto' });
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: jump once, to the section asked for on open.
  useEffect(() => {
    if (requested) scrollTo(requested, false);
  }, []);
  useEffect(() => () => void (savedTimer.current && clearTimeout(savedTimer.current)), []);

  // Track the section in view (for the nav highlight).
  const onScroll = () => {
    const root = scrollRef.current;
    if (!root) return;
    let current: SettingsSection = 'engines';
    for (const { id } of SECTIONS) {
      const el = root.querySelector<HTMLElement>(`[data-section="${id}"]`);
      if (el && el.offsetTop - 40 <= root.scrollTop) current = id;
    }
    if (root.scrollTop + root.clientHeight >= root.scrollHeight - 4) current = 'appearance';
    setSection(current);
  };

  const commit = async (patch: SettingsPatch): Promise<boolean> => {
    setSave({ kind: 'saving' });
    try {
      const next = await rpc('settings.set', patch);
      dataStore.setState({ settings: next });
      setSave({ kind: 'saved' });
      if (savedTimer.current) clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setSave({ kind: 'idle' }), 1800);
      return true;
    } catch (error) {
      setSave({ kind: 'error', message: errorMessage(error) });
      return false;
    }
  };

  return (
    <OverlayPanel label="Settings" placement="center" width={780} top={64} testId="settings">
      <div className="ovl-head">
        <Icon name="settings" size={15} className="text-overlay2" />
        <span className="ovl-title">Settings</span>
        <CommandKbd id="settings.open" />
        <span className="st-save" data-state={save.kind} aria-live="polite" data-testid="settings-save">
          {save.kind === 'saving' ? (
            'Saving…'
          ) : save.kind === 'saved' ? (
            <>
              <Icon name="check" size={12} strokeWidth={2.6} /> Saved
            </>
          ) : save.kind === 'error' ? (
            `Couldn't save: ${save.message}`
          ) : (
            'Changes save as you go'
          )}
        </span>
        <button
          type="button"
          className="btn btn-ghost btn-icon"
          aria-label="Close settings"
          title={commandTooltip('overlay.close', 'Close')}
          onClick={() => actions.closeOverlay()}
        >
          <Icon name="close" size={14} />
        </button>
      </div>
      <div className="st">
        <nav className="st-nav" aria-label="Settings sections">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              className="st-nav-item"
              aria-current={section === s.id}
              data-autofocus={s.id === (requested ?? 'engines') || undefined}
              onClick={() => scrollTo(s.id)}
            >
              {s.label}
            </button>
          ))}
        </nav>
        <div className="st-scroll" ref={scrollRef} onScroll={onScroll}>
          {settings ? (
            <>
              <EnginesSection settings={settings} engines={engines.list} commit={commit} />
              <AgentsSection settings={settings} engines={engines.list} commit={commit} />
              <RunsSection settings={settings} commit={commit} />
            </>
          ) : (
            <SettingsUnavailable />
          )}
          <AppearanceSection />
        </div>
      </div>
    </OverlayPanel>
  );
}

type Commit = (patch: SettingsPatch) => Promise<boolean>;

function SettingsUnavailable() {
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle');
  const retry = async () => {
    setState('loading');
    try {
      dataStore.setState({ settings: await rpc('settings.get', {}) });
    } catch {
      setState('error');
    }
  };
  return (
    <section className="st-section st-empty">
      <p className="m-0 text-[13px] text-subtext1">Engine settings are unavailable until the engine is connected.</p>
      <button type="button" className="btn btn-sm" onClick={() => void retry()} disabled={state === 'loading'}>
        {state === 'loading' ? 'Loading…' : 'Try again'}
      </button>
      {state === 'error' ? <span className="st-error">Still not reachable.</span> : null}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Engines
// ---------------------------------------------------------------------------------------------

function EnginesSection({ settings, engines, commit }: { settings: Settings; engines: EngineInfo[]; commit: Commit }) {
  return (
    <section className="st-section" data-section="engines" aria-labelledby="st-engines">
      <h2 id="st-engines" className="st-h">
        Engines
      </h2>
      <p className="st-lede">
        Legion drives the CLIs you already use, with your own logins. Leave the path empty to find them on your shell's
        PATH.
      </p>
      <div className="flex flex-col gap-2.5">
        {REAL.map((kind) => (
          <EngineCard
            key={kind}
            kind={kind}
            info={engines.find((e) => e.kind === kind)}
            config={settings.engines[kind]}
            commit={commit}
          />
        ))}
      </div>
    </section>
  );
}

function EngineCard({
  kind,
  info,
  config,
  commit,
}: {
  kind: 'claude' | 'codex';
  info: EngineInfo | undefined;
  config: Settings['engines']['claude'];
  commit: Commit;
}) {
  const id = useId();
  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState<string | null>(null);
  const status = engineStatus(info, config.enabled);
  const color = kind === 'codex' ? 'var(--teal)' : 'var(--mauve)';

  const probe = async () => {
    setProbing(true);
    setProbeError(null);
    try {
      const list = await rpc('engines.probe', { kind });
      dataStore.setState((s) => {
        const next = [...s.engines.list];
        for (const engine of list) {
          const i = next.findIndex((e) => e.kind === engine.kind);
          if (i === -1) next.push(engine);
          else next[i] = engine;
        }
        return { engines: { status: 'ready', list: next } };
      });
    } catch (error) {
      setProbeError(errorMessage(error));
    } finally {
      setProbing(false);
    }
  };

  return (
    <div className="st-card" data-engine={kind} data-testid={`engine-${kind}`}>
      <div className="flex items-center gap-2.5">
        <Dot color={color} />
        <span className="text-[13.5px] font-semibold">{ENGINE_NAME[kind]}</span>
        <span className="mono faint text-[11.5px]">{info?.version ? `v${info.version}` : null}</span>
        <span className={`chip chip-${status.tone === 'idle' ? 'idle' : status.tone}`} data-testid="engine-status">
          {status.label}
        </span>
        <span className="flex-1" />
        <Switch
          label={`Use ${ENGINE_NAME[kind]}`}
          checked={config.enabled}
          onChange={(enabled) => void commit({ engines: { [kind]: { enabled } } })}
        />
      </div>
      {status.detail ? <div className="st-note mt-1.5">{status.detail}</div> : null}
      <div className="mt-3 flex items-end gap-2">
        <Field
          id={`${id}-path`}
          label="Binary"
          className="flex-1"
          mono
          value={config.path ?? ''}
          placeholder={info?.path ?? `auto-detect ${kind} on PATH`}
          parse={parseBinaryPath}
          onCommit={(path) => commit({ engines: { [kind]: { path } } })}
          hint={config.path ? null : info?.path ? `found ${info.path}` : null}
        />
        <button
          type="button"
          className="btn mb-[1px] flex-none"
          onClick={() => void probe()}
          disabled={probing}
          title="Run the CLI again to detect its version and login"
        >
          <Icon name="refresh" size={13} className={probing ? 'st-spin' : undefined} />
          {probing ? 'Detecting…' : 'Detect'}
        </button>
      </div>
      {probeError ? (
        <div className="st-error mt-1.5" role="alert">
          Detection failed: {probeError}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------------------------

function AgentsSection({ settings, engines, commit }: { settings: Settings; engines: EngineInfo[]; commit: Commit }) {
  const id = useId();
  const planner = settings.roles.planner.engine;
  return (
    <section className="st-section" data-section="agents" aria-labelledby="st-agents">
      <h2 id="st-agents" className="st-h">
        Agents
      </h2>
      <div className="st-row">
        <div className="min-w-0 flex-1">
          <div className="st-label" id={`${id}-planner`}>
            Default planner
          </div>
          <div className="st-note">Preselected in the composer; you can still pick per run.</div>
        </div>
        <Segmented<EngineKind>
          labelledBy={`${id}-planner`}
          value={planner}
          options={REAL.map((k) => ({ value: k, label: k === 'claude' ? 'Claude' : 'Codex', engine: k }))}
          onChange={(engine) => void commit({ roles: { planner: { engine } } })}
        />
      </div>
      <div className="st-sub">Defaults per role</div>
      <p className="st-lede">
        Models are per engine because a reviewer's engine depends on its coder. Empty = the CLI's default model.
      </p>
      <div className="st-roles">
        <div className="st-roles-head" aria-hidden="true">
          <span>Role</span>
          <span>Engine</span>
          <span>Claude model</span>
          <span>Codex model</span>
          <span>Effort</span>
        </div>
        {ROLES.map(({ role, label, note }) => {
          const value = settings.roles[role];
          return (
            <div key={role} className="st-roles-row" data-role={role}>
              <span className="min-w-0">
                <span className="block text-[12.5px] font-medium">{label}</span>
                <span className="st-note block truncate" title={note}>
                  {note}
                </span>
              </span>
              <span>
                <Select
                  label={`${label} engine`}
                  value={value.engine}
                  options={[
                    ...REAL.map((k) => ({ value: k, label: k === 'claude' ? 'Claude' : 'Codex' })),
                    ...(value.engine === 'fake' ? [{ value: 'fake', label: 'Fake' }] : []),
                  ]}
                  onChange={(engine) => void commit({ roles: { [role]: { engine: engine as EngineKind } } })}
                />
              </span>
              {REAL.map((kind) => (
                <span key={kind}>
                  <Field
                    label={`${label} ${kind === 'claude' ? 'Claude' : 'Codex'} model`}
                    hideLabel
                    mono
                    value={value.models[kind] ?? ''}
                    placeholder="default"
                    suggestions={engines.find((e) => e.kind === kind)?.models}
                    parse={parseModel}
                    onCommit={(model) => commit({ roles: { [role]: { models: { [kind]: model } } } })}
                  />
                </span>
              ))}
              <span>
                <Select
                  label={`${label} effort`}
                  value={value.effort ?? ''}
                  options={[{ value: '', label: 'default' }, ...EFFORTS.map((e) => ({ value: e, label: e }))]}
                  onChange={(effort) =>
                    void commit({ roles: { [role]: { effort: (effort || null) as Effort | null } } })
                  }
                />
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Runs: concurrency, budget, limits
// ---------------------------------------------------------------------------------------------

function RunsSection({ settings, commit }: { settings: Settings; commit: Commit }) {
  const { concurrency, budget, limits } = settings;
  const capped = REAL.filter((k) => concurrency.perEngine[k] > concurrency.global);
  return (
    <section className="st-section" data-section="runs" aria-labelledby="st-runs">
      <h2 id="st-runs" className="st-h">
        Runs
      </h2>
      <div className="st-sub mt-0">Concurrency</div>
      <p className="st-lede">Agents working at the same time, across all runs. Each holds one worktree and one CLI.</p>
      <div className="st-grid">
        <Field
          label="All engines"
          value={String(concurrency.global)}
          numeric
          suffix="agents"
          parse={(t) => parseWhole(t, 1, 32)}
          onCommit={(global) => commit({ concurrency: { global } })}
        />
        {REAL.map((kind) => (
          <Field
            key={kind}
            label={ENGINE_NAME[kind]}
            value={String(concurrency.perEngine[kind])}
            numeric
            suffix="max"
            parse={(t) => parseWhole(t, 0, 32)}
            onCommit={(n) => commit({ concurrency: { perEngine: { [kind]: n } } })}
            hint={concurrency.perEngine[kind] === 0 ? 'paused: no new sessions' : null}
          />
        ))}
      </div>
      {capped.length ? (
        <div className="st-note mt-2">
          {capped.map((k) => ENGINE_NAME[k]).join(' and ')} can't exceed the overall limit of {concurrency.global}.
        </div>
      ) : null}

      <div className="st-sub">Budget</div>
      <p className="st-lede">
        Estimated spend per run. Crossing it pauses the run and asks you in the inbox whether to raise it.
      </p>
      <div className="st-grid">
        <Field
          label="Per run"
          value={budget.perRunUsd === null ? '' : String(budget.perRunUsd)}
          numeric
          prefix="$"
          placeholder="no limit"
          parse={parseBudget}
          onCommit={(perRunUsd) => commit({ budget: { perRunUsd } })}
        />
        <Field
          label="Warn at"
          value={String(budget.warnAtPct)}
          numeric
          suffix="%"
          parse={(t) => parseWhole(t, 1, 100)}
          onCommit={(warnAtPct) => commit({ budget: { warnAtPct } })}
        />
      </div>

      <div className="st-sub">Before asking you</div>
      <p className="st-lede">How often Legion tries again on its own before a task escalates to your inbox.</p>
      <div className="st-grid">
        <Field
          label="Retries"
          value={String(limits.maxRetries)}
          numeric
          suffix="attempts"
          parse={(t) => parseWhole(t, 0, 10)}
          onCommit={(maxRetries) => commit({ limits: { maxRetries } })}
        />
        <Field
          label="Fix rounds"
          value={String(limits.maxFixRounds)}
          numeric
          suffix="rounds"
          parse={(t) => parseWhole(t, 0, 10)}
          onCommit={(maxFixRounds) => commit({ limits: { maxFixRounds } })}
        />
        <Field
          label="Conflict resolver"
          value={String(limits.maxResolverAttempts)}
          numeric
          suffix="attempts"
          parse={(t) => parseWhole(t, 0, 10)}
          onCommit={(maxResolverAttempts) => commit({ limits: { maxResolverAttempts } })}
        />
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Appearance (renderer preferences)
// ---------------------------------------------------------------------------------------------

function AppearanceSection() {
  const id = useId();
  const flavour = usePrefs((p) => p.flavour);
  const motion = usePrefs((p) => p.motion);
  return (
    <section className="st-section" data-section="appearance" aria-labelledby="st-appearance">
      <h2 id="st-appearance" className="st-h">
        Appearance
      </h2>
      <div className="st-row">
        <div className="min-w-0 flex-1">
          <div className="st-label" id={`${id}-flavour`}>
            Theme
          </div>
          <div className="st-note">Catppuccin. Mocha is dark, Latte is light.</div>
        </div>
        <Segmented<Flavour>
          labelledBy={`${id}-flavour`}
          value={flavour}
          options={[
            { value: 'mocha', label: 'Mocha', swatch: ['#1e1e2e', '#cba6f7'] },
            { value: 'latte', label: 'Latte', swatch: ['#eff1f5', '#8839ef'] },
          ]}
          onChange={(v) => setPref('flavour', v)}
        />
      </div>
      <div className="st-row">
        <div className="min-w-0 flex-1">
          <div className="st-label" id={`${id}-motion`}>
            Motion
          </div>
          <div className="st-note">
            System follows macOS “Reduce motion”. Reduced keeps fades, drops slides, springs and pulses.
          </div>
        </div>
        <Segmented<MotionPref>
          labelledBy={`${id}-motion`}
          value={motion}
          options={[
            { value: 'system', label: 'System' },
            { value: 'reduce', label: 'Reduced' },
            { value: 'full', label: 'Full' },
          ]}
          onChange={(v) => setPref('motion', v)}
        />
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------------------------

/**
 * A text field that validates as you type (shown after the first commit attempt) and saves on blur / ⏎ when
 * valid and changed.
 */
function Field<T>({
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

function Select({
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

function Segmented<T extends string>({
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

function Switch({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
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
