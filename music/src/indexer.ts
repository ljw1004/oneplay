/**
 * Music indexer for OnePlay Music.
 *
 * Builds a complete tree of all folders and audio files in the user's OneDrive
 * Music folder, using a work-queue with batch Graph API requests. Per-folder
 * cache files in the OneDrive App folder are part of a shared format. Reuse a
 * schema-1 snapshot when the live folder's recursive byte size matches.
 *
 * Adapted from example/musicdata.ts and example/utils.ts.
 */

import { log, logError, errorDetail } from './logger.js';
import { readGraphJson, waitForMsWithAbort, type AuthFetch } from './auth.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SCHEMA_VERSION = 1;
type ContentFollow = (location: string, signal: AbortSignal) => Promise<Response>;
class IndexThrottleError extends Error {}
const AUDIO_RE = /\.(mp3|m4a|flac|wav|aac|ogg|wma)$/i;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Complete index of a music folder tree. Stored in IndexedDB and as per-folder
 * cache files in OneDrive App folder.
 *
 * INVARIANT: count = total MusicFile nodes in the tree.
 * INVARIANT: size = OneDrive folder's recursive `size` property at index time.
 */
export interface MusicData {
    readonly kind: 'MusicData';
    readonly schemaVersion: number;
    readonly size: number;
    readonly lastModifiedDateTime: string;
    readonly cTag: string;
    readonly eTag: string;
    readonly folder: MusicFolder;
    readonly count: number;
}

/** INVARIANT: id refers to a OneDrive folder. */
export interface MusicFolder {
    readonly id: string;
    readonly children: { readonly [name: string]: MusicFile | MusicFolder };
}

/** INVARIANT: id refers to a OneDrive file. */
export interface MusicFile {
    readonly id: string;
}

export const isMusicFolder = (item: MusicFile | MusicFolder): item is MusicFolder =>
    'children' in item;

/** Walks a path of segments into a MusicFolder tree. Returns undefined if any
 *  segment is missing or not a folder. Used by favorites resolution and tree
 *  navigation to avoid duplicating the walk-and-check pattern. */
export const walkFolder = (root: MusicFolder, segments: readonly string[]): MusicFolder | undefined => {
    let current: MusicFolder = root;
    for (const seg of segments) {
        const child = current.children[seg];
        if (!child || !isMusicFolder(child)) return undefined;
        current = child;
    }
    return current;
};

/** Returns sorted [name, isFolder] pairs from a MusicFolder's children.
 *  Sort order: folders first, then alphabetical within each group. */
export const sortedFolderChildren = (folder: MusicFolder): Array<[string, boolean]> =>
    Object.entries(folder.children)
        .map(([name, item]): [string, boolean] => [name, isMusicFolder(item)])
        .sort((a, b) => (a[1] === b[1] ? a[0].localeCompare(b[0]) : a[1] ? -1 : 1));

export interface AccountInfo {
    readonly driveId: string;
    readonly displayName: string;
}

/** Progress emitted during indexing. Opaque — just fraction and status text. */
export interface IndexProgress {
    readonly fraction: number;
    readonly message: string;
}

/** Subset of Graph DriveItem fields needed for the Music folder root. */
export interface MusicDriveItem {
    readonly id: string;
    readonly name: string;
    readonly size: number;
    readonly lastModifiedDateTime: string;
    readonly cTag: string;
    readonly eTag: string;
    readonly folder: { childCount: number };
}

// ---------------------------------------------------------------------------
// Private types (work-queue internals)
// ---------------------------------------------------------------------------

/** A single request within a $batch POST. */
interface BatchRequest {
    readonly id: string;
    readonly method: string;
    readonly url: string;
    readonly body?: string;
    readonly headers?: { readonly [key: string]: string };
}

/** A single response from a $batch POST (after postprocessing). */
interface BatchResponse {
    id: string;
    status: number;
    headers: { [key: string]: string };
    body: any;
}

/** An item in the indexing work queue. */
interface WorkItem {
    state: 'START' | 'END';
    driveItem: MusicDriveItem;
    parent?: WorkItem;
    requests: BatchRequest[];
    responses: { [id: string]: BatchResponse };
    data: MusicData;
    path: string[];
    remainingSubfolders: number;
    driveId: string;
    cacheNamespace: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Schema 1 names root and subtree caches by their path within the namespace. */
const cacheFilename = (path: string[], cacheNamespace: string): string => {
    const ns = cacheNamespace.trim().replace(/^\/+|\/+$/g, '');
    const prefix = ns ? `${ns}/` : '';
    return path.length === 0 ? `${prefix}index.json` : `${prefix}${path.join('_')}.json`;
};

/** Counts all MusicFile nodes recursively under a folder. */
export function countTracks(folder: MusicFolder): number {
    return Object.values(folder.children).reduce(
        (n, child) => n + (isMusicFolder(child) ? countTracks(child) : 1), 0,
    );
}

/** The shared cache contract uses schema version and recursive byte size for freshness. */
export function isCurrentIndex(data: MusicData | undefined, folder: MusicDriveItem): data is MusicData {
    return data?.schemaVersion === SCHEMA_VERSION && data.size === folder.size;
}

// ---------------------------------------------------------------------------
// Work-item constructors
// ---------------------------------------------------------------------------

/** Creates a START WorkItem with requests for children listing and cache read. */
function createStartWorkItem(
    driveItem: MusicDriveItem,
    path: string[],
    folder: MusicFolder,
    driveId: string,
    cacheNamespace: string,
    parent?: WorkItem,
): WorkItem {
    return {
        state: 'START',
        driveItem, parent,
        requests: [
            {
                id: `children-${driveItem.id}`,
                method: 'GET',
                url: `/drives/${encodeURIComponent(driveId)}/items/${driveItem.id}/children?$top=10000&select=name,id,ctag,etag,size,lastModifiedDateTime,folder,file`,
            },
            {
                id: `cache-${driveItem.id}`,
                method: 'GET',
                url: `/me/drive/special/approot:/${cacheFilename(path, cacheNamespace)}:/content`,
            },
        ],
        responses: {},
        data: {
            kind: 'MusicData',
            schemaVersion: SCHEMA_VERSION,
            size: driveItem.size,
            lastModifiedDateTime: driveItem.lastModifiedDateTime,
            cTag: driveItem.cTag,
            eTag: driveItem.eTag,
            folder,
            count: 0,
        },
        path,
        remainingSubfolders: 0,
        driveId,
        cacheNamespace,
    };
}

/**
 * Creates an END WorkItem with a request to upload the cache file.
 *
 * INVARIANT: body is base64-encoded JSON sent as text/plain. This is a
 * workaround for a OneDrive batch API bug: application/json bodies are
 * silently stored as 0-byte files. text/plain with base64 works correctly.
 */
function createEndWorkItem(item: WorkItem): WorkItem {
    const data = { ...item.data, count: countTracks(item.data.folder) };
    const json = JSON.stringify(data);
    const utf8 = new TextEncoder().encode(json);
    const b64 = btoa(Array.from(utf8, b => String.fromCharCode(b)).join(''));
    return {
        ...item,
        state: 'END',
        data,
        responses: {},
        requests: [{
            id: `write-${item.data.folder.id}`,
            method: 'PUT',
            url: `/me/drive/special/approot:/${cacheFilename(item.path, item.cacheNamespace)}:/content`,
            body: b64,
            headers: { 'Content-Type': 'text/plain' },
        }],
    };
}

// ---------------------------------------------------------------------------
// Batch postprocessing
// ---------------------------------------------------------------------------

/**
 * Cleans up idiosyncrasies of the $batch response. Modifies in place.
 *
 * 1. 302 redirects: batch API doesn't auto-follow content downloads. We
 *    follow them without Graph credentials via the transport that issued the batch.
 * 2. Base64-encoded JSON: when batch claims application/json but the body is
 *    a string, it's base64-of-utf8 JSON. Decode it.
 *
 * Adapted from example/utils.ts lines 41-62.
 */
async function postprocessBatchResponse(response: any, followContent: ContentFollow, signal: AbortSignal): Promise<void> {
    await Promise.all(response.responses.map(async (r: BatchResponse) => {
        const redirect = r.status === 302;
        const cacheRead = r.id.startsWith('cache-');
        try {
            if (redirect) {
                const location = new Headers(r.headers).get('Location');
                if (!location) throw new Error();
                const rr = await followContent(location, signal);
                r.status = rr.status;
                r.body = rr.ok ? (cacheRead || rr.headers.get('Content-Type')?.includes('application/json')
                    ? await rr.json() : await rr.text()) : undefined;
            } else if (r.status === 200 && typeof r.body === 'string'
                && new Headers(r.headers).get('Content-Type')?.includes('application/json')) {
                r.body = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(r.body), c => c.charCodeAt(0))));
            }
        } catch {
            signal.throwIfAborted();
            // Neither a signed Location nor a parser error quoting response bytes belongs in diagnostics.
            const message = `batch ${redirect ? 'redirect follow failed' : 'response invalid encoded JSON'} id=${r.id} status=${r.status}`;
            if (!cacheRead) throw new Error(message);
            log(message);
            r.body = undefined; // The authoritative children listing still suffices for indexing.
        }
    }));
}

// ---------------------------------------------------------------------------
// Main indexing algorithm
// ---------------------------------------------------------------------------

/**
 * One full indexing attempt (no full-build retry loop here).
 *
 * INVARIANT: the `root` MusicFolder is shared by reference across all
 * WorkItems. Mutations during START (adding children) are visible to the
 * parent at END. This is safe because the work-queue is single-threaded
 * (interleaved async, not concurrent).
 */
async function buildIndexSingleAttempt(
    musicDriveItem: MusicDriveItem,
    onProgress: (p: IndexProgress) => void,
    authFetch: AuthFetch,
    driveId: string,
    cacheNamespace: string,
    followContent: ContentFollow,
    cancel: AbortSignal | undefined,
    onBatchSuccess: (requestCount: number) => void,
): Promise<MusicData> {
    const root: MusicFolder = { id: musicDriveItem.id, children: Object.create(null) };
    const toProcess: WorkItem[] = [];
    const toFetch: WorkItem[] = [createStartWorkItem(musicDriveItem, [], root, driveId, cacheNamespace)];
    const stats = { bytesFromCache: 0, bytesProcessed: 0, bytesTotal: musicDriveItem.size };
    /** Bound a logical request including body, cache redirects, and throttle backoff. A
     * mixed batch can contain idempotent cache PUTs. Once dispatched, let that HTTP exchange
     * finish before acknowledging disconnect so a subsequent DELETE follows its writer. */
    async function sendBatch(requests: BatchRequest[]): Promise<{ responses: BatchResponse[] }> {
        const deadline = AbortSignal.timeout(45_000);
        const signal = cancel ? AbortSignal.any([cancel, deadline]) : deadline;
        const httpSignal = requests.some(r => r.method === 'PUT') ? deadline : signal;
        try {
            for (let attempt = 1; ; attempt++) {
                signal.throwIfAborted();
                const r = await authFetch('https://graph.microsoft.com/v1.0/$batch', false, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ requests }), signal: httpSignal,
                });
                httpSignal.throwIfAborted();
                const page = r.ok ? await readGraphJson(r, 'batch POST') : undefined;
                signal.throwIfAborted(); // A dispatched PUT has now delivered its subresponse.
                if (r.ok && !Array.isArray(page?.responses)) throw new Error(`batch POST missing responses[] status=${r.status}`);
                const throttled = r.ok
                    ? page.responses.find((sub: BatchResponse) => !sub.id.startsWith('cache-')
                        && (sub.status === 429 || sub.status === 503))
                    : undefined;
                const status = throttled?.status ?? r.status;
                if (status !== 429 && status !== 503) {
                    if (!r.ok) throw new Error(`batch POST failed status=${status}`);
                    await postprocessBatchResponse(page, followContent, signal);
                    signal.throwIfAborted();
                    return page;
                }
                if (attempt === 3) throw new IndexThrottleError(`batch POST still throttled status=${status} after ${attempt} attempts`);
                const headers = throttled ? new Headers(throttled.headers) : r.headers;
                const retryAfter = headers.get('Retry-After');
                const delay = retryAfter !== null && /^\d+$/.test(retryAfter) ? Number(retryAfter) : status === 429 ? 2 : 10;
                await waitForMsWithAbort(Math.min(delay, 45) * 1000, signal);
            }
        } catch (error) {
            signal.throwIfAborted(); // Preserve the distinction between timeout and user cancellation.
            throw error;
        }
    }

    const emitProgress = (item: WorkItem, extra?: string): void => {
        const pathStr = item.path.length === 0 ? 'Music' : item.path.join('/');
        onProgress({
            fraction: (stats.bytesFromCache + stats.bytesProcessed) / stats.bytesTotal,
            message: extra ? `${pathStr} — ${extra}` : pathStr,
        });
    };

    while (true) {
        cancel?.throwIfAborted();
        const item = toProcess.shift();

        if (item && item.state === 'START') {
            // ==================== PROCESS START ====================
            const cacheResult = item.responses[`cache-${item.data.folder.id}`];
            const childrenResult = item.responses[`children-${item.data.folder.id}`];

            if (childrenResult.status !== 200 || !Array.isArray(childrenResult.body?.value)) {
                throw new Error(`children listing failed id=${childrenResult.id} status=${childrenResult.status}`);
            }

            if (cacheResult?.status === 200 && isCurrentIndex(cacheResult.body, item.driveItem)) {
                stats.bytesFromCache += item.data.size;
                toProcess.unshift({ ...item, data: cacheResult.body, state: 'END', requests: [], responses: {} });
                emitProgress(item, 'cached');
                continue;
            }

            // One $top=10000 listing per folder is the deliberate M3 indexing tradeoff.
            for (const child of childrenResult.body.value) {
                if (child.folder) {
                    const newFolder: MusicFolder = { id: child.id, children: Object.create(null) };
                    (item.data.folder.children as any)[child.name] = newFolder;
                    toFetch.push(createStartWorkItem(child, [...item.path, child.name], newFolder, item.driveId, item.cacheNamespace, item));
                    item.remainingSubfolders++;
                } else if (child.file && AUDIO_RE.test(child.name)) {
                    (item.data.folder.children as any)[child.name] = { id: child.id };
                    stats.bytesProcessed += child.size;
                } else if (child.file) {
                    stats.bytesProcessed += child.size;
                }
            }

            // If no subfolders, this item is complete — upload cache
            if (item.remainingSubfolders === 0) {
                toFetch.unshift(createEndWorkItem(item));
            } else {
                // Sort alphabetically to finish subtrees faster
                toFetch.sort((a, b) => a.path.join('/').localeCompare(b.path.join('/')));
            }
            emitProgress(item);

        } else if (item && item.state === 'END') {
            // ==================== PROCESS END ====================
            emitProgress(item);

            // Every child completes exactly once, whether enumerated or read from cache.
            const parent = item.parent;
            if (!parent) return item.data;
            (parent.data.folder.children as Record<string, MusicFolder | MusicFile>)[item.driveItem.name] = item.data.folder;
            if (--parent.remainingSubfolders === 0) toFetch.unshift(createEndWorkItem(parent));

        } else {
            // ==================== FETCH BATCH ====================
            const thisFetch: WorkItem[] = [];
            const requests: BatchRequest[] = [];
            // Batch API limit is 20; use 18 for headroom (each item has 1-2 requests)
            while (toFetch.length > 0 && requests.length < 18) {
                const next = toFetch.shift()!;
                requests.push(...next.requests);
                thisFetch.push(next);
            }

            if (!requests.length) throw new Error('Index queue exhausted before completing the root');
            const batchResult = await sendBatch(requests);
            onBatchSuccess(requests.length);

            // Distribute responses to their WorkItems
            for (const r of batchResult.responses) {
                const owner = thisFetch.find(w => w.requests.some(req => req.id === r.id))!;
                owner.responses[r.id] = r;
            }
            toProcess.push(...thisFetch);
        }
    }
}

/**
 * Builds the music index by walking OneDrive Music folder. Uses a work-queue
 * with batch Graph API requests. Per-folder cache files in the App folder
 * enable fast subtree reuse.
 *
 * Ordinary failures retry the build up to six times. Three failures without
 * successful batch progress stop it earlier. Abort and throttle deadlines propagate.
 */
export async function buildIndex(
    musicDriveItem: MusicDriveItem,
    onProgress: (p: IndexProgress) => void,
    authFetch: AuthFetch,
    driveId: string,
    cacheNamespace: string,
    followContent: ContentFollow = (url, signal) => fetch(url, { signal, credentials: 'omit' }),
    signal?: AbortSignal,
): Promise<MusicData> {
    let poisonCount = 0;
    let attemptNo = 0;
    while (true) {
        attemptNo++;
        try {
            return await buildIndexSingleAttempt(
                musicDriveItem,
                onProgress,
                authFetch,
                driveId,
                cacheNamespace,
                followContent,
                signal,
                (requestCount) => {
                    if (poisonCount === 0) return;
                    poisonCount = 0;
                    log(
                        `index retry poison reset attempt=${attemptNo} `
                        + `index=${cacheNamespace === 'primary' ? 'primary' : 'share'} requestCount=${requestCount}`
                    );
                },
            );
        } catch (e) {
            signal?.throwIfAborted();
            if (e instanceof IndexThrottleError || (e instanceof Error && e.name === 'TimeoutError')) throw e;
            poisonCount++;
            // A repeatable failure after the same successful batch must still terminate.
            const exhausted = poisonCount >= 3 || attemptNo >= 6;
            const action = exhausted ? 'abandon' : 'retry';
            logError(
                `index retry poison increment attempt=${attemptNo} action=${action} `
                + `poison=${poisonCount}/3 index=${cacheNamespace === 'primary' ? 'primary' : 'share'} `
                + `reason=retry-all-failures: ${errorDetail(e)}`
            );
            if (exhausted) {
                logError(
                    `index retry abandon poison=${poisonCount}/3 `
                    + `index=${cacheNamespace === 'primary' ? 'primary' : 'share'} `
                    + (poisonCount >= 3 ? 'reason=3 consecutive failures' : 'reason=6 build attempts')
                );
                throw e;
            }
        }
    }
}
