---
name: Legion
description: A local orchestrator for Claude Code and Codex; the run is a conversation and the agents work offstage.
colors:
  mauve: "#cba6f7"
  mauve-hover: "#d7b9f9"
  teal: "#94e2d5"
  peach: "#fab387"
  peach-hover: "#fbc19d"
  lavender: "#b4befe"
  green: "#a6e3a1"
  green-hover: "#b8eab4"
  blue: "#89b4fa"
  red: "#f38ba8"
  yellow: "#f9e2af"
  text: "#cdd6f4"
  subtext1: "#bac2de"
  subtext0: "#a6adc8"
  overlay2: "#9399b2"
  overlay1: "#82879f"
  overlay0: "#6c7086"
  surface2: "#585b70"
  surface1: "#45475a"
  surface0: "#313244"
  base: "#1e1e2e"
  mantle: "#181825"
  crust: "#11111b"
  hairline: "#2a2b3c"
  chrome-line: "#232336"
typography:
  display:
    fontFamily: "Geist Variable, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "28px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "Geist Variable, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "21px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.012em"
  title:
    fontFamily: "Geist Variable, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "15.5px"
    fontWeight: 600
    lineHeight: 1.35
  body-reading:
    fontFamily: "Geist Variable, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "14.5px"
    fontWeight: 400
    lineHeight: 1.62
  body:
    fontFamily: "Geist Variable, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "Geist Variable, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "12.5px"
    fontWeight: 500
    lineHeight: 1
  meta:
    fontFamily: "Geist Variable, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "12px"
    fontWeight: 400
  chip:
    fontFamily: "Geist Variable, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "11px"
    fontWeight: 500
    lineHeight: 1
  section-label:
    fontFamily: "Geist Variable, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "10.5px"
    fontWeight: 600
    letterSpacing: "0.08em"
  mono:
    fontFamily: "Geist Mono Variable, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "11px"
    fontWeight: 400
    fontFeature: "\"zero\" 0, \"tnum\""
rounded:
  kbd: "4px"
  control-sm: "6px"
  sm: "8px"
  item: "10px"
  md: "12px"
  panel: "14px"
  bubble: "16px"
  pill: "999px"
spacing:
  gap: "10px"
  column: "720px"
  column-new: "680px"
  column-gutter: "24px"
  thread-gap: "20px"
  feed-top: "34px"
  feed-bottom: "40px"
  progress-height: "42px"
  tile-head: "38px"
  tab-row: "30px"
  stack-slot-min: "230px"
  code-panel: "300px"
  code-bar: "30px"
  statusbar-height: "26px"
  map-row: "34px"
  map-row-dense: "26px"
components:
  button:
    backgroundColor: "{colors.surface0}"
    textColor: "{colors.text}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "0 11px"
    height: "30px"
  button-hover:
    backgroundColor: "{colors.surface1}"
  button-primary:
    backgroundColor: "{colors.mauve}"
    textColor: "{colors.crust}"
    rounded: "{rounded.sm}"
    padding: "0 11px"
    height: "30px"
  button-primary-hover:
    backgroundColor: "{colors.mauve-hover}"
  button-warn:
    backgroundColor: "{colors.peach}"
    textColor: "{colors.crust}"
    rounded: "{rounded.sm}"
    height: "30px"
  button-warn-hover:
    backgroundColor: "{colors.peach-hover}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.subtext1}"
    rounded: "{rounded.sm}"
    height: "30px"
  button-ghost-hover:
    backgroundColor: "{colors.surface0}"
    textColor: "{colors.text}"
  button-sm:
    rounded: "{rounded.control-sm}"
    padding: "0 8px"
    height: "24px"
  chip-claude:
    textColor: "{colors.mauve}"
    typography: "{typography.chip}"
    rounded: "{rounded.pill}"
    padding: "0 7px"
    height: "20px"
  chip-codex:
    textColor: "{colors.teal}"
    typography: "{typography.chip}"
    rounded: "{rounded.pill}"
    padding: "0 7px"
    height: "20px"
  chip-warn:
    textColor: "{colors.peach}"
    typography: "{typography.chip}"
    rounded: "{rounded.pill}"
    padding: "0 7px"
    height: "20px"
  chip-idle:
    backgroundColor: "{colors.surface0}"
    textColor: "{colors.subtext0}"
    rounded: "{rounded.pill}"
    height: "20px"
  kbd:
    backgroundColor: "{colors.crust}"
    textColor: "{colors.subtext0}"
    rounded: "{rounded.kbd}"
    padding: "3px 5px"
  segmented:
    backgroundColor: "{colors.crust}"
    textColor: "{colors.subtext0}"
    rounded: "9px"
    padding: "3px"
  segmented-selected:
    backgroundColor: "{colors.surface0}"
    textColor: "{colors.text}"
    rounded: "{rounded.control-sm}"
    height: "26px"
  human-bubble:
    backgroundColor: "{colors.surface0}"
    textColor: "{colors.text}"
    rounded: "16px 16px 5px 16px"
    padding: "10px 14px"
  decision-card:
    backgroundColor: "{colors.mantle}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "13px 16px 16px"
  composer:
    backgroundColor: "{colors.mantle}"
    textColor: "{colors.text}"
    rounded: "{rounded.panel}"
    padding: "10px 10px 8px 14px"
  send-button:
    backgroundColor: "{colors.mauve}"
    textColor: "{colors.crust}"
    rounded: "50%"
    size: "30px"
  needs-chip:
    textColor: "{colors.peach}"
    typography: "{typography.meta}"
    rounded: "{rounded.pill}"
    padding: "0 10px"
    height: "24px"
  field:
    backgroundColor: "{colors.base}"
    textColor: "{colors.text}"
    rounded: "{rounded.sm}"
    padding: "0 11px"
    height: "32px"
  tile:
    backgroundColor: "{colors.base}"
    rounded: "{rounded.md}"
  tile-head:
    height: "38px"
    padding: "0 6px 0 10px"
  tile-mark:
    rounded: "{rounded.control-sm}"
    size: "20px"
  waiting-pill:
    textColor: "{colors.peach}"
    typography: "{typography.chip}"
    rounded: "{rounded.pill}"
    padding: "0 8px"
    height: "20px"
  tab-track:
    backgroundColor: "{colors.mantle}"
    rounded: "9px"
    padding: "2px"
    height: "30px"
  tab-selected:
    backgroundColor: "{colors.surface0}"
    textColor: "{colors.text}"
    rounded: "{rounded.control-sm}"
    padding: "0 10px"
    height: "24px"
  overlay-panel:
    backgroundColor: "{colors.base}"
    rounded: "{rounded.panel}"
  map-row:
    textColor: "{colors.text}"
    rounded: "{rounded.item}"
    padding: "0 8px"
    height: "34px"
  map-row-dense:
    rounded: "{rounded.item}"
    height: "26px"
  station-id-chip:
    textColor: "{colors.mauve}"
    rounded: "{rounded.sm}"
    padding: "0 8px"
    height: "30px"
  viewer-tab:
    textColor: "{colors.subtext0}"
    typography: "{typography.label}"
    rounded: "{rounded.control-sm}"
    padding: "0 24px 0 9px"
    height: "26px"
  viewer-tab-active:
    backgroundColor: "{colors.surface0}"
    textColor: "{colors.text}"
  code-section:
    textColor: "{colors.subtext0}"
    rounded: "{rounded.control-sm}"
    padding: "0 8px"
    height: "26px"
  pane-tab-selected:
    textColor: "{colors.mauve}"
    height: "40px"
---

# Design System: Legion

## Overview

**Creative North Star: "The Quiet Control Room"**

Legion is a dark, dense desktop instrument built on Catppuccin (Mocha by default, Latte as the light flavour) with Geist for everything a person reads and Geist Mono for everything a machine produced. It has three modes over one window, all on the crust gutter. **Chat** is the home: the project's board, a window manager of conversations, where every conversation still going or holding a decision is a tile that tells its run as a thread and lets the user answer what waits in place. **Agents** is the inside of one conversation, the audit room of its run, entered from its tile with ⌘E and left with ⌘E or Esc: a route map of the run's plan (one trunk from Plan to Pull request, tasks hanging off it in waves) beside one deep station pane that shows the station picked on the map. **Code** is the project's workspaces, where you check on files and run commands without leaving while agents work: terminal-first, arranged by you like i3 (splits, tabs, stacks), on the project's main checkout or on a run's worktree (read-only while its agent works there, until you take it over), with the navigators (a run's changes, files, search, activity) in a side panel. The modes share the title bar, rail, status bar, tokens, chips and the base-on-crust frame; what tells them apart at a glance is the title bar's Chat | Code switch (Chat stays lit inside a conversation's agents, whose crumb ends in "/ Agents") and what the ground holds: answerable conversations, a map and one pane, or a row of workspace tabs over tiles.

Colour is semantic before it is decorative. Mauve is Claude and the primary action; teal is Codex; peach is "needs you" and nothing else; blue is running; green is done; red is failure; lavender is the quiet accent for links on hover, the followed task's dependency links and the remaining critical path. Surfaces are tonal steps of the palette (crust, mantle, base, surface0..2) separated by hairlines, not by shadow. The palette, the sans body with mono metadata and the component kit are a brand commitment: restructure surfaces freely, keep the look.

**Key Characteristics:**
- Catppuccin Mocha/Latte tokens only; components never hard-code a hex, so the flavour swap is a variable swap.
- Engine identity by colour: mauve = Claude, teal = Codex, everywhere (chips, status bar meters, plan rows).
- Peach is reserved for human attention; the needs-you count, decision cards, the dock and the title bar counter.
- Small UI type (13px base) in the chrome, reading sizes (14 to 14.5px) in a wide conversation tile; a narrow tile steps down to tile density by its own width.
- Tonal layering with hairlines; shadows only as soft lift under floating or pinned objects.
- Lines are straight: the route map is a tree of 2px lines with right angles and 6px corners, never curves.
- Critically damped motion; tiles glide to their places, and waiting is told by static peach, never by an ambient loop on the board.

## Colors

A cool lilac-grey night (Mocha) or a cool paper day (Latte), with pastel signal colours that each carry one meaning. Frontmatter values are Mocha; Latte swaps the same variables under `:root[data-flavour="latte"]` (values in the sidecar's `colorMeta.*.latte`).

### Primary
- **Claude Mauve** (mauve): Claude's engine colour and the primary action (New run, Send, Approve). Also the focus ring (2px outline, 2px offset), the selection tint (30%), the caret, links and the focused tile border. Hover steps to mauve-hover.

### Secondary
- **Codex Teal** (teal): Codex's engine colour only; chips, status bar meter, plan-row engine. Never decorative.

### Tertiary
- **Needs-You Peach** (peach): human attention. Decision card border tint (34% into surface0), the dock's needs-you count and chips, the title bar counter, attention step and task dot, warn buttons and chips, the dot on a worktree workspace's tab whose task waits on you, the read-only checkout bar's border and lock, and its Take over button; on the route map, a waiting task's ring (ring only, no glow), its "waiting" stage word and the header's waiting count; on the board, the waiting tile's static border (62% into surface0), the head's "n waiting" pill and the dot on a waiting tab or hidden-conversation row. Hover steps to peach-hover.

### Status
- **Running Blue** (blue): live work; running chips, live task dots, the progress line dot, rail run counts, the route map's live rings (with a breathing core) and live stage words.
- **Done Green** (green): finished; done task dots, completed step ticks, filled done rings with a tick on the map and the stage track, the "n merged" fold, answered receipts, PR links in event lines, the "All clear" dot (70%).
- **Failure Red** (red): failed tasks and their rings, errors, danger buttons, rate-limit meters at 90% and above.
- **Lavender** (lavender): the semantic `accent`; link hover, accent chips, the followed task's dependency links on the route map (and their glyphs in the pane header), the 8% wash on rows that task depends on, and the remaining critical path (branches 75% into surface1, pending rings 70% into surface2).
- **Code Yellow** (yellow): inline code text on a 7% yellow wash inside markdown.

### Neutral
- **Crust** (crust): the window body and the gutter of every mode (the board, the route map and pane, the Code workspaces); kbd caps, thumbnail backing, tooltips.
- **On-fill** (`--on-fill`): text on solid signal fills (primary, warn and danger buttons, counts, the send button). Crust in Mocha, white in Latte.
- **Mantle** (mantle): status bar, decision cards, composer, sources drawer, tool/mini blocks, the board's tab track.
- **Base** (base): tiles, the route map panel and the station pane, and so the conversation ground inside a board tile; overlay panels, fields inside cards.
- **Surface 0 / 1 / 2** (surface0, surface1, surface2): human bubbles, default buttons and hovers, card and tile borders, idle chips, the selected tab pill; surface1 for overlay borders, kbd outlines, the route map's trunk and branches and the stage track's lines; surface2 for hover borders, pending dots and dashed pending rings.
- **Text / Subtext 1 / Subtext 0** (text, subtext1, subtext0): primary, secondary (assistant name, captions) and muted (event lines, receipts) text. Latte darkens subtext, overlay1 and every signal colour (mauve, red, peach, yellow, green, teal, blue, lavender) so chip text holds 4.5:1 on its own wash over base and mantle; Mocha lifts overlay1 one notch (#7f849c to #82879f) for the same reason.
- **Overlay 2 / 1 / 0** (overlay2, overlay1, overlay0): faint metadata, timestamps, placeholders, icon buttons.
- **Hairline** (hairline) and **Chrome Line** (chrome-line): derived between-steps for dividers inside surfaces and for the window chrome edges.

Tinted fills are always `color-mix(in srgb, <signal> N%, transparent)` with N between 7 and 16 for chips and marks (claude 14, codex 13, ok 13, run 14, warn 16, bad 14, needs chip 10).

### Named Rules
**The Engine Colour Rule.** Mauve means Claude, teal means Codex, in every surface and every mode. An agent is named in text followed by its engine as a chip (`chip-claude` / `chip-codex`); never swap or reuse these hues for anything else.

**The Peach Is A Person Rule.** Peach appears only where the human is needed or a limit is near. If nothing waits for the user, no peach is on screen.

**The Token-Only Rule.** Components reference palette variables (or color-mix of them), never literal hexes, so Mocha and Latte stay one stylesheet.

## Typography

**Display Font:** Geist Variable (with ui-sans-serif, system-ui, -apple-system)
**Body Font:** Geist Variable
**Label/Mono Font:** Geist Mono Variable (with ui-monospace, SF Mono, Menlo), slashed-zero feature off

**Character:** A neutral grotesk at small, tight sizes for chrome and comfortable reading sizes in the conversation; the mono face is a data voice, not a style.

### Hierarchy
- **Display** (600, 28px, 1.2, -0.02em): the project name on the new-conversation tile, only at conversation density (in practice, when it is alone as the project's page).
- **Headline** (600, 21px, 1.3, -0.012em): the station pane's title; the new-conversation tile's title at tile density. The run title no longer heads the thread; it lives in the tile head.
- **Title** (600, 15.5px, 1.35): a presentation's title; the run title in the route map's header; markdown h1 in chat is 17px, h2 to h4 15px; tile titles 13px/600 (subtext1 on an unfocused board tile).
- **Body (reading)** (400, 14.5px, 1.62): assistant prose at conversation density; human bubbles and decision ledes 14px/1.5 to 1.55; composer input 14px (15px on the new-conversation tile). Measure is the 720px column inside a wide tile; under tile density all of these read at 13px.
- **Body** (400, 13px, 1.55): the app base size; markdown in tiles, sources, document previews, fields.
- **Label** (500, 12.5px): buttons; assistant and agent names at 12.5px/600.
- **Meta** (400, 12px): steps, event lines, needs chips, hints, tooltips; 11.5px for sub-lines and branches.
- **Chip** (500, 11px, line-height 1): status and engine chips.
- **Section label** (600, 10.5px, 0.08em, uppercase): rail and tile group headers only (Projects, Engines, Archived, Acceptance, Verify).
- **Mono** (400, 10.5 to 12px, tabular): timestamps, task ids, paths, branches, versions, costs, kbd caps, code, the status bar.

### Named Rules
**The Mono Means Machine Rule.** Geist Mono is only for code, paths, ids, branches, versions, timestamps and numbers. Names, labels, statuses and prose are always Geist.

**The Two Densities Rule.** Chrome and the Code view read at 11 to 13px (the viewer's code at its own mono size); the route map reads at 12.5 to 14.5px (rows 13.5px, stops 14.5px/500) and the station pane at 13 to 14px under its 21px title; a conversation reads at 14 to 14.5px inside a 720px measure. On the board, density is chosen per tile by the tile's own width (a container query), never by the window or the mode: a tile narrower than 620px reads at tile density (thread 13px, a smaller bubble, the progress strip trimmed to the current step); a wider tile keeps conversation density.

## Layout

The window is a fixed frame: a hiddenInset title bar (draggable, interactive children opt out), the rail on the left, the main area, and a 26px mono status bar on mantle with a chrome-line top border. The title bar holds the crumb (project / run title, plus "/ Agents" inside a conversation's agents) left, the Chat | Code segmented switch centred, and Commands, the needs-you counter and the primary button right (New conversation ⌘N on a board or inside a conversation's agents, New run ⌘⇧N elsewhere).

**Chat mode: the project board.** Every conversation in the project that is still going, or holds an open decision, is a tile on the crust gutter, 10px from the edges and from each other. The layout is a deterministic dwm "tall" layout, decided by count alone. One tile fills the board; two split it 50/50. From three on, the master sits left at 56% of the inner width and up to three tiles stack on the right, each at least 230px tall; the overflow shares the last stack slot as tabs (a 30px tab row with the active tile 6px below it). Monocle shows one tile under a tab row of every tile, on request (⌘F) or forced when the board's inner width is under 720px. A conversation that finishes while the board is up stays until it is hidden or the board is left. A run that is not on the board (finished, or hidden) opened from the rail is a temporary tile: it shows alone in monocle and leaves when monocle closes.

**The conversation inside a tile.** One column, `min(720px, 100% - 48px)`, centred in the tile on the base ground (the new-conversation tile uses 680px with a top pad of `max(28px, 12cqh)`). A sticky 42px progress strip spans the top with a hairline under it; the thread scrolls between it and the dock, which is pinned to the bottom (12px bottom pad in a tile) with a 28px base-coloured fade above it. Thread items stack with a 20px gap; a continued assistant turn tucks to 10px; cards get 4px extra margin. Feed padding is 34px top, 40px bottom. Assistant body and sources indent 28px under a 20px mark. In a tile under 720px wide the plan meta, composer hint and working count drop out; under 620px the tile reads at tile density: column `100% - 32px`, feed 18/24px, thread gap 14px, no body indent, a 34px progress strip.

**Agents mode: the route map.** Two panels on crust with 10px gutters: the map left at `minmax(340px, min(420px, 32%))`, the station pane filling the rest. Both are base panels in the frame (1.5px surface0, 12px radius). The map has a header (run title, then counts: tasks, working, peach waiting, red failed, each count a jump) above a scrolling list. Parallel work grows the map downward, never sideways: the trunk runs from Plan through the waves to Integration and Pull request, which follow the last wave and pin to the panel's bottom once the list scrolls; the list's bottom edge fades (22px mask) only when it overflows. Under 900px of main area the map folds into a 42px bar above the pane ("T9 Tax rates sync" in text/600, then the counts) that opens the map as a popover (380px max, overlay shadow); the 960x600 minimum window reads this way.

**Code mode: the project's workspaces.** On crust, 10px gutters. A 30px bar on top: the side panel toggle, the workspace tabs on the board's tab track (in the order made, never reshuffled; the main checkout's named after the project, a worktree's after its task, "T4 Credential table migration", with a branch glyph, a lock while read-only, a breathing blue dot while its agent works, a static peach dot while its task waits on you; hover shows its close), a "+" that opens the new-workspace picker, and a ghost "Terminal ⌘T" right. A worktree workspace has a 32px checkout bar under it (mantle, 9px radius): the task, its branch in mono, and while its agent works "Read-only while its agent works here" with the engine chip and a warn "Take over" button (border tinted peach, a peach lock); taken over, "Yours: you took it over". Then the side panel (300px, a base panel in the tile frame; open by default on the main checkout, closed on a worktree) and the tiles. Code belongs to the project, not to the active run: its first workspace is the main checkout with a shell in it, and you make more yourself (on the project, or on a run's task or integration worktree); a takeover or a worktree shell asked for from elsewhere lands in the workspace on that worktree (made when needed). Inside a workspace, layout is the user's, i3-style: a tree of containers splitting side by side or above each other in remembered shares, or showing one child under a tab row (tabbed, 30px, the board's tab track) or under title bars (stacked, 28px rows on mantle with hairlines, the shown one on surface0, the focused one with a 2px mauve inset at its left edge). A new tile opens beside the focused one, splitting it along its longer side; nothing rearranges itself.

**How the modes relate.** Same frame, same tokens, same crust gutter, same base panels with surface0 borders. Chat is where the user acts; agents is where they audit one run; code is where they work in the project themselves. Agents is not a peer of the other two: it belongs to one conversation. ⌘E on the focused tile, the Agents door at the end of its progress strip, or View → Agents opens its run's agents once the planner is at work or there is a plan (on a conversation still only with the assistant, or the new tile, it does nothing and never falls through to Code); ⌘E, Esc, the Chat segment or the run title in the crumb return to the board with that tile focused. A task dot in the progress strip opens agents on that task's station. A saved agents view is never restored on launch; the app opens on the board.

**The Steady Board Rule.** Order is never rearranged by attention. Newcomers (a run started elsewhere, a hidden tile coming back because it needs you) join the end of the stack, oldest first; a conversation started from the new tile takes that tile's place as master; otherwise only the user moves the master (⌘⇧⏎).

## Elevation & Depth

Depth is tonal: crust under mantle under base under surface0, separated by hairlines and 1 to 1.5px surface borders. Shadows are soft, negative-spread lifts in `--shadow` (black in Mocha, the Latte text colour in Latte), used only on objects that float or are pinned over the scroll, plus glows that signal focus or urgency.

### Shadow Vocabulary
- **Card lift** (`box-shadow: 0 10px 28px -20px color-mix(in srgb, var(--shadow) 80%, transparent)`): decision cards.
- **Composer lift** (`box-shadow: 0 14px 34px -24px color-mix(in srgb, var(--shadow) 90%, transparent)`): the pinned composer; on focus-within it adds a 3px mauve ring at 11%.
- **Tooltip lift** (`box-shadow: 0 12px 28px -12px color-mix(in srgb, var(--shadow) 85%, transparent)`): task-dot tooltips; the jump-to-latest pill uses `0 8px 22px -12px` at 80%.
- **Overlay** (`box-shadow: 0 24px 64px color-mix(in srgb, var(--shadow) 55%, transparent), 0 0 0 1px color-mix(in srgb, var(--shadow) 40%, transparent)`): palette, composer overlay and dialogs over a crust scrim at 55% with a 3px blur; the folded route map's popover (no scrim).
- **Focus glow** (`--glow-focus`: 1px mauve ring at 30% plus an 18px mauve glow at 20%): the focused tile or card.
- **Selected-ring halo** (`box-shadow: 0 0 0 3px color-mix(in srgb, var(--mauve) 30%, transparent)`): the selected station's ring on the route map.
- **Urgent glow** (`--glow-urgent`: 1.5px peach ring plus a 24px peach glow at 45%): an urgent tile in the agents view's station pane and a decision card that was jumped to. A waiting board tile and a waiting route-map ring get no glow; peach is static there.

### Named Rules
**The Flat Ground Rule.** Things that sit in the flow are flat; only what floats over the scroll or is pinned gets a lift, and glows only ever mean focus (mauve) or urgency (peach).

## Shapes

Gently rounded, never sharp and never blobby. The ladder: 4px kbd caps, 5 to 7px small controls (segments, icon buttons, tabs, small buttons, rail glyphs), 8px buttons, fields and thumbnails, 9 to 10px rail items, sources and document frames, 12px cards and tiles, 9px the segmented and tab tracks, 14px the composer and overlay panels, 16px human bubbles with a 5px bottom-right tail corner, full pills for chips, needs chips and the jump pill, circles for dots, the send button and receipt marks. Borders are 1px in the conversation (hairline or surface0) and 1.5px (`--border-w`) on tiles, cards, overlays and the rail's current item. Dashed borders mean "empty, closed or not yet": the viewer's preview tab, a closed composer, pending rings and the stretch of trunk into an unreached terminus, and a dependency link down to what waits on a task.

Lines are 2px with round caps (the route map's trunk and branches, the stage track's joins, the tab underline); a dependency link is a 1.5px line. Where a line turns, it turns at a right angle with a 6px rounded corner. Rings are circles: 16px on rows, 22px on stops and the stage track.

**The Straight Tree Rule.** The route map is a tree view in straight lines: vertical trunk, horizontal branches, right-angle links with 6px corners. No curves and no diagonals.

## Components

### Buttons
Compact and solid, the kit from the incumbent mockup.
- **Shape:** gently rounded (8px), 30px tall, 11px side padding, 12.5px/500, 7px icon gap.
- **Primary:** mauve fill, crust text; hover mauve-hover. Warn: peach fill; Danger: red fill; both with crust text.
- **Default / Ghost:** surface0 fill stepping to surface1 on hover; ghost is transparent with subtext1, gaining surface0 and text on hover.
- **Focus / Disabled:** 2px mauve outline at 2px offset; disabled at 45% opacity.
- **Sizes:** small 24px with a 6px radius; icon 28px square. In the composer, round 30px send (mauve; surface0 with overlay1 when disabled; presses to scale 0.94) and stop (surface1) buttons.
- **Key caps:** mono 10.5px on crust with a surface1 outline; inside filled buttons they go translucent crust.

### Chips
- **Style:** 20px pills, 7px padding, 11px/500, signal text on a 13 to 16% wash of the same signal; idle chips are surface0 with subtext0.
- **Variants:** claude, codex, ok, run, warn, bad, idle, accent. Decision kinds are chips toned by kind; agent names carry their engine chip ("engine · role").
- **Needs chip:** 24px peach pill with a 10% wash and a 28% peach border; hover deepens to 18%.

### Cards / Containers
- **Decision card:** mantle fill, 1px border tinted 34% peach, 12px radius, 13/16/16px padding, card lift, a kind chip and mono time in the head. Answered, it folds (height and opacity, 260ms) into a one-line receipt: an 18px round mark (green, red or muted) and subtext0 text.
- **Presentations:** unboxed on the ground. Agent name and chip, a 15.5px title, a subtext1 caption; only the media is framed: thumbnails at 16/10 with an 8px radius, 1px surface0 border on crust (hover surface2, image scales 1.012), galleries in 1, 2 or 3 columns; a document preview is one framed object (10px radius, base fill, hairline head, masked fade at 232px).
- **Tiles (board and Code):** base fill, 1.5px surface0 border, 12px radius, 38px head with hairline; focused = mauve border plus focus glow (only when there is more than one tile); an unfocused tile's title goes subtext1 and no tile dims. On the board, a waiting unfocused tile has a static border of peach 62% into surface0 and never pulses, and no tile dims: every tile is meant to be read. In the station pane a tile's body is hosted without its frame or head; the pane is the frame.

### Inputs / Fields
- **Field:** 32px, base fill, 1px surface0 border, 8px radius, 13px; placeholder overlay1; focus turns the border mauve.
- **Composer:** the primary action in a conversation. Mantle, 1px surface0 border, 14px radius, composer lift; focus-within shifts the border to 50% mauve with a 3px mauve ring at 11%. Mauve caret. Attach left, hint and send right. A closed composer goes transparent and dashed.

### Navigation
- **Title bar:** crumb (13px/600, surface0 hover; inside a conversation's agents the run title becomes a subtext0/400 link back to the board and "Agents" ends the crumb in text/600), Chat | Code segmented control with icons and a spring-animated pill (Chat stays lit inside a conversation's agents), ghost Commands button with kbd, the needs-you ghost button (green dot "All clear" or peach dot, label and a peach count badge; on the board it is the live signal for what waits), and the primary button: "New conversation ⌘N" on a board and inside one of its conversations' agents (which goes back to the board and splits the new tile in), "New run ⌘⇧N" elsewhere (⌘⇧N opens the full composer from anywhere).
- **Segmented control:** crust track, 1px surface0 border, 9px radius, 3px padding; 26px segments in subtext0, the selected one on a surface0 pill.
- **Rail:** projects with tinted letter glyphs (tint at 14% with a 22% inset ring, solid when current) and their runs on a 1.5px surface0 spine; a run's status line leads with what waits on the user ("2 waiting for you", "PR ready for you") in peach with a static dot, so the rail needs no second marker; items are 10px rounded, base on hover, base plus 1.5px surface0 border when current. Group headers use the section label.
- **Status bar:** mono 11px on mantle; run spend and per-engine rate meters (engine-coloured, peach at 75%, red at 90%); in agents mode the way out and the map's keys as a faint hint ("⌘E/Esc board · ⌥J/K stations · ⌥H/L tabs"); in code mode its keys ("⌘T terminal · ⌘D/⌘⇧D split · ⌥HJKL focus · ⌥⇧ move · ⌘⌃ resize · ⌘⌥T/S/E tabs·stack·split · ⌘1–9 workspaces"), or, with a terminal focused, that keys go to it.

### Board (signature)
Conversation tiles in the tile frame on the crust gutter, laid out by the tall layout (see Layout).
- **Head:** 38px on a hairline: a 20px engine-tinted mark (6px radius, engine colour at 15%; surface0 with a plus for the new tile), the title at 13/600, the peach "n waiting" pill (20px, 11px/500, 10% wash, 28% border, a 6px dot; it jumps to the first open item), then the engine chip (hidden when the tile is under 440px) and 26px ghost icon actions in overlay2: monocle (only when the board can tile), hide. A tile's agents are not a head action: their door is the end of the progress strip (⌘E).
- **Focus and waiting:** the focused tile has the mauve border and focus glow; a waiting unfocused tile has the static peach-tinted border. Unfocused tiles are quiet: the title goes subtext1, the dock's needs bar is hidden (the head's pill counts), and the composer rests as one quiet line (13px, no lift, controls hidden) until clicked. Inside a tile the dock never repeats the count.
- **Tabs:** a mantle track (30px, 9px radius, 1px surface0 border, 2px padding) of 24px tabs in 12px subtext0; the selected one sits on a surface0 pill (6px radius) that moves on the critically damped spring, with a 45% mauve inset ring when focused; waiting tabs lead with a peach dot.
- **New-conversation tile:** alone, it is the project's page: name, path and a large composer, then the hidden conversations that still wait as quiet rows (12.5px, a peach dot, the title, "n waiting · hidden" in peach). ⌘N splits it in as the master; Esc on an empty draft closes it. It holds no history list; the rail keeps history.
- **Temporary tile:** a finished or hidden run opened from the rail, alone in monocle, closed (not hidden) by its close action or Esc.
- **Keyboard:** ⌘N new conversation tile (⌘⇧N the full New run composer); ⌥ HJKL (also ⌘⌥ HJKL or arrows) focus (returning to the tile focused last in that direction); ⌘F monocle; Esc leaves monocle (never while typing); ⌘⇧⏎ make master; ⌘W hide until it needs you. ⌘1 to 9 remain the rail's runs.

### Code Workspaces (signature)
A project's workspaces (see Layout), each arranged by the user.
- **Terminals** are the main tile: ⌘T opens one beside the focused tile, ⌘D one to its right, ⌘⇧D one below. The head names the shell by where it is: "T4 worktree", "Takeover · T4" with the engine chip, or "Terminal" with the project or folder in mono; terminals that would share a name are numbered in layout order ("Terminal 1", "Terminal 2"), in heads, tab rows, title bars and the palette alike. Closing one ends its shell; closing a workspace with terminals asks first.
- **Viewers** hold files and diffs as tabs in their 38px head, like an editor pane holds buffers (26px tabs, 6px radius, 12px subtext0 stepping to text; the tab on show on a surface0 pill, with a 45% mauve inset ring while the viewer has the focus; a file icon, or a diff/commit glyph with a mono id, a task's T4 or a commit's short sha, then the title, then the folder in overlay1 when two files share a name; a 16px close on hover). Opening a file shows it in the focused viewer, else the viewer used last, else a new viewer beside the focused tile: browsing never makes windows. It replaces the **preview tab**, drawn with a 1px dashed surface2 outline because it is not kept yet; ⌘⏎, a ⌘-click or a double-click keeps it. A thing already open is reused (and takes the new line). The tab strip scrolls sideways and fades (28px masks) at an edge that hides tabs; it never wraps. Tabs stay mounted while open (each keeps its scroll and selection); the last tab closed closes the viewer. Files are read from the workspace's checkout.
- **Editor:** a file's text opens in the editor (CodeMirror 6), on base, in Geist Mono 12.5px at 1.65 line height, a quiet gutter (overlay0 numbers, subtext0 on the current line, fold markers), the active line on a 38% surface0 wash, the mauve 2px caret and a 26% mauve selection (the app's), lavender for bracket and selection matches, a yellow wash for search matches (not peach: nothing waits on you), and Catppuccin's own syntax colours, which belong to the code. Standard keys by default (multiple cursors, ⌘F find and replace in a mantle panel, ⌘D next occurrence, ⌘/ comments, folding), vim as a setting (Settings → Appearance → Editor keys; normal mode shows a fat mauve cursor and a mono status line). ⌘S saves; a save is refused when the file changed on disk since it was read. The path bar says "Unsaved" (with a text-coloured dot), "Saving…", or, in peach, why it is read-only ("Read-only while its agent works here", too large, not UTF-8). An edited tab shows a dot where its close sits and is kept (an edited preview is pinned); closing it asks "Discard your changes…?" with Keep editing as the safe answer. Edits live in a buffer that outlives the editor on screen (tabs and workspaces switch without losing them, undo included). While on screen the editor looks at its file every two seconds: a change on disk reloads an untouched buffer and, under unsaved edits, raises a peach-tinted bar ("changed on disk while you were editing it": Take theirs / Keep mine and save).
- **Reviewing a task's diff:** a task's diff (from a worktree workspace's Changes) is reviewed in place. Each hunk header carries, on hover or while it is the active hunk, ghost "Comment" and "Revert" (11.5px, 20px tall, 5px radius). Comment (or `c`) opens a box under the hunk (mantle, a 40% mauve-tinted border, 13px text, "Add comment ⌘⏎", Esc puts it away); your comments sit under their hunk as mantle cards ("Your comment", `schema.ts:2–4` in mono, the text at 13px, a delete). A review bar (mantle, hairline above) counts them and sends them as one message: "Send to Claude/Codex" goes into the coder's session while it works (it reads it after its current step), else back to the agent as a request for changes; while nothing can take it (in review, merged) the bar says why. "Approve & merge" (green) shows while the task waits on you. Revert takes the hunk back out of the worktree after a confirm, committed on the task branch unless the agent is at work; while it works, Revert is disabled until you take the worktree over. Drafts survive a reload until sent.
- **Empty workspace:** a dashed frame (empty, not yet) with "Nothing open here." and Terminal ⌘T / Open a file ⌘P.
- **New-workspace picker:** a 340px overlay-lifted base panel under the "+": "On the project" first, then every run's worktrees grouped under the run's title (T-rows with the task's state, "Integration" with its branch in mono); ↑↓ ⏎, Esc. A worktree that already has a workspace switches to it.
- **Side panel:** a 38px head of sections on 26px pills (only the open section shows its label; the rest are icons with their name and key in the tooltip): Changes (on a run's worktree only), Files, Search, Activity, then a chevron that hides it. Files and Search are of the workspace's checkout, and the open directories are read again every few seconds. Changes lists "All changes" (the integration branch in mono, or "once the first task merges") and every task in plan order: a status dot (breathing while live), the mono id in subtext1, the title, the short state in its colour, `+a −r` in mono green and red, and on hover a terminal button that opens the workspace on its worktree. The row whose diff is on show carries the 9% mauve wash.
- **Keyboard:** see the status bar line in Navigation; also ⌘F a tile alone (⌘F again, or Esc outside a terminal), ⌘W close the tab on show or the focused terminal, ⌘⏎ keep the preview, ⌘⇧[ / ⌘⇧] the viewer's tabs (else the tabs of the container around the focus), ⌃Tab / ⌃⇧Tab the workspaces, ⌘⌥N a new workspace, ⌘B the panel, ⌘⇧F the panel's search with the caret in it, ⌘P go to file. ⌘1–9 are the workspaces while Code is on screen and the rail's runs elsewhere. ⌘K lists every window of every workspace by name ("Windows", the first group in Code).

### Progress Strip (signature)
A 42px strip pinned at the top of each conversation: phase steps (plan, execute n/m, integrate, pull request) separated by surface2 chevrons, done steps with green ticks, the current step in text/600, an attention step in peach; then one 8px dot per task (surface2 pending, ringed idle, blue live, green done, peach attention, red failed, faded gone) on 18x22px hit areas; then, right-aligned, "n working" and the door to the agents once there are any: a small ghost button "Agents ⌘E" (the agents glyph, 12px label, the key cap shown only on the focused tile and dropped under 440px). Hovering a dot rises a crust tooltip with the task id in mono, its status and latest progress line; clicking opens agents mode on that task's station.

### Route Map (signature)
The run's plan as a tree on one trunk, in the map panel (see Layout).
- **Trunk and waves:** a 2px surface1 trunk from Plan to Pull request. Tasks group in waves by dependency depth. A wave of several tasks is a wave head stop on the trunk ("Wave 2", then "11 in parallel · 3 merged" in subtext0) with its rows on straight 2px branches in the trunk's colour (lavender-tinted on the remaining critical path). A wave of one task is a stop on the trunk itself, captioned "Wave n · stage". Finished waves fold to one line; an open wave's merged rows fold into a green "n merged" row; waves beyond the next fold into "Then n waves"; a wave ahead reads in subtext1 and its rows at 60% opacity. A selected row is never folded away, and nothing is reordered by attention.
- **Stops:** Plan, wave heads, Integration and Pull request; 46px minimum, a 22px ring on the trunk, title 14.5px/500 over a 12.5px subtext0 caption (peach when it waits).
- **Rows:** 34px (26px and 12.5px when a wave holds more than 15), on a grid of 16px ring, mono id 12.5px in subtext1, title 13.5px, a short stage word 12.5px in the state colour ("coding", "checks", "review", "fix 1/2", "waiting", "failed", "pending"), then engine dots (6px, mauve or teal) in one aligned column.
- **Rings:** blue live with a breathing core (6px, 8px on stops), green filled with a tick when done, peach ring only when waiting, red failed, dashed surface2 pending (70% lavender into surface2 on the critical path), surface1 at 70% when skipped.
- **Highlights:** hover (surface0 45%), related (lavender 8%, the rows the selected task depends on) and selection all wrap the text only, starting right of the ring, 10px radius, so no line or ring crosses a highlight's edge. The selection is a 1.5px mauve outline over a 7% mauve wash that glides between stations on the critically damped spring; the selected ring carries the selected-ring halo.
- **Dependency links:** for the selected task only, right-angle lavender lines (1.5px, 6px corners) in a gutter left of the trunk: solid up to what it waits on, dashed down to what waits on it, ending at the row or at the folded line that holds it.
- **Keyboard:** ⌥J/K (also ⌘⌥J/K) walk the stations, ⌥H/L the pane's tabs. Off macOS, ⌥ is Ctrl+Alt.

### Station Pane (signature)
One deep pane for the station picked on the map; no pinning, no second pane.
- **Header** (18px 22px padding): a 30px id chip (mono 13px/600, mauve on a 14% mauve wash, 8px radius), or the same chip holding a 14px icon for run-level stations (Plan, Integration, Pull request, Crew); the 21px title; engine chips "claude coder" / "codex reviewer" with the role at 72%; the status chip; the tile's own actions. Under it a 14px subtext0 goal caption (two lines at most, 90ch), then, for a task, "Waits on T1, T2 · Unblocks T17" in 13px with line glyphs that match the map's links (solid and dashed lavender) and mono ids that turn lavender on hover.
- **Stage track:** 22px rings joined by 2px lines, 13px labels under them. A task reads Code, Check, Review, Merge, or once a review sent it back Code, Review, Fix n/m, Re-review, Merge; run-level stations read Plan, Execute m/n, Integrate, Pull request. Done steps are green filled with a tick and green joins; the current step is a mauve ring with a 4px core and a mauve 600 label (peach when it waits on the user, red when it failed), its join a gradient from green.
- **Tabs:** underline tabs on a hairline, 40px tall, 14px subtext0 with 24px gaps; selected is mauve 600 with a 2px mauve underline. Badges: a live dot, a mono "+n −m" diff stat on a surface0 pill, a findings count.
- **Body:** the focused tile of the run's layout tree. A task holds Transcript, Changes, Review; Plan holds Questions (while a clarify question is open), Plan, Graph; Integration; Pull request holds Pull request, Final review, Changes; the Crew holds Agents and Messages. A plan node with no task yet shows its brief (13 to 14px, criteria, files, "Waits on" as small buttons, size and risk).

### Thread
- **Human turn:** right-aligned surface0 bubble, max `min(82%, 560px)`, 14px/1.55, 60% opacity while sending.
- **Assistant turn:** unboxed, a 20px mark (6px radius, 15% wash) with "Assistant" and mono time, body indented 28px; provenance folds under a "Based on..." toggle into a mantle drawer with hairline-divided sources.
- **Events:** quiet 12px subtext0 lines with a hairline rule; PR links green.
- **Typing:** three 5px overlay1 dots hopping, turning mauve at the top.
- **Dock:** needs-you bar (kind chips that jump to each waiting item) above the composer; the count lives in the tile head's pill, and the title bar counts the other conversations.
- **Outcome:** a finished, failed or stopped run ends on a quiet summary under a hairline: an 18px receipt mark with the title (Finished, Failed, Stopped), then facts in subtext0 labels over mono values (pull request and its state, tasks merged, spent, took). Unboxed, like the rest of the thread.
- **Escalation actions:** the usual answers stay in view (Retry, Retry with a note); Start over, Skip and Stop sit behind a More toggle, with Stop pushed to the row's end and confirmed first.

### Motion
Critically damped springs (stiffness 800, damping 2*sqrt(800)) for layout pills, board tiles and the route map's selection outline gliding between stations; the only bouncy spring is for attention pop-ins. Board tiles glide to new rects on that spring (x, y, width, height); a new tile fades and scales in from 0.985 over 200ms; a hidden tile fades out over 150ms and the rest close the gap. The house ease-out is `cubic-bezier(0.16, 1, 0.3, 1)`. New thread items rise 6px from opacity 0 over 200ms; answered cards fold in 260ms; overlays open in 150ms; hovers transition colour in 150ms. Ambient loops are opacity-only: breathe (1.4s) for live dots, live ring cores and skeletons, the urgency pulse (1.6s) on an urgent station-pane tile. In Code, tiles glide to their new rects on the critically damped spring when a tile opens, closes, moves or is resized, or the panel opens (its width snaps, the panel fades in 8px from the left over 180ms); a worktree workspace's live tab dot breathes. The board and the route map run no attention loop: waiting is static peach and the title bar's counter. Reduced motion (OS or Settings override) collapses every duration to instant.

## Do's and Don'ts

### Do:
- **Do** use only palette variables and color-mix washes of them, so Latte works without a second stylesheet.
- **Do** name an agent in text and follow it with its engine chip: mauve `chip-claude`, teal `chip-codex`.
- **Do** keep peach for the human: the needs-you counter, decision cards, the dock, waiting route-map rings, waiting board tiles, and a worktree workspace waiting on you or read-only (its tab dot, its checkout bar and Take over).
- **Do** give every window a name on screen: a workspace tab, a viewer tab, a tile head, a container's tab or title bar. Nothing scrolls off screen unnamed, and nothing rearranges itself: the layout is the user's.
- **Do** set code, paths, ids, branches, versions, timestamps and numbers in Geist Mono, and everything else in Geist.
- **Do** put conversations on base inside their tile, tiles, the map and the station pane on the crust gutter, and a wide tile's thread inside the 720px measure.
- **Do** grow the route map downward: parallel tasks are rows in a wave, folded when finished, never columns.
- **Do** start every route-map highlight right of the ring, so lines and rings never cross it.
- **Do** choose a conversation's density by its tile's width (620px), never by the window or the mode.
- **Do** frame only what needs framing in the thread: decision cards, the composer and presentation media.
- **Do** give every interactive element the 2px mauve focus outline (peach on needs-you chips).
- **Do** animate with transform and opacity on the house ease-out, and honour reduced motion with instant transitions.

### Don't:
- **Don't** swap or reuse mauve and teal for anything but Claude and Codex.
- **Don't** put peach on anything that doesn't need the user.
- **Don't** set names, statuses or prose in mono.
- **Don't** box assistant prose or presentations; the human bubble and decision cards are the only containers for messages.
- **Don't** pulse, glow or dim board tiles for attention; a waiting tile is a static peach-tinted border and the title bar's counter is the live signal.
- **Don't** reorder the board or the route map by attention; newcomers join the end of the stack.
- **Don't** draw curved or diagonal lines on the route map; links turn at right angles with 6px corners.
- **Don't** use the uppercase section label as a kicker or eyebrow above a heading; it is for rail and tile group headers only.
- **Don't** use hard or offset shadows; lifts are soft, negative-spread and tinted with `--shadow`.
- **Don't** hard-code hex values in components.
