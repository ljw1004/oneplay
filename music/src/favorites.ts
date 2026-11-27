/**
 * Favorites module for OnePlay Music.
 *
 * Manages shortcuts (☆) and playlists (♫). A shortcut references a OneDrive
 * folder; a playlist is an ordered list of members (folders, files, or
 * references to other favorites). Favorites are persisted to IndexedDB
 * (fast, best-effort) and the OneDrive App folder (best-effort, may fail
 * offline). Playback queue edits, explicit mode choices and download requests
 * must commit to IndexedDB before acknowledgment. Cloud writes are best effort.
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
 * - A folder pin covers a whole physical branch. Edits and healing retain only
 *   its outermost explicit request within the same source and connection.
 * - A committed edit publishes the new favorites and folder pins together.
 */

import { type MusicFolder, isMusicFolder, walkFolder, sortedFolderChildren } from './indexer.js';
import { type PlaybackMode, isValidMode } from './playback.js';
import { log, logError, logCatch } from './logger.js';
import { folderPinOwnerId, folderPinPathKey, resolveWalkableRootForItemRef } from './roots.js';
import { parsePrimaryDocument, ProviderHttpError, type PrimaryStore } from './provider.js';

// ---------------------------------------------------------------------------
// Dependency injection (for testability — see LEARNINGS.md "DI over extraction")
// ---------------------------------------------------------------------------

/** I/O dependencies injected by the app entrypoint. In unit tests, supply
 *  throwing stubs so accidental I/O paths fail fast. */
export interface FavoritesDeps {
    documents: PrimaryStore;
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

/** A requested physical subfolder. Share connections get a fresh UUID each time
 * the same link is added, even though their sourceRootKey remains the same. */
export interface FolderPin extends ItemRef {
    readonly isFolder: true;
    readonly sourceRootKey: string;
    readonly connectionId?: string;
}

// The index objects are immutable. Their reverse lookup dies with the index and
// is shared by all healed references to it. A folder rename allocates
// paths for folders only, even when the root also contains 30,000 recordings.
const folderPathsByIndex = new WeakMap<MusicFolder, Promise<Map<string, string[]>>>();
const filePathsByIndex = new WeakMap<MusicFolder, Promise<Map<string, string[]>>>();

/** Enumerate each immutable index once per requested node type. Check time even
 * inside a single wide folder, and never allocate paths for unrequested recordings. */
async function indexPaths(folder: MusicFolder, folders: boolean): Promise<Map<string, string[]>> {
    const paths = new Map<string, string[]>();
    const pending: [MusicFolder, string[]][] = [[folder, []]];
    let visited = 0, start = performance.now();
    while (pending.length) {
        const [dir, path] = pending.pop()!;
        if (folders) paths.set(dir.id, path);
        for (const name in dir.children) {
            const child = dir.children[name];
            if (isMusicFolder(child)) pending.push([child, [...path, name]]);
            else if (!folders) paths.set(child.id, [...path, name]);
            if (++visited % 64 === 0 && performance.now() - start >= 4) {
                await new Promise(resolve => setTimeout(resolve, 0));
                start = performance.now();
            }
        }
    }
    return paths;
}

/** Resolve by path first (including replacements), then by ID and node type.
 * The caller must establish that this complete index belongs to the reference. */
export async function resolveVerifiedItemRef<Ref extends ItemRef>(ref: Ref, folder: MusicFolder): Promise<Ref | undefined> {
    const name = ref.path.at(-1);
    const item = name === undefined ? folder : walkFolder(folder, ref.path.slice(0, -1))?.children[name];
    if (item && isMusicFolder(item) === ref.isFolder) {
        return item.id === ref.itemId ? ref : { ...ref, itemId: item.id };
    }
    const cache = ref.isFolder ? folderPathsByIndex : filePathsByIndex;
    const paths = cache.get(folder) ?? indexPaths(folder, ref.isFolder);
    cache.set(folder, paths);
    const path = (await paths).get(ref.itemId);
    return path ? { ...ref, path } : undefined;
}

/** One request per folder and per path within a connection. A parent covers its descendants. */
function normalizeFolderPins(pins: readonly FolderPin[]): readonly FolderPin[] {
    const byOwner = new Map(pins.filter(pin => pin.path.length).map(pin => [folderPinOwnerId(pin), pin]));
    const byPath = new Map(pins.filter(pin => byOwner.get(folderPinOwnerId(pin)) === pin)
        .map(pin => [folderPinPathKey(pin.sourceRootKey, pin.connectionId, pin.path), pin]));
    return [...byPath.values()].filter(pin => !pin.path.some((_, i) =>
        byPath.has(folderPinPathKey(pin.sourceRootKey, pin.connectionId, pin.path.slice(0, i)))));
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
     *  Undefined inherits the live playback mode. */
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
     *  Undefined inherits the live playback mode. */
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
    readonly folderPins: readonly FolderPin[];
}

// ---------------------------------------------------------------------------
// Root type (consumed by tree.ts)
// ---------------------------------------------------------------------------

/** A root is a top-level item in the tree. */
export type Root =
    | { readonly type: 'onedrive'; readonly key: string; readonly name: string;
        readonly folder: MusicFolder; readonly info: import('./indexer.js').AccountInfo; readonly reindexing: boolean }
    | { readonly type: 'share'; readonly key: string; readonly name: string; readonly connectionId: string;
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

    /** Wait for local edits already admitted when the listener selects a favorite. */
    whenLocalWritesComplete(): Promise<void>;

    /** Explicit physical subfolders requested offline, independently of favorite pins. */
    getFolderPins(): readonly FolderPin[];

    /** Pin a whole branch or clear its explicit pins, including descendants. */
    setFolderPinned(folder: FolderPin, pinned: boolean, roots?: RootsMap): Promise<void>;

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
        removedShare?: { rootKey: string; id: string },
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
     *  cloud writes become no-ops. Cloud pulls skip adoption. Mutations still happen in memory and call onChange.
     *  INVARIANT: must only be called from test harnesses via page.evaluate. */
    _testOnlySuppressSave(suppress: boolean): void;

    /** Load favorites from IndexedDB into module state and call onChange().
     *  Cache-only — no network. Returns quickly so the UI renders immediately. */
    loadFromCache(): Promise<void>;

    /** Adopt a newer cloud document. True after reading a valid document or confirming a 404. */
    pullFavoritesFromOneDrive(): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates the favorites module. The onChange callback is called after every
 * mutation so the tree can re-render.
 */
export function createFavorites(deps: FavoritesDeps, onChange: (origin?: 'sync' | 'mode' | 'pins') => void | Promise<void>): Favorites {
    let data: FavoritesData = { version: 1, updatedAt: 0, favorites: [], folderPins: [] };
    let loadedMembership = false;
    // Guard each dispatch so previously dispatched requests can still settle.
    let suppressSaveForTests = false;

    // -- Helpers -------------------------------------------------------------

    /** Finds a favorite by ID. */
    const findById = (id: string): Favorite | undefined =>
        data.favorites.find(f => f.id === id);

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

    /** Both storage paths accept old documents without a folderPins collection. */
    const normalizedData = (stored: FavoritesData): FavoritesData => ({
        version: 1, updatedAt: stored.updatedAt || 0,
        favorites: stored.favorites.filter(isValid).map(normalize), folderPins: stored.folderPins ?? [],
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
     * 4. If neither resolves to the right node type, remove the shortcut, member or pin.
     */
    const healedMembership = async (
        roots: RootsMap,
        currentFolders: ReadonlyMap<string, MusicFolder>,
        removedShare?: { rootKey: string; id: string },
    ): Promise<Partial<Pick<FavoritesData, 'favorites' | 'folderPins'>> | undefined> => {
        let changed = false;

        const healRef = async <Ref extends ItemRef>(ref: Ref, connectionId?: string): Promise<Ref | undefined> => {
            const root = resolveWalkableRootForItemRef(ref, roots);
            // Ordinary favorites follow their source root. A folder pin belongs to the
            // specific connection that created it. The two cloud documents can arrive
            // in either order, so a different connection's index cannot heal that pin.
            if (removedShare && ref.sourceRootKey === removedShare.rootKey) {
                const current = roots.get(removedShare.rootKey);
                if (connectionId ? connectionId === removedShare.id
                    : current?.type !== 'share' || current.connectionId === removedShare.id) return undefined;
            }
            if (connectionId && (root?.type !== 'share' || root.connectionId !== connectionId)) return ref;
            // Only this pull's complete, verified folder can establish absence.
            // Offline, denied, failed and concurrently replaced roots keep their references.
            if (!root || currentFolders.get(root.key) !== root.folder) return ref;
            const healed = await resolveVerifiedItemRef(ref, root.folder);
            if (currentFolders.get(root.key) !== root.folder || resolveWalkableRootForItemRef(ref, roots)?.folder !== root.folder) return ref;
            if (healed && healed !== ref) {
                changed = true;
                log(`favorites: healed ${ref.itemId} at "${ref.path.join('/')}" to ${healed.itemId} at "${healed.path.join('/')}"`);
            }
            if (!healed) log(`favorites: broken ref driveId=${ref.driveId} itemId=${ref.itemId} path=${ref.path.join('/')}`);
            return healed;
        };

        // Two-pass healing: first determine which favorites survive, then build
        // the healed list. This prevents forward-reference FavRefs from being
        // removed simply because the target appears later in the array.
        const surviving: Favorite[] = [];
        for (const fav of data.favorites) {
            if (fav.kind === 'playlist') { surviving.push(fav); continue; }
            const target = await healRef(fav.target);
            if (target) surviving.push(target === fav.target ? fav : { ...fav, target });
            else {
                changed = true;
                log(`favorites: removing broken shortcut "${fav.name}"`);
            }
        }
        const survivingIds = new Set(surviving.map(fav => fav.id));

        const newFavorites: Favorite[] = [];
        for (const fav of surviving) {
            if (fav.kind === 'shortcut') { newFavorites.push(fav); continue; }
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
                    const healed = await healRef(m);
                    if (healed) {
                        newMembers.push(healed);
                    } else {
                        changed = true;
                    }
                }
            }
            newFavorites.push(newMembers.length === fav.members.length && newMembers.every((m, i) => m === fav.members[i])
                ? fav : { ...fav, members: newMembers });
        }

        const favoriteChanges = changed ? { favorites: newFavorites } : undefined;
        const pins: FolderPin[] = [];
        for (const pin of data.folderPins) {
            const healed = await healRef(pin, pin.connectionId);
            if (healed) pins.push(healed);
        }
        if (pins.length === data.folderPins.length && pins.every((pin, i) => pin === data.folderPins[i])) {
            return favoriteChanges;
        }
        return { ...favoriteChanges, folderPins: normalizeFolderPins(pins) };
    };

    // -- Persistence ---------------------------------------------------------

    const IDB_KEY = 'favorites';
    const DOCUMENT = 'favorites.json';

    let pendingWrite: Promise<void> = Promise.resolve();

    /** Compute each edit from the last admitted graph. Only disk work and the pre-edit
     * playback fence are serialized. Queue publication may wait for a source supplied
     * or removed by the next edit, so it runs outside this critical section. */
    function serializeWrite<T>(operation: () => Promise<T>): Promise<T> {
        const write = pendingWrite.then(operation);
        pendingWrite = write.then(() => {}, () => {});
        return write;
    }

    type Edit = (Partial<Pick<FavoritesData, 'favorites' | 'folderPins'>>
        & { publish?: 'mode' | 'pins' }) | undefined;
    async function commitEdit(change: () => Edit | Promise<Edit>,
        options: { queueEdit?: boolean; origin?: 'sync' | 'mode' | 'pins'; serverTime?: number } = {}): Promise<boolean> {
        let origin = options.origin;
        let queueFenced = false;
        const write = serializeWrite(async () => {
            const edit = await change();
            if (!edit) return false;
            const { publish, ...next } = edit;
            // A cloud pull or a heal can change just physical folder pins. Keeping
            // the admitted favorite objects leaves live queues and advancement alone.
            origin = publish ?? (origin === 'sync' && !next.favorites ? 'pins' : origin);
            const fenceQueue = options.queueEdit && origin !== 'mode' && origin !== 'pins'
                ? deps.fenceQueueEdit : undefined;
            queueFenced = !!fenceQueue;
            // Even two local edits in the same millisecond must compare newer on the other device.
            const updatedAt = options.serverTime ?? Math.max(Date.now(), data.updatedAt + 1);
            const nextData = { ...data, ...next, updatedAt };
            try {
                if (fenceQueue) await fenceQueue();
                if (!suppressSaveForTests) await deps.dbPut(IDB_KEY, nextData);
            } catch (error) {
                if (options.queueEdit || origin === 'pins' || origin === 'mode') throw error;
                logCatch('favorites:dbPut')(error);
            }
            data = nextData;
            loadedMembership = true;
            if (options.serverTime === undefined) scheduleOneDriveUploadFireAndForget();
            return true;
        });
        let changed: boolean;
        try {
            changed = await write;
        } catch (error) {
            if (queueFenced) await onChange(origin); // release the fence using the admitted graph
            throw error;
        }
        if (changed) await onChange(origin);
        return changed;
    }

    let uploadDirty = false;
    let uploadRunning = false;

    /** Schedule OneDrive sync in background. Never throws; returns void (not Promise).
     *  INVARIANT: only one cloud document write runs at a time.
     *  Multiple calls while upload is in-flight coalesce into one follow-up upload. */
    function scheduleOneDriveUploadFireAndForget(): void {
        uploadDirty = true;
        if (uploadRunning) return;     // already looping — the flag is enough
        uploadRunning = true;
        (async () => {
            while (uploadDirty) {
                uploadDirty = false;   // clear before upload so mutations during upload re-set it
                if (suppressSaveForTests) continue;
                try {
                    await deps.documents.write(DOCUMENT, JSON.stringify(data));
                    log('favorites: saved to OneDrive');
                } catch (e) {
                    if (e instanceof ProviderHttpError) logError(`favorites: OneDrive save failed: ${e.status}`);
                    else logCatch('favorites:onedrive-save')(e);
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
            data = normalizedData(cached);
            log(`favorites: loaded ${data.favorites.length} from cache (updatedAt=${data.updatedAt})`);
            return true;
        });
        if (loaded) await onChange();
    };

    /**
     * Fetches favorites from OneDrive. If the server version has a newer
     * updatedAt, adopts it into module state, persists to IndexedDB, and
     * calls onChange(). 404 means no server-side favorites yet — not an error.
     */
    const pullFavoritesFromOneDrive = async (): Promise<boolean> => {
        if (suppressSaveForTests) return false;
        try {
            const text = await deps.documents.read(DOCUMENT);
            if (text === null) {
                loadedMembership = true;
                return true;
            }
            const server = parsePrimaryDocument(text, 'favorites:onedrive-load') as FavoritesData;
            if (!server || !Array.isArray(server.favorites)) return false;
            const adopted = await commitEdit(() => {
                if (loadedMembership && (server.updatedAt || 0) <= data.updatedAt) return;
                const next = normalizedData(server);
                // Structural rows drive playback. Modes and offline settings can
                // arrive independently and reuse the already admitted member objects.
                const sameStructure = next.favorites.length === data.favorites.length && next.favorites.every((f, i) =>
                    JSON.stringify({...f, mode: undefined, offlinePin: undefined})
                    === JSON.stringify({...data.favorites[i], mode: undefined, offlinePin: undefined}));
                if (!sameStructure) return next;
                const foldersChanged = JSON.stringify(data.folderPins) !== JSON.stringify(next.folderPins);
                let pinsChanged = foldersChanged;
                const favorites = data.favorites.map((f, i) => {
                    const incoming = next.favorites[i];
                    if (f.offlinePin?.paused !== incoming.offlinePin?.paused) pinsChanged = true;
                    else if (f.mode === incoming.mode) return f;
                    return {...f, mode: incoming.mode, offlinePin: incoming.offlinePin};
                });
                return { favorites, folderPins: foldersChanged ? next.folderPins : data.folderPins,
                    publish: pinsChanged ? 'pins' : 'mode' };
            }, { queueEdit: true, origin: 'sync', serverTime: server.updatedAt || 0 });
            if (adopted) log(`favorites: adopted server version (updatedAt=${server.updatedAt})`);
            return true;
        } catch (error) {
            if (error instanceof ProviderHttpError) logError(`favorites: OneDrive load failed: ${error.status}`);
            else logCatch('favorites:onedrive-load')(error);
            return false;
        }
    };

    // -- Public API ----------------------------------------------------------

    const api: Favorites = {
        getAll: () => data.favorites,
        getFolderPins: () => data.folderPins,
        whenLocalWritesComplete: () => pendingWrite,
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
                return { favorites: [...data.favorites, fav] };
            });
        },

        async remove(id) {
            await commitEdit(() => ({ favorites: data.favorites.filter(f => f.id !== id).map(f => {
                if (f.kind !== 'playlist') return f;
                const filtered = f.members.filter(m => !isFavRef(m) || m.favId !== id);
                return filtered.length === f.members.length ? f : { ...f, members: filtered };
            }) }), { queueEdit: true });
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

        async heal(roots, currentFolders, removedShare) {
            await commitEdit(() => healedMembership(roots, currentFolders, removedShare), { queueEdit: true, origin: 'sync' });
        },
        async save() {
            await serializeWrite(async () => {
                loadedMembership = true;
                if (!suppressSaveForTests) await deps.dbPut(IDB_KEY, data).catch(logCatch('favorites:dbPut'));
                scheduleOneDriveUploadFireAndForget();
            });
        },
        loadFromCache,
        pullFavoritesFromOneDrive,

        async rename(id, newName) {
            const trimmed = newName.trim();
            if (!trimmed) return;
            await commitEdit(() => findById(id)
                ? { favorites: data.favorites.map(f => f.id === id ? { ...f, name: trimmed } : f) } : undefined);
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
                if (toAdd.length) return { favorites: data.favorites.map(f =>
                    f === fav ? { ...fav, members: [...fav.members, ...toAdd] } : f) };
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
                return { favorites: data.favorites.map(f => f === fav ? { ...fav, members } : f) };
            }, { queueEdit: true });
        },

        async setHasPrivatePlayback(id, value) {
            await commitEdit(() => findById(id)
                ? { favorites: data.favorites.map(f => f.id === id ? { ...f, hasPrivatePlayback: value } : f) } : undefined);
        },

        async setMode(id, mode) {
            await commitEdit(() => {
                const fav = findById(id);
                if (!fav || fav.mode === mode) return;
                return { favorites: data.favorites.map(f => f === fav ? { ...f, mode } : f) };
            }, {origin: 'mode'});
        },

        async setOfflinePin(id, pin) {
            await commitEdit(() => {
                const favorite = findById(id);
                if (!favorite || favorite.offlinePin?.paused === pin?.paused) return;
                return { favorites: data.favorites.map(f => f === favorite ? { ...f, offlinePin: pin } : f) };
            }, {origin: 'pins'});
        },

        async setFolderPinned(folder, pinned, roots) {
            await commitEdit(() => {
                if (!folder.path.length) return;
                // Recheck the live route at admission: another queued edit or refresh
                // can replace this folder or reconnect its share after the dialog opens.
                if (roots) {
                    const root = resolveWalkableRootForItemRef(folder, roots);
                    if (!root || (root.type === 'share' && root.connectionId !== folder.connectionId)
                        || walkFolder(root.folder, folder.path)?.id !== folder.itemId) {
                        throw new Error('The folder has changed. Select it again.');
                    }
                }
                const pins = data.folderPins;
                const inBranch = (pin: FolderPin): boolean => pin.sourceRootKey === folder.sourceRootKey
                    && pin.connectionId === folder.connectionId && folder.path.every((name, i) => pin.path[i] === name);
                if (pinned && pins.some(pin => inBranch(pin) && pin.path.length === folder.path.length && pin.itemId === folder.itemId)) return;
                const folderPins = pinned ? normalizeFolderPins([...pins, folder]) : pins.filter(pin => !inBranch(pin));
                if (folderPins.length !== pins.length || folderPins.some((pin, i) => pin !== pins[i])) return {folderPins};
            }, {origin: 'pins'});
        },

        _testOnlySuppressSave(suppress) {
            suppressSaveForTests = suppress;
        },
    };

    return api;
}
