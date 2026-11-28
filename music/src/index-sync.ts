/**
 * Index sync orchestration for OnePlay Music.
 *
 * Scope:
 * - Owns pull single-flight, periodic scheduling, and online-triggered refresh.
 * - Owns account/share probe/index refresh flows and settings sync status projection.
 * - Coordinates share index cache lifecycle and share add/remove side effects.
 *
 * Non-scope:
 * - Startup status rendering (owned by index-startup.ts).
 * - App composition/tree-playback-select wiring (owned by index.ts).
 */
import { readGraphJson, type Auth, type EvidenceState } from './auth.js';
import type { NativeLibrary } from './native-library.js';
import type { OneDriveProvider } from './onedrive-provider.js';
import { ProviderHttpError } from './provider.js';
import { dbGet, dbPut, dbDelete, dbClear } from './db.js';
import { log, logError, logCatch, errorMessage, errorDetail } from './logger.js';
import {
    type MusicData,
    type MusicDriveItem,
    type AccountInfo,
    type IndexProgress,
    type MusicFolder,
    isCurrentIndex,
} from './indexer.js';
import type { TreeView } from './tree.js';
import type { Playback } from './playback.js';
import type { Favorites } from './favorites.js';
import type { Select } from './select.js';
import type {
    SettingsView,
    SettingsIndexFailure,
    SettingsShareIndexRow,
    SettingsShareRow,
} from './settings.js';
import type { Shares, ShareRecordPersisted } from './shares.js';

type PullSource = 'startup' | 'periodic' | 'online' | 'settings-refresh';
type SearchReason = 'share-roots';

interface ShareProbeResult {
    readonly share: ShareRecordPersisted;
    readonly status: 'ok' | 'denied' | 'failed' | 'skipped';
    readonly driveItem?: MusicDriveItem;
    readonly failureMessage?: string;
}

export interface IndexSyncDeps {
    readonly auth: Auth | NativeLibrary;
    readonly oneDrive: Pick<OneDriveProvider,
        'fetchAccountInfo' | 'probeMusicFolder' | 'probeShareRoot' | 'buildAndCacheIndex' | 'deleteShareCache'>;
    readonly canPull: () => boolean;
    readonly hasInstalledTree: () => boolean;
    readonly accountData: Map<string, { folder: MusicFolder; driveId: string }>;
    readonly getTree: () => TreeView | undefined;
    readonly onPlaybackRootsChange?: () => void;
    readonly getPlayback: () => Playback | undefined;
    readonly getFavorites: () => Favorites | undefined;
    readonly getSelect: () => Select | undefined;
    readonly getSettings: () => SettingsView | undefined;
    readonly getShares: () => Shares | undefined;
    readonly ensureFavorites: () => Promise<void>;
    readonly ensureShares: () => Promise<void>;
    readonly showTree: (info: AccountInfo, data: MusicData, reindexing?: boolean) => void;
    readonly showOpening: () => void;
    readonly showSignIn: () => void;
    readonly showOpeningFailure: (offline: boolean) => void;
    readonly finishOpening: (offline: boolean) => void;
    readonly showIndexProgress: (progress: IndexProgress) => void;
    readonly computeAndPushOfflineState: () => void;
    readonly invalidateSearchData: () => void;
    readonly runSearchAndPushIntoTree: (reason: SearchReason) => void;
}

export interface IndexSyncController {
    setSavedInfoRef(value: AccountInfo | undefined): void;
    getSavedInfoRef(): AccountInfo | undefined;
    setCachedDataRef(value: MusicData | undefined): void;
    getCachedDataRef(): MusicData | undefined;
    setLastIndexUpdatedAt(value: number | undefined): void;
    getLastIndexUpdatedAt(): number | undefined;
    hasLatestIndexFailure(): boolean;
    clearLatestIndexFailureIntoRuntimeStateAndPushUi(): void;
    setLatestIndexFailureFromMessageAndPushUi(label: string, message: string): void;
    syncShareRootsIntoTreeAndPlayback(): void;
    loadShareIndexesFromCacheIntoState(): Promise<void>;
    buildSettingsShareRows(): SettingsShareRow[];
    updateSettingsIndexSection(): void;
    cancelScheduledPull(): void;
    drainPullsAfterAdmissionCloses(): Promise<void>;
    requestPullFromOneDrive(source: PullSource): Promise<void>;
    onShareAdded(record: ShareRecordPersisted): void;
    onShareRemoved(record: ShareRecordPersisted): Promise<void>;
}

const indexShareKey = (shareId: string): string => `index-share:${shareId}`;
const indexKey = (driveId: string): string => `index:${driveId}`;
const PULL_INTERVAL_MS = 5 * 60 * 1000;

function shareDeniedReasonText(reason: string | undefined): string | undefined {
    if (!reason) return undefined;
    return `Access unavailable: ${reason}`;
}

function deniedReasonFromStatus(status: number): string {
    if (status === 401) return 'Sign-in expired (401)';
    if (status === 403) return 'Permission denied (403)';
    if (status === 404) return 'Share no longer available (404)';
    return `Share unavailable (${status})`;
}

function shouldAutoRedirect(
    wasInitialStartup: boolean,
    tokensExpired: boolean,
    evidence: EvidenceState,
): boolean {
    if (!wasInitialStartup) { log('auto-redirect: blocked by wasInitialStartup'); return false; }
    const lineageRaw = localStorage.getItem('oneplay_music_auth_lineage_time');
    if (!lineageRaw) { log('auto-redirect: blocked by missing lineage time'); return false; }
    if (!tokensExpired) {
        const lineageTime = parseInt(lineageRaw, 10);
        if (!Number.isFinite(lineageTime)) { log('auto-redirect: blocked by NaN lineage time'); return false; }
        if (lineageTime + 21 * 60 * 60 * 1000 > Date.now()) {
            const hrsLeft = ((lineageTime + 24 * 60 * 60 * 1000 - Date.now()) / 3_600_000).toFixed(1);
            log(`auto-redirect: no need, tokens are fresh (${hrsLeft}hrs remaining)`);
            return false;
        }
    }
    if (evidence === 'evidence:not-online') { log('auto-redirect: blocked by evidence:not-online'); return false; }
    const attemptRaw = localStorage.getItem('oneplay_music_redirect_attempt');
    if (attemptRaw) {
        const attemptTime = parseInt(attemptRaw, 10);
        if (Number.isFinite(attemptTime) && attemptTime + 12 * 60 * 60 * 1000 > Date.now()) {
            log(`auto-redirect: blocked by 12hr cooldown (attempt ${Math.round((Date.now() - attemptTime) / 60000)}min ago)`);
            return false;
        }
    }
    if (localStorage.getItem('oneplay_music_redirect_result') === 'interaction_required') {
        log('auto-redirect: blocked by prior interaction_required');
        return false;
    }
    const audioEl = document.getElementById('player') as HTMLAudioElement | null;
    if (audioEl && !audioEl.paused) { log('auto-redirect: blocked by active playback'); return false; }
    return true;
}

function readTestSettingsShareRowsFromHook(): SettingsShareRow[] | undefined {
    const hooks = window as unknown as { _testSettingsShareRows?: unknown };
    const raw = hooks._testSettingsShareRows;
    if (!Array.isArray(raw)) return undefined;
    return raw
        .filter((x): x is {
            id: string;
            label: string;
            deniedReason?: string;
            removeImpactTracks?: number;
            removeImpactFavorites?: number;
        } =>
            typeof x === 'object' && x !== null
            && typeof (x as { id?: unknown }).id === 'string'
            && typeof (x as { label?: unknown }).label === 'string')
        .map((x) => ({
            id: x.id,
            label: x.label,
            deniedReason: typeof x.deniedReason === 'string' ? x.deniedReason : undefined,
            getRemoveImpact: () => ({
                uniqueTrackCount: x.removeImpactTracks ?? 0, affectedFavoriteCount: x.removeImpactFavorites ?? 0, folderPinCount: 0,
            }),
        }));
}

export function createIndexSync(deps: IndexSyncDeps): IndexSyncController {
    const native = 'state' in deps.auth ? deps.auth : undefined;
    const browserAuth = 'handleOauthRedirect' in deps.auth ? deps.auth : undefined;
    let savedInfoRef: AccountInfo | undefined;
    let cachedDataRef: MusicData | undefined;
    let isInitialStartup = true;
    const currentFolders = new Map<string, MusicFolder>();
    let lastIndexUpdatedAt: number | undefined;
    let latestIndexProgress: IndexProgress | undefined;
    let latestIndexFailure: SettingsIndexFailure | undefined;

    const shareCachedDataByShareId = new Map<string, MusicData>();
    const shareReindexingByShareId = new Map<string, boolean>();
    const shareIndexProgressByShareId = new Map<string, IndexProgress | undefined>();

    // The remote cache uses one namespace per link. Order a dispatched Graph PUT
    // before DELETE so old cleanup cannot erase the next build. Cached browsing can proceed.
    let pullController: AbortController | undefined;
    let shareBuild: { recordID: string; cancel: AbortController; done: Promise<void> } | undefined;
    const deletingShareCaches = new Map<string, Promise<void>>();
    const stillConnected = (record: ShareRecordPersisted): boolean =>
        deps.getShares()?.getAll().some(s => s.id === record.id) === true;

    let pullTimer: ReturnType<typeof setTimeout> | undefined;
    let pullInFlightPromise: Promise<void> | undefined;
    let openingRecoveryPending: PullSource | undefined;
    // The account probe or primary index can reject saved credentials.
    // Browser sign-in replaces the document. Later transport evidence
    // cannot reopen admission for that rejected session.
    let browserPrimaryRequiresSignIn = false;
    let settingsCheckingForUpdatesInFlight = false;

    const getTree = (): TreeView | undefined => deps.getTree();
    const getPlayback = (): Playback | undefined => deps.getPlayback();
    const getFavorites = (): Favorites | undefined => deps.getFavorites();
    const getSelect = (): Select | undefined => deps.getSelect();
    const getSettings = (): SettingsView | undefined => deps.getSettings();
    const getShares = (): Shares | undefined => deps.getShares();

    const setLatestIndexFailureIntoRuntimeStateAndPushUi = (failure: SettingsIndexFailure | undefined): void => {
        latestIndexFailure = failure;
        getTree()?.setIndexFailureWarning(failure !== undefined);
        updateSettingsIndexSection();
    };

    const clearLatestIndexFailureIntoRuntimeStateAndPushUi = (): void => {
        if (!latestIndexFailure) return;
        setLatestIndexFailureIntoRuntimeStateAndPushUi(undefined);
    };

    const setLatestIndexFailureFromErrorAndPushUi = (label: string, error: unknown): void => {
        setLatestIndexFailureIntoRuntimeStateAndPushUi({
            label,
            message: errorMessage(error),
            at: Date.now(),
        });
    };

    const setLatestIndexFailureFromMessageAndPushUi = (label: string, message: string): void => {
        setLatestIndexFailureIntoRuntimeStateAndPushUi({
            label,
            message,
            at: Date.now(),
        });
    };

    const buildSettingsShareIndexRows = (): SettingsShareIndexRow[] => {
        const shares = getShares();
        if (!shares) return [];
        return shares.getAll().map((share) => ({
            id: share.id,
            label: share.name,
            progress: shareIndexProgressByShareId.get(share.shareId),
        }));
    };

    const updateSettingsIndexSection = (): void => {
        getSettings()?.updateIndexSection({
            checkingForUpdates: settingsCheckingForUpdatesInFlight,
            indexProgress: latestIndexProgress,
            shareRows: buildSettingsShareIndexRows(),
            lastIndexUpdatedAt,
            latestFailure: latestIndexFailure,
        });
    };

    const writeIndexLastUpdatedNow = (): void => {
        lastIndexUpdatedAt = Date.now();
        localStorage.setItem('oneplay_music_index_last_updated', String(lastIndexUpdatedAt));
        updateSettingsIndexSection();
    };

    const setSettingsCheckingForUpdatesInFlight = (value: boolean): void => {
        if (settingsCheckingForUpdatesInFlight === value) return;
        settingsCheckingForUpdatesInFlight = value;
        updateSettingsIndexSection();
    };

    const updateAccountDataFromTreeRoots = (): void => {
        const tree = getTree();
        if (!tree) return;
        deps.accountData.clear();
        for (const [key, root] of tree.getRoots()) {
            if (root.type === 'onedrive') {
                deps.accountData.set(key, { folder: root.folder, driveId: root.info.driveId });
                continue;
            }
            if (root.type === 'share' && root.folder) {
                deps.accountData.set(key, { folder: root.folder, driveId: root.driveId });
            }
        }
    };

    const syncShareRootsIntoTreeAndPlayback = (): void => {
        const tree = getTree();
        const shares = getShares();
        if (!tree || !shares) return;
        const allowed = new Set(shares.getAll().map((s) => s.shareId));
        // RAM and disk both cache listings by share link. Pins belong to the current connection UUID.
        for (const entries of [shareCachedDataByShareId, shareReindexingByShareId, shareIndexProgressByShareId]) {
            for (const shareId of entries.keys()) {
                if (!allowed.has(shareId)) entries.delete(shareId);
            }
        }
        const rows = shares.getAll().map((share) => ({
            key: share.rootKey,
            connectionId: share.id,
            name: share.name,
            driveId: share.driveId,
            folder: shareCachedDataByShareId.get(share.shareId)?.folder,
            reindexing: shareReindexingByShareId.get(share.shareId) ?? false,
        }));
        tree.setShareRoots(rows);
        tree.setDeniedRootKeys(shares.getDeniedRootKeys());
        updateAccountDataFromTreeRoots();
        const favorites = getFavorites();
        const playback = getPlayback();
        if (playback && favorites) playback.setContext(favorites, tree.getRoots(), shares.getDeniedRootKeys(), shares.hasLoadedMembership?.());
        deps.onPlaybackRootsChange?.();
        getSelect()?.setRoots(tree.getRoots());
        deps.invalidateSearchData();
        deps.runSearchAndPushIntoTree('share-roots');
    };

    const loadShareIndexesFromCacheIntoState = async (): Promise<void> => {
        const shares = getShares();
        if (!shares) return;
        const records = shares.getAll();
        await Promise.all(records.map(async (share) => {
            if (shareCachedDataByShareId.has(share.shareId) || deletingShareCaches.has(share.shareId)) return;
            const cached = await dbGet<MusicData>(indexShareKey(share.shareId)).catch(() => undefined);
            if (stillConnected(share) && !deletingShareCaches.has(share.shareId) && cached?.kind === 'MusicData') {
                shareCachedDataByShareId.set(share.shareId, cached);
            }
        }));
    };

    const buildSettingsShareRows = (): SettingsShareRow[] => {
        const hooked = readTestSettingsShareRowsFromHook();
        if (hooked) return hooked;
        const shares = getShares();
        const favorites = getFavorites();
        const tree = getTree();
        if (!shares || !favorites || !tree) return [];
        return shares.getAll().map(share => ({
            id: share.id,
            label: share.name,
            deniedReason: shareDeniedReasonText(shares.getDeniedReason(share.rootKey)),
            getRemoveImpact: () => shares.computeRemoveImpact(share, favorites, tree.getRoots()),
        }));
    };

    /** Browser evidence can change during a failed request or a missed lifecycle event. */
    const reconcileEvidenceAndCheckOffline = (): boolean =>
        (browserAuth?.reconcileEvidenceFromNavigator('index-sync:opening') ?? deps.auth.getEvidence()) === 'evidence:not-online';

    /** A stale transport response can replace evidence without restoring expired browser credentials. */
    const requiresSignIn = (): boolean =>
        browserPrimaryRequiresSignIn || deps.auth.getEvidence() === 'evidence:signed-out' || browserAuth?.isSignedIn() === false;

    /** A failed primary probe or build can establish that sign-in is the recovery. */
    const showPrimaryOpeningFailure = (needsSignIn = false): void => {
        if (deps.hasInstalledTree()) return;
        if (browserAuth && needsSignIn) browserPrimaryRequiresSignIn = true;
        const offline = reconcileEvidenceAndCheckOffline();
        if (!offline && (needsSignIn || requiresSignIn())) deps.showSignIn();
        else deps.showOpeningFailure(offline);
    };

    const fetchFreshAccountInfoOrHandleAuthFailures = async (wasInitialStartup: boolean, signal: AbortSignal): Promise<AccountInfo | undefined> => {
        const freshInfo = await deps.oneDrive.fetchAccountInfo(signal);
        if (!deps.canPull()) return undefined;
        if (freshInfo === 'network') {
            logError('failed to fetch account info (network)');
            browserAuth?.transition('no-evidence');
            if (wasInitialStartup) log('auto-redirect: skipped (no connectivity)');
            return undefined;
        }
        if (freshInfo === 'auth') {
            logError('failed to fetch account info (auth)');
            browserAuth?.transition('evidence:signed-out');
            const evidence = browserAuth?.reconcileEvidenceFromNavigator('index-sync:auto-redirect:tokens-expired');
            if (browserAuth && evidence && shouldAutoRedirect(wasInitialStartup, true, evidence)) {
                log('auto-redirect: redirecting (tokens expired)');
                await browserAuth.attemptSilentRedirect();
                return undefined;
            }
            showPrimaryOpeningFailure(true);
            return undefined;
        }
        // Native owns the drive pairing. No web account update, cache deletion, or
        // favorites/share pull may run for details belonging to another drive.
        if (native && native.state.driveID !== freshInfo.driveId) {
            logError('account details: rejected a different OneDrive account');
            setLatestIndexFailureFromMessageAndPushUi('OneDrive', 'Reconnect with the account used for this library.');
            if (!deps.hasInstalledTree() && !reconcileEvidenceAndCheckOffline()) deps.showSignIn();
            return undefined;
        }
        return freshInfo;
    };

    const writeFreshAccountInfoIntoStateAndSetSignedIn = (freshInfo: AccountInfo): void => {
        localStorage.setItem('account_info', JSON.stringify(freshInfo));
        savedInfoRef = freshInfo;
        browserAuth?.transition('evidence:signed-in');
    };

    const clearCacheAndAccountDataIfDriveChanged = async (
        savedInfo: AccountInfo | undefined,
        freshInfo: AccountInfo,
        cachedData: MusicData | undefined,
    ): Promise<MusicData | undefined> => {
        if (!savedInfo || savedInfo.driveId === freshInfo.driveId) return cachedData;
        log(`driveId changed: ${savedInfo.driveId} → ${freshInfo.driveId}`);
        await dbClear().catch(logCatch('dbClear'));
        deps.accountData.clear();
        shareCachedDataByShareId.clear();
        shareReindexingByShareId.clear();
        shareIndexProgressByShareId.clear();
        cachedDataRef = undefined;
        return undefined;
    };

    const showTreeFromCachedDataIfPresent = (freshInfo: AccountInfo, cachedData: MusicData | undefined): void => {
        if (!cachedData) return;
        deps.showTree(freshInfo, cachedData);
        cachedDataRef = cachedData;
    };

    const fetchMusicFolderMetadata = async (signal: AbortSignal): Promise<MusicDriveItem | undefined> => {
        const musicR = await deps.oneDrive.probeMusicFolder(signal);
        if (!musicR.ok) {
            logError(`music folder fetch failed: ${musicR.status}`);
            showPrimaryOpeningFailure(musicR.status === 401);
            return undefined;
        }
        return readGraphJson(musicR, 'music folder');
    };

    const refreshIndexIfNeeded = async (
        freshInfo: AccountInfo,
        musicDriveItem: MusicDriveItem,
        cachedData: MusicData | undefined,
        signal: AbortSignal,
    ): Promise<void> => {
        if (isCurrentIndex(cachedData, musicDriveItem)) {
            log('cache is current, no re-index needed');
            log(`index end: primary status=up-to-date driveId=${freshInfo.driveId}`);
            writeIndexLastUpdatedNow();
            currentFolders.set(freshInfo.driveId, cachedData.folder);
            return;
        }

        const tree = getTree();
        const isReindex = cachedData !== undefined;
        if (isReindex) {
            tree?.setSyncing(false);
            deps.showTree(freshInfo, cachedData!, true);
            log('re-indexing in background');
        } else {
            deps.showIndexProgress({ fraction: 0, message: 'Starting index...' });
            log('first-time indexing');
        }
        const indexStartedAt = Date.now();
        log(`index start: primary mode=${isReindex ? 'reindex' : 'first-time'} driveId=${freshInfo.driveId}`);

        let data: MusicData;
        try {
            data = await deps.oneDrive.buildAndCacheIndex(
                musicDriveItem,
                (p) => {
                    latestIndexProgress = p;
                    updateSettingsIndexSection();
                    if (!isReindex) deps.showIndexProgress(p);
                },
                freshInfo.driveId,
                undefined,
                signal,
            );
            if (signal.aborted || !deps.canPull()) return;
            // Only publish membership that can survive an offline reopen.
            await dbPut(indexKey(freshInfo.driveId), data);
            if (!deps.canPull()) return;
            deps.showTree(freshInfo, data);
        } catch (e) {
            if (signal.aborted) return;
            // A partial first installation already closed admission. Leave its
            // retry screen in place and stop all remaining tree-dependent work.
            if (!deps.canPull()) throw e;
            latestIndexProgress = undefined;
            updateSettingsIndexSection();
            logError(`index end: primary status=failed driveId=${freshInfo.driveId} durationMs=${Date.now() - indexStartedAt}`);
            logError(`indexing failed: ${errorDetail(e)}`);
            // Restoring the previous root before projecting the warning keeps
            // the warning redraw from retrying the rejected render.
            if (isReindex && cachedData) deps.showTree(freshInfo, cachedData, false);
            setLatestIndexFailureFromErrorAndPushUi('OneDrive', e);
            if (!isReindex) showPrimaryOpeningFailure(e instanceof ProviderHttpError && e.status === 401);
            return;
        }
        currentFolders.set(freshInfo.driveId, data.folder);
        cachedDataRef = data;
        latestIndexProgress = undefined;
        log(`index end: primary status=ok driveId=${freshInfo.driveId} tracks=${data.count} durationMs=${Date.now() - indexStartedAt}`);
        writeIndexLastUpdatedNow();
        deps.computeAndPushOfflineState();
        browserAuth?.transition('evidence:signed-in');
    };

    const probeShareRootsConcurrently = async (signal: AbortSignal): Promise<Map<string, ShareProbeResult>> => {
        const shares = getShares();
        if (!shares) return new Map();
        const records = shares.getAll();
        const results = await Promise.all(records.map(async (share): Promise<ShareProbeResult> => {
            const startedAt = Date.now();
            const applyAccess = native?.beginSourceProbe(share.rootKey);
            try {
                const r = await deps.oneDrive.probeShareRoot(share.driveId, share.rootItemId, signal);
                const durationMs = Date.now() - startedAt;
                if (signal.aborted || !stillConnected(share)) return { share, status: 'skipped' };
                if (!r.ok) {
                    if (native && (r.status === 401 || r.headers.has('X-OnePlay-Account-Error'))) {
                        // MSAL lost the account. Keep this share's last permission state and cached tracks.
                        log(`share probe requires reconnect (${durationMs}ms, status=401)`);
                        return { share, status: 'failed' };
                    }
                    if (r.status === 401 || r.status === 403 || r.status === 404) {
                        if (applyAccess && !await applyAccess(r, false, () => stillConnected(share))) return {share, status: 'skipped'};
                        shares.setDeniedState(share.rootKey, deniedReasonFromStatus(r.status));
                        log(`share probe denied: ${share.name} (${durationMs}ms, status=${r.status})`);
                        return { share, status: 'denied' };
                    }
                    const failureMessage = `Status ${r.status}`;
                    logError(`share probe failed: ${share.name} status=${r.status}`);
                    setLatestIndexFailureFromMessageAndPushUi(share.name, `Probe failed (${failureMessage})`);
                    return { share, status: 'failed', failureMessage };
                }
                const item = await readGraphJson(r, 'share probe');
                if (signal.aborted || !stillConnected(share)) return { share, status: 'skipped' };
                // Missing/malformed metadata is not a permission result. A verified response
                // for this exact item can establish that it is no longer a folder.
                if (native && item?.id !== share.rootItemId) return {share, status: 'failed'};
                if (applyAccess && !await applyAccess(r, !!item?.folder, () => stillConnected(share))) return {share, status: 'skipped'};
                if (!item?.folder) {
                    shares.setDeniedState(share.rootKey, 'Shared folder is no longer accessible');
                    return { share, status: 'denied' };
                }
                shares.setDeniedState(share.rootKey, undefined);
                if (native) deps.onPlaybackRootsChange?.();
                log(`share probe ok: ${share.name} (${durationMs}ms)`);
                return { share, status: 'ok', driveItem: item };
            } catch (e) {
                if (signal.aborted || !stillConnected(share)) return { share, status: 'skipped' };
                logCatch(`share probe ${share.name}`)(e);
                const failureMessage = errorMessage(e);
                setLatestIndexFailureFromMessageAndPushUi(share.name, `Probe failed (${failureMessage})`);
                return { share, status: 'failed', failureMessage };
            }
        }));
        return new Map(results.map((r) => [r.share.shareId, r]));
    };

    const refreshShareIndexesSequentially = async (probes: Map<string, ShareProbeResult>): Promise<void> => {
        const shares = getShares();
        if (!shares || !getTree()) return;
        for (const share of shares.getAll()) {
            const deleting = deletingShareCaches.get(share.shareId);
            if (deleting) await deleting;
            if (!deps.canPull()) return;
            const probe = probes.get(share.shareId);
            if (!stillConnected(share) || probe?.share.id !== share.id) continue;
            const driveItem = probe?.driveItem;
            if (!driveItem || probe?.status !== 'ok') {
                log(`index end: share status=skipped share=${share.name} reason=${probe?.status ?? 'no-probe'}`);
                shareReindexingByShareId.set(share.shareId, false);
                shareIndexProgressByShareId.set(share.shareId, undefined);
                continue;
            }

            const cached = shareCachedDataByShareId.get(share.shareId);
            if (isCurrentIndex(cached, driveItem)) {
                currentFolders.set(share.rootKey, cached.folder);
                log(`index end: share status=up-to-date share=${share.name}`);
                shareReindexingByShareId.set(share.shareId, false);
                shareIndexProgressByShareId.set(share.shareId, undefined);
                continue;
            }

            shareReindexingByShareId.set(share.shareId, true);
            shareIndexProgressByShareId.set(share.shareId, undefined);
            syncShareRootsIntoTreeAndPlayback();
            updateSettingsIndexSection();

            const buildStartedAt = Date.now();
            log(`index start: share share=${share.name}`);
            const cancel = new AbortController();
            const done = (async () => {
                const data = await deps.oneDrive.buildAndCacheIndex(
                    driveItem,
                    (p) => {
                        shareIndexProgressByShareId.set(share.shareId, p);
                        updateSettingsIndexSection();
                    },
                    share.driveId,
                    share.shareId,
                    cancel.signal,
                );
                if (!stillConnected(share)) return;
                await dbPut(indexShareKey(share.shareId), data);
                if (!stillConnected(share)) return;
                shareCachedDataByShareId.set(share.shareId, data);
                currentFolders.set(share.rootKey, data.folder);
                const buildDurationMs = Date.now() - buildStartedAt;
                log(`index end: share status=ok share=${share.name} tracks=${data.count} durationMs=${buildDurationMs}`);
            })();
            shareBuild = { recordID: share.id, cancel, done };
            try {
                await done;
            } catch (e) {
                if (cancel.signal.aborted || !stillConnected(share)) continue;
                logError(`index end: share status=failed share=${share.name} durationMs=${Date.now() - buildStartedAt}`);
                const fallbackStack = e instanceof Error && typeof e.stack === 'string' && e.stack.trim()
                    ? undefined
                    : (new Error('Captured stack for share index failure logging')).stack;
                logError(
                    `share index failed label=${share.name} `
                    + `${errorDetail(e)}`
                    + (fallbackStack ? `\n${fallbackStack}` : ''),
                );
                setLatestIndexFailureFromErrorAndPushUi(share.name, e);
            } finally {
                shareBuild = undefined;
                if (stillConnected(share)) {
                    shareReindexingByShareId.set(share.shareId, false);
                    shareIndexProgressByShareId.set(share.shareId, undefined);
                }
                syncShareRootsIntoTreeAndPlayback();
                updateSettingsIndexSection();
            }
        }
    };

    const pullMusicFolderFromOneDriveInner = async (
        savedInfo: AccountInfo | undefined,
        cachedData: MusicData | undefined,
        signal: AbortSignal,
    ): Promise<void> => {
        const wasInitialStartup = isInitialStartup;
        isInitialStartup = false;
        currentFolders.clear();
        await deps.ensureFavorites();
        await deps.ensureShares();
        signal.throwIfAborted();
        const freshInfo = await fetchFreshAccountInfoOrHandleAuthFailures(wasInitialStartup, signal);
        if (!freshInfo || !deps.canPull()) return;
        writeFreshAccountInfoIntoStateAndSetSignedIn(freshInfo);

        const evidence = browserAuth?.reconcileEvidenceFromNavigator('index-sync:auto-redirect:token-refresh');
        if (browserAuth && evidence && shouldAutoRedirect(wasInitialStartup, false, evidence)) {
            log('auto-redirect: redirecting (token refresh)');
            await browserAuth.attemptSilentRedirect();
            return;
        }

        const cacheForThisAccount = browserAuth
            ? await clearCacheAndAccountDataIfDriveChanged(savedInfo, freshInfo, cachedData)
            : cachedData;
        showTreeFromCachedDataIfPresent(freshInfo, cacheForThisAccount);
        const favorites = getFavorites();
        const favoritesRead = favorites?.pullFavoritesFromOneDrive(signal).then(checked => {
            // Favorites and shares open independently. Invalidated browser
            // credentials can establish recovery before the shares read returns.
            if (browserAuth?.isSignedIn() === false) showPrimaryOpeningFailure();
            return checked;
        });
        const sharesChecked = await getShares()?.pullFromOneDrive(signal);
        if (!deps.canPull()) { await favoritesRead; return; }
        await loadShareIndexesFromCacheIntoState();
        syncShareRootsIntoTreeAndPlayback();
        browserAuth?.transition('evidence:signed-in');

        const [musicDriveItem, shareProbes] = await Promise.all([
            fetchMusicFolderMetadata(signal).catch(error => {
                if (signal.aborted) return undefined;
                logCatch('music folder probe')(error);
                setLatestIndexFailureFromErrorAndPushUi('OneDrive', error);
                showPrimaryOpeningFailure();
                return undefined;
            }),
            probeShareRootsConcurrently(signal),
        ]);
        setSettingsCheckingForUpdatesInFlight(false);
        if (!deps.canPull()) { await favoritesRead; return; }
        if (musicDriveItem) {
            log(`music folder: ${musicDriveItem.name}, size=${musicDriveItem.size}`);
            await refreshIndexIfNeeded(freshInfo, musicDriveItem, cacheForThisAccount, signal);
        }
        getTree()?.setSyncing(false);
        // Primary and share access are independent; a failed Music probe cannot cancel a healthy share refresh.
        if (deps.canPull()) await refreshShareIndexesSequentially(shareProbes);
        syncShareRootsIntoTreeAndPlayback();
        const favoritesChecked = await favoritesRead;
        const tree = getTree();
        // Healing can upload a rewritten document. Wait for the cloud intent and its sources before doing so.
        if (deps.canPull() && tree && favorites && favoritesChecked && sharesChecked) await favorites.heal(tree.getRoots(), currentFolders);
        deps.computeAndPushOfflineState();
    };

    const pullMusicFolderFromOneDrive = async (
        savedInfo: AccountInfo | undefined,
        cachedData: MusicData | undefined,
        signal: AbortSignal,
    ): Promise<void> => {
        getTree()?.setSyncing(true);
        latestIndexProgress = undefined;
        updateSettingsIndexSection();
        try {
            await pullMusicFolderFromOneDriveInner(savedInfo, cachedData, signal);
        } finally {
            if (deps.hasInstalledTree()) getTree()?.setSyncing(false);
            latestIndexProgress = undefined;
            updateSettingsIndexSection();
        }
    };

    const scheduleNextPull = (delayMs = PULL_INTERVAL_MS): void => {
        clearTimeout(pullTimer);
        if (pullInFlightPromise || !deps.canPull() || !deps.hasInstalledTree()) return;
        const ev = deps.auth.getEvidence();
        if (ev === 'evidence:not-online' || ev === 'evidence:signed-out') return;
        pullTimer = setTimeout(() => {
            pullTimer = undefined;
            requestPullFromOneDrive('periodic').catch(logCatch('periodic pull'));
        }, delayMs);
    };

    const cancelScheduledPull = (): void => {
        clearTimeout(pullTimer);
        pullTimer = undefined;
    };

    const requestPullFromOneDrive = async (source: PullSource): Promise<void> => {
        if (!deps.canPull()) return;
        log(`pull: requested (${source})`);
        if (source === 'settings-refresh') {
            clearTimeout(pullTimer);
            pullTimer = undefined;
        }
        // Connectivity can update the visible action immediately, even while
        // the rejected attempt still waits for an unrelated response.
        if (browserAuth && !deps.hasInstalledTree() && requiresSignIn()) {
            showPrimaryOpeningFailure();
            return;
        }
        if (pullInFlightPromise) {
            // The old attempt can settle after the listener reconnects or
            // signs in. An empty library then needs a fresh pull.
            if (!deps.hasInstalledTree() && ((browserAuth && source === 'online')
                || (native && source === 'settings-refresh'))) openingRecoveryPending = source;
            log(`pull: coalesced (${source})`);
            return pullInFlightPromise;
        }
        if (!deps.hasInstalledTree()) {
            if (reconcileEvidenceAndCheckOffline()) {
                deps.showOpeningFailure(true);
                return;
            }
            deps.showOpening();
        }
        clearLatestIndexFailureIntoRuntimeStateAndPushUi();
        const startedAt = Date.now();
        setSettingsCheckingForUpdatesInFlight(true);
        const controller = new AbortController();
        pullController = controller;
        pullInFlightPromise = (async () => {
            log(`pull: start (${source})`);
            try {
                await pullMusicFolderFromOneDrive(savedInfoRef, cachedDataRef, controller.signal);
            } catch (e) {
                if (!controller.signal.aborted) logError(`pull failed (${source}): ${errorDetail(e)}`);
            } finally {
                const opening = deps.canPull() && !deps.hasInstalledTree();
                const offline = opening && reconcileEvidenceAndCheckOffline();
                const recovery = opening && !offline
                    && (openingRecoveryPending === 'settings-refresh' || !requiresSignIn())
                    ? openingRecoveryPending : undefined;
                openingRecoveryPending = undefined;
                if (opening && !recovery) {
                    if (!offline && requiresSignIn()) deps.showSignIn();
                    else deps.finishOpening(offline);
                }
                const elapsedMs = Date.now() - startedAt;
                log(`pull: complete (${source}; ${elapsedMs}ms)`);
                setSettingsCheckingForUpdatesInFlight(false);
                pullInFlightPromise = undefined;
                pullController = undefined;
                updateSettingsIndexSection();
                if (recovery) await requestPullFromOneDrive(recovery);
                else scheduleNextPull();
            }
        })();
        updateSettingsIndexSection();
        return pullInFlightPromise;
    };

    const onShareAdded = (record: ShareRecordPersisted): void => {
        currentFolders.delete(record.rootKey);
        shareReindexingByShareId.set(record.shareId, true);
        syncShareRootsIntoTreeAndPlayback();
    };

    const onShareRemoved = async (record: ShareRecordPersisted): Promise<void> => {
        currentFolders.delete(record.rootKey);
        const writer = shareBuild?.recordID === record.id ? shareBuild : undefined;
        writer?.cancel.abort();
        const previous = deletingShareCaches.get(record.shareId);
        const deletion = (async () => {
            await previous?.catch(() => {});
            // A write may already be in Graph's hands or an open IDB transaction.
            // Its result (including failure) is owned by the build above.
            await writer?.done.catch(() => {});
            shareCachedDataByShareId.delete(record.shareId);
            shareReindexingByShareId.delete(record.shareId);
            shareIndexProgressByShareId.delete(record.shareId);
            await dbDelete(indexShareKey(record.shareId)).catch(logCatch('share index delete'));
            await deps.oneDrive.deleteShareCache(record.shareId).catch(logCatch('remove share remote cache'));
        })();
        deletingShareCaches.set(record.shareId, deletion);
        try { await deletion; }
        finally {
            if (deletingShareCaches.get(record.shareId) === deletion) deletingShareCaches.delete(record.shareId);
        }
        if (!getShares()?.getAll().some(s => s.rootKey === record.rootKey)) {
            getShares()?.setDeniedState(record.rootKey, undefined);
            syncShareRootsIntoTreeAndPlayback();
            deps.computeAndPushOfflineState();
            updateSettingsIndexSection();
        }
    };

    return {
        setSavedInfoRef(value) { savedInfoRef = value; },
        getSavedInfoRef() { return savedInfoRef; },
        setCachedDataRef(value) { cachedDataRef = value; },
        getCachedDataRef() { return cachedDataRef; },
        setLastIndexUpdatedAt(value) { lastIndexUpdatedAt = value; },
        getLastIndexUpdatedAt() { return lastIndexUpdatedAt; },
        hasLatestIndexFailure() { return latestIndexFailure !== undefined; },
        clearLatestIndexFailureIntoRuntimeStateAndPushUi,
        setLatestIndexFailureFromMessageAndPushUi,
        syncShareRootsIntoTreeAndPlayback,
        loadShareIndexesFromCacheIntoState,
        buildSettingsShareRows,
        updateSettingsIndexSection,
        cancelScheduledPull,
        async drainPullsAfterAdmissionCloses() {
            cancelScheduledPull();
            pullController?.abort();
            shareBuild?.cancel.abort();
            await pullInFlightPromise;
        },
        requestPullFromOneDrive,
        onShareAdded,
        onShareRemoved,
    };
}
