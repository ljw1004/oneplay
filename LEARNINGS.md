# Learnings

`LEARNINGS.md` is for durable engineering wisdom that should survive refactors and apply across both `music/` and `video/`. Use the **scope ladder** when deciding where a new insight should live:
- **Repo-wide and durable** (works across apps/repos): put it in `LEARNINGS.md`.
- **App-specific architecture/policy** (states, flows, contracts, UX rules): put it in app architecture notes (for example `music/ai/ARCHITECTURE.md`).
- **Symbol-local contract** (one module/function/type behavior): put it in code docblocks near the symbol.
- **Naming/API smell** (callers keep misusing it): prefer renaming/re-shaping the API over adding prose.
- Quick test: if it remains true after renaming modules and shipping new features, it is likely `LEARNINGS.md`; if it depends on current product behavior, it belongs in architecture docs.

## Engineering discipline

- **Every warning is harmful.** Warnings indicate mismatch between intent and reality; either fix immediately or stop and design a clean fix.
- **Don't guess; inspect first.** Confirm reality from code/runtime state before recommending changes.
- **Derive contracts from essential data flow.** Identify the minimum data required for correct output; remove extra inputs and document staleness/invariant implications.
- **Recover intent before deleting code.** Assume dead-looking code had a purpose; verify whether that purpose is now met elsewhere before removal.
- **Generalize local cleanups into pattern audits.** A good fix in one site is a signal to scan similar call paths for consistency and quality.
- **Fix prerequisites cleanly.** If goal X requires Y first, solve Y properly rather than layering hacks.
- **Don't defer quality fixes.** Bugs, races, and invariant leaks are cheapest to fix immediately.
- **Debug tools must be single-purpose.** A diagnostic control should expose bugs, not compensate for them.
- **Treat design-doc silence as "no."** Do not invent un-specified behavior; document any new behavior explicitly.
- **Look for existing code first**. If adding something, can you re-use existing code? or cleanly refactor existing code to serve the new purpose?
- **Be happy to refactor**. As a good engineer you seek out opportunities to improve the health of the codebase, and are eager to do them.

## Architecture and refactorability

- **Bias toward purity from the first implementation.** Pure functional-style input→output logic is far cheaper to move, test, and recombine later than mixed logic/effects.
- **Separate decision logic from effects early.** Keep computation in pure helpers/reducers; keep I/O, storage, DOM, and network writes in thin orchestration layers.
- **Design modules around effect boundaries.** A module should either decide what should happen (pure) or perform side effects (impure), not both.
- **Treat modularity as a maintenance multiplier, not a cleanup pass.** Building with clear boundaries up front avoids expensive, risky refactors after feature completion.

## Async, cancellation, and concurrency

- **Cancelable async work needs real cancellation plumbing.** A visible Cancel button is honest only when it can abort in-flight work via `AbortSignal`.
- **User cancel and timeout are different contracts.** User cancel is control flow (`AbortError`); timeout is an operational failure path.
- **Protect startup from hangs with a terminal-state latch.** Define structural terminal states and ensure only the first terminal render wins.
- **Use single-flight coordinators for shared refresh/init paths.** UI disable states alone do not prevent race conditions.
- **For idempotent async init, guard with an in-flight promise.** `if (ready)` checks alone are unsafe under concurrent callers.
- **Invalidate orphaned background tasks with a generation counter.** `abort()` alone is not enough once work has passed its last abort check.
- **Idempotent setters prevent callback feedback loops.** No-op when effective value is unchanged.
- **If fire-and-forget is truly required, encode it in the callee contract.** The callee owns all errors and returns `void`.

## Network and reliability

- **Request only OAuth scopes the product actually uses.** Extra scopes add consent friction and policy risk.
- **HTTP body reads are fallible I/O.** `response.text()`/`response.json()` can fail after status is known; log status and parse stage explicitly.
- **Classify failures by permanence.** Retry transient transport failures; avoid destructive state transitions on 5xx/network faults.
- **`navigator.onLine` is reliable only as a negative signal.** `false` means definitely offline; `true` does not prove internet reachability.
- **Use visibility/resume events as backstops for missed network events.** Browser lifecycle events are not perfectly reliable in PWAs.

## Identity provider behavior (Entra/OAuth)

- **iOS PWAs break iframe-based silent auth.** Third-party cookie policies make hidden-iframe `prompt=none` flows unreliable.
- **Use top-level redirect for silent re-auth on mobile PWAs.** Pair it with one-shot and cooldown guards to prevent loops.
- **`prompt=none` on localhost redirect URIs can still return `interaction_required`.** Provider trust/consent interstitials require real UI and cannot be satisfied silently.
- **In signed-out evidence states, offer reconnect, not sign-out.** Recovery affordance should match actual session reality.

## Graph/OneDrive API behavior

- **Graph batch cache uploads may require base64-as-`text/plain`.** Some endpoints mishandle batch `application/json` request bodies.
- **Graph batch `:/content` responses can require manual redirect follow.** Treat 302 as expected and fetch the redirect URL explicitly.
- **Some Graph batch JSON payloads arrive as encoded strings.** Decode and parse defensively rather than assuming direct object JSON.

## Offline-first and persistence

- **Keep pre-render state synchronous and cache state asynchronous.** Use localStorage for instant UI restore; IndexedDB for heavy cached data.
- **Separate high-frequency and low-frequency persisted fields.** Avoid rewriting large state blobs for tiny updates.
- **Multiple writers to shared persisted objects must preserve unknown fields.** Read-modify-write, never overwrite with defaults.
- **Do not consume one-shot restore values before success.** Clear restored values only after the restore action completes.
- **Deferred data must not trigger eager invalidation.** If dependencies are not loaded yet, defer validation instead of resetting state.
- **Programmatic scroll/state restoration needs guardrails.** Empty-container scroll events and resource-default values can silently corrupt restored state.
- **Tests must clear persistent state in setup.** Shared browser profiles make state leakage otherwise inevitable.

## Evidence-driven offline design

- **Model connectivity as evidence, not a boolean.** Distinguish unknown/no-evidence, signed-in evidence, signed-out evidence, and definite offline.
- **Any server 4xx is still connectivity evidence.** The server responded even if auth failed; 5xx/timeouts/network exceptions are different.
- **Gate background work and UI affordances on evidence state.** This keeps behavior explicit under flaky networks and auth loss.
- **Use `online`/`offline` plus `visibilitychange` reconciliation.** Lifecycle events are imperfect and need a backstop.
- **Suppress periodic work in terminal states.** Signed-out and definite-offline states should stop retry churn until recovery signals arrive.

## Data modeling

- **Use stable identity keys, not display names.** Resolve presentation labels at render time.
- **Use discriminated unions for variant root/entity types.** Dispatch on `type`, not string-prefix heuristics.
- **Business logic must derive from data model, not DOM styling hooks.** CSS classes are presentation, not source-of-truth semantics.
- **Graph integrity needs full traversal.** Use DFS for cycle detection, and copy visited sets per sibling when DAG sharing is valid.
- **Reference healing/migration often requires two-pass algorithms.** First compute survivors, then rebuild references.
- **Batch APIs need intra-batch dedup as well as existing-state dedup.**

## UI/DOM/CSS patterns

- **Keep semantic classes stable; add separate styling classes for visual variants.** This preserves test and behavior contracts.
- **For popup dismissal, prefer capture-phase `pointerdown` outside checks.** Bubble `click` listeners are fragile under `stopPropagation()`.
- **Long-press gestures should suppress the synthetic follow-up click.** Otherwise release can immediately undo the long-press action.
- **Toggle the popup on repeated clicks of the same anchor.**
- **Clamp fixed-position popups to all viewport edges.**
- **Defer outside-click listener installation to avoid immediate self-close on open event.**
- **Live-updated views must not rebuild active controls.** Update text/state nodes in place to preserve focus and open native UI.
- **Use one validation predicate for both disabled state and submit guard.**
- **Physical overlays are more reliable than event interception for dead zones.**
- **For flex overflow, widen the flex container (`max-content` + floor width), not just the child.**
- **`:has()` depends on DOM presence, not visibility.** Remove nodes when layout should stop matching.
- **Read CSS `env()` values via custom properties, not direct `getComputedStyle('env(...)')`.**
- **FLIP animations need deterministic cleanup fallback (timeout), not only `transitionend`.**
- **`max-height` transitions require measured pixel targets, not `auto`.**
- **Restarting CSS animations requires forced reflow between class remove/add.**

## Mobile/PWA platform behavior

- **App-like mobile tools should explicitly control zoom and overscroll behavior.**
- **iOS Safari can cache HTML aggressively; cache-busting and SW strategy must account for it.**
- **Long-press suppression on iOS needs layered defenses (CSS + JS fallback).**
- **Always handle `pointercancel` in gesture trackers.** System gestures frequently trigger it.
- **Respect safe-area/home-indicator interaction zones for bottom gestures.**
- **Keep touch targets at least 44x44 CSS px.**

## Service worker patterns

- **SW scope is determined by the SW script URL path.** Root placement is required when you want app-wide control on static hosting.
- **Use `updateViaCache: 'none'` for registration.** SW update checks should bypass stale HTTP cache.
- **Handle navigations explicitly in fetch handlers.** `caches.match(request)` is exact; SPA navigations with query strings need dedicated handling.
- **Guard `controllerchange` reloads with one-shot logic.** Prevent update-induced reload loops.
- **Delay registration until page load if needed by engine quirks.** Fresh browser contexts can throw `InvalidStateError` before provider init.
- **Normalize cached redirect responses before serving navigations.** Redirect metadata on cached responses can violate navigation redirect-mode constraints.
- **Assume eviction can happen.** iOS may purge SW cache/IndexedDB under storage pressure; recovery paths must be clean.

## Media playback and MediaSession

- **Reset media element state before async track switches to prevent stale event races.**
- **Drive play/pause UI from media events, not optimistic click updates.**
- **Do not auto-advance on media errors.** Stop, surface failure, and preserve user control.
- **Scrubbing should preserve prior play/pause intent.**
- **On iOS, ended-to-next transitions must avoid async gaps where possible.** Sync-ready next URLs reduce background suspension risk.
- **Sync-first async wrappers are useful when handlers must branch on immediate availability.**
- **Wrap MediaSession action registration in per-action try/catch for partial platform support.**
- **Treat OS `play` actions as play-only; avoid toggle semantics.**
- **Clamp and guard `setPositionState` inputs; platform implementations can throw on edge values.**

## TypeScript and testability

- **Avoid TDZ traps with synchronous builder callbacks.** Pass constructed objects into callbacks after initialization.
- **Derive flags from existing data instead of threading redundant booleans through call chains.**
- **Write optional-chain conditions in forms TypeScript can narrow correctly.**
- **Test async engines with state-change callbacks, not arbitrary sleeps.**
- **DI test stubs for expected side effects should sink calls, not throw.**
- **Test-only dependency/global overrides must be explicitly named and idempotent.**
- **If test state is user-dependent, add deterministic data hooks instead of assuming empty real accounts.**

## Testing and Playwright practice

- **Avoid `networkidle` for apps with continuous background traffic.** Use structural readiness checks/log polling instead.
- **Run short timeout-based probes before full suites.** Early failure clustering saves long waits.
- **Inspect test logs incrementally during long runs.** Don't wait for full completion to discover systemic failures.
- **Isolate destructive auth/token tests in throwaway browser profiles.** Shared profiles should stay usable for manual workflows.
- **Neutralize service-worker interference in integration harnesses.** Unregister/stub as needed to avoid stale shell or reload side effects.
- **Budget explicit waits for real production startup work.** Token refresh and first render can require deterministic grace time.
