import { Box, Text, useInput, useWindowSize } from 'ink';
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { Controller } from './controller.ts';
import { glyph, SPINNER, theme } from './theme.ts';

export function AgentsMenu({ controller, width }: { controller: Controller; width: number }) {
  useSyncExternalStore(controller.store.subscribe, controller.store.get);
  const nodes = controller.agentTree();
  const [selected, setSelected] = useState('orchestrator');
  const [frame, setFrame] = useState(0);
  const { rows } = useWindowSize();
  const index = Math.max(
    0,
    nodes.findIndex((n) => n.key === selected && n.ref !== null),
  );
  const current = nodes[index];
  useEffect(() => {
    const timer = setInterval(() => setFrame((f) => f + 1), 100);
    return () => clearInterval(timer);
  }, []);
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) return controller.closeMenu();
    if (key.return && current?.ref) return controller.openAgent(current.ref);
    if (!key.upArrow && !key.downArrow && input !== 'j' && input !== 'k') return;
    const direction = key.upArrow || input === 'k' ? -1 : 1;
    for (let offset = 1; offset <= nodes.length; offset++) {
      const next = nodes[(index + direction * offset + nodes.length) % nodes.length];
      if (next?.ref) {
        setSelected(next.key);
        break;
      }
    }
  });
  const count = Math.max(3, (rows || 24) - 12);
  const start = Math.max(0, Math.min(index - Math.floor(count / 2), nodes.length - count));
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.accent}
        paddingX={1}
        width={Math.min(width, 110)}
      >
        <Text bold color={theme.accent}>
          {glyph.brand} Agents
        </Text>
        {start > 0 ? <Text dimColor>↑ more</Text> : null}
        {nodes.slice(start, start + count).map((node) => (
          <Text key={node.key} wrap="truncate-end" color={node.key === current?.key ? theme.accent : undefined}>
            {node.key === current?.key ? '› ' : '  '}
            {'  '.repeat(node.depth)}
            {node.status === 'working'
              ? SPINNER[frame % SPINNER.length]
              : node.status === 'done'
                ? '✓'
                : node.status === 'failed'
                  ? '✗'
                  : '○'}{' '}
            {node.label}
            {node.ref ? <Text dimColor> · {node.talkable ? 'talk' : 'read-only'}</Text> : null}
            {node.detail ? <Text dimColor> · {node.detail}</Text> : null}
          </Text>
        ))}
        {start + count < nodes.length ? <Text dimColor>↓ more</Text> : null}
      </Box>
      <Box paddingX={2}>
        <Text dimColor>↑↓ move · enter open · esc close · {current?.label}</Text>
      </Box>
    </Box>
  );
}
