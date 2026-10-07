# layout

Tiling engine (architecture §11): a pure TS tree (Workspace → Strip → Column(split|stacked|tabbed) → Tile)
with ops and full unit tests, plus its React renderer. `types.ts` (TileKind, TileProps, TileDescriptor,
TileCardProps) is a shared contract with `tiles/`: extend it only in coordination.

- `tree.ts` — types + ops: `insertColumn`, `insertAfter`, `remove`, `focusDir`, `moveDir`, `setWidthPreset`,
  `cycleWidth`, `collapse`/`expand`, `toggleStacked`/`toggleTabbed`/`cycleColumnMode`, `maximize`, `focusTile`.
- `sync.ts` — `syncWithRun(layout, input)` derives columns from the run, preserving manual changes.
- `geometry.ts` (px widths, scroll targets, virtualization), `dag.ts` (topo order, depths, critical path),
  `persist.ts` (per-run localStorage), `describe.ts` (tile header/card metadata from run data).
- Views: `Workspace` → `StripView` (+ `Minimap`, `ColumnView`), `FocusView`, `OverviewView`, `PipelineView`.

Tile contract: a tile kind's default export receives `TileProps` and renders only its body; `TileFrame`
draws the border, focus glow, urgency pulse and header (id, title, engine chip, status chip, actions).
Add header buttons with `<TileActions>`; export a named `Card` (`TileCardProps`) to customise the Overview
card body. Put `data-terminal` on terminal surfaces so keybindings stay out of their way.
