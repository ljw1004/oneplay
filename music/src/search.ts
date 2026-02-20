/**
 * Search engine for OnePlay Music (M15).
 *
 * Single synchronous walk over favorites + roots with a global accepted-result
 * cap. Results are bucketed and returned as favorites, then folders, then tracks.
 *
 * INVARIANTS:
 * - Empty/whitespace query returns zero results.
 * - Each query term must match as a case-insensitive substring (AND semantics).
 * - Walk order is fixed: favorites, then onedrive roots, then share roots.
 * - Dedup keys are consumed only when a result is accepted.
 * - Track availability honors denied roots and terminal evidence states.
 * - Playlist FavRef members are searchable as direct children, but are never
 *   recursively traversed for nested hits.
 */

import { type EvidenceState } from './auth.js';
import { type Favorite, type Favorites, type ItemRef, type Playlist, type Root, type RootsMap, isFavRef } from './favorites.js';
import { type MusicFile, type MusicFolder, isMusicFolder, sortedFolderChildren, walkFolder } from './indexer.js';
import { resolveWalkableRootForItemRef } from './roots.js';
import { type FolderPath } from './tree.js';

const FAV_PREFIX = 'fav:';

export type SearchResultKind = 'favorite' | 'folder' | 'track';

export interface SearchResult {
    readonly kind: SearchResultKind;
    readonly name: string;
    readonly path: FolderPath;
    /** Physical identity when the hit maps to a OneDrive item. */
    readonly driveId?: string;
    readonly itemId?: string;
    /** Favorite identity for top-level favorite hits. */
    readonly favoriteId?: string;
}

export interface SearchOptions {
    readonly roots: RootsMap;
    readonly favorites: Favorites;
    readonly query: string;
    readonly maxResults: number;
    readonly deniedRootKeys: ReadonlySet<string>;
    readonly evidenceState: EvidenceState;
    readonly downloadedTrackKeys: ReadonlySet<string>;
}

export interface SearchRunResult {
    readonly results: readonly SearchResult[];
    readonly capped: boolean;
    readonly elapsedMs: number;
}

export interface IncrementalSearchOptions {
    readonly previousQuery: string;
    readonly query: string;
    readonly previousResults: readonly SearchResult[];
    readonly previousCapped: boolean;
}

export interface IncrementalSearchResult {
    readonly results: readonly SearchResult[];
    readonly elapsedMs: number;
}

/** Runs a single synchronous search walk over favorites + roots. */
export function runSearchSingleWalk(options: SearchOptions): SearchRunResult {
    const startedAt = nowMs();
    const terms = normalizedTerms(options.query);
    if (terms.length === 0) {
        return { results: [], capped: false, elapsedMs: Math.round(nowMs() - startedAt) };
    }

    const favorites = options.favorites.getAll();
    const favoritesById = new Map(favorites.map((fav) => [fav.id, fav]));
    const terminalEvidence = isTerminalEvidence(options.evidenceState);

    const favoriteResults: SearchResult[] = [];
    const folderResults: SearchResult[] = [];
    const trackResults: SearchResult[] = [];

    const seenFavoriteKeys = new Set<string>();
    const seenFolderKeys = new Set<string>();
    const seenTrackKeys = new Set<string>();

    let acceptedCount = 0;

    const isAtCap = (): boolean => acceptedCount >= options.maxResults;
    const accept = (): void => { acceptedCount++; };

    const trackIsAvailable = (rootKey: string | undefined, driveId: string, itemId: string): boolean => {
        if (rootKey && options.deniedRootKeys.has(rootKey)) return false;
        return !terminalEvidence || options.downloadedTrackKeys.has(`${driveId}:${itemId}`);
    };

    const resolvedRootForItemRef = (ref: ItemRef): import('./roots.js').WalkableRoot | undefined => {
        if (ref.sourceRootKey && options.deniedRootKeys.has(ref.sourceRootKey)) return undefined;
        const root = resolveWalkableRootForItemRef(ref, options.roots);
        if (!root || options.deniedRootKeys.has(root.key)) return undefined;
        return root;
    };

    const resolveItemRefFolder = (ref: ItemRef): {
        readonly rootKey: string;
        readonly folder: MusicFolder;
    } | undefined => {
        const root = resolvedRootForItemRef(ref);
        if (!root) return undefined;
        const folder = walkFolder(root.folder, ref.path);
        return folder ? { rootKey: root.key, folder } : undefined;
    };

    const resolveItemRefFile = (ref: ItemRef): {
        readonly rootKey: string;
        readonly fileName: string;
        readonly file: MusicFile;
    } | undefined => {
        if (ref.path.length === 0) return undefined;
        const root = resolvedRootForItemRef(ref);
        if (!root) return undefined;
        const parent = ref.path.length > 1
            ? walkFolder(root.folder, ref.path.slice(0, -1))
            : root.folder;
        if (!parent) return undefined;
        const fileName = ref.path[ref.path.length - 1];
        const file = parent.children[fileName];
        return file && !isMusicFolder(file) ? { rootKey: root.key, fileName, file } : undefined;
    };

    const folderHasAvailableImmediateChild = (
        folder: MusicFolder,
        driveId: string,
        rootKey: string | undefined,
    ): boolean => {
        for (const child of Object.values(folder.children)) {
            if (isMusicFolder(child)) return true;
            if (trackIsAvailable(rootKey, driveId, child.id)) return true;
        }
        return false;
    };

    const playlistHasAvailableImmediateChild = (playlist: Playlist): boolean => {
        for (const member of playlist.members) {
            if (isFavRef(member)) {
                if (favoritesById.has(member.favId)) return true;
                continue;
            }
            if (member.isFolder) {
                const resolved = resolveItemRefFolder(member);
                if (resolved) return true;
                continue;
            }
            const resolvedFile = resolveItemRefFile(member);
            if (!resolvedFile) continue;
            if (trackIsAvailable(resolvedFile.rootKey, member.driveId, resolvedFile.file.id)) return true;
        }
        return false;
    };

    const favoriteHasAvailableImmediateChild = (fav: Favorite): boolean => {
        if (fav.kind === 'shortcut') {
            const resolved = resolveItemRefFolder(fav.target);
            return resolved ? folderHasAvailableImmediateChild(resolved.folder, fav.target.driveId, resolved.rootKey) : false;
        }
        return playlistHasAvailableImmediateChild(fav);
    };

    const physicalFolderDedupKeyForFavorite = (fav: Favorite): string | undefined => {
        if (fav.kind !== 'shortcut') return undefined;
        const resolved = resolveItemRefFolder(fav.target);
        return resolved ? `${fav.target.driveId}:${resolved.folder.id}` : undefined;
    };

    const tryAcceptFavorite = (fav: Favorite): void => {
        if (isAtCap()) return;
        if (!matchesNameTerms(fav.name, terms)) return;
        if (!favoriteHasAvailableImmediateChild(fav)) return;
        if (seenFavoriteKeys.has(fav.id)) return;

        const folderDedupKey = physicalFolderDedupKeyForFavorite(fav);
        seenFavoriteKeys.add(fav.id);
        if (folderDedupKey) seenFolderKeys.add(folderDedupKey);
        favoriteResults.push({
            kind: 'favorite',
            name: fav.name,
            path: ['OnePlay Music', `${FAV_PREFIX}${fav.id}`],
            favoriteId: fav.id,
        });
        accept();
    };

    const tryAcceptFolder = (
        name: string,
        path: FolderPath,
        hasAvailableImmediateChild: boolean,
        driveId?: string,
        itemId?: string,
    ): void => {
        if (isAtCap()) return;
        if (!matchesNameTerms(name, terms)) return;
        if (!hasAvailableImmediateChild) return;

        const dedupKey = driveId && itemId ? `${driveId}:${itemId}` : undefined;
        if (dedupKey && seenFolderKeys.has(dedupKey)) return;

        if (dedupKey) seenFolderKeys.add(dedupKey);
        folderResults.push({ kind: 'folder', name, path, driveId, itemId });
        accept();
    };

    const tryAcceptTrack = (
        name: string,
        path: FolderPath,
        rootKey: string | undefined,
        driveId: string,
        itemId: string,
    ): void => {
        if (isAtCap()) return;
        if (!matchesNameTerms(name, terms)) return;
        if (!trackIsAvailable(rootKey, driveId, itemId)) return;

        const dedupKey = `${driveId}:${itemId}`;
        if (seenTrackKeys.has(dedupKey)) return;

        seenTrackKeys.add(dedupKey);
        trackResults.push({ kind: 'track', name, path, driveId, itemId });
        accept();
    };

    const walkPhysicalFolder = (
        folder: MusicFolder,
        driveId: string,
        rootKey: string | undefined,
        logicalPath: FolderPath,
    ): void => {
        for (const [childName, childIsFolder] of sortedFolderChildren(folder)) {
            if (isAtCap()) return;
            const child = folder.children[childName];
            const childPath: FolderPath = [...logicalPath, childName];

            if (childIsFolder) {
                const childFolder = child as MusicFolder;
                tryAcceptFolder(
                    childName,
                    childPath,
                    folderHasAvailableImmediateChild(childFolder, driveId, rootKey),
                    driveId,
                    childFolder.id,
                );
                walkPhysicalFolder(childFolder, driveId, rootKey, childPath);
            } else {
                const childFile = child as MusicFile;
                tryAcceptTrack(childName, childPath, rootKey, driveId, childFile.id);
            }
        }
    };

    const walkPlaylistMembers = (playlist: Playlist): void => {
        const basePath: FolderPath = ['OnePlay Music', `${FAV_PREFIX}${playlist.id}`];
        for (let i = 0; i < playlist.members.length; i++) {
            if (isAtCap()) return;
            const memberPath: FolderPath = [...basePath, `m:${i}`];
            const member = playlist.members[i];

            if (isFavRef(member)) {
                const referenced = favoritesById.get(member.favId);
                if (!referenced) continue;
                const resolved = referenced.kind === 'shortcut'
                    ? resolveItemRefFolder(referenced.target)
                    : undefined;
                tryAcceptFolder(
                    referenced.name,
                    memberPath,
                    true,
                    referenced.kind === 'shortcut' ? referenced.target.driveId : undefined,
                    resolved?.folder.id,
                );
                continue;
            }

            if (member.isFolder) {
                const resolved = resolveItemRefFolder(member);
                if (!resolved) continue;
                tryAcceptFolder(
                    member.path[member.path.length - 1] ?? '',
                    memberPath,
                    folderHasAvailableImmediateChild(resolved.folder, member.driveId, resolved.rootKey),
                    member.driveId,
                    resolved.folder.id,
                );
                walkPhysicalFolder(resolved.folder, member.driveId, resolved.rootKey, memberPath);
                continue;
            }

            const resolvedFile = resolveItemRefFile(member);
            if (!resolvedFile) continue;
            tryAcceptTrack(
                resolvedFile.fileName,
                memberPath,
                resolvedFile.rootKey,
                member.driveId,
                resolvedFile.file.id,
            );
        }
    };

    for (const fav of favorites) {
        if (isAtCap()) break;
        tryAcceptFavorite(fav);

        if (fav.kind === 'shortcut') {
            const resolved = resolveItemRefFolder(fav.target);
            if (!resolved) continue;
            walkPhysicalFolder(
                resolved.folder,
                fav.target.driveId,
                resolved.rootKey,
                ['OnePlay Music', `${FAV_PREFIX}${fav.id}`],
            );
            continue;
        }
        walkPlaylistMembers(fav);
    }

    if (!isAtCap()) {
        const onedriveRoots = [...options.roots.values()]
            .filter((root): root is Extract<Root, { readonly type: 'onedrive' }> => root.type === 'onedrive')
            .sort((a, b) => a.key.localeCompare(b.key));

        for (const root of onedriveRoots) {
            if (isAtCap()) break;
            if (options.deniedRootKeys.has(root.key)) continue;
            walkPhysicalFolder(root.folder, root.info.driveId, root.key, ['OnePlay Music', root.key]);
        }
    }

    if (!isAtCap()) {
        const shareRoots = [...options.roots.values()]
            .filter((root): root is Extract<Root, { readonly type: 'share' }> => root.type === 'share');

        for (const root of shareRoots) {
            if (isAtCap()) break;
            if (!root.folder || options.deniedRootKeys.has(root.key)) continue;
            walkPhysicalFolder(root.folder, root.driveId, root.key, ['OnePlay Music', root.key]);
        }
    }

    return {
        results: [...favoriteResults, ...folderResults, ...trackResults],
        capped: isAtCap(),
        elapsedMs: Math.round(nowMs() - startedAt),
    };
}

/**
 * Returns filtered prior results when the next query is a strict refinement.
 *
 * INVARIANTS:
 * - Only valid when prior search was uncapped (complete result set).
 * - Incremental eligibility is normalized-query prefix (prev is prefix of next).
 * - Preserves result ordering (bucket order remains stable under filtering).
 */
export function runSearchIncrementalRefinement(
    options: IncrementalSearchOptions,
): IncrementalSearchResult | undefined {
    if (options.previousCapped) return undefined;
    if (!isIncrementalRefinement(options.previousQuery, options.query)) return undefined;
    const startedAt = nowMs();
    const terms = normalizedTerms(options.query);
    const results = options.previousResults.filter((result) => matchesNameTerms(result.name, terms));
    return { results, elapsedMs: Math.round(nowMs() - startedAt) };
}

export const isIncrementalRefinement = (previousQuery: string, query: string): boolean => {
    const previous = normalizedQuery(previousQuery);
    const next = normalizedQuery(query);
    if (!previous || !next) return false;
    return next.startsWith(previous);
};

const nowMs = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

const normalizedTerms = (query: string): string[] =>
    query.toLowerCase().trim().split(/\s+/).filter(Boolean);

const normalizedQuery = (query: string): string =>
    normalizedTerms(query).join(' ');

const matchesNameTerms = (name: string, terms: readonly string[]): boolean => {
    const lower = name.toLowerCase();
    return terms.every((term) => lower.includes(term));
};

const isTerminalEvidence = (state: EvidenceState): boolean =>
    state === 'evidence:signed-out' || state === 'evidence:not-online';
