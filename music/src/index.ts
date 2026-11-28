import { createAuth, isAbortError, type EvidenceState } from './auth.js';
import { showModal } from './modal.js';
import { createOfflinePins } from './native-pins.js';
import { attachNativePlayback } from './native-playback.js';
import { connectBundledLibrary } from './native-library.js';
import { buildFavoritePlaybackStorageValue, parseFavoritePlaybackStorageValue, parseGlobalPlaybackSave,
    parseGlobalPlaybackTime, type GlobalPlaybackSave } from './playback-engine.js';
import { createMusicDatabase, dbGet, dbPut, dbClear, dbDelete, dbKeysWithPrefix } from './db.js';
import { log, logError, logCatch } from './logger.js';
import { initWebLogger } from './logger-web.js';
import {
    type MusicData, type MusicFolder, type AccountInfo, sortedFolderChildren,
} from './indexer.js';
import { createTree, type TreeView } from './tree.js';
import { createPlayback, type Playback, isValidMode } from './playback.js';
import type { DrawerState, DrawerView } from './playback-ui.js';
import { isPathDeniedByShare } from './roots.js';
import { createFavorites, type Favorite, type Favorites } from './favorites.js';
import { createSelect, type Select } from './select.js';
import { createDownloads, type Downloads, classifyOfflineBadgeState } from './downloads.js';
import { buildLibraryQueue, resolveFolderFromPath, resolveTrackIds } from './tracks.js';
import {
    runSearchSingleWalk,
    runSearchIncrementalRefinement,
    type SearchResult,
} from './search.js';
import {
    createSettings,
    type SettingsView,
    type TimerDuration,
    type ThemePreference,
} from './settings.js';
import { createShares, type Shares } from './shares.js';
import { createIndexSync } from './index-sync.js';
import { createOneDriveProvider } from './onedrive-provider.js';
import { createIndexStartup } from './index-startup.js';
import { createDemoMedia, DEMO_SOURCE, fetchDemoCatalog, parseDemoCatalog, type DemoCatalog } from './demo-provider.js';
import { MediaTransientError, MediaUnavailableError, ProviderHttpError } from './provider.js';

const displayNativeLog = initWebLogger();
const DEMO_SELECTION = 'oneplay_demo_active';
const CONNECT_ORIGIN = 'oneplay_connect_origin';
const SIGNOUT_FOCUS = 'oneplay_focus_provider_chooser';
const DEMO_CATALOG_KEY = 'catalog';
const DEMO_FOCUS = 'oneplay_demo_focus';
const DEMO_LOAD_FAILURE = 'The demo library couldn’t load.';
const demoDb = createMusicDatabase('oneplay-demo-music-cache', 1);
type Workspace = 'chooser' | 'demo' | 'personal';
let workspace: Workspace = 'chooser';
const isDemo = (): boolean => workspace === 'demo';
/** A cached personal tree remains admitted through token expiry. */
function browserWorkspace(): Workspace {
    if (browserAuth?.isSignedIn()) return 'personal';
    if (localStorage.getItem(DEMO_SELECTION) === '1') return 'demo';
    return readJson<AccountInfo>('account_info') ? 'personal' : 'chooser';
}
let demoWanted = false;
let demoSlow = false;
let demoOpening: {id: string; controller: AbortController; settled: Promise<void>; recoverIfFailed: boolean} | undefined;
let connecting = false;
let demoPage = new AbortController();
let demoCatalog: DemoCatalog | undefined;
let demoProjectionComplete = false;
let demoRefresh: Promise<void> | undefined;
let demoFocusOnTree = false;
let catalogRetryTimer: ReturnType<typeof setTimeout> | undefined;
let catalogRetryDelay = 4_000;
let demoEvidence: EvidenceState = 'no-evidence';
let demoRetryDelay = 4_000;
let demoRetryTimer: ReturnType<typeof setTimeout> | undefined;
const demoMedia = createDemoMedia(() => demoCatalog);

/** Profile-specific UI state is outside the OneDrive bulk-cleanup prefix. */
const profileKey = (key: string): string => isDemo() ? 'demo_oneplay_music_' + key : 'oneplay_music_' + key;
const getLibraryEvidence = (): EvidenceState => isDemo() && !native ? demoEvidence : auth.getEvidence();

/** Debug mode: shows evidence-state indicator and auto-reloads on SW update. */
const SW_DEBUG = true;
const TIMER_VALUES: readonly TimerDuration[] = ['15m', '30m', '45m', '60m', 'end-of-track'];

/** Deploy counter — replaced by sed during `npm run deploy`.
 *  On localhost (watch mode), this stays as the placeholder string. */
const DEPLOY_COUNTER = '__DEPLOY_COUNTER__';

let debugEnabled = false;

// DOM helpers

const statusEl = (): HTMLElement => document.getElementById('status')!;


/** Loads cached MusicData from IndexedDB, returning undefined if absent or schema mismatch. */
const loadCachedData = async (driveId: string): Promise<MusicData | undefined> => {
    const data = await dbGet<MusicData>(indexKey(driveId));
    return (data && typeof data === 'object' && data.kind === 'MusicData') ? data : undefined;
};

/** IndexedDB key for a given driveId. */
const indexKey = (driveId: string): string => `index:${driveId}`;

// M10: localStorage state persistence helpers

/** Reads and parses a JSON localStorage key, returning undefined on miss or parse error. */
const readJson = <T>(key: string): T | undefined => {
    try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : undefined;
    } catch { return undefined; }
};

/** Runtime type guard for persisted timer values. */
const isTimerDuration = (value: unknown): value is TimerDuration =>
    typeof value === 'string' && TIMER_VALUES.includes(value as TimerDuration);

const THEME_VALUES: readonly ThemePreference[] = ['light', 'dark', 'auto'];
const isThemePreference = (value: unknown): value is ThemePreference =>
    typeof value === 'string' && THEME_VALUES.includes(value as ThemePreference);

/** Applies the resolved theme to the DOM. Sets data-theme on <html> and updates
 *  <meta name="theme-color"> and <meta name="color-scheme"> to match. */
function applyTheme(): void {
    const isDark = themePreference === 'dark' ||
        (themePreference === 'auto' && matchMedia('(prefers-color-scheme:dark)').matches);
    if (isDark) {
        document.documentElement.dataset.theme = 'dark';
    } else {
        delete document.documentElement.dataset.theme;
    }
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', getComputedStyle(document.documentElement).getPropertyValue('--bg-header').trim());
    const cs = document.querySelector('meta[name="color-scheme"]');
    if (cs) cs.setAttribute('content', isDark ? 'dark' : 'light');
}

/** Removes all oneplay_music_* keys from localStorage (sign-out cleanup).
 *  Preserves oneplay_music_theme — theme preference is a device setting, not account state. */
const clearM10State = (): void => {
    const keys = Object.keys(localStorage).filter(k => k.startsWith('oneplay_music_') && k !== 'oneplay_music_theme');
    for (const k of keys) localStorage.removeItem(k);
};

// Restored M10 state, read synchronously at the top of onBodyLoad().
// Module-scoped so showTree and wireFavoritesUi can access them.
let viewState: { path?: readonly string[] } & DrawerState;
let restoredScroll: Record<string, {top: number}> | undefined;
let restoredPlayback: GlobalPlaybackSave | undefined;
let restoredTime: number | undefined;
let favoriteCustomizeToastShownInSession = false;
let activeToastEl: HTMLElement | undefined;
let activeToastTimer: ReturnType<typeof setTimeout> | undefined;
let appResumeLogArmed = false;
// Pulls require a successful first tree install or a completed local cache miss.
// A partial installation closes admission again until explicit document retry.
let localBootstrapComplete = false;

/** Shows a short-lived toast above the bottom controls. */
function showToastMessage(message: string): void {
    if (activeToastEl) activeToastEl.remove();
    if (activeToastTimer) clearTimeout(activeToastTimer);

    const toast = document.createElement('div');
    toast.className = 'hint-toast';
    toast.textContent = message;
    document.body.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('visible'));

    activeToastEl = toast;
    activeToastTimer = setTimeout(() => {
        toast.classList.remove('visible');
        setTimeout(() => {
            if (activeToastEl === toast) activeToastEl = undefined;
            toast.remove();
        }, 180);
        activeToastTimer = undefined;
    }, 2600);
}

/** Shows the "customize favorite" coaching toast at most once across sessions. */
function showFavoriteCustomizeToastOnce(): void {
    if (favoriteCustomizeToastShownInSession) return;
    favoriteCustomizeToastShownInSession = true;

    try {
        if (localStorage.getItem(profileKey('tip_customize_favorite_shown')) === '1') return;
        localStorage.setItem(profileKey('tip_customize_favorite_shown'), '1');
    } catch {
        // If localStorage is unavailable/quota-limited, still show once per session.
    }
    showToastMessage('Tip: Press and hold a favorite to customize it.');
}


// Auth module (created once at module scope, before any network calls)

const native = connectBundledLibrary(displayNativeLog);
const browserAuth = native ? undefined : createAuth();
const auth = native ?? browserAuth!;
const oneDrive = createOneDriveProvider(auth.fetch, native?.followContent);
auth.onEvidenceChange = (newState, prevState) => {
    log(`evidence: ${prevState} → ${newState}`);
    if (workspace !== 'personal') {
        if (native && offlinePins) { renderOfflineProgress(true); offlinePins.refresh().catch(logCatch('demo offline evidence')); }
        if (prevState === 'evidence:not-online' && newState !== 'evidence:not-online') resumeDemoOrChooser();
        return;
    }
    if (native && startup.hasInstalledTree()) {
        if (newState === 'evidence:not-online' || newState === 'evidence:signed-out') sync.cancelScheduledPull();
        else if (prevState === 'evidence:not-online') sync.requestPullFromOneDrive('online').catch(logCatch('native online pull'));
    }
    if (localBootstrapComplete) {
        if (newState === 'evidence:not-online' || (browserAuth && !navigator.onLine)) {
            startup.showOfflineIfAwaitingRecovery();
        } else if (newState === 'evidence:signed-out') {
            startup.showSignInIfAwaitingRecovery(!!browserAuth);
        }
    }
    downloads?.handleEvidenceTransition();
    if (native && offlinePins) { renderOfflineProgress(true); offlinePins.refresh().catch(logCatch('offline evidence')); }
    settings?.updateAuthAction(newState);
};

// Tree view + playback + favorites (singletons)

let tree: TreeView | undefined;
let playback: Playback | undefined;
let nativeLibraryGeneration = 0;
let nativePlayer: ReturnType<typeof attachNativePlayback> | undefined;
let favorites: Favorites | undefined;
let select: Select | undefined;
let downloads: Downloads | undefined;
let offlinePins: ReturnType<typeof createOfflinePins> | undefined;
let settings: SettingsView | undefined;
let timerDuration: TimerDuration = '30m';
let themePreference: ThemePreference = 'light';
let searchOpen = false;
let searchQuery = '';
let searchScrollTop = 0;
let searchDataVersion = 0;
let previousSearchRun:
    | {
        readonly query: string;
        readonly results: readonly SearchResult[];
        readonly capped: boolean;
        readonly dataVersion: number;
    }
    | undefined;

/** Root-folder data reference, shared with playback module for path resolution. */
const accountData = new Map<string, { folder: import('./indexer.js').MusicFolder; driveId: string }>();

let personalLibraryClosed = false;
const personalLocalWrites = new Set<Promise<void>>();

/** A retired personal document cannot recreate data after the sign-out purge. */
async function putPersonalLibraryData(key: string, value: unknown): Promise<void> {
    if (personalLibraryClosed) throw new DOMException('Personal library closed', 'AbortError');
    const write = dbPut(key, value);
    personalLocalWrites.add(write);
    try { await write; }
    finally { personalLocalWrites.delete(write); }
}

let shares: Shares | undefined;
interface TestHooksWindow extends Record<string, unknown> {
    _testSettingsAddShare?: (url: string, signal?: AbortSignal) => Promise<void> | void;
    _testSettingsRenameShare?: (id: string, name: string) => Promise<void> | void;
    _testSettingsRemoveShare?: (id: string) => Promise<void> | void;
    _testSettingsSignOut?: () => Promise<void> | void;
    _testSettingsReconnect?: () => Promise<void> | void;
    _testSettingsRefreshNow?: () => Promise<void> | void;
    _testSetLatestIndexFailure?: (failure?: { label?: string; message?: string }) => void;
    _testStartupOpeningWaitMs?: unknown;
}

const getTestHooksWindow = (): TestHooksWindow => window as unknown as TestHooksWindow;

type SearchReason = 'open' | 'query-change' | 'show-tree' | 'share-roots' | 'offline-state';

const startup = createIndexStartup({
    swDebug: SW_DEBUG,
    appVersionLabel: DEPLOY_COUNTER,
    getDebugEnabled: () => debugEnabled,
    getTestOpeningWaitMs: () => getTestHooksWindow()._testStartupOpeningWaitMs,
    onChooseOneDrive: () => { connectPersonal().catch(logCatch('connect OneDrive')); },
    onExploreDemo: () => { openDemoFromChooser().catch(logCatch('choose demo')); },
    onDemoWaiting: () => {
        demoSlow = true;
        startup.showLibraryChoices('Still opening the demo library…');
    },
    onSignIn: () => {
        signInAndRefreshLibrary().catch(logCatch('sign-in button'));
    },
});

const sync = createIndexSync({
    auth,
    oneDrive,
    canPull: () => localBootstrapComplete && workspace === 'personal',
    hasInstalledTree: startup.hasInstalledTree,
    accountData,
    getTree: () => tree,
    getPlayback: () => playback,
    onPlaybackRootsChange: () => {
        ++nativeLibraryGeneration;
        computeAndPushOfflineState();
        nativePlayer?.refreshLibraryQueue().catch(logCatch('queue refresh'));
        if (playback) {
            playback.refreshLibraryQueue().then(restorePlaybackState).catch(logCatch('browser queue refresh'));
            migrateBrowserFavoriteBookmarks().catch(logCatch('browser bookmark migration'));
        }
    },
    getFavorites: () => favorites,
    getSelect: () => select,
    getSettings: () => settings,
    getShares: () => shares,
    ensureFavorites: () => ensureFavorites(),
    ensureShares: () => ensureShares(),
    showTree: (info, data, reindexing = false) => showTree(info, data.folder, reindexing),
    showOpening: startup.showOpening,
    showSignIn: startup.showSignIn,
    showOpeningFailure: startup.showFailure,
    finishOpening: startup.showFailureIfUnresolved,
    showIndexProgress: startup.showIndexProgress,
    computeAndPushOfflineState: () => computeAndPushOfflineState(),
    invalidateSearchData: () => invalidateSearchData(),
    runSearchAndPushIntoTree: (reason) => runSearchAndPushIntoTree(reason),
});

function invalidateSearchData(): void {
    searchDataVersion++;
    previousSearchRun = undefined;
}

/** Runs the current search query and pushes results into tree search mode. */
function runSearchAndPushIntoTree(reason: SearchReason): void {
    if (!tree || !favorites || !searchOpen || !tree.isSearchModeOpen()) return;
    const roots = tree.getRoots();
    const snapshot = offlinePins?.getSnapshot();
    const downloadedTrackKeys = snapshot?.files ?? new Set<string>();
    const evidenceState = snapshot?.evidence ?? getLibraryEvidence();
    const deniedRootKeys = shares?.getDeniedRootKeys() ?? new Set<string>();

    const incrementalResult = reason === 'query-change' && previousSearchRun?.dataVersion === searchDataVersion
        ? runSearchIncrementalRefinement({
            previousQuery: previousSearchRun.query,
            query: searchQuery,
            previousResults: previousSearchRun.results,
            previousCapped: previousSearchRun.capped,
        })
        : undefined;

    const result = incrementalResult
        ? {
            results: incrementalResult.results,
            capped: false,
            elapsedMs: incrementalResult.elapsedMs,
        }
        : runSearchSingleWalk({
            roots,
            favorites,
            query: searchQuery,
            maxResults: 500,
            deniedRootKeys,
            evidenceState,
            downloadedTrackKeys,
        });
    tree.setSearchResults(result.results, result.capped);
    previousSearchRun = {
        query: searchQuery,
        results: result.results,
        capped: result.capped,
        dataVersion: searchDataVersion,
    };
    if (reason === 'query-change' && result.elapsedMs > 300) {
        log(`search: WARN slow-query elapsedMs=${result.elapsedMs} query=${JSON.stringify(searchQuery)}`);
    }
}

/** Applies runtime debug visibility to tree + service-worker reload gating. */
function setRuntimeDebugEnabled(next: boolean): void {
    debugEnabled = next;
    localStorage.setItem(profileKey('debug_enabled'), next ? '1' : '0');
    tree?.setDebugEnabled(SW_DEBUG && debugEnabled);
    nativePlayer?.setDebugEnabled(debugEnabled);
}

/** Exercise reconnect using the auth provider that owns the current account. */
async function simulateSignedOutForDebug(): Promise<void> {
    if (!debugEnabled) return;
    if (native) {
        try { await native.requireInteractiveReconnectForDebug(); }
        catch (error) {
            logCatch('debug: could not simulate reconnect')(error);
            showToastMessage('Could not simulate reconnect.');
        }
        return;
    }
    const stamp = new Date().toISOString();
    localStorage.setItem('access_token', `null: debug expired access_token ${stamp}`);
    localStorage.setItem('refresh_token', `null: debug expired refresh_token ${stamp}`);
    logError(`debug: expired browser credentials from Settings (${stamp})`);
    browserAuth!.transition('evidence:signed-out');
}

/** A Debug build can audition up to ten indexed MP3s starting at the current recording.
 * Swift owns the schedule after Play, including every Graph call made under lock. */
function showPlaybackTest(path?: readonly string[]): void {
    if (!native?.state.debugPlayback) return;
    const root = path && accountData.get(path[1]);
    const folder = path && resolveFolderFromPath(path.slice(0, -1), accountData);
    const names = folder ? sortedFolderChildren(folder)
        .filter(([name, isFolder]) => !isFolder && /\.mp3$/i.test(name)).map(([name]) => name) : [];
    const first = path ? names.indexOf(path[path.length - 1]) : -1;
    if (path && (!root || !folder || first < 0 || shares?.getDeniedRootKeys().has(path[1]))) {
        showToastMessage('Choose an MP3 in a OneDrive album folder.');
        return;
    }
    const tracks = root && folder ? names.slice(first, first + 10)
        .map(name => ({ driveId: root.driveId, itemId: folder.children[name].id })) : undefined;
    showModal(path ? `Test playback from ${names[first]}` : 'Playback tests', (modal, close) => {
        const add = (label: string, action: () => Promise<unknown>) => {
            const button = document.createElement('button');
            button.className = 'settings-pill';
            button.textContent = label;
            button.addEventListener('click', async () => {
                close();
                try { await action(); }
                catch (error) {
                    if (error instanceof Error && error.message === 'cancelled') return;
                    showToastMessage('Could not start the playback test.');
                    logError('Native playback test command failed');
                }
            });
            modal.appendChild(button);
        };
        if (tracks) {
            const play = (nearEnd: boolean, forceRefresh = false, delaySeconds = 0) =>
                native.playIndexed(tracks, nearEnd, forceRefresh, delaySeconds);
            add('Play from beginning', () => play(false));
            add('Play near first join', () => play(true));
            for (const delay of [0, 5, 10]) {
                add(delay ? `Force renewal, hold ${delay}s` : 'Force renewal now', () => play(true, true, delay));
            }
        } else if (nativePlayer?.currentPath()) {
            add('Test playing album…', async () => showPlaybackTest(nativePlayer?.currentPath()));
        }
        add('Playback status', async () => showToastMessage(await native.readPlaybackStatus()));
        add('Stop playback', native.stopPlayback);
    });
}

/** Interactive native sign-in returns to the same page. Cached navigation survives reconnect. */
async function signInAndRefreshLibrary(): Promise<void> {
    if (!native) return browserAuth!.signIn();
    const button = statusEl().querySelector<HTMLButtonElement>('button.signin-btn');
    if (button) button.disabled = true;
    try {
        await native.loadAccountState('signIn');
        await sync.requestPullFromOneDrive('settings-refresh');
        startup.showFailureIfUnresolved(localBootstrapComplete && auth.getEvidence() === 'evidence:not-online');
    } catch (error) {
        const outcome = error instanceof Error ? error.message : String(error);
        if (auth.getEvidence() === 'evidence:not-online') startup.showFailure(true);
        else startup.showSignIn();
        if (outcome !== 'cancelled') showToastMessage(outcome === 'wrongAccount'
            ? 'Reconnect with the OneDrive account used for this library.'
            : 'OneDrive sign-in failed. Please try again.');
    } finally {
        if (button) button.disabled = false;
    }
}

/** Demo evidence only gates its own media workers. OneDrive credentials are never consulted. */
function setDemoEvidence(next: EvidenceState): EvidenceState {
    if (demoEvidence !== next) {
        demoEvidence = next;
        downloads?.handleEvidenceTransition();
    }
    return demoEvidence;
}

/** Pause failed public downloads behind a bounded retry instead of spinning the download queue. */
function recoverDemoDownloadsLater(): EvidenceState {
    if (navigator.onLine && demoRetryTimer === undefined) {
        demoRetryTimer = setTimeout(() => {
            demoRetryTimer = undefined;
            if (!document.hidden) downloads?.handleEvidenceTransition();
        }, demoRetryDelay);
        demoRetryDelay = Math.min(demoRetryDelay * 2, 60_000);
    }
    return setDemoEvidence(navigator.onLine ? 'no-evidence' : 'evidence:not-online');
}

/** Install one committed snapshot. Reference healing may only infer absence from this tree. */
async function installDemoCatalog(next: DemoCatalog, signal: AbortSignal): Promise<void> {
    if (demoProjectionComplete && demoCatalog && JSON.stringify(demoCatalog.manifest) === JSON.stringify(next.manifest)) return;
    await ensureFavorites();
    signal.throwIfAborted();
    demoProjectionComplete = false;
    if (!demoCatalog || !startup.hasInstalledTree()
        || JSON.stringify(demoCatalog.manifest) !== JSON.stringify(next.manifest)) {
        demoCatalog = next;
        showTree(undefined, next.folder);
        settings?.updateDemoCredits(next.credits);
    } else next = demoCatalog;
    await favorites!.heal(tree!.getRoots(), new Map([[DEMO_SOURCE, next.folder]]));
    signal.throwIfAborted();
    ++nativeLibraryGeneration;
    await Promise.all([nativePlayer?.refreshLibraryQueue(), playback?.refreshLibraryQueue()]);
    signal.throwIfAborted();
    computeAndPushOfflineState();
    await restorePlaybackState();
    signal.throwIfAborted();
    demoProjectionComplete = true;
}

/** The bundled chooser fetches via Swift. Browser admission verifies the same local catalog. */
async function openDemoFromChooser(): Promise<void> {
    if (connecting || demoOpening && !demoSlow) return;
    demoWanted = true;
    if (demoOpening) {
        const previous = demoOpening;
        previous.controller.abort();
        native?.cancelDemoOpen(previous.id).catch(logCatch('supersede Demo opening'));
    }
    let finishAttempt!: () => void;
    const settled = new Promise<void>(resolve => { finishAttempt = resolve; });
    const attempt = {id: crypto.randomUUID(), controller: new AbortController(), settled, recoverIfFailed: false};
    const {signal} = attempt.controller;
    demoOpening = attempt;
    demoSlow = false;
    startup.showLibraryChoices('Opening the demo library…', true);
    let confirmedCacheMiss = false;
    let failed = false;
    try {
        if (native && !isDemo()) {
            await native.openDemo(attempt.id, statusEl().contains(document.activeElement));
            return; // Swift has admitted the Demo store and will replace the chooser.
        }
        let cached: DemoCatalog | undefined;
        try {
            const value = native ? await native.demoCatalog(false) : await demoDb.dbGet<unknown>(DEMO_CATALOG_KEY);
            signal.throwIfAborted();
            confirmedCacheMiss = value == null;
            if (!confirmedCacheMiss) cached = parseDemoCatalog(value);
        } catch (readError) {
            if (signal.aborted || isOffline()) throw readError;
            logCatch('read cached demo catalog')(readError);
        }
        if (!cached && isOffline()) {
            failed = true;
            startup.showLibraryChoices('The demo library needs an internet connection to open.');
            return;
        }
        const next = cached ?? (native ? parseDemoCatalog(await native.demoCatalog(true)) : await fetchDemoCatalog(signal));
        confirmedCacheMiss = false;
        signal.throwIfAborted();
        if (!native && !cached) await demoDb.dbPut(DEMO_CATALOG_KEY, next.manifest);
        signal.throwIfAborted();
        if (!isDemo()) {
            localStorage.setItem(DEMO_SELECTION, '1');
            if (statusEl().contains(document.activeElement)) sessionStorage.setItem(DEMO_FOCUS, '1');
            location.reload();
            return;
        }
        await installDemoCatalog(next, signal);
        signal.throwIfAborted();
        if (cached && !isOffline()) refreshDemoCatalog().catch(logCatch('demo startup refresh'));
    } catch (error) {
        if (signal.aborted) return;
        logCatch('open demo catalog')(error);
        if (startup.hasInstalledTree()) {
            refreshDemoCatalog().catch(logCatch('finish demo projection'));
            return;
        }
        failed = true;
        startup.showLibraryChoices((confirmedCacheMiss && isOffline()) || (error instanceof Error && error.message === 'unavailableOffline')
            ? 'The demo library needs an internet connection to open.' : DEMO_LOAD_FAILURE);
    } finally {
        if (demoOpening === attempt) {
            demoOpening = undefined;
            if (failed && attempt.recoverIfFailed && !isOffline()) resumeDemoOrChooser();
        }
        finishAttempt();
    }
}

/** Startup and recovery share revalidation and keep the last admitted tree on failure. */
function refreshDemoCatalog(): Promise<void> {
    if (demoRefresh) return demoRefresh;
    const signal = demoPage.signal;
    if (demoOpening) return demoOpening.settled.then(
        () => signal.aborted ? undefined : refreshDemoCatalog(),
    );
    clearTimeout(catalogRetryTimer);
    catalogRetryTimer = undefined;
    demoRefresh = (async () => {
        // Retry local healing and restoration before network revalidation.
        if (demoCatalog && !demoProjectionComplete) {
            try { await installDemoCatalog(demoCatalog, signal); }
            catch (error) { if (!signal.aborted) logCatch('finish cached demo projection')(error); }
        }
        try {
            if (signal.aborted || isOffline()) return;
            const next = native ? parseDemoCatalog(await native.demoCatalog(true)) : await fetchDemoCatalog(signal);
            signal.throwIfAborted();
            if (!native && JSON.stringify(demoCatalog?.manifest) !== JSON.stringify(next.manifest)) {
                await demoDb.dbPut(DEMO_CATALOG_KEY, next.manifest);
                signal.throwIfAborted();
            }
            await installDemoCatalog(next, signal);
            signal.throwIfAborted();
            catalogRetryDelay = 4_000;
        } catch (error) {
            if (signal.aborted) return;
            logCatch('refresh demo catalog')(error);
            if (!document.hidden && !isOffline() && isDemo()) {
                catalogRetryTimer = setTimeout(() => {
                    catalogRetryTimer = undefined;
                    if (!document.hidden && !isOffline() && !connecting) refreshDemoCatalog().catch(logCatch('retry demo refresh'));
                }, catalogRetryDelay);
                catalogRetryDelay = Math.min(catalogRetryDelay * 2, 60_000);
            }
        }
    })().finally(() => {
        if (demoPage.signal === signal) demoRefresh = undefined;
    });
    return demoRefresh;
}

function isOffline(): boolean {
    return native ? native.getEvidence() === 'evidence:not-online' : !navigator.onLine;
}

/** Keep the initiating screen on cancel. A Connect click owns chooser selection before OAuth starts. */
async function connectPersonal(): Promise<void> {
    if (connecting) return;
    connecting = true;
    startup.showLibraryChoices();
    startup.setOneDriveConnecting(true);
    try {
        demoWanted = false;
        const previous = demoOpening;
        previous?.controller.abort();
        demoOpening = undefined;
        if (native && previous) await native.cancelDemoOpen(previous.id);
        if (isOffline()) {
            startup.showLibraryChoices('Connect to the internet to sign in to OneDrive.');
            return;
        }
        if (!native) {
            sessionStorage.setItem(CONNECT_ORIGIN, 'chooser');
            await browserAuth!.signIn();
            return; // Navigation or its Back restoration owns the next outcome.
        }
        // Microsoft can dismiss its sheet before MSAL returns the grant. Present the
        // indexing screen before calling the bridge, and let the pending sign-in finish.
        startup.showIndexProgress();
        await native.loadAccountState('signIn');
        workspace = 'personal';
        startup.startOpeningWait();
        await ensureFavorites();
        await ensureShares();
        localBootstrapComplete = true;
        await sync.requestPullFromOneDrive('settings-refresh');
    } catch (error) {
        sessionStorage.removeItem(CONNECT_ORIGIN);
        const reason = error instanceof Error ? error.message : String(error);
        if (workspace === 'personal' || reason === 'libraryOpeningFailed') {
            workspace = 'personal';
            logCatch('open OneDrive library')(error);
            startup.showOpening();
            startup.showFailure(isOffline());
            return;
        }
        if (reason === 'detached') return;
        startup.showLibraryChoices(reason === 'cancelled' ? '' : isOffline()
            ? 'Connect to the internet to sign in to OneDrive.' : 'Couldn’t connect to OneDrive.', false, true);
    } finally {
        if (native || !sessionStorage.getItem(CONNECT_ORIGIN)) {
            connecting = false;
            startup.setOneDriveConnecting(false);
        }
    }
}

/** A cached PWA document can be restored after a top-level OAuth navigation. */
function resumeDemoOrChooser(): void {
    if (connecting || demoPage.signal.aborted) return;
    if (isDemo() && !native) {
        if (!navigator.onLine) setDemoEvidence('evidence:not-online');
        else if (demoEvidence === 'evidence:not-online') setDemoEvidence('no-evidence');
        else downloads?.handleEvidenceTransition();
    }
    if (!startup.hasInstalledTree()) {
        if (!demoWanted) return;
        if (demoOpening) demoOpening.recoverIfFailed ||= !isOffline();
        else openDemoFromChooser().catch(logCatch('resume demo opening'));
    } else if (isDemo() && !demoOpening && (!isOffline() || !demoProjectionComplete)) {
        refreshDemoCatalog().catch(logCatch('resume demo library'));
    }
}

/** Shows the settings page and keeps tree state untouched for exact restore on close. */
function openSettingsPage(): void {
    if (!settings) return;
    const treeEl = document.getElementById('tree-container')!;
    const settingsEl = document.getElementById('settings-container')!;
    const hooks = getTestHooksWindow();
    treeEl.hidden = true;
    settingsEl.hidden = false;
    settings.open({
        demo: isDemo() ? {
            creditsHref: demoCatalog?.credits,
            openNativeCredits: native ? () => { native.openDemoCredits().catch(logCatch('open demo credits')); } : undefined,
        } : undefined,
        onOpenInfoPage: native ? file => { native.openInfoPage(file).catch(logCatch('open app information')); } : undefined,
        evidence: getLibraryEvidence(),
        timerDuration,
        debugEnabled,
        lastIndexUpdatedAt: sync.getLastIndexUpdatedAt(),
        shareRows: sync.buildSettingsShareRows(),
        onClose: closeSettingsPage,
        onSignOut: async () => {
            if (typeof hooks._testSettingsSignOut === 'function') {
                await Promise.resolve(hooks._testSettingsSignOut());
                return;
            }
            if (native) { await native.signOut(themePreference); return; }
            const footer = document.getElementById('footer')!;
            treeEl.inert = footer.inert = true;
            try {
                if (isDemo()) {
                    playback?.pauseAndCheckpoint();
                    localStorage.removeItem(DEMO_SELECTION);
                    demoPage.abort();
                } else await browserAuth!.signOut(async () => {
                    localBootstrapComplete = false;
                    playback?.stop();
                    personalLibraryClosed = true;
                    await sync.drainPullsAfterAdmissionCloses();
                    await favorites?.whenLocalWritesComplete();
                    await Promise.allSettled(personalLocalWrites);
                    await downloads?.clear();
                    await dbClear();
                    localStorage.removeItem('account_info');
                    localStorage.removeItem(DEMO_SELECTION);
                    clearM10State();
                });
                try { sessionStorage.setItem(SIGNOUT_FOCUS, '1'); } catch { /* focus is best-effort */ }
                location.reload();
            } catch (error) {
                treeEl.inert = footer.inert = false;
                if (!isDemo()) {
                    localBootstrapComplete = true;
                    personalLibraryClosed = false;
                }
                throw error;
            }
        },
        onReconnect: () => {
            if (typeof hooks._testSettingsReconnect === 'function') return hooks._testSettingsReconnect();
            return signInAndRefreshLibrary();
        },
        onRefreshNow: () => {
            if (typeof hooks._testSettingsRefreshNow === 'function') return hooks._testSettingsRefreshNow();
            return sync.requestPullFromOneDrive('settings-refresh');
        },
        onAddShare: async (url, signal) => {
            log('settings:add-share clicked');
            if (typeof hooks._testSettingsAddShare === 'function') {
                try {
                    await Promise.resolve(hooks._testSettingsAddShare(url, signal));
                    log('settings:add-share completed via test hook');
                    return;
                } catch (e) {
                    if (signal?.aborted || isAbortError(e)) {
                        log('settings:add-share aborted via test hook');
                    } else {
                        logError('settings:add-share failed via test hook');
                    }
                    throw e;
                }
            }
            if (!shares) return;
            try {
                const record = await shares.addFromUrl(url, signal);
                sync.onShareAdded(record);
                sync.requestPullFromOneDrive('settings-refresh').catch(logCatch('settings add share pull'));
                log('settings:add-share success');
            } catch (e) {
                if (signal?.aborted || isAbortError(e)) {
                    log('settings:add-share aborted');
                } else {
                    logError('settings:add-share failed');
                }
                throw e;
            }
        },
        onRenameShare: async (id, nextName) => {
            if (typeof hooks._testSettingsRenameShare === 'function') {
                await Promise.resolve(hooks._testSettingsRenameShare(id, nextName));
                return;
            }
            if (!shares) return;
            await shares.rename(id, nextName);
        },
        onRemoveShare: async (id) => {
            if (typeof hooks._testSettingsRemoveShare === 'function') {
                await Promise.resolve(hooks._testSettingsRemoveShare(id));
                return;
            }
            if (!shares) return;
            const record = shares.getAll().find(s => s.id === id);
            if (!record) return;
            // Persist the removed connection's pins and favorite references before
            // withdrawing access. A failed write leaves this share available for retry.
            await favorites?.heal(tree?.getRoots() ?? new Map(), new Map(), record);
            try { await shares.remove(id); }
            finally { await sync.onShareRemoved(record); }
        },
        onTimerChange: (next) => {
            timerDuration = next;
            localStorage.setItem(profileKey('timer_duration'), next);
            playback?.setTimerDuration(next);
            nativePlayer?.setTimer(next);
        },
        onThemeChange: (next) => {
            themePreference = next;
            localStorage.setItem('oneplay_music_theme', next);
            applyTheme();
            native?.saveDeviceTheme(next).catch(logCatch('save device theme'));
        },
        onOpenPlaybackTests: native?.state.debugPlayback ? () => showPlaybackTest() : undefined,
        theme: themePreference,
        onDebugExpire: simulateSignedOutForDebug,
        onDebugToggle: (next) => setRuntimeDebugEnabled(next),
    });
    if (!isDemo()) sync.updateSettingsIndexSection();
}

/** Closes settings and restores tree visibility without touching selectedPath or scroll state. */
function closeSettingsPage(): void {
    if (!settings) return;
    settings.close();
    document.getElementById('settings-container')!.hidden = true;
    document.getElementById('tree-container')!.hidden = false;
}

/** Give foreground browsing precedence over pending Play and keep both players using the same drawer policy. */
function collapseDrawerForBrowsing(): void {
    (playback ?? nativePlayer)?.collapse();
}

/**
 * Switches the UI from status/sign-in view to the tree view.
 * Creates the tree and playback components on first call; updates data on subsequent calls.
 */
function showTree(info: AccountInfo | undefined, folder: MusicFolder, reindexing = false): void {
    const firstInstall = !startup.hasInstalledTree();
    const status = statusEl();
    const moveFocus = !!demoFocusOnTree || status.contains(document.activeElement);
    const settingsOpen = settings?.isOpen() ?? false;
    status.hidden = true;
    // Breadcrumb measurement and scroll restoration require a layout-visible tree.
    document.getElementById('tree-container')!.hidden = settingsOpen;
    document.getElementById('settings-container')!.hidden = !settingsOpen;
    try {
        wireAndRenderTree(info, folder, reindexing);
    } catch (error) {
        if (firstInstall) {
            localBootstrapComplete = false;
            startup.showFailure(false, moveFocus);
        }
        throw error;
    }
    if (firstInstall) {
        document.getElementById('footer')!.hidden = false;
        startup.recordTreeInstalled(moveFocus);
        demoFocusOnTree = false;
        nativePlayer?.refreshLibraryQueue().catch(logCatch('initial native library projection'));
    }
}

/** Wire the tree once, then install the primary account and the cached projection. */
function wireAndRenderTree(info: AccountInfo | undefined, folder: MusicFolder, reindexing: boolean): void {
    let attachNativePlayer: (() => void) | undefined;
    // Update root-folder references for playback path resolution.
    const driveId = info?.driveId ?? DEMO_SOURCE;
    accountData.set(driveId, { folder, driveId });

    if (!tree) {
        const treeEl = document.getElementById('tree-container')!;
        const settingsEl = document.getElementById('settings-container')!;
        tree = createTree(treeEl, viewState.path, restoredScroll,
            SW_DEBUG ? DEPLOY_COUNTER : '', scroll => {
                if (!personalLibraryClosed) localStorage.setItem(profileKey('scroll'), JSON.stringify(scroll));
            });
        settings = createSettings(settingsEl);
        const saveView = (next: typeof viewState): void => {
            viewState = next;
            if (personalLibraryClosed) return;
            try { localStorage.setItem(profileKey('view'), JSON.stringify(viewState)); } catch { /* quota */ }
        };
        const drawer: DrawerView = {
            initial: viewState,
            onStateChange: state => saveView({...state, path: tree!.getSelectedPath()}),
            captureMarkerReveal: tree.captureMarkerReveal,
            coveredViews: {tree: treeEl, settings: settingsEl},
        };
        if (browserAuth) {
            const storageKey = (key: string) => isDemo() ? 'demo_' + key : key;
            playback = createPlayback(
                document.getElementById('player') as HTMLAudioElement,
                document.getElementById('footer')!,
                (isDemo() ? demoMedia : oneDrive.media).playbackUrl,
                isDemo() ? undefined : migrateBrowserFavoriteBookmarks,
                {
                    getItem: key => localStorage.getItem(storageKey(key)),
                    setItem: (key, value) => {
                        if (!personalLibraryClosed) localStorage.setItem(storageKey(key), value);
                    },
                    removeItem: key => {
                        if (!personalLibraryClosed) localStorage.removeItem(storageKey(key));
                    },
                },
                isDemo() ? demoDb : {dbGet, dbPut: putPersonalLibraryData},
                drawer,
            );
            playback.setTimerDuration(timerDuration);

            tree.onTrackClick = path => {
                restoredPlayback = undefined;
                return playback!.playTrack(path, accountData).catch(logCatch('playTrack'));
            };
            tree.onPlayClick = path => {
                restoredPlayback = undefined;
                return playback!.playFolder(path, accountData).catch(logCatch('playFolder'));
            };
            playback.onPlaybackChange = tree.setPlaybackInfo;
            playback.onPlayBlockedNoPlayableTracks = () => {
                alert('No offline tracks are available here.');
            };
            playback.onChevronClick = () => {
                const info = playback!.getInfo();
                if (!info) return;
                if (settings?.isOpen()) closeSettingsPage();
                tree!.revealTrack(info.track);
            };
        } else if (native) {
            const denied = () => shares?.getDeniedRootKeys() ?? new Set<string>();
            const describe = (folder: readonly string[], key?: string) =>
                favorites && (!folder[1]?.startsWith('fav:') || favorites.hasLoadedMembership?.())
                    ? buildLibraryQueue(folder, new Map(tree!.getRoots()), [...favorites.getAll()], denied(), key, !!shares?.hasLoadedMembership?.())
                    : undefined;
            const favoriteSettings = (folder: readonly string[]) => {
                const favorite = favorites?.getAll().find(f => folder[1] === 'fav:' + f.id);
                return {favorite: favorite?.hasPrivatePlayback ? favorite.id : undefined, mode: favorite?.mode};
            };
            // Old bundled installations may have path-only positions in either store. Resolve
            // them before a playlist edit can reuse a row. Swift accepts only the first import.
            const migrated = new Set<string>();
            const migratePrivateSpots = async (only?: string) => {
                for (const favorite of favorites?.getAll() ?? []) {
                    if (migrated.has(favorite.id) || (only && only !== favorite.id)) continue;
                    try {
                        const key = 'oneplay_music_fav:' + favorite.id;
                        let saved = parseFavoritePlaybackStorageValue(localStorage.getItem(key));
                        if (!saved) {
                            const old = await dbGet<{trackPath?: string[]; currentTime?: number}>('playback:' + favorite.id);
                            if (Array.isArray(old?.trackPath)) saved = {track: old.trackPath, time: Number.isSafeInteger(Math.round(Number(old.currentTime) * 44100)) ? Math.max(0, Number(old.currentTime)) : 0};
                        }
                        if (saved && saved.track[1] === 'fav:' + favorite.id) {
                            const queue = await describe(saved.track.slice(0, 2), '');
                            const entry = queue?.tracks.find(t => t.path.length === saved!.track.length && t.path.every((v, i) => v === saved!.track[i]));
                            if (!queue) continue;
                            if (entry) await native.playback('importSpot', {favorite: favorite.id, spot: {folder: queue.folder, folderKey: queue.folderKey,
                                path: entry.path, key: entry.key, seconds: saved.time}});
                            await dbDelete('playback:' + favorite.id);
                            localStorage.removeItem(key);
                        }
                        migrated.add(favorite.id);
                    } catch (error) { logCatch('playback:legacy favorite')(error); }
                }
            };
            attachNativePlayer = () => {
                nativePlayer = attachNativePlayback(native, document.getElementById('footer')!,
                    tree!.setPlaybackInfo, path => {
                        if (settings?.isOpen()) closeSettingsPage();
                        tree!.revealTrack(path);
                    }, showToastMessage, drawer, describe, () => !isDemo() && shares?.hasLoadedMembership?.() ? shares.getAll().map(s => s.rootKey) : undefined, async (folder, mode) => {
                        const favorite = favorites?.getAll().find(f => folder[1] === 'fav:' + f.id);
                        if (favorite) await favorites!.setMode(favorite.id, mode);
                    }, favoriteSettings, isDemo() ? async () => {} : migratePrivateSpots, () => !isDemo() && restoredPlayback && Array.isArray(restoredPlayback.folder)
                        && Array.isArray(restoredPlayback.track) ? {folder: restoredPlayback.folder, track: restoredPlayback.track,
                            seconds: Number.isFinite(restoredTime) && restoredTime! > 0 ? restoredTime! : 0,
                            mode: isValidMode(restoredPlayback.mode) ? restoredPlayback.mode : 'all', timer: timerDuration,
                            consume: () => {
                                restoredPlayback = undefined;
                                localStorage.removeItem(profileKey('playback'));
                                localStorage.removeItem(profileKey('time'));
                            }} : undefined);
            };
            let selection = 0;
            const playAlbum = async (folderPath: readonly string[], trackPath?: readonly string[]) => {
                const intent = ++selection;
                nativePlayer!.beginSelection();
                let generation = nativeLibraryGeneration;
                let queue = await describe(folderPath);
                let index = trackPath ? queue?.tracks.findIndex(t =>
                    t.path.length === trackPath.length && t.path.every((part, i) => part === trackPath[i])) : 0;
                const tappedKey = trackPath && index !== undefined ? queue?.tracks[index]?.key : undefined;
                // Keep the identity from the tapped tree even if its row moves during a large walk.
                while (intent === selection && queue && generation !== nativeLibraryGeneration) {
                    generation = nativeLibraryGeneration;
                    queue = await describe(queue.folder, queue.folderKey);
                    index = trackPath ? queue?.tracks.findIndex(t => t.key === tappedKey) : 0;
                }
                if (intent !== selection) return;
                if (!queue || index === undefined || !queue.tracks[index]) {
                    showToastMessage('No playable tracks in this folder.');
                    await nativePlayer!.cancelSelection();
                    return;
                }
                await nativePlayer!.start(queue, index, !!trackPath, timerDuration);
            };
            tree.onTrackClick = path => {
                const folder = nativePlayer!.currentFolder();
                return playAlbum(folder?.length && folder.every((part, i) => part === path[i]) ? folder : path.slice(0, -1), path);
            };
            tree.onPlayClick = path => playAlbum(path);
        }

        tree.onPathChange = path => saveView({...viewState, path});
        tree.onBrowse = collapseDrawerForBrowsing;
        tree.onFavoriteRootTap = () => showFavoriteCustomizeToastOnce();
        tree.onSettingsClick = tree.onShareWithoutDataTap = () => {
            collapseDrawerForBrowsing();
            openSettingsPage();
        };
        tree.onSearchOpen = () => {
            if (select?.isActive()) select.exitSelectMode();
            collapseDrawerForBrowsing();
            searchOpen = true;
            tree!.openSearchMode(searchQuery, searchScrollTop);
            runSearchAndPushIntoTree('open');
        };
        tree.onSearchClose = (query, scrollTop) => {
            searchOpen = false;
            searchQuery = query;
            searchScrollTop = scrollTop;
            select?.exitSelectMode();
        };
        tree.onSearchQueryChange = (query) => {
            searchQuery = query;
            searchScrollTop = 0;
            select?.exitSelectMode();
            runSearchAndPushIntoTree('query-change');
        };
        tree.onSearchResultClick = (result: SearchResult) => {
            if (result.kind !== 'track') collapseDrawerForBrowsing();
            tree!.closeSearchMode();
            if (result.kind === 'track') {
                // Search opens the parent at its normal offset. The footer chevron explicitly reveals the row.
                tree!.setSelectedPath(result.path.slice(0, -1));
                tree!.onTrackClick(result.path);
                return;
            }
            tree!.setSelectedPath(result.path);
        };
        (window as unknown as TestHooksWindow)._testSetLatestIndexFailure = (failure) => {
            if (!failure) {
                sync.clearLatestIndexFailureIntoRuntimeStateAndPushUi();
                return;
            }
            const label = typeof failure.label === 'string' && failure.label.trim()
                ? failure.label
                : 'OneDrive';
            const message = typeof failure.message === 'string' && failure.message.trim()
                ? failure.message
                : 'Unknown error';
            sync.setLatestIndexFailureFromMessageAndPushUi(label, message);
        };
        (window as unknown as Record<string, unknown>)._testSettings = settings;
        (window as unknown as Record<string, unknown>)._testTree = tree;
    }
    tree.setIndexFailureWarning(sync.hasLatestIndexFailure());
    tree.setDebugEnabled(SW_DEBUG && debugEnabled);
    playback?.setTimerDuration(timerDuration);
    if (info) {
        tree.setAccount(info.driveId, folder, info, reindexing);
        sync.syncShareRootsIntoTreeAndPlayback();
    } else tree.setDemoRoot(folder, DEMO_SOURCE);

    // Wire favorites to tree + create select/downloads (idempotent).
    // Runs on every showTree since roots may have changed after setAccount.
    wireFavoritesUi();
    computeAndPushOfflineState();
    invalidateSearchData();
    runSearchAndPushIntoTree('show-tree');
    // The first playback snapshot can revise the live queue. Attach only once
    // the account, share and favorite projection has rendered and controls work.
    attachNativePlayer?.();
    nativePlayer?.setDebugEnabled(debugEnabled);
}

// Offline state orchestration

let prevIconsJson = '';
let prevEvidence: EvidenceState = 'no-evidence';

/** Progress notifications read cached owner counts. Rebuilding the badge maps from those
 * counts keeps shared ancestors accurate across edits, denial and quota changes. With 50
 * album pins and 500 downloads the full callback took 0.1 ms at the median in Chromium. */
function renderOfflineProgress(filesChanged: boolean): void {
    if (!offlinePins || !tree || !favorites) return;
    const snap = offlinePins.getSnapshot();
    const roots = tree.getRoots();
    const denied = shares?.getDeniedRootKeys() ?? new Set<string>();
    const stateFor = (id: string, paused: boolean) => classifyOfflineBadgeState(offlinePins!.favoriteProgress(id), snap, paused);
    type BadgeState = ReturnType<typeof stateFor>;
    const favoritesIcons = new Map<string, BadgeState>();
    const folderIcons = new Map<string, {partial: boolean; state: BadgeState}>();
    for (const favorite of favorites.getAll()) {
        if (favorite.offlinePin) favoritesIcons.set(favorite.id, stateFor(favorite.id, favorite.offlinePin.paused));
    }
    for (const [path, branch] of offlinePins.getFolderCoverage()) {
        let state: BadgeState = 'complete';
        for (const id of branch.owners) {
            const owner = stateFor(id, branch.blocked);
            if (owner === 'downloading') { state = owner; break; }
            if (owner === 'paused') state = owner;
        }
        folderIcons.set(path, {partial:branch.partial, state});
    }
    const limited = snap.evidence === 'evidence:not-online' || snap.evidence === 'evidence:signed-out';
    const repaint = prevEvidence !== snap.evidence || (limited && filesChanged);
    const isCached = (path: readonly string[]) => {
        const ids = resolveTrackIds(path, accountData, favorites!, roots);
        return !!ids && snap.files.has(ids.driveId + ':' + ids.itemId);
    };
    tree.setEvidence(snap.evidence, isCached);
    playback?.setAvailabilityContext(snap.evidence, isCached,
        path => isPathDeniedByShare(path, denied, roots),
        entry => snap.files.has(entry.driveId + ':' + entry.itemId));
    const signature = JSON.stringify([[...favoritesIcons], [...folderIcons]]);
    tree.setOfflineIcons(favoritesIcons, folderIcons);
    if (signature !== prevIconsJson) select?.refreshFolderActions();
    if (repaint || prevIconsJson !== signature) tree.render();
    prevIconsJson = signature;
    prevEvidence = snap.evidence;
    if (repaint) { invalidateSearchData(); runSearchAndPushIntoTree('offline-state'); }
    select?.updateOfflineModal();
}

/** A committed pin or new source index starts background reconciliation on either player. */
function computeAndPushOfflineState(): void {
    if (personalLibraryClosed || !tree || !favorites) return;
    offlinePins?.publishOwners(favorites.getAll(), favorites.getFolderPins(), tree.getRoots(),
        new Set(shares?.getDeniedRootKeys()), favorites.hasLoadedMembership?.() === true,
        shares?.hasLoadedMembership?.() === true).catch(logCatch('offline pin membership'));
}

// Favorites wiring

let ensureFavoritesPromise: Promise<void> | undefined;
async function ensureFavorites(): Promise<void> {
    if (ensureFavoritesPromise) return ensureFavoritesPromise;

    ensureFavoritesPromise = (async () => {
        const publishFavorites = async () => {
            // onChange: sync favorite roots into tree and re-render
            if (tree && startup.hasInstalledTree()) {
                ++nativeLibraryGeneration;
                tree.setFavorites(favorites!);
                select?.setRoots(tree.getRoots());
                playback?.setContext(favorites!, tree.getRoots(), shares?.getDeniedRootKeys(), shares?.hasLoadedMembership?.());
                computeAndPushOfflineState();
                await Promise.all([
                    nativePlayer?.refreshLibraryQueue(true),
                    playback?.refreshLibraryQueue(true).then(restorePlaybackState),
                ]);
            }
        };
        favorites = createFavorites({documents: isDemo() ? undefined : oneDrive.documents,
            dbGet: isDemo() ? demoDb.dbGet : dbGet, dbPut: isDemo() ? demoDb.dbPut : putPersonalLibraryData, fenceQueueEdit: async () => {
            if (!startup.hasInstalledTree()) return;
            ++nativeLibraryGeneration;
            return playback ? playback.fenceQueueEdit() : nativePlayer?.fenceQueueEdit();
        }}, origin => {
            // Both players already show their accepted pick. Its saved starting preference
            // has no effect on queue membership, folder badges or a live playback session.
            if (origin === 'mode') return;
            // Pin membership can commit while playback is waiting for an unrelated source index.
            if (origin === 'pins') return startup.hasInstalledTree() ? computeAndPushOfflineState() : undefined;
            const published = publishFavorites();
            // A remote edit may reference a share whose index this same sync still has to load.
            // Keep its tree publication pending while the sync proceeds with that prerequisite.
            if (origin === 'sync' && (nativePlayer || playback)) { published.catch(logCatch('publish synced favorite')); return; }
            return published;
        });

        await favorites.loadFromCache();
    })().catch(error => { ensureFavoritesPromise = undefined; throw error; });

    return ensureFavoritesPromise;
}

let ensureSharesPromise: Promise<void> | undefined;
async function ensureShares(): Promise<void> {
    if (ensureSharesPromise) return ensureSharesPromise;

    ensureSharesPromise = (async () => {
        shares = createShares({ documents: oneDrive.documents, oneDrive, dbGet, dbPut: putPersonalLibraryData,
            onDisconnect: native?.syncPlaybackMembership, beginSourceProbe: native?.beginSourceProbe,
            readPlaybackDenials: native?.readPlaybackDenials }, () => {
            sync.syncShareRootsIntoTreeAndPlayback();
            sync.updateSettingsIndexSection();
            if (settings?.isOpen()) openSettingsPage();
        });
        (window as unknown as Record<string, unknown>)._testShares = shares;
        await shares.loadFromCache();
        await sync.loadShareIndexesFromCacheIntoState();
    })();

    return ensureSharesPromise;
}

function wireFavoritesUi(): void {
    if (!favorites || !tree) return;

    // Always re-sync (roots may have changed after setAccount)
    tree.setFavorites(favorites);
    if (playback) playback.setContext(favorites, tree.getRoots(), shares?.getDeniedRootKeys(), shares?.hasLoadedMembership?.());
    if (select) select.setRoots(tree.getRoots());

    // Wire the select module (once, after tree + playback + favorites exist)
    if (!select) {
        const treeEl = document.getElementById('tree-container')!;
        const actionBarEl = document.getElementById('action-bar')!;
        const cancelBtnEl = document.getElementById('select-cancel')!;

        select = createSelect(treeEl, actionBarEl, cancelBtnEl, favorites, tree, tree.getRoots());
        select.onFavoriteSaveError = message => {
            if (!personalLibraryClosed) showToastMessage(message);
        };

        select.onEnterSelect = () => {
            collapseDrawerForBrowsing();
            document.body.classList.add('select-mode');
            treeEl.querySelector<HTMLInputElement>('.search-input:focus')?.blur();
        };
        select.onExitSelect = () => {
            document.body.classList.remove('select-mode');
        };
        select.onNavigateToFav = async (favId) => {
            const el = document.getElementById('tree-container')!;
            el.style.opacity = '0';
            await new Promise<void>(r => el.addEventListener('transitionend', () => r(), { once: true }));
            tree!.setSelectedPath(['OnePlay Music', `fav:${favId}`]);
            el.style.opacity = '';
        };

        tree.onSelectToggle = (path) => {
            select!.toggle(path);
            tree!.setSelectMode(select!.isActive(), select!.getSelectedPaths());
        };
        tree.onSelectExit = () => select!.exitSelectMode();

        // Expose test-only globals for integration tests (page.evaluate access).
        // INVARIANT: only used from test harnesses, never from production code.
        (window as unknown as Record<string, unknown>)._testFavorites = favorites;
        (window as unknown as Record<string, unknown>)._testTreeRoots = tree.getRoots();
        (window as unknown as Record<string, unknown>)._testAuth = auth;
        (window as unknown as Record<string, unknown>)._testPlayback = playback;
    }

    // Initialize downloads module (once, after favorites + tree + playback + select)
    if (!downloads && browserAuth) {
        downloads = createDownloads({
            ...(isDemo() ? {
                audioPut: demoDb.audioPut, audioGet: demoDb.audioGet, audioFileSizes: demoDb.audioFileSizes,
                audioDeleteBatch: demoDb.audioDeleteBatch, audioClear: demoDb.audioClear,
                canTransfer: () => navigator.onLine && !demoPage.signal.aborted && demoRetryTimer === undefined,
                loadQuotaBytes: () => Number(localStorage.getItem(profileKey('quota_bytes'))) || 1 << 30,
                saveQuotaBytes: (bytes: number) => {
                    try { localStorage.setItem(profileKey('quota_bytes'), String(bytes)); } catch { /* quota */ }
                },
            } : {}),
            download: isDemo() ? async (drive, item, signal) => {
                try {
                    const blob = await demoMedia.download(drive, item, signal);
                    if (!signal.aborted && demoRetryTimer === undefined && navigator.onLine) {
                        demoRetryDelay = 4_000;
                        setDemoEvidence('evidence:signed-in');
                    }
                    return blob;
                } catch (error) {
                    if (signal.aborted || error instanceof MediaUnavailableError) throw error;
                    if (error instanceof ProviderHttpError && (error.status === 404 || error.status === 410)) {
                        throw new MediaUnavailableError('Demo recording is unavailable');
                    }
                    throw new MediaTransientError('Demo media request failed', {cause: error});
                }
            } : oneDrive.media.download,
            getEvidence: getLibraryEvidence,
            provideEvidenceFromHttpStatus: (status, reason) => isDemo()
                ? recoverDemoDownloadsLater() : browserAuth.provideEvidenceFromHttpStatus(status, reason),
            provideEvidenceFromError: (error, reason) => isDemo()
                ? recoverDemoDownloadsLater() : browserAuth.provideEvidenceFromError(error, reason),
        });
        playback!.setDownloads(downloads);
        (window as unknown as Record<string, unknown>)._testDownloads = downloads;
    }
    const backend = native ?? downloads;
    if (!offlinePins && backend) {
        offlinePins = createOfflinePins(backend, renderOfflineProgress);
        select.setDownloads(offlinePins);
        if (native) offlinePins.refresh().catch(logCatch('offline inventory'));
    }
}

// M10: Restore playback visual state

/** Resolve a path-only bookmark against the favorite membership first loaded on this device.
 * Keep that membership while an unresolved share index loads, even if sync moves its rows. */
let bookmarkLibrary: readonly Favorite[] | undefined;
let legacyFavoriteIds: Promise<Set<string>> | undefined;

async function migrateBrowserFavoriteBookmarks(only?: string): Promise<void> {
    if (isDemo() || !playback || !tree || personalLibraryClosed || !favorites?.hasLoadedMembership?.()) return;
    bookmarkLibrary ??= [...favorites.getAll()];
    const roots = new Map(tree.getRoots());
    legacyFavoriteIds ??= dbKeysWithPrefix('playback:').then(keys => new Set([
        ...keys.map(key => key.slice('playback:'.length)),
        ...Object.keys(localStorage).filter(key => key.startsWith('oneplay_music_fav:')).map(key => key.slice('oneplay_music_fav:'.length)),
    ])).catch(error => { legacyFavoriteIds = undefined; throw error; });
    const pending = await legacyFavoriteIds;
    if (!pending.size) return;
    for (const fav of bookmarkLibrary) {
        if (!pending.has(fav.id) || (only && only !== fav.id)) continue;
        const storageKey = 'oneplay_music_fav:' + fav.id;
        const raw = localStorage.getItem(storageKey);
        let bookmark = parseFavoritePlaybackStorageValue(raw);
        if (!bookmark && raw === null) {
            const old = await dbGet<{trackPath?: string[]; currentTime?: number}>('playback:' + fav.id);
            if (Array.isArray(old?.trackPath)) bookmark = {track: old.trackPath, time: Number.isFinite(old.currentTime) ? Math.max(0, old.currentTime!) : 0};
        }
        if (bookmark && !bookmark.key && bookmark.track[1] === 'fav:' + fav.id) {
            // Identify the legacy row from cached metadata even if its source is temporarily denied.
            // Both players check current source access separately when admitting media.
            const queue = await buildLibraryQueue(bookmark.track.slice(0, 2), roots, bookmarkLibrary,
                new Set(), '', !!shares?.hasLoadedMembership?.());
            if (!queue) continue;
            if (personalLibraryClosed || localStorage.getItem(storageKey) !== raw) continue; // a play or another migration won
            const path = bookmark.track;
            const entry = queue.tracks.find(t => t.path.length === path.length && t.path.every((part, i) => part === path[i]));
            if (entry) localStorage.setItem(storageKey, buildFavoritePlaybackStorageValue(entry.path, bookmark.time,
                {key: entry.key, folder: queue.folder, folderKey: queue.folderKey}));
            await dbDelete('playback:' + fav.id);
            if (!entry && localStorage.getItem(storageKey) === raw) localStorage.removeItem(storageKey);
        }
        pending.delete(fav.id);
    }
}

/** Defer an unresolved folder until more cached roots arrive. A user selection supersedes restoration. */
let restoringBrowserPlayback: Promise<void> | undefined;
let retryBrowserRestore = false;
function restorePlaybackState(): Promise<void> {
    if (restoringBrowserPlayback) {
        retryBrowserRestore = true;
        return restoringBrowserPlayback;
    }
    if (!restoredPlayback || !playback || !tree || personalLibraryClosed) return Promise.resolve();
    let saved: GlobalPlaybackSave = restoredPlayback;
    const mode = isValidMode(saved.mode) ? saved.mode : 'all';
    const player = playback;
    restoringBrowserPlayback = (async () => {
        do {
            retryBrowserRestore = false;
            if (!saved.key && !isDemo()) {
                if (saved.folder[1]?.startsWith('fav:') && !favorites?.hasLoadedMembership?.()) return;
                if (favorites?.hasLoadedMembership?.()) bookmarkLibrary ??= [...favorites.getAll()];
                // A remote edit may arrive before a shared index. Bind the legacy path against
                // the original cached membership, then let the current queue remap that key.
                const original = await buildLibraryQueue(saved.folder, new Map(tree!.getRoots()), bookmarkLibrary ?? [],
                    new Set(), '', !!shares?.hasLoadedMembership?.());
                if (restoredPlayback !== saved || personalLibraryClosed) return;
                if (!original) continue;
                const entry = original.tracks.find(t => t.path.length === saved.track.length && t.path.every((v, i) => v === saved.track[i]));
                if (!entry) {
                    localStorage.removeItem(profileKey('playback'));
                    localStorage.removeItem(profileKey('time'));
                    restoredPlayback = undefined;
                    return;
                }
                saved = {...saved, key: entry.key, folderKey: original.folderKey, generation: crypto.randomUUID()};
                restoredPlayback = saved;
                localStorage.setItem(profileKey('playback'), JSON.stringify(saved));
                localStorage.setItem(profileKey('time'), JSON.stringify({generation: saved.generation, time: restoredTime ?? 0}));
            }
            if (await player.restoreVisualState(saved.folder, saved.track, mode,
                restoredTime ?? 0, saved.favId, accountData, saved)) {
                if (restoredPlayback === saved) restoredPlayback = undefined;
            }
        } while (retryBrowserRestore && restoredPlayback === saved);
    })().finally(() => { restoringBrowserPlayback = undefined; });
    return restoringBrowserPlayback;
}

// Main entry point

async function startupInner(): Promise<void> {
    // --- Service worker registration (before any early returns so offline
    //     shell caching works for signed-out/first-time users too) ---
    //     Deferred to `load` event: on fresh Chromium profiles, the SW provider
    //     may not be ready at DOMContentLoaded time (especially in headless-shell),
    //     causing InvalidStateError. The `load` event fires after subresources
    //     are loaded, by which time the provider is always initialized.
    const registerSw = (): void => {
        if (native || !('serviceWorker' in navigator)) return;
        startup.attachSwControllerChangeReloadListener();
        navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' })
            .catch(logCatch('sw-register'));
    };
    if (document.readyState === 'complete') registerSw();
    else window.addEventListener('load', registerSw);


    // Choose the profile before reading its view, playback or account-bound storage.
    if (native) await native.loadAccountState('state');
    const connectingFromChooser = !native && sessionStorage.getItem(CONNECT_ORIGIN) === 'chooser';
    const focusChooser = native ? native.state.focusProviderChooser : sessionStorage.getItem(SIGNOUT_FOCUS) === '1';
    const callback = new URLSearchParams(location.search);
    if (connectingFromChooser && callback.has('code')) {
        startup.showIndexProgress();
        startup.startOpeningWait();
    }
    const authResult = await browserAuth?.handleOauthRedirect();
    if (!native) {
        sessionStorage.removeItem(CONNECT_ORIGIN);
        sessionStorage.removeItem(SIGNOUT_FOCUS);
    }
    if (authResult?.error) logError(`auth error: ${authResult.error}`);
    if (browserAuth?.isSignedIn()) localStorage.removeItem(DEMO_SELECTION);
    workspace = native ? native.state.workspace === 'demo' ? 'demo'
        : native.state.driveID || readJson<AccountInfo>('account_info') ? 'personal' : 'chooser' : browserWorkspace();
    demoFocusOnTree = isDemo() && (native ? native.state.focusDemoTree === true : sessionStorage.getItem(DEMO_FOCUS) === '1');
    if (demoFocusOnTree && !native) sessionStorage.removeItem(DEMO_FOCUS);
    const connectFailed = !!authResult?.error && !['access_denied', 'user_cancelled', 'cancelled'].includes(callback.get('error') ?? '');


    // M10: Read persisted UI state synchronously before first render.
    // These are module-scoped so showTree() can pass them to createTree().
    const savedView = readJson<{path?: unknown; expanded?: unknown; autoExpand?: unknown}>(profileKey('view'));
    viewState = {
        path: Array.isArray(savedView?.path) && savedView.path.every(part => typeof part === 'string') ? savedView.path : undefined,
        expanded: savedView?.expanded === true,
        autoExpand: savedView?.autoExpand !== false,
    };
    restoredScroll = readJson<Record<string, {top: number}>>(profileKey('scroll'));
    restoredPlayback = parseGlobalPlaybackSave(readJson(profileKey('playback')));
    restoredTime = parseGlobalPlaybackTime(localStorage.getItem(profileKey('time')), restoredPlayback);
    const timerRaw = localStorage.getItem(profileKey('timer_duration'));
    timerDuration = isTimerDuration(timerRaw) ? timerRaw : '30m';
    const themeRaw = localStorage.getItem('oneplay_music_theme');
    themePreference = isThemePreference(themeRaw) ? themeRaw : 'light';
    applyTheme();
    matchMedia('(prefers-color-scheme:dark)').addEventListener('change', applyTheme);
    const debugRaw = localStorage.getItem(profileKey('debug_enabled'));
    debugEnabled = !isDemo() && (debugRaw === '1' || debugRaw === 'true');
    const lastUpdatedRaw = localStorage.getItem('oneplay_music_index_last_updated');
    if (lastUpdatedRaw) {
        const parsed = parseInt(lastUpdatedRaw, 10);
        sync.setLastIndexUpdatedAt(Number.isFinite(parsed) ? parsed : undefined);
    } else {
        sync.setLastIndexUpdatedAt(undefined);
    }
    if (isDemo()) {
        if (connectingFromChooser) {
            startup.showLibraryChoices(connectFailed ? 'Couldn’t connect to OneDrive.' : '', false, true);
            return;
        }
        if (!native && !navigator.onLine) setDemoEvidence('evidence:not-online');
        await openDemoFromChooser();
        return;
    }

    browserAuth?.reconcileEvidenceFromNavigator('startup:init', { logUnchanged: true });

    // -- M11b: online/offline event listeners (wired early, before any pull) --
    if (browserAuth) window.addEventListener('offline', () => {
        if (workspace === 'chooser') return;
        browserAuth.reconcileEvidenceFromNavigator('window:offline');
        sync.cancelScheduledPull();
    });
    if (browserAuth) window.addEventListener('online', () => {
        if (workspace !== 'personal') return;
        browserAuth.reconcileEvidenceFromNavigator('window:online');
        sync.requestPullFromOneDrive('online').catch(logCatch('online pull'));
    });
    // Backstop: visibilitychange catches missed online events (PWA/iOS)
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            appResumeLogArmed = true;
            return;
        }
        if (document.visibilityState === 'visible') {
            if (workspace !== 'personal') return;
            if (appResumeLogArmed) {
                log(`====== APP RESUME v${DEPLOY_COUNTER} ========`);
                appResumeLogArmed = false;
            }
            const before = auth.getEvidence();
            const after = browserAuth?.reconcileEvidenceFromNavigator('document:visibilitychange');
            if (after && after !== 'evidence:not-online'
                && (before === 'evidence:not-online' || startup.isShowingOfflineRetry())) {
                sync.requestPullFromOneDrive('online').catch(logCatch('visible pull'));
            }
        }
    });
    // If the app starts with stale evidence while hidden lifecycle events were missed,
    // reconcile once more at first visible opportunity before any startup pull gate.
    if (document.visibilityState === 'visible') browserAuth?.reconcileEvidenceFromNavigator('startup:visible');
    // Re-apply theme when OS preference changes (only matters when themePreference === 'auto')

    // Load saved AccountInfo (survives page reloads; lighter than a Graph call)
    const savedInfo: AccountInfo | undefined = (() => {
        try {
            const raw = localStorage.getItem('account_info');
            return raw ? JSON.parse(raw) : undefined;
        } catch { return undefined; }
    })();
    if (native && savedInfo && savedInfo.driveId !== native.state.driveID) {
        startup.showCacheAccountMismatch();
        return;
    }
    if (!savedInfo && !auth.isSignedIn()) {
        demoWanted = native?.state.demoOpenFailed === true;
        startup.showLibraryChoices(connectFailed ? 'Couldn’t connect to OneDrive.'
            : demoWanted ? DEMO_LOAD_FAILURE : '', false, focusChooser || connectingFromChooser);
        return;
    }
    sync.setSavedInfoRef(savedInfo);

    // Create favorites data module early (no tree dependency).
    // This ensures favorites exists before any pull, fixing the sign-out →
    // sign-back-in path where pullFavoritesFromOneDrive was silently skipped.
    await ensureFavorites();
    await ensureShares();

    // A failed read propagates to opening recovery. Only a confirmed miss admits first indexing.
    const cachedData = savedInfo ? await loadCachedData(savedInfo.driveId) : undefined;
    if (savedInfo && cachedData) {
        showTree(savedInfo, cachedData.folder);
        sync.setCachedDataRef(cachedData);
        log(`showing cached: ${cachedData.count} tracks`);
    }
    localBootstrapComplete = true;
    if (cachedData) {
        await Promise.all([restorePlaybackState(), migrateBrowserFavoriteBookmarks().catch(logCatch('browser bookmark migration'))]);
    }

    const evidence = browserAuth?.reconcileEvidenceFromNavigator('startup:pull-gate', { logUnchanged: true }) ?? auth.getEvidence();
    if (evidence === 'evidence:not-online') {
        log('skipping pull: evidence is not-online');
        if (!cachedData) startup.showFailure(true);
    } else if (!cachedData && !auth.isSignedIn()) {
        startup.showSignIn();
    } else {
        await sync.requestPullFromOneDrive('startup');
    }
}

// Profile transport is independent of the personal scheduler and token state.
window.addEventListener('online', () => { if (workspace !== 'personal') resumeDemoOrChooser(); });
window.addEventListener('offline', () => { if (isDemo() && !native) setDemoEvidence('evidence:not-online'); });
document.addEventListener('visibilitychange', () => {
    if (!document.hidden && workspace !== 'personal') resumeDemoOrChooser();
});
window.addEventListener('pagehide', () => {
    if (!native && (workspace !== 'personal')) {
        demoPage.abort();
        demoOpening?.controller.abort();
        demoOpening = undefined;
        demoRefresh = undefined;
        clearTimeout(catalogRetryTimer);
        catalogRetryTimer = undefined;
        clearTimeout(demoRetryTimer);
        demoRetryTimer = undefined;
    }
});
window.addEventListener('pageshow', (event) => {
    if (native || !event.persisted) return;
    const savedDrive = readJson<AccountInfo>('account_info')?.driveId;
    const origin = connecting ? sessionStorage.getItem(CONNECT_ORIGIN) : null;
    if (personalLibraryClosed || (connecting && !origin) || workspace !== browserWorkspace()
        || (workspace === 'personal' && accountData.size && (!savedDrive || !accountData.has(savedDrive)))) {
        location.reload();
        return;
    }
    demoPage = new AbortController();
    if (connecting) {
        sessionStorage.removeItem(CONNECT_ORIGIN);
        connecting = false;
        startup.setOneDriveConnecting(false);
        if (origin === 'chooser') startup.showLibraryChoices('', false, true);
    }
    resumeDemoOrChooser();
});

export async function onBodyLoad(): Promise<void> {
    await startup.onBodyLoad(startupInner);
}
