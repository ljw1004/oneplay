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
 *   delegates evidence interpretation to auth-owned deps helpers.
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
 * - Rebuilding the queue cancels its previous requests before reading the local inventory.
 * - activeKeys ⊆ retainKeys (enforced in setPinnedKeys).
 */

import {
    audioGet, audioPut, audioDeleteBatch, audioFileSizes, audioClear,
} from './db.js';
import type { FolderPin } from './favorites.js';
import type { EvidenceState } from './auth.js';
import { MediaTransientError, MediaUnavailableError, ProviderHttpError, type BrowserMedia } from './provider.js';
import { log, logError, logCatch, errorMessage, errorDetail } from './logger.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_CONCURRENT = 2;
const DEFAULT_QUOTA_BYTES = 1 * 1024 * 1024 * 1024; // 1 GB
export const QUOTA_OPTIONS_GB = [1, 2, 5, 10];
const QUOTA_LS_KEY = 'oneplay_music_quota_bytes';

/** Both the tree arrow and the open dialog report the same local progress. Until an
 * index tells us about a missing file, an incomplete owner has nothing it can download. */
export function classifyOfflineBadgeState(progress: PinProgress | undefined,
    snapshot: Pick<DownloadSnapshot, 'evidence' | 'overQuota' | 'lastError' | 'transferAllowed'>,
    paused: boolean): 'complete' | 'downloading' | 'paused' {
    if (progress?.complete && progress.downloaded === progress.total) return 'complete';
    if (!progress || progress.downloaded + (progress.unavailable ?? 0) >= progress.total || paused || snapshot.overQuota
        || snapshot.lastError || !(snapshot.transferAllowed ?? (snapshot.evidence === 'evidence:signed-in'))) return 'paused';
    return 'downloading';
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface QueueItem {
    readonly driveId: string;
    readonly itemId: string;
}

/** Current download state. File sizes share the live read-only inventory exposed to playback and search. */
export interface DownloadSnapshot {
    readonly files: ReadonlyMap<string, number>;
    readonly queuedCount: number;
    readonly overQuota: boolean;
    readonly lastError: string | undefined;
    readonly evidence: EvidenceState;
    readonly transferAllowed?: boolean;
    readonly quotaBytes: number;
    readonly totalBytes: number;
}

/** Counts are local to this device. An incomplete index cannot certify the total. */
export interface PinProgress { total: number; downloaded: number; bytes: number; complete: boolean; unavailable?: number; warnings?: Set<string> }

/** Both offline dialogs share quota, inventory and owner progress controls. */
export type DownloadControls = Pick<Downloads, 'getSnapshot' | 'setQuota'> & {
    clearError?: Downloads['clearError'];
    favoriteProgress(id: string): PinProgress | undefined;
    folderProgress(folder?: FolderPin): (PinProgress & {childFolders?: number}) | undefined;
};

export interface Downloads {
    /**
     * Pushes the set of track keys that should be downloaded (activeKeys)
     * and the set that should be retained in storage (retainKeys).
     * INVARIANT: activeKeys ⊆ retainKeys.
     * Triggers queue recalculation immediately (pump remains evidence-gated).
     */
    setPinnedKeys(activeKeys: ReadonlySet<string>, retainKeys: ReadonlySet<string>, membershipComplete?: boolean): Promise<void>;
    /** Reconciles the pump and UI after a route or retry gate change. */
    handleEvidenceTransition(): void;
    /** Returns an offline blob for a track, or undefined if not cached. */
    getOfflineBlob(driveId: string, itemId: string): Promise<Blob | undefined>;
    /** Read the current inventory and queue state. */
    getSnapshot(): DownloadSnapshot;
    /** Updates the storage quota (persists to localStorage). */
    setQuota(gb: number): void;
    /** Rebuild the pending queue, including recordings that returned a terminal error. */
    clearError(): Promise<void>;
    /** Clears all downloaded audio and resets state. */
    clear(): Promise<void>;
    /** Called by the engine when state changes (download progress, errors, etc.). */
    onStateChange: (inventory?: { files: ReadonlyMap<string, number> } | { added: [string, number] } | { unavailable: string }) => void;
}

export interface DownloadsDeps {
    download: BrowserMedia['download'];
    audioPut: typeof audioPut;
    audioGet: typeof audioGet;
    audioDeleteBatch: typeof audioDeleteBatch;
    audioFileSizes: typeof audioFileSizes;
    audioClear: typeof audioClear;
    loadQuotaBytes(): number;
    saveQuotaBytes(bytes: number): void;
    /** Returns the current evidence state (owned by auth module). */
    getEvidence(): EvidenceState;
    /** Public media can attempt a transfer while reachability is still unknown. */
    canTransfer?(): boolean;
    /** Delegates HTTP status evidence classification to auth evidence owner. */
    provideEvidenceFromHttpStatus(status: number, reason: string): EvidenceState;
    /** Delegates error evidence classification to auth evidence owner. */
    provideEvidenceFromError(error: unknown, reason: string): EvidenceState;
}

// ---------------------------------------------------------------------------
// Default deps (production) — excludes auth-related deps which must be injected
// ---------------------------------------------------------------------------

const defaultDeps = {
    audioPut, audioGet, audioDeleteBatch, audioFileSizes, audioClear,
    loadQuotaBytes: () => {
        const raw = localStorage.getItem(QUOTA_LS_KEY);
        return raw ? parseInt(raw, 10) || DEFAULT_QUOTA_BYTES : DEFAULT_QUOTA_BYTES;
    },
    saveQuotaBytes: (bytes: number) => {
        try { localStorage.setItem(QUOTA_LS_KEY, String(bytes)); } catch { /* quota */ }
    },
} satisfies Partial<DownloadsDeps>;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates the download engine. The media operation and evidence helpers
 * must be provided; I/O deps default to production implementations.
 * The engine has no knowledge of favorites — it operates purely on track key
 * sets pushed in by the caller.
 */
export function createDownloads(
    deps: Partial<DownloadsDeps> & Pick<DownloadsDeps, 'download' | 'getEvidence' | 'provideEvidenceFromHttpStatus' | 'provideEvidenceFromError'>,
): Downloads {
    const d: DownloadsDeps = { ...defaultDeps, ...deps } as DownloadsDeps;
    const canTransfer = d.canTransfer ?? (() => d.getEvidence() === 'evidence:signed-in');

    // -- State ---------------------------------------------------------------

    let dirty = true;
    let queue: QueueItem[] = [];
    let overQuota = false;
    let controller = new AbortController();
    let activeDownloads = 0;
    const pendingSaves = new Set<Promise<void>>();
    let quotaBytes: number = d.loadQuotaBytes();
    let lastError: string | undefined;
    let totalBytes = 0; // tracked incrementally
    let queueDrainedLogged = false;

    // -- Pinned keys (pushed by caller via setPinnedKeys) --------------------

    let membershipComplete = true;
    let activeKeys: ReadonlySet<string> = new Set();
    let retainKeys: ReadonlySet<string> = new Set();

    // Completed writes update the map in place; a disk inventory replaces it.
    let files = new Map<string, number>();

    // -- Single-flight guard for recalculateQueue ----------------------------

    let recalculating: Promise<void> | undefined;

    // -- Notify UI -----------------------------------------------------------

    const notifyUI: Downloads['onStateChange'] = inventory => {
        try { downloads.onStateChange(inventory); } catch { /* caller error must not break engine */ }
    };

    // -- Queue recalculation -------------------------------------------------

    /** Confirm the inventory and queue before acknowledging a pin edit. Edits that
     * arrive during a scan share its promise and repeat the scan for the newest keys. */
    function recalculate(): Promise<void> {
        if (recalculating) { dirty = true; return recalculating; }
        controller.abort();
        controller = new AbortController();
        activeDownloads = 0;
        queue = [];
        recalculating = Promise.resolve().then(async () => {
            let inventory = files;
            try {
                // A cancelled request may already have submitted its write to IndexedDB.
                if (pendingSaves.size) await Promise.allSettled(pendingSaves);
                do {
                    dirty = false;
                    inventory = await d.audioFileSizes();
                    // Unresolved membership and the M11 empty-set guard both defer cleanup.
                    const orphans = membershipComplete && retainKeys.size ? [...inventory.keys()].filter(key => !retainKeys.has(key)) : [];
                    if (orphans.length) {
                        await d.audioDeleteBatch(orphans);
                        for (const key of orphans) inventory.delete(key);
                    }
                } while (dirty);
                for (const key of activeKeys) {
                    if (inventory.has(key)) continue;
                    const [driveId, itemId] = key.split(':');
                    queue.push({driveId, itemId});
                }
                queueDrainedLogged = false;
                lastError = undefined;
                log(`downloads: queue recalculated queued=${queue.length} active=${activeKeys.size} retain=${retainKeys.size} downloaded=${inventory.size}`);
            } catch (error) {
                dirty = true;
                lastError = 'Could not read or update offline storage.';
                throw error;
            } finally {
                files = inventory;
                totalBytes = 0;
                for (const bytes of files.values()) totalBytes += bytes;
                overQuota = totalBytes > quotaBytes;
                recalculating = undefined;
                pumpDownloads();
                notifyUI({files});
            }
        });
        return recalculating;
    }

    // -- Download pump -------------------------------------------------------

    function pumpDownloads(): void {
        while (!recalculating && activeDownloads < MAX_CONCURRENT && queue.length > 0
            && canTransfer() && !overQuota) {
            const item = queue.shift()!;
            downloadOneTrack(item);
        }
    }

    /**
     * Downloads a single track. Returns void (not Promise) — all errors
     * are handled internally, enforcing fire-and-forget at the type level.
     * A replaced queue cancels its requests through their shared signal.
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
        activeDownloads++;
        const {signal} = controller;
        let result: Parameters<Downloads['onStateChange']>[0];

        (async () => {
            try {
                const blob = await d.download(item.driveId, item.itemId, signal);
                if (signal.aborted) return;

                const save = d.audioPut(key, blob);
                pendingSaves.add(save);
                try { await save; }
                catch (error) {
                    if (!signal.aborted) {
                        dirty = true;
                        lastError = 'Could not save the recording offline.';
                        logError(`download storage error for ${key}: ${errorDetail(error)}`);
                    }
                    return;
                } finally { pendingSaves.delete(save); }
                if (signal.aborted) return;
                files.set(key, blob.size);
                totalBytes += blob.size;
                result = {added: [key, blob.size]};

            } catch (e) {
                if (signal.aborted) return;
                if (e instanceof ProviderHttpError) {
                    result = handleDownloadHttpError(e.status, item);
                    return;
                }
                if (e instanceof MediaUnavailableError) {
                    result = {unavailable: key};
                    logError(`download: no URL for ${key}`);
                    return;
                }
                const msg = errorMessage(e);
                if (msg.includes('timeout') || msg.includes('abort')) {
                    lastError = msg;
                    const target = d.provideEvidenceFromError(e, `downloads:timeout-or-abort:${key}`);
                    log(`downloads: evidence from error reason=timeout-or-abort key=${key} -> ${target}`);
                    logError(`download: connectivity lost (${errorDetail(e)}) → ${target}`);
                } else if (e instanceof MediaTransientError || msg.includes('fetch') || msg.includes('network')) {
                    // Transient network error: evidence owner maps to no-evidence/not-online.
                    queue.push(item);
                    const target = d.provideEvidenceFromError(e, `downloads:transient-network:${key}`);
                    log(`downloads: evidence from error reason=transient-network key=${key} -> ${target}`);
                    const cause = e instanceof MediaTransientError ? e.cause ?? e : e;
                    logError(`download: transient network error for ${key}: ${errorDetail(cause)} → ${target}`);
                } else {
                    lastError = msg;
                    logError(`download error for ${key}: ${errorDetail(e)}`);
                }
            } finally {
                if (!signal.aborted) {
                    activeDownloads--;
                    // Check if quota is now exceeded
                    overQuota = totalBytes > quotaBytes;
                    pumpDownloads();
                    if (
                        !queueDrainedLogged
                        && queue.length === 0
                        && activeDownloads === 0
                        && activeKeys.size > 0
                        && canTransfer()
                    ) {
                        queueDrainedLogged = true;
                        log(`downloads: queue drained downloaded=${files.size} retain=${retainKeys.size}`);
                    }
                    notifyUI(result);
                }
            }
        })();
    }

    /** Process statuses from metadata and signed content with the same queue policy.
     * The auth wrapper also reconciles Graph evidence before returning its response.
     * Timeout and 401 handling updates evidence for either request. */
    function handleDownloadHttpError(status: number, item: QueueItem): {unavailable: string} | undefined {
        if (status === 429 || status === 500 || status === 502 || status === 503) {
            // Transient: push to back of queue for retry
            queue.push(item);
            logError(`download: ${status} for ${item.driveId}:${item.itemId}, retrying later`);
        } else if (status === 408 || status === 504) {
            // Timeout: classify evidence via the shared utility
            lastError = `HTTP ${status}`;
            const prevEvidence = d.getEvidence();
            const target = d.provideEvidenceFromHttpStatus(status, `downloads:http:${status}`);
            if (target !== prevEvidence) {
                log(`downloads: evidence from status status=${status} -> ${target}`);
            }
            logError(`download: ${status}, pausing downloads`);
        } else if (status === 401) {
            // Auth failure
            lastError = 'Authentication failed';
            const prevEvidence = d.getEvidence();
            const target = d.provideEvidenceFromHttpStatus(status, `downloads:http:${status}`);
            if (target !== prevEvidence) {
                log(`downloads: evidence from status status=${status} -> ${target}`);
            }
            logError(`download: 401, signed out`);
        } else {
            // Other (including 404): remove from queue
            logError(`download: ${status} for ${item.driveId}:${item.itemId}, removing`);
            return {unavailable: `${item.driveId}:${item.itemId}`};
        }
    }

    // -- Helpers -------------------------------------------------------------

    /** Shallow set equality: same size and every element of a is in b. */
    function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
        if (a.size !== b.size) return false;
        for (const k of a) if (!b.has(k)) return false;
        return true;
    }

    // -- Public API ----------------------------------------------------------

    const downloads: Downloads = {
        async setPinnedKeys(newActiveKeys, newRetainKeys, complete = true) {
            // Enforce invariant: activeKeys ⊆ retainKeys
            const enforced = new Set(newRetainKeys);
            for (const k of newActiveKeys) enforced.add(k);

            if (!dirty && complete === membershipComplete && setsEqual(newActiveKeys, activeKeys) && setsEqual(enforced, retainKeys)) return recalculating;
            membershipComplete = complete;
            activeKeys = new Set(newActiveKeys); // defensive copy
            retainKeys = enforced;
            dirty = true;
            return recalculate();
        },

        handleEvidenceTransition() {
            if (canTransfer() && dirty) {
                recalculate().catch(logCatch('downloads: evidence inventory'));
            } else if (canTransfer()) {
                lastError = undefined;
                pumpDownloads();
                notifyUI();
            } else {
                // Non-signed-in transitions: UI must update (grey tracks,
                // evidence indicator, static ↓ icons) even though pump doesn't run.
                notifyUI();
            }
            // In-flight downloads handle a route change through their own completion.
        },

        async getOfflineBlob(driveId, itemId) {
            return d.audioGet(`${driveId}:${itemId}`);
        },

        getSnapshot(): DownloadSnapshot {
            return {
                files,
                queuedCount: queue.length,
                overQuota,
                lastError,
                evidence: d.getEvidence(),
                transferAllowed: canTransfer(),
                quotaBytes,
                totalBytes,
            };
        },

        setQuota(gb) {
            quotaBytes = gb * 1024 * 1024 * 1024;
            d.saveQuotaBytes(quotaBytes);
            dirty = true;
            if (canTransfer()) {
                recalculate().catch(logCatch('downloads: refresh inventory'));
            }
        },

        async clearError() {
            lastError = undefined;
            dirty = true;
            if (canTransfer()) await recalculate();
            else notifyUI();
        },

        async clear() {
            controller.abort();
            activeDownloads = 0;
            activeKeys = new Set();
            retainKeys = new Set();
            queue = [];
            await Promise.allSettled([...pendingSaves, ...(recalculating ? [recalculating] : [])]);
            await d.audioClear();
            files = new Map();
            overQuota = false;
            lastError = undefined;
            totalBytes = 0;
            notifyUI({files});
        },

        onStateChange: () => {},
    };

    return downloads;
}
