import { createAuth, isAbortError, type EvidenceState } from './auth.js';
import { dbGet, dbPut, dbClear } from './db.js';
import { log, logError, logCatch, errorDetail } from './logger.js';
import { initWebLogger } from './logger-web.js';
import {
    type MusicData, type AccountInfo, type IndexProgress,
} from './indexer.js';
import { createTree, type TreeView } from './tree.js';
import { createPlayback, type Playback, type PlaybackMode, isValidMode } from './playback.js';
import { createFavorites, type Favorites } from './favorites.js';
import { createSelect, type Select } from './select.js';
import { createDownloads, type Downloads, classifyOfflineBadgeState } from './downloads.js';
import { collectPhysicalTracks, resolveTrackIds } from './tracks.js';
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

initWebLogger();  // so that logger.ts will direct to the webpage

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

/** Maps evidence state to a glyph for the debug indicator on the OnePlay Music row. */
const EVIDENCE_GLYPHS: Record<EvidenceState, string> = {
    'no-evidence': '\u203D',          // ‽
    'evidence:signed-in': '\uD83D\uDD11',   // 🔑
    'evidence:signed-out': '\uD83D\uDD12',  // 🔒
    'evidence:not-online': '\uD83D\uDEAB',  // 🚫
};

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
    if (meta) meta.setAttribute('content', isDark ? '#1a1a1c' : '#f2efe5');
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
let restoredScroll: Record<string, {top: number, left: number}> | undefined;
let restoredPlayback: { folder: string[]; track: string[]; mode: string; favId?: string } | undefined;
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

const auth = createAuth();
auth.onEvidenceChange = (newState, prevState) => {
    log(`evidence: ${prevState} → ${newState}`);
    downloads?.handleEvidenceTransition();
    computeAndPushOfflineState();
    if (settings?.isOpen()) openSettingsPage();
};

// Tree view + playback + favorites (singletons)

let tree: TreeView | undefined;
let playback: Playback | undefined;
let favorites: Favorites | undefined;
let select: Select | undefined;
let downloads: Downloads | undefined;
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
        auth.signIn().catch(logCatch('sign-in button'));
    },
    renderIndexing: (progress) => renderIndexing(progress),
});

const sync = createIndexSync({
    auth,
    startupErrorMessage: STARTUP_ERROR_MESSAGE,
    accountData,
    getTree: () => tree,
    getPlayback: () => playback,
    getFavorites: () => favorites,
    getSelect: () => select,
    getSettings: () => settings,
    getShares: () => shares,
    ensureFavorites: () => ensureFavorites(),
    ensureShares: () => ensureShares(),
    showTree: (info, data, reindexing = false) => showTree(info, data, reindexing),
    showError: (message) => startup.showError(message),
    renderSignInButtonIntoStatus: () => startup.renderSignInButtonIntoStatus(),
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
    const snapshot = downloads?.getSnapshot();
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
}

/**
 * Debug-only action: corrupt both auth tokens and force signed-out evidence.
 * This is intentionally destructive and exists to exercise signed-out recovery paths.
 */
function corruptAuthTokensAndTransitionSignedOutForDebug(): void {
    const stamp = new Date().toISOString();
    localStorage.setItem('access_token', `null: debug evidence glyph corrupt access_token ${stamp}`);
    localStorage.setItem('refresh_token', `null: debug evidence glyph corrupt refresh_token ${stamp}`);
    logError(`debug: corrupted access_token and refresh_token via evidence glyph (${stamp})`);
    // "evidence:not-signed-in" from older naming is represented as evidence:signed-out.
    auth.transition('evidence:signed-out');
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
            await auth.signOut(async () => {
                localStorage.removeItem('account_info');
                clearM10State();
                sync.cancelScheduledPull();
                await downloads?.clear();
                await dbClear();
            });
        },
        onReconnect: () => {
            if (typeof hooks._testSettingsReconnect === 'function') return hooks._testSettingsReconnect();
            return auth.signIn();
        },
        onRefreshNow: () => {
            if (typeof hooks._testSettingsRefreshNow === 'function') return hooks._testSettingsRefreshNow();
            return sync.requestPullFromOneDrive('settings-refresh');
        },
        onAddShare: async (url, signal) => {
            const trimmedUrl = url.trim();
            log(`settings:add-share clicked url=${trimmedUrl}`);
            if (typeof hooks._testSettingsAddShare === 'function') {
                try {
                    await Promise.resolve(hooks._testSettingsAddShare(url, signal));
                    log('settings:add-share completed via test hook');
                    return;
                } catch (e) {
                    if (signal?.aborted || isAbortError(e)) {
                        log('settings:add-share aborted via test hook');
                    } else {
                        logError(`settings:add-share failed via test hook: ${errorDetail(e)}`);
                    }
                    throw e;
                }
            }
            if (!shares) return;
            try {
                const record = await shares.addFromUrl(url, signal);
                sync.onShareAdded(record);
                sync.requestPullFromOneDrive('settings-refresh').catch(logCatch('settings add share pull'));
                log(`settings:add-share success shareId=${record.shareId} rootKey=${record.rootKey}`);
            } catch (e) {
                if (signal?.aborted || isAbortError(e)) {
                    log('settings:add-share aborted');
                } else {
                    logError(`settings:add-share failed: ${errorDetail(e)}`);
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
            await shares.remove(id);
            await sync.onShareRemoved(record);
        },
        onTimerChange: (next) => {
            timerDuration = next;
            localStorage.setItem('oneplay_music_timer_duration', next);
            playback?.setTimerDuration(next);
        },
        onThemeChange: (next) => {
            themePreference = next;
            localStorage.setItem('oneplay_music_theme', next);
            applyTheme();
        },
        theme: themePreference,
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
            SW_DEBUG ? DEPLOY_COUNTER : '',
            SW_DEBUG ? EVIDENCE_GLYPHS : undefined);
        settings = createSettings(settingsEl);
        playback = createPlayback(
            document.getElementById('player') as HTMLAudioElement,
            document.getElementById('footer')!,
            auth.fetch,
        );
        playback.setTimerDuration(timerDuration);

        tree.onTrackClick = (path) => playback!.playTrack(path, accountData);
        tree.onPlayClick = (path) => { playback!.playFolder(path, accountData).catch(logCatch('playFolder')); };
        playback.onPlaybackChange = (info) => tree!.setPlaybackInfo(info);
        playback.onPlayBlockedNoPlayableTracks = () => {
            alert('No offline tracks are available here.');
        };
        playback.onChevronClick = () => {
            const info = playback!.getInfo();
            if (info) tree!.setSelectedPath(info.track.slice(0, -1));
        };

        // M10: persist view state on path or expanded changes
        tree.onPathChange = (path) => {
            try {
                const exp = playback!.getInfo() ? (document.getElementById('footer')!.classList.contains('expanded')) : false;
                localStorage.setItem('oneplay_music_view', JSON.stringify({ path, expanded: exp }));
            } catch { /* quota */ }
        };
        tree.onFavoriteRootTap = () => showFavoriteCustomizeToastOnce();
        playback.onExpandedChange = (exp) => {
            const path = tree!.getSelectedPath();
            try {
                localStorage.setItem('oneplay_music_view', JSON.stringify({ path, expanded: exp }));
            } catch { /* quota */ }
        };
        tree.onSettingsClick = () => openSettingsPage();
        tree.onShareWithoutDataTap = () => openSettingsPage();
        tree.onDebugEvidenceGlyphClick = () => corruptAuthTokensAndTransitionSignedOutForDebug();
        tree.onSearchOpen = () => {
            if (select?.isActive()) select.exitSelectMode();
            playback?.collapse();
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
    playback?.setTimerDuration(timerDuration);
    tree.setAccount(info.driveId, data.folder, info, reindexing);
    sync.syncShareRootsIntoTreeAndPlayback();

    // Wire favorites to tree + create select/downloads (idempotent).
    // Runs on every showTree since roots may have changed after setAccount.
    wireFavoritesUi();
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

function isPathDeniedByShare(
    path: readonly string[],
    deniedRootKeys: ReadonlySet<string>,
): boolean {
    if (deniedRootKeys.has(path[1])) return true;
    if (!favorites) return false;
    const favRoot = path[1];
    if (!favRoot?.startsWith('fav:')) return false;
    const favoritesById = new Map(favorites.getAll().map((fav) => [fav.id, fav]));

    const visit = (favId: string, subPath: readonly string[], visited: Set<string>): boolean => {
        if (visited.has(favId)) return false;
        visited.add(favId);
        const fav = favoritesById.get(favId);
        if (!fav) return false;
        if (fav.kind === 'shortcut') {
            return fav.target.sourceRootKey ? deniedRootKeys.has(fav.target.sourceRootKey) : false;
        }
        if (subPath.length === 0) return false;
        const m = subPath[0].match(/^m:(\\d+)$/);
        if (!m) return false;
        const idx = parseInt(m[1], 10);
        if (idx < 0 || idx >= fav.members.length) return false;
        const member = fav.members[idx];
        if ('favId' in member) return visit(member.favId, subPath.slice(1), new Set(visited));
        return member.sourceRootKey ? deniedRootKeys.has(member.sourceRootKey) : false;
    };

    return visit(favRoot.slice(4), path.slice(2), new Set());
}

function computeAndPushOfflineState(): void {
    if (!favorites || !tree || !downloads) return;
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
        (path) => isPathDeniedByShare(path, deniedRoots),
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
        favorites = createFavorites({ authFetch: auth.fetch, dbGet, dbPut }, () => {
            // onChange: sync favorite roots into tree and re-render
            if (tree) {
                tree.setFavorites(favorites!);
                if (select) select.setRoots(tree.getRoots());
                // Update playback context so logical path resolution uses fresh data
                if (playback) playback.setContext(favorites!, tree.getRoots());
                // Recompute offline state (favorites may have changed offlinePin)
                computeAndPushOfflineState();
            }
        });

        await favorites.loadFromCache();
    })();

    return ensureFavoritesPromise;
}

let ensureSharesPromise: Promise<void> | undefined;
async function ensureShares(): Promise<void> {
    if (ensureSharesPromise) return ensureSharesPromise;

    ensureSharesPromise = (async () => {
        shares = createShares({ authFetch: auth.fetch, dbGet, dbPut }, () => {
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
    if (playback) playback.setContext(favorites, tree.getRoots());
    if (select) select.setRoots(tree.getRoots());

    // Wire the select module (once, after tree + playback + favorites exist)
    if (!select) {
        const treeEl = document.getElementById('tree-container')!;
        const actionBarEl = document.getElementById('action-bar')!;
        const cancelBtnEl = document.getElementById('select-cancel')!;

        select = createSelect(treeEl, actionBarEl, cancelBtnEl, favorites, tree, tree.getRoots());

        select.onEnterSelect = () => {
            playback!.collapse();
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
    if (!downloads) {
        downloads = createDownloads({
            authFetch: auth.fetch,
            getEvidence: () => auth.getEvidence(),
            provideEvidenceFromHttpStatus: (status, reason) => auth.provideEvidenceFromHttpStatus(status, reason),
            provideEvidenceFromError: (error, reason) => auth.provideEvidenceFromError(error, reason),
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

function restorePlaybackState(): void {
    if (!restoredPlayback || !playback || !tree) return;
    const { folder, track, mode, favId } = restoredPlayback;
    if (!Array.isArray(folder) || !Array.isArray(track)) return;
    const validMode: PlaybackMode = isValidMode(mode) ? mode : 'all';
    const time = typeof restoredTime === 'number' && restoredTime > 0 ? restoredTime : 0;
    const expandedState = restoredView?.expanded ?? false;

    log(`M10 restore: folder=${folder.join('/')}, track=${track[track.length - 1]}, mode=${validMode}, time=${Math.round(time)}s`);
    playback.restoreVisualState(folder, track, validMode, expandedState, time, favId, accountData);

    // Clear restored state so it's not applied again on re-init
    restoredPlayback = undefined;
    restoredTime = undefined;
}

// Main entry point

async function startupInner(): Promise<void> {

    // M10: Read persisted UI state synchronously before first render.
    // These are module-scoped so showTree() can pass them to createTree().
    restoredView = readJson<{ path: string[]; expanded: boolean }>('oneplay_music_view');
    restoredScroll = readJson<Record<string, {top: number, left: number}>>('oneplay_music_scroll');
    restoredPlayback = readJson<{ folder: string[]; track: string[]; mode: string; favId?: string }>('oneplay_music_playback');
    restoredTime = (() => {
        const raw = localStorage.getItem('oneplay_music_time');
        return raw !== null ? parseFloat(raw) : undefined;
    })();
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
    auth.reconcileEvidenceFromNavigator('startup:init', { logUnchanged: true });

    // -- M11b: online/offline event listeners (wired early, before any pull) --
    window.addEventListener('offline', () => {
        auth.reconcileEvidenceFromNavigator('window:offline');
        sync.cancelScheduledPull();
    });
    window.addEventListener('online', () => {
        auth.reconcileEvidenceFromNavigator('window:online');
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
            const after = auth.reconcileEvidenceFromNavigator('document:visibilitychange');
            if (before === 'evidence:not-online' && after !== 'evidence:not-online') {
                sync.requestPullFromOneDrive('online').catch(logCatch('visible pull'));
            }
        }
    });
    // If the app starts with stale evidence while hidden lifecycle events were missed,
    // reconcile once more at first visible opportunity before any startup pull gate.
    if (document.visibilityState === 'visible') {
        const before = auth.getEvidence();
        const after = auth.reconcileEvidenceFromNavigator('startup:visible');
        if (before === 'evidence:not-online' && after !== 'evidence:not-online') {
            sync.requestPullFromOneDrive('online').catch(logCatch('visible pull'));
        }
    }
    // Re-apply theme when OS preference changes (only matters when themePreference === 'auto')
    matchMedia('(prefers-color-scheme:dark)').addEventListener('change', () => applyTheme());

    // 1. Process OAuth redirect (if any)
    const authResult = await auth.handleOauthRedirect();
    if (authResult.error) logError(`auth error: ${authResult.error}`);

    // --- Service worker registration (before any early returns so offline
    //     shell caching works for signed-out/first-time users too) ---
    //     Deferred to `load` event: on fresh Chromium profiles, the SW provider
    //     may not be ready at DOMContentLoaded time (especially in headless-shell),
    //     causing InvalidStateError. The `load` event fires after subresources
    //     are loaded, by which time the provider is always initialized.
    const registerSw = (): void => {
        if (!('serviceWorker' in navigator)) return;
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
                restorePlaybackState();
                await sync.requestStartupPullIfEvidenceAllows();
                return;
            }
        }
        startup.renderSignInButtonIntoStatus();
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
        restorePlaybackState();
    } else if (auth.reconcileEvidenceFromNavigator('startup:signed-in-no-cache-check') === 'evidence:not-online') {
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
