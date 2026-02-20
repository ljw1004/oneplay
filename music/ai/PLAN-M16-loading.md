# Startup `Loading...` Hang Elimination Plan (Incorporating Claude Round 4)

## Summary
Eliminate indefinite startup placeholder hangs by adding one bounded startup deadline (`3s`), one bounded OAuth code-exchange timeout (`10s`), and a structural terminal-UI guard that guarantees startup always ends in a visible terminal state (`tree`, `sign-in`, or `error`).
Keep architecture constraints unchanged: all IndexedDB startup reads remain pre-render, and no pre-render OneDrive fetches are added.

## Public APIs / Interfaces / Types
- No public API changes.
- Internal changes only:
1. `index.ts`: new startup wrapper, terminal-UI detector, startup error renderer, terminal logging.
2. `auth.ts`: bounded code-exchange fetch behavior in `exchangeCodeForToken` path.
3. Tests only add coverage; no interface changes.

## Implementation Plan

### 1) Add startup terminal UI primitives in `index.ts`
1. Add `renderStartupErrorIntoStatusAndWireReload(message: string): void`.
2. Render a simple generic startup error block in `#status` with class `.startup-error` and a `Reload` button that calls `location.reload()`.
3. Add `isStartupTerminalUiRendered(): boolean` using structural checks only:
4. `#tree-container` exists and `hidden === false` is terminal.
5. `#status` contains a sign-in button is terminal.
6. `#status` contains `.error-msg` or `.startup-error` is terminal.
7. No literal string matching on `"Loading..."`.

### 2) Wrap startup flow with one deadline + one latch
1. Split current `onBodyLoad` body into `startupInner(): Promise<void>`.
2. Keep exported `onBodyLoad()` as wrapper:
3. Create boolean latch `startupTerminated` (first terminal renderer wins).
4. Run `await Promise.race([startupInner(), startupDeadlinePromise(3000)])`.
5. If deadline wins and `startupTerminated === false`:
6. Set latch true.
7. Log `startup: deadline exceeded`.
8. Render startup error UI.
9. In `finally`, if `startupTerminated === false` and `isStartupTerminalUiRendered() === false`:
10. Set latch true.
11. Log `startup: fell through without terminal UI`.
12. Render startup error UI.
13. If terminal UI is already rendered, do nothing.
14. Allow in-flight `startupInner` work to continue naturally (no cancellation). If it later renders `showTree`, that is acceptable recovery.

### 3) Handle known no-cache fall-throughs eagerly
1. In signed-in path where `cachedData` is absent:
2. If `navigator.onLine === false`, immediately render startup error UI and log terminal state, then return.
3. After `await requestStartupPullIfOnline()` returns, if still no terminal UI, immediately render startup error UI and log.
4. In account-info `'network'` return path when no cache exists, ensure terminal UI is rendered before returning.

### 4) Bound OAuth `?code=` exchange in `auth.ts`
1. In `exchangeCodeForToken`, call:
2. `myFetch(TOKEN_URL, false, { ...existing options..., timeoutMs: 10000 })`.
3. Keep all existing PKCE semantics and token parsing.
4. On timeout/failure in `handleOauthRedirect` code path:
5. Log explicit reason (`timeout` vs `HTTP` vs parse error).
6. Ensure `code_verifier` is not retained.
7. Strip query params with `history.replaceState`.
8. Return error so caller falls back to cache/sign-in/error terminal UI.
9. Keep non-`?code=` path unchanged and fast.

### 5) Logging contract (low-noise)
1. Add single startup-begin log.
2. Add deadline/fall-through logs only on abnormal paths.
3. Add one terminal-state log on completion:
4. `startup complete: tree`
5. `startup complete: sign-in`
6. `startup complete: error`
7. `startup complete: deadline`
8. Add OAuth timeout/failure log keyed to code exchange.

### 6) Scope decision
1. Defer singleton reset hardening (`ensureFavoritesPromise` / `ensureSharesPromise` clear-on-reject) for this iteration.
2. Revisit only if logs show repeated same-session retries failing due to cached rejected promise behavior.

## Test Cases and Scenarios

### Unit tests
1. Signed-in + cache: tree renders, no deadline UI.
2. Not signed in + no cache: sign-in shown quickly.
3. Signed-in + no cache + offline: immediate error terminal UI (no 3s wait).
4. Signed-in + no cache + hanging account-info/pull: deadline error at ~3s.
5. `?code=` + hanging token exchange: timeout at ~10s, URL cleaned, fallback terminal UI.
6. `?code=` + HTTP token error: fallback terminal UI and log.
7. Structural guard correctness: tree visible/sign-in/error recognized; placeholder-only recognized as non-terminal.

### Integration tests (Playwright)
1. Fresh no-auth/no-cache: sign-in appears, no persistent loading.
2. Signed-in with cache: tree appears promptly.
3. Signed-in no-cache offline simulation: error terminal UI appears immediately.
4. Signed-in no-cache network hang simulation: startup error + reload appears by 3s.
5. Reload button triggers page reload and terminal UI re-evaluates.
6. Optional production smoke (`MYMUSIC_TEST_URL=https://unto.me/mymusic/`): startup reaches terminal UI reliably.

### Validation workflow for implementation phase
1. `npm run build`
2. `npm run deploy`
3. Integration test run with `/tmp/mymusic-test.log` monitoring.
4. Production verification run against `https://unto.me/mymusic/`.

## Assumptions and Defaults
1. Startup deadline fixed at `3000ms`.
2. OAuth code-exchange timeout fixed at `10000ms`.
3. Generic startup error + reload is preferred over detailed user-facing diagnostics.
4. Logs are the primary diagnostic artifact across launches (`mymusic_logs`).
5. No startup reordering is performed.
