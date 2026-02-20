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
 *   resolveFolder resets to the deepest valid prefix.
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
import { type RootsMap, type Favorite, type Favorites, isFavRef } from './favorites.js';
import { type EvidenceState } from './auth.js';
import { type SearchResult } from './search.js';
import { resolvePathTailDisplayName } from './path-names.js';

/** Key prefix for favorite roots in the RootsMap. */
const FAV_PREFIX = 'fav:';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Path from root to a folder. ["OnePlay Music"] is the app root. */
export type FolderPath = readonly string[];

/** Public API returned by createTree. */
export interface TreeView {
    /** Add/update an account's data. Key is driveId; displayName comes from info. */
    setAccount(key: string, folder: MusicFolder, info: AccountInfo, reindexing?: boolean): void;
    /** Wire the favorites module. Converts favorites to roots and renders. */
    setFavorites(favs: Favorites): void;
    /** Replaces all share roots in insertion order. */
    setShareRoots(shares: ReadonlyArray<{
        key: string;
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
    /** Update playback indicators (track SVG, folder highlighting, play glyph). */
    setPlaybackInfo(info: PlaybackInfo | undefined): void;
    /** Update select mode rendering state. Checkboxes appear on selectable rows
     *  when active; selectedPaths uses JSON.stringify(path) as keys. */
    setSelectMode(active: boolean, selectedPaths: ReadonlySet<string>): void;
    /** Called when user clicks a track (file). */
    onTrackClick: (path: FolderPath) => void;
    /** Called when user clicks the play button on selected folder. */
    onPlayClick: (path: FolderPath) => void;
    /** Called when user clicks the menu/warning icon on the OnePlay Music row. */
    onSettingsClick: () => void;
    /** Called when user taps the debug evidence glyph on the OnePlay Music row. */
    onDebugEvidenceGlyphClick: () => void;
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
    /** Set offline icon states for favorite roots. Absent = no icon. */
    setOfflineIcons(icons: Map<string, 'complete' | 'downloading' | 'paused'>): void;
    /** Set syncing state (⟳ spinner on OnePlay Music row). */
    setSyncing(value: boolean): void;
    /** Toggle debug glyph visibility on the OnePlay Music row. */
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

/** Options for makeRow. Depth-derived flags (isAppRoot, indent, isSelected)
 *  are computed inside makeRow from path. */
interface RowOptions {
    readonly name: string;
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
 * @param debugGlyphs - If provided, enables an optional debug glyph on the
 *   OnePlay Music row showing the evidence state when setDebugEnabled(true) is active.
 */
export function createTree(
    container: HTMLElement,
    initialPath?: FolderPath,
    initialScrollMap?: Record<string, {top: number, left: number}>,
    deployCounter = '',
    debugGlyphs?: Readonly<Record<EvidenceState, string>>,
): TreeView {
    const breadcrumbsEl = container.querySelector<HTMLElement>('#breadcrumbs')!;
    const childrenEl = container.querySelector<HTMLElement>('#children')!;

    // -- State ---------------------------------------------------------------

    const roots: RootsMap = new Map();
    let favoritesRef: Favorites | undefined;
    let favoritesById = new Map<string, Favorite>();
    let selectedPath: FolderPath = initialPath && initialPath.length >= 1 && initialPath[0] === 'OnePlay Music'
        ? initialPath : ['OnePlay Music'];
    let playbackInfo: PlaybackInfo | undefined;

    // -- Scroll position tracking (M10) --------------------------------------
    // INVARIANT: scrollMap stores {top, left} per folder path. Populated from
    // initialScrollMap on startup. Updated on scroll events (rAF-throttled).
    // Capped at 100 entries; oldest entries trimmed on save.

    const scrollMap = new Map<string, {top: number, left: number}>(
        initialScrollMap ? Object.entries(initialScrollMap) : [],
    );
    let scrollRafPending = false;
    /** Previous selectedPath, used to decide scroll restoration direction. */
    let previousPath: FolderPath = selectedPath;
    /** Timeout id that clears temporary inline overflow used during FLIP. */
    let restoreOverflowTimeout: number | undefined;
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

    // Offline icon states for favorite roots (set via setOfflineIcons).
    let offlineIcons: Map<string, 'complete' | 'downloading' | 'paused'> = new Map();

    // Syncing state: when true, ⟳ spinner shows on OnePlay Music row.
    let isSyncing = false;
    // Runtime debug visibility for the OnePlay Music evidence glyph.
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

    /** Builds one search-result row using existing tree row classes. */
    const makeSearchResultRow = (result: SearchResult): HTMLElement => {
        const isFolder = result.kind === 'favorite' || result.kind === 'folder';
        const row = document.createElement('div');
        row.className = `tree-row ${isFolder ? 'folder' : 'file'} indent-1`;
        row.dataset.path = JSON.stringify(result.path);

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

        row.addEventListener('click', () => view.onSearchResultClick(result));
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
    const createSearchIconSvg = (): SVGSVGElement => {
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
    };

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
                roots.set(share.key, {
                    type: 'share',
                    key: share.key,
                    name: share.name,
                    driveId: share.driveId,
                    folder: share.folder,
                    reindexing: share.reindexing,
                });
            }
            render();
        },
        getRoots: () => roots,
        getSelectedPath: () => selectedPath,
        setSelectedPath(path) {
            // Enforce invariant: selectedPath must start with "OnePlay Music".
            selectedPath = path.length >= 1 && path[0] === 'OnePlay Music' ? path : ['OnePlay Music'];
            render();
            view.onPathChange(selectedPath);
        },
        setPlaybackInfo(info) {
            playbackInfo = info;
            render();
        },
        setSelectMode(active, paths) {
            selectModeActive = active;
            selectModePaths = paths;
            render();
        },
        onTrackClick: (_path) => {},
        onPlayClick: (_path) => {},
        onSettingsClick: () => {},
        onDebugEvidenceGlyphClick: () => {},
        onShareWithoutDataTap: (_path) => {},
        onSelectToggle: (_path) => {},
        onSelectExit: () => {},
        onFavoriteRootTap: (_path) => {},
        onPathChange: (_path) => {},
        setOfflineIcons(icons) { offlineIcons = icons; },
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

    // -- resolveFolder -------------------------------------------------------

    /**
     * Resolves selectedPath to the list of child entries to display.
     * Returns [segment, isFolder] pairs sorted folders-first then alphabetically.
     * If the path is broken (folder deleted during re-index), resets
     * selectedPath to the deepest valid prefix and returns those children.
     *
     * Three cases:
     * 1. App root (selectedPath.length <= 1): list all roots. Favorites first
     *    (in array order), then OneDrive accounts (sorted by key).
     * 2. Root is shortcut/playlist: delegate to favorites.resolveChildren.
     * 3. Root is OneDrive account: walk MusicFolder tree (existing logic).
     */
    function resolveFolder(): Array<[string, boolean]> {
        // App root: list all roots — favorites first, then accounts sorted
        if (selectedPath.length <= 1) {
            const favKeys: Array<[string, boolean]> = [];
            const accountKeys: Array<[string, boolean]> = [];
            const shareKeys: Array<[string, boolean]> = [];
            for (const [key, root] of roots) {
                if (root.type === 'onedrive') {
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
        const rootKey = selectedPath[1];
        const root = roots.get(rootKey);
        if (!root) {
            // If data hasn't loaded yet for this root, don't reset — return
            // empty children and wait for setAccount/setFavorites to re-render.
            // Favorites: not loaded until setFavorites(). Accounts: not loaded
            // until setAccount(). Both cases: roots map won't have the key yet.
            if (rootKey.startsWith(FAV_PREFIX) ? !favoritesRef : roots.size === 0) return [];
            selectedPath = ['OnePlay Music'];
            return resolveFolder();
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
                    return resolveFolder();
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
                return resolveFolder();
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
            return;
        }
        if (selectModeActive && isSelectableRow) {
            el.addEventListener('click', () => view.onSelectToggle(opts.path));
            return;
        }
        if (selectModeActive && !isSelectableRow) {
            el.addEventListener('click', () => {});
            return;
        }
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
     * child rows. Derives depth-based flags (isAppRoot, indent, isSelected)
     * from opts.path to keep callsites simple.
     *
     * At depth 2, dispatches on root type:
     * - 'onedrive': displays "OneDrive", optional re-index spinner
     * - 'shortcut': displays root.name with ☆ icon
     * - 'playlist': displays root.name with ♫ icon
     */
    function makeRow(opts: RowOptions): HTMLElement {
        const depth = opts.path.length;
        const isAppRoot = depth === 1;
        const indent = Math.min(depth - 1, 4);
        const isSelected = opts.isBreadcrumb && depth === selectedPath.length;

        // Root type dispatch at depth 2
        const rootEntry = depth >= 2 ? roots.get(opts.path[1]) : undefined;
        const rootType = rootEntry?.type;
        const isAccount = depth === 2 && rootType === 'onedrive';
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
            + ` indent-${indent}`;
        el.dataset.path = JSON.stringify(opts.path);

        // Select mode checkbox: shown on selectable rows only.
        // Non-selectable rows are app root and account roots.
        const isSelectableRow = !isAppRoot && !isAccount && !isShareRoot;
        if (selectModeActive && isSelectableRow) {
            const pathKey = JSON.stringify(opts.path);
            const isChecked = selectModePaths.has(pathKey);
            const check = document.createElement('span');
            check.className = 'select-check' + (isChecked ? ' checked' : '');
            check.textContent = isChecked ? '\u2713' : '';
            el.prepend(check);
        }

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
        const displayName = isAppRoot ? `OnePlay Music${debugEnabled ? deployCounter : ''}`
            : isAccount ? 'OneDrive'
            : isShareRoot && rootEntry ? rootEntry.name
            : isFavoriteRoot && rootEntry ? rootEntry.name
            : resolvePathTailDisplayName(opts.path, roots, favoritesRef);

        // Wrap in a span so CSS text-overflow can truncate long names
        // (bare text nodes can't be styled). The span gets min-width:0
        // to shrink below its natural width in the flex row.
        const nameSpan = document.createElement('span');
        nameSpan.className = 'row-name';
        nameSpan.textContent = displayName;
        el.appendChild(nameSpan);

        // Favorite markers are passive badges (no dedicated click target).
        // They remain appended after the name so tapping them behaves like row tap.
        if (isFavoriteRoot) {
            const favIcon = document.createElement('span');
            favIcon.className = 'fav-icon';
            favIcon.textContent = '\u2002' + (rootType === 'shortcut' ? '☆' : '♫');
            el.appendChild(favIcon);

            // ↓ offline badge: driven by offlineIcons map (pushed by index.ts)
            const iconState = offlineIcons.get(opts.path[1].slice(FAV_PREFIX.length));
            if (iconState) {
                const badge = document.createElement('span');
                badge.className = 'offline-badge'
                    + (iconState === 'downloading' ? ' downloading' : '')
                    + (iconState === 'paused' ? ' paused' : '');
                badge.textContent = '\u2193';
                el.appendChild(badge);
            }
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
                favIcon.textContent = '\u2002' + (refFav.kind === 'shortcut' ? '☆' : '♫');
                el.appendChild(favIcon);
            }
        }

        /** Appends an icon/button span with stopPropagation click handler. Returns the span. */
        const addIcon = (cls: string, text: string, onClick: () => void): HTMLElement => {
            const icon = document.createElement('span');
            icon.className = cls;
            icon.textContent = text;
            icon.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
            el.appendChild(icon);
            return icon;
        };

        /** Appends the shared spinner glyph (⟳) used by sync and reindex states. */
        const addSpinner = (): void => {
            const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.setAttribute('viewBox', '0 0 16 16');
            svg.classList.add('sync-spinner');
            svg.innerHTML = '<circle cx="8" cy="8" r="5"/>';
            el.appendChild(svg);
        };

        // App root "OnePlay Music": left menu/warning icon, right-side debug/state icons,
        // and a right-aligned Search button in the close-button slot.
        if (isAppRoot) {
            // Force text-presentation glyphs (FE0E) for a flatter, monochrome look.
            const showWarning = evidence === 'evidence:signed-out' || deniedRootKeys.size > 0 || hasIndexFailureWarning;
            const menuIcon = addIcon(
                showWarning
                    ? 'row-icon row-icon-menu row-icon-menu-left row-icon-settings row-icon-warning'
                    : 'row-icon row-icon-menu row-icon-menu-left row-icon-settings',
                showWarning ? '⚠\uFE0E' : '☰\uFE0E',
                () => view.onSettingsClick(),
            );
            // Keep the app-root control at the far left so title-row taps avoid right-side controls.
            el.insertBefore(menuIcon, nameSpan);
            if (debugEnabled) {
                addIcon('row-icon', '📋', () => {
                    const panel = document.getElementById('log-panel');
                    panel?.classList.toggle('visible');
                    if (panel?.classList.contains('visible')) panel.scrollTop = 0;
                });
            }
            if (debugGlyphs && debugEnabled) {
                addIcon('row-icon', debugGlyphs[evidence], () => view.onDebugEvidenceGlyphClick());
            }
            if (isSyncing) addSpinner();
            const searchBtn = addIcon('row-icon row-icon-search row-icon-search-right', '', () => view.onSearchOpen());
            searchBtn.appendChild(createSearchIconSvg());
        }

        // Account row: no static icon; show spinner only while re-indexing.
        if ((isAccount && rootEntry?.type === 'onedrive' && rootEntry.reindexing)
            || (isShareRoot && rootEntry?.type === 'share' && rootEntry.reindexing)) {
            addSpinner();
        }

        // Selected folder (not root, not account): play button.
        // ▶ (filled) if this folder IS the playback folder, ▷ (ghost) otherwise.
        if (isSelected && !isAppRoot && !isAccount && !isShareRoot && opts.showPlayButton !== false) {
            addIcon('play-btn', isPlaybackFolder ? '\u25B6' : '\u25B7',
                () => view.onPlayClick(selectedPath));
        }

        // Click handler: in select mode, selectable rows toggle selection.
        // Non-selectable rows (OnePlay Music + account roots) are explicit no-ops.
        // Track greying: when signed-out or not-online, non-cached tracks are
        // unavailable (grey, no click handler — the track genuinely can't play).
        const isUnavailableFromDeniedShare = !opts.isFolder && deniedRootKeys.has(opts.path[1]);
        const isUnavailableFromEvidence = !opts.isFolder && !opts.isBreadcrumb
            && (evidence === 'evidence:signed-out' || evidence === 'evidence:not-online')
            && !isTrackCachedFn(opts.path);
        const isUnavailable = isUnavailableFromDeniedShare || isUnavailableFromEvidence;
        bindRowPrimaryClick(el, opts, isSelectableRow, isUnavailable, isFavoriteRoot, isShareWithoutData);

        return el;
    }

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
        if (searchModeOpen) return;

        // FLIP step 1: snapshot old row positions before DOM update
        const oldBounds: Record<string, DOMRect> = {};
        if (animate) {
            for (const row of container.querySelectorAll<HTMLElement>('.tree-row[data-path]')) {
                oldBounds[row.dataset.path!] = row.getBoundingClientRect();
            }
        }

        // Child rows: immediate children of selected folder
        const pathBeforeResolve = selectedPath;
        const children = resolveFolder();
        // resolveFolder may correct selectedPath (broken path fallback).
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
                !isFolder && !isTrackCachedFn([...selectedPath, name]));
        const showSelectedPlayButton = children.length > 0 && !allImmediateFilesUnavailable;
        const breadcrumbRows = selectedPath.map((_, i) => {
            const prefix = selectedPath.slice(0, i + 1);
            const isSelectedFolder = i === selectedPath.length - 1;
            return makeRow({
                name: prefix[prefix.length - 1],
                isFolder: true,
                isBreadcrumb: true,
                path: prefix,
                showPlayButton: isSelectedFolder ? showSelectedPlayButton : true,
            });
        });

        const childRows = children.map(([name, isFolder]) => makeRow({
            name,
            isFolder,
            isBreadcrumb: false,
            path: [...selectedPath, name],
        }));

        // Capture live scroll before replacing DOM so same-path re-renders
        // (select-mode toggles, playback indicator updates) can preserve exact
        // viewport even when scrollMap persistence is one frame behind.
        const hadChildrenRows = childrenEl.childElementCount > 0;
        const liveScrollBeforeRender = {
            top: childrenEl.scrollTop,
            left: childrenEl.scrollLeft,
        };

        breadcrumbsEl.replaceChildren(...breadcrumbRows);
        childrenEl.replaceChildren(...childRows);

        // -- Scroll restoration (M10) ----------------------------------------
        // After DOM replacement:
        // - Same-path re-renders restore live pre-render scroll.
        // - Navigation up restores persisted per-path scroll.
        // - Navigation down/jump resets to 0.
        // Initial render has no existing rows, so it still uses persisted
        // scroll restoration (if available).
        const pathKey = JSON.stringify(selectedPath);
        const isSamePath = pathEquals(selectedPath, previousPath);
        const isUpOrSame = selectedPath.length <= previousPath.length
            && selectedPath.every((s, i) => s === previousPath[i]);
        const savedScroll = scrollMap.get(pathKey);
        if (isSamePath && hadChildrenRows) {
            childrenEl.scrollTop = liveScrollBeforeRender.top;
            childrenEl.scrollLeft = liveScrollBeforeRender.left;
        } else if (isUpOrSame && savedScroll !== undefined) {
            childrenEl.scrollTop = savedScroll.top;
            childrenEl.scrollLeft = savedScroll.left;
        } else {
            childrenEl.scrollTop = 0;
            childrenEl.scrollLeft = 0;
        }
        previousPath = selectedPath;

        // Empty-favorites placeholder: when at app root and user has no favorites,
        // show a hint above the account rows (where favorites would normally appear).
        if (selectedPath.length <= 1 && favoritesRef && favoritesRef.getAll().length === 0) {
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
            childrenEl.style.overflow = 'visible';
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
    // Writes to localStorage via a dedicated helper to avoid re-serializing
    // unrelated state on every scroll event.

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
            const key = JSON.stringify(selectedPath);
            scrollMap.set(key, {top: childrenEl.scrollTop, left: childrenEl.scrollLeft});
            // Cap at 100 entries: trim oldest (first inserted)
            if (scrollMap.size > 100) {
                const first = scrollMap.keys().next().value;
                if (first !== undefined) scrollMap.delete(first);
            }
            // Persist to localStorage
            const obj: Record<string, {top: number, left: number}> = {};
            for (const [k, v] of scrollMap) obj[k] = v;
            try { localStorage.setItem('oneplay_music_scroll', JSON.stringify(obj)); } catch { /* quota */ }
        });
    });

    // Initial render
    render();

    return view;
}
