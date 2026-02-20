# ARCHITECTURE

- Typescript, without webpack. The `index.html` contains all HTML and CSS. Code is in `src/index.ts` plus other typescript files.
- Minimal dependencies, framework-free.
- Manual MS Graph auth using PKCE and similar `authFetch`
- The app lets you explore music folders and files in a hierarchical view. It has multiple roots, one for each favorite/playlist, plus one for each OneDrive account you've connected to.
- For speed, it uses an index of each OneDrive account. The index is built locally, stored on the server, but also stored locally in IndexedDB. But you can view a folder even when the index for that folder isn't yet available.

All HTML and CSS live in `index.html`;
all logic lives in TypeScript modules compiled to `dist/`.

## Layers

The code falls into five layers:

1. **Entry / orchestration** — `src/index.ts`, `src/index-startup.ts`, `src/index-sync.ts`: composition root, startup terminal/deadline flow, and sync scheduling/orchestration.
2. **Domain modules** — `src/auth.ts`, `src/indexer.ts`, `src/favorites.ts`, `src/downloads.ts`, `src/tracks.ts`: testable logic with injected deps, no DOM access.
3. **UI components** — `src/tree.ts`, `src/playback.ts`, `src/playback-ui.ts`, `src/select.ts`, `src/modal.ts`: own DOM subtrees/primitives and expose callbacks for wiring.
4. **Persistence primitives** — `src/db.ts` (IndexedDB), localStorage, OneDrive App folder.
5. **Observability** — `src/logger.ts`, `src/logger-web.ts`.

The boundary rule: UI components do not own network concerns. Network and
persistence live in domain modules or are orchestrated by `src/index.ts`.


## Module map

- **index.html** — All HTML + CSS. Single `<script type="module">` loads `dist/index.js`. DOM elements: `#status`, `#tree-container` (`#breadcrumbs`, `#children`), `#settings-container`, `#player` (audio), `#footer`, `#action-bar`, `#select-cancel`, `#log-panel`.
- **src/index.ts** — Composition root orchestrator. Wires modules together, manages view/offline projection.
  - **src/index-startup.ts** — Startup terminal/deadline controller. Owns startup race/latch and startup terminal rendering helpers (sign-in/error/deadline).
  - **src/index-sync.ts** — Sync orchestrator. Owns pull single-flight, periodic/online scheduling, account/share probe/index refresh, and settings sync status projection.
- **src/auth.ts** — OAuth2 PKCE against Microsoft Entra. Exports `authFetch()` — the authenticated fetch wrapper used by every module that talks to Graph API.
- **src/indexer.ts** — Builds the music index by walking OneDrive via batched Graph API. Per-folder cache files on OneDrive enable Merkle-based incremental re-indexing.
- **src/db.ts** — Key-value wrapper around IndexedDB. Two stores: "data" (index and favorites cache) and "audio" (offline audio blobs).
- **src/tree.ts** — Renders the hierarchical folder/file view with breadcrumb navigation. The only module that touches `#breadcrumbs` and `#children` DOM elements.
- **src/playback.ts** — Playback orchestrator. Owns playback state machine and audio element side effects.
  - **src/playback-engine.ts** — Pure functional-style helpers for playback policy/cache. Includes selection/timer/media helpers plus download URL cache and near-end prefetch state machine.
  - **src/playback-ui.ts** — Footer/expansion UI component. Owns footer DOM construction, gestures, and emits playback intent callbacks.
- **src/favorites.ts** — Data model for shortcuts (☆) and playlists (♫). Handles persistence to IndexedDB + OneDrive, healing broken references, cycle detection.
- **src/tracks.ts** — Track list computation. Traverses the index tree (physical) or favorites graph (logical) to produce ordered lists of track paths. Used by both playback and downloads.
- **src/select.ts** — Select mode state machine/orchestrator. Owns selection mode transitions and action-bar flow.
  - **src/select-dialogs.ts** — Select dialog/domain helpers. Resolves selected paths into playlist member refs and related select-dialog data transforms.
  - **src/modal.ts** — Shared modal primitives. Reusable modal/dropdown/input helpers consumed by select/settings UIs.
- **src/settings.ts** — Settings page component. KISS model: `open()` builds DOM fresh, `close()` destroys it, `updateIndexSection()` live-updates the indexing row while open. Sections: OneDrive auth, shared-with-you, timer duration, indexing status + refresh, debug toggle.
- **src/downloads.ts** — Background download engine for offline audio. Manages a queue of `driveId:itemId` keys, two concurrent download slots, quota enforcement, and evidence-based connectivity tracking.
- **src/logger.ts** — Environment-agnostic `log`/`logError`/`logCatch`. Swappable impl.
- **src/logger-web.ts** — Browser quad-write impl (console, window array, DOM panel, localStorage). Initialized by `src/index.ts` at startup.
- **sw.js** — Service worker (plain JavaScript, not TypeScript). Caches the app shell (HTML, JS, images) so the PWA launches offline from the iOS home screen. Cache-first for app shell assets; passthrough for API calls and audio URLs. Lives at the project root (not in `dist/`) because SW scope is determined by its URL path.


## Key abstractions

Three types form the "language" of the app — every module speaks them:

- **`FolderPath`** (`readonly string[]`) — the universal navigation identifier.
  Every path starts with `["OnePlay Music", rootKey, ...]`. The root key is either a
  OneDrive `driveId` (account) or `fav:{uuid}` (favorite). Deeper segments are
  folder/file names for accounts, or synthetic `m:N` segments for playlist
  members. Tree navigation, playback, selection, and state persistence all use
  this single type.

- **`RootsMap`** (`Map<string, Root>`) — the app's "mounted filesystem". Each
  `Root` is a tagged union dispatched on `type: 'account' | 'shortcut' | 'playlist'`.
  Code dispatches on the discriminant, never on string-prefix parsing of keys.

- **`MusicData` / `MusicFolder` / `MusicFile`** — the cached index model.
  `MusicFolder` is recursive with `{ id, children: { [name]: MusicFolder | MusicFile } }`.
  `MusicFile` is a leaf with `{ id }`. The index owns helpers like
  `walkFolder(root, segments)` and `sortedFolderChildren(folder)` for safe
  traversal and canonical display order.


## Startup sequence

`index.html` loads `dist/index.js` and calls `onBodyLoad()` on DOMContentLoaded.

1. **`initWebLogger()`** — Install browser logging.
2. **Restore M10 state** — Read `oneplay_music_view`, `oneplay_music_scroll`, `oneplay_music_playback`, `oneplay_music_time` from localStorage (synchronous, no flash).
3. **`handleOauthRedirect()`** — Process `?code=` if returning from Entra.
4. **Service worker registration** — Register `sw.js` early (before any early returns, so offline shell caching works for signed-out/first-time users too). `SW_DEBUG` mode auto-reloads on SW update.
5. **`ensureFavorites()`** — Create favorites data module and load from IndexedDB cache. No tree dependency — safe to call before tree or account data exists. Concurrency-safe via in-flight promise.
6. **`loadCachedData(driveId)`** — Read MusicData from IndexedDB.
7. **`showTree(data)`** — Create tree + playback + wire callbacks. Calls `wireFavoritesUi()` at the end, which attaches favorites to tree and creates select + downloads modules (once).
8. **`restorePlaybackState()`** — Apply `oneplay_music_playback`/`oneplay_music_time` to playback module.
9. **`pullMusicFolderFromOneDrive()`** — Awaited after cached UI is rendered: calls `ensureFavorites()` again (belt-and-suspenders), syncs favorites from OneDrive, checks index staleness, re-indexes if needed, heals favorites, pushes offline state. Suppressed when `navigator.onLine` is false.

The key design split is `ensureFavorites()` (data module, no tree dependency)
vs `wireFavoritesUi()` (wires to tree, creates select + downloads). This
ensures the favorites module exists before any network pull, fixing the
sign-out → sign-back-in path where `pullFavoritesFromOneDrive` was previously
skipped because favorites hadn't been created yet.

The key principle is **offline-first**: steps 2–8 render from local data
immediately. Step 9 is awaited but runs after the cached UI is already visible.
The user sees content instantly; network is never blocking.


## Module communication

Modules are created as singletons by `src/index.ts` using factory functions
(`createTree`, `createPlayback`, `createFavorites`, `createSelect`,
`createDownloads`). Each factory returns an interface with getters, setters, and
callback slots that `src/index.ts` wires together. No module imports another
module's singleton. Instead, `src/index.ts` passes references and wires callbacks:

- **tree → playback**
  - `tree.onTrackClick` calls `playback.playTrack()`
  - `tree.onPlayClick` calls `playback.playFolder()`
- **playback → tree**
  - `playback.onPlaybackChange` calls `tree.setPlaybackInfo()` so the tree shows chevrons/spinners
- **favorites → everyone**
  - `favorites.onChange` triggers tree re-render, playback context update, select roots update, and offline state recomputation
- **downloads → tree/select**
  - `downloads.onStateChange` updates offline icons on tree rows and refreshes the offline modal if open
- **select → favorites**
  - select calls `favorites.add()`, `.remove()`, `.addMembers()`, `.rename()`, etc. to mutate data
- **playback → downloads**
  - playback calls `downloads.getOfflineBlob()` to check the local cache before streaming from OneDrive

The central dependency-breaking function is `computeAndPushOfflineState()` in
`src/index.ts`. It computes which tracks are pinned (from favorites + index data),
pushes `activeKeys`/`retainKeys` to downloads, and pushes icon state to tree.
This avoids a circular dependency between favorites, downloads, and tree.


## Data flow: index

The music index is a tree of `MusicFolder` and `MusicFile` nodes rooted at the
user's OneDrive Music folder.

- MusicData { size, folder: MusicFolder, count }
  - MusicFolder { id, children: { [name]: MusicFolder | MusicFile } }
    - MusicFile { id }

**Merkle property**: OneDrive computes each folder's `size` as the total bytes
of all descendant files. If any file changes anywhere in a subtree, the `size`
changes propagate up. Comparing cached `size` against live `size` answers "has
anything changed?" without traversal. This is how we know when to re-index.

The index is stored in three places:
1. **IndexedDB** (`index:{driveId}`) — for instant offline startup.
2. **OneDrive App folder** — per-folder cache files for incremental re-indexing.
3. **RAM** — the live `MusicData` object passed to tree and playback.


## Data flow: favorites

Two types of favorites:
- **Shortcut** (☆): a reference to a OneDrive folder (by `driveId` + `path` +
  `id`). Cannot be renamed or have members added.
- **Playlist** (♫): an ordered list of `PlaylistMember` entries, each either an
  `ItemRef` (OneDrive folder/file) or a `FavRef` (reference to another
  favorite).

Favorites are stored in three places:
1. **IndexedDB** (`favorites:{driveId}`) — local cache, instant load.
2. **OneDrive App folder** (`favorites.json`) — durable cloud backup.
3. **RAM** — the live `FavoritesData` object.

Mutations always write locally first (IndexedDB + onChange callback for
immediate UI update), then fire-and-forget an upload to OneDrive via a
dirty-flag coalescing pump (rapid mutations collapse to one upload).

### Synthetic path segments

Playlist members are addressed by synthetic segments like `m:0`, `m:1` in the
path. These are internal identifiers that must never leak to the UI. The
`resolvePathSegmentName()` function centralizes the translation from `m:N` to a
human-readable name (the member's folder/file name or referenced favorite's
name). All code that displays a path segment to the user calls this function.

### Healing

When the index is refreshed, favorites are healed:
1. ItemRefs are matched first by path (prefer stable location), then by
   OneDrive item ID (handles renames).
2. FavRefs pointing to deleted favorites are removed.
3. Two-pass algorithm: first compute surviving IDs, then rebuild the list (so
   forward references aren't incorrectly removed).


## Data flow: playback

Playback has several key concepts:

- **Playback folder**: the folder whose recursive descendants form the track
  list. Set by clicking ▷ on a folder or clicking a track (which sets its
  parent as the playback folder).
- **Track list**: a flat array of `FolderPath` entries (logical paths through
  favorites, not physical OneDrive paths). Physical resolution happens only at
  play time.
- **Playback mode**: `one` | `all` | `repeat` | `shuffle`. Determines
  auto-advance behavior on track end.
- **Per-favorite state**: favorites with "remember my spot" persist their own
  track, position, and mode. Switching favorites saves the outgoing state and
  loads the incoming state.

### Shuffle

Shuffle works in-place on the track list array. This is safe because the tree
UI is independent (it uses path slicing, not list indices), and save/restore
uses path equality. On reshuffle at end of pass, the just-finished track is
moved to [0] and playback continues from [1] to avoid immediate repetition.

### Track list refresh

The track list is refreshed reactively when favorites or roots change (via
`setContext()`), not on every prev/next action. This prevents bugs like
reshuffling on every button press.

### Race prevention

An `asyncCounter` is incremented on every `playNext()` call. After the async
URL fetch, the counter is checked; stale fetches are discarded. Before the
fetch, the audio element is reset (`pause(); removeAttribute('src'); load()`)
to prevent events from the previous track.


## Data flow: downloads

The download engine is decoupled from favorites. It operates on abstract key
sets (`driveId:itemId` strings):

- `setPinnedKeys(activeKeys, retainKeys)`: the caller (`src/index.ts`) computes which
  tracks should be downloaded (active = from unpaused offline favorites) and
  retained (all offline favorites, including paused). The engine downloads
  `active − downloaded` and garbage-collects `downloaded − retained`.
- **Evidence state machine**: tracks connectivity as `no-evidence`,
  `evidence:signed-in`, `evidence:signed-out`, or `evidence:not-online`.
  Downloads only pump when signed in. Error classification consults
  `navigator.onLine` (via `deps.isOnline()`) to choose between `no-evidence`
  and `not-online` on network failures.

  | Consumer | `no-evidence` | `signed-in` | `signed-out` | `not-online` |
  |---|---|---|---|---|
  | downloads pump | stopped | running | stopped | stopped |
  | download ↓ icon | static | animated | static | static |
  | non-cached tracks | normal | normal | grey, no-op | grey, no-op |
  | gear icon | normal | normal | ⚠ | normal |
  | recovery | wait | — | manual sign-in | auto: online event |
- **Generation counter**: bumped on every `abort()` / `recalculate()`. In-flight
  tasks check the counter before any state write. This prevents orphaned tasks
  from corrupting state (e.g., decrementing counters into negative).
- **Error classification**: 404 → remove from queue; 429/503 → push to back;
  timeout → transition to no-evidence; auth error → transition to signed-out.

Audio blobs are stored in IndexedDB's "audio" store. Playback checks the cache
via `getOfflineBlob()` before streaming from OneDrive.


## State persistence (M10)

Two storage layers serve different purposes:

- **localStorage** — Pre-render UI state. Read synchronously, so it's available before first render with no flash of wrong content.
  - `oneplay_music_view`, `oneplay_music_scroll`, `oneplay_music_playback`, `oneplay_music_time`, `oneplay_music_fav:{id}`
- **IndexedDB** — Cache of server data. Read asynchronously.
  - Music index, favorites, audio blobs
`oneplay_music_time` (every 5s) shouldn't re-serialize `oneplay_music_playback` (on track change).

### Cold-start restore

On startup, the app reads persisted state and applies it visually without
loading audio. The audio element has no `src`. The first user tap triggers
`playNext()`, which fetches the URL and seeks to `restoredCurrentTime`. The
restored value is kept until the action fully succeeds (not consumed eagerly).


## Roots model

All top-level entries in the tree share a unified `RootsMap` (Map of string key
→ `Root` object). Root types are distinguished by a `type` discriminant:

- `'account'` — a OneDrive account (key = driveId)
- `'shortcut'` — a favorited folder (key = `fav:{uuid}`)
- `'playlist'` — a user-created playlist (key = `fav:{uuid}`)

Display order: favorites first (in creation order), then accounts (sorted by
key). Display names are resolved at render time from the Root object, never
used as map keys.


## Select mode

A state machine governs three mutually exclusive UI states:

```
NORMAL  ⟷  SELECT  (long-press or right-click enters; Cancel exits)
NORMAL  ⟷  EXPANDED (swipe-up on footer enters; close button exits)
```

EXPANDED and SELECT are mutually exclusive: entering select mode collapses
expanded playback controls; while in select mode, expansion is blocked.

The body element gets a CSS class (`body.select-mode`) to toggle visibility of
the action bar vs. playback footer. This keeps the toggle atomic and CSS-driven.


## Key design patterns

### Factory + callback wiring

Every major module exports a `create*()` factory that returns an interface.
The orchestrator (`src/index.ts`) calls the factories and wires callbacks between
the returned interfaces. Modules never import each other's singletons. This
gives a clear dependency graph and makes unit testing straightforward (inject
mock deps via the factory).

### Offline-first

Every UI render path works from local data. Network operations run in the
background and update the UI reactively when they complete. Failures are
logged, never blocking. The user should always see something useful within
milliseconds of opening the app.

A service worker (`sw.js`) ensures the app shell (HTML, JS, images) is
available even when the network is completely unreachable — critical for
iOS home-screen PWAs, which cannot load without it. The SW uses cache-first
for shell assets and passthrough for all other requests (Graph API, audio
CDN). On deploy, bump `CACHE_VERSION` in `sw.js` to trigger the update
lifecycle.

### Context setter over parameter threading

When multiple functions need the same contextual data (favorites, roots,
accounts), a module-scoped `setContext()` call provides it rather than
threading extra parameters through every function. The setter must be called
after initialization and on every relevant change. This keeps call signatures
stable.

### Fire-and-forget with dirty-flag coalescing

When a fast local write (IndexedDB) and slow remote write (OneDrive) must both
happen on mutation: await the local write and fire onChange immediately, then
fire-and-forget the remote write via a dirty-flag pump. The pump serializes
uploads and coalesces rapid mutations. Functions that are truly fire-and-forget
return `void` (not `Promise<void>`) by wrapping their async body in an IIFE, so
callers cannot accidentally `await` them.

### Logical vs. physical paths

The track list and all path-based operations (chevron navigation, "is this
track in the current folder?") work with logical paths that route through
favorites. Physical resolution (driveId + itemId for fetching a URL from
OneDrive) happens only at play time. This means a track in a playlist is
identified by its position in the playlist, not by its OneDrive location.

### FLIP animation

Navigation transitions (clicking a folder, clicking a breadcrumb) use the FLIP
technique: snapshot element positions before DOM update, replace the DOM,
compute deltas, apply inverse transforms, then animate to final positions. This
gives spatial continuity during navigation.

### Evidence-based connectivity

The app instantiates the evidence model described in `LEARNINGS.md` with four
runtime states: `no-evidence`, `evidence:signed-in`, `evidence:signed-out`, and
`evidence:not-online`. Downloads run only in signed-in evidence, and periodic
pulls are suppressed in signed-out/not-online states.


## Key invariants

- **selectedPath always starts with "OnePlay Music"** and selectedPath[1] is a key in
  the roots map (or the path is reset to the deepest valid prefix).
- **playbackTrack === trackList[currentTrackIdx]** when both are defined.
- **Shortcuts always target folders**, never individual tracks. Enforced at
  add/load time.
- **Cycle detection uses DFS** through FavRef edges, with a visited set copied
  per sibling (DAG sharing is allowed; only ancestor cycles are blocked).
- **activeKeys ⊆ retainKeys** in the download engine (enforced in
  `setPinnedKeys`).
- **Generation counter checked before any state write** in download workers.
  Orphaned tasks skip all mutations.
- **render() is the sole DOM mutation point** for tree content. All state
  changes flow through it.
- **Play/pause button driven by audio events**, not set optimistically in click
  handlers. This prevents desync when `audio.play()` is rejected.
- **No auto-advance on errors.** Auto-advance on audio error causes cascading
  skips. Advance only on natural `ended` event.
- **Scroll listeners guarded against empty containers.** Programmatic
  `scrollTop` on an empty container fires a scroll event with value 0, which
  would corrupt saved scroll positions.


## Architectural don'ts

- **Don't add a global state container.** The code uses explicit module state + callbacks by design.
- **Don't let UI modules call Graph directly.** All fetch logic goes through `authFetch` or a domain module API.
- **Don't hold long-lived IndexedDB connections.** Keep per-call open/close (see `src/db.ts`).
- **Don't fire-and-forget promises from call sites.** If something must be backgrounded, the callee returns `void` and owns all error handling internally.


## App-specific contracts

### Auth and startup contracts

- Auto-redirect for refresh is guarded by startup-only one-shot, prior sign-in
  lineage, freshness/cooldown checks, current online state, no prior
  `interaction_required`, and no active audio playback.
- "Playback in progress" for redirect suppression means active audio output
  (`!audioEl.paused`), not merely restored playback metadata.
- `fetchAccountInfo` doubles as connectivity probe. Any 4xx is evidence the
  server responded; 5xx/timeouts/network exceptions are treated as no
  connectivity evidence.
- In `signed-out` evidence state, Settings presents reconnect (interactive
  auth), not sign-out.
- Refresh-token sentinel invalidation is only for 4xx client failures. 5xx and
  transient network failures do not force token invalidation.
- Startup deadline logic has explicit exceptions:
  - OAuth code-exchange path gets extra budget.
  - First-time indexing bypasses deadline once progress UI is entered.
  - Abnormal startup terminals are logged at error level.
- Startup must always terminate into one structural UI state: visible tree,
  sign-in CTA, or explicit error UI.

### OneDrive/Graph indexing contracts

- Indexing retries use a poison-pill counter with idempotent full-retry
  semantics; retry/abandon decisions are always logged with counts.

### Settings, shares, and refresh UI contracts

- Pull/index operations (startup, periodic, online recovery, manual refresh)
  run through one shared single-flight coordinator.
- App-level status icons are owned by the OnePlay Music row; per-share rows are
  visually quiet except long-running indexing spinner/progress.
- Live status payload additions must be backward-compatible for older test
  hooks and debug callers.
- Share rows with unavailable data (first index pending/probe failure/initial
  build failure) route users to Settings instead of inert empty navigation.
- Settings success copy never masks latest failure; runtime latest-failure wins
  until a new attempt starts.
- "Checking for updates" represents probe/sync phase only, not the full share
  indexing lifetime.
- Semantic row classes stay stable for logic/tests; visual parity uses separate
  styling classes.
- Share-add errors surface Graph-authored `error.message` text.
- Share disconnect copy is impact-aware and shows removal impact sentence only
  when references exist.

### Offline downloads contracts

- Download engine queue keying is per track (`driveId:itemId`), not per
  favorite.
- Queue policy is union of tracks from all unpaused offline favorites; paused
  suppresses contribution from that favorite only.
- `paused` is prioritization state, not durable user intent.
- Error policy:
  - 404: remove from queue.
  - 429/503/transient fetch: push to back for retry.
  - Timeout: transition evidence to no-evidence.
  - Auth failure: transition to signed-out.
  - Other unexpected errors: remove.
- Playback streaming and background downloads are concurrent (no explicit
  playback-vs-download prioritization).
- Favorite popup text reflects offline-marked state only (not download
  sub-states); detailed state lives in modal.
- "Make unavailable offline" is silent about shared-track storage retention;
  storage may remain if tracks are still pinned by other favorites.
- OnePlay Music row spinner covers pull/sync/indexing, not background track
  downloads.
- Favorite download arrow animation means queue membership, not guaranteed
  active-byte transfer.
- Byte totals are only known for already-downloaded tracks; initial mark-offline
  flow shows recursive track count without total-byte guarantee.
- Resume-while-offline only marks dirty intent; queue recompute/pump resumes on
  recovery to signed-in evidence.
- Track-count display in offline modal is recursive through favorite references
  (same logical traversal model as playback).
- Error latches affecting icons/modals clear on connectivity recovery.
- Downloads and periodic pulls are suppressed in terminal evidence states
  (`signed-out`, `not-online`), with `online`/`visibilitychange` recovery
  backstops.

### Tree/search/select/playback contracts

- Legacy ItemRef fallback (`sourceRootKey` absent) matches only account roots;
  favorite roots are excluded from driveId fallback.
- Search mode owns `#breadcrumbs` and `#children` while active; normal tree
  render short-circuits to avoid clobbering search DOM.
- Denied-root filtering is enforced at all traversal boundaries, not only share
  roots.
- If a badge is no longer interactive, remove dedicated hit-area wrapper and
  keep badges as row siblings so row navigation owns tap behavior.
- Playlist creation from selections in a shortcut subtree resolves through the
  shortcut target and stores absolute OneDrive ItemRef paths.
- Folder Play in shuffle mode resets stale `currentTrackIdx` before
  `shuffleTrackList()` (`-1` sentinel first).
- MediaSession registrations are per-action try/catch; `play` action is
  play-only; `setPositionState` is clamped and guarded.

### Local test/validation contracts

- Sandbox-escape bash strings treat `!` as history expansion; scripts with `!`
  are written via heredoc/file before execution.
- Deploy flow forces world-readable server perms (`--perms --chmod=...`) to
  prevent static-asset 403s from restrictive remote umask.
- Deploy counter exists as a human-visible cache-busting confirmation aid.
- Integration tests that intentionally mutate auth/token state run in isolated
  throwaway profiles, not the shared manual sign-in profile.
