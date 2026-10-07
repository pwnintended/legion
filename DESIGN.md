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
  overlay1: "#7f849c"
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
  statusbar-height: "26px"
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
  overlay-panel:
    backgroundColor: "{colors.base}"
    rounded: "{rounded.panel}"
---

# Design System: Legion

## Overview

**Creative North Star: "The Quiet Control Room"**

Legion is a dark, dense desktop instrument built on Catppuccin (Mocha by default, Latte as the light flavour) with Geist for everything a person reads and Geist Mono for everything a machine produced. It has two modes over one window. **Conversation** is the home: a single 720px reading column on the base ground, edge to edge, where the run is told as a thread and the user answers what waits in place. **Agents** is the audit room: the incumbent tiling workspace on the crust gutter, bordered tiles in columns, every agent live. The modes share the title bar, rail, status bar, tokens and chips; they differ in ground (base vs crust) and in how much moves, so a glance tells you which one you are in.

Colour is semantic before it is decorative. Mauve is Claude and the primary action; teal is Codex; peach is "needs you" and nothing else; blue is running; green is done; red is failure; lavender is the quiet accent for links on hover and the critical path. Surfaces are tonal steps of the palette (crust, mantle, base, surface0..2) separated by hairlines, not by shadow. The palette, the sans body with mono metadata and the component kit are a brand commitment: restructure surfaces freely, keep the look.

**Key Characteristics:**
- Catppuccin Mocha/Latte tokens only; components never hard-code a hex, so the flavour swap is a variable swap.
- Engine identity by colour: mauve = Claude, teal = Codex, everywhere (chips, status bar meters, plan rows).
- Peach is reserved for human attention; the needs-you count, decision cards, the dock and the title bar counter.
- Small UI type (13px base) in the chrome, reading sizes (14 to 14.5px) in the conversation.
- Tonal layering with hairlines; shadows only as soft lift under floating or pinned objects.
- Critically damped motion; one live signal per screen in conversation mode.

## Colors

A cool lilac-grey night (Mocha) or a cool paper day (Latte), with pastel signal colours that each carry one meaning. Frontmatter values are Mocha; Latte swaps the same variables under `:root[data-flavour="latte"]` (values in the sidecar's `colorMeta.*.latte`).

### Primary
- **Claude Mauve** (mauve): Claude's engine colour and the primary action (New run, Send, Approve). Also the focus ring (2px outline, 2px offset), the selection tint (30%), the caret, links and the focused tile border. Hover steps to mauve-hover.

### Secondary
- **Codex Teal** (teal): Codex's engine colour only; chips, status bar meter, plan-row engine. Never decorative.

### Tertiary
- **Needs-You Peach** (peach): human attention. Decision card border tint (34% into surface0), the dock's needs-you count and chips, the title bar counter, attention step and task dot, warn buttons and chips, urgent tile border and pulse glow. Hover steps to peach-hover.

### Status
- **Running Blue** (blue): live work; running chips, live task dots, the progress line dot, rail run counts.
- **Done Green** (green): finished; done task dots, completed step ticks, answered receipts, PR links in event lines, the "All clear" dot (70%).
- **Failure Red** (red): failed tasks, errors, danger buttons, rate-limit meters at 90% and above.
- **Lavender** (lavender): the semantic `accent`; link hover, critical-path pipeline nodes, accent chips.
- **Code Yellow** (yellow): inline code text on a 7% yellow wash inside markdown.

### Neutral
- **Crust** (crust): the window body and the agents-mode gutter; kbd caps, thumbnail backing, tooltips, text on mauve/peach fills.
- **Mantle** (mantle): status bar, decision cards, composer, sources drawer, tool/mini blocks.
- **Base** (base): the conversation ground, tiles, overlay panels, fields inside cards.
- **Surface 0 / 1 / 2** (surface0, surface1, surface2): human bubbles, default buttons and hovers, card and tile borders, idle chips; surface1 for overlay borders and kbd outlines; surface2 for hover borders and pending dots.
- **Text / Subtext 1 / Subtext 0** (text, subtext1, subtext0): primary, secondary (assistant name, captions) and muted (event lines, receipts) text. Latte darkens subtext to meet WCAG AA.
- **Overlay 2 / 1 / 0** (overlay2, overlay1, overlay0): faint metadata, timestamps, placeholders, icon buttons.
- **Hairline** (hairline) and **Chrome Line** (chrome-line): derived between-steps for dividers inside surfaces and for the window chrome edges.

Tinted fills are always `color-mix(in srgb, <signal> N%, transparent)` with N between 7 and 16 for chips and marks (claude 14, codex 13, ok 13, run 14, warn 16, bad 14, needs chip 10).

### Named Rules
**The Engine Colour Rule.** Mauve means Claude, teal means Codex, in every surface and both modes. An agent is named in text followed by its engine as a chip (`chip-claude` / `chip-codex`); never swap or reuse these hues for anything else.

**The Peach Is A Person Rule.** Peach appears only where the human is needed or a limit is near. If nothing waits for the user, no peach is on screen.

**The Token-Only Rule.** Components reference palette variables (or color-mix of them), never literal hexes, so Mocha and Latte stay one stylesheet.

## Typography

**Display Font:** Geist Variable (with ui-sans-serif, system-ui, -apple-system)
**Body Font:** Geist Variable
**Label/Mono Font:** Geist Mono Variable (with ui-monospace, SF Mono, Menlo), slashed-zero feature off

**Character:** A neutral grotesk at small, tight sizes for chrome and comfortable reading sizes in the conversation; the mono face is a data voice, not a style.

### Hierarchy
- **Display** (600, 28px, 1.2, -0.02em): the new-conversation page title only.
- **Headline** (600, 21px, 1.3, -0.012em, balanced wrap): the run title at the head of the thread.
- **Title** (600, 15.5px, 1.35): a presentation's title; markdown h1 in chat is 17px, h2 to h4 15px; tile titles 13px/600.
- **Body (reading)** (400, 14.5px, 1.62): assistant prose in the conversation; human bubbles and decision ledes 14px/1.5 to 1.55; composer input 14px (15px on the new-conversation page). Measure is the 720px column.
- **Body** (400, 13px, 1.55): the app base size; markdown in tiles, sources, document previews, fields.
- **Label** (500, 12.5px): buttons; assistant and agent names at 12.5px/600.
- **Meta** (400, 12px): steps, event lines, needs chips, hints, tooltips; 11.5px for sub-lines and branches.
- **Chip** (500, 11px, line-height 1): status and engine chips.
- **Section label** (600, 10.5px, 0.08em, uppercase): rail and tile group headers only (Projects, Engines, Archived, Acceptance, Verify).
- **Mono** (400, 10.5 to 12px, tabular): timestamps, task ids, paths, branches, versions, costs, kbd caps, code, the status bar.

### Named Rules
**The Mono Means Machine Rule.** Geist Mono is only for code, paths, ids, branches, versions, timestamps and numbers. Names, labels, statuses and prose are always Geist.

**The Two Densities Rule.** Chrome and agents mode read at 11 to 13px; the conversation reads at 14 to 14.5px. Don't bring tile density into the thread or thread sizes into tiles.

## Layout

The window is a fixed frame: a hiddenInset title bar (draggable, interactive children opt out), the rail on the left, the main area, and a 26px mono status bar on mantle with a chrome-line top border. The title bar holds the crumb (project / run title) left, the Chat | Agents segmented switch centred, and Commands, the needs-you counter and New run right.

**Conversation mode.** One column, `min(720px, 100% - 48px)`, centred in the free width on the base ground (the new-conversation page uses 680px with a top pad of `max(56px, 13vh)`). A sticky 42px progress strip spans the top with a hairline under it; the thread scrolls between it and the dock, which is pinned to the bottom with a 28px base-coloured fade above it. Thread items stack with a 20px gap; a continued assistant turn tucks to 10px; cards get 4px extra margin. Feed padding is 34px top, 40px bottom. Assistant body and sources indent 28px under a 20px mark. Below 720px the plan meta, composer hint, recent timestamps and working count drop out.

**Agents mode.** The incumbent tiling workspace: columns of bordered tiles on crust with a 10px gap, a horizontally scrolling strip with no scrollbar and no snapping, tabbed and stacked columns, 44px thin collapsed columns, and the layout-mode segmented control in the title bar.

**How the modes relate.** Same frame, same tokens; the switch changes the ground (base vs crust) and the density. Conversation is where the user acts; agents is where they audit. A task dot in the progress strip opens agents mode focused on that task's tile.

## Elevation & Depth

Depth is tonal: crust under mantle under base under surface0, separated by hairlines and 1 to 1.5px surface borders. Shadows are soft, negative-spread lifts in `--shadow` (black in Mocha, the Latte text colour in Latte), used only on objects that float or are pinned over the scroll, plus glows that signal focus or urgency.

### Shadow Vocabulary
- **Card lift** (`box-shadow: 0 10px 28px -20px color-mix(in srgb, var(--shadow) 80%, transparent)`): decision cards.
- **Composer lift** (`box-shadow: 0 14px 34px -24px color-mix(in srgb, var(--shadow) 90%, transparent)`): the pinned composer; on focus-within it adds a 3px mauve ring at 11%.
- **Tooltip lift** (`box-shadow: 0 12px 28px -12px color-mix(in srgb, var(--shadow) 85%, transparent)`): task-dot tooltips; the jump-to-latest pill uses `0 8px 22px -12px` at 80%.
- **Overlay** (`box-shadow: 0 24px 64px color-mix(in srgb, var(--shadow) 55%, transparent), 0 0 0 1px color-mix(in srgb, var(--shadow) 40%, transparent)`): palette, composer overlay and dialogs over a crust scrim at 55% with a 3px blur.
- **Focus glow** (`--glow-focus`: 1px mauve ring at 30% plus an 18px mauve glow at 20%): the focused tile or card.
- **Urgent glow** (`--glow-urgent`: 1.5px peach ring plus a 24px peach glow at 45%): urgent tiles (pulsing) and a decision card that was jumped to.

### Named Rules
**The Flat Ground Rule.** Things that sit in the flow are flat; only what floats over the scroll or is pinned gets a lift, and glows only ever mean focus (mauve) or urgency (peach).

## Shapes

Gently rounded, never sharp and never blobby. The ladder: 4px kbd caps, 5 to 7px small controls (segments, icon buttons, tabs, small buttons, rail glyphs), 8px buttons, fields and thumbnails, 9 to 10px rail items, sources and document frames, 12px cards and tiles, 14px the composer and overlay panels, 16px human bubbles with a 5px bottom-right tail corner, full pills for chips, needs chips and the jump pill, circles for dots, the send button and receipt marks. Borders are 1px in the conversation (hairline or surface0) and 1.5px (`--border-w`) on tiles, cards, overlays and the rail's current item. Dashed borders mean "empty or closed": the ghost add-column, quiet pipeline nodes and a closed composer.

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
- **Tiles (agents mode):** base fill, 1.5px surface0 border, 12px radius, 38px head with hairline; focused = mauve border plus focus glow; urgent = peach border, pulsing urgent glow; dimmed at 86%.
- **Overview cards and pipeline nodes:** same frame as tiles, lift 2px on hover with a surface2 border.

### Inputs / Fields
- **Field:** 32px, base fill, 1px surface0 border, 8px radius, 13px; placeholder overlay1; focus turns the border mauve.
- **Composer:** the primary action in conversation mode. Mantle, 1px surface0 border, 14px radius, composer lift; focus-within shifts the border to 50% mauve with a 3px mauve ring at 11%. Mauve caret. Attach left, hint and send right. A closed composer goes transparent and dashed.

### Navigation
- **Title bar:** crumb (13px/600, surface0 hover), Chat | Agents segmented control with a spring-animated pill, ghost Commands button with kbd, the needs-you ghost button (green dot "All clear" or peach dot, label and a peach count badge), primary New run.
- **Segmented control:** crust track, 1px surface0 border, 9px radius, 3px padding; 26px segments in subtext0, the selected one on a surface0 pill.
- **Rail:** projects with tinted letter glyphs (tint at 14% with a 22% inset ring, solid when current) and their runs on a 1.5px surface0 spine; items are 10px rounded, base on hover, base plus 1.5px surface0 border when current. Group headers use the section label.
- **Status bar:** mono 11px on mantle; run spend and per-engine rate meters (engine-coloured, peach at 75%, red at 90%); in agents mode a key-mode pill (mauve normal, peach resize, blue move).

### Progress Strip (signature)
A 42px strip pinned at the top of the column: phase steps (plan, execute n/m, integrate, pull request) separated by surface2 chevrons, done steps with green ticks, the current step in text/600, an attention step in peach; then one 8px dot per task (surface2 pending, ringed idle, blue live, green done, peach attention, red failed, faded gone) on 18x22px hit areas; then "n working" right-aligned. Hovering a dot rises a crust tooltip with the task id in mono, its status and latest progress line; clicking opens agents mode on that task.

### Thread
- **Human turn:** right-aligned surface0 bubble, max `min(82%, 560px)`, 14px/1.55, 60% opacity while sending.
- **Assistant turn:** unboxed, a 20px mark (6px radius, 15% wash) with "Assistant" and mono time, body indented 28px; provenance folds under a "Based on..." toggle into a mantle drawer with hairline-divided sources.
- **Events:** quiet 12px subtext0 lines with a hairline rule; PR links green.
- **Typing:** three 5px overlay1 dots hopping, turning mauve at the top.
- **Dock:** needs-you bar (peach dot, count, kind chips, "n in other runs" link) above the composer.

### Motion
Critically damped springs (stiffness 800, damping 2*sqrt(800)) for layout pills; the only bouncy spring is for attention pop-ins. The house ease-out is `cubic-bezier(0.16, 1, 0.3, 1)`. New thread items rise 6px from opacity 0 over 200ms; answered cards fold in 260ms; overlays open in 150ms; hovers transition colour in 150ms. Ambient loops are opacity-only: breathe (1.4s) for live dots and skeletons, the urgency pulse (1.6s) on tiles, and in conversation mode exactly one ping, the dock's needs-you dot (2.4s). Reduced motion (OS or Settings override) collapses every duration to instant.

## Do's and Don'ts

### Do:
- **Do** use only palette variables and color-mix washes of them, so Latte works without a second stylesheet.
- **Do** name an agent in text and follow it with its engine chip: mauve `chip-claude`, teal `chip-codex`.
- **Do** keep peach for the human: the needs-you counter, decision cards, the dock and urgent tiles.
- **Do** set code, paths, ids, branches, versions, timestamps and numbers in Geist Mono, and everything else in Geist.
- **Do** keep conversation surfaces on base inside the 720px column, and agents mode on the crust gutter.
- **Do** frame only what needs framing in the thread: decision cards, the composer and presentation media.
- **Do** give every interactive element the 2px mauve focus outline (peach on needs-you chips).
- **Do** animate with transform and opacity on the house ease-out, and honour reduced motion with instant transitions.

### Don't:
- **Don't** swap or reuse mauve and teal for anything but Claude and Codex.
- **Don't** put peach on anything that doesn't need the user.
- **Don't** set names, statuses or prose in mono.
- **Don't** box assistant prose or presentations; the human bubble and decision cards are the only containers for messages.
- **Don't** add a second live animation to conversation mode; the dock's needs-you ping is the only one.
- **Don't** use the uppercase section label as a kicker or eyebrow above a heading; it is for rail and tile group headers only.
- **Don't** use hard or offset shadows; lifts are soft, negative-spread and tinted with `--shadow`.
- **Don't** hard-code hex values in components.
