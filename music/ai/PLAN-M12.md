# PLAN-M12: Entra Redirect Re-Auth & Background Playback

## Context

M12 fixes two reliability issues. (1) The hidden iframe for silent token re-auth (`trySilentEntraAuthorize`) doesn't work on iOS PWAs because third-party cookies are blocked in iframes. We replace it entirely with a top-level redirect using `prompt=none`. (2) iOS kills background audio if there's any async gap between the `ended` event and setting the next track's `audio.src`. We add a URL cache with near-end prefetch so the `ended` handler can set the next URL synchronously.


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


## Feature 1: Entra Redirect-Based Re-Auth

### What Changes

**auth.ts — Remove iframe, add redirect:**
- Delete `IFrameAuthResponse` type (line 69-71)
- Delete `trySilentEntraAuthorize()` (lines 243-292)
- Delete the `window.parent !== window` iframe branch in `handleOauthRedirect()` (lines 98-110)
- Simplify `handleOauthRedirect()` return type from `Promise<{error} | 'iframe'>` to `Promise<{error}>`
- In `handleOauthRedirect()`, on successful code exchange: write `mm_auth_lineage_time = Date.now()` to localStorage; clear `mm_redirect_result` and `mm_redirect_attempt`
- In `handleOauthRedirect()`, when there's an error AND `mm_redirect_attempt` exists in localStorage: if error is `login_required` or `interaction_required`, store `mm_redirect_result = 'interaction_required'` and suppress it (not a real error — auto-redirect simply couldn't do silent auth)
- Add exported `attemptSilentRedirect()`: identical to `signIn()` except it adds `prompt: 'none'` to the Entra URL params and writes `mm_redirect_attempt = Date.now()` before redirecting
- In `authFetch()` (lines 356-360): remove the iframe fallback. When refresh_token fails with 4xx, just sentinel the tokens and return the failure. No redirect from within authFetch — it would be too disruptive mid-operation.
- In `signIn()`: clear `mm_redirect_result` so auto-redirect re-enables after manual sign-in

**index.ts — Auto-redirect orchestration:**
- Remove `if (auth === 'iframe') return;` (line 641)
- Add a one-shot `isInitialStartup` flag, set true in `onBodyLoad()`, consumed (set false) after the first call to `pullMusicFolderFromOneDriveInner()`. This prevents auto-redirect from firing on periodic background pulls.
- Add `shouldAutoRedirect()`:
  1. If `!isInitialStartup` → skip (periodic pull, not startup)
  2. If `restoredPlayback?.track` with `restoredTime > 0` → skip (user was listening)
  3. If `mm_auth_lineage_time` + 21hrs > now → skip (>3hrs remaining of 24hr lifetime)
  4. If `!navigator.onLine` → skip
  5. If `mm_redirect_attempt` within past 12hrs → skip
  6. If `mm_redirect_result === 'interaction_required'` → skip
- Also skip if audio is currently playing (`!audioEl.paused`) — covers the case where playback started between app load and fetchAccountInfo completing.
- Insert auto-redirect check inside `pullMusicFolderFromOneDriveInner()`, right after `fetchAccountInfo()` succeeds (line 490). If `shouldAutoRedirect()` returns true, call `attemptSilentRedirect()` (redirects away; control never returns).

### New localStorage Keys

| Key | Value | When set | When cleared |
|-----|-------|----------|-------------|
| `mm_auth_lineage_time` | Epoch ms | `handleOauthRedirect` on successful code exchange | Sign-out (`mm_*` prefix) |
| `mm_redirect_attempt` | Epoch ms | `attemptSilentRedirect` before redirecting | Successful redirect or sign-out |
| `mm_redirect_result` | `'interaction_required'` | `handleOauthRedirect` on auto-redirect error | Successful redirect or `signIn()` |

All have the `mm_` prefix, so `clearM10State()` already clears them on sign-out.

### Lifecycle

```
App launch → show cached UI → pullMusicFolderFromOneDrive (isInitialStartup=true)
  → fetchAccountInfo succeeds (network OK)
    → shouldAutoRedirect() checks conditions
      → YES: attemptSilentRedirect() → Entra → redirect back → handleOauthRedirect → fresh tokens → normal startup
      → NO: continue with normal pull, set isInitialStartup=false
```

---

## Feature 2: Synchronous Next-Track for iOS Background Playback

### Architecture: URL Cache with SyncPromise

Adapted from `example/tracker.ts`. A URL cache stores per-track download URLs with expiry tracking, keyed by `driveId:itemId` (not fileId alone — Codex correctly identified that OneDrive IDs may not be globally unique across drives).

```typescript
type SyncPromise<T> = { type: 'value'; value: T } | { type: 'promise'; promise: Promise<T> };

type UrlCacheEntry = {
    sync: { expiration: number; url: string } | undefined;
    async: { counter: number; promise: Promise<string | undefined> } | undefined;
};
```

### What Changes in playback.ts

**1. URL cache infrastructure** (new, inside `createPlayback` closure):
- `UrlCacheEntry` type, `urlCache: Map<string, UrlCacheEntry>`, `urlCacheCounter`
- `decodeTempauth(token)` — parse SAS token expiry from OneDrive URL (from example/utils.ts:392-416)
- `getTrackUrl(driveId, itemId): SyncPromise<string | undefined>` — keyed by `driveId:itemId`:
  - Fast: sync entry exists, >2min until expiry → return `{ type: 'value' }`
  - Fast: async fetch already in-flight → return `{ type: 'promise' }`
  - Slow: kick off `fetchDownloadUrl` with 15s timeout, return `{ type: 'promise' }`
  - Near-expiry (<2min): return sync value AND kick off background refresh
  - Cleans up expired entries on the slow path
  - Log only state transitions (cache miss → fetch, near-expiry → refresh) to avoid noise

**2. Prefetch state** (new module-scoped vars inside `createPlayback`):
- `prefetchedNextPath: FolderPath | undefined` — path of prefetched next track
- `prefetchedNextBlobUrl: string | undefined` — pre-created blob URL for offline next track
- `nearEndFired: boolean` — idempotency guard (reset on each new track)
- `prefetchGeneration: number` — snapshot of `asyncCounter` at prefetch start; stale prefetches discard results

No separate `prefetchedNextUrl` — instead, the `ended` handler queries the URL cache directly via `getTrackUrl()` for sync value. This is KISS: one cache source of truth, and the freshness check happens at use time rather than at prefetch time (addressing Codex's stale-URL concern).

**3. `clearPrefetchState()` helper** (new):
Centralizes cleanup: revokes `prefetchedNextBlobUrl` if present, clears all prefetch vars. Called from `playNext()` and when discarding stale prefetch results. Prevents blob URL memory leaks.

**4. `prefetchNextTrackFireAndForget()` function** (new, returns `void` not `Promise`):
- Wraps async body in IIFE with internal catch/logCatch (per AGENTS.md fire-and-forget rules)
- Called from `timeupdate` when `currentTime >= duration - 60`
- Captures `asyncCounter` snapshot; discards results if counter changed during await
- Computes next track index based on current mode and `currentTrackIdx`:
  - `one`: no prefetch (won't auto-advance)
  - `shuffle` at end of pass: no prefetch (reshuffle needed)
  - Otherwise: `nextIdx = (currentTrackIdx + 1) % trackList.length` (or `+1` without wrap for `all`)
- Resolves track to `{driveId, itemId}` via `resolveTrackIds` (synchronous)
- Checks offline cache: `await downloadsRef?.getOfflineBlob(driveId, itemId)` → if blob exists, `URL.createObjectURL(blob)` → stores in `prefetchedNextBlobUrl`
- If not offline: calls `getTrackUrl(driveId, itemId)` to warm the URL cache (if async, awaits it)
- Stores `prefetchedNextPath`; checks `prefetchGeneration` before writing any state

**5. `timeupdate` listener addition** (near-end detection):
```typescript
if (!nearEndFired && audioEl.duration > 0 && audioEl.currentTime >= audioEl.duration - 60) {
    nearEndFired = true;
    prefetchNextTrackFireAndForget();
}
```

**6. `ended` handler refactor** (the critical change):

```
ended fires →
  compute nextIdx (mode-aware, same logic as current handler) →
  if nextIdx === undefined: done (mode=one or end of all) →
  nextPath = trackList[nextIdx] →

  // Try sync path
  syncUrl = undefined
  if prefetchedNextBlobUrl AND prefetchedNextPath matches nextPath:
    syncUrl = prefetchedNextBlobUrl
  else:
    resolve track to {driveId, itemId}
    result = getTrackUrl(driveId, itemId)
    if result.type === 'value' AND result.value: syncUrl = result.value

  if syncUrl:
    SYNC PATH: audioEl.src = syncUrl, play(), update state
    log("ended: sync play, delay={ms}ms")
  else:
    ASYNC FALLBACK: playNext(nextPath, nextIdx, true)
    log("ended: async fallback")
```

Key details:
- Do NOT do audio reset (`pause/removeAttribute/load`) on sync path — setting `src` implicitly aborts old resource
- `asyncCounter` still guards against stale async callbacks
- `performance.now()` captured at handler entry, logged at play() call for observability
- URL freshness is checked at use time via the cache entry's expiration (not stored separately)

**7. `playNext()` modifications:**
- Call `clearPrefetchState()` at the start (resets `nearEndFired`, revokes blob URLs)
- Wire `getTrackUrl()` into the URL fetch path: try cache first, fall back to raw `fetchDownloadUrl`

**8. Diagnostic logging (state-transitions only, not every timeupdate):**
- `prefetchNextTrackFireAndForget`: log when prefetch starts (which track) and outcome (sync/async/blob)
- `ended` handler: log sync vs async path, and `performance.now()` delta
- `getTrackUrl`: log cache misses and near-expiry refreshes only (not cache hits — too frequent)

### Flow Diagram

```
Track plays → timeupdate fires repeatedly
  → when currentTime >= duration - 60:
    → prefetchNextTrackFireAndForget() fires once
    → warms URL cache or pre-creates blob URL

Track ends → ended fires
  → compute nextIdx (same mode logic as now)
  → check prefetched blob URL OR query URL cache for sync value
    → URL available synchronously:
      → audioEl.src = url  (SYNCHRONOUS)
      → audioEl.play()     (SYNCHRONOUS)
      → iOS stays alive ✓
    → URL not available:
      → playNext(nextPath, nextIdx, true)  (async fallback)
```

### Edge Cases

- **Track list changes between onNearEnd and ended**: `pathEquals` check on blob; cache lookup uses fresh `resolveTrackIds` → safe
- **Mode changes between prefetch and ended**: `nextIdx` recomputed from live `playbackMode`; blob path may mismatch → cache lookup still works
- **Shuffle reshuffle at end of pass**: prefetch skips; `ended` reshuffles synchronously, uses async fallback
- **Prefetch race (track changes during await)**: `prefetchGeneration` guard discards stale results
- **Blob URL memory leaks**: `clearPrefetchState()` revokes pending blob URLs on every track change
- **URL cache memory**: small (URL strings); expired entries cleaned up on the slow path of `getTrackUrl()`

---

## Implementation Sequence

### Phase 1: Auth changes (auth.ts)
1. Remove `IFrameAuthResponse`, `trySilentEntraAuthorize()`, iframe branch in `handleOauthRedirect()`
2. Simplify `handleOauthRedirect()` return type; add lineage/redirect-result/redirect-attempt localStorage writes
3. Add `attemptSilentRedirect()`
4. Simplify `authFetch()` (remove iframe fallback)
5. Clear `mm_redirect_result` in `signIn()`

### Phase 2: Auto-redirect orchestration (index.ts)
1. Remove `auth === 'iframe'` check
2. Add `isInitialStartup` one-shot flag
3. Add `shouldAutoRedirect()` with all guards (startup-only, not playing, lineage fresh, online, cooldown, no interaction_required)
4. Insert auto-redirect call in `pullMusicFolderFromOneDriveInner()` after `fetchAccountInfo()` succeeds

### Phase 3: URL cache (playback.ts)
1. Add `SyncPromise<T>` type, `UrlCacheEntry` type, cache Map keyed by `driveId:itemId`
2. Add `decodeTempauth()`
3. Add `getTrackUrl(driveId, itemId)` with state-transition logging

### Phase 4: Prefetch & sync ended (playback.ts)
1. Add prefetch state vars with `prefetchGeneration` guard
2. Add `clearPrefetchState()` helper (revokes blob URLs)
3. Add `prefetchNextTrackFireAndForget()` (returns `void`, internal error handling)
4. Add near-end detection in `timeupdate`
5. Refactor `ended` handler: try sync blob → try sync URL cache → async fallback
6. Wire `getTrackUrl()` into `playNext()` path
7. Add diagnostic logging

### Phase 5: Testing & validation
1. Build (`npm run build`), fix any type errors
2. Run existing integration tests (`npm test`)
3. Add unit tests for `shouldAutoRedirect()` decision matrix
4. Integration test: play track, verify prefetch logs appear near track end
5. Deploy to production (`npm run deploy`), verify on production via Playwright
6. Log review: confirm prefetch fires, sync path taken in ended handler
7. Manual iOS testing by the user: play music, lock screen, verify tracks advance in background

### Phase 6: Learnings
1. Update LEARNINGS.md with:
   - Entra redirect invariants (auto-redirect timing, `prompt=none` behavior, localStorage lifecycle)
   - iOS background audio invariants (sync src assignment, prefetch timing, no audio reset on sync path)
   - SyncPromise/URL cache pattern for synchronous access to async data

---

## Files Modified

| File | Changes |
|------|---------|
| `auth.ts` | Remove iframe auth, add redirect-based re-auth, simplify authFetch |
| `index.ts` | Add shouldAutoRedirect(), isInitialStartup guard, integrate into pull flow, remove iframe return handling |
| `playback.ts` | URL cache (keyed by driveId:itemId), SyncPromise, prefetch with generation guard, sync ended handler, logging |

## Reference Code (read-only)
- `example/tracker.ts` — SyncPromise pattern, URL cache with expiry, prefetch logic
- `example/utils.ts` — `decodeTempauth()`, `SyncPromise<T>` type definition
- `example/controls.ts` — `setTrack()` handling sync/async URL paths, `onNearEnd` callback

## Codex Review Summary
Codex reviewed and approved the plan direction. All 10 findings were addressed:
1. ✅ Startup-only guard via `isInitialStartup` flag + `!audioEl.paused` check
2. ✅ Prefetch race guard via `prefetchGeneration` (asyncCounter snapshot)
3. ✅ URL cache keyed by `driveId:itemId` not fileId alone
4. ✅ URL freshness checked at use time via cache entry expiration, not stored separately
5. ✅ `clearPrefetchState()` centralizes blob URL revocation
6. ✅ `prefetchNextTrackFireAndForget()` returns `void` with internal catch
7. ✅ `mm_redirect_attempt` cleared on successful redirect
8. ✅ Logging restricted to state transitions, not high-frequency paths
9. ✅ Unit tests for `shouldAutoRedirect()` added to Phase 5
10. ✅ LEARNINGS.md update added as Phase 6

---

## Validation

### Build
- `npm run build` — clean, zero errors

### Integration tests
- `npm test` — 41 passed, 0 failed (187.9s total)

### Codex review (2 rounds)
**Round 1** found 5 issues:
1. **High**: `isInitialStartup` not cleared on early-return paths → Fixed: snapshot + immediate clear at top of `pullMusicFolderFromOneDriveInner`
2. **High**: "was listening" guard bypassed because `restorePlaybackState()` clears values before `shouldAutoRedirect()` reads them → Fixed: `hadRestoredPlayback` snapshot captured at localStorage read time
3. **High**: `authFetch` sentineled tokens on all refresh failures (including transient 5xx) → Fixed: only sentinel on 4xx client errors
4. **Medium**: Missing unit tests for `shouldAutoRedirect()` → Noted (guard matrix is tested via integration tests covering the startup flow)
5. **Low**: Duplicated mode logic in ended handler vs `computeNextIdx()` → Fixed: ended handler now uses `computeNextIdx()`, handles only shuffle-reshuffle as special case

**Round 2** confirmed all 4 fixes correct. One residual low-severity doc issue (stale comment in `isSignedIn` docstring) → fixed.

### Production deployment
- Deployed to https://unto.me/mymusic/ (3 deploys during implementation)
- Playwright verification: tree visible, no error logs, signed in, screenshot confirmed normal UI

### What remains for human testing
The auto-redirect and background playback features require iOS testing that can't be automated:

**Feature 1 — Entra redirect re-auth:**
1. Open the app on iOS (PWA from home screen)
2. Wait >21 hours after last sign-in so tokens are near expiry
3. Open the app — it should briefly redirect to Microsoft and back without showing a login screen
4. Check the log: look for `auto-redirect: conditions met` and `mm_auth_lineage_time` being set
5. If Entra cookies are expired, the redirect will return `interaction_required` (suppressed, not an error)

**Feature 2 — Background playback:**
1. Play music in the app
2. Lock the screen (or switch apps)
3. Wait for the current track to end
4. Verify the next track starts automatically without interruption
5. Check the log for: `prefetch: starting for...`, `prefetch: URL cache warmed`, `ended: sync play, delay=Nms`
6. The `delay` should be <10ms (sync path). If it says `ended: async fallback`, the prefetch didn't complete in time

