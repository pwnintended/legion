# layout

A run's layout tree (architecture §11): a pure TS tree (Workspace → Strip → Column → Tile) with ops and full
unit tests. It is the model behind the route map (agents/): the focused tile is the station pane on screen, and
tile ids stay stable for commands and jumps. `types.ts` (TileKind, TileProps, TileDescriptor) is a shared
contract with `tiles/`: extend it only in coordination.

- `tree.ts` — types + ops: `insertColumn`, `insertAfter`, `remove`, `focusDir`, `focusTile`, `setTileParams`, ….
- `sync.ts` — `syncWithRun(layout, input)` derives columns from the run, preserving manual changes.
- `dag.ts` (topo order, depths, critical path), `persist.ts` (per-run localStorage), `describe.ts` (tile
  header metadata from run data).
- `TileFrame.tsx` — `TileBody` hosts a tile kind's body wherever it is drawn (the station pane, the Code view's
  viewer, terminals and side panel): header actions slot, error boundary, loading skeleton, and where the body
  saves its params (`useSetTileParams`).
- `Workspace.tsx` — the loading skeleton.

The Code view does not use this tree: its workspaces (the project's own and one per run, tiled in the board's
tall layout) live in `code/`.

Tile contract: a tile kind's default export receives `TileProps` and renders only its body; its host draws the
frame and head. Add header buttons with `<TileActions>`. Put `data-terminal` on terminal surfaces so keybindings
stay out of their way.
