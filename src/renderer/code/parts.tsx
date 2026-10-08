/** Small pieces the Code view's tiles share. */
import { commandTooltip } from '../app/commands';
import { Icon } from '../chrome/icons';

/** Show a tile alone over its workspace (⌘F) / tile again. */
export function FullscreenButton({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className="btn btn-ghost btn-icon"
      aria-label={on ? 'Tile again' : 'Show this tile alone'}
      aria-pressed={on}
      title={commandTooltip('code.fullscreen', on ? 'Tile again' : 'Alone')}
      onClick={onClick}
    >
      <Icon name={on ? 'minimize' : 'maximize'} size={13} />
    </button>
  );
}
