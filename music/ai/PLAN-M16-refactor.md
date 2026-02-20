# PLAN-M16 Refactor: Size Reduction With KISS Boundaries

## Summary
This refactor reduces oversized files while keeping concept count low for maintenance mode.
The key index split is now:

1. `index-startup.ts` for startup lifecycle mechanics.
2. `index-sync.ts` for all pull/sync orchestration (primary account + favorites + shares).

We explicitly drop `index-derived.ts` to avoid abstract top-level concepts.

## Goals
1. No file over 1000 lines.
2. Keep 800 as a soft target, not a hard stop.
3. Preserve behavior and public module contracts.
4. Keep caller sets explicit with consumer-prefixed helper modules.

## Final Module Strategy

## 1) Index Split (Revised)

### `music/src/index-startup.ts`
Owns startup lifecycle mechanics only:
1. Startup deadline race + terminal-state latch.
2. Startup terminal render helpers (sign-in/error/deadline handling).
3. Startup restore/bootstrap helpers for local persisted startup state.
4. OAuth redirect bootstrap helper.
5. Service worker startup registration helper.

Does not own long-lived app orchestration or sync loops.

### `music/src/index-sync.ts`
Owns synchronization orchestration:
1. Pull single-flight, periodic scheduling, and online/visibility-triggered pulls.
2. Primary OneDrive account sync and index refresh flow.
3. Favorites and shares cloud pull coordination.
4. Share probe/refresh/index progress/cache cleanup lifecycle.
5. Sync status propagation used by settings rows and refresh UI.

Keeps share indexing orchestration out of `shares.ts`.

### Keep In `music/src/index.ts`
1. Composition root wiring.
2. `showTree`, `openSettingsPage`, `closeSettingsPage`.
3. Tree/playback/select/downloads/settings callback wiring.
4. Search UI mode and push.
5. Offline projection and push (`computeAndPushOfflineState`).
6. `onBodyLoad` export as top-level entrypoint.

## 2) Shares Boundary
`music/src/shares.ts` remains a domain module:
1. Share record persistence (IDB + OneDrive shares file).
2. Share CRUD and runtime denied-state bookkeeping.
3. Remove-impact computation.

`shares.ts` will not absorb:
1. Share index builds via `buildIndex`.
2. Share reindex progress orchestration.
3. Tree/settings sync orchestration.
4. Pull scheduling.

## 3) Playback Split
1. Create `music/src/playback-engine.ts` for URL cache, expiry refresh, prefetch, and source resolution.
2. Create `music/src/playback-ui.ts` for expanded scrubber, gestures, and expansion UI lifecycle.
3. Keep `music/src/playback.ts` as facade + core playback state machine.

## 4) Select + Modal Split
1. Create `music/src/select-dialogs.ts` for select-specific dialogs and offline modal.
2. Create `music/src/modal.ts` for shared modal shell primitives used by `select` and `settings` (meaningful dedupe only).
3. Keep `music/src/select.ts` focused on select-mode state machine and action-bar flow.

## 5) Tree
Keep `music/src/tree.ts` intact for this milestone unless it crosses 1000 after nearby edits.

## 6) HTML/CSS Split
1. Keep HTML and synchronous theme bootstrap script in `music/index.html`.
2. Extract theme variables and dark/light overrides to `music/theme.css`.
3. Extract all other styles to `music/index.css`.
4. Update `music/sw.js` app shell list to include both CSS files.
5. Update deploy staging copy command in `music/package.json` to include both CSS files.

## 7) Integration Test Split
Replace monolithic `music/test/integration/tree.test.cjs` with:
1. `music/test/integration/test-helpers.cjs`
2. `music/test/integration/test-cases-tree-settings.cjs`
3. `music/test/integration/test-cases-playback-select-startup.cjs`
4. `music/test/integration/test-main.cjs`

Keep compatibility by making `tree.test.cjs` a thin wrapper that delegates to `test-main.cjs`.

## 8) File Size Guidance
Keep file size as an engineering smell signal, not a hard automated gate.

## Public API / Interface Impact
No intended behavior or public API changes.
All new modules are internal refactor boundaries.
`index.ts` still exports `onBodyLoad`.

## Acceptance Criteria
1. No touched file exceeds 1000 lines.
2. Build and typecheck pass.
3. Unit tests pass.
4. Integration tests pass locally.
5. Deploy succeeds.
6. Integration tests pass against production URL.
7. Startup terminal-state behavior remains correct (including deadline bypass for first-time indexing).

## Test and Validation Sequence
1. `cd music && npm run build`
2. `cd music && npm run test:unit`
3. `cd music && timeout 45 npm test -- "settings|playback|startup"` and inspect `/tmp/oneplay-music-test.log`
4. `cd music && npm test`
5. `cd music && npm run deploy`
6. `cd music && ONEPLAY_MUSIC_TEST_URL=https://unto.me/oneplay/music/ npm test`
7. Manual production smoke for settings/share/playback/search/offline/startup terminal paths

## Assumptions and Defaults
1. Refactor is behavior-preserving and maintenance-focused.
2. Keep concept count low: prefer caller-scoped helpers over broad reusable abstractions.
3. Name side-effecting functions with explicit side effects.
4. Avoid `void asyncFn()` fire-and-forget callsites.
5. If `index.ts` remains >1000 after this split, the next candidate is search-only extraction, not deeper startup/sync fragmentation.

## Phase 2: Playback Purity Refactor (No New Files)

### Summary
1. Keep exactly the current three playback files: `music/src/playback.ts`, `music/src/playback-engine.ts`, `music/src/playback-ui.ts`.
2. Move additional pure business logic from `playback.ts` into `playback-engine.ts`.
3. Keep all side effects in `playback.ts` and `playback-ui.ts` (DOM, audio element, localStorage, IndexedDB, MediaSession API, logging).
4. Refactor `playback.ts` into thin orchestration: call pure helpers, assign results, run side effects.
5. Bring `music/src/playback.ts` under 1000 lines while preserving behavior.

### Scope and Constraints
1. In scope: playback internals only.
2. Out of scope: feature changes, UX changes, new top-level concepts/files, changes to `createPlayback` public contract.
3. Hard constraint: `playback-engine.ts` remains pure-only.

### Implementation Plan

#### 1) Extract Track-List Pure Logic To `music/src/playback-engine.ts`
1. Add a pure reducer for refresh semantics currently in `refreshTrackList`:
- Inputs: `freshTrackList`, `prevTrackList`, `playbackTrack`, `playbackMode`.
- Output: `{ trackList, currentTrackIdx }`.
- Behavior parity: non-shuffle replace/reindex, shuffle preserve order when set unchanged, reshuffle only when set changed.
2. Add pure shuffle helper:
- Input: list + current index + RNG function.
- Output: shuffled list + remapped current index.
- `playback.ts` passes `Math.random` to keep current behavior deterministic-by-runtime.
3. Keep in `playback.ts`:
- Track collection (`collectTracks` / `collectLogicalTracks`).
- Logging.
- Assigning module state from reducer outputs.

#### 2) Extract Navigation/Advance Decisions To `music/src/playback-engine.ts`
1. Add pure decision helpers used by `doPrev`, `doNext`, and `ended`:
- Prev index choice by mode.
- Next index choice by mode.
- Shuffle end-of-pass fallback choice.
2. Keep in `playback.ts`:
- `playNext(...)` invocation.
- Timer side effects.
- URL/audio side effects.
- Logging.

#### 3) Extract Per-Favorite Persistence Business Logic To `music/src/playback-engine.ts`
1. Add pure helpers for payload and validation:
- Build favorite save payload from `{ track, time }`.
- Build global playback payload from `{ folder, track, mode, favId }`.
- Parse/validate favorite state from localStorage JSON.
- Parse/validate global playback state shape as needed.
- Pick restore candidate index/time from parsed state + current `trackList`.
2. Keep in `playback.ts`:
- `localStorage.getItem/setItem`.
- `dbGet`.
- `favoritesRef.setMode`.
- try/catch, logging, assignment.

#### 4) Extract MediaSession Pure Logic To `music/src/playback-engine.ts`
1. Move pure metadata derivation from `playback.ts`:
- Given resolved names, produce `{ filename, album, title }`.
2. Add pure position-state helper:
- Input: duration/currentTime/playbackRate.
- Output: valid/clamped payload or `undefined`.
3. Keep in `playback.ts`:
- `navigator.mediaSession.metadata` writes.
- `setPositionState`.
- per-action registration and platform guards.

#### 5) Thin `music/src/playback.ts` Into Orchestrator
1. Replace inlined decision logic with calls to engine pure helpers.
2. Ensure each side-effecting function name still signals side effects.
3. Preserve current logging points and message text unless a rename is required for clarity.
4. Remove dead code and stale comments after extraction.

### Public APIs / Interfaces / Types
1. `createPlayback(...)` and `Playback` interface remain unchanged.
2. `playback-engine.ts` gains new pure exports (names finalized during implementation), likely including:
- Track-list refresh reducer input/output types.
- Shuffle result type.
- Persistence payload/parse helper types.
- MediaSession derived payload type.
3. No new module files beyond the existing three playback files.

### Testing Plan

#### Unit Tests
1. Add or extend unit tests for new pure helpers in `playback-engine`:
- Refresh reducer in shuffle/non-shuffle and changed/unchanged set cases.
- Shuffle current-index remap correctness.
- Prev/next/ended decision outputs across modes.
- Persistence parse/build helpers for valid/corrupt/missing data.
- MediaSession payload and position-state clamping edge cases.

#### Integration / Regression
1. Run `timeout 45 npm test -- "playback"` and inspect `/tmp/oneplay-music-test.log`.
2. Run targeted existing flows:
- Track click starts playback.
- Prev/next behavior by mode.
- Ended auto-advance behavior.
- Offline/blocked no-playable handling.
- Search-to-playback flow.

#### Build / Size Gates
1. `npm run build`
2. `npm run test:unit`

### Acceptance Criteria
1. `music/src/playback.ts` is below 1000 lines.
2. Behavior parity is maintained (no intended UX/feature changes).
3. All build and tests above pass.
4. `playback-engine.ts` contains only pure logic (no DOM/audio/storage/MediaSession/network side effects).

### Assumptions and Defaults
1. Keep exactly three playback files; do not introduce `playback-persistence` or `playback-media-session` files.
2. Preserve existing runtime behavior and log semantics unless a pure refactor requires tiny wording updates.
3. Favor KISS over over-abstraction: if a helper has one trivial callsite, keep it inline in `playback.ts`.
4. Continue using current fallback rules for legacy favorite state (`localStorage` first, then IndexedDB legacy read path).
