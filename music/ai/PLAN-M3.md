# Plan: Milestone 3 -- Indexing

## Context

M2 established OneDrive auth and a demo directory listing. M3 replaces that demo with a real music index: a recursive tree of all folders and audio files in the user's Music folder, stored in IndexedDB for offline-first launch, with server-side per-folder caching in the OneDrive App folder for fast re-indexing of a 30k-track library.

**Design decisions from planning discussion:**
- Single OneDrive account (multi-account deferred). Share links are a future feature and won't affect the index schema.
- Cache keyed by `driveId` (from `GET /me/drive`), naturally extends to share links later.
- Server-side cache in OneDrive App folder included (proven pattern from example code; critical for fast re-indexing).
- **Merkle-tree invariant** documented in code: OneDrive's recursive folder `size` serves as a Merkle-like hash for cache validation.
- **Binary state model**: the index is either "not yet built" or "built." Always display from the cached index, nothing else. The indexer is an opaque process that produces a complete `MusicData` at the end.
- **Progress is purely human-informative**: `IndexProgress { fraction, message }` is only used for UI display, never consumed by code logic.

**Design doc alignment** (DESIGN.md lines 316-333):
- Always display cached index, nothing else. No partial data, no per-folder online queries.
- Cache staleness checked via recursive `size` comparison (Merkle-like). For M3: check at load time. Periodic 5-min checks are a future enhancement for long-lived sessions.
- Two UI treatments for indexing status:
  - **First index** (no cached data): prominent progress display — progress bar, fraction, current folder path. This is the user's introduction to the app.
  - **Re-index** (cached data displayed): subtle indicator — small spinner next to account name ("⟳"). Cached data remains visible and usable throughout.
- Re-sync happens during the app lifetime, not blocking startup. Typically ~1-2 min after launch.
- Low-connectivity tolerance: cached data shows; if no cache and no network, nothing to display.

## Files

| File | Action | Purpose |
|---|---|---|
| `indexer.ts` | **Create** | Data model types, indexing algorithm (work-queue + batch API), `fetchAccountInfo` |
| `index.ts` | **Rewrite** | Offline-first flow, summary rendering, background re-indexing |
| `index.html` | **Modify** | CSS for summary UI and progress indicator |
| `auth.ts` | No changes | `authFetch` used as-is |
| `db.ts` | No changes | String-keyed store used as-is |
| `logger.ts` | No changes | `log`/`logError` used as-is |

## 1. Data Model (`indexer.ts`)

Adapted from `example/musicdata.ts` (lines 31-55). Types exported for `index.ts`.

```typescript
const SCHEMA_VERSION = 1;
const AUDIO_RE = /\.(mp3|m4a|flac|wav|aac|ogg|wma)$/i;

/**
 * Complete index of a music folder tree. Stored in IndexedDB and as per-folder
 * cache files in OneDrive App folder.
 *
 * INVARIANT: count = total MusicFile nodes in the tree.
 * INVARIANT: size = OneDrive folder's recursive `size` property at index time.
 *
 * MERKLE PROPERTY: OneDrive computes each folder's `size` as the total bytes of
 * all files in all descendant folders. If ANY file anywhere in a subtree is added,
 * removed, or modified, the `size` changes propagate up to every ancestor. Comparing
 * a cached MusicData's `size` against the live folder `size` therefore answers
 * "has anything changed in this entire subtree?" without traversing it. This is
 * the basis for cache validation: if size + schemaVersion match, the cached subtree
 * is reused as-is. This property also enables resumability -- if indexing is
 * interrupted, completed subtrees have their cache files on OneDrive, and on resume
 * those subtrees pass the size check and are skipped.
 */
export interface MusicData {
    readonly kind: 'MusicData';
    readonly schemaVersion: number;
    readonly size: number;
    readonly lastModifiedDateTime: string;
    readonly cTag: string;
    readonly eTag: string;
    readonly folder: MusicFolder;
    readonly count: number;
}

/** INVARIANT: id refers to a OneDrive folder. */
export interface MusicFolder {
    readonly id: string;
    readonly children: { readonly [name: string]: MusicFile | MusicFolder };
}

/** INVARIANT: id refers to a OneDrive file. */
export interface MusicFile {
    readonly id: string;
}

export const isMusicFolder = (item: MusicFile | MusicFolder): item is MusicFolder =>
    'children' in item;

export interface AccountInfo {
    readonly driveId: string;
    readonly displayName: string;
}

/** Progress emitted during indexing. Opaque — just fraction and status text. */
export interface IndexProgress {
    readonly fraction: number;
    readonly message: string;
}
```

Note on mutability: `MusicFolder.children` is marked `readonly` in the type, but during indexing the implementation mutates it via cast. The shared mutable root is safe because the work-queue is single-threaded (interleaved async, not concurrent).

## 2. Indexing Algorithm (`indexer.ts`)

Adapted from `example/musicdata.ts` lines 140-366 and `example/utils.ts` lines 41-62.

### Exports

```typescript
/** Fetches driveId + displayName from GET /me/drive.
 *  Returns undefined on network failure. */
export async function fetchAccountInfo(): Promise<AccountInfo | undefined>

/** Builds the music index by walking OneDrive Music folder.
 *  Opaque long-running process. Uses server-side cache in App folder
 *  for fast subtree reuse. Returns a complete MusicData on success. */
export async function buildIndex(
    musicDriveItem: MusicDriveItem,
    onProgress: (p: IndexProgress) => void
): Promise<MusicData>

/** Subset of Graph DriveItem fields needed for the Music folder root. */
export interface MusicDriveItem {
    readonly id: string;
    readonly name: string;
    readonly size: number;
    readonly lastModifiedDateTime: string;
    readonly cTag: string;
    readonly eTag: string;
    readonly folder: { childCount: number };
}

/** Counts all MusicFile nodes recursively under a folder. */
export function countTracks(folder: MusicFolder): number
```

### Algorithm (work-queue with START/END states)

Module-private types:
```typescript
interface WorkItem {
    state: 'START' | 'END';
    requests: BatchRequest[];
    responses: { [id: string]: BatchResponse };
    data: MusicData;
    path: string[];               // folder names from root (empty = root)
    remainingSubfolders: number;
}
```

Loop:
1. Pop from `toProcess`. If START: check cache validity (`size` + `schemaVersion`). Cache hit → reuse subtree, push END with no upload requests (already on server). Cache miss → enumerate children, create START items for subfolders, filter audio files by `AUDIO_RE`.
2. If END: if root, return `MusicData`. Otherwise merge folder into parent tree (via shared mutable root), decrement parent's `remainingSubfolders`. If parent now done, push parent's END with cache-upload PUT.
3. If `toProcess` empty: batch-fetch from `toFetch` (up to 18 requests per `POST /$batch`), distribute responses, push into `toProcess`.
4. Report progress after each processed item: `{ fraction: bytesProcessed/bytesTotal, message: currentPath }`.

### Key API calls
- Children: `GET /me/drive/items/{id}/children?$top=10000&select=name,id,ctag,etag,size,lastModifiedDateTime,folder,file`
- Cache read: `GET /me/drive/special/approot:/{cacheFilename}:/content`
- Cache write: `PUT /me/drive/special/approot:/{cacheFilename}:/content` (base64-encoded as text/plain -- OneDrive batch API bug workaround, see example lines 185-189)
- Cache filename: `path.length === 0 ? 'index.json' : path.join('_') + '.json'`

### Batch postprocessing
Adapted from `example/utils.ts` lines 41-62. Handles:
- **302 redirects**: batch API doesn't auto-follow. Follow with `authFetch` (redirect URL has SAS token; extra Bearer header is harmless).
- **Base64-encoded JSON bodies**: when batch claims `application/json` but body is a string, decode: `atob` → `Uint8Array.from(_, c => c.codePointAt(0))` → `TextDecoder` → `JSON.parse`.

### 429/503 handling
Track `got429recently`. If any response within a batch has 429/503, put the work item back in `toFetch` and delay 10s before the next batch fetch.

### Resumability
If the user closes mid-indexing and re-opens:
- Completed subtrees have their `MusicData` cached in OneDrive App folder
- On re-open, the indexer starts fresh but hits cache for those subtrees (fast path via Merkle size check)
- Only incomplete subtrees are re-traversed
- IndexedDB is written only on full completion

## 3. Offline-First Flow (`index.ts`)

Replace the entire M2 demo. Remove `CacheEntry`, `DriveItem`, `GRAPH_MUSIC_CHILDREN`, `CACHE_KEY`, `renderListing`, `formatSize`.

### State model

Binary: either "have index" or "don't have index."
- **No index** → prominent progress display (progress bar, fraction %, current folder path). This is the user's first experience with the app.
- **Have index** → display summary (account name, track count, top-level folders)
- **Have index but stale** → display existing index + subtle re-indexing indicator ("⟳"). On re-index completion, swap in new data silently.

### `onBodyLoad()` flow

```
1. handleOauthRedirect()
   if 'iframe': return
   if error: log it

2. Load AccountInfo from localStorage("account_info")

3. If not signed in:
   - If have AccountInfo + cached index in IndexedDB: render summary (offline)
   - Show sign-in button
   - return

4. Signed in:
   a. If AccountInfo exists: load cached index from IndexedDB("index:{driveId}")
      If found: render summary immediately
   b. Fetch GET /me/drive → extract driveId, owner.user.displayName
      Save AccountInfo to localStorage("account_info")
      If driveId changed: clear stale cache, reload for new driveId
   c. Fetch GET /me/drive/special/music?select=name,id,cTag,eTag,size,...
      → MusicDriveItem
   d. Compare cached index size with musicDriveItem.size + schemaVersion:
      - Match: done (cache is current)
      - Mismatch: buildIndex() in background
      - No cache: buildIndex(), show progress bar
   e. On indexing completion: dbPut("index:{driveId}", data), render summary
   f. Network errors: log, keep showing cached data if available
```

### Sign-out
```typescript
signOut(async () => {
    localStorage.removeItem("account_info");
    await dbClear();
})
```

### Rendering functions

- `renderSummary(accountInfo, data)`: Account name header, "{count} tracks in {N} folders", flat listing of top-level folders sorted alphabetically with recursive track counts. Uses `countTracks`.
- `renderIndexing(progress)`: Prominent progress display for first-time indexing — progress bar, percentage, current folder path.
- `renderReindexing(show)`: Subtle indicator for background re-index — spinner next to account name. No disruption to the displayed summary.
- `escapeHtml(s)`: Retained from M2.

## 4. CSS Changes (`index.html`)

Add after existing styles. Reuse `.dir-item` and `.dir-list` from M2 for the folder listing.

New classes:
- `.account-header`: Account name display
- `.index-summary`: Stats line (subdued color, 0.85rem)
- `.index-progress`: Progress indicator container
- `.progress-bar` / `.progress-fill`: Thin bar (3px, #0078d4, transition on width)
- `.status-line`: Current indexing status text (subdued, small)

Layout change: when showing data, `#status` should align to the top rather than being vertically centered. Use `#status.data-view` to override to `flex-start`.

## 5. Implementation Order

**Step 1: `indexer.ts`** -- Create with all types, `fetchAccountInfo`, `buildIndex`, `countTracks`, batch helpers, `postprocessBatchResponse`. Largest new file (~250-300 lines). Can be compiled independently.

**Step 2: `index.html` CSS** -- Add M3 styles. Small, independent.

**Step 3: `index.ts` rewrite** -- Replace M2 demo with offline-first flow. Imports from `indexer.ts`, `auth.ts`, `db.ts`, `logger.ts`.

**Step 4: Build + test locally** -- `npm run build` (zero errors). `npm run serve`. Human signs in once. AI validates via Playwright.

**Step 5: Deploy + production test** -- `npm run deploy`. Human tests on iPhone.

**Step 6: Review** -- Code review subagent, KISS/cleanup subagent, update LEARNINGS.md.

## 6. Validation

### Build
`npm run build` must produce zero TypeScript errors.

### Playwright automated tests (via sandbox-escape)
1. Navigate to localhost:5500, verify page loads without JS errors
2. After human signs in: wait for indexing to complete (poll `window.__MYMUSIC_LOGS` for "index complete"), verify track count > 0
3. Reload page: verify cached data renders before network calls (check log: "showing cached" before "fetching /me/drive")
4. Screenshot for visual verification

### Human testing
1. Sign in on localhost:5500, see progress bar during indexing
2. See final summary with accurate track/folder counts after completion
3. Refresh page -- cached data appears instantly
4. Sign out, sign in again -- re-index uses server cache (fast)
5. Close mid-indexing, re-open -- observe faster re-index due to server cache
6. Deploy to production, test on iPhone

### Scale
30k tracks. First indexing: 5-10 min. Re-index with server cache: much faster (most subtrees cached). Summary rendering: <1ms. IndexedDB: ~3-5MB, well within limits.

## Learnings from Example Code

Key patterns carried forward:
- **Shared mutable root**: `MusicFolder` root shared by reference across WorkItems; mutations during START visible to parent at END
- **Batch API limit**: 18 requests per batch (headroom under 20)
- **Cache write encoding**: base64-encode JSON as text/plain for batch PUT (OneDrive batch API bug)
- **302 redirect in batch**: content downloads return 302; must manually follow
- **Merkle-like size validation**: `size` propagates up the folder tree; mismatch at any level means something changed in that subtree
- **Sort toFetch alphabetically**: finishes subtrees faster
- **No pagination**: `$top=10000`; OneDrive has never failed to return all children
- **Cache hit on resume**: each completed subtree writes its own cache file; on resume, those pass the size check and are skipped
