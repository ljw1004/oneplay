# PLAN-M10: State Persistence & Memory

## Context

When the user closes and reopens the app (or when an OAuth redirect restarts the page), all transient state is lost: which folder was open, what track was playing, scroll position, scrubber expansion. M10 makes the app restore to the exact same state as when the user left — same folder, same scroll position, same track at the same time, paused. This is critical because OAuth redirects count as restarts and happen frequently.

## Key Decisions

1. **localStorage, not IndexedDB** — localStorage is synchronous, readable before first render with no flash of wrong content. IndexedDB remains pure as a cache of OneDrive data.
2. **Multiple localStorage keys** — The periodic currentTime save (every 5s) should not re-serialize unchanging data. Separate keys for separate write frequencies.
3. **Per-favorite mode stays on Favorite object** — `savePlaybackModeFireAndForget()` continues to write mode to IndexedDB+OneDrive eagerly. No change here.
4. **Per-favorite trackPath/currentTime migrate from IndexedDB to localStorage** — Lazy migration: on first access, check localStorage first, fall back to IndexedDB, migrate on read.
5. **App always starts paused** — Visual state (footer, track title, mode label) is restored, but audio element has no `src`. Tapping play triggers URL fetch and resumes from saved `currentTime`.
6. **Expanded controls state is restored.**
7. **State persists indefinitely until sign-out.** No TTL or expiry.

## localStorage Key Schema

| Key | Shape | Written when |
|-----|-------|-------------|
| `mm_view` | `{path: string[], expanded: boolean}` | Navigation, expand/collapse |
| `mm_scroll` | `Record<string, number>` (pathKey → scrollTop) | Scroll events (throttled via rAF) |
| `mm_playback` | `{folder: string[], track: string[], mode: PlaybackMode, favId?: string}` | Track change, folder change, mode change |
| `mm_time` | `number` | Every 5s via timeupdate, on pause, on track change |
| `mm_fav:{favId}` | `{track: string[], time: number}` | Per-favorite state save (on favorite exit, periodic, pause) |

## Restore Flow

Restore happens at the start of `onBodyLoad()`, before first render:

```
1. Read mm_view, mm_scroll, mm_playback, mm_time from localStorage  (synchronous)
2. Pass initialPath + initialScrollMap to createTree()               (tree starts at right folder)
3. showTree() from cached IndexedDB data                             (existing flow)
4. initFavorites()                                                    (existing flow)
5. playback.restoreVisualState(folder, track, mode, expanded, time)  (NEW — footer visible, paused)
6. pullMusicFolderFromOneDrive()                                      (existing background sync)
```

When the user taps play on the restored state, `playNext()` fires with `startTime` to seek to the saved position.

## File Changes

### `tree.ts`

- **Accept initial state in `createTree()`**: New optional params `initialPath?: FolderPath` and `initialScrollMap?: Record<string, number>`. `selectedPath` initializes from `initialPath` (validated, falls back to `['MyMusic']`).

- **Scroll position tracking**: Add a `scrollMap: Map<string, number>` populated from `initialScrollMap`. Listen for `scroll` events on `childrenEl`, throttled via `requestAnimationFrame`. On scroll, save `childrenEl.scrollTop` keyed by `JSON.stringify(selectedPath)` to the map and to `mm_scroll` in localStorage. Cap map at 100 entries.

- **Scroll restoration after render()**: Track `previousPath`. After `replaceChildren()`:
  - If navigated up (new path is prefix of or equal-length to old path): restore saved `scrollTop` from map.
  - If navigated down or jumped: `scrollTop = 0`.
  - On initial load from restored state: restore saved scroll.

- **`onPathChange` callback**: New callback on `TreeView`, called every time `selectedPath` changes (folder click, breadcrumb click, `setSelectedPath()`). Wired by `index.ts` to save `mm_view`.

### `playback.ts`

- **`restoreVisualState()` method** on `Playback` interface:
  - Sets `playbackFolder`, `playbackTrack`, `playbackMode`, `activeFavId`, `activeFavHasPrivatePlayback`.
  - Calls `refreshTrackList()` to build track list. If restored track not found, clears state and returns.
  - Updates footer DOM (title, indicators). Sets `phase = 'loaded'`.
  - Calls `onPlaybackChange()` so tree shows track indicator.
  - Sets expanded state via `setExpanded()`.
  - Stores `restoredCurrentTime` for use when play is first tapped.
  - Does NOT touch the audio element.

- **Play button "cold start" handling**: In the `playpauseBtn` click handler, if `audioEl` has no src but we have a restored track, call `playNext(playbackTrack, currentTrackIdx, true, restoredCurrentTime)`. Clear `restoredCurrentTime` after first use.

- **Replace per-favorite save to use localStorage**: `savePlaybackStateFireAndForget()` changes from `dbPut('playback:{favId}', ...)` to `localStorage.setItem('mm_fav:{favId}', ...)`. Also saves `mm_playback` and `mm_time` for the global context.

- **Broaden periodic save to all contexts**: The `timeupdate` throttle currently only fires for `activeFavHasPrivatePlayback`. Remove that gate — save `mm_time` every 5s for all playback (global and per-favorite). Per-favorite state (`mm_fav:{favId}`) is also saved on the same trigger when in a private-playback favorite.

- **Save mm_playback on state changes**: In `playTrack()`, `playFolder()`, and the mode label click handler, call a save function that writes `mm_playback`.

- **Migration in `playFolder()` restore logic**: Check `localStorage.getItem('mm_fav:{favId}')` first (synchronous). If not found, fall back to `dbGet('playback:{favId}')` (async, existing code). If found in IndexedDB, write to localStorage for migration.

- **`onExpandedChange` callback**: Called inside `setExpanded()`. Wired by `index.ts` to save `mm_view`.

### `index.ts`

- **Read localStorage state early in `onBodyLoad()`** — synchronous reads of `mm_view`, `mm_scroll`, `mm_playback`, `mm_time`. Add a small helper `readJson<T>(key): T | undefined`.

- **Pass initial state to `createTree()`**: `createTree(treeEl, restoredView?.path, restoredScroll)`.

- **Wire new callbacks**: `tree.onPathChange` saves `mm_view`. `playback.onExpandedChange` saves `mm_view`.

- **Restore playback after initFavorites()**: If `restoredPlayback` exists and account data is available, call `playback.restoreVisualState(...)`.

- **Clear M10 state on sign-out**: Remove all `mm_*` keys from localStorage.

### `favorites.ts`

No changes. Per-favorite `mode` continues to be saved eagerly via `savePlaybackModeFireAndForget()` → `favorites.setMode()` → IndexedDB+OneDrive. No change to this flow.

### `db.ts`

No changes. Old `playback:{favId}` keys in IndexedDB become dead weight, cleaned up naturally on sign-out via `dbClear()`.

## Edge Cases

- **Restored path invalid** (folder renamed/deleted): `resolveFolder()` in tree.ts already resets to deepest valid prefix. No special handling needed.
- **Restored track not in track list**: `restoreVisualState()` checks `currentTrackIdx`. If < 0, clears playback state — app starts as if nothing was playing.
- **OAuth redirect**: localStorage survives redirect. `onBodyLoad()` restores state on return. This is the primary use case.
- **Sign-out**: All `mm_*` keys explicitly removed.
- **Scroll map overflow**: Capped at 100 entries. Oldest entries trimmed on save.

## Validation

1. Build and test locally (`npm run build && npm test`)
2. Navigate to a deep folder, scroll down, play a track, expand scrubber. Reload page. Verify: same folder, same scroll position, same track title in footer, paused, scrubber expanded. Tap play → resumes from saved position.
3. Switch between two "remember my spot" audiobook favorites. Verify each resumes at correct position.
4. Sign out → sign in. Verify all M10 state is cleared.
5. Deploy to production and verify on mobile (OAuth redirect restores state).

## Human Validation (on iPhone, production)

A temporary "↻ reload" button is in the top-left corner to simulate page reload in the home-screen SPA.

1. **Folder restoration**: Navigate deep into a folder (e.g. Favorites → an album). Tap ↻ reload. Verify the same folder opens with the same breadcrumb path.
2. **Scroll restoration**: In a long folder, scroll down partway. Navigate away to a different folder, then come back (via breadcrumbs). Verify scroll position is restored to where you left off.
3. **Playback restoration**: Play a track, let it play a few seconds. Tap ↻ reload. Verify the footer shows the correct track name and mode, in a paused state. Tap play — verify it resumes from approximately where you left off (within ~5s).
4. **Expanded scrubber**: Expand the scrubber (swipe up on footer). Tap ↻ reload. Verify the scrubber comes back expanded.
5. **Per-favorite audiobook state**: Play a track in one "remember my spot" favorite. Switch to a different favorite, play there. Switch back to the first. Verify it resumes at the saved position.
6. **OAuth redirect survival**: Wait for the auth token to expire (or force it by clearing the token). Let the OAuth redirect happen and complete sign-in. Verify state (folder, track, scroll) survives the round trip.
7. **Sign-out clearing**: Sign out. Verify the app returns to the sign-in screen. Sign back in. Verify no stale M10 state remains (starts fresh, no footer, default folder).
