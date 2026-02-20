Phase 1 executed as requested: information gathering only, no code edits, no file writes.

## Primary framing: latch + immediate model
Policy vocabulary:
- `Immediate`: show now in the active UI context.
- `Latched`: materialize/update a `LatchedIssue` in runtime state owned by a module; re-render until user remediation succeeds.
- `Log-only`: developer-visible only, unless escalated to a user-impacting state.

Evidence model vocabulary:
- `ErrorEvent`: an observed failure occurrence (the only directly observable unit).
- `LatchedIssue`: app-local issue state inferred from one or more `ErrorEvent`s, used for persistent user surfacing and recovery.

### Common principles (both latch + immediate)
1. Logs capture full technical detail for developer reconstruction (error code, context, and stack/callstack when available).
2. User sees a technical but actionable message (for network failures: status code and server message/body summary when available).

### Latch principles
1. The `LatchedIssue` is visible to the user somewhere in-app.
2. User has an explicit way to retrigger/recover after remediation.
3. If detailed text is not always visible, a top-level indicator still signals unresolved issues.

### Immediate principles
1. It is shown immediately in context.
2. It causes no hidden side effect beyond failing that operation.
3. It occurs directly from a user-initiated action the user understands just failed.
4. The user can retry after remediation (or an equivalent explicit recovery action exists).

Exception: startup terminal and global crash errors are system-triggered immediate lanes; they must still present explicit recovery actions (`Reload`, `Reconnect`, or equivalent).

### Latch registry (owner + user remediation)
| Lane | Runtime owner (where `LatchedIssue` is stored) | User surfaces | User remediation | Status |
|---|---|---|---|---|
| Auth evidence | `auth.evidence` in `music/src/auth.ts` | OnePlay row warning icon/glyph, settings reconnect state, offline gating | Reconnect sign-in; restore connectivity | Implemented |
| Index/probe health | `latestIndexFailure` in `music/src/index-sync.ts` | Settings index line (`Last refresh failed...`), OnePlay warning icon | `Refresh now`; `Reload` if startup-blocking | Implemented |
| Share access denial (per share root) | `deniedByRootKey` in `music/src/shares.ts` | Settings denied reason line, OnePlay warning icon, denied-track behavior | Reconnect / restore permissions / disconnect bad share | Implemented |
| Download subsystem health | `lastError` in `music/src/downloads.ts` (+ evidence/quota state) | Offline modal warning line and controls | Resume/retry, reconnect, get online, adjust quota | Implemented |
| Sync health (favorites/shares cloud sync) | **Missing latch today** (currently log-only in favorites/shares upload/pull paths) | None consistently | Missing explicit remediation surface | **Gap** |

### Immediate registry (exhaustive for current table rows with `Immediate` policy)
| Candidate code | Immediate type | Current surface | Principles check | Status |
|---|---|---|---|---|
| `ERR_STARTUP_MUSIC_FOLDER` | System-triggered startup terminal | Startup status error | P1/P4 expected; exception lane | Needs technical code + reconnect/reload action wording |
| `ERR_STARTUP_INDEX_BUILD` | System-triggered startup terminal | Startup status error | P1/P4 expected; exception lane | Needs explicit technical wording |
| `ERR_STARTUP_DEADLINE` | System-triggered startup terminal | Startup reload screen | P1/P4 expected; exception lane | Mostly aligned |
| `ERR_STARTUP_UNHANDLED` | System-triggered startup terminal | Startup reload screen | P1/P4 expected; exception lane | Mostly aligned |
| `ERR_RUNTIME_UNHANDLED` (startup path) | System-triggered startup terminal | Missing global capture | Fails P1 today | **Gap**: add global handlers + terminal routing |
| `ERR_SETTINGS_AUTH_ACTION` | User-initiated | Settings action | Fails P1/P4 today (settings closes) | **Gap** |
| `ERR_PLAYBACK_MEDIA` | User-initiated playback action path | Playback surface (implicit) | Fails P1/P4 today | **Gap** |
| `ERR_PLAYBACK_URL_RESOLVE` | User-initiated playback action path | Playback surface (implicit) | Fails P1/P4 today | **Gap** |
| `ERR_FAVORITES_ADD_REJECTED` | User-initiated modal/select action | Often silent | Fails P1 | **Gap** |
| `ERR_INDEXER_BATCH` (no-cache branch) | System-triggered startup terminal | Startup error path | P1/P4 expected; exception lane | Needs technical wording consistency |
| `ERR_DOWNLOAD_TRANSIENT` | User-visible ongoing operation | Offline modal warning | P1/P4 mostly met; P3 partly indirect | Keep, with clearer retry wording |
| `ERR_DOWNLOAD_TIMEOUT` | User-visible ongoing operation | Offline modal warning | P1/P4 mostly met; P3 partly indirect | Keep, with clearer retry wording |
| `ERR_SHARE_MODAL_CANCEL_INFLIGHT` | User-initiated modal action | Modal closes while op may continue | Fails P2/P3 | **Gap** |
| `ERR_MODAL_ACTION` | User-initiated modal action | Inline modal message | Mostly aligned | Keep |
| `ERR_PLAYBACK_NO_PLAYABLE` | User-initiated play action | `alert(...)` | Weak P1/P4 UX | **Gap**: replace with inline actionable UI |
| `ERR_SHARES_ADD_VALIDATION` | User-initiated modal action | Inline modal validation error | Mostly aligned | Keep |

## Audit Summary
- `logError` callsites: `62`
- `logCatch` callsites: `30`
- `throw new Error(...)` callsites: `13`
- `alert(...)` callsites: `1`
- Global crash capture (`window.error` / `unhandledrejection`): **none found**
- `logError` with `errorDetail(...)` (stack-capable): `11/62`
- `logError` without stack detail: `51/62`

## Classification Table (with desired policy)
Rows classify `ErrorEvent` types. `Desired policy = Latched` means those events must create/update a `LatchedIssue`.

| Sev | Candidate code | Location | Trigger | User visibility now | Recovery action now | Logging quality | Desired policy |
|---|---|---|---|---|---|---|---|
| P0 | `ERR_RUNTIME_UNHANDLED` | `music/src/index.ts:848` | Unhandled runtime throw/rejection | None | None | No global capture | `Immediate` fatal if startup, otherwise `Latched` issue in settings + warning icon; always capture stack via global handlers |
| P1 | `ERR_STARTUP_MUSIC_FOLDER` | `music/src/index-sync.ts:444` | Music folder fetch fails with no cache | Startup text only | None | Status logged; no stack | `Immediate` startup error with technical code and action (`Reload`, `Reconnect` when signed-out) |
| P1 | `ERR_STARTUP_INDEX_BUILD` | `music/src/index-sync.ts:504` | Initial indexing fails with no cache | Startup text only | None | Failure logged with stack | `Immediate` startup error with action (`Reload`) and technical code |
| P1 | `ERR_SETTINGS_AUTH_ACTION` | `music/src/settings.ts:259` | Reconnect/signout action fails | Settings closes, no inline error | None in UI | Logged via `logCatch` only | `Immediate` inline settings error; keep settings open and allow retry |
| P1 | `ERR_PLAYBACK_MEDIA` | `music/src/playback.ts:691` | Audio element error | No technical user message | Implicit manual retry only | Logs code/message only | `Immediate` playback-surface message + local retry action |
| P1 | `ERR_PLAYBACK_URL_RESOLVE` | `music/src/playback.ts:895` | Track URL missing/not found | No user message | None explicit | Logged only | `Immediate` playback-surface message + retry/open-settings action |
| P1 | `ERR_FAVORITES_ADD_REJECTED` | `music/src/favorites.ts:611` | Cycle/invalid shortcut add | Usually silent in UI | None explicit | Logged only | `Immediate` modal/inline validation error at action site |
| P1 | `ERR_PERSISTENCE_SWALLOWED` | `music/src/index.ts:470` | localStorage write failure | None | None | No log (swallowed) | `Log-only` with code/context (path/key), no user interruption |
| P1 | `ERR_DB_FALLBACK_SILENT` | `music/src/index.ts:60` | IndexedDB read failure fallback | None | None | No log (swallowed) | `Latched` non-blocking warning in settings + `Log-only` details |
| P2 | `ERR_STARTUP_DEADLINE` | `music/src/index-startup.ts:188` | Startup deadline exceeded | Startup reload screen | Reload | Error logged | Keep `Immediate` startup fatal + reload |
| P2 | `ERR_STARTUP_UNHANDLED` | `music/src/index-startup.ts:170` | startup promise throws | Startup reload screen | Reload | Stack logged | Keep `Immediate` startup fatal + reload |
| P2 | `ERR_AUTH_REDIRECT_EXCHANGE` | `music/src/auth.ts:509` | OAuth code exchange timeout/http/parse | Not directly surfaced as technical UI | Usually sign-in/retry path | Logged; user message mostly absent | `Latched` auth issue + reconnect CTA; `Immediate` only when startup-blocking |
| P2 | `ERR_AUTH_REFRESH_4XX` | `music/src/auth.ts:405` | refresh token client failure | Signed-out evidence/warning icon path | Reconnect in settings | Logged (no stack) | Keep `Latched` signed-out policy + reconnect action |
| P2 | `ERR_AUTH_REFRESH_TRANSIENT` | `music/src/auth.ts:409` | refresh transient failure | Usually degraded behavior only | Implicit later retry | Logged (no stack) | `Latched` transient auth/network issue in settings, non-blocking |
| P2 | `ERR_INDEX_PULL_FAILED` | `music/src/index-sync.ts:705` | Pull wrapper fails | Sometimes in settings failure, sometimes not | Refresh now | Stack logged | `Latched` index failure row + explicit `Refresh now` |
| P2 | `ERR_INDEX_PROBE_FAILED` | `music/src/index-sync.ts:529` | Share probe non-denied failure | Settings “Last refresh failed” + warning icon | Refresh now | Status + detail logged | Keep `Latched` settings/share failure + refresh action |
| P2 | `ERR_INDEX_SHARE_DENIED` | `music/src/index-sync.ts:522` | Share 401/403/404 | Warning icon + denied reason text | Reconnect/remove/refresh | Logged mostly as info; no stack | Keep `Latched` denied-share state + reconnect/remove actions |
| P2 | `ERR_INDEXER_BATCH` | `music/src/indexer.ts:471` | Batch transport/parse/shape failure | Surfaces via index failure row/startup path | Refresh now / reload | Rich error strings, thrown upward | `Immediate` if no cache; otherwise `Latched` index failure with refresh action |
| P2 | `ERR_INDEXER_CHILDREN` | `music/src/indexer.ts:367` | Per-folder children error body | Not clearly visible, may continue partial work | None explicit | Logged only | `Latched` partial-index warning + refresh action |
| P2 | `ERR_DOWNLOAD_TRANSIENT` | `music/src/downloads.ts:338` | fetch/network transient | Offline modal warning/icons | Resume / wait / reconnect | Stack logged via `errorDetail` | Keep `Immediate` offline-modal warning + resume/retry actions |
| P2 | `ERR_DOWNLOAD_AUTH` | `music/src/downloads.ts:384` | Download 401 | Signed-out evidence + warning icon | Reconnect | Logged (status only) | Keep `Latched` signed-out evidence + reconnect action |
| P2 | `ERR_DOWNLOAD_TIMEOUT` | `music/src/downloads.ts:379` | 408/504 classification | Offline modal warning/icons | Resume/retry | Logged (status only) | Keep `Immediate` offline-modal warning + resume/retry |
| P2 | `ERR_DOWNLOAD_RECALC` | `music/src/downloads.ts:244` | Queue recalculation/storage ops fail | Usually none, unless lastError set elsewhere | None clear | Often logs raw `${e}`: weak stack/ctx | `Latched` offline subsystem warning + retry/resume action |
| P2 | `ERR_DOWNLOAD_NO_URL` | `music/src/downloads.ts:303` | Missing downloadUrl metadata | No explicit technical UI message | None explicit | Logged only | `Latched` in offline modal/status + non-blocking skip behavior |
| P1 | `ERR_SHARE_MODAL_CANCEL_INFLIGHT` | `music/src/modal.ts:101`, `music/src/settings.ts:303`, `music/src/settings.ts:322`, `music/src/settings.ts:370` | User clicks Cancel (or backdrop) while share action is in-flight | Modal closes immediately; rename/disconnect may continue in background | Ambiguous: user expects cancel to stop operation | No explicit audit log for "continued after cancel" path | Split policy by action type: `abortable` actions use abort-and-close; `non-abortable` actions disable cancel/backdrop while pending and show "Cannot cancel this step" |
| P2 | `ERR_SHARE_ACTION_PARTIAL_REMOTE` | `music/src/index.ts:398`, `music/src/index-sync.ts:367`, `music/src/shares.ts:138` | Share remove/rename succeeds locally but remote sync/cache cleanup fails | UI often looks successful; failure mostly log-only | No direct user-facing retry in same context | Background log only | `Latched` settings issue: "Saved locally; cloud sync pending/failed" with explicit retry action |
| P3 | `ERR_MODAL_ACTION` | `music/src/modal.ts:140` | Modal confirm callback throws | Inline modal error text | Retry/cancel available | Message shown; logging optional by caller | Keep `Immediate` inline modal error; require log at caller boundary |
| P3 | `ERR_PLAYBACK_NO_PLAYABLE` | `music/src/index.ts:458` | Folder play blocked in terminal evidence | `alert("No offline tracks...")` | Dismiss alert; reconnect | Not logged as structured app error | Replace with `Immediate` inline non-alert message + open-settings/offline action |
| P3 | `ERR_SHARES_ADD_VALIDATION` | `music/src/shares.ts:196` | Invalid/duplicate/unsupported share URL | Inline modal error text | Fix input, retry | Good message surface | Keep `Immediate` inline modal validation |
| P3 | `ERR_SHARES_SYNC_BG` | `music/src/shares.ts:155` | Background share save/load failures | Usually silent in UI | None explicit | Logged only | `Latched` settings share-sync warning, non-blocking |
| P3 | `ERR_FAVORITES_SYNC_BG` | `music/src/favorites.ts:551` | Background favorites save/load failures | Usually silent in UI | None explicit | Logged only | `Latched` settings favorites-sync warning, non-blocking |

## Cross-cutting findings
1. Stack/context gap is large: most error logs are string/status only; only a minority include `errorDetail(...)`.
2. User-recovery gap is concentrated in startup no-cache failures, playback failures, settings auth action failures, and persistence failures.
3. Background sync failures (favorites/shares/index subpaths) are frequently logged but not surfaced with direct user actions.
4. Several storage failures are intentionally swallowed with no logging, making developer reconstruction difficult.
5. Modal cancel semantics are currently inconsistent: some in-flight operations are truly abortable while others continue after the modal closes.
6. Share operations have local-vs-remote split behavior where local success can mask remote sync/cache-cleanup failure.
7. Sync health lacks a dedicated latch owner today (favorites/shares cloud sync failures are mostly log-only).
8. Existing good recovery surfaces already present: startup reload screen (`music/src/index-startup.ts:113`), sign-in gate (`music/src/index-startup.ts:148`), settings refresh CTA + failure line (`music/src/settings.ts:185`, `music/src/settings.ts:405`), modal inline error pattern (`music/src/modal.ts:140`), offline modal pause/resume/quota controls (`music/src/select.ts:808`).

# Proposal (revised)

## Design principle
Do not add a global `RecoveryAction` abstraction and do not force a universal event bus for recovery handlers.

Recovery should remain local to each UI surface:
- startup surface handles startup fatal recovery,
- settings handles `LatchedIssue` account/index/share recovery,
- modals handle immediate inline action errors,
- playback/offline surfaces handle playback/download recovery.

## Logging model (minimal change)
Keep `logError` and `logCatch` as primary primitives.

Add only a thin, optional helper for consistency in high-value paths, e.g.:
- `logErrorCode(code, message, context, error?)`

The helper’s goal is formatting and required context fields, not architectural indirection.

## Error display policy model
Use per-code policy from the table:
- `Immediate`
- `Latched`
- `Log-only`

This explicitly supports the existing mixed model where some `ErrorEvent`s are shown immediately and others create/update `LatchedIssue`s that persist until remediation.

## Share modal pending policy (explicit)
This is intentionally per-action, not global:

| Action | Abortability now | Pending cancel/backdrop policy | Failure surfacing policy |
|---|---|---|---|
| Add share | Abortable (`AbortSignal` already wired) | Cancel/backdrop stays enabled; it aborts the request and closes modal | `Immediate` inline error for operational failure; no error on user cancel (`AbortError` is control flow) |
| Rename share | Non-abortable (no signal wiring today) | Cancel/backdrop disabled while pending; modal stays visible until completion | `Immediate` inline error on failure + `Latched` settings issue if local/remote diverge |
| Disconnect share | Non-abortable (no signal wiring today) | Cancel/backdrop disabled while pending; modal stays visible until completion | `Immediate` inline error on failure + `Latched` settings issue if local/remote diverge |

## Implementation plan
### Release priorities (for initial public release)
1. Full-detail logging sweep (code + context + stack/reconstruction metadata on all high-value failure paths).
2. Global crash capture + startup fatal routing.
3. Add missing sync `LatchedIssue` for favorites/shares cloud sync failures.
4. Fix share modal in-flight cancel semantics.
5. Surface local-success/remote-failure divergence as a retryable `LatchedIssue`.

### Deferred UX plan: mobile ad-hoc fault menu (no developer console)
Goal: enable manual fault injection on phone builds where DevTools console is unavailable.

1. Add a debug-only dropdown on the evidence glyph (`SW_DEBUG && debugEnabled` only).
2. Include one-shot actions:
- Corrupt auth tokens + transition signed-out (existing evidence test action).
- Force auth evidence state transitions (`signed-in`, `signed-out`, `not-online`, `no-evidence`).
- Set/clear forced index `LatchedIssue` (label + message).
- Force next settings action failure (`Reconnect`, `Refresh`, `Add Share`, `Rename Share`, `Disconnect Share`).
3. Include toggle actions (sticky until turned off):
- Force shares cloud-save failure.
- Force favorites cloud-save failure.
- Force share probe failure (status/message).
4. Show active toggles in the menu title/body so tester knows fault mode is armed.
5. Safety constraints:
- No production exposure.
- Explicit confirmation for destructive actions (token corruption/sign-out simulation).
- One-tap “Reset all fault injections” action.

Status: intentionally deferred; document-only for now.

1. Phase 1: make the latch registry authoritative (each lane has an explicit owner + user remediation).
2. Phase 2: add the missing sync-health latch for favorites/shares cloud sync failures and surface it in settings with retry CTA.
3. Phase 3: keep the immediate registry exhaustive and evaluate each row against the Immediate principles.
4. Phase 4: keep the classification table as source of truth and map every code path to one policy (`Immediate`, `Latched`, `Log-only`).
5. Phase 5: add global crash capture (`window.error` + `unhandledrejection`) and replace swallowed persistence/db catches with coded `logError` events.
6. Phase 6: close high-priority user recovery gaps:
   - startup no-cache failures,
   - settings auth action failures,
   - playback URL/media failures,
   - playback blocked-no-playable (replace `alert`).
7. Phase 7: enforce Immediate principles for every non-latched operational path.
8. Phase 8: enforce Latch principles for every lane that materializes a `LatchedIssue`.
9. Phase 9: implement modal pending contract in `modal.ts`:
   - `abortable`: cancel/backdrop allowed and must call abort.
   - `non-abortable`: cancel/backdrop disabled while pending; modal remains visible.
10. Phase 10: apply explicit share action policy:
   - Add share = `abortable`.
   - Rename share = `non-abortable` unless true abort semantics are added.
   - Disconnect share = `non-abortable` unless true abort semantics are added.
11. Phase 11: add `LatchedIssue` settings surfacing for local-success/remote-failure paths with explicit retry CTA.
12. Phase 12: keep recovery execution local to each UI owner (startup/settings/modal/playback); do not introduce a global recovery callback system.
13. Phase 13: enforce Common principles for all user-facing and logged errors.

## Test cases and scenarios
1. Unit:
   - coded log helper emits required fields when used,
   - global crash capture maps to expected policy route,
   - swallowed storage/db failures now log once with context.
2. Integration:
   - startup fatal errors show technical message and startup action,
   - settings auth/index/share `LatchedIssue`s render with correct CTA,
   - playback/download immediate errors show local actionable message,
   - modal cancel behavior is correct for both `abortable` and `non-abortable` share actions,
   - cancel+complete race is deterministic (no double-close, no stale spinner, no duplicate logs),
   - share local-success/remote-failure scenario surfaces a retryable `LatchedIssue`,
   - warning icon clears once the `LatchedIssue` resolves.
3. Regression:
   - existing sign-in/indexing/share/offline/playback flows remain non-blocking and offline-first.

## Acceptance criteria
1. Every code in the table has an implemented policy (`Immediate`, `Latched`, or `Log-only`).
2. No silent P0/P1 failures remain (especially runtime unhandled + startup blockers).
3. High-impact operational failures have actionable local recovery in the owning UI surface.
4. Logging includes enough context to reconstruct request/status/path IDs for non-throw callbacks.
5. No misleading cancel affordance remains: any pending action is either truly abortable or explicitly non-cancelable while pending.
6. Modal close semantics are deterministic under race conditions (user cancel, timeout, late network completion).
7. Every lane that materializes a `LatchedIssue` has a named owner and a user remediation action; sync health is no longer log-only.
8. Every non-latched operational (`Immediate`) error path satisfies all four Immediate principles (startup/crash terminal lanes follow the explicit exception rule).
9. Every user-facing error includes technical detail suitable for remediation (at minimum code/context + HTTP status/message where relevant).
10. Common principles are satisfied across both Immediate and `LatchedIssue` lanes.
