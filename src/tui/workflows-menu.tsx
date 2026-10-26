/**
 * `/workflows`: browse the workflows, open one to see its description, inputs and agent steps (found by a dry
 * run), and set the model and effort its agents run with: for all of an engine's agents, or one step. Changes are
 * drafts until Esc saves them into the config file picked in the "Save to" row.
 */
import { Box, Text, useInput } from 'ink';
import { type MutableRefObject, useEffect, useRef, useState } from 'react';
import type { RealKind } from '../config.ts';
import {
  type Controller,
  type ModelChoice,
  type ModelRow,
  SAVE_SCOPES,
  type SaveScope,
  type WorkflowDetail,
  type WorkflowSummary,
} from './controller.ts';
import { engineColor, glyph, SPINNER, theme } from './theme.ts';

const EFFORTS = [null, 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const ALL: WorkflowDetail = {
  name: '*',
  source: 'config',
  file: '',
  overrides: [],
  description:
    "Defaults for the agents of every workflow. A workflow's own settings, and models its code picks, take precedence.",
  inputs: [],
  agents: [],
  error: null,
};

type Draft = Map<string, string | null>;
type KeyHandler = Parameters<typeof useInput>[0];
const draftKey = (row: ModelRow, field: 'engine' | 'model' | 'effort') => `${row.path.join('\u0000')}|${field}`;

export function WorkflowsMenu({ controller, width }: { controller: Controller; width: number }) {
  const [list, setList] = useState<WorkflowSummary[] | null>(null);
  const [index, setIndex] = useState(0);
  const [open, setOpen] = useState<WorkflowDetail | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; tone: string } | null>(null);
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    let live = true;
    void controller.listWorkflows().then((l) => live && setList(l));
    return () => {
      live = false;
    };
  }, [controller]);

  useEffect(() => {
    if (!loading) return;
    const t = setInterval(() => setFrame((f) => f + 1), 100);
    return () => clearInterval(t);
  }, [loading]);

  const entries: (WorkflowSummary | null)[] = [null, ...(list ?? [])];
  const current = entries[index] ?? null;

  const inspect = (name: string) => {
    setLoading(name);
    setMessage(null);
    controller
      .inspectWorkflow(name)
      .then(setOpen)
      .catch((err: unknown) =>
        setMessage({ text: String(err instanceof Error ? err.message : err), tone: theme.error }),
      )
      .finally(() => setLoading(null));
  };

  // One subscription for both views, dispatching through refs set during render: Ink re-subscribes handlers in
  // an effect, so keys typed right after the view changes would otherwise reach the old view.
  const pageKeys = useRef<KeyHandler | null>(null);
  const listKeys = useRef<KeyHandler | null>(null);
  const viewRef = useRef<'list' | 'page'>('list');
  viewRef.current = open ? 'page' : 'list';
  useInput((input, key) => (viewRef.current === 'page' ? pageKeys : listKeys).current?.(input, key));

  listKeys.current = (input, key) => {
    if (loading) return;
    if (key.escape || (key.ctrl && input === 'c')) return controller.closeMenu();
    if (key.upArrow || input === 'k') return setIndex((i) => (i - 1 + entries.length) % entries.length);
    if (key.downArrow || input === 'j') return setIndex((i) => (i + 1) % entries.length);
    if (key.return || key.rightArrow) {
      if (!current) setOpen(ALL);
      else inspect(current.name);
      return;
    }
    if (!current) return;
    if (input === 'r') {
      setLoading(current.name);
      void controller
        .inspectWorkflow(current.name)
        .then((d) => controller.runFromMenu(d))
        .catch((err: unknown) =>
          setMessage({ text: String(err instanceof Error ? err.message : err), tone: theme.error }),
        )
        .finally(() => setLoading(null));
    }
  };

  if (open) {
    return (
      <WorkflowPage
        keys={pageKeys}
        controller={controller}
        detail={open}
        width={width}
        onBack={(note) => {
          setOpen(null);
          setMessage(note);
          void controller.listWorkflows().then(setList);
        }}
      />
    );
  }

  const nameWidth = Math.max(13, ...(list ?? []).map((w) => w.name.length)) + 2;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.accent}
        paddingX={1}
        width={Math.min(width, 110)}
      >
        <Text color={theme.accent} bold>
          {glyph.brand} Workflows
        </Text>
        <Box flexDirection="column" marginTop={1}>
          {list === null ? <Text dimColor>loading…</Text> : null}
          {entries.map((w, n) => {
            const on = n === index;
            const busy = loading !== null && (w?.name ?? '*') === loading;
            return (
              <Box key={w?.name ?? '*'} marginBottom={n === 0 ? 1 : 0}>
                <Cursor on={on} />
                {w === null ? (
                  <Text wrap="truncate-end">
                    <Text bold={on} color={on ? theme.accent : undefined}>
                      {'All workflows'.padEnd(nameWidth + 9)}
                    </Text>
                    <Text dimColor>models for every workflow's agents</Text>
                  </Text>
                ) : (
                  <Text wrap="truncate-end">
                    <Text bold color={on ? theme.accent : undefined}>
                      {w.name.padEnd(nameWidth)}
                    </Text>
                    <Text dimColor>{w.source.padEnd(9)}</Text>
                    {busy ? (
                      <Text color={theme.accent}>{SPINNER[frame % SPINNER.length]} inspecting…</Text>
                    ) : 'error' in w ? (
                      <Text color={theme.warn}>⚠ {w.error}</Text>
                    ) : (
                      <Text dimColor={!on}>{w.description}</Text>
                    )}
                  </Text>
                )}
              </Box>
            );
          })}
        </Box>
        {message ? (
          <Box marginTop={1}>
            <Text color={message.tone}>{message.text}</Text>
          </Box>
        ) : null}
      </Box>
      <Box paddingX={2}>
        <Keys
          keys={[
            ['↑↓', 'move'],
            ['enter', 'open'],
            ...(current ? ([['r', 'run']] as [string, string][]) : []),
            ['esc', 'close'],
          ]}
        />
      </Box>
    </Box>
  );
}

interface PickerOption {
  value: string | null;
  label: string;
  description?: string;
  /** "other…": type a name. */
  custom?: boolean;
}

const COLUMNS = ['engine', 'model', 'effort'] as const;
type Column = (typeof COLUMNS)[number];
const WIDTH = { engine: 12, model: 26, effort: 12 } as const;
const PICKER_ROWS = 9;

function WorkflowPage(props: {
  keys: MutableRefObject<KeyHandler | null>;
  controller: Controller;
  detail: WorkflowDetail;
  width: number;
  onBack(message: { text: string; tone: string } | null): void;
}) {
  const { controller, detail, width } = props;
  const [scope, setScope] = useState<SaveScope>('project');
  const [index, setIndex] = useState(1);
  const [column, setColumn] = useState<Column>('model');
  const [draft, setDraft] = useState<Draft>(new Map());
  const [picker, setPicker] = useState<{ field: Column; options: PickerOption[]; at: number } | null>(null);
  const [typing, setTyping] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [models, setModels] = useState<Partial<Record<RealKind, { models: ModelChoice[]; error: string | null }>>>({});
  const [message, setMessage] = useState<{ text: string; tone: string } | null>(
    detail.error ? { text: detail.error, tone: theme.warn } : null,
  );

  useEffect(() => {
    let live = true;
    for (const e of ['claude', 'codex'] as const) {
      void controller.modelChoices(e).then((m) => live && setModels((prev) => ({ ...prev, [e]: m })));
    }
    return () => {
      live = false;
    };
  }, [controller]);

  const rows = controller.workflowModels(detail, scope);
  // Row 0 is "save to".
  const row = index === 0 ? null : (rows[index - 1] ?? null);
  const isAll = detail.name === '*';
  const columns = (r: ModelRow | null): Column[] => (r?.kind === 'step' ? [...COLUMNS] : ['model', 'effort']);
  const col = row && !columns(row).includes(column) ? 'model' : column;

  const value = (r: ModelRow, field: Column): string | null => {
    const k = draftKey(r, field);
    return draft.has(k) ? (draft.get(k) ?? null) : (r[field]?.set ?? null);
  };
  /** The engine a row's agents run on, counting an unsaved engine change. */
  const engineOf = (r: ModelRow): RealKind => (value(r, 'engine') as RealKind | null) ?? r.engines[0] ?? 'claude';

  const set = (r: ModelRow, field: Column, v: string | null) => {
    setDraft((prev) => {
      const next = new Map(prev);
      if (v === (r[field]?.set ?? null)) next.delete(draftKey(r, field));
      else next.set(draftKey(r, field), v);
      return next;
    });
  };

  const choose = (r: ModelRow, field: Column, v: string | null) => {
    setMessage(null);
    set(r, field, v);
    if (field !== 'engine') return;
    // A model belongs to one engine: drop one the new engine does not offer.
    const on = (v as RealKind | null) ?? r.engines[0] ?? 'claude';
    const model = value(r, 'model');
    const offered = models[on]?.models ?? [];
    if (model !== null && offered.length > 0 && !offered.some((m) => m.id === model)) {
      set(r, 'model', null);
      setMessage({ text: `Model reset: ${model} is not a ${on} model.`, tone: theme.warn });
    }
  };

  const options = (r: ModelRow, field: Column): PickerOption[] => {
    const on = engineOf(r);
    if (field === 'engine') {
      return [
        { value: null, label: `as coded · ${r.engines.join(', ')}`, description: 'what the workflow says' },
        { value: 'claude', label: 'claude', description: 'Claude Code' },
        { value: 'codex', label: 'codex', description: 'Codex' },
      ];
    }
    const inherited = r[field].inherited[on];
    const inherit: PickerOption = {
      value: null,
      label: `inherit · ${inherited.value ?? (field === 'model' ? "the CLI's default" : 'default')}`,
      description: inherited.value !== null ? `from ${inherited.from}` : undefined,
    };
    if (field === 'effort') return [inherit, ...EFFORTS.filter((e) => e !== null).map((e) => ({ value: e, label: e }))];
    const list = models[on]?.models ?? [];
    const current = value(r, 'model');
    return [
      inherit,
      ...(current !== null && !list.some((m) => m.id === current)
        ? [{ value: current, label: current, description: 'current' }]
        : []),
      ...list.map((m) => ({ value: m.id, label: m.id, description: m.description })),
      { value: null, label: 'other…', description: 'type a model name', custom: true },
    ];
  };

  const changes = () =>
    rows.flatMap((r) =>
      COLUMNS.filter((f) => draft.has(draftKey(r, f))).map((f) => ({
        row: r,
        field: f,
        value: draft.get(draftKey(r, f)) ?? null,
      })),
    );

  const save = async (): Promise<boolean> => {
    const list = changes();
    if (list.length === 0) return true;
    setBusy('saving');
    try {
      await controller.applyWorkflowModels(detail.name, list, scope);
      setDraft(new Map());
      return true;
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : String(err), tone: theme.error });
      return false;
    } finally {
      setBusy(null);
    }
  };

  const act = async (label: string, fn: () => Promise<void>) => {
    if (!(await save())) return;
    setBusy(label);
    try {
      await fn();
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : String(err), tone: theme.error });
    } finally {
      setBusy(null);
    }
  };

  props.keys.current = (input, key) => {
    if (busy) return;
    if (typing !== null && row) {
      if (key.return) {
        choose(row, 'model', typing.trim() || null);
        setTyping(null);
      } else if (key.escape) setTyping(null);
      else if (key.backspace || key.delete) setTyping(typing.slice(0, -1));
      else if ((key.ctrl && input === 'u') || input === '\u0015') setTyping('');
      else if (!key.ctrl && !key.meta && !key.tab) setTyping(typing + printable(input));
      return;
    }
    if (picker && row) {
      const n = picker.options.length;
      if (key.escape || key.leftArrow) return setPicker(null);
      if (key.upArrow || input === 'k') return setPicker({ ...picker, at: (picker.at - 1 + n) % n });
      if (key.downArrow || input === 'j') return setPicker({ ...picker, at: (picker.at + 1) % n });
      if (key.return || input === ' ' || key.rightArrow) {
        const option = picker.options[picker.at];
        setPicker(null);
        if (!option) return;
        if (option.custom) setTyping(value(row, 'model') ?? '');
        else choose(row, picker.field, option.value);
      }
      return;
    }
    if (key.escape) {
      void save().then((ok) => ok && props.onBack(null));
      return;
    }
    if (key.ctrl && input === 'c') return props.onBack(null);
    if (input === 'd' && draft.size > 0) return setDraft(new Map());
    const count = rows.length + 1;
    if (key.upArrow || input === 'k') return setIndex((i) => (i - 1 + count) % count);
    if (key.downArrow || input === 'j') return setIndex((i) => (i + 1) % count);
    const dir = key.leftArrow ? -1 : key.rightArrow ? 1 : 0;
    if (!row) {
      if (dir || key.return || input === ' ') {
        const at = SAVE_SCOPES.indexOf(scope);
        setScope(SAVE_SCOPES[(at + (dir || 1) + SAVE_SCOPES.length) % SAVE_SCOPES.length] ?? 'project');
      }
      return;
    }
    if (dir) {
      const cols = columns(row);
      setColumn(cols[Math.max(0, Math.min(cols.length - 1, cols.indexOf(col) + dir))] ?? 'model');
      return;
    }
    if (key.return || input === ' ') {
      const opts = options(row, col);
      const current = value(row, col);
      setPicker({
        field: col,
        options: opts,
        at: Math.max(
          0,
          opts.findIndex((o) => !o.custom && o.value === current),
        ),
      });
      return;
    }
    if (key.backspace || key.delete) return choose(row, col, null);
    if (isAll) return;
    if (input === 'r')
      return void act('starting', async () => {
        await controller.runFromMenu(detail);
      });
    if (input === 'v')
      return void act('validating', async () => {
        const ok = await controller.validateFromMenu(detail.name);
        setMessage(
          ok
            ? { text: `${glyph.ok} valid: type-check and dry run pass (report above)`, tone: theme.ok }
            : { text: `${glyph.fail} problems found (report above)`, tone: theme.error },
        );
      });
    if (input === 'e' && detail.source !== 'project')
      return void act('ejecting', async () => {
        controller.ejectFromMenu(detail.name);
        props.onBack({ text: `${glyph.ok} ${detail.name} copied into .legion/workflows`, tone: theme.ok });
      });
    if (input === 'o')
      return void act('editing', async () => {
        await controller.editWorkflow(detail.name);
      });
  };

  const labelWidth = Math.max(16, ...rows.map((r) => r.label.length + (r.steps.length > 1 ? 5 : 2)));
  const pending = changes().length;
  const modelError = models.codex?.error ?? null;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.accent}
        paddingX={1}
        width={Math.min(width, 110)}
      >
        <Box justifyContent="space-between">
          <Text>
            <Text color={theme.accent} bold>
              {glyph.brand} {isAll ? 'All workflows' : detail.name}
            </Text>
            {isAll ? null : (
              <Text dimColor>
                {'  '}
                {detail.source} · {detail.file}
                {detail.overrides.length ? ` · overrides the ${detail.overrides.join(', ')} one` : ''}
              </Text>
            )}
          </Text>
          <Text color={pending ? theme.accent : undefined} dimColor={!pending}>
            {pending ? `${pending} unsaved` : ''}
          </Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>{detail.description}</Text>
        </Box>

        {detail.inputs.length > 0 ? (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Input</Text>
            {detail.inputs.map((i) => (
              <Text key={i.name} wrap="truncate-end">
                {'  '}
                <Text color={theme.accent}>{i.name.padEnd(14)}</Text>
                <Text dimColor>{i.type.padEnd(9)}</Text>
                {i.required && i.default === undefined ? (
                  <Text color={theme.warn}>required </Text>
                ) : (
                  <Text dimColor>{i.default !== undefined ? `= ${JSON.stringify(i.default)} ` : 'optional '}</Text>
                )}
                <Text>{i.description ?? ''}</Text>
              </Text>
            ))}
          </Box>
        ) : null}

        <Box marginTop={1}>
          <Box width={labelWidth + 2}>
            <Text bold>Agents</Text>
          </Box>
          {COLUMNS.map((c) => (
            <Box key={c} width={WIDTH[c] + 2}>
              <Text dimColor>{c}</Text>
            </Box>
          ))}
        </Box>
        <Box>
          <Cursor on={index === 0} />
          <Box width={labelWidth}>
            <Text bold={index === 0}>Save to</Text>
          </Box>
          <Text color={index === 0 ? theme.accent : undefined} bold={index === 0}>
            {(index === 0 ? `‹ ${scope} ›` : scope).padEnd(14)}
          </Text>
          <Text dimColor>{controller.scopePath(scope)}</Text>
        </Box>
        {rows.map((r, n) => {
          const on = index === n + 1;
          const engine = engineOf(r);
          return (
            <Box key={r.path.join('.')} flexDirection="column" marginTop={n === 2 ? 1 : 0}>
              {n === 2 ? <Text dimColor>{'  Agent steps (found by a dry run)'}</Text> : null}
              <Box>
                <Cursor on={on} />
                <Box width={labelWidth} flexShrink={0}>
                  <Text bold={on} wrap="truncate-end">
                    {r.label}
                    {r.steps.length > 1 ? <Text dimColor> ×{r.steps.length}</Text> : null}
                  </Text>
                </Box>
                {COLUMNS.map((c) => {
                  const focused = on && col === c && !typing;
                  if (c === 'engine' && r.kind === 'engine')
                    return (
                      <Box key={c} width={WIDTH[c] + 2} flexShrink={0}>
                        <Text color={engineColor(engine)}>{` ${engine}`}</Text>
                      </Box>
                    );
                  if (on && typing !== null && c === 'model')
                    return (
                      <Box key={c} width={WIDTH[c] + 2} flexShrink={0}>
                        <Text>
                          <Text color={theme.accent}>{` ${typing}`}</Text>
                          <Text inverse> </Text>
                        </Text>
                      </Box>
                    );
                  const field = r[c];
                  if (!field) return null;
                  const v = value(r, c);
                  const changed = draft.has(draftKey(r, c));
                  const inherited =
                    c === 'engine' ? { value: r.engines.join(','), from: 'code' } : field.inherited[engine];
                  return (
                    <Box key={c} width={WIDTH[c] + 2} flexShrink={0}>
                      <Cell
                        width={WIDTH[c]}
                        text={v ?? inherited.value ?? 'default'}
                        own={v !== null}
                        changed={changed}
                        focused={focused}
                        color={c === 'engine' ? engineColor(v ?? r.engines[0]) : undefined}
                        warn={field.shadowedBy ? `${field.shadowedBy} wins` : null}
                      />
                    </Box>
                  );
                })}
              </Box>
              {on && picker ? (
                <Picker
                  options={picker.options}
                  at={picker.at}
                  current={value(r, picker.field)}
                  indent={
                    labelWidth +
                    2 +
                    (picker.field === 'engine'
                      ? 0
                      : picker.field === 'model'
                        ? WIDTH.engine + 2
                        : WIDTH.engine + WIDTH.model + 4)
                  }
                  loading={picker.field === 'model' && !models[engine]}
                />
              ) : null}
            </Box>
          );
        })}
        {!isAll && detail.agents.length === 0 ? <Text dimColor>{'  The dry run reached no agent steps.'}</Text> : null}

        <Box marginTop={1}>
          {busy ? (
            <Text color={theme.accent}>{busy}…</Text>
          ) : message ? (
            <Text color={message.tone}>{message.text}</Text>
          ) : (
            <Text dimColor>{hint(row, col, isAll, engineOf, modelError)}</Text>
          )}
        </Box>
      </Box>
      <Box paddingX={2}>
        {typing !== null ? (
          <Keys
            keys={[
              ['enter', 'set'],
              ['esc', 'cancel'],
              ['ctrl+u', 'clear'],
            ]}
          />
        ) : picker ? (
          <Keys
            keys={[
              ['↑↓', 'choose'],
              ['enter', 'pick'],
              ['esc', 'cancel'],
            ]}
          />
        ) : (
          <Keys
            keys={[
              ['↑↓', 'move'],
              ['←→', 'column'],
              ['enter', 'choose'],
              ['⌫', 'reset'],
              ...((isAll
                ? []
                : [
                    ['r', 'run'],
                    ['v', 'validate'],
                    detail.source === 'project' ? ['o', 'edit'] : ['e', 'eject to edit'],
                  ]) as [string, string][]),
              ['esc', pending ? 'save and back' : 'back'],
              ...(pending ? ([['d', 'discard']] as [string, string][]) : []),
            ]}
          />
        )}
      </Box>
    </Box>
  );
}

function hint(
  row: ModelRow | null,
  col: Column,
  isAll: boolean,
  engineOf: (r: ModelRow) => RealKind,
  modelError: string | null,
): string {
  if (!row) return 'project: this repository · local: this machine only · user: every project';
  if (col === 'model' && modelError) return modelError;
  if (row.kind === 'step') {
    const runs = `${row.steps.slice(0, 3).join(', ')}${row.steps.length > 3 ? ', …' : ''}`;
    if (col === 'engine') return `Run every \`${row.label}\` agent on another engine than the code says. Runs: ${runs}`;
    return `Every \`${row.label}\` agent (on ${engineOf(row)}), over what the code picks. Runs: ${runs}`;
  }
  return isAll
    ? `Every ${row.engines[0]} agent of every workflow, unless a workflow or its code says otherwise`
    : `Every ${row.engines[0]} agent of this workflow whose code and step settings pick nothing`;
}

/** A cell: the value set here (accent), or what applies otherwise (dim); focused cells get ‹ ›. */
function Cell(props: {
  width: number;
  text: string;
  own: boolean;
  changed: boolean;
  focused: boolean;
  color?: string;
  warn: string | null;
}) {
  const mark = props.changed ? '●' : props.warn ? '⚠' : ' ';
  const room = props.width - 3;
  const text = props.text.length > room ? `${props.text.slice(0, room - 1)}…` : props.text;
  return (
    <Text wrap="truncate-end">
      <Text color={theme.accent}>{props.focused ? '‹' : ' '}</Text>
      <Text
        color={props.own || props.changed ? (props.color ?? theme.accent) : undefined}
        dimColor={!props.own && !props.changed}
        bold={props.focused}
        inverse={props.focused}
      >
        {text}
      </Text>
      <Text color={theme.accent}>{props.focused ? '›' : ' '}</Text>
      <Text color={props.changed ? theme.accent : theme.warn}>{mark}</Text>
    </Text>
  );
}

function Picker(props: {
  options: PickerOption[];
  at: number;
  current: string | null;
  indent: number;
  loading: boolean;
}) {
  const first = Math.max(0, Math.min(props.at - Math.floor(PICKER_ROWS / 2), props.options.length - PICKER_ROWS));
  const shown = props.options.slice(first, first + PICKER_ROWS);
  const width = Math.max(...props.options.map((o) => o.label.length)) + 2;
  return (
    <Box marginLeft={props.indent} flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
      {first > 0 ? <Text dimColor>{`  ↑ ${first} more`}</Text> : null}
      {shown.map((o, i) => {
        const n = first + i;
        const on = n === props.at;
        const isCurrent = !o.custom && o.value === props.current;
        return (
          <Text key={`${o.label}-${n}`} wrap="truncate-end">
            <Text color={theme.accent}>{on ? '❯ ' : '  '}</Text>
            <Text bold={on} color={on ? theme.accent : undefined}>
              {o.label.padEnd(width)}
            </Text>
            <Text color={theme.ok}>{isCurrent ? '✓ ' : '  '}</Text>
            <Text dimColor>{o.description ?? ''}</Text>
          </Text>
        );
      })}
      {first + PICKER_ROWS < props.options.length ? (
        <Text dimColor>{`  ↓ ${props.options.length - first - PICKER_ROWS} more`}</Text>
      ) : null}
      {props.loading ? <Text dimColor>{'  loading models…'}</Text> : null}
    </Box>
  );
}

function Cursor({ on }: { on: boolean }) {
  return (
    <Box width={2} flexShrink={0}>
      <Text color={theme.accent}>{on ? '❯' : ' '}</Text>
    </Box>
  );
}

function Keys({ keys }: { keys: [string, string][] }) {
  return (
    <Text>
      {keys.map(([k, label], i) => (
        <Text key={k}>
          {i > 0 ? '   ' : ''}
          <Text color={theme.accent} bold>
            {k}
          </Text>
          <Text dimColor> {label}</Text>
        </Text>
      ))}
    </Text>
  );
}

/** Typed or pasted text without control characters. */
function printable(input: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point.
  return input.replace(/[\u0000-\u001f\u007f]/g, '');
}
