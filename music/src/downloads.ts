/**
 * Offline download engine for OnePlay Music.
 *
 * Pure download queue with no knowledge of favorites or track resolution.
 * The caller (index.ts) computes which track keys are pinned and pushes
 * them in via setPinnedKeys(). This module handles the queue, concurrent
 * download workers, error classification, storage, and quota management.
 *
 * STATE MODEL:
 * - evidence: owned by the auth module. Downloads reads it via deps.getEvidence()
 *   and reacts via handleEvidenceTransition(). Downloads only pump when
 *   evidence is 'evidence:signed-in'. Error classification in download workers
 *   calls deps.transitionEvidence() to push state changes back to auth.
 * - activeKeys/retainKeys: pushed by caller. activeKeys determines the
 *   download queue; retainKeys determines GC retention.
 * - queue: ordered list of {driveId, itemId} to download.
 * - isOverQuota: set when total audio bytes exceed quotaBytes.
 *
 * INVARIANTS:
 * - At most MAX_CONCURRENT downloads in flight at any time.
 * - Queue = activeKeys − downloaded.
 * - GC: downloaded − retainKeys → audioDelete. GC skipped when
 *   retainKeys is empty (guards against incomplete index state).
 * - Single-flight queue recalculation via dirty-flag loop.
 * - AbortController + generation counter for abort safety.
 * - activeKeys ⊆ retainKeys (enforced in setPinnedKeys).
 */

import {
    audioGet, audioPut, audioDelete, audioKeys, audioTotalBytes, audioClear,
} from './db.js';
import { type EvidenceState, type AuthFetch, classifyEvidence } from './auth.js';
import { log, logError, errorMessage, errorDetail } from './logger.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_CONCURRENT = 2;
const DEFAULT_QUOTA_BYTES = 1 * 1024 * 1024 * 1024; // 1 GB
export const QUOTA_OPTIONS_GB = [1, 2, 5, 10];
const QUOTA_LS_KEY = 'oneplay_music_quota_bytes';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface QueueItem {
    readonly driveId: string;
    readonly itemId: string;
}

/** Atomic snapshot of download engine state. */
export interface DownloadSnapshot {
    readonly downloadedKeys: ReadonlySet<string>;
    readonly queuedKeys: ReadonlySet<string>;
    readonly overQuota: boolean;
    readonly lastError: string | undefined;
    readonly evidence: EvidenceState;
    readonly quotaBytes: number;
    readonly totalBytes: number;
}

/** Public API returned by createDownloads. */
export interface Downloads {
    /**
     * Pushes the set of track keys that should be downloaded (activeKeys)
     * and the set that should be retained in storage (retainKeys).
     * INVARIANT: activeKeys ⊆ retainKeys.
     * Triggers queue recalculation if signed in.
     */
    setPinnedKeys(activeKeys: ReadonlySet<string>, retainKeys: ReadonlySet<string>): void;
    /** Notifies the download engine that evidence changed externally.
     *  Reads current state from deps.getEvidence() and reacts (start/stop
     *  pump, clear errors, notifyUI). */
    handleEvidenceTransition(): void;
    /** Returns an offline blob for a track, or undefined if not cached. */
    getOfflineBlob(driveId: string, itemId: string): Promise<Blob | undefined>;
    /** Returns an atomic snapshot of engine state. */
    getSnapshot(): DownloadSnapshot;
    /** Updates the storage quota (persists to localStorage). */
    setQuota(gb: number): void;
    /** Clears the latched error, allowing downloads to retry. */
    clearError(): void;
    /** Clears all downloaded audio and resets state. */
    clear(): Promise<void>;
    /** Called by the engine when state changes (download progress, errors, etc.). */
    onStateChange: () => void;
}

export interface DownloadsDeps {
    authFetch: AuthFetch;
    fetcher: (url: string, options?: RequestInit) => Promise<Response>;
    audioPut: typeof audioPut;
    audioGet: typeof audioGet;
    audioDelete: typeof audioDelete;
    audioKeys: typeof audioKeys;
    audioTotalBytes: typeof audioTotalBytes;
    audioClear: typeof audioClear;
    loadQuotaBytes(): number;
    saveQuotaBytes(bytes: number): void;
    /** Returns navigator.onLine (reliable negative signal: false = definitely offline). */
    isOnline(): boolean;
    /** Returns the current evidence state (owned by auth module). */
    getEvidence(): EvidenceState;
    /** Transitions evidence state (owned by auth module). */
    transitionEvidence(state: EvidenceState): void;
    /** Returns whether the user has a plausible access token. */
    isSignedIn(): boolean;
}

// ---------------------------------------------------------------------------
// Default deps (production) — excludes auth-related deps which must be injected
// ---------------------------------------------------------------------------

const defaultDeps = {
    fetcher: (url: string, options?: RequestInit) => fetch(url, options),
    audioPut, audioGet, audioDelete, audioKeys, audioTotalBytes, audioClear,
    loadQuotaBytes: () => {
        const raw = localStorage.getItem(QUOTA_LS_KEY);
        return raw ? parseInt(raw, 10) || DEFAULT_QUOTA_BYTES : DEFAULT_QUOTA_BYTES;
    },
    saveQuotaBytes: (bytes: number) => {
        try { localStorage.setItem(QUOTA_LS_KEY, String(bytes)); } catch { /* quota */ }
    },
    isOnline: () => navigator.onLine,
} satisfies Partial<DownloadsDeps>;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates the download engine. Auth-related deps (authFetch, evidence, isSignedIn)
 * must be provided; I/O deps default to production implementations.
 * The engine has no knowledge of favorites — it operates purely on track key
 * sets pushed in by the caller.
 */
export function createDownloads(deps: Partial<DownloadsDeps> & Pick<DownloadsDeps, 'authFetch' | 'getEvidence' | 'transitionEvidence' | 'isSignedIn'>): Downloads {
    const d: DownloadsDeps = { ...defaultDeps, ...deps } as DownloadsDeps;

    // -- State ---------------------------------------------------------------

    let dirty = true;
    let queue: QueueItem[] = [];
    let overQuota = false;
    let activeDownloads = 0;
    let generation = 0; // monotonic epoch; bumped on abort to invalidate old tasks
    let quotaBytes: number = d.loadQuotaBytes();
    let lastError: string | undefined;
    let totalBytes = 0; // tracked incrementally
    let queueDrainedLogged = false;

    // -- Pinned keys (pushed by caller via setPinnedKeys) --------------------

    let activeKeys: ReadonlySet<string> = new Set();
    let retainKeys: ReadonlySet<string> = new Set();

    // -- Downloaded keys set (refreshed during recalculation) ----------------

    let downloadedKeys: Set<string> = new Set();

    // -- AbortController for in-flight downloads -----------------------------

    let abortController: AbortController | undefined;

    // -- Single-flight guard for recalculateQueue ----------------------------

    let recalculating = false;

    // -- Notify UI -----------------------------------------------------------

    const notifyUI = (): void => {
        try { downloads.onStateChange(); } catch { /* caller error must not break engine */ }
    };

    // -- Queue recalculation -------------------------------------------------

    /**
     * Recalculates the download queue from activeKeys/retainKeys, then
     * starts the download pump. Returns void (not Promise) — all errors
     * are handled internally, enforcing fire-and-forget at the type level.
     * Single-flight: if already running, sets dirty and returns.
     * The running call loops if dirty was re-set during execution.
     */
    function recalculate(): void {
        if (recalculating) { dirty = true; return; }
        recalculating = true;

        // Abort any in-flight downloads from previous queue
        abortController?.abort();
        abortController = new AbortController();
        generation++;
        activeDownloads = 0; // orphaned workers skip decrement; reset here

        (async () => {
            try {
                do {
                    dirty = false;

                    // 1. Get existing downloaded keys
                    const existingKeys = await d.audioKeys().catch((e: unknown) => {
                        logError(`downloads: audioKeys failed: ${e}`);
                        return [] as string[];
                    });
                    const existingSet = new Set(existingKeys);
                    downloadedKeys = existingSet;

                    // 2. Queue = activeKeys − downloaded
                    queue = Array.from(activeKeys)
                        .filter(k => !existingSet.has(k))
                        .map(k => { const [driveId, itemId] = k.split(':'); return { driveId, itemId }; });
                    queueDrainedLogged = false;
                    log(`downloads: queue recalculated queued=${queue.length} active=${activeKeys.size} retain=${retainKeys.size} downloaded=${downloadedKeys.size}`);

                    // 3. Garbage collect: downloaded − retainKeys → delete
                    //    GC safety: skip when retainKeys is empty (incomplete index guard)
                    if (retainKeys.size > 0) {
                        for (const key of existingKeys) {
                            if (!retainKeys.has(key)) {
                                const blob = await d.audioGet(key).catch(() => undefined);
                                const blobSize = blob?.size ?? 0;
                                await d.audioDelete(key).catch((e: unknown) => {
                                    logError(`downloads: audioDelete failed for ${key}: ${e}`);
                                });
                                downloadedKeys.delete(key);
                                totalBytes = Math.max(0, totalBytes - blobSize);
                            }
                        }
                    }

                    // 4. Recalculate totalBytes from scratch (accurate baseline)
                    totalBytes = await d.audioTotalBytes().catch((e: unknown) => {
                        logError(`downloads: audioTotalBytes failed: ${e}`);
                        return 0;
                    });

                    // 5. Check quota
                    overQuota = totalBytes > quotaBytes;
                    lastError = undefined;

                } while (dirty);
            } catch (e) {
                logError(`downloads: recalculate failed: ${e}`);
            } finally {
                recalculating = false;
            }

            // Start pump
            pumpDownloads();
            notifyUI();
        })();
    }

    // -- Download pump -------------------------------------------------------

    function pumpDownloads(): void {
        while (activeDownloads < MAX_CONCURRENT && queue.length > 0
            && d.getEvidence() === 'evidence:signed-in' && !overQuota) {
            const item = queue.shift()!;
            activeDownloads++;
            downloadOneTrack(item);
        }
    }

    /**
     * Downloads a single track. Returns void (not Promise) — all errors
     * are handled internally, enforcing fire-and-forget at the type level.
     * Captures the current generation at start; refuses to commit writes
     * if the generation has advanced (abort safety).
     *
     * Error classification per DESIGN.md:
     * - 404 → remove from queue (track deleted/moved)
     * - 429/500/502/503 → push to back of queue (transient)
     * - timeout/408/504 → transition to no-evidence
     * - 401 post-refresh → transition to evidence:signed-out
     * - Network exceptions (TypeError: Failed to fetch) → push to back (transient)
     * - Other errors → remove from queue
     */
    function downloadOneTrack(item: QueueItem): void {
        const key = `${item.driveId}:${item.itemId}`;
        const signal = abortController?.signal;
        const myGeneration = generation;

        (async () => {
            try {
                // 1. Fetch download URL via Graph API
                const metaR = await d.authFetch(
                    `https://graph.microsoft.com/v1.0/drives/${encodeURIComponent(item.driveId)}/items/${encodeURIComponent(item.itemId)}?$select=@microsoft.graph.downloadUrl`,
                    false,
                    { signal },
                );
                if (signal?.aborted || myGeneration !== generation) return;

                if (!metaR.ok) {
                    classifyHttpError(metaR.status, item);
                    return;
                }

                const meta = await metaR.json();
                const downloadUrl: string | undefined = meta['@microsoft.graph.downloadUrl'];
                if (!downloadUrl) {
                    logError(`download: no URL for ${key}`);
                    return; // remove from queue (don't re-add)
                }

                // 2. Fetch the audio data (plain fetch, SAS-token URL)
                const audioR = await d.fetcher(downloadUrl, { signal });
                if (signal?.aborted || myGeneration !== generation) return;

                if (!audioR.ok) {
                    classifyHttpError(audioR.status, item);
                    return;
                }

                const blob = await audioR.blob();
                if (signal?.aborted || myGeneration !== generation) return;

                // 3. Store in IndexedDB (generation guard prevents stale writes)
                await d.audioPut(key, blob);
                if (myGeneration !== generation) return;
                downloadedKeys.add(key);
                totalBytes += blob.size;

            } catch (e) {
                if (signal?.aborted || myGeneration !== generation) return;
                const msg = errorMessage(e);
                if (msg.includes('timeout') || msg.includes('abort')) {
                    const target = d.isOnline() ? 'no-evidence' : 'evidence:not-online';
                    lastError = msg;
                    d.transitionEvidence(target);
                    logError(`download: connectivity lost (${errorDetail(e)}) → ${target}`);
                } else if (msg.includes('fetch') || msg.includes('network') || msg.includes('Failed to fetch')) {
                    // Transient network error: consult navigator.onLine for state
                    const target = d.isOnline() ? 'no-evidence' : 'evidence:not-online';
                    queue.push(item);
                    d.transitionEvidence(target);
                    logError(`download: transient network error for ${key}: ${errorDetail(e)} → ${target}`);
                } else {
                    lastError = msg;
                    logError(`download error for ${key}: ${errorDetail(e)}`);
                }
            } finally {
                if (myGeneration === generation) {
                    activeDownloads--;
                    // Check if quota is now exceeded
                    overQuota = totalBytes > quotaBytes;
                    pumpDownloads();
                    if (
                        !queueDrainedLogged
                        && queue.length === 0
                        && activeDownloads === 0
                        && activeKeys.size > 0
                        && d.getEvidence() === 'evidence:signed-in'
                    ) {
                        queueDrainedLogged = true;
                        log(`downloads: queue drained downloaded=${downloadedKeys.size} retain=${retainKeys.size}`);
                    }
                    notifyUI();
                }
                // If generation advanced, this task is orphaned — don't touch state.
            }
        })();
    }

    /** Classifies an HTTP error status and takes action on the queue item.
     * For auth-wrapped fetches (metadata), evidence is already classified by
     * auth.fetch. For plain fetches (SAS-token audio), uses classifyEvidence.
     * Queue management: 404 → remove, 429/5xx → retry, timeout → pause. */
    function classifyHttpError(status: number, item: QueueItem): void {
        if (status === 429 || status === 500 || status === 502 || status === 503) {
            // Transient: push to back of queue for retry
            queue.push(item);
            logError(`download: ${status} for ${item.driveId}:${item.itemId}, retrying later`);
        } else if (status === 408 || status === 504) {
            // Timeout: classify evidence via the shared utility
            lastError = `HTTP ${status}`;
            d.transitionEvidence(classifyEvidence(status, d.isSignedIn(), d.isOnline()));
            logError(`download: ${status}, pausing downloads`);
        } else if (status === 401) {
            // Auth failure
            lastError = 'Authentication failed';
            d.transitionEvidence('evidence:signed-out');
            logError(`download: 401, signed out`);
        } else {
            // Other (including 404): remove from queue
            logError(`download: ${status} for ${item.driveId}:${item.itemId}, removing`);
        }
    }

    // -- Helpers -------------------------------------------------------------

    /** Shallow set equality: same size and every element of a is in b. */
    function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
        if (a.size !== b.size) return false;
        for (const k of a) if (!b.has(k)) return false;
        return true;
    }

    /** Builds a Set of queued keys for the snapshot. */
    function queuedKeysSet(): ReadonlySet<string> {
        return new Set(queue.map(item => `${item.driveId}:${item.itemId}`));
    }

    // -- Public API ----------------------------------------------------------

    const downloads: Downloads = {
        setPinnedKeys(newActiveKeys, newRetainKeys) {
            // Enforce invariant: activeKeys ⊆ retainKeys
            const enforced = new Set(newRetainKeys);
            for (const k of newActiveKeys) enforced.add(k);

            // Skip if unchanged (prevents feedback loop: onStateChange → computeAndPush → setPinnedKeys → recalculate → onStateChange)
            if (setsEqual(newActiveKeys, activeKeys) && setsEqual(enforced, retainKeys)) return;

            activeKeys = new Set(newActiveKeys); // defensive copy
            retainKeys = enforced;
            dirty = true;

            if (d.getEvidence() === 'evidence:signed-in') {
                recalculate();
            }
        },

        handleEvidenceTransition() {
            const newState = d.getEvidence();
            log(`downloads: evidence → ${newState}`);

            if (newState === 'evidence:signed-in' && dirty) {
                recalculate();  // recalculate calls notifyUI internally
            } else if (newState === 'evidence:signed-in' && !dirty) {
                // Not dirty but signed in: clear latched error, resume pump
                lastError = undefined;
                pumpDownloads();
                notifyUI();
            } else {
                // Non-signed-in transitions: UI must update (grey tracks,
                // evidence indicator, static ↓ icons) even though pump doesn't run.
                notifyUI();
            }
            // All non-signed-in states (no-evidence, signed-out, not-online):
            // pump is already guarded by the d.getEvidence() === 'evidence:signed-in' check.
            // No special action needed. In-flight downloads fail naturally via
            // error classification; the generation counter prevents stale writes.
        },

        async getOfflineBlob(driveId, itemId) {
            return d.audioGet(`${driveId}:${itemId}`);
        },

        getSnapshot(): DownloadSnapshot {
            return {
                downloadedKeys: new Set(downloadedKeys), // defensive copy for snapshot immutability
                queuedKeys: queuedKeysSet(),
                overQuota,
                lastError,
                evidence: d.getEvidence(),
                quotaBytes,
                totalBytes,
            };
        },

        setQuota(gb) {
            quotaBytes = gb * 1024 * 1024 * 1024;
            d.saveQuotaBytes(quotaBytes);
            dirty = true;
            if (d.getEvidence() === 'evidence:signed-in') {
                recalculate();
            }
        },

        clearError() {
            if (!lastError) return;
            lastError = undefined;
            dirty = true;
            if (d.getEvidence() === 'evidence:signed-in') {
                recalculate();
            }
            notifyUI();
        },

        async clear() {
            abortController?.abort();
            abortController = new AbortController();
            generation++; // orphan any in-flight tasks
            queue = [];
            activeDownloads = 0;
            downloadedKeys.clear();
            overQuota = false;
            lastError = undefined;
            totalBytes = 0;
            await d.audioClear();
            notifyUI();
        },

        onStateChange: () => {},
    };

    return downloads;
}
