# overlays

Floating layers (architecture §11): composer (⌘⇧N), inbox (⌘I), command palette (⌘K, cmdk), settings (⌘,).
One command registry feeds keybindings, palette and tooltips. While an overlay is open it owns the keyboard:
only commands marked `inOverlay` fire from keys (see `app/commands.ts`).
