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


### Bundled iOS library

The Xcode target under `ios/` compiles the same TypeScript and serves the selected shell files at `oneplay://app/music/index.html`. Each main document gets one WKWebView and one bridge. A reload or WebKit process exit cancels its library requests and releases unread response files. The native account and player live outside the view. The hosted PWA keeps its service worker, browser PKCE client and HTML audio player.

Swift pairs an MSAL home account with its Graph drive ID. Startup reads that pairing locally, and the page can render the corresponding IndexedDB index before sync. Swift owns account verification, access-token renewal and network evidence. The page receives Graph responses through `native-library.ts`. Large bodies stay in a temporary file while the page acknowledges 256 KiB chunks. The batch indexer's content follow uses the transport that received the redirect.

In the bundled app, tapping Expire in Settings > Debug simulates MSAL requiring interaction. The native account rejects silent acquisition until interactive reconnect verifies the same drive, or the app process ends. The simulation preserves Keychain credentials and cached library data.

Swift records auth and media-renewal diagnostics independently of the Debug switch. It atomically queues up to 200 sanitized events on the device, then signals the bundled page. The page pulls after its last rendered ID on a signal or foreground return. Each new page starts with an empty cursor and replays the retained window. Swift keeps the durable copy through delivery. The Logs button in Settings > Debug opens the panel, which exposes the last 200 Swift events separately from the 300 JS entries. Sign-out clears the native queue and the WebKit store.

Sign-out records cleanup and the device theme before it yields. Startup completes pending cleanup before loading a page. The marker survives until playback, temporary files, the account's WebKit data and private Keychain credentials have been cleared. Indexed MP3 playback uses the signed target's range decoder. The Debug build provides listening checks from a selected recording or the Files picker.

The bundled library walks the selected physical folder or nested favorite in display order. Each track has a stable occurrence key and its current row path. Swift owns canonical order, shuffle passes, the audible occurrence, the prepared successor and the sleep deadline. Snapshots describe the audible track and never send the queue back with a position update. A web view can disappear while the native player advances. Its replacement samples the live session before painting the drawer. The hosted PWA keeps its audio element and uses the same controls.

The iOS player uses a nonmixable playback session with spoken-audio mode for every recording, including music, and long-form routing for AirPlay and Bluetooth output. Swift takes audio focus when PCM is ready. System transport keys act on the audible occurrence. iOS receives the cleaned track title, album and a position/rate pair on playback changes while WebKit can be suspended. Control Center and the Lock Screen receive the audible recording’s embedded front cover or the OnePlay app icon. The artwork worker reads the pinned MP3 or its versioned streaming prefix without starting a transfer. Output selection is available through Control Center.

A system interruption parks the decoder at its last observed render position, retaining its occurrence, successor and media admission. Automatic resume requires an iOS recommendation, the same interrupted occurrence, and a live sleep deadline if Timer is armed. A subsequent Pause, an output disconnect or a media-services reset withdraws that permission. Graph replacements preserve the render position and leave a paused session parked.

A native session assigns a slot to each occurrence. Its render anchors carry the pass and the specific play of that occurrence. Edits that preserve the immediate successor keep the decoder running. When an edit changes already prepared audio, Swift stops the old node and opens the current recording at its sampled position using its admitted media and cached bytes. If the current row disappears, its old pass determines the first surviving neighbor. A confirmed revoked source stops immediately. Large queues cross WebKit in groups of up to 512 entries and commit together. [Phase 5 plan](PLAN-M17-ios.md) · [Playback measurements](../../experiments/ios-playback/Evidence/phase5/BUFFERING.md)

Swift saves the live queue and each private favorite in Application Support under the MSAL home-account and Graph drive pairing. The structural file holds the catalog, canonical order, current pass, held-song neighbors, chosen Shuffle boundary, mode, timer setting and a complete restart point. A serial writer atomically replaces it. Five-second position checkpoints identify the structural generation, occurrence and slot. An unreadable or mismatched checkpoint falls back to the structural point. Source access survives a restart. Sign-out drains the writer before removing the account files.

A fresh app process restores paused. Its decoder waits for Play before activating audio or requesting media. A replacement web view reads the existing player. Folder Play matches a private bookmark by occurrence key in the newly selected queue, including after a row moves. A track tap starts that occurrence at zero, and folder Play in Shuffle draws a fresh pass. TypeScript supplies the favorite’s configured mode and migrates old bundled localStorage and IndexedDB positions through a complete cached library projection. New native positions are written only by Swift.

Swift persists source access and its revision together under the account pairing. A WebKit document proposes a change against the revision it read. A verified share probe can allow or deny that source, and an explicit disconnect withdraws it locally. The account and document identity qualify pending requests. A retired account proof or an older probe cannot change access after a newer decision. The player checks access on queue commit and on cold restore.

Native playback owns one account-scoped URLSession and a 40 MB in-memory compressed-byte pool. Decoder replacement retains versioned blocks, and sign-out replaces the pool. The live network path governs forward range size. During metered playback the reader aims 45 seconds past decoded PCM in the current track, with a 2 MiB read-ahead cap per request. During a metered scrub, the first cache miss can stream through Core Audio’s estimated target plus the normal 256 KiB window. The immediate successor’s URL is resolved when the current track begins. With three seconds of current PCM queued, the low-priority successor worker can read a 256 KiB opening and a decoder tail probe on either route. Manual-only modes prepare the same Next target while retaining their stop-at-end behavior. On unmetered Wi-Fi the rolling 6 MB window spans the current track and its immediate successor. Missing blocks before the playhead do not gate successor preparation. The account reuses recent signed URLs across seeks, selections and natural joins. A missing range uses that URL directly, and a CDN rejection triggers renewal on demand. Playback transitions and command replies share one sequence number so delayed replies cannot repaint stale indicators. [Fetching algorithms and validation](AUDIO-FETCHING.md) · [Listener interaction review](INTERACTIONS.md)

### Offline recordings on iOS

The favorite action bar edits the shared pin intent. The bundled page resolves each favorite to physical drive/item keys grouped by source root. A partial index, inaccessible share or reference awaiting healing preserves that owner's previous files. Swift stores owners under the native account pairing. A durable fence suspends obsolete work across a favorite edit and a process exit. The next authoritative library projection releases it.

Swift schedules two pin transfers in a background URLSession. Each task has an account binding and a durable task ID. The file must match the Graph length and open as audio before Swift records its expected length and version and moves it into the account’s backup-excluded Audio directory. A decoder can retain its open file through unpin, pause and seek. Sign-out closes admission before account cleanup. On foreground return the page pulls missed inventory revisions. Normal completions update counts through reverse membership, without walking the library again. [Native downloader](../ios/App/OfflinePins.swift) · [Shared UI projection](../src/native-pins.ts)

## Module map

- **index.html** — All HTML + CSS. Single `<script type="module">` loads `dist/index.js`. DOM elements: `#status`, `#tree-container` (`#breadcrumbs`, `#children`), `#settings-container`, `#player` (audio), `#footer`, `#action-bar`, `#select-cancel`, `#log-panel`.
- **src/index.ts** — Composition root orchestrator. Wires modules together, manages view/offline projection.
  - **src/index-startup.ts** — Startup terminal/deadline controller. Owns startup race/latch and startup terminal rendering helpers (sign-in/error/deadline).
  - **src/index-sync.ts** — Sync orchestrator. Owns pull single-flight, periodic/online scheduling, account/share probe/index refresh, and settings sync status projection.
- **src/auth.ts** — OAuth2 PKCE against Microsoft Entra. Exports `authFetch()` — the authenticated fetch wrapper used by every module that talks to Graph API.
- **src/indexer.ts** — Builds the music index by walking OneDrive via batched Graph API. Per-folder cache files on OneDrive enable incremental re-indexing by folder path.
- **src/db.ts** — Key-value wrapper around IndexedDB. Two stores: "data" (index and favorites cache) and "audio" (offline audio blobs).
- **src/tree.ts** — Renders the hierarchical folder/file view with breadcrumb navigation. The only module that touches `#breadcrumbs` and `#children` DOM elements.
- **src/playback.ts** — Playback orchestrator. Owns playback state machine and audio element side effects.
  - **src/playback-engine.ts** — Pure functional-style helpers for playback policy/cache. Includes selection/timer/media helpers plus download URL cache and near-end prefetch state machine.
  - **src/playback-ui.ts** — Footer/expansion UI component. Owns the footer DOM, pointer capture and drag preview. The player samples the media clock on expansion and gives each drag a seek callback bound to the play counter and source at press. A track change discards the preview on movement and invalidates release even if the pointer stayed still.
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

The primary and shared-root probes request fresh metadata with `cache: 'no-store'`.
Build 251's schema 1 uses a root `index.json` in each cache namespace. A subfolder's
filename joins its path segments with underscores, so `A/B` and `A_B` both map to
`A_B.json` by design. Reuse uses the schema version and recursive byte count.
OneDrive can take several minutes to propagate that size to ancestors.

In a OneDrive Personal test on 2026-11-24, Graph still reported the old Music
total 2m 31s after creating `Music/Pop/Queen/alpha.mp3`. The saved Queen index
contained the file by 3m 34s and the full Music index by 3m 40s. These
end-to-end timings include polling and rebuilding. The exact propagation time
and its upper bound are unknown.

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

An ItemRef can be rewritten or removed only after sync confirms its own root's
current, complete index or the user explicitly disconnects that root. An old
visible cache or an inaccessible share cannot establish that a track was deleted.

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
- **Queue entries** carry a stable occurrence key, a logical path for the tree, the source root, physical drive/item IDs, title and album. The shared library walk distinguishes two playlist routes to the same recording.
- **Playback modes** are One, All, Repeat, Shuffle and Timer. Each player owns its current pass, the audible occurrence and the natural-end policy.
- **Remember my spot** saves the outgoing position for each private favorite. Folder Play resumes a surviving occurrence, an explicit track tap starts at zero, and Shuffle starts a fresh pass.

### Playlist edits

Each player matches the audible occurrence against the revised queue by key. A surviving recording keeps its media position as its row moves. A removed recording retains its title and playback controls while its tree indicator disappears. Previous and Next search its former neighbors for a surviving playable occurrence. A structural edit fences advancement until the replacement queue is ready. Revoking access to the audible source stops it immediately.

A row-only change preserves the browser's shuffle order and updates the paths in that order. A membership change starts a new permutation with the surviving current occurrence first. Leaving Shuffle restores canonical order.

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
The browser writes the occurrence key and folder key with each global or private position. The five-second global checkpoint carries the playback generation, which also distinguishes repeated plays of one occurrence. Old numeric checkpoints apply only to path-only structural records. The browser resolves legacy localStorage and IndexedDB positions against its cached library. A moved key maps to the new row and a missing key discards its position. While an edit is pending, the global record can recover the removed recording and its former neighbors. Large neighbor lists are stored in the existing IndexedDB data store.

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

- Each folder gets one children listing with `$top=10000`. The indexer consumes that page. This per-folder limit is deliberate. [Original indexing decisions](PLAN-M3.md#learnings-from-example-code)
- Index requests bound their retry and backoff time. Whole-index rebuilds stop after three consecutive failures without batch progress or six attempts in all. A share disconnect waits for a dispatched cache write to settle before deleting the share cache.

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
