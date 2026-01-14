# Flowgate migration plan (remove legacy Trystero)

Goal: retire the legacy Trystero compatibility layer while keeping stability during transition.

## Scope (legacy surface)
- Globals: `window.__TRYSTERO_CHAT__`, `window.__TRYSTERO_PEER__`, `window.__TRYSTERO_ROOM__`, `window.__TRYSTERO_STABLE_ID`
- Events: `trystero:*`
- Storage keys: `trystero_*`

## Phase 0 - Inventory and freeze
- Define the official legacy APIs to support during transition (list above).
- Freeze new usage: no new code should consume `trystero:*` directly.

## Phase 1 - Explicit aliasing and dual events
- `Modules/Flowgate.html`: publish primary API in `window.Flowgate` and keep `__TRYSTERO_*` as aliases/proxies.
- Emit both `flowgate:*` and `trystero:*` events.
- Storage: read `trystero_*` as fallback, but write only `flowgate_*` (migrate on first read).

## Phase 2 - Update consumers to Flowgate
- Migrate modules/widgets to `window.Flowgate` and `flowgate:*` events.
- Keep legacy fallback only where strictly needed during transition.
- Priority targets (high integration):
  - `Widgets/fscore.html`
  - `Modules/host-visibility.js`
  - `Modules/Keepawake.html`
  - `Modules (Host-only)/serialport.html`
  - `Modules/maincontrol.html`
- Secondary targets:
  - `Widgets/Roleta.html`
  - `Widgets/audiolistener.html`
  - `Widgets/botoespersonalizados.html`
  - `Widgets/Games/peer-arena.html`
  - `Widgets/Games/naval.html`

## Phase 3 - Deprecation
- Remove `trystero:*` listeners from migrated consumers.
- Stop writing `trystero_*` (keep read with deprecation warning).
- Keep `__TRYSTERO_*` aliases for one release cycle with clear warnings.

## Phase 4 - Final removal
- Remove `__TRYSTERO_*` aliases and all `trystero:*` events from Flowgate.
- Remove `trystero_*` storage and migration code.
- Clean legacy UI/strings (e.g., `trystero-*` classes and labels).

## Notes
- Keep a simple checklist per phase to track progress and avoid regressions.
