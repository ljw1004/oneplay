import { createAuth, isAbortError, type EvidenceState } from './auth.js';
import { showModal } from './modal.js';
import { createNativePins } from './native-pins.js';
import { attachNativePlayback } from './native-playback.js';
import { connectBundledLibrary } from './native-library.js';
import { buildFavoritePlaybackStorageValue, parseFavoritePlaybackStorageValue, parseGlobalPlaybackSave,
    parseGlobalPlaybackTime, type GlobalPlaybackSave } from './playback-engine.js';
import { dbGet, dbPut, dbClear, dbDelete, dbKeysWithPrefix } from './db.js';
import { log, logError, logCatch } from './logger.js';
import { initWebLogger } from './logger-web.js';
import {
    type MusicData, type AccountInfo, type IndexProgress, sortedFolderChildren,
} from './indexer.js';
import { createTree, type TreeView } from './tree.js';
import { createPlayback, type Playback, isValidMode } from './playback.js';
import { isPathDeniedByShare } from './roots.js';
import { createFavorites, type Favorite, type Favorites } from './favorites.js';
import { createSelect, type Select } from './select.js';
import { createDownloads, type Downloads, classifyOfflineBadgeState } from './downloads.js';
import { buildLibraryQueue, collectPhysicalTracks, resolveFolderFromPath, resolveTrackIds } from './tracks.js';
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
import { createIndexStartup } from './index-startup.js';

const displayNativeLog = initWebLogger();

/** Debug mode: shows evidence-state indicator and auto-reloads on SW update. */
const SW_DEBUG = true;
const TIMER_VALUES: readonly TimerDuration[] = ['15m', '30m', '45m', '60m', 'end-of-track'];
const FAVORITE_CUSTOMIZE_TOAST_KEY = 'oneplay_music_tip_customize_favorite_shown';
const STARTUP_DEADLINE_MS = 5000;
const STARTUP_DEADLINE_WITH_OAUTH_CODE_MS = 13000;
const STARTUP_ERROR_MESSAGE = 'Could not finish startup. Please reload.';

/** Deploy counter — replaced by sed during `npm run deploy`.
 *  On localhost (watch mode), this stays as the placeholder string. */
const DEPLOY_COUNTER = '__DEPLOY_COUNTER__';

let debugEnabled = false;

// DOM helpers

const statusEl = (): HTMLElement => document.getElementById('status')!;


/** Loads cached MusicData from IndexedDB, returning undefined if absent or schema mismatch. */
const loadCachedData = async (driveId: string): Promise<MusicData | undefined> => {
    const data = await dbGet<MusicData>(indexKey(driveId)).catch(() => undefined);
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
let restoredView: { path: string[]; expanded: boolean } | undefined;
let restoredScroll: Record<string, {top: number}> | undefined;
let restoredPlayback: GlobalPlaybackSave | undefined;
let restoredTime: number | undefined;
let favoriteCustomizeToastShownInSession = false;
let activeToastEl: HTMLElement | undefined;
let activeToastTimer: ReturnType<typeof setTimeout> | undefined;
let appResumeLogArmed = false;

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
        if (localStorage.getItem(FAVORITE_CUSTOMIZE_TOAST_KEY) === '1') return;
        localStorage.setItem(FAVORITE_CUSTOMIZE_TOAST_KEY, '1');
    } catch {
        // If localStorage is unavailable/quota-limited, still show once per session.
    }
    showToastMessage('Tip: Press and hold a favorite to customize it.');
}


// Auth module (created once at module scope, before any network calls)

const native = connectBundledLibrary(displayNativeLog);
const browserAuth = native ? undefined : createAuth();
const auth = native ?? browserAuth!;
auth.onEvidenceChange = (newState, prevState) => {
    log(`evidence: ${prevState} → ${newState}`);
    if (native && tree) {
        if (newState === 'evidence:not-online' || newState === 'evidence:signed-out') sync.cancelScheduledPull();
        else if (prevState === 'evidence:not-online') sync.requestPullFromOneDrive('online').catch(logCatch('native online pull'));
    }
    downloads?.handleEvidenceTransition();
    if (nativePins) { renderNativePins(true); nativePins.refresh().catch(logCatch('offline evidence')); }
    else computeAndPushOfflineState();
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
let nativePins: ReturnType<typeof createNativePins> | undefined;
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

let shares: Shares | undefined;
interface TestHooksWindow extends Record<string, unknown> {
    _testSettingsAddShare?: (url: string, signal?: AbortSignal) => Promise<void> | void;
    _testSettingsRenameShare?: (id: string, name: string) => Promise<void> | void;
    _testSettingsRemoveShare?: (id: string) => Promise<void> | void;
    _testSettingsSignOut?: () => Promise<void> | void;
    _testSettingsReconnect?: () => Promise<void> | void;
    _testSettingsRefreshNow?: () => Promise<void> | void;
    _testSetLatestIndexFailure?: (failure?: { label?: string; message?: string }) => void;
    _testStartupDeadlineMs?: unknown;
}

const getTestHooksWindow = (): TestHooksWindow => window as unknown as TestHooksWindow;

type SearchReason = 'open' | 'query-change' | 'show-tree' | 'share-roots' | 'offline-state';

const startup = createIndexStartup({
    swDebug: SW_DEBUG,
    appVersionLabel: DEPLOY_COUNTER,
    startupDeadlineMsDefault: STARTUP_DEADLINE_MS,
    startupDeadlineWithOauthCodeMs: STARTUP_DEADLINE_WITH_OAUTH_CODE_MS,
    startupErrorMessage: STARTUP_ERROR_MESSAGE,
    getDebugEnabled: () => debugEnabled,
    getTestStartupDeadlineMs: () => getTestHooksWindow()._testStartupDeadlineMs,
    onSignIn: () => {
        signInAndRefreshLibrary().catch(logCatch('sign-in button'));
    },
    renderIndexing: (progress) => renderIndexing(progress),
});

const sync = createIndexSync({
    auth,
    startupErrorMessage: STARTUP_ERROR_MESSAGE,
    accountData,
    getTree: () => tree,
    getPlayback: () => playback,
    onPlaybackRootsChange: () => {
        ++nativeLibraryGeneration;
        if (nativePins) computeAndPushOfflineState();
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
    showTree: (info, data, reindexing = false) => showTree(info, data, reindexing),
    showError: (message) => startup.showError(message),
    renderSignInButtonIntoStatus: showSignIn,
    renderStartupErrorIntoStatusAndWireReload: (message) => startup.renderStartupErrorIntoStatusAndWireReload(message),
    markStartupTerminalState: (state) => startup.markStartupTerminalState(state),
    enterFirstTimeIndexingAndBypassStartupDeadline: () => startup.enterFirstTimeIndexingAndBypassStartupDeadline(),
    renderIndexing: (progress) => renderIndexing(progress),
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
    const snapshot = (nativePins ?? downloads)?.getSnapshot();
    const downloadedTrackKeys = snapshot?.downloadedKeys ?? new Set<string>();
    const evidenceState = snapshot?.evidence ?? auth.getEvidence();
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
    localStorage.setItem('oneplay_music_debug_enabled', next ? '1' : '0');
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

/** The local-file join check is available before the first sign-in and in airplane mode. */
function showSignIn(): void {
    if (startup.hasReachedDeadline()) return;
    startup.renderSignInButtonIntoStatus();
    if (!native?.state.debugPlayback) return;
    const localFiles = document.createElement('button');
    localFiles.textContent = 'Test local MP3 files…';
    localFiles.addEventListener('click', () => showPlaybackTest());
    statusEl().appendChild(localFiles);
}

/** A Debug build can audition local files or up to ten indexed MP3 siblings from the tapped row.
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
    showModal(path ? `Test playback from ${names[first]}` : 'Test local MP3 playback', (modal, close) => {
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
        const play = (nearEnd: boolean, forceRefresh = false, delaySeconds = 0) => tracks
            ? native.playIndexed(tracks, nearEnd, forceRefresh, delaySeconds)
            : native.playLocal(nearEnd);
        if (!path && nativePlayer?.currentPath()) add('Test playing album…', async () => showPlaybackTest(nativePlayer?.currentPath()));
        add('Play from beginning', () => play(false));
        add('Play near first join', () => play(true));
        if (tracks) for (const delay of [0, 5, 10]) {
            add(delay ? `Force renewal, hold ${delay}s` : 'Force renewal now', () => play(true, true, delay));
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
        if (!tree) renderIndexing({ fraction: 0, message: 'Opening your OneDrive library...' });
        await sync.requestPullFromOneDrive('settings-refresh');
        if (!tree && !startup.isStartupTerminalUiRendered()) startup.renderStartupErrorIntoStatusAndWireReload(STARTUP_ERROR_MESSAGE);
    } catch (error) {
        const outcome = error instanceof Error ? error.message : String(error);
        if (!tree) showSignIn();
        if (outcome !== 'cancelled') showToastMessage(outcome === 'wrongAccount'
            ? 'Reconnect with the OneDrive account used for this library.'
            : 'OneDrive sign-in failed. Please try again.');
    } finally {
        if (button) button.disabled = false;
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
        evidence: auth.getEvidence(),
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
            await browserAuth!.signOut(async () => {
                playback?.stop();
                browserBookmarksClosed = true;
                localStorage.removeItem('account_info');
                clearM10State();
                sync.cancelScheduledPull();
                await downloads?.clear();
                await dbClear();
            });
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
            const record = shares.getAll().find((s) => s.id === id);
            if (!record) return;
            try { await shares.remove(id); }
            finally { await sync.onShareRemoved(record); }
        },
        onTimerChange: (next) => {
            timerDuration = next;
            localStorage.setItem('oneplay_music_timer_duration', next);
            playback?.setTimerDuration(next);
            nativePlayer?.setTimer(next);
        },
        onThemeChange: (next) => {
            themePreference = next;
            localStorage.setItem('oneplay_music_theme', next);
            applyTheme();
        },
        onTestLocalPlayback: native?.state.debugPlayback ? () => showPlaybackTest() : undefined,
        theme: themePreference,
        onDebugExpire: simulateSignedOutForDebug,
        onDebugToggle: (next) => setRuntimeDebugEnabled(next),
    });
    sync.updateSettingsIndexSection();
}

/** Closes settings and restores tree visibility without touching selectedPath or scroll state. */
function closeSettingsPage(): void {
    if (!settings) return;
    settings.close();
    document.getElementById('settings-container')!.hidden = true;
    document.getElementById('tree-container')!.hidden = false;
}

/**
 * Switches the UI from status/sign-in view to the tree view.
 * Creates the tree and playback components on first call; updates data on subsequent calls.
 */
function showTree(info: AccountInfo, data: MusicData, reindexing = false): void {
    if (startup.hasReachedDeadline()) return;
    const status = statusEl();
    const treeEl = document.getElementById('tree-container')!;
    const settingsEl = document.getElementById('settings-container')!;
    status.hidden = true;
    const settingsOpen = settings?.isOpen() ?? false;
    treeEl.hidden = settingsOpen;
    settingsEl.hidden = !settingsOpen;
    startup.markStartupTerminalState('tree');

    // Update root-folder references for playback path resolution.
    accountData.set(info.driveId, { folder: data.folder, driveId: info.driveId });

    if (!tree) {
        tree = createTree(treeEl, restoredView?.path, restoredScroll,
            SW_DEBUG ? DEPLOY_COUNTER : '');
        settings = createSettings(settingsEl);
        if (browserAuth) {
            playback = createPlayback(
                document.getElementById('player') as HTMLAudioElement,
                document.getElementById('footer')!,
                auth.fetch,
                migrateBrowserFavoriteBookmarks,
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
                return favorite?.hasPrivatePlayback
                    ? {favorite: favorite.id, mode: isValidMode(favorite.mode) ? favorite.mode : 'all' as const}
                    : favorite ? {mode: 'all' as const} : {};
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
            nativePlayer = attachNativePlayback(native, document.getElementById('footer')!,
                tree.setPlaybackInfo, path => {
                    if (settings?.isOpen()) closeSettingsPage();
                    tree!.revealTrack(path);
                }, showToastMessage, describe, () => shares?.hasLoadedMembership?.() ? shares.getAll().map(s => s.rootKey) : undefined, async (folder, mode) => {
                    const favorite = favorites?.getAll().find(f => folder[1] === 'fav:' + f.id);
                    if (favorite?.hasPrivatePlayback) await favorites!.setMode(favorite.id, mode);
                }, favoriteSettings, migratePrivateSpots, () => restoredPlayback && Array.isArray(restoredPlayback.folder)
                    && Array.isArray(restoredPlayback.track) ? {folder: restoredPlayback.folder, track: restoredPlayback.track,
                        seconds: Number.isFinite(restoredTime) && restoredTime! > 0 ? restoredTime! : 0,
                        mode: isValidMode(restoredPlayback.mode) ? restoredPlayback.mode : 'all', timer: timerDuration,
                        consume: () => {
                            restoredPlayback = undefined;
                            localStorage.removeItem('oneplay_music_playback');
                            localStorage.removeItem('oneplay_music_time');
                        }} : undefined);
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

        // M10: persist view state on path or expanded changes
        tree.onPathChange = (path) => {
            try {
                const exp = playback?.getInfo() ? (document.getElementById('footer')!.classList.contains('expanded')) : false;
                localStorage.setItem('oneplay_music_view', JSON.stringify({ path, expanded: exp }));
            } catch { /* quota */ }
        };
        tree.onFavoriteRootTap = () => showFavoriteCustomizeToastOnce();
        if (playback) playback.onExpandedChange = (exp) => {
            const path = tree!.getSelectedPath();
            try {
                localStorage.setItem('oneplay_music_view', JSON.stringify({ path, expanded: exp }));
            } catch { /* quota */ }
        };
        tree.onSettingsClick = () => openSettingsPage();
        tree.onShareWithoutDataTap = () => openSettingsPage();
        tree.onSearchOpen = () => {
            if (select?.isActive()) select.exitSelectMode();
            playback?.collapse();
            nativePlayer?.collapse();
            searchOpen = true;
            tree!.openSearchMode(searchQuery, searchScrollTop);
            runSearchAndPushIntoTree('open');
        };
        tree.onSearchClose = (query, scrollTop) => {
            searchOpen = false;
            searchQuery = query;
            searchScrollTop = scrollTop;
        };
        tree.onSearchQueryChange = (query) => {
            searchQuery = query;
            searchScrollTop = 0;
            runSearchAndPushIntoTree('query-change');
        };
        tree.onSearchResultClick = (result: SearchResult) => {
            tree!.closeSearchMode();
            if (result.kind === 'track') {
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
    nativePlayer?.setDebugEnabled(debugEnabled);
    playback?.setTimerDuration(timerDuration);
    tree.setAccount(info.driveId, data.folder, info, reindexing);
    sync.syncShareRootsIntoTreeAndPlayback();

    // Wire favorites to tree + create select/downloads (idempotent).
    // Runs on every showTree since roots may have changed after setAccount.
    wireFavoritesUi();
    if (native) computeAndPushOfflineState();
    invalidateSearchData();
    runSearchAndPushIntoTree('show-tree');
}

// Offline state orchestration

/**
 * Computes pinned track keys from favorites + roots and pushes derived
 * state to both downloads (pinned keys) and tree (icon states).
 *
 * Called on: favorites onChange, index build complete, download state change.
 * This is the single point where favorites knowledge is translated into
 * the data that the downloads engine and tree view consume — breaking the
 * dependency cycle between them.
 */
/** Previous icon map + evidence state, for dirty-checking in computeAndPushOfflineState.
 *  Only re-render the tree when these actually change — avoids restarting CSS
 *  animations on every per-track download completion. */
let prevIconsJson = '';
let prevEvidence: EvidenceState = 'no-evidence';
let prevOfflineHadPending = false;

/** Tree/search need new rows only when their playable set or a visible badge changes. */
function renderNativePins(filesChanged: boolean): void {
    if (!nativePins || !tree || !favorites) return;
    const snap = nativePins.getSnapshot();
    const roots = tree.getRoots();
    const icons = new Map<string, 'complete' | 'paused' | 'downloading'>();
    for (const favorite of favorites.getAll()) {
        if (!favorite.offlinePin) continue;
        const count = nativePins.favoriteProgress(favorite.id);
        icons.set(favorite.id, classifyOfflineBadgeState(!count?.complete || count.downloaded < count.total,
            snap.evidence, favorite.offlinePin.paused, snap.overQuota, !!snap.lastError));
    }
    const limited = snap.evidence === 'evidence:not-online' || snap.evidence === 'evidence:signed-out';
    const repaint = prevEvidence !== snap.evidence || (limited && filesChanged);
    tree.setEvidence(snap.evidence, path => {
        const ids = resolveTrackIds(path, accountData, favorites!, roots);
        return !!ids && snap.downloadedKeys.has(ids.driveId + ':' + ids.itemId);
    });
    const signature = JSON.stringify([...icons]);
    tree.setOfflineIcons(icons);
    if (repaint || prevIconsJson !== signature) tree.render();
    prevIconsJson = signature;
    prevEvidence = snap.evidence;
    if (repaint) { invalidateSearchData(); runSearchAndPushIntoTree('offline-state'); }
    select?.updateOfflineModal();
}

function computeAndPushOfflineState(): void | Promise<void> {
    if (!tree || !favorites) return;
    if (nativePins) {
        return nativePins.publishOwners([...favorites.getAll()], new Map(tree.getRoots()), new Set(shares?.getDeniedRootKeys()),
            favorites.hasLoadedMembership?.() === true).catch(error => { logCatch('offline pin membership')(error); });
    }
    if (!downloads) {
        if (native && prevEvidence !== native.getEvidence()) {
            prevEvidence = native.getEvidence();
            tree.setEvidence(prevEvidence, () => false);
            tree.render();
            invalidateSearchData();
            runSearchAndPushIntoTree('offline-state');
        }
        return;
    }
    const roots = tree.getRoots();
    const allFavs = favorites.getAll();
    const deniedRoots = shares?.getDeniedRootKeys() ?? new Set<string>();

    // Per-favorite track keys (for icon computation)
    const favTrackKeys = new Map<string, Set<string>>();
    const activeKeys = new Set<string>();
    const retainKeys = new Set<string>();

    for (const fav of allFavs) {
        const tracks = collectPhysicalTracks(fav.id, favorites, roots, deniedRoots);
        const keys = new Set(tracks.map(t => `${t.driveId}:${t.itemId}`));
        favTrackKeys.set(fav.id, keys);
        if (fav.offlinePin) {
            for (const k of keys) retainKeys.add(k);
            if (!fav.offlinePin.paused) {
                for (const k of keys) activeKeys.add(k);
            }
        }
    }

    downloads.setPinnedKeys(activeKeys, retainKeys);

    // Compute icon states from snapshot
    const snap = downloads.getSnapshot();
    const pendingByFavorite: string[] = [];
    let pendingTrackCount = 0;
    const icons = new Map<string, 'complete' | 'downloading' | 'paused'>();
    for (const fav of allFavs) {
        if (!fav.offlinePin) continue;
        const keys = favTrackKeys.get(fav.id);
        const missing = keys ? Array.from(keys).filter((k) => !snap.downloadedKeys.has(k)).length : 0;
        if (missing > 0) {
            pendingTrackCount += missing;
            pendingByFavorite.push(`${fav.name}(${missing})`);
        }
        icons.set(
            fav.id,
            classifyOfflineBadgeState(
                missing > 0,
                snap.evidence,
                fav.offlinePin.paused,
                snap.overQuota,
                !!snap.lastError,
            ),
        );
    }
    if (pendingByFavorite.length > 0) {
        if (!prevOfflineHadPending) {
            log(`offline: downloads started queue=${snap.queuedKeys.size} missingTracks=${pendingTrackCount} favorites=${pendingByFavorite.join(', ')}`);
        }
        prevOfflineHadPending = true;
    } else {
        if (prevOfflineHadPending) {
            log(`offline: downloads finished queue=${snap.queuedKeys.size} downloadedKeys=${snap.downloadedKeys.size}`);
        }
        prevOfflineHadPending = false;
    }
    tree.setOfflineIcons(icons);

    // Push evidence state + cache-check callback to tree for track greying.
    // Tree uses this to grey non-cached tracks when signed-out or not-online.
    const cachedCheck = (path: readonly string[]): boolean => {
        const ids = resolveTrackIds(path, accountData, favorites!, roots);
        return ids !== undefined && snap.downloadedKeys.has(`${ids.driveId}:${ids.itemId}`);
    };
    tree.setEvidence(snap.evidence, cachedCheck);
    playback?.setAvailabilityContext(
        snap.evidence,
        cachedCheck,
        path => isPathDeniedByShare(path, deniedRoots, roots),
        entry => snap.downloadedKeys.has(`${entry.driveId}:${entry.itemId}`),
    );

    // Only re-render when icon states or evidence actually changed.
    // Intermediate download completions (same icon state) skip the render,
    // preventing CSS animation restarts on every per-track completion.
    const iconsJson = JSON.stringify([...icons]);
    if (iconsJson !== prevIconsJson || snap.evidence !== prevEvidence) {
        prevIconsJson = iconsJson;
        prevEvidence = snap.evidence;
        tree.render();
    }
    invalidateSearchData();
    runSearchAndPushIntoTree('offline-state');
}

// Favorites wiring

let ensureFavoritesPromise: Promise<void> | undefined;
async function ensureFavorites(): Promise<void> {
    if (ensureFavoritesPromise) return ensureFavoritesPromise;

    ensureFavoritesPromise = (async () => {
        const publishFavorites = async () => {
            // onChange: sync favorite roots into tree and re-render
            if (tree) {
                ++nativeLibraryGeneration;
                tree.setFavorites(favorites!);
                if (nativePins) await nativePins.publishOwners([...favorites!.getAll()], new Map(tree.getRoots()),
                    new Set(shares?.getDeniedRootKeys()), favorites!.hasLoadedMembership?.() === true);
                await nativePlayer?.refreshLibraryQueue(true);
                if (select) select.setRoots(tree.getRoots());
                // Update playback context so logical path resolution uses fresh data
                if (playback) {
                    playback.setContext(favorites!, tree.getRoots(), shares?.getDeniedRootKeys(), shares?.hasLoadedMembership?.());
                    await playback.refreshLibraryQueue(true);
                    await restorePlaybackState();
                }
                // An acknowledged local edit includes publishing the resulting pin owners.
                if (!nativePins) await computeAndPushOfflineState();
            }
        };
        favorites = createFavorites({authFetch: auth.fetch, dbGet, dbPut, fencePinEdit: native ? () => nativePins?.fenceEdit() : undefined, fenceQueueEdit: async () => {
            ++nativeLibraryGeneration;
            return playback ? playback.fenceQueueEdit() : nativePlayer?.fenceQueueEdit();
        }}, origin => {
            const published = publishFavorites();
            // A remote edit may reference a share whose index this same sync still has to load.
            // Keep its tree publication pending while the sync proceeds with that prerequisite.
            if (origin === 'sync' && (nativePlayer || playback)) { published.catch(logCatch('publish synced favorite')); return; }
            return published;
        });

        await favorites.loadFromCache();
    })();

    return ensureFavoritesPromise;
}

let ensureSharesPromise: Promise<void> | undefined;
async function ensureShares(): Promise<void> {
    if (ensureSharesPromise) return ensureSharesPromise;

    ensureSharesPromise = (async () => {
        shares = createShares({ authFetch: auth.fetch, dbGet, dbPut,
            onDisconnect: native?.syncPlaybackMembership, beginSourceProbe: native?.beginSourceProbe,
            readPlaybackDenials: native?.readPlaybackDenials }, () => {
            sync.syncShareRootsIntoTreeAndPlayback();
            computeAndPushOfflineState();
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

        select.onEnterSelect = () => {
            playback?.collapse();
            nativePlayer?.collapse();
            document.body.classList.add('select-mode');
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
    if (native && !nativePins) {
        nativePins = createNativePins(native, renderNativePins);
        select.setDownloads(nativePins);
        nativePins.refresh().catch(logCatch('offline inventory'));
    }
    if (!downloads && browserAuth) {
        downloads = createDownloads({
            authFetch: auth.fetch,
            getEvidence: () => auth.getEvidence(),
            provideEvidenceFromHttpStatus: (status, reason) => browserAuth.provideEvidenceFromHttpStatus(status, reason),
            provideEvidenceFromError: (error, reason) => browserAuth.provideEvidenceFromError(error, reason),
        });
        downloads.onStateChange = () => {
            computeAndPushOfflineState();
            select?.updateOfflineModal();
        };
        playback!.setDownloads(downloads);
        select!.setDownloads(downloads);
        computeAndPushOfflineState();
        // Expose for integration tests
        (window as unknown as Record<string, unknown>)._testDownloads = downloads;
    }
}

// Rendering (indexing progress — shown in #status, not in tree)

/**
 * Renders the prominent progress display for first-time indexing.
 * Called repeatedly as progress updates arrive.
 */
function renderIndexing(progress: IndexProgress): void {
    if (startup.hasReachedDeadline()) return;
    const el = statusEl();
    const pct = Math.round(progress.fraction * 100);

    // Create structure on first call
    if (!el.querySelector('.index-progress')) {
        el.innerHTML = `<div class="index-progress">`
            + `<div>Indexing your music...</div>`
            + `<div class="progress-bar"><div class="progress-fill"></div></div>`
            + `<div class="status-line"></div>`
            + `</div>`;
    }

    el.querySelector<HTMLElement>('.progress-fill')!.style.width = `${pct}%`;
    el.querySelector('.status-line')!.textContent = `${pct}% — ${progress.message}`;
}

// M10: Restore playback visual state

/** Resolve a path-only bookmark against the favorite membership first loaded on this device.
 * Keep that membership while an unresolved share index loads, even if sync moves its rows. */
let bookmarkLibrary: readonly Favorite[] | undefined;
let legacyFavoriteIds: Promise<Set<string>> | undefined;
let browserBookmarksClosed = false;
async function migrateBrowserFavoriteBookmarks(only?: string): Promise<void> {
    if (!playback || !tree || browserBookmarksClosed || !favorites?.hasLoadedMembership?.()) return;
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
            if (browserBookmarksClosed || localStorage.getItem(storageKey) !== raw) continue; // a play or another migration won
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
    if (!restoredPlayback || !playback || !tree || browserBookmarksClosed) return Promise.resolve();
    let saved: GlobalPlaybackSave = restoredPlayback;
    const mode = isValidMode(saved.mode) ? saved.mode : 'all';
    const player = playback;
    restoringBrowserPlayback = (async () => {
        do {
            retryBrowserRestore = false;
            if (!saved.key) {
                if (saved.folder[1]?.startsWith('fav:') && !favorites?.hasLoadedMembership?.()) return;
                if (favorites?.hasLoadedMembership?.()) bookmarkLibrary ??= [...favorites.getAll()];
                // A remote edit may arrive before a shared index. Bind the legacy path against
                // the original cached membership, then let the current queue remap that key.
                const original = await buildLibraryQueue(saved.folder, new Map(tree!.getRoots()), bookmarkLibrary ?? [],
                    new Set(), '', !!shares?.hasLoadedMembership?.());
                if (restoredPlayback !== saved || browserBookmarksClosed) return;
                if (!original) continue;
                const entry = original.tracks.find(t => t.path.length === saved.track.length && t.path.every((v, i) => v === saved.track[i]));
                if (!entry) {
                    localStorage.removeItem('oneplay_music_playback');
                    localStorage.removeItem('oneplay_music_time');
                    restoredPlayback = undefined;
                    return;
                }
                saved = {...saved, key: entry.key, folderKey: original.folderKey, generation: crypto.randomUUID()};
                restoredPlayback = saved;
                localStorage.setItem('oneplay_music_playback', JSON.stringify(saved));
                localStorage.setItem('oneplay_music_time', JSON.stringify({generation: saved.generation, time: restoredTime ?? 0}));
            }
            if (await player.restoreVisualState(saved.folder, saved.track, mode, restoredView?.expanded ?? false,
                restoredTime ?? 0, saved.favId, accountData, saved)) {
                if (restoredPlayback === saved) restoredPlayback = undefined;
            }
        } while (retryBrowserRestore && restoredPlayback === saved);
    })().finally(() => { restoringBrowserPlayback = undefined; });
    return restoringBrowserPlayback;
}

// Main entry point

async function startupInner(): Promise<void> {

    // M10: Read persisted UI state synchronously before first render.
    // These are module-scoped so showTree() can pass them to createTree().
    restoredView = readJson<{ path: string[]; expanded: boolean }>('oneplay_music_view');
    restoredScroll = readJson<Record<string, {top: number}>>('oneplay_music_scroll');
    restoredPlayback = parseGlobalPlaybackSave(readJson('oneplay_music_playback'));
    restoredTime = parseGlobalPlaybackTime(localStorage.getItem('oneplay_music_time'), restoredPlayback);
    const timerRaw = localStorage.getItem('oneplay_music_timer_duration');
    timerDuration = isTimerDuration(timerRaw) ? timerRaw : '30m';
    const themeRaw = localStorage.getItem('oneplay_music_theme');
    themePreference = isThemePreference(themeRaw) ? themeRaw : 'light';
    applyTheme();
    const debugRaw = localStorage.getItem('oneplay_music_debug_enabled');
    debugEnabled = debugRaw === '1' || debugRaw === 'true';
    const lastUpdatedRaw = localStorage.getItem('oneplay_music_index_last_updated');
    if (lastUpdatedRaw) {
        const parsed = parseInt(lastUpdatedRaw, 10);
        sync.setLastIndexUpdatedAt(Number.isFinite(parsed) ? parsed : undefined);
    } else {
        sync.setLastIndexUpdatedAt(undefined);
    }
    browserAuth?.reconcileEvidenceFromNavigator('startup:init', { logUnchanged: true });

    // -- M11b: online/offline event listeners (wired early, before any pull) --
    if (browserAuth) window.addEventListener('offline', () => {
        browserAuth.reconcileEvidenceFromNavigator('window:offline');
        sync.cancelScheduledPull();
    });
    if (browserAuth) window.addEventListener('online', () => {
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
            if (appResumeLogArmed) {
                log(`====== APP RESUME v${DEPLOY_COUNTER} ========`);
                appResumeLogArmed = false;
            }
            const before = auth.getEvidence();
            const after = browserAuth?.reconcileEvidenceFromNavigator('document:visibilitychange');
            if (after && before === 'evidence:not-online' && after !== 'evidence:not-online') {
                sync.requestPullFromOneDrive('online').catch(logCatch('visible pull'));
            }
        }
    });
    // If the app starts with stale evidence while hidden lifecycle events were missed,
    // reconcile once more at first visible opportunity before any startup pull gate.
    if (document.visibilityState === 'visible') {
        const before = auth.getEvidence();
        const after = browserAuth?.reconcileEvidenceFromNavigator('startup:visible');
        if (after && before === 'evidence:not-online' && after !== 'evidence:not-online') {
            sync.requestPullFromOneDrive('online').catch(logCatch('visible pull'));
        }
    }
    // Re-apply theme when OS preference changes (only matters when themePreference === 'auto')
    matchMedia('(prefers-color-scheme:dark)').addEventListener('change', () => applyTheme());

    // 1. Process OAuth redirect (if any)
    if (native) await native.loadAccountState('state'); // Local admission only. Cached rendering precedes Graph.
    const authResult = await browserAuth?.handleOauthRedirect();
    if (authResult?.error) logError(`auth error: ${authResult.error}`);

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

    // 2. Load saved AccountInfo (survives page reloads; lighter than a Graph call)
    const savedInfo: AccountInfo | undefined = (() => {
        try {
            const raw = localStorage.getItem('account_info');
            return raw ? JSON.parse(raw) : undefined;
        } catch { return undefined; }
    })();
    if (native && savedInfo && savedInfo.driveId !== native.state.driveID) {
        startup.showError('This cached library belongs to a different OneDrive account.');
        return;
    }
    sync.setSavedInfoRef(savedInfo);

    // Create favorites data module early (no tree dependency).
    // This ensures favorites exists before any pull, fixing the sign-out →
    // sign-back-in path where pullFavoritesFromOneDrive was silently skipped.
    await ensureFavorites();
    await ensureShares();

    // M12: set initial startup flag so the first pull can consider auto-redirect.
    // Consumed (set false) in pullMusicFolderFromOneDriveInner after the check.
    sync.setInitialStartup(true);

    // 3. Not signed in — show cached tree if available, else sign-in button.
    //    If cached data exists, fire off background sync (non-blocking) to
    //    attempt token refresh so playback works if we're actually online.
    if (!auth.isSignedIn()) {
        if (savedInfo) {
            const cached = await loadCachedData(savedInfo.driveId);
            if (cached) {
                sync.setCachedDataRef(cached);
                showTree(savedInfo, cached);
                log('showing cached index (offline)');
                await Promise.all([restorePlaybackState(), migrateBrowserFavoriteBookmarks().catch(logCatch('browser bookmark migration'))]);
                await sync.requestStartupPullIfEvidenceAllows();
                return;
            }
        }
        showSignIn();
        log('showing sign-in');
        return;
    }

    // 4. Signed in — show cached tree immediately, then sync with server
    log('signed in, loading data');
    const cachedData = savedInfo ? await loadCachedData(savedInfo.driveId) : undefined;
    sync.setCachedDataRef(cachedData);
    if (cachedData) {
        showTree(savedInfo!, cachedData);
        log(`showing cached: ${cachedData.count} tracks`);
        await Promise.all([restorePlaybackState(), migrateBrowserFavoriteBookmarks().catch(logCatch('browser bookmark migration'))]);
    } else if ((browserAuth?.reconcileEvidenceFromNavigator('startup:signed-in-no-cache-check') ?? auth.getEvidence()) === 'evidence:not-online') {
        log('startup: signed-in with no cache while evidence is not-online');
        startup.markStartupTerminalState('error');
        startup.renderStartupErrorIntoStatusAndWireReload(STARTUP_ERROR_MESSAGE);
        return;
    }

    await sync.requestStartupPullIfEvidenceAllows();
    if (!cachedData && !startup.isStartupTerminalUiRendered()) {
        log('startup: startup pull returned without terminal UI');
        startup.markStartupTerminalState('error');
        startup.renderStartupErrorIntoStatusAndWireReload(STARTUP_ERROR_MESSAGE);
    }
}

export async function onBodyLoad(): Promise<void> {
    await startup.onBodyLoad(startupInner);
}
