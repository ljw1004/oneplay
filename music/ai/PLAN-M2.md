# M2 Plan: OneDrive Authentication

## Context

Milestone 2 adds OneDrive sign-in so the app can access the user's music. This establishes the auth layer (`authFetch`) that every subsequent milestone depends on. We also demonstrate caching by displaying both cached and live data from the user's Music folder.

The example code in `example/utils.ts` and `example/index.ts` contains proven patterns for PKCE auth, token refresh, Entra silent iframe re-auth, and IndexedDB caching. We will adapt these into fresh, cleaner code.

## Human Prerequisites

- Verify that Client ID `3e5b0862-9322-481b-b97e-0518ae38aff3` has `http://localhost:5500/` registered as a SPA redirect URI in Azure Portal (Entra app registration). Production `https://unto.me/mymusic/` should already be registered from example code.
- The human must sign in once on localhost (and once on production) before AI can run autonomous tests against that environment.

## Architecture Decisions

**File organization**: Two new files.
- `auth.ts` — PKCE flow, token management, `authFetch`, Entra silent iframe. This is the shared infrastructure used by all future milestones. CLIENT_ID is a module constant here (no localStorage indirection, unlike the example which needed it because authFetch and CLIENT_ID lived in different modules).
- `db.ts` — IndexedDB wrapper (`dbGet`, `dbPut`, `dbClear`). Separate from auth so the cache is reusable in M3+.

**Redirect URI**: `window.location.origin + window.location.pathname` — dynamic, works for both localhost and production. Proven pattern from example code.

**What to display**: Top-level children of the Music special folder via `GET /me/drive/special/music/children`. This is a temporary demo for M2; M3+ replaces it with the real index.

**UI approach**: All rendering goes into the existing `#status` div. No new HTML elements in index.html — content is generated dynamically by TypeScript.

**Cache**: IndexedDB database `mymusic-cache`, store `data`, string keys. For M2 we use a single key `"music-folder"`. M3 will evolve to per-account keying.

## Files to Create/Modify

### 1. New file: `db.ts`

Minimal IndexedDB wrapper adapted from `example/utils.ts`:
- `dbPut(key: string, value: unknown): Promise<void>` — stores a value
- `dbGet<T>(key: string): Promise<T | undefined>` — retrieves a value
- `dbClear(): Promise<void>` — wipes the store (for sign-out)

Module-private `dbOpen()` handles database creation (version 1, single `data` object store).

Key difference from example: string keys instead of hardcoded integer `1`, enabling per-account keying in M3.

### 2. New file: `auth.ts`

Core auth module, adapted from `example/utils.ts` + `example/index.ts`. Exports:

- **`handleOauthRedirect(): Promise<{error: string | null} | 'iframe'>`** — Called first in onBodyLoad. Checks for `?code=` param, exchanges for tokens, handles iframe vs main-window. In main window: stores tokens in localStorage, cleans URL via `replaceState`. In iframe: posts result to parent via `postMessage`, returns `'iframe'` sentinel.

- **`isSignedIn(): boolean`** — Checks `localStorage.getItem('access_token')` exists and doesn't start with `'null'`.

- **`signIn(): Promise<void>`** — Generates PKCE code_verifier/code_challenge, stores verifier in `sessionStorage`, redirects to Microsoft authorize endpoint.

- **`signOut(onClear: () => Promise<void>): Promise<void>`** — Calls onClear callback (for IndexedDB clearing), sets localStorage sentinels, redirects to Microsoft logout endpoint.

- **`authFetch(url: string, retryOn429: () => boolean, options?: RequestInit): Promise<Response>`** — The core authenticated fetch wrapper. Adds Bearer token. On 401: attempts refresh-token flow, then falls back to Entra iframe. Uses AUTH_REFRESH_SIGNAL to prevent thundering herd. Delegates to `myFetch` for retry logic.

Module-private internals:
- `CLIENT_ID`, `GRAPH_SCOPES`, endpoint URL constants
- `base64UrlEncode(array: Uint8Array): string` — PKCE helper
- `exchangeCodeForToken(code, codeVerifier)` — token exchange
- `trySilentEntraAuthorize()` — hidden iframe re-auth (adapted from `example/utils.ts:341-385`)
- `myFetch(url, retryOn429, options?)` — wraps fetch with retry on 429 (2s) / 503 (10s) and exception-to-Response conversion
- `errorResponse(url, e)` — converts exceptions to Response objects
- `AuthRefreshSignal` class — prevents thundering herd on concurrent 401s
- `noRetryOn429()`, `indefinitelyRetryOn429()` — retry strategies (exported for callers)

### 3. Modified: `index.html`

Add CSS for the sign-in button and directory listing display inside the existing `<style>` block. The sign-in button is centered, blue (#0078d4). The directory listing is left-aligned monospace with labels distinguishing "(cached)" from "(live)".

### 4. Rewritten: `index.ts`

Orchestrates auth flow and display states. Flow:

```
onBodyLoad()
  → handleOauthRedirect()  // process ?code= if present
  → if iframe: return      // nothing to render in iframe
  → if not signed in: render sign-in button
  → if signed in:
      → show cached data from IndexedDB (if any), labelled "(cached)"
      → fire authFetch to Graph API for live data
      → on success: render live data labelled "(live)", save to IndexedDB
      → on failure: show error, offer re-sign-in if 401
      → render sign-out button
```

Types defined here (not exported, local to this module):
- `CacheEntry { fetchedAt: string, children: DriveItem[] }` — what's stored in IndexedDB
- `DriveItem { name, size?, folder?, file?, lastModifiedDateTime? }` — from MS Graph

Graph endpoint: `https://graph.microsoft.com/v1.0/me/drive/special/music/children?select=name,size,folder,file,lastModifiedDateTime`

Rendering: a simple DOM list showing each item's name (bold if folder), child count or file size, and last-modified date.

## Implementation Sequence

1. Create `db.ts` (no dependencies)
2. Create `auth.ts` (depends on `logger.ts`)
3. Add CSS to `index.html`
4. Rewrite `index.ts` (depends on auth.ts, db.ts, logger.ts)
5. `npm run build` — verify clean compilation
6. Start `npm run serve` — test on localhost
7. Human signs in on localhost
8. AI validates via Playwright (signed-in state, cached data, log output)
9. `npm run deploy` via sandbox-escape
10. Human validates on production + iPhone

## Auth Flow Walkthrough

**First visit**: onBodyLoad → no ?code= → no tokens → show sign-in button → user clicks → PKCE redirect to Microsoft → user authenticates → redirect back with ?code= → exchange for tokens → store in localStorage → show music folder contents.

**Return visit (valid tokens)**: onBodyLoad → no ?code= → tokens exist → show cached data immediately → authFetch succeeds → show live data alongside.

**Return visit (expired token)**: authFetch gets 401 → attempts refresh_token → new tokens → retry succeeds.

**After 24hrs (expired refresh token)**: authFetch 401 → refresh fails → Entra silent iframe with prompt=none → iframe loads index.html?code= → iframe detects `window.parent !== window` → exchanges code → postMessages tokens to parent → parent stores tokens → retry succeeds.

**Sign-out**: clear IndexedDB → set localStorage sentinels → redirect to Microsoft logout → redirect back → show sign-in button.

## Validation

**AI autonomous (Playwright via sandbox-escape):**
- Before sign-in: navigate to localhost:5500, verify sign-in button renders, no errors in logs
- After human sign-in: verify directory listing visible, cached data in IndexedDB, sign-out works
- Verify `npm run build` produces zero errors

**Human testing checklist:**
1. `npm run serve`, open localhost:5500 — see sign-in button
2. Click sign in — authenticate with Microsoft — see directory listing
3. Refresh page — see "(cached)" data immediately, then "(live)" data
4. Click sign out — redirects to Microsoft, returns to sign-in state
5. `npm run deploy` — repeat on unto.me/mymusic/
6. On iPhone: open production URL, sign in, verify listing shows

**Cannot test in M2:**
- Entra silent iframe (requires 24hr token expiry). Code is in place; testing deferred per milestone spec.
