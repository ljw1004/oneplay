/**
 * OneDrive authentication for OnePlay Music.
 *
 * Implements OAuth2 PKCE code flow against Microsoft Entra (consumer accounts).
 * Created via createAuth() factory; the returned Auth object is the single
 * source of truth for both authenticated fetching and evidence state.
 *
 * Token lifecycle:
 *   1. User clicks sign-in → PKCE redirect to Microsoft → redirect back with ?code=
 *   2. handleOauthRedirect() exchanges code for access_token + refresh_token
 *   3. auth.fetch() adds Bearer header; on 401 it tries refresh_token grant
 *   4. Tokens live in localStorage; sign-out clears them and redirects to Microsoft logout
 *
 * Evidence state:
 *   auth.fetch() classifies every response via classifyEvidence() and
 *   transitions the evidence state machine automatically. External callers
 *   (online/offline events, debug button) can also call auth.transition().
 *
 * Token re-auth (M12):
 *   When the refresh_token expires (~24hrs), the app uses a top-level redirect
 *   with `prompt=none` (attemptSilentRedirect) to get fresh tokens without user
 *   interaction. This replaces the hidden-iframe approach which doesn't work on
 *   iOS PWAs due to third-party cookie blocking.
 *
 * INVARIANT: CLIENT_ID and GRAPH_SCOPES never change across the lifetime of a session.
 * INVARIANT: AUTH_REFRESH_SIGNAL prevents concurrent 401-refresh races (thundering herd).
 * INVARIANT: oneplay_music_auth_lineage_time tracks when tokens were last refreshed via redirect.
 * INVARIANT: oneplay_music_redirect_attempt prevents redirect loops (cooldown check).
 * INVARIANT: oneplay_music_redirect_result records if auto-redirect got interaction_required.
 * INVARIANT: evidence transitions are no-ops on same-state (no spurious onChange).
 */

import { log, logError } from './logger.js';

// ---------------------------------------------------------------------------
// Evidence state types + classifier
// ---------------------------------------------------------------------------

/** Four-state machine tracking connectivity/auth evidence. Owned by the Auth
 *  module; consumed by downloads (pump guard), tree (track greying, icons),
 *  and index (pull scheduling, auto-redirect). */
export type EvidenceState = 'no-evidence' | 'evidence:signed-in' | 'evidence:signed-out' | 'evidence:not-online';

/** Options accepted by auth.fetch. timeoutMs is handled by the wrapper and
 *  never passed through to native fetch(). */
export interface AuthFetchOptions extends RequestInit {
    readonly timeoutMs?: number;
}

/** Shared authenticated fetch function type used across modules. */
export type AuthFetch = (
    url: string,
    retryOn429: boolean,
    options?: AuthFetchOptions,
) => Promise<Response>;

/** True when a thrown value represents intentional cancellation. */
export const isAbortError = (e: unknown): boolean =>
    e instanceof Error && e.name === 'AbortError';

/** Creates an AbortError in environments with/without DOMException support. */
function createAbortError(): Error {
    if (typeof DOMException === 'function') return new DOMException('Aborted', 'AbortError');
    const err = new Error('Aborted');
    err.name = 'AbortError';
    return err;
}

/**
 * Classifies a fetch outcome into an evidence state.
 * Pure function — usable by both auth.fetch (for Graph calls) and downloads
 * (for plain SAS-token audio fetches). No side effects, no state mutation.
 *
 * @param status    — HTTP status (or synthetic 503 from errorResponse)
 * @param signedIn  — whether tokens are still valid (from isSignedIn)
 * @param online    — navigator.onLine (reliable negative signal)
 */
export function classifyEvidence(status: number, signedIn: boolean, online: boolean): EvidenceState {
    if (status < 500) return signedIn ? 'evidence:signed-in' : 'evidence:signed-out';
    return online ? 'no-evidence' : 'evidence:not-online';
}

// ---------------------------------------------------------------------------
// Auth interface
// ---------------------------------------------------------------------------

export interface Auth {
    /** Evidence-aware authenticated fetch. Classifies every response and
     *  transitions evidence automatically. All modules receive this via DI. */
    fetch: AuthFetch;
    /** Returns the current evidence state. */
    getEvidence(): EvidenceState;
    /** Transitions evidence state. No-ops on same-state. Fires onEvidenceChange
     *  on actual transitions. Called by the wrapper and by external callers
     *  (online/offline events, debug button). */
    transition(newState: EvidenceState): void;
    /** Reconciles evidence against navigator.onLine.
     *  Uses navigator.onLine only as a reliable negative signal. */
    reconcileEvidenceFromNavigator(
        reason: string,
        options?: { logUnchanged?: boolean; suppressLog?: boolean },
    ): EvidenceState;
    /** Classifies evidence from an HTTP status and transitions auth evidence. */
    provideEvidenceFromHttpStatus(status: number, reason: string): EvidenceState;
    /** Classifies evidence from an operational error and transitions auth evidence
     *  for network/timeout-style failures. */
    provideEvidenceFromError(error: unknown, reason: string): EvidenceState;
    /** True if we have a plausible access token in localStorage.
     *  INVARIANT: signOut() writes sentinels starting with "null:" (e.g. "null: logged out ...").
     *  Failed 4xx refresh also sentinels (e.g. "null: 401 failed to refresh - ...").
     *  Transient/5xx failures do NOT sentinel — tokens may still be valid on retry.
     *  startsWith('null') correctly identifies intentionally invalidated tokens. */
    isSignedIn(): boolean;
    /** Initiates PKCE sign-in redirect. */
    signIn(): Promise<void>;
    /** Signs out: clears cache via the provided callback, invalidates tokens in
     *  localStorage, and redirects to Microsoft logout. */
    signOut(onClear: () => Promise<void>): Promise<void>;
    /** Processes ?code= redirect on page load. Must be called first in onBodyLoad. */
    handleOauthRedirect(): Promise<{ error: string | null }>;
    /** Attempts silent token re-auth via top-level redirect with prompt=none.
     *  INVARIANT: redirects away from the page; control never returns. */
    attemptSilentRedirect(): Promise<void>;
    /** Fired on every actual evidence state transition. Wired by index.ts. */
    onEvidenceChange: (newState: EvidenceState, prevState: EvidenceState) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CLIENT_ID = 'e4adae2b-3cf8-4ce8-b59f-d341b3bacbf6';
// Keep Graph scopes minimal: only OneDrive data access + refresh-token grant.
const GRAPH_SCOPES = 'Files.Read Files.ReadWrite.AppFolder offline_access';
const AUTHORIZE_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize';
const TOKEN_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token';
const LOGOUT_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/logout';

// ---------------------------------------------------------------------------
// Stateless helpers (module-scoped — shared, pure, no instance state)
// ---------------------------------------------------------------------------

/** Redirect URI — canonical form: bare origin at root ("https://localhost:5500"),
 * origin+pathname for subdirectories ("https://unto.me/oneplay/music/").
 * Entra registrations must match these exact strings. */
const redirectUri = (): string =>
    window.location.pathname === '/'
        ? window.location.origin
        : window.location.origin + window.location.pathname;

/** Base64url-encodes a Uint8Array (no padding), per RFC 7636. */
const base64UrlEncode = (array: Uint8Array): string =>
    btoa(String.fromCharCode(...Array.from(array)))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');

/**
 * Converts an exception into a synthetic Response (503). Allows callers to
 * have a single error-handling path for both network failures and HTTP errors.
 */
const errorResponse = (url: string, e: unknown): Response => {
    const message = `${e instanceof Error ? e.message : String(e)} (${url})`;
    return new Response(message, { status: 503, statusText: 'Cannot make request' });
};

/** Synthetic timeout response used when wrapper-level timeoutMs elapses. */
const timeoutResponse = (url: string, timeoutMs: number): Response =>
    new Response(`Timeout after ${timeoutMs}ms (${url})`, {
        status: 504,
        statusText: 'Request timed out',
    });

/** Awaitable delay that can be canceled by an AbortSignal. */
async function waitForMsWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
    if (!signal) {
        await new Promise<void>((resolve) => setTimeout(resolve, ms));
        return;
    }
    if (signal.aborted) throw createAbortError();
    await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
            clearTimeout(timeoutId);
            signal.removeEventListener('abort', onAbort);
            reject(createAbortError());
        };
        const timeoutId = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
}

/**
 * Like fetch(), but:
 * - preserves caller AbortError semantics (throws AbortError),
 * - returns synthetic timeout responses for timeoutMs expirations,
 * - converts other thrown exceptions into synthetic 503 responses,
 * - retries on 429 (2 s delay) and 503 (10 s delay) when retryOn429 is true.
 */
async function myFetch(url: string, retryOn429: boolean, options?: AuthFetchOptions): Promise<Response> {
    const timeoutMs = options?.timeoutMs;
    const requestInit: RequestInit = options ? (() => {
        const { timeoutMs: _timeoutMs, ...rest } = options;
        return rest;
    })() : {};
    const callerSignal = requestInit.signal ?? undefined;
    while (true) {
        if (callerSignal?.aborted) throw createAbortError();
        let timedOut = false;
        const mergedController = new AbortController();
        const onCallerAbort = callerSignal ? () => mergedController.abort() : undefined;
        if (callerSignal && onCallerAbort) callerSignal.addEventListener('abort', onCallerAbort, { once: true });
        const timeoutId = timeoutMs === undefined ? undefined : setTimeout(() => {
            timedOut = true;
            mergedController.abort();
        }, timeoutMs);
        try {
            const r = await fetch(url, { ...requestInit, signal: mergedController.signal });
            if (timeoutId !== undefined) clearTimeout(timeoutId);
            if (callerSignal && onCallerAbort) callerSignal.removeEventListener('abort', onCallerAbort);
            if ((r.status !== 429 && r.status !== 503) || !retryOn429) return r;
            log(`${r.status}: will retry ${url}`);
            await waitForMsWithAbort(r.status === 429 ? 2000 : 10000, callerSignal);
        } catch (e) {
            if (timeoutId !== undefined) clearTimeout(timeoutId);
            if (callerSignal && onCallerAbort) callerSignal.removeEventListener('abort', onCallerAbort);
            if (isAbortError(e)) {
                if (timedOut && !callerSignal?.aborted) return timeoutResponse(url, timeoutMs ?? 0);
                throw e;
            }
            return errorResponse(url, e);
        }
    }
}

// ---------------------------------------------------------------------------
// Thundering-herd prevention for concurrent 401 refreshes
// ---------------------------------------------------------------------------

/**
 * A simple signal: one caller sets willSomeoneSignal=true, does the refresh,
 * then calls signal(). Other callers seeing willSomeoneSignal=true just wait().
 */
class AuthRefreshSignal {
    public willSomeoneSignal = false;
    private waiting: Array<{
        resolve: () => void;
        reject: (e: Error) => void;
        signal?: AbortSignal;
        onAbort?: () => void;
    }> = [];

    /** Blocks until signal() is called. Only call when willSomeoneSignal is true. */
    wait(signal?: AbortSignal): Promise<void> {
        if (signal?.aborted) return Promise.reject(createAbortError());
        return new Promise((resolve, reject) => {
            const waiter: {
                resolve: () => void;
                reject: (e: Error) => void;
                signal?: AbortSignal;
                onAbort?: () => void;
            } = { resolve, reject, signal, onAbort: undefined };
            if (signal) {
                waiter.onAbort = () => {
                    this.waiting = this.waiting.filter((w) => w !== waiter);
                    signal.removeEventListener('abort', waiter.onAbort!);
                    reject(createAbortError());
                };
                signal.addEventListener('abort', waiter.onAbort, { once: true });
            }
            this.waiting.push(waiter);
        });
    }

    /** Resolves all waiters and resets the flag. */
    signal(): void {
        this.willSomeoneSignal = false;
        this.waiting.forEach((w) => {
            if (w.signal && w.onAbort) w.signal.removeEventListener('abort', w.onAbort);
            w.resolve();
        });
        this.waiting = [];
    }
}

const AUTH_REFRESH_SIGNAL = new AuthRefreshSignal();

// ---------------------------------------------------------------------------
// Token exchange
// ---------------------------------------------------------------------------

/**
 * Exchanges an authorization code + PKCE verifier for tokens.
 * Returns {accessToken, refreshToken} on success, or an error string.
 */
const exchangeCodeForToken = async (
    code: string, codeVerifier: string
): Promise<{ accessToken: string; refreshToken: string } | string> => {
    log(`exchangeCodeForToken: redirect_uri=${redirectUri()}`);
    const r = await myFetch(TOKEN_URL, true, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: CLIENT_ID,
            code,
            code_verifier: codeVerifier,
            redirect_uri: redirectUri(),
            grant_type: 'authorization_code',
        }).toString(),
        timeoutMs: 10000,
    });
    if (!r.ok) {
        const body = await r.text().catch(() => '');
        if (r.status === 504) return `exchangeCodeForToken: timeout ${body}`;
        return `exchangeCodeForToken: HTTP ${r.status} ${body}`;
    }
    const data = await r.json().catch((e: unknown) => e);
    if (data instanceof Error) return `exchangeCodeForToken: parse ${data.message}`;
    if (typeof data !== 'object' || data === null) return 'exchangeCodeForToken: parse non-object token response';
    const accessToken = (data as { access_token?: unknown }).access_token;
    const refreshToken = (data as { refresh_token?: unknown }).refresh_token;
    if (typeof accessToken !== 'string' || typeof refreshToken !== 'string') {
        return 'exchangeCodeForToken: parse missing access_token or refresh_token';
    }
    return { accessToken, refreshToken };
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates the Auth module. All auth operations and evidence state are
 * encapsulated in the returned object. Modules receive auth.fetch via DI.
 *
 * INVARIANT: only one Auth instance exists per page load.
 */
export function createAuth(): Auth {
    let evidence: EvidenceState = 'no-evidence';

    // -- isSignedIn (used internally and exposed on the interface) -----------

    const isSignedIn = (): boolean => {
        const token = localStorage.getItem('access_token');
        return token !== null && !token.startsWith('null');
    };

    // -- Internal authFetch (the raw implementation, without evidence) -------

    /**
     * Authenticated fetch wrapper. Adds Bearer token from localStorage.
     * On 401: attempts refresh_token flow. If refresh fails with 4xx,
     * sentinels the tokens and returns the failure. No redirect from
     * within authFetch — it would be too disruptive mid-operation.
     * Uses AUTH_REFRESH_SIGNAL to prevent concurrent refresh attempts.
     */
    async function rawAuthFetch(url: string, retryOn429: boolean, options?: AuthFetchOptions): Promise<Response> {
        /** Makes the actual request with the current access_token. */
        const doFetch = (): Promise<Response> => {
            const accessToken = localStorage.getItem('access_token');
            if (!accessToken || accessToken.startsWith('null')) {
                return Promise.resolve(new Response('Unauthorized: no access_token', { status: 401, statusText: 'Unauthorized' }));
            }
            const opts: AuthFetchOptions = options ? { ...options } : {};
            opts.headers = new Headers(opts.headers);
            opts.headers.set('Authorization', `Bearer ${accessToken}`);
            return myFetch(url, retryOn429, opts);
        };

        // If someone else is already refreshing, wait for them, then try
        if (AUTH_REFRESH_SIGNAL.willSomeoneSignal) {
            await AUTH_REFRESH_SIGNAL.wait(options?.signal ?? undefined);
            return doFetch();
        }

        const r = await doFetch();
        if (r.status !== 401) return r;

        // Got a 401 — maybe someone else started refreshing while we were fetching
        if (AUTH_REFRESH_SIGNAL.willSomeoneSignal) {
            await AUTH_REFRESH_SIGNAL.wait(options?.signal ?? undefined);
            return doFetch();
        }

        // We'll do the refresh ourselves
        AUTH_REFRESH_SIGNAL.willSomeoneSignal = true;
        try {
            // Try refresh_token grant. If it fails with 4xx, sentinel and return.
            // No iframe/redirect fallback — auto-redirect is orchestrated by
            // index.ts at startup, not mid-operation.
            const refreshToken = localStorage.getItem('refresh_token');
            if (!refreshToken || refreshToken.startsWith('null')) {
                return r; // no refresh token available
            }

            log('attempting refresh via refresh_token');
            const refreshResult = await myFetch(TOKEN_URL, false, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    client_id: CLIENT_ID,
                    refresh_token: refreshToken,
                    grant_type: 'refresh_token',
                    scope: GRAPH_SCOPES,
                }).toString(),
                signal: options?.signal,
            });

            if (!refreshResult.ok) {
                const body = await refreshResult.text();
                // Only sentinel tokens on client errors (4xx). Server errors (5xx)
                // and transient failures should not force sign-out — the refresh
                // token may still be valid on retry.
                if (refreshResult.status >= 400 && refreshResult.status < 500) {
                    const sentinel = `null: ${refreshResult.status} failed to refresh - ${body}`;
                    logError(`token refresh failed (4xx, sentineling): ${refreshResult.status} ${body}`);
                    localStorage.setItem('access_token', sentinel);
                    localStorage.setItem('refresh_token', sentinel);
                } else {
                    logError(`token refresh failed (transient): ${refreshResult.status} ${body}`);
                }
                return refreshResult;
            }

            log('refreshed!');
            const tokenData = await refreshResult.json();
            localStorage.setItem('access_token', tokenData.access_token);
            localStorage.setItem('refresh_token', tokenData.refresh_token);
            // Successful refresh proves tokens are valid — clear auto-redirect
            // cooldown and interaction_required so future auto-redirects aren't
            // blocked by stale state from a prior failed attempt.
            localStorage.removeItem('oneplay_music_redirect_attempt');
            localStorage.removeItem('oneplay_music_redirect_result');
        } catch (e) {
            if (isAbortError(e)) throw e;
            return errorResponse(url, e);
        } finally {
            AUTH_REFRESH_SIGNAL.signal();
        }

        return doFetch();
    }

    // -- The Auth object ----------------------------------------------------

    const auth: Auth = {
        async fetch(url, retryOn429, options) {
            try {
                const onlineBeforeFetch = navigator.onLine;
                const evidenceBeforeFetch = auth.reconcileEvidenceFromNavigator(
                    `authFetch:init:${url}`,
                    onlineBeforeFetch ? { suppressLog: true } : { logUnchanged: true },
                );
                if (evidenceBeforeFetch === 'evidence:not-online') {
                    const offlineResponse = errorResponse(url, 'navigator.onLine=false before fetch');
                    auth.provideEvidenceFromHttpStatus(offlineResponse.status, `authFetch:skip-offline:${url}`);
                    return offlineResponse;
                }
                const r = await rawAuthFetch(url, retryOn429, options);
                auth.provideEvidenceFromHttpStatus(r.status, `authFetch:${url}`);
                return r;
            } catch (e) {
                if (isAbortError(e)) throw e;
                throw e;
            }
        },

        getEvidence: () => evidence,

        transition(newState) {
            const prev = evidence;
            if (newState === prev) return;
            evidence = newState;
            auth.onEvidenceChange(newState, prev);
        },

        reconcileEvidenceFromNavigator(reason, options) {
            const online = navigator.onLine;
            const next = online
                ? (evidence === 'evidence:not-online' ? 'no-evidence' : evidence)
                : 'evidence:not-online';
            if (next !== evidence) {
                if (options?.suppressLog !== true) {
                    log(`evidence: navigator reconcile reason=${reason} online=${online} -> ${next}`);
                }
                auth.transition(next);
            } else if (options?.logUnchanged === true && options?.suppressLog !== true) {
                log(`evidence: navigator reconcile reason=${reason} online=${online} -> ${next} (unchanged)`);
            }
            return auth.getEvidence();
        },

        provideEvidenceFromHttpStatus(status, reason) {
            const prev = evidence;
            const state = classifyEvidence(status, isSignedIn(), navigator.onLine);
            auth.transition(state);
            if (state !== prev) {
                log(`evidence: status classify reason=${reason} status=${status} -> ${state}`);
            }
            return state;
        },

        provideEvidenceFromError(error, reason) {
            const message = error instanceof Error ? error.message : String(error);
            const lower = message.toLowerCase();
            const isNetworkLike = lower.includes('timeout')
                || lower.includes('network')
                || lower.includes('fetch')
                || lower.includes('failed to fetch')
                || lower.includes('abort');
            if (!isNetworkLike) return auth.getEvidence();
            const state: EvidenceState = navigator.onLine ? 'no-evidence' : 'evidence:not-online';
            auth.transition(state);
            log(`evidence: error classify reason=${reason} -> ${state}`);
            return state;
        },

        isSignedIn,

        async signIn() {
            localStorage.removeItem('oneplay_music_redirect_result');
            localStorage.removeItem('oneplay_music_redirect_attempt');
            const codeVerifier = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
            const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier));
            const codeChallenge = base64UrlEncode(new Uint8Array(digest));
            sessionStorage.setItem('code_verifier', codeVerifier);

            const params = new URLSearchParams({
                client_id: CLIENT_ID,
                response_type: 'code',
                redirect_uri: redirectUri(),
                scope: GRAPH_SCOPES,
                code_challenge: codeChallenge,
                code_challenge_method: 'S256',
            });
            const url = `${AUTHORIZE_URL}?${params}`;
            log(`signIn: redirect_uri=${redirectUri()} scope=${GRAPH_SCOPES}`);
            log(`signIn: full URL = ${url}`);
            location.href = url;
        },

        async signOut(onClear) {
            await onClear();
            const sentinel = `null: logged out ${new Date().toLocaleString()}`;
            localStorage.setItem('access_token', sentinel);
            localStorage.setItem('refresh_token', sentinel);
            location.href = `${LOGOUT_URL}?post_logout_redirect_uri=${encodeURIComponent(redirectUri())}`;
        },

        async handleOauthRedirect() {
            const params = new URLSearchParams(window.location.search);
            const code = params.get('code');
            const error = params.get('error');
            const errorDesc = params.get('error_description');
            const errorSubcode = params.get('error_subcode');
            /** Human-readable error summary combining all error params from Entra. */
            const errorSummary = [error, errorDesc, errorSubcode].filter(Boolean).join(' | ') || null;

            // Exchange code for tokens if we got one
            const authResult = code === null ? undefined : await (async () => {
                const codeVerifier = sessionStorage.getItem('code_verifier');
                sessionStorage.removeItem('code_verifier');
                if (!codeVerifier) return 'exchangeCodeForToken: missing code_verifier';
                return exchangeCodeForToken(code, codeVerifier);
            })();

            const isAutoRedirect = localStorage.getItem('oneplay_music_redirect_attempt') !== null;

            if (typeof authResult === 'string') {
                if (authResult.startsWith('exchangeCodeForToken: timeout')) {
                    logError(`oauth redirect code exchange timeout: ${authResult}`);
                } else if (authResult.startsWith('exchangeCodeForToken: HTTP')) {
                    logError(`oauth redirect code exchange HTTP failure: ${authResult}`);
                } else if (authResult.startsWith('exchangeCodeForToken: parse')) {
                    logError(`oauth redirect code exchange parse failure: ${authResult}`);
                } else {
                    logError(`oauth redirect code exchange failure: ${authResult}`);
                }
                window.history.replaceState(null, '', window.location.pathname);
                return { error: authResult };
            } else if (authResult) {
                localStorage.setItem('access_token', authResult.accessToken);
                localStorage.setItem('refresh_token', authResult.refreshToken);
                // Record when tokens were last refreshed via redirect (lineage tracking).
                // INVARIANT: oneplay_music_auth_lineage_time is checked by shouldAutoRedirect to
                // skip re-auth when tokens are still fresh (>3hrs remaining of 24hr lifetime).
                localStorage.setItem('oneplay_music_auth_lineage_time', String(Date.now()));
                localStorage.removeItem('oneplay_music_redirect_result');
                localStorage.removeItem('oneplay_music_redirect_attempt');
            } else if (isAutoRedirect && errorSummary) {
                // Auto-redirect returned an error. If it's login_required or
                // interaction_required, that just means the Entra session cookies
                // are absent — not a real error. Record it so we don't retry.
                const isExpected = error === 'login_required' || error === 'interaction_required';
                if (isExpected) {
                    localStorage.setItem('oneplay_music_redirect_result', 'interaction_required');
                    // The sticky result blocks future auto-redirects; keep the
                    // attempt timestamp out of the cooldown path so a manual
                    // sign-in can immediately restore normal behavior.
                    localStorage.removeItem('oneplay_music_redirect_attempt');
                    log(`auto-redirect: ${error} (suppressed, Entra session absent)`);
                    window.history.replaceState(null, '', window.location.pathname);
                    return { error: null };
                }
            }
            window.history.replaceState(null, '', window.location.pathname);
            return { error: errorSummary };
        },

        async attemptSilentRedirect() {
            localStorage.setItem('oneplay_music_redirect_attempt', String(Date.now()));
            const codeVerifier = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
            const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier));
            const codeChallenge = base64UrlEncode(new Uint8Array(digest));
            sessionStorage.setItem('code_verifier', codeVerifier);

            const params = new URLSearchParams({
                client_id: CLIENT_ID,
                response_type: 'code',
                redirect_uri: redirectUri(),
                scope: GRAPH_SCOPES,
                prompt: 'none',
                code_challenge: codeChallenge,
                code_challenge_method: 'S256',
            });
            log(`attemptSilentRedirect: redirect_uri=${redirectUri()} scope=${GRAPH_SCOPES} prompt=none`);
            location.href = `${AUTHORIZE_URL}?${params}`;
        },

        onEvidenceChange: () => {},
    };

    return auth;
}
