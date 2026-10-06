# layout

Tiling engine (architecture §11): a pure TS tree (Workspace → Strip → Column(split|stacked|tabbed) → Tile)
with ops and full unit tests, plus its React renderer. `types.ts` (TileKind, TileProps, TileDescriptor) is a
shared contract with `tiles/`: extend it only in coordination.
