# Legion: tiling-WM-inspired UX research (2026-10-06)

Legend: [V] verified this session via fetch/registry; [K] from prior knowledge, not re-verified.

## 1. Tiling WM paradigms -> orchestrator meaning
- i3/sway [K]: manual n-ary container tree (splith/splitv/tabbed/stacked), workspaces, marks, scratchpad, urgency hint, modes (resize). Maps to: explicit user control; tabbed/stacked = many sessions in one tile; urgency = attention inbox; marks = named agent tiles ("jump to mark"). Cost: manual placement is a chore for an auto-generated DAG.
- bspwm [K]: automatic binary partition. Predictable but fragments badly beyond ~6 tiles; bad for 10+ agents.
- dwm/xmonad master-stack [K]: one master + stack. Great "focus mode" layout: master = tile you care about, stack = rest.
- Hyprland [K + V partly]: dwindle/master layouts, gaps, rounded corners, blur, animated borders, special workspaces (scratchpad). Animation DSL: `animation = NAME, ONOFF, SPEED(ds=100ms), CURVE[, STYLE]`, `bezier = NAME,x0,y0,x1,y1`, `popin 80%` style (scale 80->100) [V: wiki.hypr.land/0.53.0/Configuring/Animations/]. Looping border-angle animation burns CPU/battery -> avoid continuous animation in Legion.
- niri / PaperWM / Karousel [V]: scrollable infinite horizontal strip; new window opens to the right of focused, taking full height; focusing scrolls viewport to reveal. Windows never get resized by others opening. niri has overview. (PaperWM: github.com/paperwm/PaperWM; niri: github.com/YaLTeR/niri). Most relevant: an ever-growing list of agents needs a layout that doesn't squash tiles.
- AeroSpace/yabai/Amethyst [K]: macOS tilers; AeroSpace uses own virtual workspaces + i3-like tree, TOML config, modes. Lesson: a good tiler on macOS needs no OS integration if in-app.
- Zellij/tmux [V partly: zellij.dev/documentation/swap-layouts, zellij.dev/news/stacked-panes-swap-layouts/]: layouts as KDL; swap layouts = rule-based layouts keyed on pane count (auto-reflow as panes added); stacked panes (title-line only for collapsed); floating panes; modal keys (locked/pane/tab/resize, Ctrl+g). Swap-layouts-by-count is directly the model for "layout reflows as DAG progresses"; on-screen mode hints bar is the model for beginner discoverability.
- Key concepts to steal: focus model (focus-follows-mouse optional, keyboard directional focus h/j/k/l), modes, urgency, scratchpad, workspaces, status bar, layouts-as-code.

## 2. Aesthetic (unixporn translation)
Ingredients [K]: consistent gaps (8-12px), 10-14px radius, 1-2px borders with active-window accent (gradient/glow), dim inactive, one coherent palette, mono type with ligatures/Nerd glyphs, subtle translucency/blur, short critically-damped motion, bar with tiny dense status.
Palettes: Catppuccin Mocha/Latte (4 flavours, well-specified tokens, ports everywhere incl. xterm themes) -- best fit; Tokyo Night; Rose Pine; Gruvbox; Nord. Recommend Catppuccin Mocha default + Latte light + user-selectable; semantic tokens (surface0..2, accent, attention=peach/yellow, ok=green, err=red, agent colours: Claude = mauve/peach-ish, Codex = teal/green).
Type: Geist Mono (free, OFL) or JetBrains Mono for terminals/timeline code; Berkeley Mono is paid (can't bundle); Iosevka for dense/narrow tiles. UI chrome: Geist Sans / Inter. Bundle Symbols Nerd Font Mono fallback for glyphs.
Motion: niri defaults [V: mintlify.wiki/niri-wm/niri/configuration/animations]: workspace-switch spring damping 1.0 stiffness 1000; horizontal-view-movement / window-movement / window-resize spring damping 1.0 stiffness 800; window-open ease-out-expo 150ms; window-close ease-out-quad 150ms; overview spring 1.0/800; notification spring damping 0.6 stiffness 1000 (the only bouncy one). Takeaway: critically damped springs, ~150ms opens, bounce only for attention. Global `slowdown` multiplier + honour prefers-reduced-motion.
Electron: macOS `vibrancy` (sidebar, under-window, hud, etc.) + `visualEffectState: 'active'`, `transparent`/`backgroundColor: '#00000000'`, `titleBarStyle:'hiddenInset'`, `trafficLightPosition`; Windows 11 `backgroundMaterial: 'mica'|'acrylic'|'tabbed'` [V: electronjs.org BaseWindowConstructorOptions]. macOS 26 Tahoe native glass: `electron-liquid-glass` (NSGlassEffectView, private API, macOS 26+) [V: search result] -- optional, risky (private API, Mac App Store). Use vibrancy only on the window background / rail / status bar; keep tile interiors OPAQUE (terminal legibility, perf; CSS backdrop-filter over many live panes is costly). Web: CSS `backdrop-filter` sparingly; View Transitions API for route/workspace/overview switches (Chromium supports); Motion `layout`/`layoutId` for tile reflow (uses transforms, FLIP-like) [V: motion.dev/docs/react-layout-animations]; avoid animating terminal size every frame -- animate transform, resize xterm (fit) on settle only.
Glow: active border = 1.5px accent + 0 0 0 1px inset + soft box-shadow (accent @ 25%, 16px blur); urgency = pulsing (opacity-only, 1.6s ease, stops after ack) peach border + badge; no always-on rotating gradient.

## 3. Mapping proposal for Legion
PRIMARY PARADIGM: niri-style scrollable strip (columns on infinite horizontal strip), with i3 stacked/tabbed columns for density, and Zellij-style swap-layouts for auto-reflow. Why: (a) agent count is unbounded and arrives from a DAG -- strip never squashes tiles; (b) new tile "opens right of focus / at DAG-position" is predictable (spatial memory); (c) columns can hold a vertical stack (e.g. agent timeline over its diff) = natural for task+review; (d) trivially mouse-friendly (trackpad horizontal scroll, drag) and keyboard-friendly (h/l column, j/k within column); (e) overview = zoomed-out strip, which doubles as DAG-aware minimap.
Concept map:
- Workspace = Run (issue -> plan -> DAG -> PR). Vertical list of workspaces (niri-style) in a left rail with live status chips; Cmd+1..9 / Ctrl+j/k.
- Column = a DAG "lane" or a task; Tile = a view: Plan editor, DAG graph, Agent session (timeline | raw terminal toggle), Diff/Review, Merge/PR. Column may be tabbed/stacked (e.g. coder + reviewer for the same task as stack).
- Auto-layout driven by DAG: spawn task -> column inserted right of its dependency parent, slides in (spring 800, popin 90%), strip scrolls to it only if not user-focused elsewhere (never steal focus; show toast + minimap pip). Finished tasks auto-collapse to a narrow "stacked title" column (Zellij-stacked), expand on focus. Column widths: presets 1/3, 1/2, 2/3, full (niri preset widths), cycle with a key.
- Layout modes (switchable, like swap layouts): Strip (default), Focus (master = focused tile 60% + stack of running agents on right), Grid/Overview (all tiles of the run as thumbnails -- live tiny timelines, urgency badges; niri-overview/Exposé/hyprexpo), Pipeline (columns arranged by DAG depth).
- Urgency: tile border + rail chip + status-bar counter pulse when approval/plan sign-off/review/conflict needed; keyboard `Mod+u` jumps to oldest urgent tile (i3 `[urgent=latest] focus`).
- Scratchpad (floating, toggled overlay, Hyprland special workspace): (1) Quick Composer for new issue (Mod+n), (2) Attention Inbox drawer (Mod+i) listing all urgent items across runs with inline approve/deny, (3) command palette. Dismiss returns focus.
- Status bar (waybar): left = workspace/run chips + mode indicator (NORMAL/RESIZE/MOVE like Zellij/sway); center = current run phase (plan > dag > review > merge > PR) progress; right = agents running N/M, urgent count, tokens/cost, rate-limit, clock. Clickable.
- Marks: `Mod+m a` marks a tile, `Mod+'` a jumps (i3 marks). Optional.
- Layouts-as-code: persist per-run layout JSON; user-defined swap-layout rules (YAML/JSON) keyed on counts/states, shareable.
Keyboard: modal-lite. Mod = Cmd (mac). Normal: Mod+h/j/k/l focus, Mod+Shift+hjkl move tile, Mod+r resize mode (h/l widths, j/k heights, presets; Esc exits), Mod+f maximize/fullscreen tile, Mod+w tab/stack toggle, Mod+Enter zoom/focus mode, Mod+Tab overview, Mod+k palette. Always-visible mode+hint bar (Zellij-style) and tooltip hints on every button so mouse users learn keys. Mouse: drag tile header to reorder/stack (drop overlays), drag edges to resize, wheel/trackpad scroll strip, click minimap. Respect terminal focus: when raw terminal focused, only a Mod-prefixed set is intercepted ("locked" escape hatch like Zellij Ctrl+g).
Beginners: default Strip with visible minimap and "+" ghost tile; guided first-run; every command in palette with its shortcut.

## 4. Implementation libraries (npm registry data 2026-10-06 [V])
- dockview(-react) 8.4.1 (published 2026-10-05): very active; React, floating groups, popout windows, drag-drop with overlays, serialize (toJSON/fromJSON), theming via CSS vars, keyboard a11y, nested instances, tabs. Model is grid of tabbed groups (fixed split-tree + tabs), not an infinite strip. Animations: minimal/none built in. Docs: dockview.dev.
- react-mosaic-component 7.2.1 (2026-09-28): n-ary tree, react-dnd, tab containers as node, CSS-var theme, React 16-19, active again. Pure tiling (no floating). Keyboard not built in.
- flexlayout-react 0.11.1 (2026-09-26): active, JSON model, tabsets, borders, popouts; pre-1.0.
- rc-dock 4.1.0 (2026-09-30): active, floating/maximize, theming; smaller community.
- react-resizable-panels 4.14.2 (2026-10-02): excellent primitive (nested, persisted, keyboard-resizable), no drag-to-dock, no tabs.
- allotment 1.20.5 (2025-12-19): VS Code split view; slow cadence. 
- golden-layout 2.6.0 (2022-09-26): effectively dead; avoid.
- @lumino/widgets 2.9.0 (2026-07-03): DockPanel from JupyterLab, imperative, non-React; heavy.
- react-grid-layout 2.3.0: grid dashboard, not tiling.
- Motion 14.0.0 (2026-10-02; formerly Framer Motion): layout / layoutId / LayoutGroup, spring, transform-based.
- xterm: @xterm/xterm 6.0.0, @xterm/addon-webgl 0.19.0 (2025-12-22); @xterm/addon-canvas 0.7.0 (2024-04, stale/deprecated -> DOM renderer fallback). ghostty-web 0.4.0 exists (WASM libghostty xterm-compatible) -- young.
- Electron 44.5.1 current.
WebGL limit [V via search, matches Chromium behaviour]: Chromium caps ~16 live WebGL contexts per renderer process; xterm WebglAddon = 1 context per terminal; exceeding silently evicts oldest -> blank terminals. Solution: context pool: WebGL only for visible+focused (<=~8) terminals, dispose addon (falls back to DOM renderer) for offscreen/background tiles; or timeline-first UI where raw terminal is opt-in (Legion's design already helps: structured timeline is DOM/React, terminal only on toggle). Also keep xterm instances alive but detached for scrollback, serialize via @xterm/addon-serialize if needed; virtualise offscreen strip columns (render placeholder with last-frame snapshot).
RECOMMENDATION: build a CUSTOM layout engine -- an i3-style n-ary container tree (Workspace -> Strip -> Column(split v | stacked | tabbed) -> Tile) held in a pure-TS reducer/zustand store (immutable JSON, serialisable, DAG-driven actions: insertAfter, focusDir, moveDir, setWidthPreset, collapse), rendered with React + CSS (flex/scroll-snap or transform on strip) + Motion layout animations; pointer-based DnD via dnd-kit for drop overlays; react-resizable-panels only if wanting a ready-made vertical-split resize primitive (or write own: columns need pixel/preset widths anyway). Reasons: no library gives scrollable-strip, DAG-driven insertion, urgency, animations and keyboard-tree nav; all off-the-shelf libs are fixed-grid docking. Fallback if time-constrained: dockview-react for the Diff/Review "editor area" or popouts only. Keep layout-tree pure so it's unit-testable (property tests on tree ops).
Perf: virtualise columns off-viewport (+1 buffer), `content-visibility:auto`, `contain: layout paint` per tile, `will-change: transform` only during animation, pause timeline rendering for hidden tiles, throttle streaming updates (rAF batching).

## 5. Prior art
- Wave Terminal (Electron+Go; blocks in drag-drop tiled layout, widgets, web/preview blocks) [K] -- closest in tech: https://github.com/wavetermdev/waveterm
- Warp (Rust, native; panes, blocks, agent mgmt panel) [K]. Zed (GPUI; pane splits + docks) [K]. VS Code grid editor (SplitView/GridView, which Dockview echoes) [K]. Arc split view [K]. Blender area system (any area can become any editor; joinable/splittable, workspaces) [K] -- great model for "tile = any view type" and tile-type switcher. tldraw/Figma: infinite canvas -- alternative paradigm (spatial canvas for DAG) [K]. Bloomberg terminal: dense panels + command line (function codes) + keyboard-first [K].
- Agent-specific [V search]: Conductor (Mac app, parallel Claude Code in worktrees, diffs/checks/PR) conductor.build; Superset (desktop, 10+ parallel agents, worktrees, any CLI agent) github.com/superset-sh / docs.superset.sh; Warp agentic terminal; Claude Squad (tmux). tmax (Electron multi-terminal, tiling, floating panels, AI agents) aur.archlinux.org/packages/tmax-bin; Tilectron (npm). Observation: existing agent apps are sidebar-list + single main pane (Conductor/Superset) -- NOT tiled strip with DAG-aware reflow; that is Legion's differentiator. Gap: none found with urgency-driven tiling + plan-DAG linkage.

## Sources
- https://dockview.dev/docs/releases/migrating/migrating-to-v7
- https://github.com/nomcopter/react-mosaic
- https://registry.npmjs.org/<pkg> (versions/dates above)
- https://mintlify.wiki/niri-wm/niri/configuration/animations
- https://github.com/YaLTeR/niri ; https://github.com/paperwm/PaperWM
- https://wiki.hypr.land/0.53.0/Configuring/Animations/
- https://zellij.dev/documentation/swap-layouts ; https://zellij.dev/news/stacked-panes-swap-layouts/ ; https://zellij.dev/news/floating-panes-tmux-mode/
- https://www.electronjs.org/docs/latest/api/structures/base-window-options
- https://github.com/meridius-labs/electron-liquid-glass
- https://motion.dev/docs/react-layout-animations ; https://motion.dev/docs/react-layout-group
- https://www.npmjs.com/package/@xterm/addon-webgl
- https://superset.sh/compare/warp-vs-conductor ; https://www.conductor.build/workflows/run-parallel-claude-codes
- https://pkg.go.dev/github.com/1broseidon/termtile ; https://www.npmjs.com/package/tilectron
