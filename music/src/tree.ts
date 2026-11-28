/**
 * Hierarchical tree view component for OnePlay Music.
 *
 * Renders a breadcrumb + children split view of the music library. Only the
 * breadcrumb trail (O(depth)) and the current folder's immediate children are
 * in the DOM at any time — O(1) for a 30k-track library.
 *
 * STATE MODEL:
 * - `roots`: Map keyed by root key, where each entry is a Root (OneDrive
 *   account, shortcut, or playlist). OneDrive accounts use driveId as key;
 *   favorites use "fav:" + uuid. Code dispatches on roots.get(key)?.type,
 *   never on key prefix.
 * - `selectedPath`: FolderPath identifying the currently expanded folder.
 *   ["OnePlay Music"] is the virtual app root; ["OnePlay Music", rootKey] is a root;
 *   deeper segments walk MusicFolder.children or playlist members.
 * - `playbackInfo`: current playback state from playback.ts, used to render
 *   track indicators, playback-folder highlighting, and the ▷/▶ play glyph.
 * - `favoritesRef`: optional reference to the Favorites module, used for
 *   resolving children inside favorites and display names.
 *
 * INVARIANTS:
 * - selectedPath always starts with "OnePlay Music".
 * - selectedPath[1] (if present) is always a key in the `roots` map, or else
 *   resolveFolderAndRepairSelection resets to the deepest valid prefix.
 * - In normal mode, render() is the sole function that mutates the DOM
 *   subtrees of breadcrumbsEl and childrenEl. In search mode, DOM writes are
 *   isolated to renderSearchHeader() and renderSearchResultsRows().
 * - All event callbacks (onTrackClick, onPlayClick, onSettingsClick) are set by the
 *   wiring code in index.ts; they default to no-ops.
 * - Root display order at app root: favorites first (in array order), then
 *   OneDrive accounts (sorted by key).
 */

import { type MusicFolder, type AccountInfo, isMusicFolder, sortedFolderChildren } from './indexer.js';
import { type PlaybackInfo } from './playback.js';
import { type RootsMap, type Favorite, type Favorites, type FolderPin, isFavRef } from './favorites.js';
import { type EvidenceState } from './auth.js';
import { type SearchResult } from './search.js';
import { folderPinPathKey, isPathDeniedByShare, solePrimaryLibraryKey } from './roots.js';
import { resolvePathTailDisplayName } from './path-names.js';

/** Appends the shared spinner glyph (⟳) used by sync and reindex states. */
function addSpinner(parent: HTMLElement): void {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.classList.add('sync-spinner');
    svg.innerHTML = '<circle cx="8" cy="8" r="5"/>';
    parent.appendChild(svg);
}

/** Paint the same compact arrow in the trail, child list and offline details.
 * The pause bar and arrow share a viewBox, independently of text line height. */
export function setOfflineBadge(badge: HTMLElement, state: OfflineBadgeState | undefined, partial = false): void {
    badge.replaceChildren();
    badge.className = state ? 'offline-badge ' + state + (partial ? ' partial' : '') : '';
    if (!state) return;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('role', 'img');
    const status = state === 'paused' ? 'Downloads paused' : state === 'downloading' ? 'Downloading' : 'Marked for offline';
    svg.setAttribute('aria-label', partial ? 'Some subfolders marked for offline. ' + status : status);
    // The rounded stroke extends 0.8 units past the arrow vertex to the baseline at y=12.
    // Place individual dots on the centerline and in mirrored pairs. Dashing a V
    // continuously offsets the dots on its second arm by the length of the first.
    const arrow = partial
        ? '<path d="M8 1.6h0 M8 4.8h0 M8 8h0 M8 11.2h0 M4 7.2h0 M12 7.2h0 M6 9.2h0 M10 9.2h0"/>'
        : '<path d="M8 1.5v9.7M4 7.2l4 4 4-4"/>';
    svg.innerHTML = arrow + (state === 'paused' ? '<path d="M3.5 14h9"/>' : '');
    badge.appendChild(svg);
}

/** Key prefix for favorite roots in the RootsMap. */
const FAV_PREFIX = 'fav:';

/** Debug shows an evidence badge only while sign-in is unconfirmed. */
const DEBUG_EVIDENCE_BADGES = {
    'no-evidence': { icon: '‽', label: 'OneDrive sign-in status unknown' },
    'evidence:signed-out': { icon: '🔒', label: 'OneDrive signed out' },
    'evidence:not-online': { icon: '🚫', label: 'Offline' },
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Path from root to a folder. ["OnePlay Music"] is the app root. */
export type FolderPath = readonly string[];
type OfflineBadgeState = 'complete' | 'downloading' | 'paused';
type OfflineIcons = ReadonlyMap<string, OfflineBadgeState>;
type FolderIcons = ReadonlyMap<string, {partial: boolean; state: OfflineBadgeState}>;

/** Public API returned by createTree. */
export interface TreeView {
    /** Add/update an account's data. Key is driveId; displayName comes from info. */
    setAccount(key: string, folder: MusicFolder, info: AccountInfo, reindexing?: boolean): void;
    /** Install the account-free primary library. */
    setDemoRoot(folder: MusicFolder, key: string): void;
    /** Wire the favorites module. Converts favorites to roots and renders. */
    setFavorites(favs: Favorites): void;
    /** Replaces all share roots in insertion order. */
    setShareRoots(shares: ReadonlyArray<{
        key: string;
        connectionId: string;
        name: string;
        driveId: string;
        folder?: MusicFolder;
        reindexing: boolean;
    }>): void;
    /** Get the roots map (for passing to favorites.resolveChildren). */
    getRoots(): RootsMap;
    /** Get current selected path (for future state persistence). */
    getSelectedPath(): FolderPath;
    /** Set selected path programmatically (for future state restoration). */
    setSelectedPath(path: FolderPath): void;
    /** Opens the track's logical parent and scrolls its row into view if needed. */
    revealTrack(path: FolderPath): void;
    /** Update playback indicators (track SVG, folder highlighting, play glyph). */
    setPlaybackInfo(info: PlaybackInfo | undefined, advanced?: boolean): void;
    /** Update select mode rendering state. Checkboxes appear on selectable rows
     *  when active; selectedPaths uses JSON.stringify(path) as keys. */
    setSelectMode(active: boolean, selectedPaths: ReadonlySet<string>): void;
    /** Called when user clicks a track (file). */
    onTrackClick: (path: FolderPath) => void;
    /** Called when user clicks the play button on selected folder. */
    onPlayClick: (path: FolderPath) => void;
    /** Called when user clicks the menu/warning icon on the OnePlay Music row. */
    onSettingsClick: () => void;
    /** Called when user taps a share root row with no loaded folder data. */
    onShareWithoutDataTap: (path: FolderPath) => void;
    /** Called when user clicks a row in select mode. Wired by index.ts. */
    onSelectToggle: (path: FolderPath) => void;
    /** Called when breadcrumb navigation exits select mode (clears stale selections). */
    onSelectExit: () => void;
    /** Called when user taps a top-level favorite row. */
    onFavoriteRootTap: (path: FolderPath) => void;
    /** Called on every selectedPath change (folder click, breadcrumb, setSelectedPath).
     *  Wired by index.ts to persist oneplay_music_view to localStorage. */
    onPathChange: (path: FolderPath) => void;
    /** Physical icons use the same scoped path for a marked folder and its ancestors. */
    setOfflineIcons(favorites: OfflineIcons, folders?: FolderIcons): void;
    /** The selection menu shares the tree's definition of coverage. */
    getFolderOfflineState(folder: FolderPin): {coverage: 'none' | 'explicit' | 'partial' | 'covered'; badge?: OfflineBadgeState};
    /** Set syncing state (⟳ spinner on OnePlay Music row). */
    setSyncing(value: boolean): void;
    /** Toggle the build number on the OnePlay Music row. */
    setDebugEnabled(value: boolean): void;
    /** Set evidence state and cache-check callback for track greying.
     *  When signed-out or not-online, non-cached tracks are greyed and unclickable. */
    setEvidence(state: EvidenceState, isTrackCached: (path: FolderPath) => boolean): void;
    /** Sets denied share root keys (for warning icon and unavailable tracks). */
    setDeniedRootKeys(keys: ReadonlySet<string>): void;
    /** Sets warning-icon state for latest index failure. */
    setIndexFailureWarning(value: boolean): void;
    /** Re-render the tree view. Used by downloads.onStateChange. */
    render(): void;
    /** Opens search mode and restores in-memory query + scroll state. */
    openSearchMode(query: string, scrollTop: number): void;
    /** Closes search mode and returns to normal tree rendering. */
    closeSearchMode(): void;
    /** Pushes latest search results into the tree search results list. */
    setSearchResults(results: readonly SearchResult[], capped: boolean): void;
    /** True while tree is in search mode. */
    isSearchModeOpen(): boolean;
    /** Called when the top-row search icon is clicked. */
    onSearchOpen: () => void;
    /** Called when the search mode close button is clicked. */
    onSearchClose: (query: string, scrollTop: number) => void;
    /** Called whenever the search query changes. */
    onSearchQueryChange: (query: string) => void;
    /** Called when the user clicks a search result row. */
    onSearchResultClick: (result: SearchResult) => void;
}

/** The home crumb can represent an account prefix while retaining its root actions. */
interface RowOptions {
    readonly isFolder: boolean;
    readonly isBreadcrumb: boolean;
    readonly path: FolderPath;
    /** For selected-folder breadcrumbs: whether to show the play button. */
    readonly showPlayButton?: boolean;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates the tree view component. Finds #breadcrumbs and #children inside
 * the given container. Returns the public TreeView API.
 *
 * @param initialPath - Restored folder path from localStorage (M10 state persistence).
 *   Validated: must start with "OnePlay Music". Falls back to ["OnePlay Music"] if invalid.
 * @param initialScrollMap - Restored scroll positions keyed by JSON.stringify(path).
 *   Used to restore scroll position after render.
 * @param deployCounter - Deploy counter string shown as "OnePlay Music{N}" in the header
 *   only when debug mode is enabled. Empty string = plain "OnePlay Music".
 * @param saveScroll - Stores the current workspace's scroll positions while it is admitted.
 */
export function createTree(
    container: HTMLElement,
    initialPath?: FolderPath,
    initialScrollMap?: Record<string, {top: number}>,
    deployCounter = '',
    saveScroll?: (scroll: Record<string, {top: number}>) => void,
): TreeView {
    const breadcrumbsEl = container.querySelector<HTMLElement>('#breadcrumbs')!;
    const childrenEl = container.querySelector<HTMLElement>('#children')!;
    const trackRow = (path: FolderPath) => childrenEl.querySelector<HTMLElement>(
        `.tree-row.file[data-path="${CSS.escape(JSON.stringify(path))}"]`);
    const trail = document.createElement('div');
    trail.className = 'folder-trail';
    const search = document.createElement('button');
    search.type = 'button';
    search.className = 'row-icon row-icon-search';
    search.setAttribute('aria-label', 'Search music');
    search.appendChild(createSearchIconSvg());
    search.onclick = () => view.onSearchOpen();

    // -- State ---------------------------------------------------------------

    const roots: RootsMap = new Map();
    let favoritesRef: Favorites | undefined;
    let favoritesById = new Map<string, Favorite>();
    let selectedPath: FolderPath = initialPath && initialPath.length >= 1 && initialPath[0] === 'OnePlay Music'
        ? initialPath : ['OnePlay Music'];
    let playbackInfo: PlaybackInfo | undefined;

    // -- Scroll position tracking (M10) --------------------------------------
    // INVARIANT: scrollMap stores the vertical offset per folder path. Populated from
    // initialScrollMap on startup. Updated on scroll events (rAF-throttled).
    // Capped at 100 entries; oldest entries trimmed on save.

    const scrollMap = new Map<string, {top: number}>(
        initialScrollMap ? Object.entries(initialScrollMap) : [],
    );
    let scrollRafPending = false;
    // A restored bottom offset can be temporarily above the current maximum
    // while the native player is still preparing its first footer.
    let clampedInitialScroll: { readonly top: number; readonly applied: number } | undefined;
    /** Physical or logical folder whose children were last drawn and own the scroll offset. */
    let previousPath: FolderPath | undefined;
    /** Timeout id that clears temporary inline overflow used during FLIP. */
    let restoreOverflowTimeout: number | undefined;
    /** Capture the list while it still owns the viewport, including navigation before the next scroll frame. */
    function rememberListScroll(): void {
        if (!previousPath || container.hidden || !childrenEl.childElementCount) return;
        const top = childrenEl.scrollTop;
        if (clampedInitialScroll?.applied === top) return;
        clampedInitialScroll = undefined;
        scrollMap.set(JSON.stringify(previousPath), {top});
        if (scrollMap.size > 100) scrollMap.delete(scrollMap.keys().next().value!);
    }

    /** Test-only FLIP-settled sequence for integration tests. */
    const bumpTestTreeFlipSeq = (): void => {
        const w = window as unknown as Record<string, unknown>;
        const current = typeof w._testTreeFlipSeq === 'number' ? w._testTreeFlipSeq as number : 0;
        w._testTreeFlipSeq = current + 1;
    };

    // Select mode state: when active, selectable rows (children + breadcrumbs,
    // excluding OnePlay Music and account roots) show checkboxes and clicks toggle
    // selection instead of navigating.
    let selectModeActive = false;
    let selectModePaths: ReadonlySet<string> = new Set();

    let offlineIcons: OfflineIcons = new Map();
    let folderIcons: FolderIcons = new Map();

    // Syncing state: when true, ⟳ spinner shows on OnePlay Music row.
    let isSyncing = false;
    // Debug mode shows the build number after OnePlay.
    let debugEnabled = false;

    // Evidence state for track greying (set via setEvidence from orchestrator).
    // When signed-out or not-online, non-cached tracks get CSS class 'unavailable'
    // and their click handler is a no-op.
    let evidence: EvidenceState = 'no-evidence';
    let isTrackCachedFn: (path: FolderPath) => boolean = () => false;
    let deniedRootKeys: ReadonlySet<string> = new Set();
    let hasIndexFailureWarning = false;
    let searchModeOpen = false;
    let searchQuery = '';
    let searchResults: readonly SearchResult[] = [];
    let searchCapped = false;
    let searchResultsScrollTop = 0;

    // -- Path helpers --------------------------------------------------------

    /** True if two paths are identical (same length, same segments). */
    const pathEquals = (a: FolderPath, b: FolderPath): boolean =>
        a.length === b.length && a.every((s, i) => s === b[i]);

    /** Tree rows and search results show the same selection marker. */
    const addSelectionMarker = (row: HTMLElement): void => {
        row.classList.add('selectable');
        if (!selectModeActive) return;
        const isChecked = selectModePaths.has(row.dataset.path!);
        const check = document.createElement('span');
        check.className = 'select-check' + (isChecked ? ' checked' : '');
        check.setAttribute('aria-hidden', 'true');
        row.setAttribute('role', 'checkbox');
        row.setAttribute('aria-checked', String(isChecked));
        check.textContent = isChecked ? '\u2713' : '';
        row.prepend(check);
    };

    /** Builds one search-result row using existing tree row classes. */
    const makeSearchResultRow = (result: SearchResult): HTMLElement => {
        const isFolder = result.kind === 'favorite' || result.kind === 'folder';
        const row = document.createElement('div');
        row.className = `tree-row ${isFolder ? 'folder' : 'file'}`;
        row.dataset.path = JSON.stringify(result.path);
        addSelectionMarker(row);

        const name = document.createElement('span');
        name.className = 'row-name';
        name.textContent = result.name;
        row.appendChild(name);

        if (result.kind === 'favorite') {
            const root = roots.get(result.path[1]);
            const favIcon = document.createElement('span');
            favIcon.className = 'fav-icon';
            favIcon.textContent = '\u2002' + (root?.type === 'playlist' ? '♫' : '☆');
            row.appendChild(favIcon);
        }

        row.addEventListener('click', () => {
            if (selectModeActive) view.onSelectToggle(result.path);
            else view.onSearchResultClick(result);
        });
        return row;
    };

    /** Renders search results list + optional cap row. */
    const renderSearchResultsRows = (): void => {
        if (!searchModeOpen) return;
        const rows = searchResults.map(makeSearchResultRow);
        if (searchCapped) {
            const cap = document.createElement('div');
            cap.className = 'search-cap-row';
            cap.textContent = '[Only showing first 500 results]';
            rows.push(cap);
        }
        childrenEl.replaceChildren(...rows);
        childrenEl.scrollTop = searchResultsScrollTop;
    };

    /** Creates a plain magnifier icon with deterministic shape across platforms. */
    function createSearchIconSvg(): SVGSVGElement {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('aria-hidden', 'true');
        const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        circle.setAttribute('cx', '11');
        circle.setAttribute('cy', '11');
        circle.setAttribute('r', '7');
        const handle = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        handle.setAttribute('d', 'M20 20l-4.35-4.35');
        svg.append(circle, handle);
        return svg;
    }

    /** Renders the pinned search header row in #breadcrumbs. */
    const renderSearchHeader = (focusInput: boolean): void => {
        const header = document.createElement('div');
        header.className = 'search-header';

        const pill = document.createElement('div');
        pill.className = 'search-pill';

        const pillIcon = document.createElement('span');
        pillIcon.className = 'search-pill-icon';
        pillIcon.appendChild(createSearchIconSvg());

        const input = document.createElement('input');
        input.type = 'search';
        input.className = 'search-input';
        input.placeholder = 'Search your library...';
        input.autocomplete = 'off';
        input.value = searchQuery;
        const clearBtn = document.createElement('button');
        clearBtn.type = 'button';
        clearBtn.className = 'search-pill-clear';
        clearBtn.setAttribute('aria-label', 'Clear search query');
        clearBtn.textContent = '×';
        clearBtn.hidden = input.value.length === 0;
        const updateClearButtonVisibility = (): void => {
            clearBtn.hidden = input.value.length === 0;
        };
        input.addEventListener('input', () => {
            searchQuery = input.value;
            searchResultsScrollTop = 0;
            updateClearButtonVisibility();
            view.onSearchQueryChange(searchQuery);
        });
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') view.closeSearchMode();
        });
        clearBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (input.value.length === 0) return;
            input.value = '';
            searchQuery = '';
            searchResultsScrollTop = 0;
            updateClearButtonVisibility();
            view.onSearchQueryChange(searchQuery);
            input.focus({ preventScroll: true });
        });
        pill.addEventListener('click', () => input.focus({ preventScroll: true }));

        pill.append(pillIcon, input, clearBtn);

        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'search-close';
        closeBtn.textContent = '×';
        closeBtn.addEventListener('click', () => view.closeSearchMode());

        header.append(pill, closeBtn);
        breadcrumbsEl.replaceChildren(header);
        if (focusInput) {
            input.focus({ preventScroll: true });
            const end = input.value.length;
            input.setSelectionRange(end, end);
        }
    };

    // -- Favorites → roots sync ----------------------------------------------

    /** Rebuilds favorite roots from the favorites module. Called on
     *  setFavorites and whenever favorites mutate (via onChange callback). */
    const syncFavoriteRoots = (): void => {
        if (!favoritesRef) return;
        const currentFavorites = favoritesRef.getAll();
        favoritesById = new Map(currentFavorites.map((fav) => [fav.id, fav]));
        // Remove old favorite roots
        for (const [key, root] of roots) {
            if (root.type === 'shortcut' || root.type === 'playlist') roots.delete(key);
        }
        // Add current favorites
        for (const fav of currentFavorites) {
            const key = `${FAV_PREFIX}${fav.id}`;
            if (fav.kind === 'shortcut') {
                roots.set(key, { type: 'shortcut', key, name: fav.name, target: fav.target });
            } else {
                roots.set(key, { type: 'playlist', key, name: fav.name, members: fav.members });
            }
        }
    };

    // -- Callbacks (wired by index.ts) ---------------------------------------

    const view: TreeView = {
        setAccount(key, folder, info, reindexing = false) {
            roots.set(key, { type: 'onedrive', key, name: info.displayName, folder, info, reindexing });
            render();
        },
        setDemoRoot(folder, key) {
            roots.set(key, {type: 'demo', key, name: 'Demo library', driveId: key, folder});
            render();
        },
        setFavorites(favs) {
            favoritesRef = favs;
            syncFavoriteRoots();
            render();
        },
        setShareRoots(shares) {
            for (const [key, root] of roots) {
                if (root.type === 'share') roots.delete(key);
            }
            for (const share of shares) {
                roots.set(share.key, { type: 'share', ...share });
            }
            render();
        },
        getRoots: () => roots,
        getSelectedPath: () => selectedPath,
        setSelectedPath(path) {
            // Enforce invariant: selectedPath must start with "OnePlay Music".
            const requested = path[0] === 'OnePlay Music' ? path : ['OnePlay Music'];
            selectedPath = requested;
            render();
            // render already published any correction, including a folded bare account.
            if (selectedPath === requested) view.onPathChange(selectedPath);
        },
        revealTrack(path) {
            // A folder transition can temporarily unclip the list, disabling scrolling.
            childrenEl.style.overflow = '';
            const parent = path.slice(0, -1);
            if (!pathEquals(parent, previousPath ?? selectedPath)) view.setSelectedPath(parent);
            view.closeSearchMode();
            trackRow(path)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        },
        setPlaybackInfo(info, advanced = false) {
            // Sample the outgoing row before render replaces it. The children list is clipped
            // by the breadcrumbs and drawer. A covered row cannot grant permission to navigate.
            const row = advanced && info && playbackInfo && !pathEquals(info.track, playbackInfo.track)
                && !searchModeOpen && !selectModeActive && !document.querySelector('.modal-backdrop, .action-dropdown')
                ? trackRow(playbackInfo.track) : undefined;
            let follow = false;
            if (row) {
                const bounds = row.getBoundingClientRect();
                const list = childrenEl.getBoundingClientRect();
                const top = Math.max(bounds.top, list.top, 0);
                const logTop = document.querySelector('#log-panel.visible')?.getBoundingClientRect().top;
                follow = top < Math.min(bounds.bottom, list.bottom, logTop ?? window.innerHeight);
            }
            playbackInfo = info;
            render();
            if (follow && info) view.revealTrack(info.track);
        },
        setSelectMode(active, paths) {
            selectModeActive = active;
            selectModePaths = paths;
            if (searchModeOpen) {
                searchResultsScrollTop = childrenEl.scrollTop;
                renderSearchResultsRows();
            } else render();
        },
        onTrackClick: (_path) => {},
        onPlayClick: (_path) => {},
        onSettingsClick: () => {},
        onShareWithoutDataTap: (_path) => {},
        onSelectToggle: (_path) => {},
        onSelectExit: () => {},
        onFavoriteRootTap: (_path) => {},
        onPathChange: (_path) => {},
        setOfflineIcons(favorites, folders = new Map()) {
            offlineIcons = favorites;
            folderIcons = folders;
        },
        getFolderOfflineState({sourceRootKey, connectionId, path}) {
            const key = folderPinPathKey(sourceRootKey, connectionId, path);
            const icon = folderIcons.get(key);
            if (icon) return {coverage: icon.partial ? 'partial' : 'explicit', badge:icon.state};
            for (let end = path.length - 1; end > 0; end--) {
                const ancestor = folderIcons.get(folderPinPathKey(sourceRootKey, connectionId, path.slice(0, end)));
                if (ancestor && !ancestor.partial) return {coverage:'covered'};
            }
            return {coverage:'none'};
        },
        setSyncing(value) { isSyncing = value; render(); },
        setDebugEnabled(value) { debugEnabled = value; render(); },
        setEvidence(state, isTrackCached) {
            evidence = state;
            isTrackCachedFn = isTrackCached;
            // No render() here — caller (computeAndPushOfflineState) controls
            // render timing to avoid double-render.
        },
        setDeniedRootKeys(keys) {
            deniedRootKeys = keys;
            render();
        },
        setIndexFailureWarning(value) {
            hasIndexFailureWarning = value;
            render();
        },
        render() { render(); },
        openSearchMode(query, scrollTop) {
            // Search takes ownership of the list. Its scroll offset belongs to its results.
            rememberListScroll();
            previousPath = undefined;
            searchModeOpen = true;
            searchQuery = query;
            searchResultsScrollTop = Math.max(0, scrollTop);
            renderSearchHeader(true);
            renderSearchResultsRows();
        },
        closeSearchMode() {
            if (!searchModeOpen) return;
            searchModeOpen = false;
            view.onSearchClose(searchQuery, searchResultsScrollTop);
            render();
        },
        setSearchResults(results, capped) {
            searchResults = results;
            searchCapped = capped;
            renderSearchResultsRows();
        },
        isSearchModeOpen: () => searchModeOpen,
        onSearchOpen: () => {},
        onSearchClose: (_query, _scrollTop) => {},
        onSearchQueryChange: (_query) => {},
        onSearchResultClick: (_result) => {},
    };

    // -- resolveFolderAndRepairSelection -------------------------------------------------------

    /**
     * Resolves selectedPath to the list of child entries to display.
     * Returns [segment, isFolder] pairs sorted folders-first then alphabetically.
     * If the path is broken (folder deleted during re-index), resets
     * selectedPath to the deepest valid prefix and returns those children.
     *
     * Three cases:
     * 1. App root with multiple roots: list favorites first
     *    (in array order), then OneDrive accounts (sorted by key).
     * 2. Root is shortcut/playlist: delegate to favorites.resolveChildren.
     * 3. Root is OneDrive account: walk MusicFolder tree (existing logic).
     */
    function resolveFolderAndRepairSelection(homeLibrary: string | undefined): Array<[string, boolean]> {
        // App root: list all roots — favorites first, then accounts sorted
        const rootKey = selectedPath[1] ?? homeLibrary;
        if (rootKey === undefined) {
            const favKeys: Array<[string, boolean]> = [];
            const accountKeys: Array<[string, boolean]> = [];
            const shareKeys: Array<[string, boolean]> = [];
            for (const [key, root] of roots) {
                if (root.type === 'onedrive' || root.type === 'demo') {
                    accountKeys.push([key, true]);
                } else if (root.type === 'share') {
                    shareKeys.push([key, true]);
                } else {
                    favKeys.push([key, true]);
                }
            }
            accountKeys.sort((a, b) => a[0].localeCompare(b[0]));
            return [...favKeys, ...accountKeys, ...shareKeys];
        }

        // Root level
        const root = roots.get(rootKey);
        if (!root) {
            // If data hasn't loaded yet for this root, don't reset — return
            // empty children and wait for setAccount/setFavorites to re-render.
            // Favorites: not loaded until setFavorites(). Accounts: not loaded
            // until setAccount(). Both cases: roots map won't have the key yet.
            if (rootKey.startsWith(FAV_PREFIX) ? !favoritesRef : roots.size === 0) return [];
            selectedPath = ['OnePlay Music'];
            return resolveFolderAndRepairSelection(homeLibrary);
        }

        // Favorites: delegate to favorites module
        if (root.type === 'shortcut' || root.type === 'playlist') {
            if (!favoritesRef) return [];
            const favId = rootKey.slice(FAV_PREFIX.length);
            const subPath = selectedPath.slice(2);
            const result = favoritesRef.resolveChildren(favId, subPath, roots);
            if (result === undefined) {
                // Broken path — reset to deepest valid prefix
                if (selectedPath.length > 2) {
                    selectedPath = selectedPath.slice(0, -1);
                    return resolveFolderAndRepairSelection(homeLibrary);
                }
                return [];
            }
            return result;
        }

        // OneDrive/share root: walk MusicFolder tree if loaded.
        if (!root.folder) return [];
        let current: MusicFolder = root.folder;
        for (let i = 2; i < selectedPath.length; i++) {
            const child = current.children[selectedPath[i]];
            if (!child || !isMusicFolder(child)) {
                // Path is broken — reset to deepest valid prefix
                selectedPath = selectedPath.slice(0, i);
                return resolveFolderAndRepairSelection(homeLibrary);
            }
            current = child;
        }

        // Sort children: folders first, then alphabetical within each group
        return sortedFolderChildren(current);
    }

    // -- makeRow -------------------------------------------------------------

    const bindRowPrimaryClick = (
        el: HTMLElement,
        opts: RowOptions,
        isSelectableRow: boolean,
        isUnavailable: boolean,
        isFavoriteRoot: boolean,
        isShareWithoutData: boolean,
    ): void => {
        if (isUnavailable) {
            el.classList.add('unavailable');
        }
        if (selectModeActive && isSelectableRow) {
            el.addEventListener('click', () => view.onSelectToggle(opts.path));
            return;
        }
        if (selectModeActive || isUnavailable) return;
        if (opts.isFolder) {
            if (isShareWithoutData) {
                el.addEventListener('click', () => view.onShareWithoutDataTap(opts.path));
                return;
            }
            // Folders navigate into children.
            // Clicking the already-selected folder is a no-op (avoids flicker).
            el.addEventListener('click', () => {
                if (pathEquals(opts.path, selectedPath)) return;
                selectedPath = opts.path;
                if (isFavoriteRoot) view.onFavoriteRootTap(opts.path);
                // Breadcrumb navigation in select mode exits select (stale selections
                // reference the old folder's children and must not remain actionable).
                // Note: onSelectExit → exitSelectMode → setSelectMode → render(),
                // then render(true) below fires a second animated render. The first
                // is wasted but harmless (browser coalesces paints).
                if (selectModeActive) {
                    selectModeActive = false;
                    selectModePaths = new Set();
                    view.onSelectExit();
                }
                render(true);
                view.onPathChange(selectedPath);
            });
            return;
        }
        el.addEventListener('click', () => {
            view.onTrackClick(opts.path);
        });
    };

    /**
     * Creates a single tree row element. Used for both breadcrumb rows and
     * child rows. The first visible crumb owns the home controls.
     *
     * At depth 2, dispatches on root type:
     * - 'onedrive': displays "OneDrive", optional re-index spinner
     * - 'shortcut': displays root.name with ☆ icon
     * - 'playlist': displays root.name with ♫ icon
     */
    function makeRow(opts: RowOptions): HTMLElement {
        const depth = opts.path.length;
        const isAppRoot = depth === 1;
        const isSelected = opts.isBreadcrumb && depth === selectedPath.length;

        // Root type dispatch at depth 2
        // The OnePlay crumb always navigates home. A sole account supplies its source indicators.
        const rootKey = isAppRoot ? solePrimaryLibraryKey(roots) : opts.path[1];
        const rootEntry = rootKey === undefined ? undefined : roots.get(rootKey);
        const rootType = rootEntry?.type;
        const isAccount = depth === 2 && (rootType === 'onedrive' || rootType === 'demo');
        const isShareRoot = depth === 2 && rootType === 'share';
        const isShareWithoutData = isShareRoot && rootEntry?.type === 'share' && rootEntry.folder === undefined;
        const isFavoriteRoot = depth === 2 && (rootType === 'shortcut' || rootType === 'playlist');

        // Playback state flags, derived from playbackInfo
        const isPlaybackFolder = playbackInfo !== undefined && pathEquals(opts.path, playbackInfo.folder);
        const isCurrentTrack = playbackInfo !== undefined && pathEquals(opts.path, playbackInfo.track);

        const el = document.createElement('div');
        el.className = 'tree-row'
            + (opts.isFolder ? ' folder' : ' file')
            + (isSelected ? ' selected' : '')
            + (opts.isBreadcrumb ? ' crumb' : '')
            + (isAppRoot ? ' app-root' : '');
        el.dataset.path = JSON.stringify(opts.path);

        // Select mode checkbox: shown on selectable rows only.
        // Non-selectable rows are app root and account roots.
        const isSelectableRow = !isAppRoot && !isAccount && !isShareRoot;
        if (isSelectableRow) addSelectionMarker(el);

        // Current track SVG indicator: chevron > (loaded) or spinner ⟳ (loading).
        // Prepended before text so it appears at the row's left edge.
        // CSS :has(> .track-indicator) reduces padding to accommodate the SVG width.
        // Suppressed in select mode: checkboxes occupy the left gutter instead.
        if (isCurrentTrack && !selectModeActive) {
            const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.setAttribute('viewBox', '0 0 21 21');
            svg.classList.add('track-indicator', playbackInfo!.phase);
            svg.innerHTML = '<path d="M5 4 L11 11 L5 18"/><circle cx="12" cy="11" r="6"/>';
            el.appendChild(svg);
        }

        // Display name:
        // - Account rows show "OneDrive" (per DESIGN.md)
        // - Favorite root rows show root.name
        // - Playlist member segments "m:N" resolve via favorites.resolveDisplayName
        // - Everything else uses the raw segment name
        const displayName = isAppRoot ? `OnePlay${debugEnabled ? deployCounter : ''}`
            : isAccount ? (rootType === 'demo' ? 'Demo library' : 'OneDrive')
            : isShareRoot && rootEntry ? rootEntry.name
            : isFavoriteRoot && rootEntry ? rootEntry.name
            : resolvePathTailDisplayName(opts.path, roots, favoritesRef);

        // The full display name remains available when a breadcrumb is shortened.
        const nameSpan = document.createElement('span');
        nameSpan.className = 'row-name';
        nameSpan.textContent = displayName;
        if (opts.isBreadcrumb) {
            nameSpan.title = displayName;
            el.setAttribute('aria-label', displayName);
            if (isSelected) el.setAttribute('aria-current', 'location');
        }
        if (opts.isBreadcrumb && !isAppRoot && isSelectableRow) {
            const label = document.createElement('span');
            label.className = 'crumb-label';
            label.append(...el.childNodes, nameSpan);
            el.appendChild(label);
        } else {
            el.appendChild(nameSpan);
        }

        // A breadcrumb's badges and trailing separator wrap together with the
        // end of its name. A separator on its own would indent the next folder.
        const suffix = opts.isBreadcrumb ? document.createElement('span') : el;

        // Favorite markers are passive badges (no dedicated click target).
        // They remain appended after the name so tapping them behaves like row tap.
        if (isFavoriteRoot) {
            const favIcon = document.createElement('span');
            favIcon.className = 'fav-icon';
            favIcon.textContent = (opts.isBreadcrumb ? '\u00a0' : '\u2002') + (rootType === 'shortcut' ? '☆' : '♫');
            suffix.appendChild(favIcon);

        }

        const reindexing = depth <= 2 && (rootEntry?.type === 'onedrive' || rootEntry?.type === 'share')
            && rootEntry.reindexing;
        const showSpinner = !selectModeActive && ((isAppRoot && isSyncing) || reindexing);

        // Only a physical route can show a folder pin. A playlist containing the same tracks
        // has its own owner badge, and never marks the corresponding OneDrive album.
        const keyFor = (subpath: FolderPath) => folderPinPathKey(rootEntry!.key,
            rootEntry?.type === 'share' ? rootEntry.connectionId : undefined, subpath);
        const folderKey = opts.isFolder && (rootType === 'onedrive' || rootType === 'share' || rootType === 'demo')
            ? keyFor(opts.path.slice(2)) : undefined;
        const folderIcon = folderKey === undefined ? undefined : folderIcons.get(folderKey);
        const partial = folderIcon?.partial;
        const iconState = isFavoriteRoot ? offlineIcons.get(opts.path[1].slice(FAV_PREFIX.length)) : folderIcon?.state;
        // Breadcrumb arrows coalesce to the right. Every ancestor of a pin is
        // partial, so checking the next crumb suffices even in a deep trail.
        const nextKey = partial && opts.isBreadcrumb && !isSelected ? keyFor(selectedPath.slice(2, Math.max(2, depth) + 1)) : undefined;
        const visibleIcon = nextKey && folderIcons.has(nextKey) ? undefined : iconState;
        const replaceArrow = isAppRoot && showSpinner && visibleIcon;
        if (visibleIcon) {
            const badge = document.createElement('span');
            if (replaceArrow) {
                // Use the arrow's footprint so sync cannot move or rewrap the next breadcrumb.
                badge.className = 'crumb-status-spinner';
                addSpinner(badge);
            } else {
                setOfflineBadge(badge, visibleIcon, partial);
            }
            suffix.appendChild(badge);
        }

        // For depth-3 rows inside playlists, show FavRef member's icon (☆/♫)
        if (depth === 3 && rootEntry?.type === 'playlist' && favoritesRef) {
            const match = opts.path[2].match(/^m:(\d+)$/);
            const idx = match ? parseInt(match[1], 10) : -1;
            const member = idx >= 0 && idx < rootEntry.members.length
                ? rootEntry.members[idx] : undefined;
            const refFav = member && isFavRef(member)
                ? favoritesById.get(member.favId) : undefined;
            if (refFav) {
                const favIcon = document.createElement('span');
                favIcon.className = 'fav-icon';
                favIcon.textContent = (opts.isBreadcrumb ? '\u00a0' : '\u2002') + (refFav.kind === 'shortcut' ? '☆' : '♫');
                suffix.appendChild(favIcon);
            }
        }

        // The menu occupies the left gutter. Only the text belongs to the path.
        if (isAppRoot) {
            // Force text-presentation glyphs (FE0E) for a flatter, monochrome look.
            const demo = [...roots.values()].some(root => root.type === 'demo');
            const showWarning = demo || evidence === 'evidence:signed-out' || [...deniedRootKeys].some(key => roots.has(key)) || hasIndexFailureWarning;
            const menuIcon = document.createElement('button');
            menuIcon.type = 'button';
            menuIcon.className = 'row-icon row-icon-menu row-icon-menu-left row-icon-settings';
            menuIcon.classList.toggle('row-icon-warning', showWarning);
            menuIcon.setAttribute('aria-label', demo ? 'Settings, demo library' : 'Open settings');
            menuIcon.textContent = showWarning ? '⚠\uFE0E' : '☰\uFE0E';
            menuIcon.onclick = event => {
                event.stopPropagation();
                view.onSettingsClick();
            };
            el.insertBefore(menuIcon, nameSpan);
            if (debugEnabled && evidence !== 'evidence:signed-in') {
                const { icon, label } = demo && evidence === 'no-evidence'
                    ? {icon: '‽', label: 'Demo library connection unconfirmed'} : DEBUG_EVIDENCE_BADGES[evidence];
                const badge = document.createElement('span');
                badge.setAttribute('role', 'img');
                badge.setAttribute('aria-label', label);
                badge.title = label;
                badge.textContent = icon;
                suffix.append('\u2009', badge);
            }
        }

        if (reindexing && !opts.isBreadcrumb) addSpinner(el);

        // Selected folder (not root, not account): play button.
        // ▶ (filled) if this folder IS the playback folder, ▷ (ghost) otherwise.
        if (isSelected && !isAppRoot && !isAccount && !isShareRoot && opts.showPlayButton !== false) {
            const play = document.createElement('button');
            play.className = 'play-btn';
            play.setAttribute('aria-label', `Play ${displayName}`);
            play.textContent = isPlaybackFolder ? '▶' : '▷';
            play.onclick = event => {
                event.stopPropagation();
                view.onPlayClick(opts.path);
            };
            // An inline nonbreaking space reserves the trailing button width on
            // the same line as the name. Its tap target can fill the line height.
            const tail = document.createElement('span');
            tail.className = 'play-tail';
            tail.append('\u00a0', play);
            suffix.appendChild(tail);
        }

        if (opts.isBreadcrumb && (!isSelected || isAppRoot || isAccount || isShareRoot)) {
            const separator = document.createElement('span');
            separator.className = 'crumb-separator';
            separator.setAttribute('aria-hidden', 'true');
            // The separator owns the gap even when the root is the final crumb.
            // Its spinner is out of flow so refresh can never rewrap the path.
            separator.textContent = '\u00a0';
            if (!isSelected) {
                const chevron = document.createElement('span');
                chevron.textContent = '›';
                separator.appendChild(chevron);
            }
            if (showSpinner && !replaceArrow) addSpinner(separator);
            suffix.appendChild(separator);
        }

        if (opts.isBreadcrumb) {
            suffix.className = 'crumb-end';
            el.appendChild(suffix);
        }

        // Click handler: in select mode, selectable rows toggle selection.
        // Non-selectable rows (OnePlay Music + account roots) are explicit no-ops.
        // Track greying: when signed-out or not-online, non-cached tracks are
        // unavailable for playback. Selection and its local actions still work.
        const isUnavailableFromDeniedShare = !opts.isFolder && isPathDeniedByShare(opts.path, deniedRootKeys, roots);
        const isUnavailableFromEvidence = !opts.isFolder && !opts.isBreadcrumb
            && (evidence === 'evidence:signed-out' || evidence === 'evidence:not-online')
            && !isTrackCachedFn(opts.path);
        const isUnavailable = isUnavailableFromDeniedShare || isUnavailableFromEvidence;
        bindRowPrimaryClick(el, opts, isSelectableRow, isUnavailable, isFavoriteRoot, isShareWithoutData);

        return el;
    }

    /** Fit only the ancestor trail. The browser chooses word breaks, including
     * splits within filenames. A partial first line earns one continuation. */
    function fitBreadcrumbNames(): void {
        if (!trail.clientWidth) return; // ResizeObserver will fit it when the tree becomes visible.
        const playTail = trail.querySelector<HTMLElement>('.play-tail');
        if (playTail) playTail.style.lineHeight = '';
        const style = getComputedStyle(trail);
        const left = trail.getBoundingClientRect().left + parseFloat(style.paddingLeft);
        const lineHeight = parseFloat(style.lineHeight);
        for (const crumb of trail.querySelectorAll<HTMLElement>('.crumb')) {
            const name = crumb.querySelector<HTMLElement>('.row-name')!;
            const full = name.title;
            name.textContent = full;
            // Bidi runs and badges can yield several rectangles on one line.
            // The inline box height increases by one line-height per wrap.
            const first = crumb.getClientRects()[0];
            if (!first) continue;
            const oneLine = first.height + 1;
            // The tap area reaches into the preceding gap. Wrap by the text edge.
            const startsAtLeft = name.getClientRects()[0].left <= left + 1;
            const maxHeight = oneLine + (startsAtLeft ? 0 : lineHeight);
            if (crumb.getBoundingClientRect().height <= maxHeight) continue;
            // Keep the longest grapheme prefix that fits with its ellipsis,
            // badges and separator. Full song titles never enter this path.
            const letters = Array.from(new Intl.Segmenter().segment(full), part => part.segment);
            let low = 0, high = letters.length;
            while (low < high) {
                const mid = Math.ceil((low + high) / 2);
                name.textContent = letters.slice(0, mid).join('').trimEnd() + '…';
                if (crumb.getBoundingClientRect().height <= maxHeight) low = mid;
                else high = mid - 1;
            }
            name.textContent = letters.slice(0, low).join('').trimEnd() + '…';
        }
        // If Play ends directly below Search, separate their 44px hit areas.
        // Only that final line needs extra leading; text widths stay the same.
        if (playTail) {
            const play = playTail.firstElementChild!.getBoundingClientRect();
            const searchBounds = search.getBoundingClientRect();
            const overlap = searchBounds.bottom - play.top;
            if (overlap > 0 && play.right > searchBounds.left && play.left < searchBounds.right) {
                playTail.style.lineHeight = (lineHeight + 2 * Math.ceil(overlap)) + 'px';
            }
        }
    }

    // Rotation, resizing and returning from Settings can all change line breaks.
    let lastTrailSize = '';
    new ResizeObserver(() => {
        const size = trail.clientWidth + '/' + getComputedStyle(trail).fontSize;
        if (size === lastTrailSize) return;
        lastTrailSize = size;
        fitBreadcrumbNames();
    }).observe(trail);

    // -- render --------------------------------------------------------------

    /**
     * Re-renders breadcrumbs and children based on current selectedPath and
     * roots data. This is the sole function that writes to the DOM.
     *
     * When animate=true (user clicked a folder), uses FLIP to slide persistent
     * rows from old positions and fade in new children.
     *
     * FLIP INVARIANTS:
     * - oldBounds captures all .tree-row[data-path] positions before DOM update.
     *   After replaceChildren, rows matching the same data-path animate from
     *   old→new; rows without an oldBounds entry are new (fade in via opacity).
     * - pending counter tracks outstanding transitions. Incremented for each
     *   animating row + the childrenEl fade. When pending reaches 0,
     *   overflow:auto is restored on #children.
     */
    function render(animate = false): void {
        // showTree installs account and cached share roots, then favorites. An earlier
        // render could invalidate a saved share path before its root is available.
        if (!favoritesRef || searchModeOpen) return;

        // FLIP step 1: snapshot old row positions before DOM update
        const oldBounds: Record<string, DOMRect> = {};
        if (animate) {
            for (const row of container.querySelectorAll<HTMLElement>('.tree-row[data-path]')) {
                oldBounds[row.dataset.path!] = row.getBoundingClientRect();
            }
        }

        // Child rows: immediate children of selected folder
        const pathBeforeResolve = selectedPath;
        const homeLibrary = solePrimaryLibraryKey(roots);
        const children = resolveFolderAndRepairSelection(homeLibrary);
        // Home stays home when another root appears. Child rows always retain the drive key.
        if (homeLibrary !== undefined && selectedPath.length === 2 && selectedPath[1] === homeLibrary) {
            selectedPath = selectedPath.slice(0, 1);
        }
        const displayedPath = homeLibrary !== undefined && selectedPath.length === 1
            ? [...selectedPath, homeLibrary] : selectedPath;
        // resolveFolderAndRepairSelection may correct selectedPath (broken path fallback).
        // If so, persist the correction via onPathChange.
        if (selectedPath !== pathBeforeResolve) view.onPathChange(selectedPath);

        // Breadcrumb rows: one per prefix of selectedPath.
        // The selected-folder play button is suppressed when:
        // - there are no immediate children, or
        // - in terminal evidence states, there are no child folders and all
        //   immediate file children are unavailable (cheap non-recursive check).
        const isTerminalEvidence = evidence === 'evidence:signed-out' || evidence === 'evidence:not-online';
        const hasChildFolder = children.some(([, isFolder]) => isFolder);
        const allImmediateFilesUnavailable = children.length > 0
            && !hasChildFolder
            && isTerminalEvidence
            && children.every(([name, isFolder]) =>
                !isFolder && !isTrackCachedFn([...displayedPath, name]));
        const showSelectedPlayButton = children.length > 0 && !allImmediateFilesUnavailable;
        const breadcrumbRows: HTMLElement[] = [];
        for (let i = 0; i < selectedPath.length; i++) {
            if (i === 1 && homeLibrary !== undefined) continue;
            breadcrumbRows.push(makeRow({
                isFolder: true,
                isBreadcrumb: true,
                path: selectedPath.slice(0, i + 1),
                showPlayButton: showSelectedPlayButton,
            }));
        }

        const childRows = children.map(([name, isFolder]) => makeRow({
            isFolder,
            isBreadcrumb: false,
            path: [...displayedPath, name],
        }));

        // Capture live scroll before replacing DOM so same-path re-renders
        // (select-mode toggles, playback indicator updates) can preserve exact
        // viewport even when scrollMap persistence is one frame behind.
        const hadChildrenRows = childrenEl.childElementCount > 0;
        const liveScrollBeforeRender = childrenEl.scrollTop;
        const previous = previousPath;
        const isSamePath = previous && pathEquals(displayedPath, previous);
        if (!isSamePath) rememberListScroll();

        trail.classList.toggle('selecting', selectModeActive);
        trail.replaceChildren(search, breadcrumbRows[0]);
        for (const crumb of breadcrumbRows.slice(1)) {
            trail.append(' ', crumb);
        }
        breadcrumbsEl.replaceChildren(trail);
        fitBreadcrumbNames();
        // A previous FLIP may have unclipped the list. Restore scrolling before applying its offset.
        childrenEl.style.overflow = '';
        childrenEl.replaceChildren(...childRows);

        // -- Scroll restoration (M10) ----------------------------------------
        // After DOM replacement:
        // - Same-path re-renders restore live pre-render scroll.
        // - Navigation up restores persisted per-path scroll.
        // - Navigation down/jump resets to 0. Switching between the root and account lists
        //   follows the same rule; only the home selection is shared between those lists.
        // Initial render has no existing rows, so it still uses persisted
        // scroll restoration (if available).
        const pathKey = JSON.stringify(displayedPath);
        const isUpOrSame = !previous || displayedPath.every((s, i) => s === previous[i]);
        const savedScroll = scrollMap.get(pathKey);
        const stillClamped = isSamePath && clampedInitialScroll?.applied === liveScrollBeforeRender
            ? clampedInitialScroll : undefined;
        const scrollTop = isSamePath && hadChildrenRows
            ? stillClamped?.top ?? liveScrollBeforeRender
            : isUpOrSame ? savedScroll?.top ?? 0 : 0;
        childrenEl.scrollTop = scrollTop;
        // A viewport redraw can restore the rest. Navigation or a changed live
        // offset cancels the retry so the listener's current scroll wins.
        clampedInitialScroll = (!previous || stillClamped) && childrenEl.scrollTop < scrollTop
            ? {top: scrollTop, applied: childrenEl.scrollTop}
            : undefined;
        previousPath = displayedPath;

        // Empty-favorites placeholder: when at app root and user has no favorites,
        // show a hint above the account rows (where favorites would normally appear).
        if (displayedPath.length === 1 && favoritesRef.getAll().length === 0) {
            const hint = document.createElement('div');
            hint.className = 'empty-favorites-hint';
            hint.textContent = 'press and hold on a folder to add it to favorites';
            childrenEl.prepend(hint);
        }

        // FLIP step 2: animate rows that existed before from old → new position,
        // and fade in the new children container.
        // Temporarily unclip #children so transformed rows can paint outside
        // its bounds during the 220ms animation. (#breadcrumbs has no overflow
        // clipping — it's always exactly sized to its content.)
        if (animate) {
            // Unclipping a scrolled viewport resets its offset in both browser engines.
            if (childrenEl.scrollTop === 0) childrenEl.style.overflow = 'visible';
            if (restoreOverflowTimeout !== undefined) clearTimeout(restoreOverflowTimeout);
            // INVARIANT: overflow must always return to stylesheet control.
            // Relying only on transitionend is fragile because re-renders can
            // remove transitioning rows before events fire.
            restoreOverflowTimeout = window.setTimeout(() => {
                childrenEl.style.overflow = '';
                restoreOverflowTimeout = undefined;
                bumpTestTreeFlipSeq();
            }, 260);
            for (const row of container.querySelectorAll<HTMLElement>('.tree-row[data-path]')) {
                const old = oldBounds[row.dataset.path!];
                if (!old) continue;
                const cur = row.getBoundingClientRect();
                const dx = old.left - cur.left;
                const dy = old.top - cur.top;
                if (dx === 0 && dy === 0) continue;
                if (row.classList.contains('crumb')) {
                    // Inline text can span line boxes. Animate relative offsets
                    // on its fragments, including the attached Play target.
                    for (const fragment of row.children) {
                        fragment.animate([{ left: dx + 'px', top: dy + 'px' }, { left: '0', top: '0' }],
                            { duration: 220, easing: 'cubic-bezier(0.33, 1, 0.68, 1)' });
                    }
                    continue;
                }
                row.style.transition = 'none';
                row.style.transform = `translate(${dx}px, ${dy}px)`;
                requestAnimationFrame(() => {
                    row.style.transition = 'transform 220ms cubic-bezier(0.33, 1, 0.68, 1)';
                    row.style.transform = '';
                    row.addEventListener('transitionend', () => {
                        row.style.transition = '';
                    }, { once: true });
                });
            }
            childrenEl.style.transition = 'none';
            childrenEl.style.opacity = '0';
            requestAnimationFrame(() => {
                childrenEl.style.transition = 'opacity 220ms ease';
                childrenEl.style.opacity = '';
                childrenEl.addEventListener('transitionend', () => {
                    childrenEl.style.transition = '';
                }, { once: true });
            });
        }
    }

    // -- Scroll position tracking (M10) ----------------------------------------
    // rAF-throttled scroll listener saves scrollTop keyed by current path.
    // The composing workspace owns persistence and can retire it on sign-out.

    childrenEl.addEventListener('scroll', () => {
        if (searchModeOpen) {
            searchResultsScrollTop = childrenEl.scrollTop;
            return;
        }
        // Don't save scroll when the container is empty (e.g. initial render
        // before data loads). Saving 0 would overwrite restored values.
        if (scrollRafPending || childrenEl.childElementCount === 0) return;
        scrollRafPending = true;
        requestAnimationFrame(() => {
            scrollRafPending = false;
            if (!previousPath || searchModeOpen) return;
            rememberListScroll();
            const obj: Record<string, {top: number}> = {};
            for (const [k, v] of scrollMap) obj[k] = v;
            try { saveScroll?.(obj); } catch { /* quota */ }
        });
    });

    return view;
}
