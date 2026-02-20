# M14 Shares: Decision-Complete Implementation Plan

## Summary
Implement end-to-end share support with a strict prerequisite refactor to make root resolution share-aware and safe for multiple shares from the same drive. M14 will add durable share persistence (IndexedDB + OneDrive app folder), share indexing, tree/settings wiring, denied-share handling, source-root-aware favorites healing, and share-compatible playback/offline downloads.
This plan includes all user decisions and all three Claude review rounds.

## Public API / Type Changes
1. Add new module `shares.ts`.
- Persisted type `ShareRecordPersisted` fields: `id`, `shareId`, `name`, `rootKey`, `driveId`, `rootItemId`, `addedAt`, `updatedAt`.
- Runtime-only denied state is not persisted.
- Exposed API:
  - `getAll()`
  - `loadFromCache()`
  - `pullFromOneDrive()`
  - `addFromUrl(url: string)`
  - `rename(id: string, nextName: string)`
  - `remove(id: string)`
  - `setDeniedState(rootKey: string, reason: string | undefined)`
  - `getDeniedCount()`
  - `getDeniedReason(rootKey: string)`
  - `computeRemoveImpact(rootKey: string, favorites, roots)`

2. Extend `favorites.ts` `ItemRef`.
- Add optional `sourceRootKey?: string`.
- Invariant: healing must preserve `sourceRootKey` unchanged.

3. Extend `favorites.ts` `Root` union.
- Add `share` root variant with fields: `type: 'share'`, `key`, `name`, `driveId`, `folder?`, `reindexing`.

4. Add shared root-resolution helper module (new `roots.ts`).
- `isWalkableRoot(root)` for `onedrive`/`share` with loaded folder.
- `resolveWalkableRootForItemRef(ref, roots)` with strict fallback:
  - Use `sourceRootKey` first.
  - If absent, allow driveId fallback only when exactly one matching root exists and it is `onedrive`.
  - Otherwise unresolved.

5. Update `indexer.ts` `buildIndex` signature.
- Add explicit drive and cache namespace parameters.
- All children calls use `/drives/{driveId}/items/{itemId}/children`.
- Cache filenames include namespace to prevent collisions.

6. Update `settings.ts` `OpenOptions`/`SettingsShareRow`.
- `SettingsShareRow` fields include share id, label, denied reason text (optional), and row actions (rename/remove).
- `open(...)` receives callbacks for add/rename/remove share actions and indexing progress rows for shares.

7. Update playback URL fetching.
- All playback metadata calls use `/drives/{driveId}/items/{itemId}?$select=@microsoft.graph.downloadUrl`.
- Remove remaining `/me/drive/items/{id}` playback path.

## Implementation Plan

### Phase 0: Prerequisites (must land first)
1. Implement `roots.ts` helper functions and switch all ItemRef resolution callsites in `favorites.ts`, `tracks.ts`, and `select.ts` to use them.
2. Refactor playback URL fetch paths to unified drive-scoped URL behavior in both existing playback fetch paths.
3. Add focused unit tests for these prerequisite changes before share features.

### Phase 1: Share Data Layer
1. Create `shares.ts` with favorites-like persistence pattern.
- IndexedDB key: `shares`.
- OneDrive app-folder file: `shares.json`.
- Use updatedAt conflict resolution exactly like favorites.
2. Use stable root key format `share:{shareId}`.
3. Do not persist raw share URL or encoded token.
4. Keep denied state runtime-only in `shares.ts`, updated via `setDeniedState`.

### Phase 2: Add Share Flow
1. Add-share modal submits URL to `shares.addFromUrl`.
2. `addFromUrl` algorithm:
- Encode URL as Graph share token.
- Resolve via `/shares/{token}/driveItem` with redeem behavior.
- Read stable `shareId`.
- Reject duplicates by `shareId`.
- Reject non-folder share.
- If root facet indicates whole-drive share:
  - Require successful `/drives/{driveId}/special/music`.
  - If it fails, reject add-share.
- Derive initial display name:
  - whole-drive/music-root: owner display name if available, else folder name.
  - other shares: shared folder name.
- Persist share, add root immediately, start background indexing.

### Phase 3: Root Model + Tree + Select Integration
1. Extend tree root ordering to explicit 3-way partition:
- favorites first
- accounts second
- shares third in creation order (`addedAt` sorted before root insertion)
2. Share root row behavior:
- Non-selectable at depth 2.
- Spinner while share reindexing.
3. Gear warning condition:
- signed-out evidence OR any denied share.
4. `select.ts` ItemRef creation:
- For share-origin selections, set `sourceRootKey`.
- For account-origin selections, omit `sourceRootKey`.
- Share root itself remains non-selectable, children selectable.

### Phase 4: Indexing and Refresh Pipeline
1. Extend startup/pull orchestration in `index.ts`.
- Load share records and cached share indexes before first render.
- Render available share roots from cache offline-first.
2. Pull cycle behavior:
- Primary probe + share probes run concurrently.
- Probe failure on share updates denied state only.
- Global evidence transitions continue to be based on primary account only.
3. Build ordering:
- Primary index build first when stale.
- Then share builds sequentially in share creation order.
4. Share index storage:
- IDB key `index-share:{shareId}`.
- App-folder cache namespace includes share identity and cannot collide with primary.
5. Build composite healing maps from all currently loaded root folders (cached or fresh), not only roots rebuilt in this pull.

### Phase 5: Favorites Healing Rules
1. Update `favorites.heal(...)` signature to accept:
- per-root id maps
- denied root set
- explicit removed root set
2. Healing rules:
- `sourceRootKey` refs heal only against that root map.
- Legacy refs without `sourceRootKey` use strict account-only fallback.
- If any denied share exists, unresolved share-backed refs/shortcuts are preserved.
- If ref points to denied root, preserve unchanged.
- If root was explicitly removed, refs with that `sourceRootKey` are removed.

### Phase 6: Denied Share UX/Behavior
1. Settings rows show denied reason under share name.
2. Tree keeps denied shares browsable when cached folder exists.
3. Tracks under denied share are unavailable/grey/unplayable even when signed in.
4. Denied share with no cached folder displays row but has no children expansion.
5. Share-denied state never mutates auth evidence state.

### Phase 7: Remove Share Flow
1. Remove modal text: `This will remove N tracks from M favorites.`
2. `N` counting rule:
- unique physical tracks (`driveId:itemId`) contributed by that share.
3. `M` counting rule:
- favorites containing at least one contributed track from that share.
4. On confirm:
- remove share record
- clear denied state for that root
- remove share root from tree
- remove local share index key
- best-effort remote share cache cleanup
- run healing with explicit removed root set
- persist and rerender.

## Test Cases and Scenarios

## Unit Tests
1. `shares` add flow parsing and validation:
- valid folder share
- duplicate `shareId` rejection
- non-folder rejection
- whole-drive special/music required and rejection path
2. `roots` resolution helper:
- `sourceRootKey` primary resolution
- strict legacy fallback behavior
- ambiguous same-drive fallback rejection
3. `favorites` healing:
- preserve share refs/shortcuts when denied exists
- remove refs for explicitly removed share root
- preserve `sourceRootKey` across heal-by-path/heal-by-id
4. `tracks` with same-drive multi-share:
- no cross-share mis-resolution
- share-origin refs resolve with `sourceRootKey`
5. playback URL tests (or targeted integration assertions) confirming drive-scoped endpoint usage.

## Integration Tests (`test/integration/tree.test.cjs`)
1. settings add-share modal wired to real behavior (not M13 no-op).
2. share root appears in tree after add and is ordered after accounts.
3. share root non-selectable; share children selectable.
4. rename share in settings updates settings + tree.
5. remove-share modal shows `N tracks / M favorites` and removal updates tree/settings.
6. share indexing spinner appears per share row.
7. denied synthetic scenario:
- warning icon on gear
- denied reason visible in settings
- denied tracks unavailable
- primary OneDrive remains usable.
8. share-based shortcut/playlist creation and playback.
9. share-based offline download and playback from cache.
10. share failures do not force signed-out evidence.

## Required Validation Workflow
1. `npm run build`
2. `npm run test:unit`
3. `npm run deploy` before Playwright integration runs
4. integration fast-pass with timeout and log:
- tell user `/tmp/mymusic-test.log`
- run `timeout 45 npm test -- "settings|share|denied"`
- inspect log immediately
5. full integration run local
6. production integration run with `MYMUSIC_TEST_URL=https://unto.me/mymusic/`
7. real-share manual+automated cycle validation:
- add share
- browse/index
- rename
- create favorite
- play
- offline pin/play
- remove share
8. collect and record metrics:
- primary probe duration
- per-share probe/build durations
- tracks indexed per share
- remove-impact counts
- denied-state recovery timing.

## Assumptions and Defaults
1. Whole-drive shares are accepted only if `/special/music` is accessible; otherwise add-share is rejected.
2. Duplicate shares are defined by `shareId` and are rejected.
3. Share roots use stable key `share:{shareId}`.
4. Denied state is runtime-only and cleared when probe succeeds.
5. `sourceRootKey` is required for all new share-origin ItemRefs.
6. Legacy ItemRefs never cross-resolve into share roots via driveId fallback.
7. Share ordering is creation order (`addedAt`), not raw map insertion randomness.
8. Share persistence follows milestone requirement: IndexedDB + OneDrive app folder sync.
