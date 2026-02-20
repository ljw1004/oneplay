/**
 * Shared track traversal for OnePlay Music.
 *
 * Provides functions to collect and resolve tracks through both physical
 * OneDrive paths and logical favorites paths. Used by both playback.ts
 * (for track list building and resolution) and downloads.ts (for
 * determining which tracks to download).
 *
 * INVARIANTS:
 * - collectTracks returns paths in sorted display order (folders-first, alpha).
 * - collectLogicalTracks returns logical paths so trackList entries match the tree.
 * - collectPhysicalTracks returns deduped {driveId, itemId} pairs.
 * - Cycle detection uses a visited set; DAG-style sharing (same favorite in
 *   multiple members) is allowed — only true ancestor cycles are blocked.
 */

import { type MusicFolder, type MusicFile, isMusicFolder, walkFolder } from './indexer.js';
import { type Favorites, type RootsMap, isFavRef } from './favorites.js';
import { log } from './logger.js';
import { resolveWalkableRootForItemRef } from './roots.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Root folders map shape, keyed by root key (account driveId or share root key). */
export type AccountsMap = Map<string, { folder: MusicFolder; driveId: string }>;

/** A path from root to a folder or file. */
type FolderPath = readonly string[];

// ---------------------------------------------------------------------------
// Physical track collection
// ---------------------------------------------------------------------------

/**
 * Collects all file (track) paths under a physical folder, in sorted display order.
 * Folders are visited first (alphabetically), then files (alphabetically),
 * matching tree.ts resolveFolder sort. This is the sequential playback order.
 *
 * INVARIANT: returned paths all end with a filename (MusicFile leaf).
 */
export function collectTracks(basePath: FolderPath, folder: MusicFolder): FolderPath[] {
    const tracks: FolderPath[] = [];
    const entries = Object.entries(folder.children)
        .map(([name, item]): [string, boolean] => [name, isMusicFolder(item)])
        .sort((a, b) => (a[1] === b[1] ? a[0].localeCompare(b[0]) : a[1] ? -1 : 1));
    for (const [name, isFolder] of entries) {
        const childPath: FolderPath = [...basePath, name];
        if (isFolder) {
            tracks.push(...collectTracks(childPath, folder.children[name] as MusicFolder));
        } else {
            tracks.push(childPath);
        }
    }
    return tracks;
}

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
// Logical path resolution (favorites-aware)
// ---------------------------------------------------------------------------

/**
 * Resolves any path (physical or through favorites) to a MusicFile.
 * - Physical paths (path[1] is a driveId): delegate to resolveTrack.
 * - Shortcut paths ("fav:<id>"): resolve shortcut target, walk remaining segments.
 * - Playlist paths ("fav:<id>", "m:N"): resolve member N, walk deeper if needed.
 * Uses visited set for FavRef cycle detection. Broken refs return undefined with log.
 */
export function resolveLogicalTrack(
    path: FolderPath, accounts: AccountsMap, favorites: Favorites, roots: RootsMap,
    visited?: Set<string>,
): MusicFile | undefined {
    if (path.length < 2) return undefined;
    // Physical path — delegate directly
    if (!path[1].startsWith('fav:')) return resolveTrack(path, accounts);

    const favId = path[1].slice(4);
    const fav = favorites.getAll().find(f => f.id === favId);
    if (!fav) { log(`resolveLogicalTrack: favorite ${favId} not found`); return undefined; }

    if (fav.kind === 'shortcut') {
        // Resolve shortcut target folder, then walk path.slice(2)
        const root = resolveWalkableRootForItemRef(fav.target, roots);
        if (!root) { log(`resolveLogicalTrack: root not found for ${fav.target.driveId}`); return undefined; }
        const targetFolder = walkFolder(root.folder, fav.target.path);
        if (!targetFolder) { log(`resolveLogicalTrack: shortcut target broken`); return undefined; }
        // Walk remaining segments (path[2..n-1] are folders, path[n] is the track)
        let current: MusicFolder = targetFolder;
        for (let i = 2; i < path.length - 1; i++) {
            const child = current.children[path[i]];
            if (!child || !isMusicFolder(child)) return undefined;
            current = child;
        }
        const file = current.children[path[path.length - 1]];
        return file && !isMusicFolder(file) ? file : undefined;
    }

    // Playlist
    if (path.length < 3) return undefined;
    const memberSeg = path[2];
    const match = /^m:(\d+)$/.exec(memberSeg);
    if (!match) return undefined;
    const memberIdx = parseInt(match[1], 10);
    if (memberIdx < 0 || memberIdx >= fav.members.length) return undefined;
    const member = fav.members[memberIdx];

    if (isFavRef(member)) {
        // Recurse with cycle detection
        const v = visited ?? new Set<string>();
        if (v.has(member.favId)) { log(`resolveLogicalTrack: cycle at ${member.favId}`); return undefined; }
        v.add(member.favId);
        const innerPath: FolderPath = ['OnePlay Music', `fav:${member.favId}`, ...path.slice(3)];
        return resolveLogicalTrack(innerPath, accounts, favorites, roots, v);
    }

    // ItemRef member
    const root = resolveWalkableRootForItemRef(member, roots);
    if (!root) return undefined;
    if (!member.isFolder) {
        // File member: path.slice(3) should be empty
        if (path.length > 3) { log(`resolveLogicalTrack: extra segments after file member`); return undefined; }
        // Walk to the file's parent, then get the file
        const parentFolder = member.path.length > 0
            ? walkFolder(root.folder, member.path.slice(0, -1))
            : root.folder;
        if (!parentFolder) return undefined;
        const fileName = member.path[member.path.length - 1];
        const file = parentFolder.children[fileName];
        return file && !isMusicFolder(file) ? file : undefined;
    }
    // Folder member: walk member.path + path.slice(3)
    const memberFolder = walkFolder(root.folder, member.path);
    if (!memberFolder) return undefined;
    const remaining = path.slice(3);
    if (remaining.length === 0) return undefined; // folder, not a track
    let current: MusicFolder = memberFolder;
    for (let i = 0; i < remaining.length - 1; i++) {
        const child = current.children[remaining[i]];
        if (!child || !isMusicFolder(child)) return undefined;
        current = child;
    }
    const file = current.children[remaining[remaining.length - 1]];
    return file && !isMusicFolder(file) ? file : undefined;
}

/**
 * Collects all track paths under any logical folder, in sorted display order.
 * Returns logical paths so trackList entries match the tree structure.
 * - Physical path: resolve folder, collect with physical basePath.
 * - Shortcut: resolve target folder, collect with logical basePath.
 * - Playlist: iterate members, recursively collect from each.
 * Duplicates are intentionally allowed (same file via different logical paths).
 */
export function collectLogicalTracks(
    basePath: FolderPath, accounts: AccountsMap, favorites: Favorites, roots: RootsMap,
    visited?: Set<string>,
): FolderPath[] {
    if (basePath.length < 2) return [];
    // Physical path
    if (!basePath[1].startsWith('fav:')) {
        const folder = resolveFolderFromPath(basePath, accounts);
        return folder ? collectTracks(basePath, folder) : [];
    }

    const favId = basePath[1].slice(4);
    const fav = favorites.getAll().find(f => f.id === favId);
    if (!fav) return [];

    if (fav.kind === 'shortcut') {
        const root = resolveWalkableRootForItemRef(fav.target, roots);
        if (!root) return [];
        const targetFolder = walkFolder(root.folder, fav.target.path);
        if (!targetFolder) return [];
        // Walk subpath if present
        const subPath = basePath.slice(2);
        const folder = subPath.length === 0 ? targetFolder : walkFolder(targetFolder, subPath);
        if (!folder) return [];
        // Collect with logical basePath (not physical) so paths route through the shortcut
        return collectTracks(basePath, folder);
    }

    // Playlist
    const subPath = basePath.slice(2);
    if (subPath.length === 0) {
        // Top-level playlist: iterate members. Each member gets its own copy
        // of the visited set so DAG-style shared references (same favorite in
        // multiple members) are allowed — only true ancestor cycles are blocked.
        const tracks: FolderPath[] = [];
        const baseVisited = visited ?? new Set<string>();
        baseVisited.add(favId);
        for (let i = 0; i < fav.members.length; i++) {
            const memberPath: FolderPath = [...basePath, `m:${i}`];
            tracks.push(...collectLogicalTracks(memberPath, accounts, favorites, roots, new Set(baseVisited)));
        }
        return tracks;
    }

    // Subpath into a member: "m:N" + deeper
    const match = /^m:(\d+)$/.exec(subPath[0]);
    if (!match) return [];
    const memberIdx = parseInt(match[1], 10);
    if (memberIdx < 0 || memberIdx >= fav.members.length) return [];
    const member = fav.members[memberIdx];

    if (isFavRef(member)) {
        const v = visited ?? new Set<string>();
        if (v.has(member.favId)) { log(`collectLogicalTracks: cycle at ${member.favId}`); return []; }
        v.add(member.favId);
        const deeper = subPath.slice(1);
        const innerBasePath: FolderPath = ['OnePlay Music', `fav:${member.favId}`, ...deeper];
        // Collect from inner favorite, but remap paths to use our basePath.
        // basePath already includes the "m:N" segment (it's [..., "fav:playlistId", "m:N"]),
        // so we only need to append the trailing segments from the inner tracks.
        const innerTracks = collectLogicalTracks(innerBasePath, accounts, favorites, roots, v);
        return innerTracks.map(t => [...basePath, ...t.slice(2 + deeper.length)]);
    }

    // ItemRef member
    if (!member.isFolder) {
        // File member: it IS a track (no children)
        return subPath.length === 1 ? [basePath] : [];
    }
    const root = resolveWalkableRootForItemRef(member, roots);
    if (!root) return [];
    const memberFolder = walkFolder(root.folder, member.path);
    if (!memberFolder) return [];
    const deeper = subPath.slice(1);
    const folder = deeper.length === 0 ? memberFolder : walkFolder(memberFolder, deeper);
    if (!folder) return [];
    return collectTracks(basePath, folder);
}

// ---------------------------------------------------------------------------
// Physical track collection for downloads (deduped by driveId:itemId)
// ---------------------------------------------------------------------------

/**
 * Collects all physical MusicFile items under a MusicFolder, returning
 * {driveId, itemId} for each. Helper for collectPhysicalTracks.
 */
function collectFilesFromFolder(
    driveId: string, folder: MusicFolder,
    result: Array<{ driveId: string; itemId: string }>,
    seen: Set<string>,
): void {
    for (const [, item] of Object.entries(folder.children)) {
        if (isMusicFolder(item)) {
            collectFilesFromFolder(driveId, item, result, seen);
        } else {
            const key = `${driveId}:${item.id}`;
            if (!seen.has(key)) {
                seen.add(key);
                result.push({ driveId, itemId: item.id });
            }
        }
    }
}

/**
 * Resolves all physical tracks {driveId, itemId} for a favorite.
 * Walks shortcuts, playlists, nested favorites with cycle detection.
 * Returns deduped by driveId:itemId (a track shared between favorites is one download).
 */
export function collectPhysicalTracks(
    favId: string, favorites: Favorites, roots: RootsMap,
    deniedRootKeys: ReadonlySet<string> = new Set(),
    visited?: Set<string>,
): Array<{ driveId: string; itemId: string }> {
    const fav = favorites.getAll().find(f => f.id === favId);
    if (!fav) return [];

    const result: Array<{ driveId: string; itemId: string }> = [];
    const seen = new Set<string>();
    const v = visited ?? new Set<string>();
    v.add(favId);

    if (fav.kind === 'shortcut') {
        if (fav.target.sourceRootKey && deniedRootKeys.has(fav.target.sourceRootKey)) return [];
        const root = resolveWalkableRootForItemRef(fav.target, roots);
        if (!root) return [];
        const targetFolder = walkFolder(root.folder, fav.target.path);
        if (!targetFolder) return [];
        collectFilesFromFolder(fav.target.driveId, targetFolder, result, seen);
        return result;
    }

    // Playlist: iterate members
    for (const member of fav.members) {
        if (isFavRef(member)) {
            if (v.has(member.favId)) continue; // cycle guard
            const inner = collectPhysicalTracks(
                member.favId, favorites, roots, deniedRootKeys, new Set(v));
            for (const item of inner) {
                const key = `${item.driveId}:${item.itemId}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    result.push(item);
                }
            }
        } else {
            if (member.sourceRootKey && deniedRootKeys.has(member.sourceRootKey)) continue;
            const root = resolveWalkableRootForItemRef(member, roots);
            if (!root) continue;
            if (!member.isFolder) {
                // File member: resolve directly
                const parentFolder = member.path.length > 0
                    ? walkFolder(root.folder, member.path.slice(0, -1))
                    : root.folder;
                if (!parentFolder) continue;
                const fileName = member.path[member.path.length - 1];
                const file = parentFolder.children[fileName];
                if (file && !isMusicFolder(file)) {
                    const key = `${member.driveId}:${file.id}`;
                    if (!seen.has(key)) {
                        seen.add(key);
                        result.push({ driveId: member.driveId, itemId: file.id });
                    }
                }
            } else {
                // Folder member: walk and collect
                const memberFolder = walkFolder(root.folder, member.path);
                if (memberFolder) {
                    collectFilesFromFolder(member.driveId, memberFolder, result, seen);
                }
            }
        }
    }

    return result;
}

// ---------------------------------------------------------------------------
// Track ID resolution (for offline cache lookup in playback)
// ---------------------------------------------------------------------------

/**
 * Resolves any track path to its physical {driveId, itemId}.
 * Used by playback.ts to check the offline cache before streaming.
 * Uses visited set for FavRef cycle detection (same pattern as resolveLogicalTrack).
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
