/**
 * Settings (⌘,): a sheet with a page per section: engines (binary path, detected version and login, enable),
 * agents (engine, model, effort and prompt per role, AgentsSettings.tsx), access, gates, run limits (concurrency,
 * budget, retries) and appearance. Gates (Gates.tsx) edit the project's legion.json instead
 * and save with their own button. Engine settings go through `settings.get/set` (each
 * valid field saves on commit: blur, ⏎ or a choice); appearance is a renderer preference (prefs.ts).
 */
import type { Settings, SettingsPatch } from '@shared/domain';
import type { EngineInfo } from '@shared/engine';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { commandTooltip } from '../app/commands';
import { rpc, useEngines, useSettings, useUi } from '../app/hooks';
import { type Flavour, type MotionPref, setPref, usePrefs } from '../app/prefs';
import { actions, dataStore, type SettingsSection } from '../app/store';
import { Icon, type IconName } from '../chrome/icons';
import { CommandKbd, Dot } from '../chrome/ui';
import { ENGINE_NAME } from '../layout/describe';
import { errorMessage } from '../tiles/session/actions';
import { AccessSection } from './Access';
import { AgentsSection } from './AgentsSettings';
import { GatesSection } from './Gates';
import { ApprovalsControl, Field, Segmented, Switch } from './SettingsControls';
import { OverlayPanel } from './Shell';
import { engineStatus, parseBinaryPath, parseBudget, parseModel, parseWhole } from './settings-model';

const REAL: readonly ('claude' | 'codex')[] = ['claude', 'codex'];
const SECTIONS: { id: SettingsSection; label: string; icon: IconName }[] = [
  { id: 'engines', label: 'Engines', icon: 'terminal' },
  { id: 'agents', label: 'Agents', icon: 'agents' },
  { id: 'access', label: 'Access', icon: 'link' },
  { id: 'gates', label: 'Gates', icon: 'check' },
  { id: 'runs', label: 'Runs', icon: 'dag' },
  { id: 'appearance', label: 'Appearance', icon: 'eye' },
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

  // A page per section: switching starts the new one at its top.
  const open = (id: SettingsSection) => {
    setSection(id);
    scrollRef.current?.scrollTo({ top: 0 });
  };

  useEffect(() => () => void (savedTimer.current && clearTimeout(savedTimer.current)), []);

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

  const page = (id: SettingsSection, content: ReactNode) => (
    <div className="st-page" data-page={id} data-wide={id === 'agents' || undefined} hidden={section !== id}>
      {content}
    </div>
  );

  return (
    <OverlayPanel label="Settings" placement="sheet" width="min(1180px, 100%)" top={40} testId="settings">
      <div className="ovl-head st-head">
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
              aria-current={section === s.id ? 'page' : undefined}
              data-autofocus={s.id === (requested ?? 'engines') || undefined}
              onClick={() => open(s.id)}
            >
              <Icon name={s.icon} size={14} className="st-nav-icon" />
              {s.label}
            </button>
          ))}
        </nav>
        <div className="st-scroll" ref={scrollRef} data-page={section}>
          {settings ? (
            <>
              {page('engines', <EnginesSection settings={settings} engines={engines.list} commit={commit} />)}
              {page('agents', <AgentsSection settings={settings} engines={engines.list} commit={commit} />)}
              {page('access', <AccessSection settings={settings} commit={commit} />)}
              {page('gates', <GatesSection />)}
              {page('runs', <RunsSection settings={settings} commit={commit} />)}
            </>
          ) : section !== 'appearance' ? (
            <SettingsUnavailable />
          ) : null}
          {page('appearance', <AppearanceSection />)}
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
      <div className="st-engines">
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
      <Field
        label="Fallback review model"
        className="mt-3 max-w-[340px]"
        mono
        value={config.fallbackReviewModel ?? ''}
        placeholder="automatic"
        suggestions={info?.models}
        parse={parseModel}
        onCommit={(fallbackReviewModel) => commit({ engines: { [kind]: { fallbackReviewModel } } })}
        hint={`Used when ${ENGINE_NAME[kind]} has to review its own coders' work.`}
      />
      {probeError ? (
        <div className="st-error mt-1.5" role="alert">
          Detection failed: {probeError}
        </div>
      ) : null}
    </div>
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
      <div className="st-sub mt-0">Coordination</div>
      <p className="st-lede">Both only talk: they never touch files.</p>
      <div className="st-row">
        <div className="min-w-0 flex-1">
          <div className="st-label">Assistant</div>
          <div className="st-note">
            You talk to an assistant that starts the work and keeps you posted. Off: the composer starts the planner
            directly.
          </div>
        </div>
        <Switch
          label="Assistant"
          checked={settings.assistant.enabled}
          onChange={(enabled) => commit({ assistant: { enabled } })}
        />
      </div>
      <div className="st-row">
        <div className="min-w-0 flex-1">
          <div className="st-label">Implementation lead</div>
          <div className="st-note">
            Coordinates the coders once a plan is approved and answers their questions from it. Off: coders work from
            the plan alone.
          </div>
        </div>
        <Switch
          label="Implementation lead"
          checked={settings.lead.enabled}
          onChange={(enabled) => commit({ lead: { enabled } })}
        />
      </div>
      <div className="st-row">
        <div className="min-w-0 flex-1">
          <div className="st-label" id="st-approvals">
            Permission prompts
          </div>
          <div className="st-note">
            What coders would ask you (commands outside a task's verify list). Auto lets the engine decide: Claude's
            auto mode, Codex's approve-for-me. Also switches running Claude coders.
          </div>
        </div>
        <ApprovalsControl labelledBy="st-approvals" />
      </div>

      <div className="st-sub">Concurrency</div>
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
        Estimated spend per run. Crossing it pauses the run and asks you in its conversation whether to raise it.
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
      <p className="st-lede">
        How often Legion tries again on its own before a task escalates and asks you what to do.
      </p>
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
  const vim = usePrefs((p) => p.editorVim);
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
            { value: 'latte', label: 'Latte', swatch: ['#eff1f5', '#7013ea'] },
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
      <div className="st-row">
        <div className="min-w-0 flex-1">
          <div className="st-label" id={`${id}-keys`}>
            Editor keys
          </div>
          <div className="st-note">How the Code view's editor takes keys. Vim starts in normal mode.</div>
        </div>
        <Segmented<'standard' | 'vim'>
          labelledBy={`${id}-keys`}
          value={vim ? 'vim' : 'standard'}
          options={[
            { value: 'standard', label: 'Standard' },
            { value: 'vim', label: 'Vim' },
          ]}
          onChange={(v) => setPref('editorVim', v === 'vim')}
        />
      </div>
    </section>
  );
}

export { ApprovalsControl, Segmented };
