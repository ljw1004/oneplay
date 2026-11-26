/**
 * Select mode module for OnePlay Music.
 *
 * Manages multi-select for favorites CRUD: long-press / right-click enters
 * select mode, a three-zone action bar (share · summary text · more) offers
 * actions via popup menus. Modals handle user input for each action.
 * The right button manages one favorite or one physical subfolder, or deletes a selection.
 *
 * STATE MODEL:
 * - active: whether select mode is currently engaged.
 * - selectedPaths: Set<string> of JSON.stringify(path) for checked rows.
 * - roots: current RootsMap snapshot, updated via setRoots().
 *
 * INVARIANTS:
 * - Selectable rows exclude app root and account roots (OneDrive).
 * - In select mode, selectable breadcrumb clicks toggle selection.
 * - In select mode, non-selectable rows (OnePlay Music, OneDrive) are no-ops.
 * - Modals opened from the single-favorite action-bar menu exit SELECT first.
 * - Other modals: Modal Cancel → stays in SELECT. Select Cancel → exits to NORMAL.
 * - Share button always visible (at minimum "New Playlist" is available).
 * - More (⋯) button hidden via visibility:hidden when no actions apply,
 *   preserving flex layout centering of the summary text.
 * - selectedPaths keys are JSON.stringify(path), matching tree.ts data-path.
 * - Long-press: 500ms timer, primary pointer only, cancel on move > 10px.
 */

import { setOfflineBadge, type FolderPath, type TreeView } from './tree.js';
import { type Favorites, type RootsMap, type PlaylistMember, type FolderPin } from './favorites.js';
import { walkFolder } from './indexer.js';
import { log, logError } from './logger.js';
import { type DownloadControls, QUOTA_OPTIONS_GB, classifyOfflineBadgeState } from './downloads.js';
import { isWalkableRoot } from './roots.js';
import { buildMembersFromSelection as buildMembersFromSelectionFromState } from './select-dialogs.js';
import {
    showModal,
    addModalActions,
    toggleActionDropdown,
    dismissActionDropdown,
    focusTextInput,
    configureNameTextInput,
} from './modal.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FAV_PREFIX = 'fav:';
const LONG_PRESS_MS = 500;
const LONG_PRESS_MOVE_THRESHOLD = 10;
const SUSPICIOUS_LONG_PRESS_EXIT_MS = 350;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Public API returned by createSelect. */
export interface Select {
    isActive(): boolean;
    getSelectedPaths(): ReadonlySet<string>;
    toggle(path: FolderPath): void;
    enterSelectModeWithRow(path: FolderPath): void;
    exitSelectMode(): void;
    setRoots(roots: RootsMap): void;
    onEnterSelect: () => void;
    onExitSelect: () => void;
    /** Called after a favorites action to navigate the tree to the target favorite. */
    onNavigateToFav: (favId: string) => void;
    /** Set the downloads module reference for offline menu items and modal. */
    setDownloads(downloads: DownloadControls): void;
    /** Updates the offline modal DOM if it's currently open. Called on download state changes. */
    updateOfflineModal(): void;
    /** Update an open selection when sync changes the covering folder pin. */
    refreshFolderActions(): void;
}

/** Which actions are available based on selection state. */
interface AvailableActions {
    folder?: FolderPin;
    shortcut: boolean;
    playlist: boolean;       // existing playlists to add to
    delete: boolean;
    moreMemory: boolean;     // exactly 1 top-level favorite → show its icon
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates the select module. All dependencies passed at construction;
 * only setRoots() exposed as an update method since roots change on
 * re-index and favorites mutation.
 */
export function createSelect(
    treeContainer: HTMLElement,
    actionBarEl: HTMLElement,
    cancelBtn: HTMLElement,
    favorites: Favorites,
    tree: TreeView,
    initialRoots: RootsMap,
): Select {

    // -- State ---------------------------------------------------------------

    let active = false;
    const selectedPaths = new Set<string>();
    let roots = initialRoots;
    let downloadsRef: DownloadControls | undefined;

    // -- Action bar DOM (three-zone layout, built once) -----------------------
    // Left: share circle button. Center: selection summary text. Right: dynamic icon.
    // The right button shows ☆/♫ for a single favorite, a trash icon for multi-delete,
    // or is hidden when no actions apply. visibility:hidden (not display:none) keeps
    // center text centered via flex layout.

    const shareBtn = document.createElement('button');
    shareBtn.type = 'button';
    shareBtn.className = 'action-btn share-btn';
    shareBtn.setAttribute('aria-label', 'Playlist and shortcut actions');
    shareBtn.setAttribute('aria-expanded', 'false');
    // iOS-style share glyph (box with upward arrow) — using SF Symbol equivalent
    shareBtn.innerHTML = '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13V3M10 3L6 7M10 3l4 4"/><path d="M3 10v7a1 1 0 001 1h12a1 1 0 001-1v-7"/></svg>';

    const actionText = document.createElement('div');
    actionText.className = 'action-bar-text';
    actionText.textContent = 'Select Items';

    const rightBtn = document.createElement('button');
    rightBtn.type = 'button';
    rightBtn.className = 'action-btn right-btn';

    const summary = document.createElement('div');
    summary.className = 'selection-summary';
    summary.append(actionText, cancelBtn);
    actionBarEl.append(shareBtn, summary, rightBtn);

    // -- Helpers --------------------------------------------------------------

    /** Parses a selected path into its semantic meaning.
     * When isPlaylistMember is true, favId is the playlist's ID. */
    const classifyPath = (pathStr: string): {
        path: FolderPath;
        isFavRoot: boolean;
        favId: string | undefined;
        isPlaylistMember: boolean;
        memberIndex: number;
    } => {
        const path: FolderPath = JSON.parse(pathStr);
        const rootKey = path.length >= 2 ? path[1] : undefined;
        const isFavKey = rootKey !== undefined && rootKey.startsWith(FAV_PREFIX);
        const favId = isFavKey ? rootKey.slice(FAV_PREFIX.length) : undefined;
        const isFavRoot = path.length === 2 && isFavKey;
        const memberMatch = path.length === 3 && isFavKey ? path[2].match(/^m:(\d+)$/) : null;
        const isPlaylistMember = memberMatch !== null;
        const memberIndex = memberMatch ? parseInt(memberMatch[1], 10) : -1;
        return { path, isFavRoot, favId, isPlaylistMember, memberIndex };
    };

    /** Resolve only physical subfolders. The connection UUID fences a dialog across share replacement. */
    const physicalFolderAt = (path: FolderPath): FolderPin | undefined => {
        const root = roots.get(path[1]);
        if (path.length < 3 || !isWalkableRoot(root)) return undefined;
        const tail = path.slice(2);
        const folder = walkFolder(root.folder, tail);
        if (!folder) return undefined;
        return {
            driveId: root.type === 'onedrive' ? root.info.driveId : root.driveId,
            sourceRootKey: root.key,
            connectionId: root.type === 'share' ? root.connectionId : undefined,
            path: tail, itemId: folder.id, isFolder: true,
        };
    };

    const buildMembersFromSelection = (): PlaylistMember[] =>
        buildMembersFromSelectionFromState(selectedPaths, classifyPath, favorites, roots);

    /**
     * Computes which popup items should be available based on selection.
     *
     * Share popup:
     * - shortcut: exactly 1 OneDrive folder selected, not already a shortcut target.
     * - playlist: 1+ existing playlists to add to.
     * - "New Playlist" is always shown (not tracked here — always present).
     *
     * Right button:
     * - moreMemory: exactly 1 top-level favorite → show ☆/♫ icon, fav dropdown on tap.
     * - delete (without moreMemory): multiple deletable items → show trash, delete modal on tap.
     */
    const computeAvailableActions = (): AvailableActions => {
        const paths = Array.from(selectedPaths).map(classifyPath);
        if (paths.length === 0) {
            return { shortcut: false, playlist: false, delete: false, moreMemory: false };
        }

        // Shortcut: exactly 1 selected, it's a folder in the OneDrive index
        // (not a track — track shortcuts would break the playback model where
        // tapping a track sets its containing folder as the playback folder),
        // and not already a shortcut target.
        const folder = paths.length === 1 ? physicalFolderAt(paths[0].path) : undefined;
        const shortcutOk = !!folder && !favorites.getAll().some(f =>
            f.kind === 'shortcut'
            && f.target.driveId === folder.driveId
            && (f.target.sourceRootKey ?? f.target.driveId) === folder.sourceRootKey
            && JSON.stringify(f.target.path) === JSON.stringify(folder.path));

        // Playlist: at least one existing playlist exists (excluding the one we're browsing)
        const browsingFavId = paths.length > 0 && paths.every(p => p.favId === paths[0].favId)
            ? paths[0].favId : undefined;
        const playlistOk = favorites.getAll().some(f =>
            f.kind === 'playlist' && f.id !== browsingFavId);

        // Delete: all top-level favorites, or all members of same playlist
        const allFavRoots = paths.every(p => p.isFavRoot);
        const allSamePlaylist = paths.every(p => p.isPlaylistMember)
            && new Set(paths.map(p => p.favId)).size === 1;
        const deleteOk = allFavRoots || allSamePlaylist;

        // Memory: exactly 1 top-level favorite selected (shows the fav icon
        // on the right button, with the full fav dropdown on tap).
        const moreMemory = paths.length === 1 && allFavRoots;

        return {
            folder,
            shortcut: shortcutOk,
            playlist: playlistOk,
            delete: deleteOk,
            moreMemory,
        };
    };

    /**
     * Updates action bar: selection summary text and right button icon/mode.
     *
     * Summary text: "N Tracks" / "N Folders" / "N Selected" / "Select Items".
     * Right button: ☆/♫ for single favorite, trash for multi-delete, hidden otherwise.
     */
    const syncActionBar = (): HTMLButtonElement => {
        const count = selectedPaths.size;
        if (count === 0) {
            actionText.textContent = 'Select Items';
        } else {
            // Classify each selected path as folder or track
            let folders = 0;
            let tracks = 0;
            for (const pathStr of selectedPaths) {
                const cp = classifyPath(pathStr);
                // Favorite roots and playlist members are always "folders" for display
                if (cp.isFavRoot || cp.isPlaylistMember) {
                    folders++;
                } else if (cp.path.length >= 3) {
                    if (physicalFolderAt(cp.path)) folders++; else tracks++;
                } else {
                    folders++; // account-level rows are folders
                }
            }
            actionText.textContent = tracks === 0 ? `${count} Folder${count > 1 ? 's' : ''}`
                : folders === 0 ? `${count} Track${count > 1 ? 's' : ''}`
                : `${count} Selected`;
        }

        const actions = computeAvailableActions();

        const folder = actions.folder;
        const coverage = folder ? tree.getFolderOfflineState(folder).coverage : 'none';
        let toggleRightMenu: (() => void) | undefined;
        if (actions.moreMemory) {
            const favId = classifyPath([...selectedPaths][0]).favId!;
            const fav = favorites.getAll().find(f => f.id === favId);
            rightBtn.textContent = fav?.kind === 'playlist' ? '♫' : '☆';
            rightBtn.setAttribute('aria-label', 'Favorite actions');
            toggleRightMenu = () => toggleActionDropdown(rightBtn, buildFavItems(favId));
        } else if (folder && coverage !== 'covered') {
            rightBtn.innerHTML = '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M2 5a1 1 0 011-1h5l2 2h7a1 1 0 011 1v8a1 1 0 01-1 1H3a1 1 0 01-1-1z"/></svg>';
            rightBtn.setAttribute('aria-label', 'Folder actions');
            toggleRightMenu = () => toggleActionDropdown(rightBtn, [{
                label: offlineTitle(coverage !== 'none'),
                onClick: () => showOfflineModal(folder),
            }]);
        } else if (actions.delete) {
            rightBtn.innerHTML = '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5h14M7 5V4a1 1 0 011-1h4a1 1 0 011 1v1M5 5v12a1 1 0 001 1h8a1 1 0 001-1V5"/><path d="M8 9v5M12 9v5"/></svg>';
            rightBtn.setAttribute('aria-label', 'Delete selected items');
        }
        if (toggleRightMenu) {
            if (!rightBtn.hasAttribute('aria-expanded')) rightBtn.setAttribute('aria-expanded', 'false');
        } else {
            if (rightBtn.getAttribute('aria-expanded') === 'true') dismissActionDropdown();
            rightBtn.removeAttribute('aria-expanded');
        }
        rightBtn.onclick = toggleRightMenu ?? (actions.delete ? showDeleteModal : null);
        rightBtn.classList.toggle('hidden', !rightBtn.onclick);
        // A playlist member can have a direct Delete button. Entry opens only menus.
        return toggleRightMenu ? rightBtn : shareBtn;
    };

    // -- Modals ---------------------------------------------------------------

    /** Shortcut creation modal: "Add new shortcut" with name and hasPrivatePlayback. */
    const showShortcutModal = (folder: FolderPin): void => {
        const folderName = folder.path.at(-1)!;
        let hasPrivatePlayback = false;

        showModal('Add new shortcut', (modal, close) => {
            const desc = document.createElement('p');
            desc.textContent = `Create a shortcut to "${folderName}"`;
            modal.appendChild(desc);

            const label = document.createElement('label');
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.addEventListener('change', () => { hasPrivatePlayback = checkbox.checked; });
            label.append(checkbox, 'Remember my spot');
            modal.appendChild(label);

            addModalActions(modal, close, 'Create', async () => {
                const id = crypto.randomUUID();
                await favorites.add({
                    kind: 'shortcut',
                    id,
                    name: folderName,
                    target: {
                        driveId: folder.driveId, path: folder.path, itemId: folder.itemId, isFolder: true,
                        sourceRootKey: folder.connectionId ? folder.sourceRootKey : undefined,
                    },
                    hasPrivatePlayback,
                });
                close();
                select.exitSelectMode();
                select.onNavigateToFav(id);
            });
        });
    };

    /** Playlist picker modal: lists existing playlists to add to.
     * Excludes the playlist the user is currently browsing (can't add a playlist to itself). */
    const showPlaylistModal = (): void => {
        const selectedItems = buildMembersFromSelection();
        if (selectedItems.length === 0) return;

        // If all selected items are inside the same playlist, exclude it from the picker
        const classified = Array.from(selectedPaths).map(classifyPath);
        const browsingPlaylistId = classified.length > 0 && classified.every(c => c.favId === classified[0].favId)
            ? classified[0].favId : undefined;

        showModal('Add to playlist', (modal, close) => {
            const playlists = favorites.getAll().filter(f =>
                f.kind === 'playlist' && f.id !== browsingPlaylistId);

            const list = document.createElement('ul');
            list.className = 'modal-playlist-list';
            for (const pl of playlists) {
                const li = document.createElement('li');
                li.textContent = `${pl.name} ♫`;
                li.addEventListener('click', async () => {
                    await favorites.addMembers(pl.id, selectedItems);
                    close();
                    select.exitSelectMode();
                });
                list.appendChild(li);
            }
            modal.appendChild(list);

            const actions = document.createElement('div');
            actions.className = 'modal-actions';
            const cancelBtn2 = document.createElement('button');
            cancelBtn2.type = 'button';
            cancelBtn2.className = 'modal-cancel';
            cancelBtn2.textContent = 'Cancel';
            cancelBtn2.addEventListener('click', () => close());
            actions.appendChild(cancelBtn2);
            modal.appendChild(actions);
        });
    };

    /** Create-new-playlist sub-dialog. */
    const showCreatePlaylistModal = (members: PlaylistMember[]): void => {
        let hasPrivatePlayback = false;

        const normalizePlaylistName = (name: string): string => name.trim().toLocaleLowerCase();
        const isPlaylistNameUnique = (name: string, excludeFavId?: string): boolean => {
            const normalized = normalizePlaylistName(name);
            if (!normalized) return false;
            return !favorites.getAll().some(f =>
                f.kind === 'playlist'
                && f.id !== excludeFavId
                && normalizePlaylistName(f.name) === normalized,
            );
        };

        showModal('Create playlist', (modal, close) => {
            const input = document.createElement('input');
            input.type = 'text';
            input.placeholder = 'Playlist name';
            configureNameTextInput(input);
            modal.appendChild(input);

            const label = document.createElement('label');
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.addEventListener('change', () => { hasPrivatePlayback = checkbox.checked; });
            label.append(checkbox, 'Remember my spot');
            modal.appendChild(label);

            const confirmBtn = addModalActions(modal, close, 'Create', async () => {
                const name = input.value.trim();
                if (!isPlaylistNameUnique(name)) return;
                const id = crypto.randomUUID();
                await favorites.add({
                    kind: 'playlist',
                    id,
                    name,
                    members,
                    hasPrivatePlayback,
                });
                close();
                select.exitSelectMode();
                select.onNavigateToFav(id);
            });

            const syncConfirmEnabled = (): void => {
                confirmBtn.disabled = !isPlaylistNameUnique(input.value);
            };
            input.addEventListener('input', syncConfirmEnabled);
            syncConfirmEnabled();
            focusTextInput(input);
        }, undefined, true);
    };

    /** Delete confirmation modal. Context-aware text. */
    const showDeleteModal = (): void => {
        const paths = Array.from(selectedPaths).map(classifyPath);
        const allFavRoots = paths.every(p => p.isFavRoot);
        const allPlaylistMembers = paths.every(p => p.isPlaylistMember);

        const itemCount = paths.length;
        const title = allFavRoots
            ? (itemCount === 1 ? 'Delete favorite?' : `Delete ${itemCount} favorites?`)
            : 'Remove from playlist?';
        const desc = allFavRoots
            ? (itemCount === 1
                ? 'This shortcut or playlist will be removed.'
                : `${itemCount} favorites will be removed.`)
            : `${itemCount} item${itemCount > 1 ? 's' : ''} will be removed from the playlist.`;

        showModal(title, (modal, close) => {
            const p = document.createElement('p');
            p.textContent = desc;
            modal.appendChild(p);

            addModalActions(modal, close, 'Delete', async () => {
                if (allFavRoots) {
                    for (const cp of paths) {
                        if (cp.favId) await favorites.remove(cp.favId);
                    }
                } else if (allPlaylistMembers) {
                    const playlistId = paths[0].favId!;
                    const indices = paths.map(p => p.memberIndex);
                    await favorites.removeMembers(playlistId, indices);
                }
                close();
                select.exitSelectMode();
            }, true);
        });
    };

    /** Share popup: shortcut, add to playlist, new playlist. */
    const showSharePopup = (): void => {
        const actions = computeAvailableActions();
        const items: Array<{ label: string; danger?: boolean; chevron?: boolean; onClick: () => void }> = [];

        if (actions.shortcut && actions.folder) {
            const folder = actions.folder;
            items.push({ label: 'Add as Shortcut ☆', onClick: () => showShortcutModal(folder) });
        }
        if (actions.playlist) {
            items.push({ label: 'Add to existing playlist ♫', onClick: () => showPlaylistModal() });
        }
        // "Put in new playlist" is always available
        items.push({
            label: 'Put in new playlist ♫',
            onClick: () => showCreatePlaylistModal(buildMembersFromSelection()),
        });

        toggleActionDropdown(shareBtn, items);
    };

    /** Builds the dropdown items for a single favorite shown from the action bar. */
    const buildFavItems = (favId: string): Array<{ label: string; danger?: boolean; chevron?: boolean; onClick: () => void }> => {
        const fav = favorites.getAll().find(f => f.id === favId);
        if (!fav) return [];

        const items: Array<{ label: string; danger?: boolean; chevron?: boolean; onClick: () => void }> = [];

        items.push({
            label: fav.hasPrivatePlayback ? 'Remember my spot \u2713' : 'Remember my spot',
            onClick: async () => {
                await favorites.setHasPrivatePlayback(favId, !fav.hasPrivatePlayback);
            },
        });

        // Offline download menu item (opens modal for details)
        if (downloadsRef) {
            const isOffline = fav.offlinePin !== undefined;
            items.push({
                label: offlineTitle(isOffline),
                onClick: () => showOfflineModal(favId),
            });
        }

        if (fav.kind === 'playlist') {
            items.push({
                label: 'Rename…',
                onClick: () => {
                    if (active) select.exitSelectMode();
                    showRenameModal(favId);
                },
            });
        }

        items.push({
            label: 'Delete…',
            danger: true,
            onClick: () => {
                // INVARIANT: this popup is only shown in `moreMemory` mode.
                // `moreMemory` means exactly one selected top-level favorite, so
                // the shared delete modal naturally renders the single-favorite
                // confirmation variant for this action.
                showDeleteModal();
            },
        });

        return items;
    };

    /** Rename sub-dialog. */
    const showRenameModal = (favId: string): void => {
        const fav = favorites.getAll().find(f => f.id === favId);
        if (!fav) return;
        const normalizePlaylistName = (name: string): string => name.trim().toLocaleLowerCase();
        const isPlaylistNameUnique = (name: string): boolean => {
            const normalized = normalizePlaylistName(name);
            if (!normalized) return false;
            return !favorites.getAll().some(f =>
                f.kind === 'playlist'
                && f.id !== favId
                && normalizePlaylistName(f.name) === normalized,
            );
        };

        showModal('Rename', (modal, close) => {
            const input = document.createElement('input');
            input.type = 'text';
            input.value = fav.name;
            configureNameTextInput(input);
            modal.appendChild(input);

            const confirmBtn = addModalActions(modal, close, 'Save', async () => {
                const name = input.value.trim();
                if (!isPlaylistNameUnique(name)) return;
                await favorites.rename(favId, name);
                close();
                select.exitSelectMode();
            });

            const syncConfirmEnabled = (): void => {
                confirmBtn.disabled = !isPlaylistNameUnique(input.value);
            };
            input.addEventListener('input', syncConfirmEnabled);
            syncConfirmEnabled();
            focusTextInput(input, true);
        }, undefined, true);
    };

    // -- Offline modal --------------------------------------------------------

    /** Live updates replace text and button visibility in place so an open quota picker keeps its focus. */
    let refreshOfflineModal: (() => void) | undefined;
    const offlineTitle = (marked: boolean): string => marked ? 'Available offline…' : 'Make available offline';

    /** Formats bytes as "X.X Gb" or "X Mb". */
    const formatBytes = (bytes: number): string =>
        bytes >= 1024 * 1024 * 1024 ? `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} Gb`
        : bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(0)} Mb`
        : `${(bytes / 1024).toFixed(0)} Kb`;

    /** Favorites and physical folders share the same offline dialog. Capture its target once,
     * then read committed pin state and local progress on each update. */
    const showOfflineModal = (target: string | FolderPin): void => {
        const downloads = downloadsRef;
        if (!downloads) return;
        const folder = typeof target === 'string' ? undefined : target;
        const favorite = () => typeof target === 'string' ? favorites.getAll().find(f => f.id === target) : undefined;
        if (!folder && !favorite()) return;
        select.exitSelectMode();
        const backdrop = document.createElement('div');
        backdrop.className = 'modal-backdrop';
        const modal = document.createElement('div');
        modal.className = 'modal';
        const closeBtn = document.createElement('button');
        closeBtn.className = 'modal-close';
        closeBtn.type = 'button';
        closeBtn.setAttribute('aria-label', 'Close');
        closeBtn.textContent = '×';
        const title = document.createElement('h3');
        const row = document.createElement('div');
        row.className = 'offline-fav-row';
        const name = document.createElement('span');
        const icon = document.createElement('span');
        const badge = document.createElement('span');
        const fav = favorite();
        if (fav) {
            icon.className = 'fav-icon';
            icon.textContent = '\u2002' + (fav.kind === 'playlist' ? '♫' : '☆');
        }
        row.append(name, icon, badge);
        modal.append(closeBtn, title, row);

        // Stats line
        const statsEl = document.createElement('div');
        statsEl.className = 'offline-progress';
        modal.appendChild(statsEl);

        // Warning line (conditional)
        const warningEl = document.createElement('div');
        warningEl.className = 'offline-warning';
        modal.appendChild(warningEl);

        // Global stats — structure created once, text updated live
        const globalEl = document.createElement('div');
        globalEl.className = 'offline-global';
        const globalLabel = document.createElement('div');
        globalLabel.textContent = 'Overall storage:';
        const globalDetail = document.createElement('div');
        const globalCountText = document.createTextNode('');
        const quotaSelect = document.createElement('select');
        for (const gb of QUOTA_OPTIONS_GB) {
            const opt = document.createElement('option');
            opt.value = String(gb);
            opt.textContent = `${gb}.0 Gb max`;
            quotaSelect.appendChild(opt);
        }
        quotaSelect.addEventListener('change', () => {
            downloads.setQuota(parseFloat(quotaSelect.value));
        });
        globalDetail.append(globalCountText, quotaSelect);
        globalEl.append(globalLabel, globalDetail);
        modal.appendChild(globalEl);

        // Pause/Resume glyph (inline in statsEl, updated live)
        const pauseBtn = document.createElement('button');
        pauseBtn.type = 'button';
        pauseBtn.className = 'offline-pauseplay';

        const actions = document.createElement('div');
        actions.className = 'modal-actions offline-actions';
        modal.appendChild(actions);
        let saving = false;
        type OfflineAction = 'pin' | 'unpin' | 'pause' | 'resume' | 'retry';
        let progressAction: 'pause' | 'resume' | 'retry' = 'pause';
        let saveError = '';
        const close = (): void => {
            if (saving) return;
            backdrop.remove();
            if (refreshOfflineModal !== renderOfflineModal) return;
            refreshOfflineModal = undefined;
            downloads.folderProgress(undefined);
        };
        closeBtn.addEventListener('click', close);
        backdrop.addEventListener('click', event => { if (event.target === backdrop) close(); });

        /** A local write failure leaves the same target and its current actions in the dialog. */
        const save = async (action: OfflineAction): Promise<void> => {
            if (saving) return;
            const membership = action === 'pin' || action === 'unpin';
            saving = true;
            saveError = '';
            renderOfflineModal();
            try {
                if (action === 'retry') await downloads.clearError?.();
                else if (folder && membership) await favorites.setFolderPinned(folder, action === 'pin', roots);
                else if (typeof target === 'string') {
                    if (action === 'resume' && downloads.getSnapshot().lastError) await downloads.clearError?.();
                    await favorites.setOfflinePin(target, action === 'unpin' ? undefined : {paused: action === 'pause'});
                }
            } catch (error) {
                logError('Could not update offline downloads: ' + String(error));
                saveError = 'Could not finish updating downloads. Try again.';
            } finally {
                saving = false;
                if (membership && !saveError) close();
                else if (refreshOfflineModal === renderOfflineModal) renderOfflineModal();
            }
        };
        const buttons = (['pin', 'unpin'] as const).map(action => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'modal-cancel';
            button.textContent = action === 'pin' ? 'Make available offline' : 'Make unavailable offline';
            actions.appendChild(button);
            button.addEventListener('click', () => save(action));
            return button;
        });
        pauseBtn.addEventListener('click', () => save(progressAction));

        /** The partial row describes the marked child folders and their unique tracks. */
        const renderOfflineModal = (): void => {
            const fav = favorite();
            const state = folder ? tree.getFolderOfflineState(folder) : undefined;
            const marked = state ? state.coverage !== 'none' : !!fav?.offlinePin;
            const partial = state?.coverage === 'partial';
            const progress = folder ? downloads.folderProgress(folder) : undefined;
            const cached = folder ? progress : fav && downloads.favoriteProgress(fav.id);
            const current = folder ? physicalFolderAt(['OnePlay Music', folder.sourceRootKey, ...folder.path]) : undefined;
            const changedFolder = !!folder && (current?.itemId !== folder.itemId || current.connectionId !== folder.connectionId);
            const editable = folder ? !changedFolder && state?.coverage !== 'covered' : !!fav;
            name.textContent = partial && progress?.childFolders !== undefined
                ? `${progress.childFolders} child folder${progress.childFolders === 1 ? '' : 's'}`
                : folder?.path.at(-1) ?? fav?.name ?? '';
            title.textContent = offlineTitle(marked);
            buttons[0].hidden = !editable || (marked && !partial);
            buttons[1].hidden = !editable || !marked;
            closeBtn.disabled = pauseBtn.disabled = saving;
            for (const button of buttons) button.disabled = saving;
            const snap = downloads.getSnapshot();
            const iconState = state?.badge ?? classifyOfflineBadgeState(cached, snap, !!fav?.offlinePin?.paused);
            setOfflineBadge(badge, marked ? iconState : undefined, partial);
            const incomplete = marked && iconState !== 'complete';
            const downloading = iconState === 'downloading';
            statsEl.textContent = '';
            if (!cached || (!cached.complete && !cached.total)) {
                statsEl.textContent = 'Waiting for the library…';
            } else {
                const trackLabel = `${cached.total} track${cached.total === 1 ? '' : 's'}`;
                statsEl.textContent = !marked ? trackLabel
                    : !incomplete ? `${trackLabel}, ${formatBytes(cached.bytes)} ✓`
                    : cached.warnings?.size && !downloading && !fav?.offlinePin?.paused ? `${cached.downloaded}/${cached.total} tracks available offline`
                    : `${downloading ? 'Downloading' : 'Paused'} ${cached.downloaded}/${cached.total} tracks`;
            }
            const canRetry = downloads.clearError && (snap.lastError || (!downloading && cached?.unavailable));
            if (incomplete && (fav?.offlinePin?.paused || canRetry || (fav && downloading))) {
                progressAction = fav?.offlinePin?.paused ? 'resume' : canRetry ? 'retry' : 'pause';
                pauseBtn.textContent = progressAction === 'pause' ? '⏸︎' : '▶︎';
                pauseBtn.setAttribute('aria-label', progressAction === 'pause' ? 'Pause downloads'
                    : progressAction === 'resume' ? 'Resume downloads' : 'Retry downloads');
                statsEl.appendChild(pauseBtn);
            }
            warningEl.innerText = changedFolder ? 'The folder has changed. Select it again.' : saveError || (
                !incomplete || fav?.offlinePin?.paused ? ''
                : snap.overQuota ? 'Reached storage limit'
                : snap.evidence === 'evidence:signed-out' ? 'Not signed in'
                : snap.evidence === 'evidence:not-online' ? 'Not online'
                : cached?.warnings?.size ? [...cached.warnings].join('\n')
                : downloading ? '' : snap.lastError ?? '');

            const downloaded = snap.files.size;
            const queued = snap.queuedCount;
            const gb = snap.quotaBytes / (1024 ** 3);
            globalCountText.textContent = queued && snap.evidence === 'evidence:signed-in'
                ? `${downloaded}/${downloaded + queued} tracks, ${formatBytes(snap.totalBytes)} / `
                : `${downloaded} tracks, ${formatBytes(snap.totalBytes)} / `;
            quotaSelect.value = String(QUOTA_OPTIONS_GB.find(option => Math.abs(option - gb) < 0.1) ?? gb);
        };
        backdrop.appendChild(modal);
        document.body.appendChild(backdrop);
        refreshOfflineModal = renderOfflineModal;
        renderOfflineModal();
    };

    // -- Long-press detection -------------------------------------------------

    let longPressTimer: ReturnType<typeof setTimeout> | undefined;
    let longPressPointerId: number | undefined;
    let longPressStartX = 0;
    let longPressStartY = 0;
    /** Flag to suppress contextmenu right after a long-press fires. */
    let suppressContextMenu = false;
    // Re-rendering checkboxes during a long-press leaves the finger over a selected row.
    // Its release click belongs to the press that entered selection.
    let suppressLongPressClick = false;
    /** Tracks latest long-press entry for diagnostic logging on immediate exits. */
    let lastLongPressEnterAt = 0;
    let lastLongPressEnteredPath: FolderPath | undefined;

    const cancelLongPress = (): void => {
        if (longPressTimer !== undefined) {
            clearTimeout(longPressTimer);
            longPressTimer = undefined;
        }
        longPressPointerId = undefined;
    };

    const isSelectablePath = (path: FolderPath): boolean =>
        path.length > 1 && !(path.length === 2 && !path[1].startsWith(FAV_PREFIX));

    const pathFromTreeEventTarget = (target: EventTarget | null): FolderPath | undefined => {
        const element = target instanceof Element ? target : null;
        if (element?.closest('.play-btn')) return undefined;
        const row = element?.closest<HTMLElement>(
            '#children .tree-row[data-path], #breadcrumbs .tree-row[data-path]',
        );
        return row?.dataset.path ? JSON.parse(row.dataset.path) : undefined;
    };

    // JS hardening: suppress text selection app-wide. CSS user-select:none
    // on body is unreliable on some iOS Safari versions; this safety net
    // prevents the callout from appearing anywhere in the app.
    // Exception: text inputs and the log panel must allow selection.
    document.addEventListener('selectstart', (e) => {
        const el = e.target as HTMLElement;
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return;
        if (el.closest('#log-panel')) return;
        e.preventDefault();
    });

    // WebKit and Chromium can retarget the release click to the newly opened menu
    // when it covers the held coordinate. Consume that gesture anywhere on the page.
    document.addEventListener('click', event => {
        if (!suppressLongPressClick || event.detail === 0) return;
        suppressLongPressClick = false;
        event.preventDefault();
        event.stopPropagation();
    }, true);

    // A fresh press on any target, including the menu itself, owns its next click.
    document.addEventListener('pointerdown', e => {
        if (e.isPrimary) suppressLongPressClick = false;
    }, true);

    treeContainer.addEventListener('pointerdown', (e) => {
        if (!e.isPrimary) return;
        suppressContextMenu = false;
        if (e.button !== 0) return;
        if (active) return; // already in select mode
        const path = pathFromTreeEventTarget(e.target);
        if (!path || !isSelectablePath(path)) return;

        cancelLongPress();
        longPressPointerId = e.pointerId;
        longPressStartX = e.clientX;
        longPressStartY = e.clientY;

        longPressTimer = setTimeout(() => {
            longPressTimer = undefined;
            longPressPointerId = undefined;
            suppressContextMenu = true;
            suppressLongPressClick = true;
            lastLongPressEnterAt = performance.now();
            lastLongPressEnteredPath = path;
            select.enterSelectModeWithRow(path);
        }, LONG_PRESS_MS);
    });

    document.addEventListener('pointermove', (e) => {
        if (e.pointerId !== longPressPointerId) return;
        const dx = e.clientX - longPressStartX;
        const dy = e.clientY - longPressStartY;
        if (Math.hypot(dx, dy) > LONG_PRESS_MOVE_THRESHOLD) cancelLongPress();
    });

    document.addEventListener('pointerup', (e) => {
        if (e.pointerId === longPressPointerId) cancelLongPress();
    });

    document.addEventListener('pointercancel', (e) => {
        if (e.pointerId === longPressPointerId) cancelLongPress();
    });

    // -- Right-click detection ------------------------------------------------

    treeContainer.addEventListener('contextmenu', (e) => {
        if (suppressContextMenu) {
            suppressContextMenu = false;
            e.preventDefault();
            return;
        }
        const path = pathFromTreeEventTarget(e.target);
        if (!path || !isSelectablePath(path)) return;
        e.preventDefault();
        if (!active) {
            select.enterSelectModeWithRow(path);
        }
    });

    // -- Action bar button handlers -------------------------------------------

    shareBtn.addEventListener('click', () => showSharePopup());
    // -- Cancel button --------------------------------------------------------

    cancelBtn.addEventListener('click', () => select.exitSelectMode());

    // -- Public API -----------------------------------------------------------

    const select: Select = {
        isActive: () => active,
        getSelectedPaths: () => selectedPaths,

        toggle(path) {
            dismissActionDropdown();
            const key = JSON.stringify(path);
            if (selectedPaths.has(key)) {
                selectedPaths.delete(key);
            } else {
                selectedPaths.add(key);
            }
            // Exit select mode if nothing selected
            if (selectedPaths.size === 0) {
                select.exitSelectMode();
                return;
            }
            syncActionBar();
        },

        enterSelectModeWithRow(path) {
            if (active) return;
            active = true;
            selectedPaths.clear();
            selectedPaths.add(JSON.stringify(path));
            select.onEnterSelect();
            const menuButton = syncActionBar();
            tree.setSelectMode(true, selectedPaths);
            menuButton.click();
            log(`select: entered with ${JSON.stringify(path)}`);
        },

        exitSelectMode() {
            if (!active) return;
            const selectedCountBeforeExit = selectedPaths.size;
            const elapsedSinceLongPress = lastLongPressEnterAt > 0
                ? performance.now() - lastLongPressEnterAt
                : Infinity;
            if (selectedCountBeforeExit === 0 && elapsedSinceLongPress <= SUSPICIOUS_LONG_PRESS_EXIT_MS) {
                logError(
                    'select: suspicious immediate exit after long-press'
                    + ` elapsedMs=${Math.round(elapsedSinceLongPress)}`
                    + ` path=${JSON.stringify(lastLongPressEnteredPath ?? [])}`,
                );
            }
            lastLongPressEnterAt = 0;
            lastLongPressEnteredPath = undefined;
            dismissActionDropdown();
            active = false;
            selectedPaths.clear();
            select.onExitSelect();
            tree.setSelectMode(false, selectedPaths);
            log('select: exited');
        },

        setRoots(newRoots) {
            roots = newRoots;
            if (active) syncActionBar();
        },

        onEnterSelect: () => {},
        onExitSelect: () => {},
        onNavigateToFav: () => {},
        setDownloads(dl) { downloadsRef = dl; },
        updateOfflineModal() { refreshOfflineModal?.(); },
        refreshFolderActions() { if (active) syncActionBar(); },
    };

    return select;
}
