/**
 * Favorites module for OnePlay Music.
 *
 * Manages shortcuts (☆) and playlists (♫). A shortcut references a OneDrive
 * folder; a playlist is an ordered list of members (folders, files, or
 * references to other favorites). Favorites are persisted to IndexedDB
 * (fast, best-effort) and the OneDrive App folder (best-effort, may fail
 * offline). An edit that fences a playback queue must commit to IndexedDB before
 * acknowledgment. Other settings and cloud writes remain best effort.
 *
 * INVARIANTS:
 * - Shortcut targets always have isFolder=true. Enforced at add() and load().
 * - Playlist member ordering is stable: path segments use "m:0", "m:1", etc.
 *   Display names are resolved separately via resolveDisplayName().
 * - Cycle freedom: enforced by wouldCreateCycle() at add-time. Additionally,
 *   resolveChildren() uses a visited set during FavRef traversal to guard
 *   against cycles from corrupt/legacy data.
 * - FavoritesData.updatedAt is the epoch-ms timestamp of the most recent
 *   mutation. On load, local vs server conflict is resolved by newer updatedAt.
 * - Every mutation (add, remove, heal) and loadFromCache/pullFavoritesFromOneDrive call
 *   state, so the tree re-renders.
 */

import { type MusicFolder, type MusicFile, isMusicFolder, walkFolder, sortedFolderChildren } from './indexer.js';
import { type PlaybackMode, isValidMode } from './playback.js';
import { log, logError, logCatch } from './logger.js';
import { resolveWalkableRootForItemRef } from './roots.js';
import { readGraphJson, type AuthFetch } from './auth.js';

// ---------------------------------------------------------------------------
// Dependency injection (for testability — see LEARNINGS.md "DI over extraction")
// ---------------------------------------------------------------------------

/** I/O dependencies injected by the app entrypoint. In unit tests, supply
 *  throwing stubs so accidental I/O paths fail fast. */
export interface FavoritesDeps {
    authFetch: AuthFetch;
    fencePinEdit?: () => Promise<() => void> | undefined;
    fenceQueueEdit?: () => Promise<void> | undefined;
    dbGet<T>(key: string): Promise<T | undefined>;
    dbPut(key: string, value: unknown): Promise<void>;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Reference to a OneDrive item (folder or file). */
export interface ItemRef {
    readonly driveId: string;
    readonly itemId: string;
    readonly path: readonly string[];
    readonly isFolder: boolean;
    /** Optional root identity used for share-backed refs (M14 multi-share disambiguation). */
    readonly sourceRootKey?: string;
}

/** Reference to another favorite (for playlist-in-playlist). */
export interface FavRef {
    readonly favId: string;
}

export type PlaylistMember = ItemRef | FavRef;

/** Type guard: is this member a FavRef (reference to another favorite)? */
export const isFavRef = (m: PlaylistMember): m is FavRef => 'favId' in m;

export interface Shortcut {
    readonly kind: 'shortcut';
    readonly id: string;
    readonly name: string;
    /** INVARIANT: target.isFolder is always true. Shortcuts reference folders,
     *  never files. Enforced at creation time and validated on load/add. */
    readonly target: ItemRef;
    readonly hasPrivatePlayback: boolean;
    /** Per-favorite playback mode. Persisted to OneDrive with favorites data.
     *  Undefined means "use global default" ('all'). */
    readonly mode?: PlaybackMode;
    /** Offline download pin. undefined = not offline.
     *  paused = user-paused downloads for this favorite. */
    readonly offlinePin?: { readonly paused: boolean };
}

export interface Playlist {
    readonly kind: 'playlist';
    readonly id: string;
    readonly name: string;
    readonly members: readonly PlaylistMember[];
    readonly hasPrivatePlayback: boolean;
    /** Per-favorite playback mode. Persisted to OneDrive with favorites data.
     *  Undefined means "use global default" ('all'). */
    readonly mode?: PlaybackMode;
    /** Offline download pin. undefined = not offline.
     *  paused = user-paused downloads for this favorite. */
    readonly offlinePin?: { readonly paused: boolean };
}

export type Favorite = Shortcut | Playlist;

export interface FavoritesData {
    readonly version: number;
    readonly updatedAt: number;
    readonly favorites: readonly Favorite[];
}

// ---------------------------------------------------------------------------
// Root type (consumed by tree.ts)
// ---------------------------------------------------------------------------

/** A root is a top-level item in the tree. */
export type Root =
    | { readonly type: 'onedrive'; readonly key: string; readonly name: string;
        readonly folder: MusicFolder; readonly info: import('./indexer.js').AccountInfo; readonly reindexing: boolean }
    | { readonly type: 'share'; readonly key: string; readonly name: string;
        readonly driveId: string; readonly folder?: MusicFolder; readonly reindexing: boolean }
    | { readonly type: 'shortcut'; readonly key: string; readonly name: string;
        readonly target: ItemRef }
    | { readonly type: 'playlist'; readonly key: string; readonly name: string;
        readonly members: readonly PlaylistMember[] };

/** Map from root key to Root. Used by tree.ts. */
export type RootsMap = Map<string, Root>;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface Favorites {
    hasLoadedMembership?(): boolean;
    /** All favorites in display order. */
    getAll(): readonly Favorite[];

    /** Add a favorite. Returns false if it would create a cycle or shortcut
     *  target is not a folder. Persists to IndexedDB + OneDrive. */
    add(fav: Favorite): Promise<boolean>;

    /** Remove a favorite by ID. Also removes FavRefs to it from all playlists.
     *  Persists to IndexedDB + OneDrive. */
    remove(id: string): Promise<void>;

    /** Check if adding memberId to playlistId would create a cycle. */
    wouldCreateCycle(playlistId: string, memberId: string): boolean;

    /** Resolve children for display. Returns [segment, isFolder] or undefined if broken.
     *  - Shortcut: resolves target folder, walks subPath, returns its sorted children.
     *  - Playlist (subPath empty): returns one entry per member, using "m:0", "m:1" etc.
     *  - Playlist (subPath non-empty): first segment is "m:N", resolves into that member. */
    resolveChildren(id: string, subPath: readonly string[], roots: RootsMap):
        Array<[string, boolean]> | undefined;

    /** Resolve display name for a path segment inside a favorite. For playlist
     *  members, maps "m:0" → the member's display name.
     *  Contract: name resolution is based only on favorites metadata (FavRef names,
     *  ItemRef.path tails), not live roots traversal. Names can therefore be
     *  briefly stale until heal/sync updates the stored refs. */
    resolveDisplayName(id: string, segment: string): string;

    /** Resolve the display name for the last segment of a logical path.
     *  Handles synthetic segments (m:N) by extracting favorite context from the
     *  path; does not require roots traversal.
     *  Contract: output reflects current favorites snapshot and may lag behind
     *  OneDrive renames until heal/sync rewrites ItemRef.path. */
    resolvePathSegmentName(path: readonly string[]): string;

    /** Heal broken references after index refresh. Persists if changes were made. */
    heal(
        roots: RootsMap,
        currentFolders: ReadonlyMap<string, MusicFolder>,
        removedRootKey?: string,
    ): Promise<void>;

    /** Persist to IndexedDB and OneDrive. */
    save(): Promise<void>;

    /** Rename a favorite. Trims whitespace; rejects empty/whitespace-only names
     *  (returns without mutation). Persists and calls onChange. */
    rename(id: string, newName: string): Promise<void>;

    /** Add members to an existing playlist. Skips duplicates (by driveId+itemId
     *  for ItemRefs, by favId for FavRefs). Cycle-checks FavRefs.
     *  Persists and calls onChange. */
    addMembers(playlistId: string, members: PlaylistMember[]): Promise<void>;

    /** Remove the members occupying the given rows when the command is issued.
     *  Earlier pending edits may shift those rows before this edit commits. */
    removeMembers(playlistId: string, indices: number[]): Promise<void>;

    /** Set hasPrivatePlayback on a favorite. Persists and calls onChange. */
    setHasPrivatePlayback(id: string, value: boolean): Promise<void>;

    /** Set playback mode on a favorite. No-op if value unchanged.
     *  Persists to IndexedDB + OneDrive and calls onChange. */
    setMode(id: string, mode: PlaybackMode): Promise<void>;

    /** Set offline pin on a favorite. undefined clears offline status.
     *  Persists to IndexedDB + OneDrive and calls onChange. */
    setOfflinePin(id: string, pin: { paused: boolean } | undefined): Promise<void>;

    /** Suppress persistence (for testing only). When suppressed, dbPut and
     *  authFetch become no-ops. Mutations still happen in memory and call onChange.
     *  INVARIANT: must only be called from test harnesses via page.evaluate. */
    _testOnlySuppressSave(suppress: boolean): void;

    /** Load favorites from IndexedDB into module state and call onChange().
     *  Cache-only — no network. Returns quickly so the UI renders immediately. */
    loadFromCache(): Promise<void>;

    /** Fetch favorites from OneDrive. If the server version has a newer
     *  updatedAt, adopt it, persist to IndexedDB, and call onChange(). */
    pullFavoritesFromOneDrive(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates the favorites module. The onChange callback is called after every
 * mutation so the tree can re-render.
 */
export function createFavorites(deps: FavoritesDeps, onChange: (origin?: 'sync') => void | Promise<void>): Favorites {
    let favorites: Favorite[] = [];
    let updatedAt = 0;
    let loadedMembership = false;
    /** Stashed originals for _testOnlySuppressSave restore. */
    let originalDeps: Pick<FavoritesDeps, 'authFetch' | 'dbPut'> | undefined;

    // -- Helpers -------------------------------------------------------------

    /** Finds a favorite by ID. */
    const findById = (id: string): Favorite | undefined =>
        favorites.find(f => f.id === id);

    /** Builds FavoritesData from current state. */
    const toData = (): FavoritesData => ({
        version: 1,
        updatedAt,
        favorites,
    });

    /** Validates a favorite on load/add. Returns true if valid. */
    const isValid = (fav: Favorite): boolean => {
        if (fav.kind === 'shortcut' && !fav.target.isFolder) {
            logError(`favorites: shortcut "${fav.name}" targets a file, rejected`);
            return false;
        }
        return true;
    };

    /** Normalizes a favorite loaded from storage, defaulting hasPrivatePlayback
     *  to false, validating mode with the canonical isValidMode guard
     *  (imported from playback.ts), and preserving offlinePin when present. */
    const normalize = (fav: Favorite): Favorite => ({
        ...fav,
        hasPrivatePlayback: fav.hasPrivatePlayback ?? false,
        mode: isValidMode(fav.mode) ? fav.mode : undefined,
        offlinePin: fav.offlinePin ?? undefined,
    });

    // -- Cycle detection -----------------------------------------------------

    /**
     * DFS on the FavRef graph from `memberId`. Returns true if it can reach
     * `targetPlaylistId`, meaning adding memberId to targetPlaylistId would
     * create a cycle.
     */
    const wouldCreateCycle = (targetPlaylistId: string, memberId: string): boolean => {
        const visited = new Set<string>();
        const dfs = (id: string): boolean => {
            if (id === targetPlaylistId) return true;
            if (visited.has(id)) return false;
            visited.add(id);
            const fav = findById(id);
            if (!fav || fav.kind !== 'playlist') return false;
            return fav.members.some(m => isFavRef(m) && dfs(m.favId));
        };
        return dfs(memberId);
    };

    // -- Resolution ----------------------------------------------------------

    /**
     * Resolves a MusicFolder from an ItemRef, walking the account's tree.
     * Returns undefined if the path is broken or the account is missing.
     */
    const resolveItemRefFolder = (ref: ItemRef, roots: RootsMap): MusicFolder | undefined => {
        const root = resolveWalkableRootForItemRef(ref, roots);
        if (!root) return undefined;
        return walkFolder(root.folder, ref.path);
    };

    /**
     * Resolves children for a shortcut, walking into subPath within the target folder.
     */
    const resolveShortcutChildren = (
        sc: Shortcut, subPath: readonly string[], roots: RootsMap,
    ): Array<[string, boolean]> | undefined => {
        const folder = resolveItemRefFolder(sc.target, roots);
        if (!folder) return undefined;
        const target = subPath.length === 0 ? folder : walkFolder(folder, subPath);
        return target ? sortedFolderChildren(target) : undefined;
    };

    /**
     * Resolves children for a playlist. Uses visited set to prevent cycles.
     * At the top level (subPath empty), returns "m:0", "m:1" etc.
     * Deeper (subPath starts with "m:N"), resolves into that member's content.
     */
    const resolvePlaylistChildren = (
        pl: Playlist, subPath: readonly string[], roots: RootsMap,
        visited: Set<string>,
    ): Array<[string, boolean]> | undefined => {
        if (subPath.length === 0) {
            // Top level: one entry per member
            return pl.members.map((m, i): [string, boolean] => {
                if (isFavRef(m)) {
                    const fav = findById(m.favId);
                    return [`m:${i}`, fav !== undefined]; // FavRef to playlist/shortcut = folder-like
                }
                return [`m:${i}`, m.isFolder];
            });
        }

        // subPath[0] should be "m:N"
        const match = subPath[0].match(/^m:(\d+)$/);
        if (!match) return undefined;
        const idx = parseInt(match[1], 10);
        if (idx < 0 || idx >= pl.members.length) return undefined;
        const member = pl.members[idx];
        const deeper = subPath.slice(1);

        if (isFavRef(member)) {
            // Cycle guard
            if (visited.has(member.favId)) return undefined;
            visited.add(member.favId);
            const fav = findById(member.favId);
            if (!fav) return undefined;
            return fav.kind === 'shortcut'
                ? resolveShortcutChildren(fav, deeper, roots)
                : resolvePlaylistChildren(fav, deeper, roots, visited);
        }

        // ItemRef — walk into the OneDrive tree
        if (!member.isFolder) return undefined; // can't go deeper into a file
        const folder = resolveItemRefFolder(member, roots);
        if (!folder) return undefined;
        const target = deeper.length === 0 ? folder : walkFolder(folder, deeper);
        return target ? sortedFolderChildren(target) : undefined;
    };

    // -- Display name resolution ---------------------------------------------

    /**
     * Resolves the display name for a segment inside a favorite.
     *
     * Invariant: this is intentionally metadata-only and does not walk roots.
     * - FavRef members resolve from the referenced favorite's current name.
     * - ItemRef members resolve from the tail of stored ItemRef.path.
     *
     * Result: fast/offline-safe name resolution, with possible temporary
     * staleness after remote rename until heal/sync updates stored refs.
     */
    const resolveDisplayName = (id: string, segment: string): string => {
        const fav = findById(id);
        if (!fav || fav.kind !== 'playlist') return segment;
        const match = segment.match(/^m:(\d+)$/);
        if (!match) return segment;
        const idx = parseInt(match[1], 10);
        if (idx < 0 || idx >= fav.members.length) return segment;
        const member = fav.members[idx];
        if (isFavRef(member)) {
            const ref = findById(member.favId);
            return ref ? ref.name : segment;
        }
        // ItemRef: use the last path segment as the display name
        return member.path.length > 0 ? member.path[member.path.length - 1] : segment;
    };

    // -- Healing -------------------------------------------------------------

    /**
     * Heals broken references after an index refresh. For each ItemRef in each
     * favorite:
     * 1. Try resolving path in the account's tree — if found with matching itemId, healthy.
     * 2. If found with different itemId — heal by path (item was replaced).
     * 3. If not found at path — look up "driveId:itemId" in idToPath. If found,
     *    update path (item was moved/renamed). Heal by ID.
     * 4. If neither — broken. Remove shortcuts entirely; remove playlist members.
     */
    const healedFavorites = (
        roots: RootsMap,
        currentFolders: ReadonlyMap<string, MusicFolder>,
        removedRootKey?: string,
    ): Favorite[] | undefined => {
        let changed = false;
        const pathsByFolder = new Map<MusicFolder, Map<string, string[]>>();

        const healRef = (ref: ItemRef): ItemRef | undefined => {
            if (removedRootKey && ref.sourceRootKey === removedRootKey) return undefined;
            const root = resolveWalkableRootForItemRef(ref, roots);
            // Only this pull's complete, verified folder can establish absence.
            // Offline, denied, failed and concurrently replaced roots keep their references.
            if (!root || currentFolders.get(root.key) !== root.folder) return ref;
            let current: MusicFolder | MusicFile = root.folder;
            let resolved = true;
            for (const seg of ref.path) {
                if (!isMusicFolder(current) || !current.children[seg]) {
                    resolved = false;
                    break;
                }
                current = current.children[seg];
            }

            if (resolved) {
                // Found at path. Check itemId match.
                if (current.id === ref.itemId) return ref; // healthy
                // Different item at same path — heal by path (update itemId)
                changed = true;
                log(`favorites: heal by path "${ref.path.join('/')}" old=${ref.itemId} new=${current.id}`);
                return { ...ref, itemId: current.id };
            }

            // Most references still resolve at their stored path. Build the reverse
            // map at most once per root and only after a path actually disappears.
            let paths = pathsByFolder.get(root.folder);
            if (!paths) {
                const byId = new Map<string, string[]>();
                const visit = (item: MusicFolder | MusicFile, path: string[]): void => {
                    byId.set(item.id, path);
                    if (isMusicFolder(item)) {
                        for (const [name, child] of Object.entries(item.children)) visit(child, [...path, name]);
                    }
                };
                visit(root.folder, []);
                pathsByFolder.set(root.folder, byId);
                paths = byId;
            }
            const path = paths.get(ref.itemId);
            if (path) {
                changed = true;
                log(`favorites: heal by ID ${ref.itemId} → ${path.join('/')}`);
                return { ...ref, path };
            }

            // Broken
            log(`favorites: broken ref driveId=${ref.driveId} itemId=${ref.itemId} path=${ref.path.join('/')}`);
            return undefined;
        };

        // Two-pass healing: first determine which favorites survive, then build
        // the healed list. This prevents forward-reference FavRefs from being
        // removed simply because the target appears later in the array.
        const surviving = favorites.flatMap((fav): Favorite[] => {
            if (fav.kind === 'playlist') return [fav];
            const target = healRef(fav.target);
            if (target) return [target === fav.target ? fav : { ...fav, target }];
            changed = true;
            log(`favorites: removing broken shortcut "${fav.name}"`);
            return [];
        });
        const survivingIds = new Set(surviving.map(fav => fav.id));

        const newFavorites = surviving.map((fav): Favorite => {
            if (fav.kind === 'shortcut') return fav;
            // Playlist: heal each ItemRef member, remove broken ones
            const newMembers: PlaylistMember[] = [];
            for (const m of fav.members) {
                if (isFavRef(m)) {
                    // FavRef: keep if target survived healing (checked against
                    // survivingIds to handle both forward and backward refs).
                    if (survivingIds.has(m.favId)) {
                        newMembers.push(m);
                    } else {
                        changed = true;
                        log(`favorites: removing broken FavRef to ${m.favId}`);
                    }
                } else {
                    const healed = healRef(m);
                    if (healed) {
                        newMembers.push(healed);
                    } else {
                        changed = true;
                    }
                }
            }
            return newMembers.length === fav.members.length && newMembers.every((m, i) => m === fav.members[i])
                ? fav : { ...fav, members: newMembers };
        });

        return changed ? newFavorites : undefined;
    };

    // -- Persistence ---------------------------------------------------------

    const IDB_KEY = 'favorites';
    const ONEDRIVE_PATH = '/me/drive/special/approot:/favorites.json:/content';

    let pendingWrite: Promise<void> = Promise.resolve();

    /** Compute each edit from the last admitted graph. Only disk work and the pre-edit
     * playback fence are serialized. Queue publication may wait for a source supplied
     * or removed by the next edit, so it runs outside this critical section. */
    function serializeWrite<T>(operation: () => Promise<T>): Promise<T> {
        const write = pendingWrite.then(operation);
        pendingWrite = write.then(() => {}, () => {});
        return write;
    }

    async function commitEdit(change: () => Favorite[] | undefined,
        options: { pinEdit?: boolean; queueEdit?: boolean; origin?: 'sync'; serverTime?: number } = {}): Promise<boolean> {
        const fencePins = (options.pinEdit || options.queueEdit) && deps.fencePinEdit;
        const fenced = !!options.queueEdit && !!deps.fenceQueueEdit;
        const write = serializeWrite(async () => {
            const next = change();
            if (!next) return false;
            const data = { version: 1, updatedAt: options.serverTime ?? Date.now(), favorites: next };
            const releasePins = fencePins ? await fencePins() : undefined;
            try {
                if (fenced) await deps.fenceQueueEdit!();
                await deps.dbPut(IDB_KEY, data);
            } catch (error) {
                if (fenced || fencePins) throw error;
                logCatch('favorites:dbPut')(error);
            } finally { releasePins?.(); }
            favorites = next;
            updatedAt = data.updatedAt;
            loadedMembership = true;
            if (options.serverTime === undefined) scheduleOneDriveUploadFireAndForget();
            return true;
        });
        let changed: boolean;
        try {
            changed = await write;
        } catch (error) {
            if (fenced || fencePins) await onChange(options.origin); // release the fence using the admitted graph
            throw error;
        }
        if (changed) await onChange(options.origin);
        return changed;
    }

    let uploadDirty = false;
    let uploadRunning = false;

    /** Schedule OneDrive sync in background. Never throws; returns void (not Promise).
     *  INVARIANT: only one authFetch to the favorites path runs at a time.
     *  Multiple calls while upload is in-flight coalesce into one follow-up upload. */
    function scheduleOneDriveUploadFireAndForget(): void {
        uploadDirty = true;
        if (uploadRunning) return;     // already looping — the flag is enough
        uploadRunning = true;
        (async () => {
            while (uploadDirty) {
                uploadDirty = false;   // clear before upload so mutations during upload re-set it
                const data = toData(); // snapshot current state
                try {
                    const r = await deps.authFetch(
                        `https://graph.microsoft.com/v1.0${ONEDRIVE_PATH}`,
                        false,
                        {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(data),
                        },
                    );
                    if (!r.ok) logError(`favorites: OneDrive save failed: ${r.status}`);
                    else log('favorites: saved to OneDrive');
                } catch (e) {
                    logCatch('favorites:onedrive-save')(e);
                }
            }
            uploadRunning = false;
        })();
    }

    /**
     * Loads favorites from IndexedDB into module state and calls onChange().
     * Cache-only — no network call. Returns quickly so the UI renders immediately.
     */
    const loadFromCache = async (): Promise<void> => {
        const loaded = await serializeWrite(async () => {
            const cached = await deps.dbGet<FavoritesData>(IDB_KEY).catch(() => undefined);
            if (!cached || !Array.isArray(cached.favorites)) return false;
            loadedMembership = true;
            favorites = cached.favorites.filter(isValid).map(normalize);
            updatedAt = cached.updatedAt || 0;
            log(`favorites: loaded ${favorites.length} from cache (updatedAt=${updatedAt})`);
            return true;
        });
        if (loaded) await onChange();
    };

    /**
     * Fetches favorites from OneDrive. If the server version has a newer
     * updatedAt, adopts it into module state, persists to IndexedDB, and
     * calls onChange(). 404 means no server-side favorites yet — not an error.
     */
    const pullFavoritesFromOneDrive = async (): Promise<void> => {
        await deps.authFetch(
            `https://graph.microsoft.com/v1.0${ONEDRIVE_PATH}`,
            false,
        ).then(async (r) => {
            if (!r.ok) {
                if (r.status === 404) loadedMembership = true;
                else logError(`favorites: OneDrive load failed: ${r.status}`);
                return;
            }
            const server: FavoritesData = await readGraphJson(r, 'favorites:onedrive-load');
            if (!server || !Array.isArray(server.favorites)) return;
            loadedMembership = true;
            const adopted = await commitEdit(() => (server.updatedAt || 0) > updatedAt
                ? server.favorites.filter(isValid).map(normalize) : undefined,
                { queueEdit: true, origin: 'sync', serverTime: server.updatedAt });
            if (adopted) log(`favorites: adopted server version (updatedAt=${server.updatedAt})`);
        }).catch(logCatch('favorites:onedrive-load'));
    };

    // -- Public API ----------------------------------------------------------

    const api: Favorites = {
        getAll: () => favorites,
        hasLoadedMembership: () => loadedMembership,

        add(fav) {
            return commitEdit(() => {
                if (!isValid(fav)) return;
                if (fav.kind === 'playlist') {
                    for (const m of fav.members) {
                        if (isFavRef(m) && wouldCreateCycle(fav.id, m.favId)) {
                            logError(`favorites: cycle detected adding ${m.favId} to ${fav.id}`);
                            return;
                        }
                    }
                }
                return [...favorites, fav];
            });
        },

        async remove(id) {
            await commitEdit(() => favorites.filter(f => f.id !== id).map(f => {
                if (f.kind !== 'playlist') return f;
                const filtered = f.members.filter(m => !isFavRef(m) || m.favId !== id);
                return filtered.length === f.members.length ? f : { ...f, members: filtered };
            }), { queueEdit: true });
        },

        wouldCreateCycle,

        resolveChildren(id, subPath, roots) {
            const fav = findById(id);
            if (!fav) return undefined;
            return fav.kind === 'shortcut'
                ? resolveShortcutChildren(fav, subPath, roots)
                : resolvePlaylistChildren(fav, subPath, roots, new Set([id]));
        },

        resolveDisplayName,

        resolvePathSegmentName(path) {
            const segment = path[path.length - 1];
            if (!segment.startsWith('m:') || !path[1]?.startsWith('fav:')) return segment;
            // Walk intermediate m:N segments to find the playlist that owns
            // the final segment. Each m:N may be a FavRef to another playlist;
            // we must follow the chain rather than always using path[1].
            let ownerId = path[1].slice(4);
            for (let i = 2; i < path.length - 1; i++) {
                const seg = path[i];
                const m = seg.match(/^m:(\d+)$/);
                if (!m) break;
                const owner = findById(ownerId);
                if (!owner || owner.kind !== 'playlist') break;
                const idx = parseInt(m[1], 10);
                if (idx < 0 || idx >= owner.members.length) break;
                const member = owner.members[idx];
                if (!isFavRef(member)) break; // ItemRef — deeper segments are folder names, not m:N
                ownerId = member.favId;
            }
            return resolveDisplayName(ownerId, segment);
        },

        async heal(roots, currentFolders, removedRootKey) {
            await commitEdit(() => healedFavorites(roots, currentFolders, removedRootKey),
                { queueEdit: true, origin: 'sync' });
        },
        async save() {
            await serializeWrite(async () => {
                loadedMembership = true;
                await deps.dbPut(IDB_KEY, toData()).catch(logCatch('favorites:dbPut'));
                scheduleOneDriveUploadFireAndForget();
            });
        },
        loadFromCache,
        pullFavoritesFromOneDrive,

        async rename(id, newName) {
            const trimmed = newName.trim();
            if (!trimmed) return;
            await commitEdit(() => findById(id)
                ? favorites.map(f => f.id === id ? { ...f, name: trimmed } : f) : undefined);
        },

        async addMembers(playlistId, members) {
            await commitEdit(() => {
                const fav = findById(playlistId);
                if (!fav || fav.kind !== 'playlist') return;
                const memberKey = (m: PlaylistMember): string =>
                    isFavRef(m) ? `fav:${m.favId}` : `item:${m.driveId}:${m.itemId}`;
                const seen = new Set(fav.members.map(memberKey));
                const toAdd = members.filter(m => {
                    if (isFavRef(m) && wouldCreateCycle(playlistId, m.favId)) return false;
                    const key = memberKey(m);
                    if (seen.has(key)) return false;
                    seen.add(key); // also prevents intra-batch duplicates
                    return true;
                });
                if (toAdd.length) return favorites.map(f =>
                    f === fav ? { ...fav, members: [...fav.members, ...toAdd] } : f);
            }, { queueEdit: true });
        },

        async removeMembers(playlistId, indices) {
            const displayed = findById(playlistId);
            if (displayed?.kind !== 'playlist') return;
            const rows = new Set(indices);
            await commitEdit(() => {
                const fav = findById(playlistId);
                if (!fav || fav.kind !== 'playlist') return;
                let members: readonly PlaylistMember[];
                if (fav.members === displayed.members) {
                    members = fav.members.filter((_, i) => !rows.has(i));
                } else {
                    // Local edits retain surviving member objects. If sync replaced a row or
                    // its object also appeared in an unselected row, discard the ambiguous removal.
                    const targets = new Set(displayed.members.filter((_, i) => rows.has(i)));
                    displayed.members.forEach((m, i) => { if (!rows.has(i)) targets.delete(m); });
                    members = fav.members.filter(m => !targets.has(m));
                }
                if (members.length === fav.members.length) return;
                return favorites.map(f => f === fav ? { ...fav, members } : f);
            }, { queueEdit: true });
        },

        async setHasPrivatePlayback(id, value) {
            await commitEdit(() => findById(id)
                ? favorites.map(f => f.id === id ? { ...f, hasPrivatePlayback: value } : f) : undefined);
        },

        async setMode(id, mode) {
            await commitEdit(() => {
                const fav = findById(id);
                if (!fav || fav.mode === mode) return;
                return favorites.map(f => f === fav ? { ...f, mode } : f);
            });
        },

        async setOfflinePin(id, pin) {
            await commitEdit(() => findById(id)
                ? favorites.map(f => f.id === id ? { ...f, offlinePin: pin } : f) : undefined, {pinEdit: true});
        },

        _testOnlySuppressSave(suppress) {
            if (suppress) {
                // Idempotent: only stash originals on the first suppress call.
                // Calling suppress(true) twice must not overwrite originals with no-ops.
                if (!originalDeps) {
                    originalDeps = { authFetch: deps.authFetch, dbPut: deps.dbPut };
                }
                deps.authFetch = () => Promise.resolve(new Response('', { status: 200 }));
                deps.dbPut = () => Promise.resolve();
            } else if (originalDeps) {
                deps.authFetch = originalDeps.authFetch;
                deps.dbPut = originalDeps.dbPut;
                originalDeps = undefined;
            }
        },
    };

    return api;
}
