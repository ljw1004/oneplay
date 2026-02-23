/**
 * Index sync orchestration for OnePlay Music.
 *
 * Scope:
 * - Owns pull single-flight, periodic scheduling, and online-triggered refresh.
 * - Owns account/share probe/index refresh flows and settings sync status projection.
 * - Coordinates share index cache lifecycle and share add/remove side effects.
 *
 * Non-scope:
 * - Startup terminal UI/deadline policy (owned by index-startup.ts).
 * - App composition/tree-playback-select wiring (owned by index.ts).
 */
import type { Auth, EvidenceState } from './auth.js';
import { dbGet, dbPut, dbDelete, dbClear } from './db.js';
import { log, logError, logCatch, errorMessage, errorDetail } from './logger.js';
import {
    type MusicData,
    type MusicDriveItem,
    type AccountInfo,
    type IndexProgress,
    type MusicFolder,
    isMusicFolder,
    SCHEMA_VERSION,
    fetchAccountInfo,
    buildIndex,
} from './indexer.js';
import type { TreeView } from './tree.js';
import type { Playback } from './playback.js';
import type { Favorites, RootsMap } from './favorites.js';
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
    readonly status: 'ok' | 'denied' | 'failed';
    readonly driveItem?: MusicDriveItem;
    readonly failureMessage?: string;
}

export interface IndexSyncDeps {
    readonly auth: Auth;
    readonly startupErrorMessage: string;
    readonly accountData: Map<string, { folder: MusicFolder; driveId: string }>;
    readonly getTree: () => TreeView | undefined;
    readonly getPlayback: () => Playback | undefined;
    readonly getFavorites: () => Favorites | undefined;
    readonly getSelect: () => Select | undefined;
    readonly getSettings: () => SettingsView | undefined;
    readonly getShares: () => Shares | undefined;
    readonly ensureFavorites: () => Promise<void>;
    readonly ensureShares: () => Promise<void>;
    readonly showTree: (info: AccountInfo, data: MusicData, reindexing?: boolean) => void;
    readonly showError: (message: string) => void;
    readonly renderSignInButtonIntoStatus: () => void;
    readonly renderStartupErrorIntoStatusAndWireReload: (message: string) => void;
    readonly markStartupTerminalState: (state: 'error') => void;
    readonly enterFirstTimeIndexingAndBypassStartupDeadline: () => void;
    readonly renderIndexing: (progress: IndexProgress) => void;
    readonly computeAndPushOfflineState: () => void;
    readonly invalidateSearchData: () => void;
    readonly runSearchAndPushIntoTree: (reason: SearchReason) => void;
}

export interface IndexSyncController {
    setSavedInfoRef(value: AccountInfo | undefined): void;
    getSavedInfoRef(): AccountInfo | undefined;
    setCachedDataRef(value: MusicData | undefined): void;
    getCachedDataRef(): MusicData | undefined;
    setInitialStartup(value: boolean): void;
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
    requestPullFromOneDrive(source: PullSource): Promise<void>;
    requestStartupPullIfEvidenceAllows(): Promise<void>;
    onShareAdded(record: ShareRecordPersisted): void;
    onShareRemoved(record: ShareRecordPersisted): Promise<void>;
}

const indexShareKey = (shareId: string): string => `index-share:${shareId}`;
const shareCacheNamespace = (shareId: string): string => `share-${encodeURIComponent(shareId)}`;
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
            removeImpactTracks: typeof x.removeImpactTracks === 'number' ? x.removeImpactTracks : 0,
            removeImpactFavorites: typeof x.removeImpactFavorites === 'number' ? x.removeImpactFavorites : 0,
        }));
}

function buildItemIdMapForRoot(driveId: string, folder: MusicFolder): Map<string, { driveId: string; path: string[] }> {
    const map = new Map<string, { driveId: string; path: string[] }>();
    const walk = (f: MusicFolder, currentPath: string[]): void => {
        map.set(f.id, { driveId, path: currentPath });
        for (const [name, child] of Object.entries(f.children)) {
            const childPath = [...currentPath, name];
            if (isMusicFolder(child)) walk(child, childPath);
            else map.set(child.id, { driveId, path: childPath });
        }
    };
    walk(folder, []);
    return map;
}

function buildPerRootIdMaps(roots: RootsMap):
Map<string, Map<string, { driveId: string; path: string[] }>> {
    const result = new Map<string, Map<string, { driveId: string; path: string[] }>>();
    for (const [key, root] of roots) {
        if (root.type === 'onedrive') {
            result.set(key, buildItemIdMapForRoot(root.info.driveId, root.folder));
        } else if (root.type === 'share' && root.folder) {
            result.set(key, buildItemIdMapForRoot(root.driveId, root.folder));
        }
    }
    return result;
}

export function createIndexSync(deps: IndexSyncDeps): IndexSyncController {
    let savedInfoRef: AccountInfo | undefined;
    let cachedDataRef: MusicData | undefined;
    let isInitialStartup = false;
    let lastIndexUpdatedAt: number | undefined;
    let latestIndexProgress: IndexProgress | undefined;
    let latestIndexFailure: SettingsIndexFailure | undefined;

    const shareCachedDataByShareId = new Map<string, MusicData>();
    const shareReindexingByShareId = new Map<string, boolean>();
    const shareIndexProgressByShareId = new Map<string, IndexProgress | undefined>();

    let pullTimer: ReturnType<typeof setTimeout> | undefined;
    let pullInFlightPromise: Promise<void> | undefined;
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
        for (const shareId of [...shareReindexingByShareId.keys()]) {
            if (!allowed.has(shareId)) shareReindexingByShareId.delete(shareId);
        }
        for (const shareId of [...shareIndexProgressByShareId.keys()]) {
            if (!allowed.has(shareId)) shareIndexProgressByShareId.delete(shareId);
        }
        const rows = shares.getAll().map((share) => ({
            key: share.rootKey,
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
        if (playback && favorites) playback.setContext(favorites, tree.getRoots());
        getSelect()?.setRoots(tree.getRoots());
        deps.invalidateSearchData();
        deps.runSearchAndPushIntoTree('share-roots');
    };

    const loadShareIndexesFromCacheIntoState = async (): Promise<void> => {
        const shares = getShares();
        if (!shares) return;
        const records = shares.getAll();
        const allowed = new Set(records.map((s) => s.shareId));
        for (const shareId of [...shareCachedDataByShareId.keys()]) {
            if (!allowed.has(shareId)) shareCachedDataByShareId.delete(shareId);
        }
        await Promise.all(records.map(async (share) => {
            const cached = await dbGet<MusicData>(indexShareKey(share.shareId)).catch(() => undefined);
            if (cached && typeof cached === 'object' && cached.kind === 'MusicData') {
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
        return shares.getAll().map((share) => {
            const impact = shares.computeRemoveImpact(share.rootKey, favorites, tree.getRoots());
            return {
                id: share.id,
                label: share.name,
                deniedReason: shareDeniedReasonText(shares.getDeniedReason(share.rootKey)),
                removeImpactTracks: impact.uniqueTrackCount,
                removeImpactFavorites: impact.affectedFavoriteCount,
            };
        });
    };

    const healFavoritesFromLoadedRoots = async (
        removedRootKeys: ReadonlySet<string> = new Set(),
    ): Promise<void> => {
        const favorites = getFavorites();
        const tree = getTree();
        if (!favorites || !tree) return;
        const roots = tree.getRoots();
        const perRootMaps = buildPerRootIdMaps(roots);
        const denied = getShares()?.getDeniedRootKeys() ?? new Set<string>();
        await favorites.heal(perRootMaps, roots, denied, removedRootKeys);
    };

    const removeShareRemoteCacheBestEffort = async (shareId: string): Promise<void> => {
        const namespace = shareCacheNamespace(shareId);
        await deps.auth.fetch(
            `https://graph.microsoft.com/v1.0/me/drive/special/approot:/${namespace}`,
            false,
            { method: 'DELETE' },
        ).catch(logCatch('remove share remote cache'));
    };

    const fetchFreshAccountInfoOrHandleAuthFailures = async (
        wasInitialStartup: boolean,
        cachedData: MusicData | undefined,
    ): Promise<AccountInfo | undefined> => {
        const freshInfo = await fetchAccountInfo(deps.auth.fetch);
        if (freshInfo === 'network') {
            logError('failed to fetch account info (network)');
            deps.auth.transition('no-evidence');
            if (wasInitialStartup) log('auto-redirect: skipped (no connectivity)');
            if (wasInitialStartup && !cachedData) {
                log('startup: account info fetch returned network with no cache');
                deps.markStartupTerminalState('error');
                deps.renderStartupErrorIntoStatusAndWireReload(deps.startupErrorMessage);
            }
            return undefined;
        }
        if (freshInfo === 'auth') {
            logError('failed to fetch account info (auth)');
            deps.auth.transition('evidence:signed-out');
            const evidence = deps.auth.reconcileEvidenceFromNavigator('index-sync:auto-redirect:tokens-expired');
            if (shouldAutoRedirect(wasInitialStartup, true, evidence)) {
                log('auto-redirect: redirecting (tokens expired)');
                await deps.auth.attemptSilentRedirect();
                return undefined;
            }
            if (!cachedData) deps.renderSignInButtonIntoStatus();
            return undefined;
        }
        return freshInfo;
    };

    const writeFreshAccountInfoIntoStateAndSetSignedIn = (freshInfo: AccountInfo): void => {
        localStorage.setItem('account_info', JSON.stringify(freshInfo));
        savedInfoRef = freshInfo;
        deps.auth.transition('evidence:signed-in');
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

    const fetchMusicFolderMetadataOrShowError = async (
        cachedData: MusicData | undefined,
    ): Promise<MusicDriveItem | undefined> => {
        const musicR = await deps.auth.fetch(
            'https://graph.microsoft.com/v1.0/me/drive/special/music?$select=name,id,cTag,eTag,size,lastModifiedDateTime,folder',
            false,
        );
        if (!musicR.ok) {
            const text = await musicR.text().catch(() => '');
            logError(`music folder fetch failed: ${musicR.status} ${text}`);
            if (!cachedData) deps.showError(`Cannot access Music folder: ${musicR.status}`);
            return undefined;
        }
        return musicR.json();
    };

    const refreshIndexIfNeeded = async (
        freshInfo: AccountInfo,
        musicDriveItem: MusicDriveItem,
        cachedData: MusicData | undefined,
    ): Promise<void> => {
        if (cachedData
            && cachedData.size === musicDriveItem.size
            && cachedData.schemaVersion === SCHEMA_VERSION) {
            log('cache is current, no re-index needed');
            log(`index end: primary status=up-to-date driveId=${freshInfo.driveId}`);
            writeIndexLastUpdatedNow();
            return;
        }

        const tree = getTree();
        const isReindex = cachedData !== undefined;
        if (isReindex) {
            tree?.setSyncing(false);
            deps.showTree(freshInfo, cachedData!, true);
            log('re-indexing in background');
        } else {
            deps.enterFirstTimeIndexingAndBypassStartupDeadline();
            log('first-time indexing');
        }
        const indexStartedAt = Date.now();
        log(`index start: primary mode=${isReindex ? 'reindex' : 'first-time'} driveId=${freshInfo.driveId}`);

        try {
            const data = await buildIndex(
                musicDriveItem,
                (p) => {
                    latestIndexProgress = p;
                    updateSettingsIndexSection();
                    if (!isReindex) deps.renderIndexing(p);
                },
                deps.auth.fetch,
                freshInfo.driveId,
                'primary',
            );
            await dbPut(indexKey(freshInfo.driveId), data).catch(logCatch('dbPut'));
            deps.showTree(freshInfo, data);
            cachedDataRef = data;
            latestIndexProgress = undefined;
            log(`index end: primary status=ok driveId=${freshInfo.driveId} tracks=${data.count} durationMs=${Date.now() - indexStartedAt}`);
            writeIndexLastUpdatedNow();
            deps.computeAndPushOfflineState();
            deps.auth.transition('evidence:signed-in');
        } catch (e) {
            latestIndexProgress = undefined;
            updateSettingsIndexSection();
            logError(`index end: primary status=failed driveId=${freshInfo.driveId} durationMs=${Date.now() - indexStartedAt}`);
            logError(`indexing failed: ${errorDetail(e)}`);
            setLatestIndexFailureFromErrorAndPushUi('OneDrive', e);
            if (isReindex && cachedData) deps.showTree(freshInfo, cachedData, false);
            if (!cachedData) deps.showError('Indexing failed. Please try again.');
        }
    };

    const probeShareRootsConcurrently = async (): Promise<Map<string, ShareProbeResult>> => {
        const shares = getShares();
        if (!shares) return new Map();
        const records = shares.getAll();
        const results = await Promise.all(records.map(async (share): Promise<ShareProbeResult> => {
            const startedAt = Date.now();
            try {
                const r = await deps.auth.fetch(
                    `https://graph.microsoft.com/v1.0/drives/${encodeURIComponent(share.driveId)}/items/${encodeURIComponent(share.rootItemId)}?$select=name,id,cTag,eTag,size,lastModifiedDateTime,folder`,
                    false,
                );
                const durationMs = Date.now() - startedAt;
                if (!r.ok) {
                    if (r.status === 401 || r.status === 403 || r.status === 404) {
                        shares.setDeniedState(share.rootKey, deniedReasonFromStatus(r.status));
                        log(`share probe denied: ${share.name} (${durationMs}ms, status=${r.status})`);
                        return { share, status: 'denied' };
                    }
                    const responseText = await r.text().catch(() => '');
                    const condensed = responseText.trim().replace(/\s+/g, ' ').slice(0, 160);
                    const failureMessage = condensed ? `${r.status}: ${condensed}` : `Status ${r.status}`;
                    logError(`share probe failed: ${share.name} status=${r.status} detail=${condensed || '<empty>'}`);
                    setLatestIndexFailureFromMessageAndPushUi(share.name, `Probe failed (${failureMessage})`);
                    return { share, status: 'failed', failureMessage };
                }
                const item = await r.json();
                if (!item?.folder) {
                    shares.setDeniedState(share.rootKey, 'Shared folder is no longer accessible');
                    return { share, status: 'denied' };
                }
                shares.setDeniedState(share.rootKey, undefined);
                log(`share probe ok: ${share.name} (${durationMs}ms)`);
                return { share, status: 'ok', driveItem: item };
            } catch (e) {
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
            const probe = probes.get(share.shareId);
            const driveItem = probe?.driveItem;
            if (!driveItem || probe?.status !== 'ok') {
                log(`index end: share status=skipped share=${share.name} reason=${probe?.status ?? 'no-probe'}`);
                shareReindexingByShareId.set(share.shareId, false);
                shareIndexProgressByShareId.set(share.shareId, undefined);
                continue;
            }

            const cached = shareCachedDataByShareId.get(share.shareId);
            if (cached && cached.size === driveItem.size && cached.schemaVersion === SCHEMA_VERSION) {
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
            log(`index start: share share=${share.name} shareId=${share.shareId}`);
            try {
                const data = await buildIndex(
                    driveItem,
                    (p) => {
                        shareIndexProgressByShareId.set(share.shareId, p);
                        updateSettingsIndexSection();
                    },
                    deps.auth.fetch,
                    share.driveId,
                    shareCacheNamespace(share.shareId),
                );
                await dbPut(indexShareKey(share.shareId), data).catch(logCatch('dbPut share index'));
                shareCachedDataByShareId.set(share.shareId, data);
                const buildDurationMs = Date.now() - buildStartedAt;
                log(`index end: share status=ok share=${share.name} tracks=${data.count} durationMs=${buildDurationMs}`);
            } catch (e) {
                logError(`index end: share status=failed share=${share.name} durationMs=${Date.now() - buildStartedAt}`);
                const fallbackStack = e instanceof Error && typeof e.stack === 'string' && e.stack.trim()
                    ? undefined
                    : (new Error('Captured stack for share index failure logging')).stack;
                logError(
                    `share index failed label=${share.name} shareId=${share.shareId} `
                    + `rootKey=${share.rootKey}: ${errorDetail(e)}`
                    + (fallbackStack ? `\n${fallbackStack}` : ''),
                );
                setLatestIndexFailureFromErrorAndPushUi(share.name, e);
            } finally {
                shareReindexingByShareId.set(share.shareId, false);
                shareIndexProgressByShareId.set(share.shareId, undefined);
                syncShareRootsIntoTreeAndPlayback();
                updateSettingsIndexSection();
            }
        }
    };

    const pullMusicFolderFromOneDriveInner = async (
        savedInfo: AccountInfo | undefined,
        cachedData: MusicData | undefined,
    ): Promise<void> => {
        const wasInitialStartup = isInitialStartup;
        isInitialStartup = false;
        await deps.ensureFavorites();
        await deps.ensureShares();
        const freshInfo = await fetchFreshAccountInfoOrHandleAuthFailures(wasInitialStartup, cachedData);
        if (!freshInfo) return;
        writeFreshAccountInfoIntoStateAndSetSignedIn(freshInfo);

        const evidence = deps.auth.reconcileEvidenceFromNavigator('index-sync:auto-redirect:token-refresh');
        if (shouldAutoRedirect(wasInitialStartup, false, evidence)) {
            log('auto-redirect: redirecting (token refresh)');
            await deps.auth.attemptSilentRedirect();
            return;
        }

        const cacheForThisAccount = await clearCacheAndAccountDataIfDriveChanged(savedInfo, freshInfo, cachedData);
        showTreeFromCachedDataIfPresent(freshInfo, cacheForThisAccount);

        await getFavorites()?.pullFavoritesFromOneDrive();
        await getShares()?.pullFromOneDrive();
        await loadShareIndexesFromCacheIntoState();
        syncShareRootsIntoTreeAndPlayback();
        deps.auth.transition('evidence:signed-in');

        const [musicDriveItem, shareProbes] = await Promise.all([
            fetchMusicFolderMetadataOrShowError(cacheForThisAccount),
            probeShareRootsConcurrently(),
        ]);
        setSettingsCheckingForUpdatesInFlight(false);
        if (!musicDriveItem) return;
        log(`music folder: ${musicDriveItem.name}, size=${musicDriveItem.size}`);
        await refreshIndexIfNeeded(freshInfo, musicDriveItem, cacheForThisAccount);
        getTree()?.setSyncing(false);
        await refreshShareIndexesSequentially(shareProbes);
        syncShareRootsIntoTreeAndPlayback();
        await healFavoritesFromLoadedRoots();
    };

    const pullMusicFolderFromOneDrive = async (
        savedInfo: AccountInfo | undefined,
        cachedData: MusicData | undefined,
    ): Promise<void> => {
        getTree()?.setSyncing(true);
        latestIndexProgress = undefined;
        updateSettingsIndexSection();
        try {
            await pullMusicFolderFromOneDriveInner(savedInfo, cachedData);
        } finally {
            getTree()?.setSyncing(false);
            latestIndexProgress = undefined;
            updateSettingsIndexSection();
        }
    };

    const scheduleNextPull = (delayMs = PULL_INTERVAL_MS): void => {
        clearTimeout(pullTimer);
        if (pullInFlightPromise) return;
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
        log(`pull: requested (${source})`);
        if (source === 'settings-refresh') {
            clearTimeout(pullTimer);
            pullTimer = undefined;
        }
        if (pullInFlightPromise) {
            log(`pull: coalesced (${source})`);
            return pullInFlightPromise;
        }
        clearLatestIndexFailureIntoRuntimeStateAndPushUi();
        const startedAt = Date.now();
        setSettingsCheckingForUpdatesInFlight(true);
        pullInFlightPromise = (async () => {
            log(`pull: start (${source})`);
            try {
                await pullMusicFolderFromOneDrive(savedInfoRef, cachedDataRef);
            } catch (e) {
                logError(`pull failed (${source}): ${errorDetail(e)}`);
            } finally {
                const elapsedMs = Date.now() - startedAt;
                log(`pull: complete (${source}; ${elapsedMs}ms)`);
                setSettingsCheckingForUpdatesInFlight(false);
                pullInFlightPromise = undefined;
                updateSettingsIndexSection();
                scheduleNextPull();
            }
        })();
        updateSettingsIndexSection();
        return pullInFlightPromise;
    };

    const requestStartupPullIfEvidenceAllows = async (): Promise<void> => {
        const evidence = deps.auth.reconcileEvidenceFromNavigator('index-sync:startup-pull-gate', { logUnchanged: true });
        if (evidence === 'evidence:not-online') {
            log('skipping pull: evidence is not-online');
            return;
        }
        await requestPullFromOneDrive('startup');
    };

    const onShareAdded = (record: ShareRecordPersisted): void => {
        shareReindexingByShareId.set(record.shareId, true);
        syncShareRootsIntoTreeAndPlayback();
    };

    const onShareRemoved = async (record: ShareRecordPersisted): Promise<void> => {
        getShares()?.setDeniedState(record.rootKey, undefined);
        shareCachedDataByShareId.delete(record.shareId);
        shareReindexingByShareId.delete(record.shareId);
        shareIndexProgressByShareId.delete(record.shareId);
        await dbDelete(indexShareKey(record.shareId)).catch(logCatch('share index delete'));
        await removeShareRemoteCacheBestEffort(record.shareId);
        syncShareRootsIntoTreeAndPlayback();
        await healFavoritesFromLoadedRoots(new Set([record.rootKey]));
        deps.computeAndPushOfflineState();
        updateSettingsIndexSection();
    };

    return {
        setSavedInfoRef(value) { savedInfoRef = value; },
        getSavedInfoRef() { return savedInfoRef; },
        setCachedDataRef(value) { cachedDataRef = value; },
        getCachedDataRef() { return cachedDataRef; },
        setInitialStartup(value) { isInitialStartup = value; },
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
        requestPullFromOneDrive,
        requestStartupPullIfEvidenceAllows,
        onShareAdded,
        onShareRemoved,
    };
}
