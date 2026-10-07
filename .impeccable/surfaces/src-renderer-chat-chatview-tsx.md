---
version: 1
slug: "src-renderer-chat-chatview-tsx"
primary_target: "src/renderer/chat/ChatView.tsx"
related_targets: ["src/renderer/board/Board.tsx","src/renderer/chrome/TitleBar.tsx"]
---

# Surface: the project board (Chat mode)

Mode: Operate. Inherits Legion's established world (Catppuccin Mocha/Latte tokens, Geist + Geist Mono, chip vocabulary, mauve = Claude, teal = Codex, peach = needs you). Extension, not a new world. Supersedes the single-column run page: the conversation (ChatView) is now the body of a board tile.

Audience and job: a developer with one to three assistant conversations going in a project (rarely more than five). On return: see every conversation at once, see which wait on them, answer in place without navigating. Background agents stay offstage in Agents mode.

Content: per tile, the whole conversation (turns, relayed updates, decision cards folding to receipts, presentations, events, progress strip, needs-you chips, composer). Board members: the project's runs that are not archived and either still going or holding an open decision (PR ready). A run that finishes on screen stays until hidden or the board is left. A run opened from the rail that is not a member shows as a temporary tile in monocle.

Decisions settled in shape (confirmed by the user, 2026-10-07): tiles are live, answerable chats; scope is one project; auto-tiling, keyboard-driven (i3/dwm "tall"); new conversation is a tile that splits in, and alone it is the project's page; monocle in place; the board replaces the separate run page; the "Conversations" history list goes (the rail keeps history); waiting tiles get a static peach border, no pulse.

## Direction contract

THESIS: The project is a window manager of conversations. Every live conversation is a tile you can answer in place; layout is automatic and deterministic, never rearranged by attention. Refuses both the inbox list of conversations and the dashboard of agent transcripts.

OWN-WORLD: Agents-mode tile frame on the crust gutter: base tiles, 1.5px surface0 border, 12px radius, 10px gaps, 38px head on a hairline. Head: engine-tinted 20px mark, run title 13/600, peach "n waiting" pill when something waits, engine chip, ghost icon actions (agents, monocle, hide). Focused tile: mauve border and focus glow. Waiting, unfocused: static peach-tinted border. Tabs (overflow and monocle): a mantle track with surface0 pills, peach dot on waiting tabs. Inside tiles the conversation keeps its own look; density steps down by container width.

STORY: Open the project, scan the tiles, answer what waits right in its tile, split in a new conversation with ⌘N, blow one up with ⌘F when it needs room, hide what is done with ⌘W.

FIRST VIEWPORT: Title bar as before, its primary button reads "New conversation ⌘N" on a board. Rail left. Main area: crust field; master tile left (56% of the width, full height); up to three stacked tiles right, overflow sharing the last slot as tabs. Zero conversations: one new-conversation tile fills the board (project name, path, large composer). Too narrow to split (<720px inner): monocle with tabs.

FORM: tall tiling layout (dwm/xmonad), decided by the user in shape; extension of the established world. Seed: none rolled.

SIGNATURE: a new conversation splits in as the master and the other tiles glide to their new places on a critically damped spring (transform x/y plus size); a hidden tile fades out 150ms and the rest close the gap. Unfocused tiles rest their composer as one quiet line that opens on click. Keyboard: ⌘⌥ HJKL/arrows focus (returns to the tile focused last), ⌘F monocle, Esc leaves it, ⌘⇧⏎ make master, ⌘W hide until it needs you, ⌘N new. Reduced motion: instant.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
