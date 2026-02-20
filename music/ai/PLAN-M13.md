# M13 Plan: Settings Page, Share-Stub Modals, and Refresh Coordination

## Summary

Implement a full Settings page (replacing the old account-row dropdown), move settings entry to the MyMusic row, split sync/index indicators between MyMusic and OneDrive, add persisted timer/debug settings, and add a race-free "Refresh now" pipeline. Share add/remove in M13 will open/close modals only (no data mutation).

1. In scope: Settings page UI and navigation, sign out/reconnect actions, timer persistence, debug toggle persistence, indexing status display, refresh-now behavior, spinner split, integration test updates.
2. In scope: Share add/remove modal UX with no-op confirm actions.
3. Out of scope: Real share connect/remove/indexing (M14), timer playback mode behavior (M15), search UI (M15).

## HOW TO EXECUTE ON A PLAN

1. Implement the plan
   - You should check your implementation with AI autonomous validation and testing.
   - The hope is that implementation can be done with a minimum of human interaction, preferably none at all.
   - Once it is complete, add a "Validation" section to the bottom of the plan showing how you have validated it and what were the results.
2. After implementation, do a "review" phase
   - Clean up LEARNINGS.md. If any information there is just restating information from other files (AGENTS.md, SANDBOX.md) then delete it. If it would belong better elsewhere, move it.
   - Validate whether the changes have satisfied their goals
   - Do a code review
   - Evaluate if there is KISS, or consolidation, or refactoring that would improve quality of codebase
   - Tell the user how you have done code cleanup. The user is passionate about clean code and will be delighted to hear how you have improved it.
3. Upon completion, ask for human review. Tell the user what to test, what commands to use, what gestures to try out, what to look for


## Public API / Interface Changes

1. `tree.ts` `TreeView` changes:
- Remove dropdown-specific callbacks: `onSignOut`, `onSignIn`.
- Add `onSettingsClick: () => void`.
- Add `setDebugEnabled(value: boolean): void`.
- Keep `setAccount(..., reindexing?: boolean)` and make `reindexing` visually rendered on OneDrive rows.
- Remove all static OneDrive row icons (`☁`, `⚠`) in M13. OneDrive row only gets a spinner while reindexing.

2. New UI component module `settings.ts`:
- Export `TimerDuration = '15m' | '30m' | '45m' | '60m' | 'end-of-track'`.
- Export `createSettings(...)` returning:
  - `open(initial: { evidence, timerDuration, debugEnabled, lastIndexUpdatedAt, onClose, onSignOut, onReconnect, onRefreshNow, onTimerChange, onDebugToggle })`
  - `close()`
  - `isOpen()`
  - `updateIndexSection(status: { pullInFlight, indexProgress, lastIndexUpdatedAt })`
- KISS decision: no monolithic `setState()`. Build Settings DOM on open, destroy on close, and only live-update the Index section while open.

3. `index.ts` orchestration additions:
- Single-flight pull coordinator (`requestPull...`) used by startup, periodic pull, online recovery, and settings refresh button.
- Settings persistence read/write for timer/debug/index timestamp.
- Runtime debug flag wiring for both tree debug UI and SW controllerchange reload gating.
- Explicit index-progress pipeline: keep latest reindex progress in orchestration state, update it from `buildIndex(..., onProgress, ...)`, and push to `settings.updateIndexSection(...)` when Settings is open.

## Implementation Plan

1. Replace settings entry point and remove old dropdown.
Update `tree.ts` so MyMusic row owns settings entry icon; icon is `⚙` normally and `⚠` when evidence is `evidence:signed-out`. Remove OneDrive cloud/warning icon rendering entirely. OneDrive row has no icon in idle state; it shows only a reindex spinner while indexing. Delete `showSettingsDropdown()` and related CSS in `index.html`.

2. Add OneDrive indexing indicator.
Render account-level spinner on OneDrive rows when `root.reindexing === true`. Keep MyMusic spinner for short pull/sync work only.

3. Create dedicated Settings view component.
Add `settings.ts` and add `#settings-container` in `index.html`. Header is fixed (`Settings` + close `X`), body scrolls. Sections:
- OneDrive section with exactly one action button: `Sign out` when signed-in, `Reconnect...` when signed-out.
- Shared with you section initial state is empty: show only `Add share URL...` in M13 unless shares already exist from future data. Remove buttons are rendered only for existing share rows.
- `Add share URL...` and `Remove...` actions show modals and close on confirm/cancel with no state mutation.
- Timer section with option set: `15m`, `30m`, `45m`, `60m`, `End of track`.
- Indexing section showing live progress (`OneDrive: NN% ⟳ + message`) or idle status (`Last updated ... ✓`), and `Refresh now` button.
- Debug section with one toggle button (`Turn on debug` or `Turn off debug`).
- Style note: the `Settings` header row matches normal tree row height but does not reuse "selected folder" styling.
- Sign out/Reconnect both dismiss Settings by redirecting the top-level frame (same behavior as current auth flows).

4. Wire Settings open/close without mutating tree state.
In `index.ts`, `tree.onSettingsClick` opens settings view by hiding `#tree-container` and showing `#settings-container`. Closing reverses visibility only. Do not change `selectedPath` or tree scroll map while settings is open, so restore is exact.

5. Implement persisted settings values.
Store timer/debug choices in localStorage keys:
- `mm_timer_duration` default `30m`.
- `mm_debug_enabled` default `false`.
Store index status timestamp:
- `mm_index_last_updated` updated after successful staleness check or completed reindex.
- Keep this separate from `MusicData.lastModifiedDateTime` (which is content metadata, not "last successful refresh" time).

6. Implement race-free refresh pipeline (single-flight).
Add pull mutual exclusion in `index.ts`:
- If a pull is in-flight, new refresh requests do not start a second pull.
- Settings `Refresh now` button is hidden while pull is in-flight.
- Manual refresh resets periodic scheduling so completion schedules the next interval once.
- All entry points (startup, periodic timer, online event, settings button) call the same single-flight function.

7. Split spinner responsibilities in code path.
During pull:
- MyMusic spinner (`tree.setSyncing(true)`) wraps account/favorites/staleness work.
- When reindex begins, stop MyMusic spinner and set OneDrive `reindexing=true`.
- On completion/failure, clear OneDrive reindexing and update settings indexing state.

8. Runtime debug toggle behavior.
Debug toggle controls both:
- MyMusic debug glyph visibility.
- SW controllerchange auto-reload behavior, gated by runtime `debugEnabled`.
- M13 cleanup: remove token-corruption debug action from user-facing tree UI. Keep auth test hooks in integration-only paths.

9. Update CSS for settings and hit areas.
Add settings-specific classes in `index.html` with min 44px touch targets, fixed header row height matching tree rows, and scrollable content body. Reuse existing modal styles for share no-op dialogs.

10. Document learnings.
Add M13 entries to `LEARNINGS.md` for single-flight refresh coordination and icon responsibility split (MyMusic settings/warning vs OneDrive indexing spinner).

## Tests and Validation

1. Build and unit tests: `npm run build` and `npm run test:unit`.
2. Integration tests (fast pass first): run `timeout 45 npm test -- "settings"` and inspect `/tmp/mymusic-test.log` before full suite.
3. Integration cases to add/update in `test/integration/tree.test.cjs`:
- Settings icon appears on MyMusic row; OneDrive has no cloud/warning icon.
- Signed-out evidence changes MyMusic icon from `⚙` to `⚠`.
- Open settings and close restores exact previous tree state and scroll.
- Sign-out/reconnect button label changes by evidence state.
- Sign-out/reconnect actions leave Settings by redirecting (or by auth handoff in test stubs).
- Add-share and remove-share modals open and close; confirm is no-op.
- Timer selection persists across reload.
- Debug toggle persists across reload and toggles debug glyph presence.
- Refresh button hidden during in-flight pull and visible after completion.
- Indexing section shows either live progress line or last-updated line.
- Mobile viewport checks for settings controls: minimum 44px hit targets.
4. Full local regression: `npm test`.
5. Deploy and production verification: `npm run deploy`, then run settings-focused Playwright against `MYMUSIC_TEST_URL=https://unto.me/mymusic/` before full production regression.
6. Metrics to capture during validation: refresh duration (click-to-complete), settings open/close responsiveness, and indexing progress update cadence while reindexing.

## Assumptions and Defaults

1. OneDrive row shows no icon in M13; signed-out warning is shown on MyMusic icon only.
2. Timer options are exactly `15/30/45/60/end-of-track`; default is `30m`; playback behavior remains unchanged until M15.
3. Share add/remove confirm actions are strict no-ops in M13 (modal close only, no list mutation/persistence).
4. Debug default is disabled (`false`); user can enable it in Settings and persistence applies on next load.
5. Refresh-now runs the normal pull pipeline (not forced reindex) and is serialized by algorithmic mutual exclusion, not UI alone.

## Validation

1. Build/typecheck:
- `npm run build` passed.

2. Unit tests:
- `npm run test:unit` passed (`69 passed, 0 failed`).

3. Integration fast pass (required timeout/log workflow):
- `timeout 45 npm test -- "settings"` passed (`11 passed, 0 failed`).
- Log checked at `/tmp/mymusic-test.log`.

4. Full local regression:
- `npm test` passed (`57 passed, 0 failed`).

5. Deploy:
- `npm run deploy` passed and uploaded updated `index.html`, `sw.js`, and `dist/` bundles (including new `dist/settings.js`).

6. Production validation:
- `MYMUSIC_TEST_URL=https://unto.me/mymusic/ timeout 45 npm test -- "settings"` passed (`11 passed, 0 failed`).
- `MYMUSIC_TEST_URL=https://unto.me/mymusic/ npm test` passed (`57 passed, 0 failed`).

7. Metrics captured:
- Settings open latency (Playwright probe): local `93ms`, production `76ms`.
- Settings close latency (Playwright probe): local `21ms`, production `28ms`.
- Refresh click-to-complete (integration test duration for `settings: refresh button and indexing status update live`):
  - local `1.7s`
  - production `1.7s`
- Index progress UI update cadence (forced progress updates every 120ms):
  - local intervals: `121.9ms`, `121.6ms`, `121.8ms`, `121.4ms`
  - production intervals: `130.3ms`, `121.7ms`, `121.5ms`, `121.5ms`

8. Screenshots captured:
- local settings page: `/tmp/m13-settings-local.png`
- production settings page: `/tmp/m13-settings-prod.png`

## Review

1. LEARNINGS cleanup:
- Removed duplicated/stale validation workflow bullets that were restating project-agent instructions.

2. Goal validation:
- Verified M13 "Shared with you" default state now matches the plan: no synthetic share rows are rendered when there are no real shares; only `Add share URL...` is shown.
- Verified share add/remove confirm actions remain strict no-ops.

3. Code review + cleanup:
- Fixed a spec mismatch in `settings.ts`: removed the placeholder "Example Share" row so remove actions only appear for real share rows.
- Added a regression integration test `settings: shared section defaults to add-only` to lock the intended empty-state behavior.

4. KISS/refactor pass:
- Simplified share-row rendering by iterating `initial.shareRows ?? []` directly instead of constructing a placeholder array.
