/**
 * Select mode module for OnePlay Music.
 *
 * Manages multi-select for favorites CRUD: long-press / right-click enters
 * select mode, a three-zone action bar (share · summary text · more) offers
 * actions via popup menus. Modals handle user input for each action.
 * A per-favorite dropdown is available from the action bar right button when
 * exactly one top-level favorite is selected.
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

import { type FolderPath } from './tree.js';
import { type Favorites, type RootsMap, type PlaylistMember, type ItemRef } from './favorites.js';
import { type TreeView } from './tree.js';
import { walkFolder } from './indexer.js';
import { log, logError } from './logger.js';
import { type Downloads, QUOTA_OPTIONS_GB } from './downloads.js';
import { collectPhysicalTracks } from './tracks.js';
import { isWalkableRoot } from './roots.js';
import { buildMembersFromSelection as buildMembersFromSelectionFromState } from './select-dialogs.js';
import {
    showModal,
    addModalActions,
    showDropdown,
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
    setDownloads(downloads: Downloads): void;
    /** Updates the offline modal DOM if it's currently open. Called on download state changes. */
    updateOfflineModal(): void;
}

/** Which actions are available based on selection state. */
interface AvailableActions {
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
    let downloadsRef: Downloads | undefined;

    // -- Action bar DOM (three-zone layout, built once) -----------------------
    // Left: share circle button. Center: selection summary text. Right: dynamic icon.
    // The right button shows ☆/♫ for a single favorite, a trash icon for multi-delete,
    // or is hidden when no actions apply. visibility:hidden (not display:none) keeps
    // center text centered via flex layout.

    const shareBtn = document.createElement('button');
    shareBtn.type = 'button';
    shareBtn.className = 'action-btn share-btn';
    // iOS-style share glyph (box with upward arrow) — using SF Symbol equivalent
    shareBtn.innerHTML = '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13V3M10 3L6 7M10 3l4 4"/><path d="M3 10v7a1 1 0 001 1h12a1 1 0 001-1v-7"/></svg>';

    const actionText = document.createElement('div');
    actionText.className = 'action-bar-text';
    actionText.textContent = 'Select Items';

    const rightBtn = document.createElement('button');
    rightBtn.type = 'button';
    rightBtn.className = 'action-btn right-btn';

    /** Tracks what the right button currently represents, so the click handler
     *  knows whether to show a fav dropdown or go straight to delete. */
    let rightBtnMode: 'fav' | 'delete' | 'hidden' = 'hidden';
    let rightBtnFavId: string | undefined;

    actionBarEl.append(shareBtn, actionText, rightBtn);

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

    /** Resolves direct-root path context for ItemRef creation / folder checks. */
    const rootContextForPath = (path: FolderPath): {
        folder: import('./indexer.js').MusicFolder;
        driveId: string;
        sourceRootKey: string | undefined;
    } | undefined => {
        if (path.length < 2) return undefined;
        const root = roots.get(path[1]);
        if (!isWalkableRoot(root)) return undefined;
        return {
            folder: root.folder,
            driveId: root.type === 'onedrive' ? root.info.driveId : root.driveId,
            sourceRootKey: root.type === 'share' ? root.key : undefined,
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
        const shortcutOk = paths.length === 1 && (() => {
            const p = paths[0];
            if (p.path.length < 3) return false;
            const ctx = rootContextForPath(p.path);
            if (!ctx) return false;
            // walkFolder returns undefined for files (no children property)
            if (!walkFolder(ctx.folder, p.path.slice(2))) return false;
            const allFavs = favorites.getAll();
            return !allFavs.some(f =>
                f.kind === 'shortcut'
                && f.target.driveId === ctx.driveId
                && f.target.sourceRootKey === ctx.sourceRootKey
                && JSON.stringify(f.target.path) === JSON.stringify(p.path.slice(2)),
            );
        })();

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
    const syncActionBar = (): void => {
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
                    const ctx = rootContextForPath(cp.path);
                    const isFolder = ctx !== undefined
                        && walkFolder(ctx.folder, cp.path.slice(2)) !== undefined;
                    if (isFolder) folders++; else tracks++;
                } else {
                    folders++; // account-level rows are folders
                }
            }
            actionText.textContent = tracks === 0 ? `${count} Folder${count > 1 ? 's' : ''}`
                : folders === 0 ? `${count} Track${count > 1 ? 's' : ''}`
                : `${count} Selected`;
        }

        const actions = computeAvailableActions();

        // Right button: ☆/♫ for single favorite, trash for multi-delete, hidden otherwise
        if (actions.moreMemory) {
            // INVARIANT: moreMemory implies exactly 1 top-level favorite selected
            const paths = Array.from(selectedPaths).map(classifyPath);
            const favId = paths[0].favId!;
            const fav = favorites.getAll().find(f => f.id === favId);
            rightBtnMode = 'fav';
            rightBtnFavId = favId;
            rightBtn.textContent = fav?.kind === 'playlist' ? '♫' : '☆';
            rightBtn.classList.remove('hidden');
        } else if (actions.delete) {
            rightBtnMode = 'delete';
            rightBtnFavId = undefined;
            rightBtn.innerHTML = '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5h14M7 5V4a1 1 0 011-1h4a1 1 0 011 1v1M5 5v12a1 1 0 001 1h8a1 1 0 001-1V5"/><path d="M8 9v5M12 9v5"/></svg>';
            rightBtn.classList.remove('hidden');
        } else {
            rightBtnMode = 'hidden';
            rightBtnFavId = undefined;
            rightBtn.classList.add('hidden');
        }
    };

    // -- Modals ---------------------------------------------------------------

    /** Shortcut creation modal: "Add new shortcut" with name and hasPrivatePlayback. */
    const showShortcutModal = (): void => {
        const paths = Array.from(selectedPaths).map(classifyPath);
        if (paths.length !== 1) return;
        const p = paths[0];
        const ctx = rootContextForPath(p.path);
        if (!ctx) return;

        // Resolve the folder to get its itemId using walkFolder
        const folderPath = p.path.slice(2);
        const folderName = folderPath[folderPath.length - 1] || 'Folder';
        const folder = folderPath.length === 0 ? ctx.folder : walkFolder(ctx.folder, folderPath);
        if (!folder) return;
        const folderId = folder.id;

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
                const target: ItemRef = {
                    driveId: ctx.driveId,
                    itemId: folderId,
                    path: [...folderPath],
                    isFolder: true,
                    sourceRootKey: ctx.sourceRootKey,
                };
                const id = crypto.randomUUID();
                await favorites.add({
                    kind: 'shortcut',
                    id,
                    name: folderName,
                    target,
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

        if (actions.shortcut) {
            items.push({ label: 'Add as Shortcut ☆', onClick: () => showShortcutModal() });
        }
        if (actions.playlist) {
            items.push({ label: 'Add to existing playlist ♫', onClick: () => showPlaylistModal() });
        }
        // "Put in new playlist" is always available
        items.push({
            label: 'Put in new playlist ♫',
            onClick: () => showCreatePlaylistModal(buildMembersFromSelection()),
        });

        showDropdown(shareBtn, items, 'action-dropdown');
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
                label: isOffline ? 'Available offline…' : 'Make available offline…',
                onClick: () => {
                    if (active) select.exitSelectMode();
                    showOfflineModal(favId, isOffline);
                },
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

    /** State for the live-updating offline modal. */
    let modalFavId: string | undefined;
    let modalEls: {
        statsEl: HTMLElement;
        warningEl: HTMLElement;
        globalCountText: Text;
        quotaSelect: HTMLSelectElement;
        badgeEl: HTMLSpanElement;
        actionBtn: HTMLButtonElement;
        pauseBtn: HTMLSpanElement;
    } | undefined;

    /** Formats bytes as "X.X Gb" or "X Mb". */
    const formatBytes = (bytes: number): string =>
        bytes >= 1024 * 1024 * 1024 ? `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} Gb`
        : bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(0)} Mb`
        : `${(bytes / 1024).toFixed(0)} Kb`;

    /**
     * Shows the Available Offline modal for a favorite.
     * Reads favorite data from the favorites module (already available) and
     * download progress from the downloads snapshot API.
     */
    const showOfflineModal = (favId: string, isCurrentlyOffline: boolean): void => {
        if (!downloadsRef) return;
        const fav = favorites.getAll().find(f => f.id === favId);
        if (!fav) return;

        modalFavId = favId;

        const backdrop = document.createElement('div');
        backdrop.className = 'modal-backdrop';

        const modal = document.createElement('div');
        modal.className = 'modal';

        // Close ✕ button at top-right
        const closeBtn = document.createElement('button');
        closeBtn.className = 'modal-close';
        closeBtn.type = 'button';
        closeBtn.textContent = '\u00D7'; // ×
        modal.appendChild(closeBtn);

        // Title
        const h3 = document.createElement('h3');
        h3.textContent = isCurrentlyOffline ? 'Available Offline' : 'Make Available Offline';
        modal.appendChild(h3);

        // Fav row: name + icon + badge, matching tree row display order
        const favRow = document.createElement('div');
        favRow.className = 'offline-fav-row';
        const favName = document.createElement('span');
        favName.textContent = fav.name;
        const favIcon = document.createElement('span');
        favIcon.className = 'fav-icon';
        favIcon.textContent = '\u2002' + (fav.kind === 'playlist' ? '♫' : '☆');
        const badgeEl = document.createElement('span');
        favRow.append(favName, favIcon, badgeEl);
        modal.appendChild(favRow);

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
            downloadsRef!.setQuota(parseFloat(quotaSelect.value));
        });
        globalDetail.append(globalCountText, quotaSelect);
        globalEl.append(globalLabel, globalDetail);
        modal.appendChild(globalEl);

        // Pause/Resume glyph (inline in statsEl, updated live)
        const pauseBtn = document.createElement('span');
        pauseBtn.className = 'offline-pauseplay';

        // Action button (left-aligned: single button, reads naturally with content above)
        const actions = document.createElement('div');
        actions.className = 'modal-actions';
        actions.style.justifyContent = 'flex-start';

        const actionBtn = document.createElement('button');
        actionBtn.type = 'button';
        actionBtn.className = 'modal-cancel';
        actionBtn.textContent = isCurrentlyOffline ? 'Make unavailable offline' : 'Make available offline';

        actions.appendChild(actionBtn);
        modal.appendChild(actions);

        // Store references for live updates
        modalEls = { statsEl, warningEl, globalCountText, quotaSelect, badgeEl, actionBtn, pauseBtn };

        const close = (): void => {
            backdrop.remove();
            modalFavId = undefined;
            modalEls = undefined;
        };

        // Event handlers
        closeBtn.addEventListener('click', close);
        backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

        actionBtn.addEventListener('click', async () => {
            if (isCurrentlyOffline) {
                await favorites.setOfflinePin(favId, undefined);
            } else {
                await favorites.setOfflinePin(favId, { paused: false });
            }
            close();
        });

        pauseBtn.addEventListener('click', async () => {
            const currentFav = favorites.getAll().find(f => f.id === favId);
            if (!currentFav?.offlinePin) return;
            const wasPaused = currentFav.offlinePin.paused;
            if (wasPaused) downloadsRef!.clearError(); // resume also clears latched error
            await favorites.setOfflinePin(favId, { paused: !wasPaused });
        });

        backdrop.appendChild(modal);
        document.body.appendChild(backdrop);

        // Initial update
        updateOfflineModalLive();
    };

    /** Updates the offline modal DOM elements with current download state. */
    const updateOfflineModalLive = (): void => {
        if (!modalEls || !modalFavId || !downloadsRef) return;
        const { statsEl, warningEl, globalCountText, quotaSelect, badgeEl, pauseBtn } = modalEls;
        const fav = favorites.getAll().find(f => f.id === modalFavId);
        if (!fav) return;

        // Compute per-favorite track keys (one-time per update)
        const tracks = collectPhysicalTracks(modalFavId, favorites, roots);
        const trackKeys = new Set(tracks.map(t => `${t.driveId}:${t.itemId}`));
        const totalTracks = trackKeys.size;

        const snap = downloadsRef.getSnapshot();
        const downloadedCount = Array.from(trackKeys).filter(k => snap.downloadedKeys.has(k)).length;

        // Badge: matches tree row logic from index.ts computeAndPushOfflineState
        if (!fav.offlinePin) {
            badgeEl.className = '';
            badgeEl.textContent = '';
        } else {
            const hasQueued = Array.from(trackKeys).some(k => !snap.downloadedKeys.has(k));
            const iconState = (hasQueued && (fav.offlinePin.paused || snap.overQuota || snap.lastError)) ? 'paused'
                : (snap.evidence === 'evidence:signed-in' && hasQueued) ? 'downloading'
                : 'complete';
            badgeEl.className = 'offline-badge'
                + (iconState === 'downloading' ? ' downloading' : '')
                + (iconState === 'paused' ? ' paused' : '');
            badgeEl.textContent = '\u2193';
        }

        // Stats line: "28 tracks" | "Downloading 3/28 tracks ⏸︎" | "Paused 3/28 tracks ▶︎" | "28 tracks, 43 Mb ✓"
        const incomplete = fav.offlinePin && downloadedCount < totalTracks;
        const trackLabel = `${totalTracks} track${totalTracks !== 1 ? 's' : ''}`;
        const isDownloading = incomplete && !fav.offlinePin!.paused && !snap.overQuota
            && !snap.lastError && snap.evidence === 'evidence:signed-in';

        statsEl.textContent = '';
        if (!fav.offlinePin) {
            statsEl.textContent = trackLabel;
        } else if (downloadedCount === totalTracks) {
            // Estimate this favorite's bytes proportionally from global totals
            const favBytes = snap.downloadedKeys.size > 0
                ? snap.totalBytes * downloadedCount / snap.downloadedKeys.size : 0;
            statsEl.textContent = `${trackLabel}, ${formatBytes(favBytes)} \u2713`;
        } else if (isDownloading) {
            pauseBtn.textContent = '\u2002\u23F8\uFE0E'; // ⏸︎
            statsEl.append(
                document.createTextNode(`Downloading ${downloadedCount}/${totalTracks} tracks`),
                pauseBtn,
            );
        } else {
            pauseBtn.textContent = '\u2002\u25B6\uFE0E'; // ▶︎
            statsEl.append(
                document.createTextNode(`Paused ${downloadedCount}/${totalTracks} tracks`),
                pauseBtn,
            );
        }

        // Show pause/resume glyph:
        //   paused:true → show ▶︎ (resume clears paused)
        //   lastError → show ▶︎ (resume clears error)
        //   else → show ⏸︎ only if downloading (signed-in, not over quota)
        pauseBtn.style.display = incomplete ? '' : 'none';
        if (incomplete && !isDownloading) {
            const showResume = fav.offlinePin!.paused || !!snap.lastError
                || (!snap.overQuota && snap.evidence === 'evidence:signed-in');
            pauseBtn.style.display = showResume ? '' : 'none';
        }

        // Warning line: reason for being paused (not shown for user-initiated pause)
        warningEl.textContent = '';
        if (incomplete && !isDownloading && !fav.offlinePin!.paused) {
            if (snap.overQuota) warningEl.textContent = 'Reached storage limit';
            else if (snap.evidence === 'evidence:signed-out') warningEl.textContent = 'Not signed in';
            else if (snap.evidence === 'evidence:not-online') warningEl.textContent = 'Not online';
            else if (snap.lastError) warningEl.textContent = snap.lastError;
        }

        // Global: update text and quota select value (DOM structure is stable)
        const globalDownloaded = snap.downloadedKeys.size;
        const globalQueued = snap.queuedKeys.size;
        const globalTotal = globalDownloaded + globalQueued;
        const hasActiveDownloads = globalQueued > 0 && snap.evidence === 'evidence:signed-in';
        const currentQuotaGb = snap.quotaBytes / (1024 * 1024 * 1024);

        globalCountText.textContent = hasActiveDownloads
            ? `${globalDownloaded}/${globalTotal} tracks, ${formatBytes(snap.totalBytes)} / `
            : `${globalDownloaded} tracks, ${formatBytes(snap.totalBytes)} / `;
        quotaSelect.value = String(QUOTA_OPTIONS_GB.find(gb => Math.abs(gb - currentQuotaGb) < 0.1) ?? currentQuotaGb);
    };

    // -- Long-press detection -------------------------------------------------

    let longPressTimer: ReturnType<typeof setTimeout> | undefined;
    let longPressPointerId: number | undefined;
    let longPressStartX = 0;
    let longPressStartY = 0;
    /** Flag to suppress contextmenu right after a long-press fires. */
    let suppressContextMenu = false;
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
        const row = (target as HTMLElement | null)?.closest<HTMLElement>(
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

    treeContainer.addEventListener('pointerdown', (e) => {
        if (!e.isPrimary || e.button !== 0) return;
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
    rightBtn.addEventListener('click', () => {
        if (rightBtnMode === 'fav' && rightBtnFavId) {
            // Single favorite: show the favorite-management dropdown.
            const items = buildFavItems(rightBtnFavId);
            if (items.length > 0) showDropdown(rightBtn, items, 'action-dropdown');
        } else if (rightBtnMode === 'delete') {
            // Multiple deletable items: go straight to delete confirmation
            showDeleteModal();
        }
    });

    // -- Cancel button --------------------------------------------------------

    cancelBtn.addEventListener('click', () => select.exitSelectMode());

    // -- Public API -----------------------------------------------------------

    const select: Select = {
        isActive: () => active,
        getSelectedPaths: () => selectedPaths,

        toggle(path) {
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
            syncActionBar();
            tree.setSelectMode(true, selectedPaths);
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
            active = false;
            selectedPaths.clear();
            select.onExitSelect();
            tree.setSelectMode(false, selectedPaths);
            log('select: exited');
        },

        setRoots(newRoots) {
            roots = newRoots;
        },

        onEnterSelect: () => {},
        onExitSelect: () => {},
        onNavigateToFav: () => {},
        setDownloads(dl) { downloadsRef = dl; },
        updateOfflineModal() { updateOfflineModalLive(); },
    };

    return select;
}
