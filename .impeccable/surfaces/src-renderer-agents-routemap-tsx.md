---
version: 1
slug: "src-renderer-agents-routemap-tsx"
primary_target: "src/renderer/agents/RouteMap.tsx"
related_targets: ["src/renderer/agents/StationPane.tsx","src/renderer/chrome/TitleBar.tsx","src/renderer/app/App.tsx"]
---

# Surface: the run's route map (Agents mode)

Mode: Operate. Inherits Legion's established world (Catppuccin Mocha/Latte tokens, Geist + Geist Mono, chips, mauve = Claude, teal = Codex, peach = needs you, lavender = critical path). Replaces the run's tiling strip (strip, focus, overview and pipeline layouts) in Agents mode.

Audience and job: a developer with a run going who leaves the Chat board to check one task, inspect the work before trusting a merge, see the whole run, or find what is stuck. One deep view with a map; never a wall of live tiles.

Content: the run's plan DAG (1 to ~25 tasks, up to ~12 in parallel), each task's coder and reviewer attempts, fix rounds, diff, review findings and messages; run-level plan, clarify questions, integration, final review and PR; the crew (assistant, lead, planner, researchers).

Decisions settled in shape (confirmed 2026-10-07): route map chosen from a surface roll; one pane only, no pinning; the project rail stays; files, editor, search, terminals, project overview and activity move to a new Code mode (Chat | Agents | Code), whose landing view is overview and activity; parallel work grows the map downward, never sideways.

Approved comps: `.impeccable/mocks/decision/assigned.png` (deep pane, locked on the decision page) and `.impeccable/mocks/decision/assigned-dense.png` (the map at scale, confirmed in chat). Comp defects not to copy: T8 marker should be blue (in review), dependency curves must reach their rows, engine dots align in one column.

Later user decisions (2026-10-07): "I prefer this to not have curved lines, more like a tree view with straight lines and slightly rounder corners"; "the selected one in a tree is looking a bit ugly due to all the overlapping things"; comp authority downgraded: "Yes, reference only. The comp guides the look; the build follows your later decisions (tree view, rail, shared title bar)."

## Direction contract

THESIS: The plan's dependency graph is the index. One vertical trunk carries the run from Plan to Pull request; tasks hang off it in waves; the one you pick fills the room. Refuses the sideways strip of columns, the dashboard of many live transcripts, and the branching graph that runs out of width.

OWN-WORLD: Map panel on base (300 to 410px, 12px radius, 1.5px surface0 border) on the crust gutter beside one deep pane in the same frame. A tree view in straight lines: one 2px surface1 trunk, each wave's rows on straight branches off it (lavender on the critical path); no curves. Rings in state colour (blue live, green done with tick, peach ring waiting, red failed, dashed surface2 pending). Rows 34px (26px dense): mono id, Geist title, stage word, engine dots in aligned columns. Selected: a mauve outline that wraps the text only, right of the ring, plus a mauve halo on the ring; the selected task's dependency links run as right-angle lines with 6px rounded corners in a gutter left of the trunk (solid up, dashed down). Pane: mono id chip, 21px title, goal caption, engine chips, a stage track of ring steps, a tab row, the tile body.

STORY: Open Agents, read the map top down, see what is waiting or failing by its ring, click or J/K to a station, read its transcript, switch to Changes or Review without losing your place, answer an approval in the pane.

FIRST VIEWPORT: Title bar with Chat | Agents | Code; rail; map left with header counts (tasks, working, waiting, failed), Plan terminus, folded finished waves, the open wave's rows, the next wave dimmed, folded later waves, Integration and Pull request termini; right the selected task: header, stage track, tabs Transcript · Changes · Review, transcript with the steer bar at the bottom.

FORM: Route map (vertical line diagram with waves), position 4 on the grounded list, dealt as the lead of seed efbd4955; raised by the wayfinding challenger (the followed station stays lit; only what is ahead is signed).

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
