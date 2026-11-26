/** Shared playback queues and physical track ID resolution for browser and native music players.
 * Logical paths match the tree. Separate playlist routes can refer to the same physical file.
 */

import { type MusicFolder, type MusicFile, isMusicFolder, walkFolder, sortedFolderChildren } from './indexer.js';
import { type Favorite, type ItemRef, type Favorites, type RootsMap, isFavRef } from './favorites.js';
import { log } from './logger.js';
import { type WalkableRoot, isWalkableRoot, resolveWalkableRootForItemRef } from './roots.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Root folders map shape, keyed by root key (account driveId or share root key). */
export type AccountsMap = Map<string, { folder: MusicFolder; driveId: string }>;

/** A path from root to a folder or file. */
type FolderPath = readonly string[];

// ---------------------------------------------------------------------------
// Physical path resolution
// ---------------------------------------------------------------------------

/**
 * Resolves a physical track path to its MusicFile. Returns undefined if broken.
 * Path structure: ["OnePlay Music", driveId, "folder1", ..., "track.mp3"].
 */
export function resolveTrack(path: FolderPath, accounts: AccountsMap): MusicFile | undefined {
    if (path.length < 3) return undefined;
    const root = accounts.get(path[1]);
    if (!root) return undefined;
    let current: MusicFolder = root.folder;
    for (let i = 2; i < path.length - 1; i++) {
        const child = current.children[path[i]];
        if (!child || !isMusicFolder(child)) return undefined;
        current = child;
    }
    const file = current.children[path[path.length - 1]];
    return file && !isMusicFolder(file) ? file : undefined;
}

/**
 * Resolves a physical folder path to its MusicFolder. Returns undefined if broken.
 * Path structure: ["OnePlay Music", driveId, "folder1", ...].
 */
export function resolveFolderFromPath(path: FolderPath, accounts: AccountsMap): MusicFolder | undefined {
    if (path.length < 2) return undefined;
    const root = accounts.get(path[1]);
    if (!root) return undefined;
    let current: MusicFolder = root.folder;
    for (let i = 2; i < path.length; i++) {
        const child = current.children[path[i]];
        if (!child || !isMusicFolder(child)) return undefined;
        current = child;
    }
    return current;
}

// ---------------------------------------------------------------------------
// Track ID resolution (for offline cache lookup in playback)
// ---------------------------------------------------------------------------

/**
 * Resolves any track path to its physical {driveId, itemId}.
 * Used by playback.ts to check the offline cache before streaming.
 * An ancestor favorite ID guards against cycles in nested playlists.
 */
export function resolveTrackIds(
    path: FolderPath, accounts: AccountsMap, favorites: Favorites, roots: RootsMap,
    visited?: Set<string>,
): { driveId: string; itemId: string } | undefined {
    if (path.length < 3) return undefined;

    // Physical path
    if (!path[1].startsWith('fav:')) {
        const root = accounts.get(path[1]);
        if (!root) return undefined;
        const file = resolveTrack(path, accounts);
        if (!file) return undefined;
        return { driveId: root.driveId, itemId: file.id };
    }

    // Logical path: resolve through favorites to get the MusicFile,
    // then we need the driveId. Walk the resolution to find it.
    const favId = path[1].slice(4);
    const fav = favorites.getAll().find(f => f.id === favId);
    if (!fav) return undefined;

    if (fav.kind === 'shortcut') {
        const root = resolveWalkableRootForItemRef(fav.target, roots);
        if (!root) return undefined;
        const targetFolder = walkFolder(root.folder, fav.target.path);
        if (!targetFolder) return undefined;
        let current: MusicFolder = targetFolder;
        for (let i = 2; i < path.length - 1; i++) {
            const child = current.children[path[i]];
            if (!child || !isMusicFolder(child)) return undefined;
            current = child;
        }
        const file = current.children[path[path.length - 1]];
        return file && !isMusicFolder(file) ? { driveId: fav.target.driveId, itemId: file.id } : undefined;
    }

    // Playlist: resolve member
    if (path.length < 3) return undefined;
    const match = /^m:(\d+)$/.exec(path[2]);
    if (!match) return undefined;
    const memberIdx = parseInt(match[1], 10);
    if (memberIdx < 0 || memberIdx >= fav.members.length) return undefined;
    const member = fav.members[memberIdx];

    if (isFavRef(member)) {
        // Recurse with cycle detection
        const v = visited ?? new Set<string>();
        if (v.has(member.favId)) { log(`resolveTrackIds: cycle at ${member.favId}`); return undefined; }
        v.add(member.favId);
        const innerPath: FolderPath = ['OnePlay Music', `fav:${member.favId}`, ...path.slice(3)];
        return resolveTrackIds(innerPath, accounts, favorites, roots, v);
    }

    const root = resolveWalkableRootForItemRef(member, roots);
    if (!root) return undefined;
    if (!member.isFolder) {
        if (path.length > 3) return undefined;
        const parentFolder = member.path.length > 0
            ? walkFolder(root.folder, member.path.slice(0, -1))
            : root.folder;
        if (!parentFolder) return undefined;
        const fileName = member.path[member.path.length - 1];
        const file = parentFolder.children[fileName];
        return file && !isMusicFolder(file) ? { driveId: member.driveId, itemId: file.id } : undefined;
    }
    const memberFolder = walkFolder(root.folder, member.path);
    if (!memberFolder) return undefined;
    const remaining = path.slice(3);
    if (remaining.length === 0) return undefined;
    let current: MusicFolder = memberFolder;
    for (let i = 0; i < remaining.length - 1; i++) {
        const child = current.children[remaining[i]];
        if (!child || !isMusicFolder(child)) return undefined;
        current = child;
    }
    const file = current.children[remaining[remaining.length - 1]];
    return file && !isMusicFolder(file) ? { driveId: member.driveId, itemId: file.id } : undefined;
}

/** The library names stable occurrences. Each platform player owns its play order and audible cursor. */
export interface QueueEntry {
    readonly key: string;
    readonly path: FolderPath;
    readonly sourceRootKey: string;
    readonly driveId: string;
    readonly itemId: string;
    readonly title: string;
    readonly album: string;
}

export interface LibraryQueue {
    folder: FolderPath;
    folderKey: string;
    tracks: QueueEntry[];
}

/** Resolve a folder by path on selection, or by identity after an edit. A missing share
 * index makes a revision incomplete. Sending that partial list would delete live entries. */
function* walkLibraryQueue(path: FolderPath, roots: RootsMap, favorites: readonly Favorite[],
    denied: ReadonlySet<string>, folderKey?: string, sharesKnown = true): Generator<void, LibraryQueue | undefined> {
    if (path.length < 2) return undefined;
    const rootKey = path[1];
    const byId = new Map(favorites.map(f => [f.id, f]));
    const rootPath = path.slice(0, 2);
    let result: LibraryQueue | undefined;
    let visited = 0;
    let incomplete = false;
    const resolved = new Map<string, WalkableRoot | undefined>();
    let searchMoved = false;
    type Route = readonly (readonly (string | number)[])[];
    const relevant = (p: FolderPath) => searchMoved || !!result || p.every((part, i) => path[i] === part);
    function enter(p: FolderPath, key: string): void {
        if (!result && (folderKey ? key === folderKey : p.length === path.length && relevant(p))) {
            incomplete = false;
            result = {folder: p, folderKey: key, tracks: []};
        }
    }
    const inside = (p: FolderPath) => !!result && result.folder.every((part, i) => p[i] === part);
    function* physical(node: MusicFile | MusicFolder, p: FolderPath, route: Route, root: WalkableRoot, name: string, album = root.name): Generator<void> {
        if (++visited % 512 === 0) yield;
        const driveId = root.type === 'onedrive' ? root.info.driveId : root.driveId;
        if (!isMusicFolder(node) && !inside(p)) return;
        const key = JSON.stringify([rootKey, ...route, root.key, driveId, node.id]);
        if (!isMusicFolder(node)) {
            if (inside(p)) result!.tracks.push({key, path: p, driveId, sourceRootKey: root.key, itemId: node.id, title: name, album});
            return;
        }
        enter(p, key);
        for (const [child] of sortedFolderChildren(node)) {
            const next = [...p, child];
            if (inside(p) || (!result && relevant(next))) yield* physical(node.children[child], next, route, root, child, name);
        }
    }
    function* reference(ref: ItemRef, p: FolderPath, route: Route): Generator<void> {
        const key = ref.sourceRootKey ?? ref.driveId;
        if (denied.has(key)) return;
        const token = JSON.stringify([ref.sourceRootKey, ref.driveId]);
        if (!resolved.has(token)) resolved.set(token, resolveWalkableRootForItemRef(ref, roots));
        const root = resolved.get(token);
        if (!root) {
            if ((roots.get(key)?.type === 'share' || (!sharesKnown && !roots.has(key))) && (inside(p) || !result)) incomplete = true;
            return;
        }
        const parent = walkFolder(root.folder, ref.path.slice(0, -1));
        const name = ref.path.at(-1) ?? root.name;
        const node = ref.path.length ? parent?.children[name] : root.folder;
        if (node && isMusicFolder(node) === ref.isFolder) yield* physical(node, p, route, root, name, ref.path.at(-2) ?? root.name);
    }
    function* favorite(id: string, p: FolderPath, route: Route, ancestors: Set<string>): Generator<void> {
        const f = byId.get(id);
        if (!f || ancestors.has(id)) return;
        enter(p, JSON.stringify([rootKey, ...route, 'favorite', id]));
        if (f.kind === 'shortcut') { yield* reference(f.target, p, route); return; }
        ancestors.add(id);
        // Old documents can contain duplicate members. A count change invalidates the whole ambiguous group.
        const ids = f.members.map(m => isFavRef(m) ? ['favorite', m.favId] : ['item', m.driveId, m.itemId]);
        const tokens = ids.map(id => JSON.stringify(id));
        const totals = new Map<string, number>(), seen = new Map<string, number>();
        for (const key of tokens) totals.set(key, (totals.get(key) ?? 0) + 1);
        for (const [i, m] of f.members.entries()) {
            const token = tokens[i], ordinal = seen.get(token) ?? 0;
            seen.set(token, ordinal + 1);
            const next = [...p, 'm:' + i];
            if (!inside(p) && (result || !relevant(next))) continue;
            const chain = [...route, [...ids[i], totals.get(token)!, ordinal]];
            if (isFavRef(m)) yield* favorite(m.favId, next, chain, ancestors);
            else yield* reference(m, next, chain);
        }
        ancestors.delete(id);
    }
    function* visitRoot(): Generator<void> {
        const root = roots.get(rootKey);
        if (rootKey.startsWith('fav:')) yield* favorite(rootKey.slice(4), rootPath, [], new Set());
        else if (isWalkableRoot(root) && !denied.has(rootKey)) yield* physical(root.folder, rootPath, [], root, root.name);
        else if (!denied.has(rootKey) && (!root || root.type === 'share')) incomplete = true;
    }
    yield* visitRoot();
    if (folderKey && !result) { searchMoved = true; yield* visitRoot(); }
    if (incomplete && (folderKey !== undefined || !result)) return undefined;
    return result ?? (folderKey !== undefined ? {folder: path, folderKey, tracks: []} : undefined);
}

/** Give WebKit an event-loop turn during expensive walks. Small selections finish in one turn. */
export async function buildLibraryQueue(...args: Parameters<typeof walkLibraryQueue>): Promise<LibraryQueue | undefined> {
    const walk = walkLibraryQueue(...args);
    let sliceStart = performance.now();
    for (;;) {
        const step = walk.next();
        if (step.done) return step.value;
        if (performance.now() - sliceStart >= 8) {
            await new Promise(resolve => setTimeout(resolve, 0));
            sliceStart = performance.now();
        }
    }
}
