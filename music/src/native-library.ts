import type { NativeLogEntry } from './logger-web.js';
import type { AuthFetchOptions, EvidenceState } from './auth.js';

/** The WebKit reply handler is installed exclusively in the signed, bundled page.
 * Native code validates the main frame and account generation independently. */
interface ReplyHandler {
    postMessage(message: Record<string, unknown>): Promise<unknown>;
}

interface NativeAccountState {
    readonly driveID: string | null;
    readonly evidence: EvidenceState;
    readonly debugPlayback?: boolean;
}

interface NativeResponse {
    readonly status: number;
    readonly statusText: string;
    readonly headers: Record<string, string>;
    readonly body?: string;
    readonly chunked?: boolean;
}

/** One acknowledged chunk at a time keeps large index bytes out of control messages.
 * Response decodes the concatenated bytes, so split UTF-8 codepoints survive intact. */
export function createNativeLibrary(handler: ReplyHandler) {
    const post = (message: Record<string, unknown>) => handler.postMessage(message);
    let state: NativeAccountState = { driveID: null, evidence: 'no-evidence', debugPlayback: false };

    /** The page can abandon its wait even while MSAL finishes a renewal shared with another caller. */
    async function request(url: string, retryOn429: boolean, options: AuthFetchOptions = {}, follow = false): Promise<Response> {
        const id = crypto.randomUUID();
        const { signal, body, cache, timeoutMs } = options;
        if (body != null && typeof body !== 'string') throw new TypeError('Library request requires a text body');
        signal?.throwIfAborted();

        const abort = () => post({ op: 'abort', id });
        const readResponse = async (): Promise<Response> => {
            const headers: Record<string, string> = {};
            new Headers(options.headers).forEach((value, name) => { headers[name] = value; });
            const result = await post({
                op: 'request', id, url, retryOn429, follow, method: options.method ?? 'GET', headers,
                ...(body != null ? { body } : {}),
                ...(cache ? { cache } : {}),
                ...(timeoutMs !== undefined ? { timeoutMs } : {}),
            }) as NativeResponse;
            signal?.throwIfAborted();
            const chunks: Uint8Array<ArrayBuffer>[] = [];
            try {
                let encoded = result.body;
                let done = !result.chunked;
                while (true) {
                    if (encoded) {
                        const binary = atob(encoded);
                        const bytes = new Uint8Array(binary.length);
                        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
                        chunks.push(bytes);
                    }
                    if (done) break;
                    const chunk = await post({ op: 'chunk', id }) as { body: string; done: boolean };
                    signal?.throwIfAborted();
                    encoded = chunk.body;
                    done = chunk.done;
                }
            } catch (error) {
                if (result.chunked && !signal?.aborted) await abort().catch(() => {});
                throw error;
            }
            return new Response(chunks.length ? new Blob(chunks) : null, {
                status: result.status, statusText: result.statusText, headers: result.headers,
            });
        };

        if (!signal) return readResponse();
        let onAbort!: () => void;
        const cancelled = new Promise<never>((_, reject) => {
            onAbort = () => {
                reject(signal.reason);
                abort().catch(() => {}); // Detaching the view also cancels the native task and releases its spool.
            };
            signal.addEventListener('abort', onAbort, { once: true });
        });
        try {
            return await Promise.race([readResponse(), cancelled]);
        } finally {
            signal.removeEventListener('abort', onAbort);
        }
    }

    const library = {
        get state() { return state; },
        getEvidence: () => state.evidence,
        isSignedIn: () => state.driveID !== null,
        onEvidenceChange: (_next: EvidenceState, _prev: EvidenceState) => {},
        /** Native is the sole evidence writer. This page projects changes into the library UI. */
        applyEvidence(next: EvidenceState) {
            const prev = state.evidence;
            if (next === prev) return;
            state = { ...state, evidence: next };
            library.onEvidenceChange(next, prev);
        },
        async loadAccountState(op: 'state' | 'signIn') {
            const next = await post({ op }) as NativeAccountState;
            const prev = state.evidence;
            state = next;
            if (next.evidence !== prev) library.onEvidenceChange(next.evidence, prev);
        },
        signOut: (theme: string) => post({ op: 'signOut', theme }),
        fetch: request,
        followContent: (url: string, signal?: AbortSignal) => request(url, false, { signal, timeoutMs: 30000 }, true),
        playback: (action: string, args: Record<string, unknown> = {}) => post({op: 'playback', version: 1, action, ...args}),
        playIndexed: (tracks: {driveId: string; itemId: string}[], nearEnd: boolean, forceRefresh: boolean, delaySeconds: number) =>
            post({ op: 'playIndexed', tracks, nearEnd, forceRefresh, delaySeconds }),
        playLocal: (nearEnd: boolean) => post({ op: 'playLocal', nearEnd }),
        readPlaybackStatus: async () => String(await post({ op: 'playbackStatus' })),
        stopPlayback: () => post({ op: 'stopPlayback' }),
    };
    return library;
}

export type NativeLibrary = ReturnType<typeof createNativeLibrary>;

/** A broken bundled bridge must fail closed before the browser PKCE client can start. */
export function connectBundledLibrary(displayNativeLog: (entries: NativeLogEntry[]) => void) {
    if (location.protocol !== 'oneplay:') return undefined;
    const handler = (window as Window & { webkit?: { messageHandlers?: { oneplay?: ReplyHandler } } }).webkit?.messageHandlers?.oneplay;
    if (location.href !== 'oneplay://app/music/index.html' || !handler) throw new Error('Bundled library bridge unavailable');
    const library = createNativeLibrary(handler);
    window.addEventListener('oneplay-evidence', event => library.applyEvidence((event as CustomEvent<EvidenceState>).detail));
    // Signals are hints. Pull on launch and resume even if WebKit missed every signal while asleep.
    let after: string | undefined;
    let pulling = false;
    let requested = false;
    async function pullPending(): Promise<void> {
        requested = true;
        if (pulling) return;
        pulling = true;
        do {
            requested = false;
            try {
                const entries = await handler!.postMessage({ op: 'diagnostics', after: after ?? null }) as NativeLogEntry[];
                if (entries.length) {
                    displayNativeLog(entries);
                    after = entries[entries.length - 1].id;
                }
            } catch {
                // A failed bridge call leaves the cursor in place. Honor any wake that arrived during the call.
                console.warn('Native diagnostics delivery deferred');
            }
        } while (requested);
        pulling = false;
    }
    window.addEventListener('oneplay-diagnostics', pullPending);
    window.addEventListener('pageshow', pullPending);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) return pullPending(); });
    window.dispatchEvent(new Event('oneplay-diagnostics'));
    return library;
}
