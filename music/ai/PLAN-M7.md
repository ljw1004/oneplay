# Plan: Milestone 7 — Favorites (Data Layer + Tree Integration)

## Context

M1–M6 are complete: dev infrastructure, OneDrive auth, indexing, hierarchical tree with FLIP animations, playback with footer bar, and expanded scrubber controls. The app browses and plays a 30k-track OneDrive music library. M7 adds the favorites data layer (shortcuts ☆ and playlists ♫), persists them to OneDrive App folder and IndexedDB, and integrates them into the tree view. Select mode, action bar, and modals for creating/editing favorites are M8.

**Key architectural decision (Codex-approved):** Refactor from a separate `accounts` Map to a **unified roots** model. All top-level items (OneDrive accounts, shortcuts, playlists, and future shared links) are entries in a single `roots` Map. Path[1] is always a root key. This gives one path resolution invariant and one rendering path with a type switch, reducing concept count compared to parallel data structures.

## 1. Types

### Root type (new, in `tree.ts` or extracted)

```typescript
/** A root is a top-level item in the tree. */
type Root =
    | { readonly type: 'onedrive'; readonly key: string; readonly name: string;
        readonly folder: MusicFolder; readonly info: AccountInfo; readonly reindexing: boolean }
    | { readonly type: 'shortcut'; readonly key: string; readonly name: string;
        readonly target: ItemRef; readonly hasOwnPlayback: boolean }
    | { readonly type: 'playlist'; readonly key: string; readonly name: string;
        readonly members: readonly PlaylistMember[]; readonly hasOwnPlayback: boolean }
```

### Favorites types (in `favorites.ts`)

```typescript
/** Reference to a OneDrive item (folder or file). */
interface ItemRef {
    readonly driveId: string;
    readonly itemId: string;           // OneDrive ID, for heal-by-ID
    readonly path: readonly string[];  // segments within MusicFolder tree (no "MyMusic" or driveId)
    readonly isFolder: boolean;
}

/** Reference to another favorite (for playlist-in-playlist). */
interface FavRef {
    readonly favId: string;
}

type PlaylistMember = ItemRef | FavRef;

/** Per-favorite playback state (not wired to UI in M7). */
interface FavoritePlaybackState {
    readonly hasOwnState: boolean;
    readonly currentTrackPath?: readonly string[];
    readonly currentTime?: number;
}

interface Shortcut {
    readonly kind: 'shortcut';
    readonly id: string;               // UUID
    readonly name: string;             // derived from target folder name
    /** INVARIANT: target.isFolder is always true. Shortcuts reference folders, never files.
     *  Enforced at creation time and validated on load/add (corrupt data is rejected). */
    readonly target: ItemRef;
    readonly playbackState?: FavoritePlaybackState;
}

interface Playlist {
    readonly kind: 'playlist';
    readonly id: string;               // UUID
    readonly name: string;             // user-chosen
    readonly members: readonly PlaylistMember[];
    readonly playbackState?: FavoritePlaybackState;
}

type Favorite = Shortcut | Playlist;

interface FavoritesData {
    readonly version: number;
    readonly updatedAt: number;         // epoch ms, for conflict resolution
    readonly favorites: readonly Favorite[];
}
```

### Root key conventions

- OneDrive accounts: key is the driveId (opaque Microsoft identifier)
- Favorites: key is `"fav:" + uuid`
- Future shared links (M12): key is `"share:" + id`

These never collide because driveIds don't start with `"fav:"` or `"share:"`.

**Root type dispatch:** Never use `startsWith('fav:')` to determine root type. Always use `roots.get(path[1])?.type`. The key prefix is a human-readability convention; code dispatches on the `type` field.

## 2. Module: `favorites.ts`

New file. Factory pattern matching the codebase convention.

```typescript
interface Favorites {
    /** All favorites in display order. */
    getAll(): readonly Favorite[];

    /** Add a favorite. Returns false if it would create a cycle. */
    add(fav: Favorite): boolean;

    /** Remove a favorite by ID. Also removes FavRefs to it from all playlists. */
    remove(id: string): void;

    /** Check if adding memberId to playlistId would create a cycle. */
    wouldCreateCycle(playlistId: string, memberId: string): boolean;

    /** Resolve children for display. Returns [name, isFolder] or undefined if broken.
     *  - Shortcut: resolves target folder, walks subPath, returns its sorted children.
     *  - Playlist (subPath empty): returns one entry per member, using "m:0", "m:1" etc as
     *    stable path segments (not member names, which may collide). Display names are
     *    resolved separately by makeRow via a lookup method.
     *  - Playlist (subPath non-empty): first segment is "m:N", resolves into that member's content. */
    resolveChildren(id: string, subPath: readonly string[], roots: RootsMap):
        Array<[string, boolean]> | undefined;

    /** Resolve display name for a path segment inside a favorite. For playlist members,
     *  maps "m:0" → the member's display name (folder name, track name, or favorite name). */
    resolveDisplayName(id: string, segment: string, roots: RootsMap): string;

    /** Heal broken references after index refresh. Uses an id→path map built during indexing. */
    heal(idToPath: Map<string, { driveId: string; path: string[] }>, roots: RootsMap): void;

    /** Persist to IndexedDB and OneDrive (fire-and-forget). */
    save(): Promise<void>;

    /** Load from IndexedDB (immediate), then OneDrive (background). */
    load(): Promise<FavoritesData | undefined>;
}
```

### Healing algorithm

1. During `buildIndex`, build an `idToPath` Map keyed by `"driveId:itemId"` (composite key to avoid collisions across multiple accounts/drives), with values `{driveId, path, isFolder}`. This is O(n) during the index walk and is discarded after healing.
2. After index completes, call `favorites.heal(idToPath, roots)`.
3. For each ItemRef in each favorite:
   - Try resolving `itemRef.path` in the account's MusicFolder tree.
   - If found with matching `itemId`: healthy, skip.
   - If found with different `itemId`: the name is the same but the item was replaced. Update `itemId` to the new one. (Heal by path/name.)
   - If not found at path: look up `"driveId:itemId"` in the `idToPath` map. If found, update `itemRef.path`. (Heal by ID — item was moved/renamed.)
   - If neither: broken. Remove the member from playlists; remove the shortcut entirely.
4. If any changes were made, call `save()`.

### Cycle safety

Cycle detection runs at add-time (`wouldCreateCycle`). Additionally, `resolveChildren` uses a `visited: Set<string>` during FavRef traversal to guard against cycles from corrupt/legacy data. If a cycle is detected during resolution, the cyclic member is skipped (treated as broken).

### Persistence

- **IndexedDB key:** `"favorites"` via existing `db.ts` (`dbPut`/`dbGet`).
- **OneDrive:** Direct PUT to `/me/drive/special/approot:/favorites.json:/content` using `authFetch`. Individual PUTs work fine with `application/json` (the batch workaround is only needed for batch requests).
- **`FavoritesData` includes `updatedAt: number` (epoch ms)** — the timestamp of the most recent modification. This is part of the data model from M7 onward.
- **Load order (offline-first):** Same pattern as the music index: load from IndexedDB cache first → immediate display. Background fetch from OneDrive → if server version has newer `updatedAt`, adopt it; otherwise keep local. This means if the user was offline while modifying favorites, and separately the OneDrive copy was modified, whichever has the more recent `updatedAt` wins. No merge on conflict.
- **Save order:** `dbPut` first (fast), set `updatedAt` to `Date.now()`, then OneDrive PUT (may fail offline — logged, not blocking).
- **Re-render after mutations:** `load()`, `heal()`, `add()`, `remove()` all call an `onChange` callback (wired to tree re-render) after mutating state.

### Cycle detection

DFS on the FavRef graph from the candidate member. If it reaches back to the target playlist, reject.

## 3. Tree integration (`tree.ts` changes)

### Refactor: `accounts` Map → `roots` Map

```typescript
// Before:
const accounts = new Map<string, { folder: MusicFolder; info: AccountInfo; reindexing: boolean }>();

// After:
const roots = new Map<string, Root>();
```

`setAccount` becomes a method that creates/updates a root of type `'onedrive'` in the roots Map.

New method: `setFavorites(favs: Favorites)` — stores a reference to the Favorites module, converts favorites to roots of type `'shortcut'`/`'playlist'`, and renders.

### `resolveFolder()` changes

Currently handles two cases:
1. `selectedPath.length <= 1` → list accounts
2. Walk accounts Map for deeper paths

After M7, three cases:
1. `selectedPath.length <= 1` → list all roots (favorites first, then onedrive, sorted within groups)
2. Root at `path[1]` has type `'shortcut'` or `'playlist'` → delegate to `favorites.resolveChildren(favId, subPath, roots)`
3. Root has type `'onedrive'` → existing OneDrive account walking logic (unchanged)

**Playlist path segments:** Playlist children use index-based segments `"m:0"`, `"m:1"`, etc., not member names. This avoids ambiguity from duplicate names (two members named "Best Of"). The display name for `"m:N"` is resolved by `favorites.resolveDisplayName()`, called from `makeRow()`.

### `makeRow()` changes

Currently derives display from path depth:
- `depth === 1` → app root (clipboard icon)
- `depth === 2` → account (shows "OneDrive", gear icon)

After M7, `depth === 2` needs a type check:
```typescript
const rootEntry = roots.get(opts.path[1]);
const rootType = rootEntry?.type;
const isAccount = rootType === 'onedrive';
const isFavoriteRoot = rootType === 'shortcut' || rootType === 'playlist';
```

For favorite roots:
- Display `root.name` (not the `fav:uuid` key)
- Prepend icon: `☆` for shortcuts, `♫` for playlists (via a `.fav-icon` span)
- No gear icon (gear is accounts only)

For deeper rows inside favorites:
- If path segment is `"m:N"` (playlist member), display name comes from `favorites.resolveDisplayName()`
- If a playlist member is a FavRef, its resolved icon (☆ or ♫) appears via the same `.fav-icon` span
- Otherwise (deeper inside a shortcut or inside a resolved member), use the segment name directly

### `render()` changes

- Remove the "favorites will go here" placeholder
- At app root, favorites appear first in the children list

## 4. Index integration (`index.ts` changes)

### Wiring

```typescript
const favorites = createFavorites();
```

- During startup: `favorites.load()` before `showTree()`.
- After `showTree()`: `tree.setFavorites(favorites)`.
- After re-index completes: build `idToPath` map, call `favorites.heal(idToPath, accountData)`.

### `accountData` refactor

Currently: `const accountData = new Map<string, { folder: MusicFolder }>()`.

This needs to become compatible with the roots Map. Options:
- Pass the tree's roots Map to playback (but playback only needs MusicFolder for OneDrive accounts).
- Keep accountData as-is for now — playback doesn't use favorites in M7.

**Decision:** Keep `accountData` unchanged for M7. Playback doesn't handle `fav:` paths yet (M9). The `roots` Map is internal to tree.ts. `index.ts` continues to pass `accountData` to playback.

### Test fixtures

If `favorites.getAll().length === 0` after load, create hard-coded test favorites:
1. One shortcut ☆ to the first top-level folder in the music library.
2. One playlist ♫ containing three members: a track (first file found), a second folder, and a FavRef to the shortcut.
3. Save to IndexedDB + OneDrive.

This exercises the full persistence and display pipeline.

## 5. `index.html` CSS additions

```css
/* Favorite icon (☆ or ♫) prepended to favorite rows */
.fav-icon {
    margin-right: 4px;
    font-weight: normal;
    font-size: 0.85rem;
    opacity: 0.7;
}
```

## 6. `buildIndex` change (id→path map)

Add a post-processing step (or inline during the walk) that builds `Map<itemId, {driveId, path}>` from the completed MusicData tree. This map is:
- Built once after `buildIndex` returns
- Passed to `favorites.heal()`
- Discarded (not persisted)

A simple recursive walk of the MusicFolder tree builds this in O(n).

## 7. Test additions (`test-tree.js`)

New tests in the `favorites:` category:

| Test name | What it verifies |
|-----------|------------------|
| `favorites: test favorites created on first load` | Two favorites appear at app root (star + notes) |
| `favorites: shortcut has star icon` | Star glyph visible on shortcut row |
| `favorites: playlist has notes icon` | Notes glyph visible on playlist row |
| `favorites: expanding shortcut shows children` | Click shortcut → children match target folder |
| `favorites: expanding playlist shows members` | Click playlist → three members visible |
| `favorites: favref in playlist shows icon` | FavRef member in playlist shows ☆ icon |
| `favorites: breadcrumbs work in favorites` | Navigate into favorite, click breadcrumb to go back |
| `favorites: persist across reload` | Reload page → favorites still present |
| `favorites: gear only on accounts` | No gear icon on favorite rows |
| `favorites: broken shortcut healed or removed` | After heal with stale data, broken shortcuts are removed |
| `favorites: broken playlist member dropped` | After heal, broken playlist members are silently removed |
| `favorites: cyclic data does not loop` | Corrupt cycle in FavRef chain → member skipped, no infinite recursion |

## Files modified

| File | Action | Summary |
|------|--------|---------|
| `favorites.ts` | **Create** | Types, factory, persistence (IndexedDB + OneDrive), healing, cycle detection, resolution |
| `tree.ts` | **Modify** | Refactor accounts→roots, favorite-aware resolveFolder/makeRow/render |
| `index.ts` | **Modify** | Wire favorites, test fixture creation, heal after re-index |
| `indexer.ts` | **Modify** | Add `buildIdMap` helper (or inline) to produce id→path map after indexing |
| `index.html` | **Modify** | CSS for `.fav-icon` |
| `test-tree.js` | **Modify** | Add `favorites:` tests |

## Validation plan

### Automated (Playwright via sandbox-escape)
1. All existing tests pass (tree, indent, nav, log, settings, scroll, playback, expanded)
2. All new favorites tests pass
3. Build succeeds clean (`npm run build`)

### Manual (human on iPhone)
1. Fresh load → test favorites appear with icons
2. Shortcut expands to show target folder contents
3. Playlist expands to show three members (track, folder, shortcut-ref)
4. FavRef inside playlist shows star icon
5. Navigation into favorites works (breadcrumbs, back navigation)
6. Reload → favorites persist
7. Deploy to production → verify at https://unto.me/mymusic/

### Production verification (Playwright)
1. Deploy with `npm run deploy`
2. Run Playwright against https://unto.me/mymusic/ with 8s load wait
3. Verify favorites display and expand correctly

## Key invariants

1. **Path prefix:** `path[1]` uses `"fav:"` prefix for favorites and raw driveId for accounts as a naming convention. These namespaces never collide. **Code always dispatches on `roots.get(path[1])?.type`, never on string prefix.**
2. **Favorite ID stability:** UUIDs. Renames change `name` not `id`. Stored paths remain valid.
3. **Cycle freedom:** Enforced by `wouldCreateCycle()` at add-time. FavRef chains always terminate.
4. **Broken reference tolerance:** Kept silently; healed on re-index; removed only when unresolvable by both ID and path.
5. **Offline-first:** Favorites load from IndexedDB before network. OneDrive writes are background, non-blocking.
6. **Root display order:** Favorites first (in array order), then OneDrive accounts (sorted by key).

## Codex review

Codex raised 3 blockers, 6 should-fixes. Here's how each was addressed:

**Blockers addressed:**
1. **Sync data loss:** Added `updatedAt` timestamp to `FavoritesData` as part of the data model. Same pattern as music index: load from cache first, background fetch from OneDrive, newer `updatedAt` wins. No merge on conflict.
2. **Duplicate names in playlists:** Playlist children now use index-based path segments (`"m:0"`, `"m:1"`) instead of member names. Display names resolved separately by `resolveDisplayName()`.
3. **Healing map key collisions:** Changed to composite `"driveId:itemId"` key with `isFolder` in the value.

**Should-fixes addressed:**
1. **Root typing:** Dispatch on `roots.get(path[1])?.type`, never on key prefix. Added to plan.
2. **Cycle safety on load:** `resolveChildren` uses `visited` set during FavRef traversal. Added to plan.
3. **Shortcut folder-only:** Shortcut target always has `isFolder: true`. This is a documented invariant on the `Shortcut.target` type. Enforced at creation time. Also validated on `load()` and `add()` — corrupt data with file-target shortcuts is rejected/removed.
4. **Change notification:** `load()`, `heal()`, `add()`, `remove()` all call `onChange` callback. Added to plan.
5. **Test seeding gated:** The test fixtures are temporary M7 scaffolding, removed in M8. They only create if `getAll().length === 0` and are saved to OneDrive.
6. **Failure mode tests:** Will add tests for broken favorites display and reload persistence.

## Deferred review items (end-of-milestone code review)

These items were identified during the M7 end-of-milestone dual review (subagent + Codex) and deferred as too architectural, low severity, or out-of-scope for M7.

### 1. Forward-ref cycle bypass

**Issue:** `wouldCreateCycle(playlistId, memberId)` does DFS from `memberId` through existing FavRef edges. If a user adds P1→P2 *before P2 exists*, the cycle check passes vacuously (P2 has no members to traverse). Later adding P2→P1 would be caught, but the window exists.

**Why deferred:** In practice, `add()` is always called with existing members — the UI (M8) will only offer existing favorites as FavRef candidates. The test seeder also only references existing favorites. The runtime `visited` set in `resolveChildren` provides a safety net: even if corrupt data introduces a cycle, resolution terminates without infinite recursion.

**Future action:** None needed unless the API surface changes to allow forward references. If it does, validate that `memberId` exists before accepting FavRefs.

### 2. `load()` return value staleness

**Issue (resolved):** `load()` mixed two concerns: reading from IndexedDB cache (fast, offline-first) and fetching from OneDrive (slow, may fail). The return value was the stale cached version even when the server version was adopted. The name `load()` implied it returned data, but its real purpose was the side effect of populating module state and calling `onChange()`.

**Resolution:** Split into two methods with explicit names:
- `loadFromCache()`: reads IndexedDB only, populates state, calls `onChange()`, returns `void`. Called from `initFavorites()` at startup — no network, renders immediately.
- `pullFavoritesFromOneDrive()`: fetches from OneDrive, adopts if newer, persists locally, calls `onChange()`. Called from `pullMusicFolderFromOneDrive()` in the background, alongside the music index sync.

This aligns with the offline-first architecture: cache loads are synchronous with rendering, network syncs are background and non-blocking.

### 3. Persistence error contract

**Issue (resolved):** The original docstring on `save()` said "Persist to IndexedDB and OneDrive (fire-and-forget)" without clarifying error behavior. The implementation swallows errors via `logCatch` — correct for offline-first (network failures are expected and non-blocking), but the docstring didn't document this contract.

**Resolution:** Docstring was updated during this review to explicitly state: "Persistence is best-effort and never throws — IndexedDB errors are logged, OneDrive PUT failures are logged. Callers do not need to handle errors." No code change needed; the implementation already matched the intended contract.
