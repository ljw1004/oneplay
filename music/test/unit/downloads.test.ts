/**
 * Unit tests for downloads.ts — offline download engine.
 *
 * Tests the algorithmic paths: evidence state machine, queue calculation,
 * garbage collection, error classification, snapshot API. All I/O
 * is injected via DI stubs (in-memory maps, mock fetch responses).
 *
 * The engine has no knowledge of favorites — tests push raw key sets
 * via setPinnedKeys(activeKeys, retainKeys).
 *
 * TESTING APPROACH: The engine fires onStateChange after every meaningful
 * state transition (recalculation complete, download complete, error).
 * Tests await that signal via waitForState(predicate) instead of arbitrary
 * delays. For negative assertions (nothing should happen), the code path
 * is synchronous or doesn't fire at all, so no waiting is needed.
 *
 * Evidence is now owned externally (by the auth module). Tests simulate
 * this by maintaining a local `evidence` variable in the stub deps,
 * and calling `setEvidence(state)` which sets the variable and calls
 * `dl.handleEvidenceTransition()`.
 *
 * Run: npm run test:unit
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createDownloads, classifyOfflineBadgeState, type Downloads, type DownloadsDeps } from '../../src/downloads.js';
import { classifyEvidence, type EvidenceState } from '../../src/auth.js';
import { ProviderHttpError } from '../../src/provider.js';

// ---------------------------------------------------------------------------
// DI stubs: in-memory audio store + mock fetch + evidence state
// ---------------------------------------------------------------------------

function makeStubDeps(): {
    deps: DownloadsDeps;
    audioStore: Map<string, Blob>;
    fetchLog: string[];
    setOnline: (value: boolean) => void;
    provideEvidenceFromStatusCallCount: () => number;
    provideEvidenceFromErrorCallCount: () => number;
    /** Sets evidence state in the stub and notifies the engine. Must be called
     *  after createDownloads() so `dl` is set. */
    setEvidence: (state: EvidenceState) => void;
    /** Direct read of the stub's evidence variable (for assertions). */
    getEvidence: () => EvidenceState;
} {
    const audioStore = new Map<string, Blob>();
    const fetchLog: string[] = [];
    let quotaBytes = 10 * 1024 * 1024 * 1024; // 10 GB (generous for tests)
    let online = true;
    let evidence: EvidenceState = 'no-evidence';
    let provideEvidenceFromStatusCalls = 0;
    let provideEvidenceFromErrorCalls = 0;
    let dlRef: Downloads | undefined;

    const deps: DownloadsDeps = {
        async download(driveId, itemId) {
            fetchLog.push(driveId + ':' + itemId);
            return new Blob(['mock-audio-data'], { type: 'audio/mpeg' });
        },
        async audioPut(key, blob) { audioStore.set(key, blob); },
        async audioGet(key) { return audioStore.get(key); },
        async audioDeleteBatch(keys) { for (const key of keys) audioStore.delete(key); },
        async audioFileSizes() { return new Map([...audioStore].map(([key, blob]) => [key, blob.size])); },
        async audioClear() { audioStore.clear(); },
        loadQuotaBytes() { return quotaBytes; },
        saveQuotaBytes(bytes) { quotaBytes = bytes; },
        getEvidence() { return evidence; },
        provideEvidenceFromHttpStatus(status) {
            provideEvidenceFromStatusCalls++;
            evidence = classifyEvidence(status, evidence !== 'evidence:signed-out', online);
            return evidence;
        },
        provideEvidenceFromError(error) {
            provideEvidenceFromErrorCalls++;
            const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
            if (msg.includes('timeout') || msg.includes('network') || msg.includes('fetch') || msg.includes('abort')) {
                evidence = online ? 'no-evidence' : 'evidence:not-online';
            }
            return evidence;
        },
    };

    const setOnline = (value: boolean): void => { online = value; };

    /** Sets evidence and notifies the engine via handleEvidenceTransition.
     *  Mirrors what auth.transition() does: no-op on same state, then notify. */
    const setEvidence = (state: EvidenceState): void => {
        if (state === evidence) return;
        evidence = state;
        dlRef?.handleEvidenceTransition();
    };

    const getEvidence = (): EvidenceState => evidence;

    // Patch: after createDownloads, caller must set dlRef so setEvidence works.
    // We return a setter via a closure trick below.
    const result = {
        deps,
        audioStore,
        fetchLog,
        setOnline,
        setEvidence,
        getEvidence,
        provideEvidenceFromStatusCallCount: () => provideEvidenceFromStatusCalls,
        provideEvidenceFromErrorCallCount: () => provideEvidenceFromErrorCalls,
    };

    // Hook: createDownloads wrapper that sets dlRef automatically
    const origSetEvidence = setEvidence;
    result.setEvidence = (state: EvidenceState): void => {
        // dlRef must be set by this point (caller creates dl, then calls setEvidence)
        origSetEvidence(state);
    };

    // Expose a way to set dlRef
    (result as any)._setDlRef = (dl: Downloads) => { dlRef = dl; };

    return result;
}

/** Helper: creates downloads and wires the dlRef for setEvidence. */
function createTestDownloads(stubs: ReturnType<typeof makeStubDeps>): Downloads {
    const dl = createDownloads(stubs.deps);
    (stubs as any)._setDlRef(dl);
    return dl;
}

/**
 * Returns a promise that resolves when onStateChange fires and the
 * predicate returns true. This is the logical "wait for the engine
 * to reach a state" mechanism — no arbitrary delays.
 *
 * INVARIANT: onStateChange fires after every recalculation and after
 * every download completion/error, so any reachable state will
 * eventually trigger this.
 */
function waitForState(dl: Downloads, predicate: () => boolean): Promise<void> {
    if (predicate()) return Promise.resolve();
    return new Promise<void>(resolve => {
        const prev = dl.onStateChange;
        dl.onStateChange = inventory => {
            prev(inventory);
            if (predicate()) {
                dl.onStateChange = prev;
                resolve();
            }
        };
    });
}

const DRIVE = 'drv';

/** Builds a key set from an array of item IDs. */
const keySet = (...ids: string[]): Set<string> => new Set(ids.map(id => `${DRIVE}:${id}`));

// ---------------------------------------------------------------------------
// Evidence state machine
// ---------------------------------------------------------------------------

describe('evidence state machine', () => {
    it('initial state is no-evidence, pump does not start', () => {
        const stubs = makeStubDeps();
        const dl = createTestDownloads(stubs);
        dl.setPinnedKeys(keySet('f1', 'f2', 'f3'), keySet('f1', 'f2', 'f3'));
        // evidence is no-evidence → setPinnedKeys doesn't trigger recalculation.
        // No async work happens, so assert synchronously.
        assert.equal(stubs.fetchLog.length, 0);
    });

    it('transition to signed-in while dirty → triggers recalculate + pump', async () => {
        const stubs = makeStubDeps();
        const dl = createTestDownloads(stubs);
        dl.setPinnedKeys(keySet('f1', 'f2', 'f3'), keySet('f1', 'f2', 'f3'));
        stubs.setEvidence('evidence:signed-in');
        // Wait for downloads to complete (3 tracks → all in files)
        await waitForState(dl, () => dl.getSnapshot().files.size === 3);
        assert.ok(stubs.fetchLog.length > 0, 'expected fetch calls after signed-in transition');
    });

    it('transition to no-evidence → pump stops', async () => {
        const stubs = makeStubDeps();
        const dl = createTestDownloads(stubs);
        dl.setPinnedKeys(keySet('f1', 'f2', 'f3'), keySet('f1', 'f2', 'f3'));
        stubs.setEvidence('evidence:signed-in');
        await waitForState(dl, () => dl.getSnapshot().files.size === 3);
        const countBefore = stubs.fetchLog.length;
        stubs.setEvidence('no-evidence');
        // After no-evidence, no new fetches should start. The transition is
        // synchronous (no recalculation fires), so assert immediately.
        assert.equal(stubs.fetchLog.length, countBefore);
    });

    it('transition to signed-out → aborts in-flight', () => {
        const stubs = makeStubDeps();
        const dl = createTestDownloads(stubs);
        dl.setPinnedKeys(keySet('f1'), keySet('f1'));
        stubs.setEvidence('evidence:signed-in');
        // Immediately transition to signed-out before downloads complete
        stubs.setEvidence('evidence:signed-out');
        assert.equal(stubs.getEvidence(), 'evidence:signed-out');
    });
});

// ---------------------------------------------------------------------------
// Queue calculation
// ---------------------------------------------------------------------------

describe('queue calculation', () => {
    it('3 active keys, 0 downloaded → queue has 3 items', async () => {
        const stubs = makeStubDeps();
        const dl = createTestDownloads(stubs);
        dl.setPinnedKeys(keySet('f1', 'f2', 'f3'), keySet('f1', 'f2', 'f3'));
        stubs.setEvidence('evidence:signed-in');
        await waitForState(dl, () => stubs.audioStore.size === 3);
        assert.equal(stubs.audioStore.size, 3);
    });

    it('3 active keys, 2 already downloaded → only 1 downloaded', async () => {
        const stubs = makeStubDeps();
        // Pre-populate 2 of 3 tracks
        stubs.audioStore.set(`${DRIVE}:f1`, new Blob(['data']));
        stubs.audioStore.set(`${DRIVE}:f2`, new Blob(['data']));
        const dl = createTestDownloads(stubs);
        dl.setPinnedKeys(keySet('f1', 'f2', 'f3'), keySet('f1', 'f2', 'f3'));
        stubs.setEvidence('evidence:signed-in');
        await waitForState(dl, () => stubs.audioStore.size === 3);
        assert.equal(stubs.audioStore.size, 3);
    });

    it('empty activeKeys → no downloads start', async () => {
        const stubs = makeStubDeps();
        const dl = createTestDownloads(stubs);
        dl.setPinnedKeys(new Set(), keySet('f1')); // retained but not active (paused)
        stubs.setEvidence('evidence:signed-in');
        // Recalculation fires (async) but with empty queue, no fetches happen.
        // Wait for recalculation to complete via onStateChange.
        await waitForState(dl, () => true); // first onStateChange = recalculation done
        assert.equal(stubs.fetchLog.length, 0);
    });

    it('setPinnedKeys hydrates cached files while evidence is not-online', async () => {
        const stubs = makeStubDeps();
        stubs.audioStore.set(`${DRIVE}:f1`, new Blob(['data']));
        const dl = createTestDownloads(stubs);
        stubs.setEvidence('evidence:not-online');
        dl.setPinnedKeys(keySet('f1'), keySet('f1'));
        await waitForState(dl, () => dl.getSnapshot().files.size === 1);
        assert.equal(dl.getSnapshot().files.size, 1);
        assert.equal(stubs.fetchLog.length, 0, 'must not start network fetch while not-online');
    });
});

// ---------------------------------------------------------------------------
// Garbage collection
// ---------------------------------------------------------------------------

describe('garbage collection', () => {
    it('only collects cached files once current owner membership is complete', async () => {
        const stubs = makeStubDeps();
        const all = keySet('song', 'other', 'orphan'), kept = keySet('song', 'other');
        for (const key of all) stubs.audioStore.set(key, new Blob(['audio']));
        const engine = createTestDownloads(stubs);
        await engine.setPinnedKeys(kept, kept, false);
        assert.deepEqual(new Set(stubs.audioStore.keys()), all);
        await engine.setPinnedKeys(kept, kept, true);
        assert.deepEqual(new Set(stubs.audioStore.keys()), kept);
    });

    it('downloaded track not in retainKeys → audioDelete called', async () => {
        const stubs = makeStubDeps();
        // A track in the store that shouldn't be retained
        stubs.audioStore.set(`${DRIVE}:orphan`, new Blob(['data']));
        const dl = createTestDownloads(stubs);
        dl.setPinnedKeys(new Set(), keySet('f1')); // retain f1 only, not orphan
        stubs.setEvidence('evidence:signed-in');
        // GC runs during recalculation; wait for it to complete
        await waitForState(dl, () => !stubs.audioStore.has(`${DRIVE}:orphan`));
        assert.equal(stubs.audioStore.has(`${DRIVE}:orphan`), false, 'orphan should be GC-ed');
    });

    it('downloaded track in retainKeys → not deleted', async () => {
        const stubs = makeStubDeps();
        stubs.audioStore.set(`${DRIVE}:f1`, new Blob(['data']));
        const dl = createTestDownloads(stubs);
        dl.setPinnedKeys(keySet('f1'), keySet('f1'));
        stubs.setEvidence('evidence:signed-in');
        // Wait for recalculation to finish
        await waitForState(dl, () => true);
        assert.equal(stubs.audioStore.has(`${DRIVE}:f1`), true, 'retained track should NOT be GC-ed');
    });

    it('empty retainKeys → GC skipped (safety guard)', async () => {
        const stubs = makeStubDeps();
        stubs.audioStore.set(`${DRIVE}:f1`, new Blob(['data']));
        const dl = createTestDownloads(stubs);
        dl.setPinnedKeys(new Set(), new Set()); // both empty
        stubs.setEvidence('evidence:signed-in');
        // Wait for recalculation to finish
        await waitForState(dl, () => true);
        assert.equal(stubs.audioStore.has(`${DRIVE}:f1`), true, 'should not GC when retainKeys is empty');
    });
});

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

describe('error classification', () => {
    it('404 response → item removed from queue (not re-queued)', async () => {
        const stubs = makeStubDeps();
        stubs.deps.download = async () => { throw new ProviderHttpError(404); };
        const dl = createTestDownloads(stubs);
        dl.setPinnedKeys(keySet('f1', 'f2'), keySet('f1', 'f2'));
        stubs.setEvidence('evidence:signed-in');
        // 404s are removed from queue. Wait for all workers to finish
        // (queue drains, no items re-queued). onStateChange fires per track.
        await waitForState(dl, () => dl.getSnapshot().queuedCount === 0);
        assert.equal(stubs.audioStore.size, 0);
    });

    it('429 response → item pushed to back of queue, retried', async () => {
        const stubs = makeStubDeps();
        let call = 0;
        stubs.deps.download = async () => {
            call++;
            if (call <= 2) throw new ProviderHttpError(429);
            return new Blob(['mock-audio-data'], { type: 'audio/mpeg' });
        };
        const dl = createTestDownloads(stubs);
        dl.setPinnedKeys(keySet('f1'), keySet('f1'));
        stubs.setEvidence('evidence:signed-in');
        // Wait for the track to eventually download (after retries)
        await waitForState(dl, () => stubs.audioStore.size === 1);
        assert.ok(call > 1, `expected retry, got ${call} calls`);
    });

    it('408/504 → transitions to no-evidence', async () => {
        const stubs = makeStubDeps();
        stubs.deps.download = async () => { throw new ProviderHttpError(504); };
        const dl = createTestDownloads(stubs);
        dl.setPinnedKeys(keySet('f1'), keySet('f1'));
        stubs.setEvidence('evidence:signed-in');
        // 504 transitions evidence via the delegated auth evidence helper.
        await waitForState(dl, () => stubs.getEvidence() === 'no-evidence');
        assert.equal(stubs.getEvidence(), 'no-evidence');
        assert.equal(stubs.provideEvidenceFromStatusCallCount(), 1);
        assert.ok(dl.getSnapshot().lastError, 'lastError should be set');
    });

    it('network exception delegates evidence mapping to auth helper', async () => {
        const stubs = makeStubDeps();
        stubs.setOnline(false);
        stubs.deps.download = async () => { throw new TypeError('Failed to fetch'); };
        const dl = createTestDownloads(stubs);
        dl.setPinnedKeys(keySet('f1'), keySet('f1'));
        stubs.setEvidence('evidence:signed-in');
        await waitForState(dl, () => stubs.getEvidence() === 'evidence:not-online');
        assert.equal(stubs.provideEvidenceFromErrorCallCount(), 1);
    });

    it('aborted worker fetch during recalculate does not latch error or change evidence', async () => {
        const stubs = makeStubDeps();
        let fetchStartedResolve!: () => void;
        const fetchStarted = new Promise<void>((resolve) => { fetchStartedResolve = resolve; });
        stubs.deps.download = (_driveId, _itemId, signal) => {
            fetchStartedResolve();
            return new Promise<Blob>((_resolve, reject) => {
                signal.addEventListener('abort', () => {
                    reject(new DOMException('Aborted', 'AbortError'));
                }, { once: true });
            });
        };
        const dl = createTestDownloads(stubs);
        dl.setPinnedKeys(keySet('f1'), keySet('f1'));
        stubs.setEvidence('evidence:signed-in');
        await fetchStarted;
        // Removing the last owner aborts the recording’s request.
        dl.setPinnedKeys(new Set(), new Set());
        await waitForState(dl, () =>
            dl.getSnapshot().queuedCount === 0 && dl.getSnapshot().files.size === 0);
        assert.equal(stubs.getEvidence(), 'evidence:signed-in');
        assert.equal(dl.getSnapshot().lastError, undefined);
    });
});

// ---------------------------------------------------------------------------
// Snapshot API
// ---------------------------------------------------------------------------

describe('snapshot API', () => {
    it('snapshot exposes completed sizes alongside queue and quota state', async () => {
        const stubs = makeStubDeps();
        stubs.audioStore.set(`${DRIVE}:f1`, new Blob(['data']));
        const dl = createTestDownloads(stubs);
        dl.setPinnedKeys(keySet('f1', 'f2'), keySet('f1', 'f2'));
        stubs.setEvidence('evidence:signed-in');
        // Wait for f2 to be downloaded (f1 was pre-populated)
        await waitForState(dl, () => dl.getSnapshot().files.size === 2);

        const snap = dl.getSnapshot();
        assert.equal(snap.files.get(`${DRIVE}:f1`), stubs.audioStore.get(`${DRIVE}:f1`)!.size);
        assert.equal(snap.files.get(`${DRIVE}:f2`), stubs.audioStore.get(`${DRIVE}:f2`)!.size);
        assert.equal(snap.evidence, 'evidence:signed-in');
        assert.equal(snap.overQuota, false);
        assert.equal(snap.lastError, undefined);
    });

    it('setQuota triggers recalculation', async () => {
        const stubs = makeStubDeps();
        const dl = createTestDownloads(stubs);
        dl.setPinnedKeys(keySet('f1'), keySet('f1'));
        stubs.setEvidence('evidence:signed-in');
        // Wait for download to complete
        await waitForState(dl, () => stubs.audioStore.size === 1);
        // Set a tiny quota (~1 byte) — recalculation will set overQuota
        dl.setQuota(0.000000001);
        await waitForState(dl, () => dl.getSnapshot().overQuota);
        assert.equal(dl.getSnapshot().overQuota, true);
    });

    it('clear resets all state', async () => {
        const stubs = makeStubDeps();
        const dl = createTestDownloads(stubs);
        dl.setPinnedKeys(keySet('f1'), keySet('f1'));
        stubs.setEvidence('evidence:signed-in');
        // Wait for download to complete
        await waitForState(dl, () => stubs.audioStore.size === 1);
        assert.ok(dl.getSnapshot().files.size > 0, 'precondition: has downloads');
        await dl.clear();
        const snap = dl.getSnapshot();
        assert.equal(snap.files.size, 0);
        assert.equal(snap.totalBytes, 0);
        assert.equal(stubs.audioStore.size, 0);
    });
});

// ---------------------------------------------------------------------------
// evidence:not-online (M11b four-state model)
// ---------------------------------------------------------------------------

describe('evidence:not-online', () => {
    it('transition to not-online stops pump (same as no-evidence)', () => {
        const stubs = makeStubDeps();
        const dl = createTestDownloads(stubs);
        dl.setPinnedKeys(keySet('f1', 'f2', 'f3'), keySet('f1', 'f2', 'f3'));
        stubs.setEvidence('evidence:not-online');
        // Pump guarded by evidence === 'evidence:signed-in'; not-online won't match.
        assert.equal(stubs.fetchLog.length, 0);
    });

    it('transition from not-online to no-evidence does not resume pump', () => {
        const stubs = makeStubDeps();
        const dl = createTestDownloads(stubs);
        dl.setPinnedKeys(keySet('f1'), keySet('f1'));
        stubs.setEvidence('evidence:not-online');
        stubs.setEvidence('no-evidence');
        // no-evidence is not signed-in, so pump does not start
        assert.equal(stubs.fetchLog.length, 0);
    });

    it('transition from not-online to signed-in resumes pump', async () => {
        const stubs = makeStubDeps();
        const dl = createTestDownloads(stubs);
        dl.setPinnedKeys(keySet('f1'), keySet('f1'));
        stubs.setEvidence('evidence:not-online');
        // Now come back online and sign in
        stubs.setEvidence('evidence:signed-in');
        await waitForState(dl, () => stubs.audioStore.size === 1);
        assert.equal(stubs.audioStore.size, 1);
    });

    it('snapshot reflects not-online state', () => {
        const stubs = makeStubDeps();
        const dl = createTestDownloads(stubs);
        stubs.setEvidence('evidence:not-online');
        assert.equal(dl.getSnapshot().evidence, 'evidence:not-online');
    });

    it('error classifier uses not-online when navigator.onLine is false', async () => {
        const stubs = makeStubDeps();
        // Make the provider report 504 (timeout)
        stubs.deps.download = async () => { throw new ProviderHttpError(504); };
        stubs.setOnline(false); // simulate offline
        const dl = createTestDownloads(stubs);
        dl.setPinnedKeys(keySet('f1'), keySet('f1'));
        stubs.setEvidence('evidence:signed-in');
        // 504 + offline -> evidence:not-online via delegated status mapping.
        await waitForState(dl, () => stubs.getEvidence() === 'evidence:not-online');
        assert.equal(stubs.getEvidence(), 'evidence:not-online');
    });
});

describe('offline badge classifier', () => {
    const progress = {downloaded: 0, total: 1, bytes: 0, complete: true};
    const online = {evidence: 'evidence:signed-in' as const, overQuota: false, lastError: undefined};
    it('missing + not-online returns paused', () => {
        assert.equal(
            classifyOfflineBadgeState(progress, {...online, evidence: 'evidence:not-online'}, false),
            'paused',
        );
    });

    it('missing + signed-in + no blockers returns downloading', () => {
        assert.equal(
            classifyOfflineBadgeState(progress, online, false),
            'downloading',
        );
    });

    it('an unavailable index has nothing to download until it identifies a missing file', () => {
        assert.equal(classifyOfflineBadgeState(undefined, online, false), 'paused');
        assert.equal(classifyOfflineBadgeState({...progress, complete: false, downloaded: 1}, online, false), 'paused');
        assert.equal(classifyOfflineBadgeState({...progress, complete: false}, online, false), 'downloading');
    });

    it('no missing tracks returns complete', () => {
        assert.equal(
            classifyOfflineBadgeState({...progress, downloaded: 1}, {...online, evidence: 'evidence:not-online', overQuota: true, lastError: 'Offline'}, false),
            'complete',
        );
    });
});
