# PLAN-M11: Offline Audio Downloads

## Context

This M11 plan implements a design described in ai/DESIGN.md lines 204 to 295.

M11 adds offline audio download capability. Users mark favorites for offline availability via a popup menu → modal flow. Tracks are downloaded in the background into IndexedDB and played from cache when available. This makes the app usable without connectivity for favorited content. Additionally, a ⟳ spinner on the MyMusic row signals background sync operations.
- Download ↓ icon (and animation) for favorites
- Menu options in favorites popup
- "Available offline" modal triggered by popup
- Pinning, global queue, pausing+resuming, concurrent downloads
- Global quota and management
- Audio plays from offline IndexDB if available
- Quota management
- Separately, as part of the "network traffic indicator" spirit of this milestone, also have a spinner on MyMusic when pulling index/favorites, or pushing favorites

Validate: Mark a favorite for offline. Downloads complete. Music plays with no connectivity. Incomplete downloads restart when connectivity returns.

## HOW TO EXECUTE ON A PLAN

1. Implement the plan
   - Use teams/swarms. Even if it's not parallelizable, still use a team.
   - Each subagent can be told about the milestone's plan file to guide their work, if appropriate.
   - You should check your implementation with AI autonomous validation and testing.
   - The hope is that implementation can be done with a minimum of human interaction, preferably none at all.
   - Once it is complete, add a "Validation" section to the bottom of the plan showing how you have validated it and what were the results.
2. Ask Codex subagent for review of your implementation.
   - You will need to provide it contect: your plan document PLAN-Mn.md, and tell it which files or functions you've worked on. Ask it also to review your validation steps.
   - Again, codex is my trusted senior engineer, and I want you to get Codex signoff.
3. After implementation, do a "review" phase
   - Clean up LEARNINGS.md. If any information there is just restating information from other files (AGENTS.md, SANDBOX.md) then delete it. If it would belong better elsewhere, move it.
   - Ask your own subagent and also Codex subagent to validate whether the changes have satisfied their goals
   - Ask your own subagent and also Codex subagent for code review
   - Ask your own subagent and also Codex subagent if there is KISS, or consolidation, or refactoring that would improve quality of codebase
   - Tell the user how you have done code cleanup. The user is passionate about clean code and will be delighted to hear how you have improved it.
4. Upon completion, ask for human review. Tell the user what to test, what commands to use, what gestures to try out, what to look for


## Files to modify/create

| File | Action | Summary |
|------|--------|---------|
| `db.ts` | modify | Version 2, add 'audio' store, wipe-on-mismatch |
| `favorites.ts` | modify | Add `offlinePin` field, `setOfflinePin()` method |
| `tracks.ts` | **create** | Shared track traversal: logical and physical resolution |
| `downloads.ts` | **create** | Pure download engine: queue, evidence state machine, storage. No favorites/UI knowledge. |
| `playback.ts` | modify | Use shared tracks.ts; check offline cache before streaming |
| `tree.ts` | modify | ↓ badge via `setOfflineIcons()`; ⟳ spinner. No downloads import. |
| `select.ts` | modify | Offline menu items + "Available Offline" modal (moved from downloads) |
| `index.ts` | modify | Orchestrator: `computeAndPushOfflineState()`, evidence transitions, wiring |
| `index.html` | modify | CSS for badge, spinner, modal extensions |

## 1. db.ts — Version bump and audio store

Bump IDB version from 1 to 2. On `onupgradeneeded`, if `event.oldVersion > 0` delete all existing stores, then create both `'data'` and `'audio'`. This is the "wipe on version mismatch" strategy — safe because all cached data rebuilds from OneDrive.

New exports for the audio store (same open/close-per-call pattern as existing `dbPut`/`dbGet`):

```typescript
audioPut(key: string, blob: Blob): Promise<void>
audioGet(key: string): Promise<Blob | undefined>
audioDelete(key: string): Promise<void>
audioKeys(): Promise<string[]>          // all keys in audio store
audioTotalBytes(): Promise<number>      // sum of blob sizes (cursor walk)
```

Audio key format: `"driveId:itemId"`.

## 2. favorites.ts — offlinePin field

Add to both `Shortcut` and `Playlist`:
```typescript
readonly offlinePin?: { readonly paused: boolean };
```

`offlinePin === undefined` = not offline. `offlinePin.paused` = user-paused downloads.

New method on `Favorites` interface:
```typescript
setOfflinePin(id: string, pin: { paused: boolean } | undefined): Promise<void>;
```

Implementation follows `setHasPrivatePlayback` pattern: map → mutate → `saveLocal()` → `scheduleOneDriveUploadFireAndForget()` → `onChange()`.

Update `normalize()` to preserve `offlinePin` when present.

## 3. tracks.ts — Shared track traversal (new file)

Extract track collection and resolution from `playback.ts` into a shared module. Both `playback.ts` and `downloads.ts` import from it.

### Functions to extract from playback.ts:

```typescript
/** Collects all file paths under a physical MusicFolder, in sorted display order. */
export function collectTracks(basePath: FolderPath, folder: MusicFolder): FolderPath[]

/** Collects all file paths under a logical path (through favorites). */
export function collectLogicalTracks(
    basePath: FolderPath, accounts: AccountsMap, favorites: Favorites, roots: RootsMap,
    visited?: Set<string>,
): FolderPath[]

/** Resolves a physical track path to its MusicFile. */
export function resolveTrack(path: FolderPath, accounts: AccountsMap): MusicFile | undefined

/** Resolves any path (physical or through favorites) to a MusicFile. */
export function resolveLogicalTrack(
    path: FolderPath, accounts: AccountsMap, favorites: Favorites, roots: RootsMap,
    visited?: Set<string>,
): MusicFile | undefined

/** Resolves a physical folder path to its MusicFolder. */
export function resolveFolderFromPath(path: FolderPath, accounts: AccountsMap): MusicFolder | undefined
```

### New function for downloads.ts:

```typescript
/** Resolves all physical tracks {driveId, itemId} for a favorite.
 *  Walks shortcuts, playlists, nested favorites with cycle detection.
 *  Returns deduped by driveId:itemId (a track shared between favorites is one download). */
export function collectPhysicalTracks(
    favId: string, favorites: Favorites, roots: RootsMap, accounts: AccountsMap,
    visited?: Set<string>,
): Array<{ driveId: string; itemId: string }>
```

This walks the same structure as `collectLogicalTracks` but instead of building path arrays, it:
- For shortcuts: walks the target MusicFolder tree, collecting `{ driveId: fav.target.driveId, itemId: file.id }` for each MusicFile.
- For playlists with ItemRef members: resolves the member folder and collects files.
- For playlists with FavRef members: recurses into the referenced favorite (with cycle detection via visited set).

Also useful: a helper to resolve a track path to `{ driveId, itemId }` for the playback offline-cache lookup:
```typescript
/** Resolves any track path to its physical {driveId, itemId}. */
export function resolveTrackIds(
    path: FolderPath, accounts: AccountsMap, favorites: Favorites, roots: RootsMap,
): { driveId: string; itemId: string } | undefined
```

### Types to export:

```typescript
export type AccountsMap = Map<string, { folder: MusicFolder }>;
```

(Currently defined in playback.ts as a private type — move to tracks.ts and re-export.)

## 4. downloads.ts — Pure download engine (new file)

Downloads is a pure engine with **no knowledge of favorites, tracks, or UI**. The caller
(index.ts) computes which track keys are pinned and pushes them in via `setPinnedKeys()`.
This module handles the queue, concurrent download workers, error classification, storage,
and quota management.

### 4.1 Evidence state machine

```typescript
type EvidenceState = 'no-evidence' | 'evidence:signed-in' | 'evidence:signed-out';
```

Factory-scoped: `let evidence: EvidenceState = 'no-evidence';`

`transitionEvidence(newState)`:
- To `evidence:signed-in` while dirty → recalculate queue + start downloads.
- To `evidence:signed-in` while not dirty → clear latched error, resume pump.
- To `no-evidence` → downloads pause (workers don't start new fetches).
- To `evidence:signed-out` → abort all in-flight downloads.

### 4.2 Input model: two key sets

The engine receives two sets from the caller via `setPinnedKeys(activeKeys, retainKeys)`:

- **activeKeys**: tracks from unpaused offline favorites → determines download queue.
- **retainKeys**: tracks from ALL offline favorites including paused → determines GC retention
  (superset of activeKeys).
- **INVARIANT**: `activeKeys ⊆ retainKeys`. Enforced: if a key is in activeKeys but not
  retainKeys, it's added to retainKeys.

`setPinnedKeys` is **idempotent**: if both sets are unchanged (shallow set equality), it
no-ops. This prevents a feedback loop where `onStateChange → computeAndPushOfflineState →
setPinnedKeys → recalculate → onStateChange`.

Incoming sets are **defensively copied** so callers cannot silently mutate internal state.

### 4.3 Queue recalculation

`recalculate()` returns `void` (not `Promise<void>`) — wraps its async body in an IIFE that
handles all errors internally, enforcing fire-and-forget at the type level. Callers cannot
accidentally `await` it.

Single-flight: if already running, sets dirty and returns. The running call loops if dirty was
re-set during execution (same pattern as the favorites upload pump).

Steps:
1. Get existing downloaded keys via `audioKeys()`.
2. Queue = `activeKeys − downloaded`.
3. Garbage collect: `downloaded − retainKeys → audioDelete()`. **GC safety**: skipped when
   `retainKeys` is empty (guards against incomplete index state wiping all audio).
4. Recalculate `totalBytes` from scratch via `audioTotalBytes()` (accurate baseline).
5. Check quota: `totalBytes > quotaBytes` → set `overQuota`.
6. Start pump, notify UI.

On entering recalculate: abort previous in-flight downloads, bump generation counter, and
reset `activeDownloads = 0` (orphaned workers skip their decrement in the finally block,
so the counter must be reset explicitly).

### 4.4 Concurrent download workers

Max 2 concurrent. Simple pump pattern:

```typescript
function pumpDownloads(): void {
    while (activeDownloads < MAX_CONCURRENT && queue.length > 0
        && evidence === 'evidence:signed-in' && !overQuota) {
        const item = queue.shift()!;
        activeDownloads++;
        downloadOneTrack(item);
    }
}
```

`downloadOneTrack(item)` also returns `void` via IIFE. Steps:
1. Fetch download URL via Graph API (`authFetch` for
   `/drives/{driveId}/items/{itemId}?$select=@microsoft.graph.downloadUrl`).
   Uses `/drives/{driveId}` (not `/me/drive`) for multi-drive correctness.
2. `fetcher()` the download URL (plain fetch, no auth — SAS-token URL).
3. `audioPut(key, blob)`, update `downloadedKeys` and `totalBytes` incrementally.
4. Error classification (see §4.6).
5. `finally`: if generation matches, decrement `activeDownloads`, check quota, pump, notify.
   If generation has advanced, this task is orphaned — skip all state mutations.

**Abort safety**: monotonic generation counter, captured at task start, checked before every
state mutation and in the finally block. `AbortController` signal checked after each `await`.

### 4.5 Storage and quota

```typescript
let quotaBytes: number;  // loaded via deps.loadQuotaBytes(), default 2 GB
const QUOTA_OPTIONS_GB = [1, 2, 5, 10];
```

`setQuota(gb)`: update `quotaBytes`, persist via `deps.saveQuotaBytes()`, mark dirty, recalculate if signed in.

### 4.6 Error classification

```typescript
function classifyHttpError(status, item): void
```

- **Push to back of queue** (transient, retry): 429, 500, 502, 503
- **Transition to `no-evidence`** (connectivity): 408, 504
- **Transition to `evidence:signed-out`**: 401
- **Remove from queue** (default): 404 and all other status codes

Exception classification in catch block:
- timeout/abort messages → transition to `no-evidence`
- fetch/network/Failed to fetch messages → push to back of queue (transient)
- Other → set `lastError`, log error

`notifyUI()` is wrapped in try/catch so caller errors cannot break the engine.

### 4.7 Atomic snapshot API

```typescript
export interface DownloadSnapshot {
    readonly downloadedKeys: ReadonlySet<string>;
    readonly queuedKeys: ReadonlySet<string>;
    readonly overQuota: boolean;
    readonly lastError: string | undefined;
    readonly evidence: EvidenceState;
    readonly quotaBytes: number;
    readonly totalBytes: number;
}
```

`getSnapshot()` returns a **defensively copied** set for `downloadedKeys` so callers observe
a true snapshot, not a live reference to internal state.

`totalBytes` is tracked incrementally: added on successful download, subtracted on GC delete,
reset from `audioTotalBytes()` during recalculation.

### 4.8 Public API

```typescript
export interface Downloads {
    setPinnedKeys(activeKeys: ReadonlySet<string>, retainKeys: ReadonlySet<string>): void;
    transitionEvidence(state: EvidenceState): void;
    getOfflineBlob(driveId: string, itemId: string): Promise<Blob | undefined>;
    getSnapshot(): DownloadSnapshot;
    setQuota(gb: number): void;
    clear(): Promise<void>;
    onStateChange: () => void;
}

export interface DownloadsDeps {
    authFetch: (url: string, retryOn429: boolean) => Promise<Response>;
    fetcher: (url: string) => Promise<Response>;
    audioPut, audioGet, audioDelete, audioKeys, audioTotalBytes, audioClear;
    loadQuotaBytes(): number;
    saveQuotaBytes(bytes: number): void;
}
```

Note what is **absent** from the API: `setContext`, `markDirty`, `getFavOfflineIcon`,
`showOfflineModal`, and any reference to favorites, tracks, or roots. All of those
concerns live in the caller (index.ts) or the UI layer (select.ts).

## 5. playback.ts — Offline cache integration

### 5.1 Import from tracks.ts

Replace the local `collectTracks`, `collectLogicalTracks`, `resolveTrack`, `resolveLogicalTrack`, `resolveFolderFromPath` functions with imports from `tracks.ts`. Also import `resolveTrackIds`.

### 5.2 Check offline cache before streaming

In `playNext()`, after resolving the MusicFile:

```typescript
const ids = resolveTrackIds(path, accountsRef, favoritesRef, rootsRef);
const offlineBlob = ids ? await downloadsRef?.getOfflineBlob(ids.driveId, ids.itemId) : undefined;
if (counter !== asyncCounter) return;  // stale check

if (offlineBlob) {
    const blobUrl = URL.createObjectURL(offlineBlob);
    log(`playing from offline cache: ${path[path.length - 1]}`);
    audioEl.src = blobUrl;
} else {
    // existing streaming URL fetch
}
```

Track previous blob URL; revoke in the reset sequence at the top of `playNext()`:
```typescript
if (currentBlobUrl) { URL.revokeObjectURL(currentBlobUrl); currentBlobUrl = undefined; }
```

### 5.3 New interface method

```typescript
setDownloads(downloads: Downloads): void;
```

Stores `downloadsRef` module-scoped.

## 6. tree.ts — ↓ badge and ⟳ spinner

### 6.1 ↓ badge on favorites

Tree has **no knowledge of downloads**. It receives icon states as data via
`setOfflineIcons(icons)`, where `icons` is a `Map<string, 'complete' | 'downloading' | 'paused'>`.
Absent from map = no icon.

In `makeRow()`, for top-level favorite rows, look up `offlineIcons.get(favId)`:
```typescript
const iconState = offlineIcons.get(favId);
if (iconState) {
    const badge = document.createElement('span');
    badge.className = 'offline-badge' + (iconState === 'downloading' ? ' downloading' : '') + (iconState === 'paused' ? ' paused' : '');
    badge.textContent = iconState === 'paused' ? '\u2002\u2193\u23F8' : '\u2002\u2193';
    row.appendChild(badge);
}
```

`setOfflineIcons` does NOT trigger re-render — the caller (index.ts) controls render timing
to avoid double-render.

### 6.2 ⟳ spinner on MyMusic

New module-scoped: `let isSyncing = false;`

In `makeRow()` for the app-root row, after the log-toggle icon:
```typescript
if (isSyncing) {
    const spinner = document.createElement('span');
    spinner.className = 'sync-spinner';
    spinner.textContent = '\u2002\u27F3';
    row.appendChild(spinner);
}
```

New interface method: `setSyncing(value: boolean): void` — sets `isSyncing` and re-renders.

### 6.3 Interface changes

```typescript
setOfflineIcons(icons: Map<string, 'complete' | 'downloading' | 'paused'>): void;
```

Note: **no `setDownloads()` method**. Tree does not import downloads.ts at all.

## 7. select.ts — Offline popup items + modal

### 7.1 Popup menu items

In `buildFavItems()`, before the Delete item:

```typescript
if (downloadsRef) {
    const isOffline = fav.offlinePin !== undefined;
    items.push({
        label: isOffline ? 'Available offline \u276F' : 'Make available offline \u276F',
        onClick: () => showOfflineModal(favId, isOffline),
    });
}
```

### 7.2 Available Offline modal (moved from downloads.ts)

The offline modal lives in select.ts because:
- select.ts already owns the popup menu that opens it
- select.ts already holds `favorites` (constructor param) and calls mutation methods directly
- select.ts already builds modals (rename, add-to-playlist)

`showOfflineModal(favId, isCurrentlyOffline)`:

Builds DOM using the CSS classes from the existing modal pattern (`.modal-backdrop`, `.modal`,
`.modal h3`, etc.) plus M11 CSS classes.

Modal structure (per DESIGN.md):
```
Title: "Make Available Offline" | "Available Offline"
Fav row: icon + name + live offline badge
Stats: "20 tracks" | "20 tracks, 0.2 Gb" | "15/20 tracks [Pause/Resume]"
Warning: "Paused due to {error}" | "Paused due to max storage" (conditional)
Global: "Total: 53 tracks, 0.3 / [2.0 Gb max ▾]" with quota dropdown
Queue: "↓ track1... + 19 others" (when downloading)
Actions: Cancel/Close + Make (un)available offline
```

The modal reads download state from `downloadsRef.getSnapshot()` and computes per-favorite
track keys via `collectPhysicalTracks(favId, favorites, roots)` on modal open.

Pause/Resume buttons call `favorites.setOfflinePin(favId, { paused: true/false })` directly
(no indirection through downloads).

### 7.3 Live modal updates

`updateOfflineModal(): void` — exposed on the Select interface. Called by index.ts in the
`downloads.onStateChange` handler alongside `tree.render()`. Updates modal DOM elements with
current snapshot state if the modal is open.

### 7.4 Interface additions

```typescript
setDownloads(downloads: Downloads): void;
updateOfflineModal(): void;
```

## 8. index.ts — Orchestrator wiring

Index.ts is the orchestrator that breaks the dependency cycle between downloads, favorites,
and tree. It computes derived state from favorites + downloads and pushes it to both modules.

### 8.1 computeAndPushOfflineState()

New local function (~40 lines) that:
1. Iterates all favorites, computes per-fav track keys via `collectPhysicalTracks()`.
2. Builds `activeKeys` (unpaused offline) and `retainKeys` (all offline) sets.
3. Calls `downloads.setPinnedKeys(activeKeys, retainKeys)`.
4. Reads `downloads.getSnapshot()` to compute per-favorite icon states.
5. Calls `tree.setOfflineIcons(icons)`.

Icon state logic (previously in downloads.ts as `getFavOfflineIcon`):
```
if (!fav.offlinePin) → absent from map (no icon)
if (fav.offlinePin.paused || snap.overQuota || snap.lastError) → 'paused'
if (evidence === 'signed-in' && fav has queued items) → 'downloading'
else → 'complete'
```

Called on: favorites onChange, index build complete, download state change.

### 8.2 Create downloads module

After favorites and select are initialized in `initFavorites()`:

```typescript
downloads = createDownloads();
downloads.onStateChange = () => {
    computeAndPushOfflineState();
    select?.updateOfflineModal();
    tree!.render();
};
playback.setDownloads(downloads);
select.setDownloads(downloads);
computeAndPushOfflineState();   // initial push
```

Note: **no `tree.setDownloads()`** — tree receives icon data, not a downloads reference.

### 8.3 Evidence transitions in pullMusicFolderFromOneDrive

- After `fetchAccountInfo()` succeeds → `transitionEvidence('evidence:signed-in')`
- After `fetchAccountInfo()` fails → `transitionEvidence('no-evidence')`
- After `pullFavoritesFromOneDrive()` succeeds → `transitionEvidence('evidence:signed-in')`
- After index build succeeds → `computeAndPushOfflineState()` + `transitionEvidence('evidence:signed-in')`

### 8.4 MyMusic spinner

At the start of `pullMusicFolderFromOneDrive`: `tree?.setSyncing(true)`.
At every return/completion: `tree?.setSyncing(false)`.

### 8.5 Favorites onChange propagation

In the favorites `onChange` callback:
```typescript
computeAndPushOfflineState();  // replaces downloads.setContext + downloads.markDirty
```

### 8.6 Sign-out cleanup

Add `downloads?.clear()` before `dbClear()` in the sign-out handler.

## 9. index.html — CSS additions

### ↓ badge
```css
.offline-badge { font-weight: normal; font-size: 0.85rem; opacity: 0.7; }
.offline-badge.downloading { animation: download-pulse 1.5s ease-in-out infinite; }
@keyframes download-pulse { 0%,100% { opacity: 0.7; } 50% { opacity: 0.3; } }
.offline-badge.paused { opacity: 0.5; }
```

### ⟳ spinner
```css
.sync-spinner { font-weight: normal; font-size: 0.85rem; display: inline-block; animation: spin 1.2s linear infinite; }
```
(Reuses existing `@keyframes spin`.)

### Modal extensions
```css
.offline-fav-row { display: flex; align-items: center; gap: 8px; padding: 8px 0; font-weight: 600; }
.offline-progress { display: flex; align-items: center; gap: 8px; font-size: 14px; color: #666; margin-bottom: 8px; }
.offline-progress button { appearance: none; border: 1px solid #ccc; border-radius: 6px; padding: 4px 12px; font-size: 13px; cursor: pointer; background: #f8f8f8; }
.offline-progress button:disabled { opacity: 0.4; cursor: default; }
.offline-warning { color: #e65100; font-size: 13px; margin-bottom: 8px; }
.offline-global { border-top: 1px solid #eee; padding-top: 12px; margin-top: 8px; font-size: 13px; color: #888; }
.offline-global select { appearance: none; border: 1px solid #ccc; border-radius: 4px; padding: 2px 6px; font-size: 13px; background: #fff; cursor: pointer; }
.offline-queue-line { font-size: 12px; color: #999; margin-top: 4px; }
```

## 10. Module dependency graph

```
favorites.ts  (no module deps)
tracks.ts     (imports: indexer types, favorites types — pure functions)
downloads.ts  (imports: auth, db, logger — NO favorites, NO tracks)
playback.ts   (imports: tracks; gets Downloads via setDownloads for getOfflineBlob)
tree.ts       (imports: favorites types — NO downloads)
select.ts     (imports: favorites [constructor], tracks; gets Downloads via setDownloads for modal)
index.ts      (orchestrator: creates all, imports tracks for pin computation, pushes derived state)
```

No cycles. Downloads has zero knowledge of favorites. Tree has zero knowledge of downloads.
Index.ts is the single point where favorites knowledge is translated into the data that
downloads and tree consume.

## 11. Implementation sequence

**Phase 1: Storage foundation**
1. `db.ts`: Version bump, audio store, wipe logic
2. `favorites.ts`: offlinePin field + setOfflinePin
3. Build, verify no regressions

**Phase 2: Shared track traversal**
4. `tracks.ts`: Extract functions from playback.ts, add collectPhysicalTracks + resolveTrackIds
5. `playback.ts`: Import from tracks.ts (remove local copies)
6. Build, run existing tests to verify no regressions

**Phase 3: Downloads engine (pure, no favorites knowledge)**
7. `downloads.ts`: Evidence state machine, queue, workers, GC, storage tracking, snapshot API.
   No modal, no `setContext`, no `getFavOfflineIcon`, no favorites imports.
8. Build, unit test downloads engine with raw key sets

**Phase 4: UI integration + orchestrator**
9. `tree.ts`: ↓ badge via `setOfflineIcons()`, ⟳ spinner via `setSyncing()`. No downloads import.
10. `select.ts`: Offline items in buildFavItems, offline modal (moved from downloads), `updateOfflineModal()`
11. `index.ts`: `computeAndPushOfflineState()` orchestrator, evidence transitions, wiring
12. `index.html`: All new CSS
13. Build, verify badges, spinner, and modal appear

**Phase 5: Playback integration**
14. `playback.ts`: Offline cache check in playNext, blob URL management, setDownloads
15. Build, test offline playback

## 12. Testing

### 12.1 DI analysis

**tracks.ts** — Pure functions taking data arguments (favorites, roots, accounts). No I/O, no module-scoped state, no DI needed. Directly testable with the existing `buildTestRoots()` fixture.

**favorites.ts** — Already has `FavoritesDeps`. The new `setOfflinePin` follows `setHasPrivatePlayback` pattern. Existing `sinkDeps` covers it. No new DI needed.

**db.ts** — Uses `indexedDB` global directly. No DI. The audio store functions are trivial I/O wrappers (same pattern as existing `dbPut`/`dbGet` which also aren't unit-tested). Not worth mocking IndexedDB internals. **Skip unit tests for db.ts; covered by integration tests.**

**downloads.ts** — Needs DI for:
- `authFetch` — dep
- `fetcher` (global `fetch` for SAS URLs) — dep, so tests can stub it
- `audioPut/audioGet/audioDelete/audioKeys/audioTotalBytes/audioClear` — deps
- `loadQuotaBytes/saveQuotaBytes` — deps, to avoid `localStorage` dependency in tests

The engine has **no knowledge of favorites** — tests push raw key sets via `setPinnedKeys()`.
No favorites stubs needed. All algorithmic code (queue calculation, evidence state machine,
GC, error classification, snapshot API) is testable in Node with no browser APIs.

**Testing approach**: The engine fires `onStateChange` after every meaningful state transition.
Tests await that signal via `waitForState(predicate)` instead of arbitrary `setTimeout` delays.
For negative assertions (nothing should happen), the code path is synchronous, so no waiting
is needed.

### 12.2 Unit test files

#### `test/unit/tracks.test.ts` (~10 tests)

Uses the existing `buildTestRoots()` fixture and `DRIVE_ID` constant (shared or duplicated from favorites test).

1. **collectTracks**: physical folder → sorted file paths (folders-first, alpha)
2. **collectTracks**: empty folder → empty array
3. **collectLogicalTracks**: shortcut root → expands through target to physical files
4. **collectLogicalTracks**: playlist with ItemRef members → collects each member's files
5. **collectLogicalTracks**: playlist with FavRef → follows reference, collects transitively
6. **collectLogicalTracks**: cycle in FavRef chain → terminates without infinite loop
7. **collectPhysicalTracks**: shortcut → returns `{driveId, itemId}` for each file
8. **collectPhysicalTracks**: playlist with mixed members → deduped by `driveId:itemId`
9. **collectPhysicalTracks**: shared track across two favorites → appears once
10. **resolveTrackIds**: physical path → correct `{driveId, itemId}`; broken path → undefined

#### `test/unit/downloads.test.ts` (~16 tests)

DI stubs: `authFetch` returns mock JSON with `@microsoft.graph.downloadUrl`, `fetcher` returns
mock Blob, audio* stubs use in-memory Map, quota stubs use a variable.

Helper: `waitForState(dl, predicate)` — resolves when `onStateChange` fires and predicate
holds. No arbitrary delays.

**Evidence state machine (4 tests):**
1. Initial state is `no-evidence`, pump does not start (synchronous assert, no wait)
2. Transition to `evidence:signed-in` while dirty → triggers recalculate + pump
3. Transition to `no-evidence` → pump stops (no new downloads start)
4. Transition to `evidence:signed-out` → aborts in-flight (synchronous assert)

**Queue calculation (3 tests):**
5. 3 active keys, 0 downloaded → all 3 downloaded
6. 3 active keys, 2 already downloaded → only 1 new download
7. Empty activeKeys → no downloads start

**Garbage collection (3 tests):**
8. Downloaded track not in retainKeys → audioDelete called
9. Downloaded track in retainKeys → not deleted
10. Empty retainKeys → GC skipped (safety guard)

**Error classification (3 tests):**
11. 404 response → item removed from queue (not re-queued)
12. 429 response → item pushed to back of queue, retried
13. 408/504 → evidence transitions to `no-evidence`, lastError set

**Snapshot API (3 tests):**
14. getSnapshot returns atomic state (downloadedKeys, evidence, overQuota, lastError)
15. setQuota triggers recalculation → overQuota becomes true
16. clear resets all state (downloadedKeys, totalBytes, audioStore)

#### `test/unit/favorites.test.ts` — extend existing file (~3 new tests)

16. `setOfflinePin(id, { paused: false })` → sets offlinePin, triggers onChange
17. `setOfflinePin(id, undefined)` → clears offlinePin, triggers onChange
18. `normalize()` preserves offlinePin when present; omits when absent

### 12.3 Integration tests (2 tests in `test/integration/tree.test.cjs`)

**offline:badge** — Mark a favorite offline via `window.favorites.setOfflinePin(id, { paused: false })`, wait for re-render, verify `.offline-badge` element exists on the favorite's tree row.

**offline:modal** — Open the offline modal via `window.downloads.showOfflineModal(id, false)`, verify modal is visible with expected title ("Make Available Offline") and track count text.

### 12.4 Infrastructure changes

**`tsconfig.unit.json`**: Add `tracks.ts`, `downloads.ts`, `playback.ts` to the include list, plus `test/unit/tracks.test.ts` and `test/unit/downloads.test.ts`.

**`package.json`**: Update `test:unit` script to glob all test files:
```
"test:unit": "tsc -p tsconfig.unit.json && node --test dist-test/test/unit/*.test.js"
```

### 12.5 Manual verification (iPhone)

1. Tap ☆ → "Make available offline >" → modal → confirm → ↓ appears → animates → static when complete
2. Modal → Pause → ↓⏸ → Resume → animation resumes
3. Airplane mode → play cached track → plays from offline cache
4. Close app → reopen → downloads resume
5. Set quota to 1 GB → mark large favorite → pauses at quota → increase → resumes
6. "Make unavailable offline" → ↓ disappears → cache purged
7. ⟳ spinner on MyMusic during sync, disappears after
8. All touch targets ≥ 44px, modal doesn't zoom on iOS

## 13. Codex review — feedback and disposition

Codex reviewed this plan and raised 10 findings. Here's how each is addressed:

1. **Wiping IDB on version bump breaks offline-first (Critical)** — Dismissed per user directive: "no member of the public has ever used this app" and "deleting IndexDB is deliberately intended never to be a problem." The wipe is safe.

2. **Stale audio if file content changes with same itemId (Critical)** — Valid in theory. In practice, a file content change triggers an index refresh (Merkle size change), which marks dirty, which recalculates the queue. However the audio blob wouldn't be re-downloaded since the key already exists. Noted as a future concern; not worth complicating M11 with per-track eTag tracking.

3. **Download URL should use `/drives/{driveId}/items/{itemId}` (Critical)** — Accepted. Plan updated to use the drive-scoped Graph API path.

4. **Missing cancellation and single-flight guards (High)** — Accepted. Plan updated: AbortController for in-flight downloads, single-flight recalculation via dirty-flag loop (same pattern as favorites upload pump).

5. **Global isOverQuota/lastError shows paused on unrelated favorites (High)** — This is correct per DESIGN.md: quota is a global concern. The spec says "↓⏸ if marked offline and either we're out of quota or it has the pause boolean set." `lastError` transitions to `no-evidence` which shows static ↓ (not ↓⏸), so no per-favorite error state needed.

6. **Error policy too destructive (High)** — The error policy comes directly from DESIGN.md. The "other→remove" default is the user's explicit design choice. 429 already pushes to back of queue.

7. **Full audioKeys/audioTotalBytes scans at scale (Medium)** — Acceptable for MVP (offline libraries are ~100-1000 tracks, not 30k). Future optimization: incremental metadata tracking.

8. **isSyncing boolean flickering (Medium)** — `pullMusicFolderFromOneDrive` doesn't overlap with itself (single call path from `onBodyLoad`). No refcount needed.

9. **offlinePin should be device-local (Medium)** — Per DESIGN.md, the `offlinePin` (whether a favorite is marked offline) syncs with the favorite to OneDrive. The `paused` boolean within it is "not durable intent" (per LEARNINGS.md), but it persists with the favorite for simplicity. This is the user's explicit design.

10. **tracks.ts extraction scope (Low)** — Agreed: extract only what's shared. Keep playback-specific helpers in playback.ts.

## 14. Post-implementation refactoring and Codex review

After initial implementation, a code review identified a dependency cycle:
`tree → downloads → favorites → tree`. The refactoring broke the cycle by making downloads
a pure engine and introducing index.ts as an orchestrator. See the refactoring plan at
`~/.claude/plans/majestic-chasing-riddle.md` for full details.

### Post-implementation Codex review findings

Codex reviewed the refactored downloads.ts and raised 7 findings:

1. **Critical: `activeDownloads` leaks on generation bump** — Orphaned workers skip decrement.
   **Fixed**: reset `activeDownloads = 0` in `recalculate()` alongside generation bump.

2. **Critical: feedback loop `onStateChange → computeAndPush → setPinnedKeys → recalculate`** —
   `setPinnedKeys` always triggered recalculation even when keys were unchanged.
   **Fixed**: added set-equality check; no-ops when both sets are unchanged.

3. **High: `getSnapshot()` returns `downloadedKeys` by reference** — Not truly atomic.
   **Fixed**: returns `new Set(downloadedKeys)` defensive copy.

4. **High: `setPinnedKeys` keeps caller's mutable set by reference** — Caller mutation bypasses
   dirty flag. **Fixed**: stores `new Set(newActiveKeys)` defensive copy.

5. **Medium: GC guard too coarse** — Blocks cleanup when user unpins everything.
   **By design**: `clear()` is the explicit cleanup path; empty retainKeys guards against
   incomplete index state.

6. **Medium: error classification shared for Graph vs CDN; no backoff; brittle string matching** —
   **Accepted for now**: CDN URLs use SAS tokens (no 401), backoff adds complexity for
   minimal benefit at this scale.

7. **Medium: `notifyUI()` can throw inside detached IIFE** — Produces unhandled rejections.
   **Fixed**: wrapped in try/catch.

### Fire-and-forget naming refactoring

`recalculateQueueAndStartDownloadsFireAndForget` and `downloadOneTrackFireAndForget` were
renamed to `recalculate` and `downloadOneTrack`. Both changed from `async function(): Promise<void>`
to `function(): void` with an internal IIFE. This enforces the fire-and-forget contract at
the type level — callers literally cannot `await` a `void` return.

## 15. Post-M11: Four-state evidence model

After testing M11, we added a fourth evidence state `evidence:not-online` triggered by
`navigator.onLine === false`. This addresses two issues: (1) avoiding wasted network
requests on offline startup (which triggered iOS's "You are offline" banner), and
(2) greying out non-cached tracks when the device is definitively offline.

The download engine's error classifier consults `navigator.onLine` (via `deps.isOnline()`)
to choose between `no-evidence` and `not-online` on network failures. Periodic background
pulls (5-min interval) are suppressed while offline or signed-out. A `visibilitychange`
backstop catches missed `online` events.

See the full plan at `~/.claude/plans/functional-twirling-hammock.md`.
