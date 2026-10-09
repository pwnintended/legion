# overlays

Floating layers (architecture §11): composer (⌘⇧N), inbox (⌘I), command palette (⌘K, cmdk), settings (⌘,: a
near-full-window sheet, one page per section; Agents is a role list beside each role's engine, model, effort and
layered prompt, `AgentsSettings.tsx`).
One command registry feeds keybindings, palette and tooltips. While an overlay is open it owns the keyboard:
only commands marked `inOverlay` fire from keys (see `app/commands.ts`).
