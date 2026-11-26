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

interface AccessReply {
    readonly subscription: string;
    readonly snapshot: {readonly accessRevision: number};
    readonly applied?: boolean;
    readonly staleProof?: boolean;
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

    // This queue belongs to one admitted document. Swift persists the revision and rejects an older
    // subscription even if its delayed callback presents the current revision after reconnection.
    let access: AccessReply | undefined;
    let writes: Promise<unknown> = Promise.resolve();
    let membership: {signature: string; completion: Promise<boolean>} | undefined;
    const probes = new Map<string, symbol>();
    const retryDenials = new Map<string, () => Promise<boolean>>();
    function commitAccess(args: Record<string, unknown>, current: () => boolean): Promise<boolean> {
        const commit = writes.then(async () => {
            if (!current()) return false;
            access ??= await library.playback('snapshot') as AccessReply;
            while (current()) {
                const {subscription, snapshot: {accessRevision: base}} = access;
                const reply = await library.playback('access', {subscription, base, denied: [], ...args}) as AccessReply;
                if (reply.subscription !== subscription) throw new Error('Playback document was replaced');
                access = reply;
                if (reply.applied) return true;
                if (reply.staleProof) return false;
                if (!(reply.snapshot.accessRevision > base)) throw new Error('Playback access revision was rejected');
                // A concurrent writer won the base. Recheck this proposal's owner before retrying.
            }
            return false;
        });
        writes = commit.catch(() => {}); // Each caller receives its own error. Later proposals still run.
        return commit;
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
        requireInteractiveReconnectForDebug: () => post({ op: 'debugRequireInteractiveReconnect' }),
        signOut: (theme: string) => post({ op: 'signOut', theme }),
        fetch: request,
        followContent: (url: string, signal?: AbortSignal) => request(url, false, { signal, timeoutMs: 30000 }, true),
        /** A large projection commits on its final piece. A snapshot's pieces all describe one revision. */
        async pins(action: string, args: Record<string, unknown> = {}) {
            const send = (name: string, fields: Record<string, unknown>) => post({op: 'pins', action: name, ...fields});
            if (action === 'owners') {
                const contents = JSON.stringify(args.owners);
                if (contents.length > 65536) {
                    for (let offset = 0; offset < contents.length;) {
                        let end = Math.min(offset + 65536, contents.length);
                        // WebKit converts each piece to a Swift String. Keep surrogate pairs together.
                        if (end < contents.length && /[\uD800-\uDBFF]/.test(contents[end-1])) end--;
                        await send('ownerPart', {revision: args.revision, first: offset === 0, last: end === contents.length,
                            text: contents.slice(offset, end)});
                        offset = end;
                    }
                    return {};
                }
            }
            const result = await send(action, args) as {parts?: number; revision?: number};
            if (!result.parts) return result;
            const chunks: Uint8Array<ArrayBuffer>[] = [];
            for (let index = 0; index < result.parts; index++) {
                const body = await send('inventoryPart', {revision: result.revision, index}) as string;
                chunks.push(Uint8Array.from(atob(body), c => c.charCodeAt(0)));
            }
            return JSON.parse(await new Blob(chunks).text()) as unknown;
        },
        playback: (action: string, args: Record<string, unknown> = {}) => post({op: 'playback', version: 1, action, ...args}),
        /** Read the last durable decisions before rendering cached shares. This read also
         * binds the document's first write to the observed account revision. */
        async readPlaybackDenials(): Promise<readonly string[]> {
            if (!state.driveID) return [];
            const read = writes.then(async () => {
                const reply = await library.playback('readAccess') as AccessReply & {denied: string[]};
                if (access && reply.subscription !== access.subscription) throw new Error('Playback document was replaced');
                access = reply;
                return reply.denied;
            });
            writes = read.catch(() => {});
            return read;
        },
        /** Only a completed membership load or an explicit edit establishes the connected roots. */
        async syncPlaybackMembership(connected: readonly string[], disconnected?: string): Promise<void> {
            const signature = JSON.stringify(connected);
            if (!disconnected && membership?.signature === signature) { await membership.completion; return; }
            // A subsequent reconnect still needs a fresh verified probe. Even if membership
            // changes during the write, commit the explicit removal before its successor.
            const completion = commitAccess({connected, ...(disconnected && {disconnected: [disconnected]})},
                () => !!disconnected || membership?.signature === signature);
            membership = {signature, completion};
            try {
                if (await completion && disconnected) retryDenials.delete(disconnected);
            }
            catch (error) { if (membership?.completion === completion) membership = undefined; throw error; }
        },
        /** Capture the request at issue time. Reconnection changes the share record ID, and a
         * newer probe of that same record supersedes its predecessor before either result arrives. */
        beginSourceProbe(root: string) {
            const ticket = Symbol();
            probes.set(root, ticket);
            return async (response: Response, allowed: boolean, connected: () => boolean): Promise<boolean> => {
                const proof = response.headers.get('X-OnePlay-Account-Proof');
                if (!proof || response.headers.has('X-OnePlay-Account-Error')) return false;
                const current = () => probes.get(root) === ticket && connected();
                const commit = () => commitAccess({[allowed ? 'allowed' : 'denied']: [root], proof}, current);
                try {
                    const applied = await commit();
                    if (applied) retryDenials.delete(root);
                    return applied && current();
                } catch (error) {
                    if (!allowed && current()) retryDenials.set(root, async () => {
                        // A newer probe supersedes this one. Until it supplies an actual verdict,
                        // the last confirmed denial is still unresolved for this source.
                        if (connected() && !current()) throw new Error('Waiting for confirmed playback access');
                        return commit();
                    });
                    throw error;
                }
            };
        },
        /** Any in-flight confirmed denial or disconnect precedes admission of a new queue. */
        async waitForPlaybackAccess(inQueue: (root: string) => boolean = () => true): Promise<void> {
            await writes;
            // A successful update for some other root cannot acknowledge this denied source.
            // Recheck the captured proof on retry; Swift rejects a grant invalidated in between.
            for (const [root, retry] of retryDenials) {
                if (!inQueue(root)) continue;
                // A retired account proof has no authority to change Swift's new policy.
                await retry();
                if (retryDenials.get(root) === retry) retryDenials.delete(root);
            }
        },
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
