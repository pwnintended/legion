---
version: 1
slug: "src-renderer-chat-chatview-tsx"
primary_target: "src/renderer/chat/ChatView.tsx"
related_targets: ["src/renderer/chrome/TitleBar.tsx"]
---

# Surface: the run conversation (Chat mode)

Mode: Operate. Inherits Legion's established world (Catppuccin Mocha/Latte tokens, Geist + Geist Mono, chip vocabulary, mauve = Claude, teal = Codex, peach = needs you). Extension, not a new world: DESIGN.md is not rewritten.

Audience and job: a developer who started a run and mostly looks away. On return they need three answers fast: what changed, what needs me, what is there to look at. Background agents stay inspectable in Agents mode (the old tiling workspace), never in the user's face.

Content: assistant conversation (human + assistant turns, persisted), lead status updates the assistant relays (provenance folded under its reply), decision cards from the inbox (approval, question, plan sign-off, escalation, conflict, PR ready, budget) that collapse to receipts once answered, things agents present (images, markdown, PDFs, files), quiet run event lines. Runs without an assistant still get the thread (events, cards, presentations).

Decisions settled in shape (confirmed by the user): one thread per run; Agents mode is a separate full-window mode; decisions move into the chat and the Inbox overlay goes away; keep the look. Project home becomes a new-conversation page; "Plan directly" goes away.

## Direction contract

THESIS: The run is a conversation; agents work offstage. The chat column owns the window. Refuses the category default for agent orchestrators: a dashboard of live transcript tiles as the home screen.

OWN-WORLD: Legion's Mocha base ground edge to edge (crust stays the agents view's gutter, so the two modes read differently at a glance; a crust field behind a base band would draw two vertical edges the calm column does not need), Geist at reading sizes, Geist Mono only for paths, ids and numbers. Human turns sit in a quiet surface0 bubble on the right; assistant prose sits unboxed on the ground with a small engine-tinted mark. Decision cards are the only bordered objects: mantle fill, hairline, peach rule-free attention via a peach label and focus glow. Presentations sit unboxed on the ground; only their media is framed: thumbnails with a 1px hairline, the document preview as one framed object. Agents are named in text with their engine as the world's chip (mauve claude, teal codex); decision kinds are chips too.

STORY: Open a run, read the last few lines, answer what is waiting in place, glance at what was shown to you, and leave. Drop into Agents only to audit.

FIRST VIEWPORT: Title bar: crumb, a two-way Chat | Agents switch centered, Commands, a peach "needs you" counter, New run. Rail left as today. Center: a single column, 720px measure, centered in the free width. A sticky progress strip at the column top: phase steps (plan, execute n/m, integrate, PR) and one dot per task, tinted by state. The thread fills the column; the needs-you dock and the composer are pinned at the bottom of the column. The composer is the primary action.

FORM: chat thread with inline decision cards and agent presentations, first of the structures considered in shape. Seed: none rolled. The structure was decided by the user in the shape interview, in their own answers: "One thread per run", "Separate 'Agents' mode", "Into the chat as cards", "Restructure, keep the look"; this is an extension of the established world, not an open surface. The strip also counts agents at work ("3 working"): the one-word answer to "is anything happening".

SIGNATURE: the progress strip's task dots. Hover reveals the task's latest progress line; click flies into Agents mode focused on that task's tile. Motion grammar: new thread items rise 6px from opacity 0 with the house ease-out (0.16, 1, 0.3, 1) over 200ms; an answered decision card collapses into its one-line receipt with a height animation (260ms). One live signal only: the needs-you dot in the dock pings while something waits. Reduced motion: instant.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
