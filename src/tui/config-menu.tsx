/**
 * `/config`: the settings as a menu. ↑↓ picks a setting, ←→ changes it, Enter types a value (or runs an action),
 * Esc saves everything at once and closes, `d` discards. Changes go into one file, chosen in the first row.
 */
import { Box, Text, useInput } from 'ink';
import { useEffect, useState } from 'react';
import type { TomlScalar } from '../config-file.ts';
import { type Controller, SAVE_SCOPES, type SaveScope, type SettingRow } from './controller.ts';
import { glyph, theme } from './theme.ts';

type Value = TomlScalar | null;

const SCOPE_HINT: Record<SaveScope, string> = {
  project: 'this project, for everyone who uses it (commit it if you like)',
  local: 'this project, on this machine only (gitignored)',
  user: 'every project on this machine',
};

export function ConfigMenu({ controller, width }: { controller: Controller; width: number }) {
  const [scope, setScope] = useState<SaveScope>('project');
  const [index, setIndex] = useState(0);
  const [changes, setChanges] = useState<Map<string, Value>>(new Map());
  const [editing, setEditing] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [models, setModels] = useState<Record<string, string[]>>({});

  useEffect(() => {
    let live = true;
    for (const e of ['claude', 'codex'] as const) {
      void controller
        .modelChoices(e)
        .then((m) => live && setModels((prev) => ({ ...prev, [e]: m.models.map((x) => x.id) })));
    }
    return () => {
      live = false;
    };
  }, [controller]);

  const rows = controller.settings(scope);
  // Row 0 is "save to"; the settings follow.
  const count = rows.length + 1;
  const row = index === 0 ? null : (rows[index - 1] ?? null);
  const draftOf = (r: SettingRow): Value => (changes.has(r.id) ? (changes.get(r.id) ?? null) : r.value);

  const change = (r: SettingRow, value: Value) => {
    setError(null);
    setChanges((prev) => {
      const next = new Map(prev);
      if (value === r.value) next.delete(r.id);
      else next.set(r.id, value);
      return next;
    });
  };

  const step = (r: SettingRow, dir: -1 | 1) => {
    const current = draftOf(r);
    const tierModel = /^models\.(claude|codex)\.[a-z]+\.model$/.exec(r.id);
    if (r.id === 'assistant.model' || tierModel) {
      // The models of the row's engine (the assistant's: as it will be after saving); Enter types any other.
      const engineRow = rows.find((x) => x.id === 'assistant.engine');
      const engine = tierModel?.[1] ?? String((engineRow && draftOf(engineRow)) ?? 'claude');
      const list: (string | null)[] = [null, ...(models[engine] ?? [])];
      if (current !== null && !list.includes(current as string)) list.splice(1, 0, current as string);
      const at = Math.max(0, list.indexOf(current as string | null));
      change(r, list[(at + dir + list.length) % list.length] ?? null);
    } else if (r.kind === 'choice' && r.choices) {
      const at = Math.max(0, r.choices.indexOf(current as string | null));
      change(r, r.choices[(at + dir + r.choices.length) % r.choices.length] ?? null);
    } else if (r.kind === 'number') {
      const n = typeof current === 'number' ? current : (r.min ?? 0);
      change(r, Math.min(r.max ?? Number.MAX_SAFE_INTEGER, Math.max(r.min ?? 0, n + dir)));
    }
  };

  const save = async (then?: () => Promise<void>) => {
    setSaving(true);
    try {
      if (changes.size > 0) await controller.applySettings(changes, scope);
      setChanges(new Map());
      controller.closeMenu();
      await then?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const commitEdit = (r: SettingRow, text: string) => {
    setEditing(null);
    const t = text.trim();
    if (r.kind === 'number') {
      const n = Number(t);
      if (!Number.isInteger(n) || n < (r.min ?? 0) || n > (r.max ?? Number.MAX_SAFE_INTEGER)) {
        setError(`${r.label} must be a whole number from ${r.min} to ${r.max}`);
        return;
      }
      change(r, n);
    } else change(r, t || null);
  };

  useInput(
    (input, key) => {
      if (saving) return;
      if (editing !== null && row) {
        if (key.return) commitEdit(row, editing);
        else if (key.escape) setEditing(null);
        else if (key.backspace || key.delete) setEditing(editing.slice(0, -1));
        else if ((key.ctrl && input === 'u') || input === '\u0015') setEditing('');
        else if (!key.ctrl && !key.meta && !key.tab) setEditing(editing + printable(input));
        return;
      }
      if (key.escape) return void save();
      if ((key.ctrl && input === 'c') || input === 'd') {
        setChanges(new Map());
        controller.closeMenu();
        return;
      }
      if (key.upArrow || input === 'k') return setIndex((i) => (i - 1 + count) % count);
      if (key.downArrow || input === 'j' || key.tab) return setIndex((i) => (i + 1) % count);
      const dir = key.leftArrow ? -1 : key.rightArrow ? 1 : 0;
      if (!row) {
        if (dir !== 0 || key.return || input === ' ') {
          const at = SAVE_SCOPES.indexOf(scope);
          setScope(SAVE_SCOPES[(at + (dir || 1) + SAVE_SCOPES.length) % SAVE_SCOPES.length] ?? 'project');
        }
        return;
      }
      if (dir !== 0) return step(row, dir);
      if (key.return || input === ' ') {
        if (row.kind === 'action') return void save(() => controller.editConfigFile(scope));
        if (row.kind === 'choice') return step(row, 1);
        const v = draftOf(row);
        setEditing(v === null ? '' : String(v));
      }
    },
    { isActive: true },
  );

  const labelWidth = Math.max(...rows.filter((r) => r.kind !== 'action').map((r) => r.label.length), 7) + 3;
  const valueWidth = 14;
  let group = '';
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.accent}
        paddingX={1}
        width={Math.min(width, 100)}
      >
        <Box justifyContent="space-between">
          <Text color={theme.accent} bold>
            {glyph.brand} Settings
          </Text>
          <Text dimColor>
            {changes.size > 0 ? (
              <Text color={theme.accent}>
                {changes.size} unsaved change{changes.size > 1 ? 's' : ''}
              </Text>
            ) : (
              'no changes'
            )}
          </Text>
        </Box>
        <Box marginTop={1}>
          <Cursor on={index === 0} />
          <Text bold={index === 0}>{'Save to'.padEnd(labelWidth)}</Text>
          <Choice on={index === 0} text={scope} width={valueWidth} />
          <Text dimColor> {controller.scopePath(scope)}</Text>
        </Box>
        {rows.map((r, n) => {
          const on = index === n + 1;
          const header = r.group !== group ? r.group : null;
          group = r.group;
          const value = draftOf(r);
          const changed = changes.has(r.id);
          return (
            <Box key={r.id} flexDirection="column">
              {header ? (
                <Box marginTop={1}>
                  <Text dimColor bold>
                    {header}
                  </Text>
                </Box>
              ) : null}
              <Box>
                <Cursor on={on} />
                {r.kind === 'action' ? (
                  <Text bold={on} color={on ? theme.accent : undefined}>
                    {r.label}
                    <Text dimColor> ({scope})</Text>
                  </Text>
                ) : (
                  <>
                    <Text bold={on}>{r.label.padEnd(labelWidth)}</Text>
                    {on && editing !== null ? (
                      <Text>
                        <Text color={theme.accent}>{`  ${editing}`}</Text>
                        <Text inverse> </Text>
                      </Text>
                    ) : r.kind === 'text' ? (
                      <Text color={changed ? theme.accent : undefined} dimColor={!changed && value === null}>
                        {`  ${value === null ? 'default' : String(value)}`.padEnd(valueWidth + 4)}
                      </Text>
                    ) : (
                      <Choice
                        on={on}
                        text={value === null ? 'default' : String(value)}
                        changed={changed}
                        width={valueWidth}
                      />
                    )}
                    {changed ? <Text color={theme.accent}> ●</Text> : null}
                    {r.shadowedBy ? (
                      <Text color={theme.warn}> ⚠ {r.shadowedBy} overrides this</Text>
                    ) : r.source && !changed ? (
                      <Text dimColor> {r.source === 'default' ? '' : `from ${r.source}`}</Text>
                    ) : null}
                  </>
                )}
              </Box>
            </Box>
          );
        })}
        <Box marginTop={1}>
          {error ? (
            <Text color={theme.error}>
              {glyph.fail} {error}
            </Text>
          ) : saving ? (
            <Text color={theme.accent}>Saving…</Text>
          ) : (
            <Text dimColor>{row ? describe(row, editing !== null) : `Saves to ${scope}: ${SCOPE_HINT[scope]}`}</Text>
          )}
        </Box>
      </Box>
      <Box paddingX={2}>
        <Text dimColor>
          {editing !== null ? (
            <Keys
              keys={[
                ['enter', 'set'],
                ['esc', 'cancel'],
                ['ctrl+u', 'clear'],
              ]}
            />
          ) : (
            <Keys
              keys={[
                ['↑↓', 'move'],
                ['←→', 'change'],
                [
                  'enter',
                  row?.kind === 'text' || row?.kind === 'number'
                    ? 'type a value'
                    : row?.kind === 'action'
                      ? 'open'
                      : 'next',
                ],
                ['esc', changes.size > 0 ? 'save and close' : 'close'],
                ...(changes.size > 0 ? ([['d', 'discard']] as [string, string][]) : []),
              ]}
            />
          )}
        </Text>
      </Box>
    </Box>
  );
}

function describe(row: SettingRow, editing: boolean): string {
  if (editing) return row.kind === 'number' ? `A whole number from ${row.min} to ${row.max}` : row.hint;
  if (row.kind === 'action') return 'Saves your changes first, then opens the file; it is reloaded when you exit';
  return row.hint;
}

function Cursor({ on }: { on: boolean }) {
  return <Text color={theme.accent}>{on ? '❯ ' : '  '}</Text>;
}

function Choice(props: { on: boolean; text: string; changed?: boolean; width: number }) {
  const shown = props.on ? `‹ ${props.text} ›` : `  ${props.text}  `;
  return (
    <Text color={props.changed || props.on ? theme.accent : undefined} bold={props.on}>
      {shown.padEnd(props.width + 4)}
    </Text>
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
