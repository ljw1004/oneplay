/**
 * Music indexer for OnePlay Music.
 *
 * Builds a complete tree of all folders and audio files in the user's OneDrive
 * Music folder, using a work-queue with batch Graph API requests. Per-folder
 * cache files in the OneDrive App folder enable fast re-indexing: completed
 * subtrees are reused when their `size` hasn't changed (Merkle property).
 *
 * MERKLE PROPERTY: OneDrive computes each folder's `size` as the total bytes
 * of all files in all descendant folders. If ANY file anywhere in a subtree is
 * added, removed, or modified, the `size` changes propagate up to every
 * ancestor. Comparing a cached MusicData's `size` against the live folder
 * `size` therefore answers "has anything changed in this entire subtree?"
 * without traversing it. This is the basis for cache validation: if size +
 * schemaVersion match, the cached subtree is reused as-is. This property also
 * enables resumability — if indexing is interrupted, completed subtrees have
 * their cache files on OneDrive, and on resume those subtrees pass the size
 * check and are skipped.
 *
 * Adapted from example/musicdata.ts and example/utils.ts.
 */

import { log, logError, logCatch, errorDetail } from './logger.js';
import { type AuthFetch } from './auth.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SCHEMA_VERSION = 1;
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

/**
 * Cache filename for a folder path. Root → "index.json", otherwise segments
 * joined by underscore. Prioritizes human readability in the App folder.
 */
const cacheFilename = (path: string[], cacheNamespace: string): string => {
    const ns = cacheNamespace.trim().replace(/^\/+|\/+$/g, '');
    const prefix = ns ? `${ns}/` : '';
    return path.length === 0 ? `${prefix}index.json` : `${prefix}${path.join('_')}.json`;
};

/** Counts all MusicFile nodes recursively under a folder. */
export function countTracks(folder: MusicFolder): number {
    return Object.values(folder.children).reduce(
        (n, child) => n + (isMusicFolder(child) ? countTracks(child) : 1), 0
    );
}

/**
 * Fetches driveId + displayName from GET /me/drive.
 * Returns the account info on success, or a failure reason:
 * - 'auth': server responded but auth failed (proves connectivity)
 * - 'network': couldn't reach the server (no connectivity evidence)
 */
export async function fetchAccountInfo(
    authFetch: AuthFetch,
): Promise<AccountInfo | 'auth' | 'network'> {
    const r = await authFetch(
        'https://graph.microsoft.com/v1.0/me/drive?$select=id,owner',
        false
    );
    if (!r.ok) {
        logError(`fetchAccountInfo: ${r.status} ${r.statusText}`);
        // Any 4xx = server processed our request and rejected it, proving
        // connectivity. This includes 401/403 (auth expired) and 400
        // (invalid_grant from token refresh). 5xx and synthetic 503
        // (from errorResponse wrapping network exceptions) = no evidence.
        return (r.status >= 400 && r.status < 500) ? 'auth' : 'network';
    }
    const data = await r.json();
    return { driveId: data.id, displayName: data.owner?.user?.displayName ?? 'OneDrive' };
}

// ---------------------------------------------------------------------------
// Work-item constructors
// ---------------------------------------------------------------------------

/** Creates a START WorkItem with requests for children listing and cache read. */
function createStartWorkItem(
    driveItem: any,
    path: string[],
    folder: MusicFolder,
    driveId: string,
    cacheNamespace: string,
): WorkItem {
    return {
        state: 'START',
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
    const json = JSON.stringify(item.data);
    const utf8 = new TextEncoder().encode(json);
    const b64 = btoa(Array.from(utf8, b => String.fromCharCode(b)).join(''));
    return {
        ...item,
        state: 'END',
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
 *    follow them with a plain fetch (the redirect URL contains a SAS token;
 *    an extra Bearer header is harmless).
 * 2. Base64-encoded JSON: when batch claims application/json but the body is
 *    a string, it's base64-of-utf8 JSON. Decode it.
 *
 * Adapted from example/utils.ts lines 41-62.
 */
async function postprocessBatchResponse(response: any): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const r of response.responses) {
        if (r.status === 302) {
            promises.push(
                (async (): Promise<void> => {
                    try {
                        const location = typeof r.headers?.Location === 'string' ? r.headers.Location : '';
                        const rr = await fetch(location);
                        r.headers = {} as any;
                        rr.headers.forEach((value: string, key: string) => r.headers[key] = value);
                        r.status = rr.status;
                        try {
                            r.body = rr.headers.get('Content-Type')?.includes('application/json')
                                ? await rr.json()
                                : await rr.text();
                        } catch (e) {
                            logCatch('postprocessBatchResponse')(e);
                        }
                    } catch (e) {
                        // Wrap redirect-follow network failures with batch context so
                        // index logs include a concrete failing response id + URL.
                        throw new Error(
                            `batch redirect follow failed id=${String(r.id)} `
                            + `location=${String(r.headers?.Location ?? '<missing>')} `
                            + `detail=${errorDetail(e)}`
                        );
                    }
                })()
            );
        } else if (r.headers?.['Content-Type']?.includes('application/json') && typeof r.body === 'string') {
            r.body = JSON.parse(
                new TextDecoder().decode(Uint8Array.from(atob(r.body), c => c.codePointAt(0)!))
            );
        }
    }
    await Promise.all(promises);
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
    onBatchSuccess: (requestCount: number) => void,
): Promise<MusicData> {
    const root: MusicFolder = { id: musicDriveItem.id, children: {} };
    const toProcess: WorkItem[] = [];
    const toFetch: WorkItem[] = [createStartWorkItem(musicDriveItem, [], root, driveId, cacheNamespace)];
    const waiting = new Map<string, WorkItem>();
    const stats = { bytesFromCache: 0, bytesProcessed: 0, bytesTotal: musicDriveItem.size };
    let trackCount = 0;
    let got429recently = false;

    const emitProgress = (item: WorkItem, extra?: string): void => {
        const pathStr = item.path.length === 0 ? 'Music' : item.path.join('/');
        onProgress({
            fraction: (stats.bytesFromCache + stats.bytesProcessed) / stats.bytesTotal,
            message: extra ? `${pathStr} — ${extra}` : pathStr,
        });
    };

    while (true) {
        const item = toProcess.shift();

        if (item && item.state === 'START') {
            // ==================== PROCESS START ====================
            const cacheResult = item.responses[`cache-${item.data.folder.id}`];
            const childrenResult = item.responses[`children-${item.data.folder.id}`];

            // 429/503 on children listing: re-queue and delay
            if (childrenResult.status === 429 || childrenResult.status === 503) {
                toFetch.unshift({ ...item, responses: {} });
                got429recently = true;
                emitProgress(item, 'throttled');
                continue;
            }

            // Error on children listing
            if (childrenResult.body?.error) {
                logError(`children error: ${JSON.stringify(childrenResult.body.error)}`);
                // Skip this folder rather than crashing — log and continue
                continue;
            }

            // Cache hit: size and schemaVersion match → reuse entire subtree
            if (cacheResult.status === 200
                && cacheResult.body?.size === item.data.size
                && cacheResult.body?.schemaVersion === SCHEMA_VERSION) {
                stats.bytesFromCache += item.data.size;
                trackCount += cacheResult.body.count;
                // Graft cached folder into the shared root tree
                if (item.path.length > 0) {
                    const parentFolder = item.path.slice(0, -1).reduce(
                        (f, name) => (f.children as any)[name] as MusicFolder, root
                    );
                    (parentFolder.children as any)[item.path[item.path.length - 1]] = cacheResult.body.folder;
                }
                toProcess.unshift({
                    ...item, data: cacheResult.body, state: 'END', requests: [], responses: {},
                });
                emitProgress(item, 'cached');
                continue;
            }

            // Cache miss: enumerate children
            for (const child of childrenResult.body.value) {
                if (child.folder) {
                    const newFolder: MusicFolder = { id: child.id, children: {} };
                    (item.data.folder.children as any)[child.name] = newFolder;
                    toFetch.push(createStartWorkItem(child, [...item.path, child.name], newFolder, item.driveId, item.cacheNamespace));
                    item.remainingSubfolders++;
                } else if (child.file && AUDIO_RE.test(child.name)) {
                    (item.data.folder.children as any)[child.name] = { id: child.id };
                    stats.bytesProcessed += child.size;
                    trackCount++;
                } else if (child.file) {
                    stats.bytesProcessed += child.size;
                }
            }

            // If no subfolders, this item is complete — upload cache
            if (item.remainingSubfolders === 0) {
                (item.data as any).count = countTracks(item.data.folder);
                toFetch.unshift(createEndWorkItem(item));
            } else {
                // Sort alphabetically to finish subtrees faster
                toFetch.sort((a, b) =>
                    cacheFilename(a.path, a.cacheNamespace).localeCompare(cacheFilename(b.path, b.cacheNamespace)));
                waiting.set(cacheFilename(item.path, item.cacheNamespace), item);
            }
            emitProgress(item);

        } else if (item && item.state === 'END') {
            // ==================== PROCESS END ====================
            emitProgress(item);

            // Root folder done — return the complete index
            if (item.path.length === 0) {
                (item.data as any).count = trackCount;
                return item.data;
            }

            // Merge into parent via shared mutable root
            const parentFolder = item.path.slice(0, -1).reduce(
                (f, name) => (f.children as any)[name] as MusicFolder, root
            );
            (parentFolder.children as any)[item.path[item.path.length - 1]] = item.data.folder;

            // Decrement parent's remaining count; if done, push parent's END
            const parentKey = cacheFilename(item.path.slice(0, -1), item.cacheNamespace);
            const parentWorkItem = waiting.get(parentKey)!;
            parentWorkItem.remainingSubfolders--;
            if (parentWorkItem.remainingSubfolders === 0) {
                waiting.delete(parentKey);
                (parentWorkItem.data as any).count = countTracks(parentWorkItem.data.folder);
                toFetch.unshift(createEndWorkItem(parentWorkItem));
            }

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

            if (got429recently) {
                await new Promise(r => setTimeout(r, 10_000));
                got429recently = false;
            }

            const batchResponse = await authFetch(
                'https://graph.microsoft.com/v1.0/$batch',
                true,
                { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requests }) },
            );
            if (!batchResponse.ok) {
                const body = await batchResponse.text()
                    .catch((readErr: unknown) => `<body unreadable: ${errorDetail(readErr)}>`);
                const condensedBody = body.trim().replace(/\s+/g, ' ').slice(0, 240);
                throw new Error(
                    `batch POST failed status=${batchResponse.status} `
                    + `statusText=${batchResponse.statusText || '<empty>'} `
                    + `body=${condensedBody || '<empty>'}`
                );
            }

            const rawBatchResult = await batchResponse.text().catch((readErr: unknown): never => {
                throw new Error(
                    `batch POST ok but body unreadable status=${batchResponse.status} `
                    + `statusText=${batchResponse.statusText || '<empty>'} `
                    + `detail=${errorDetail(readErr)}`
                );
            });
            let batchResult: any;
            try {
                batchResult = JSON.parse(rawBatchResult);
            } catch (parseErr) {
                const snippet = rawBatchResult.trim().replace(/\s+/g, ' ').slice(0, 240);
                throw new Error(
                    `batch POST ok but invalid JSON status=${batchResponse.status} `
                    + `statusText=${batchResponse.statusText || '<empty>'} `
                    + `snippet=${snippet || '<empty>'} `
                    + `detail=${errorDetail(parseErr)}`
                );
            }
            if (!Array.isArray(batchResult?.responses)) {
                const snippet = rawBatchResult.trim().replace(/\s+/g, ' ').slice(0, 240);
                throw new Error(
                    `batch POST ok but missing responses[] status=${batchResponse.status} `
                    + `statusText=${batchResponse.statusText || '<empty>'} `
                    + `snippet=${snippet || '<empty>'}`
                );
            }
            await postprocessBatchResponse(batchResult);
            onBatchSuccess(requests.length);

            // Distribute responses to their WorkItems
            for (const r of batchResult.responses) {
                const owner = thisFetch.find(w => w.requests.some(req => req.id === r.id))!;
                owner.responses[r.id] = r;
                // Check for 429/503 in individual responses
                if (r.status === 429 || r.status === 503) got429recently = true;
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
 * On any failure, retries the whole build with a poison counter: increment on
 * attempt failure, reset after any successful batch, and give up at 3.
 */
export async function buildIndex(
    musicDriveItem: MusicDriveItem,
    onProgress: (p: IndexProgress) => void,
    authFetch: AuthFetch,
    driveId: string,
    cacheNamespace: string,
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
                (requestCount) => {
                    if (poisonCount === 0) return;
                    poisonCount = 0;
                    log(
                        `index retry poison reset attempt=${attemptNo} `
                        + `cacheNamespace=${cacheNamespace} requestCount=${requestCount}`
                    );
                },
            );
        } catch (e) {
            poisonCount++;
            const action = poisonCount >= 3 ? 'abandon' : 'retry';
            logError(
                `index retry poison increment attempt=${attemptNo} action=${action} `
                + `poison=${poisonCount}/3 cacheNamespace=${cacheNamespace} `
                + `reason=retry-all-failures: ${errorDetail(e)}`
            );
            if (poisonCount >= 3) {
                logError(
                    `index retry abandon poison=${poisonCount}/3 `
                    + `cacheNamespace=${cacheNamespace} `
                    + 'reason=3 consecutive failures'
                );
                throw e;
            }
        }
    }
}
