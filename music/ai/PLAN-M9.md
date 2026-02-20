# Milestone 9: Playback Modes — Implementation Plan

## Context

M1-M8 established: dev infrastructure, OneDrive auth, indexing, tree view, basic playback, expanded scrubber controls, favorites data model, and select mode. Playback currently works only with physical OneDrive paths (walks accounts by driveId). There are no playback modes — tracks auto-advance linearly and stop at end of folder. The `hasPrivatePlayback` field on favorites is data-only with no behavior.

M9 transforms playback to understand logical paths through favorites (shortcuts/playlists), adds four playback modes, and wires per-favorite "remember my spot" to actually persist and restore playback state.

## Design Decisions (from user clarification)

- **Mode storage**: Per-favorite `mode` is a new field on Shortcut/Playlist in FavoritesData (uploaded to OneDrive with favorites). Per-favorite `currentTrack` and `currentTime` are IndexedDB-only.
- **Four modes** (timer deferred): `one`, `all`, `repeat`, `shuffle`. Timer mode is deferred — it requires interrupting in-progress tracks and a user-configurable timeout setting.
- **Default mode**: `'all'` (current behavior — play sequentially, stop at end).
- **"one" mode**: Play current track, stop when it ends. No auto-advance. Prev/next buttons still work manually.
- **Restore behavior**: Auto-play from saved position when clicking play on a favorite with "remember my spot".
- **No new module**: All changes go into `playback.ts` (and its callers). KISS.

## Files Modified

| File | Summary |
|------|---------|
| `playback.ts` | Logical resolution, mode state, mode-aware ended/prev/next, per-favorite save/load, mode UI label |
| `favorites.ts` | Add `mode?: PlaybackMode` field to Shortcut & Playlist types; `setMode()` method; normalize on load with whitelist validation |
| `index.ts` | Update playTrack/playFolder callsites to pass favorites+roots |
| `index.html` | CSS for `.mode-label` button |
| `test/integration/tree.test.cjs` | Tests for modes, per-favorite state, logical playback |

## Phase 1: Logical Path Resolution

**Problem**: `resolveTrack`, `resolveFolderFromPath`, and `collectTracks` only handle physical paths like `["MyMusic", driveId, ...]`. Logical paths like `["MyMusic", "fav:uuid", "m:0", "subfolder", "track.mp3"]` can't be resolved.

### 1a. `resolveLogicalTrack(path, accounts, favoritesRef, roots) → MusicFile | undefined`

Resolves any path (physical or through favorites) to a MusicFile:
- If `path[1]` doesn't start with `"fav:"` → delegate to existing `resolveTrack` (physical)
- Shortcut (`"fav:<id>"`): look up shortcut, resolve `target` folder from accounts via `walkFolder(root.folder, target.path)`, then walk `path.slice(2)` within that folder
- Playlist (`"fav:<id>"`, `path[2]` = `"m:N"`): validate format strictly (`/^m:\d+$/`, in range). Resolve member N. If ItemRef file with no further subpath: return it. If ItemRef file with extra subpath: treat as broken. If ItemRef folder: walk `member.path + path.slice(3)` in accounts. If FavRef: recurse with visited set for cycle detection.
- All broken refs (deleted drive/item/favorite) return undefined with log, never fail the whole traversal.

### 1b. `collectLogicalTracks(basePath, accounts, favoritesRef, roots) → FolderPath[]`

Collects all track paths under any logical folder, in sorted display order:
- Physical path: resolve folder via `resolveFolderFromPath`, then call existing `collectTracks` (which walks MusicFolder children in sorted order)
- Shortcut: resolve target folder, call `collectTracks` but with the **logical** basePath (not physical) so returned paths are logical
- Playlist at root (`["MyMusic", "fav:id"]`): iterate members via `resolveChildren`, for each `"m:N"` recursively call `collectLogicalTracks(["MyMusic", "fav:id", "m:N"], ...)`. Uses visited set for FavRef cycle detection. Broken members are skipped with log (don't abort the whole collection).
- Playlist subpath: resolve member, walk deeper, collect tracks
- Duplicates: intentionally allowed. The same physical file can appear via different logical paths (e.g. in two different playlist members). Each gets its own logical path.

**Critical invariant**: trackList stores **logical paths**. This ensures chevron-click navigates correctly through the tree. Physical resolution happens at play time via `resolveLogicalTrack`. All "in-folder" checks (`pathEquals`, `pathStartsWith`) continue to work because they compare logical paths.

### 1c. Update `playTrack` and `playFolder` signatures

Rather than adding two more params to every call, use a context setter pattern:

```typescript
/** Sets the favorites/roots context for logical path resolution.
 *  Called once after favorites are initialized, and on onChange. */
setContext(favorites: FavoritesRef, roots: RootsMap): void;
```

`playTrack` and `playFolder` keep their existing `(path, accounts)` signatures. The favorites/roots context is stored as module state (`favoritesRef`, `rootsRef`) and updated via `setContext`. This avoids threading two extra params through every call site.

### 1d. Update `index.ts` wiring

```typescript
// After favorites are initialized:
playback.setContext(favorites, tree.getRoots());
// In favorites onChange callback, update context:
playback.setContext(favorites, tree.getRoots());
```

### 1e. Performance logging

```typescript
const t0 = performance.now();
trackList = collectLogicalTracks(path, ...);
log(`collectLogicalTracks: ${trackList.length} tracks in ${Math.round(performance.now() - t0)}ms`);
```

## Phase 2: Playback Modes

### 2a. Type and state

```typescript
export type PlaybackMode = 'one' | 'all' | 'repeat' | 'shuffle';
const MODES: readonly PlaybackMode[] = ['one', 'all', 'repeat', 'shuffle'];
const isValidMode = (s: unknown): s is PlaybackMode =>
    typeof s === 'string' && MODES.includes(s as PlaybackMode);
let playbackMode: PlaybackMode = 'all';
```

`PlaybackMode` is exported from `playback.ts` and imported by `favorites.ts`. This avoids a shared types file (KISS) — playback owns the type definition since it's a playback concept.

### 2b. Mode-aware `ended` handler

```
switch (playbackMode):
  'one'     → stop (log, do nothing). Save state if private playback.
  'all'     → advance linearly, stop at end (current behavior)
  'repeat'  → advance linearly, wrap to 0 at end
  'shuffle' → pick random index (avoid same track if length > 1)
```

### 2c. Mode-aware prev/next buttons

- **prev**: In repeat mode, wrap to end. In shuffle, go to idx-1 (linear prev — documented choice; no shuffle history stack for KISS). Otherwise, go to idx-1 (no-op if at 0).
- **next**: In shuffle, pick random. In repeat, wrap. Otherwise advance or no-op at end.

## Phase 3: Mode UI

### 3a. Mode label button

Create a `<button class="mode-label">` in the expansion-inner area, positioned absolutely at top-left (matching the design: "indicator at the top left which shows the current shuffle mode").

Text content: the current mode name (`'one'`, `'all'`, `'repeat'`, `'shuffle'`).

### 3b. CSS (in `index.html`)

```css
.mode-label {
    position: absolute;
    top: 0; left: 0;
    appearance: none; border: none; background: none;
    color: #888; font-size: 14px;
    padding: 8px 12px;
    cursor: pointer;
    min-width: 44px; min-height: 44px;
    display: flex; align-items: center; justify-content: center;
}
```

### 3c. Tap handler

Cycles through MODES array. Updates mode label text. Calls `savePlaybackModeIfNeeded()` to persist mode for private-playback favorites.

### 3d. Mode label update on setExpanded

When expanding, sync `modeLabel.textContent = playbackMode` to show current state.

## Phase 4: Per-Favorite Playback State

### 4a. Detecting active favorite

New module state:
```typescript
let activeFavId: string | undefined;
let activeFavHasPrivatePlayback = false;
```

On `playFolder`/`playTrack`: if `path[1]` starts with `"fav:"`, extract favId, look up favorite, set `activeFavId` and `activeFavHasPrivatePlayback`. If changing from a different favorite, save outgoing state first.

### 4b. Data model change: add `mode` to Shortcut/Playlist

In `favorites.ts`, add optional `mode?: PlaybackMode` field to both `Shortcut` and `Playlist` interfaces. This field is persisted in FavoritesData and uploaded to OneDrive.

The `normalize` function validates mode values with a whitelist: if `mode` is not one of the valid strings, set it to `undefined` (meaning "use global default"). This handles corrupt/future data gracefully.

New method on Favorites: `setMode(id: string, mode: PlaybackMode): Promise<void>` — no-op if value unchanged. Sets the mode field, persists, calls onChange.

### 4c. Local playback state (IndexedDB only)

```typescript
interface PerFavoritePlaybackState {
    readonly trackPath: readonly string[];
    readonly currentTime: number;
}
```

IndexedDB key: `"playback:<favId>"`. Not uploaded. Stale keys (from deleted favorites) are tolerated — they're inert and will be overwritten if a new favorite reuses the same UUID (which won't happen in practice).

### 4d. Save triggers

- `timeupdate`: throttled to ~10s intervals (compare `Math.floor(currentTime / 10)` to last saved bucket)
- `pause` event
- Track change (in `playNext` — save outgoing state before switching)
- Mode change (save mode via `favorites.setMode()`, save track/time via `dbPut`)
- Before switching favorites (in `playFolder`/`playTrack` when `activeFavId` changes)

The `dbPut` calls use `.catch(logCatch(...))` — fire-and-forget with internal error handling per project conventions (the function name `savePlaybackStateFireAndForget` makes the contract explicit).

### 4e. Load on favorite play

When `playFolder` is called with a favorite path and `hasPrivatePlayback` is true:
1. Load saved mode from the Favorite object (via `favoritesRef.getAll().find(...)`)
2. If mode exists and is valid, set `playbackMode` to it; update mode label immediately
3. Load saved track/time from IndexedDB (`dbGet('playback:' + favId)`)
4. If saved trackPath is found in the new trackList, play from that track at savedTime
5. Otherwise, play from beginning (with the saved mode)
6. If saved currentTime is invalid (NaN, negative, > duration), clamp or ignore

When `playTrack` is called within a favorite: user explicitly chose a track, so restore mode but NOT track/time position.

### 4f. Global mode behavior

When playing outside a favorite (physical path, or favorite without `hasPrivatePlayback`), the global `playbackMode` is used. When switching from a private-playback favorite to a non-favorite folder, `playbackMode` reverts to the global default (`'all'`). When switching from non-favorite to a private-playback favorite, the global mode is overridden by the favorite's saved mode.

## Phase 5: Chevron Click (No Changes Needed)

Since trackList stores logical paths, `info.track.slice(0, -1)` already gives the correct logical parent path. `tree.setSelectedPath(logicalParent)` will navigate through favorites correctly. This is a free benefit of the "trackList stores logical paths" design.

## Phase 6: Invariants Update

Update `playback.ts` module docstring to document:
- trackList stores logical paths (may be physical or through favorites)
- `resolveLogicalTrack` handles physical → MusicFile resolution at play time
- Mode state: global default is `'all'`, overridden by per-favorite mode when active
- Per-favorite state: activeFavId tracks which favorite is currently the playback context; state saved on mutation, restored on favorite play

## Phase 7: Testing & Validation

### Integration tests to add

- `mode: cycle through modes` — tap mode label, verify text cycles one→all→repeat→shuffle→one
- `mode: all stops at end` — play last track in folder, verify no advance after ended
- `mode: repeat wraps` — play last track, verify it wraps to first
- `mode: one stops after track` — play a track, verify no auto-advance
- `mode: shuffle advances` — verify next track is played after ended in shuffle mode
- `mode: per-favorite restore` — set mode on a favorite with hasPrivatePlayback, play, switch away, come back, verify mode restored
- `logical: play track in shortcut` — click a track inside an expanded shortcut, verify it plays
- `logical: play folder in shortcut` — click play on a folder inside a shortcut, verify trackList built correctly
- `logical: chevron navigates to logical path` — play a track in a shortcut, click chevron, verify tree shows the track inside the shortcut (not the raw OneDrive path)

### Manual/Playwright validation

- Play, pause, resume across all 4 modes
- Auto-advance behavior per mode
- Scrub through audiobook chapter with ~2s precision (existing M6 test)
- Per-favorite state: play audiobook A, pause at some point, play audiobook B, return to A → resumes at saved position
- Footer correct on mobile viewport
- Mode label visible and tappable on mobile (44px minimum)
- Updated dev-counter then deploy to production, verify all modes work

### Performance measurement

- Log `collectLogicalTracks` timing for large playlists
- Verify no UI blocking during track enumeration

## Codex Review Summary

Codex approved the plan with these changes, all incorporated above:
1. Strict validation of `m:N` segment format and member-type mismatches
2. Broken refs skipped with logs, never fail whole traversal
3. Duplicates intentionally supported (same file via different logical paths)
4. Context setter pattern instead of extra params on every call
5. Save outgoing state before switching favorites
6. `setMode()` no-ops on unchanged value
7. Mode validation whitelist in `normalize()`
8. Shuffle prev is linear (documented, KISS — no history stack)
9. Global mode reverts to default when leaving private-playback favorite

## Deferred

- **Timer mode**: Deferred to a future milestone. Requires interrupting in-progress tracks when time expires, and a user-configurable timeout setting (not just hardcoded 30min).
