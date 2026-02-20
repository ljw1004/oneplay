import { type Favorites, type RootsMap } from './favorites.js';

/**
 * Resolves user-visible display text for the final segment of a logical path.
 *
 * Invariants:
 * - depth-2 root keys resolve to root.name (never raw driveId/fav:* keys)
 * - playlist member pseudo-segments (m:N) resolve via favorites
 * - all other segments are returned unchanged
 */
export const resolvePathTailDisplayName = (
    path: readonly string[],
    roots: RootsMap,
    favorites: Pick<Favorites, 'resolvePathSegmentName'> | undefined,
): string => {
    if (path.length === 0) return '';

    const last = path[path.length - 1];
    if (path.length === 2) {
        const root = roots.get(path[1]);
        return root ? root.name : last;
    }

    const root = roots.get(path[1]);
    const isFavoriteInner = path.length > 2
        && favorites !== undefined
        && (root?.type === 'shortcut' || root?.type === 'playlist');
    return isFavoriteInner && last.startsWith('m:')
        ? favorites.resolvePathSegmentName(path)
        : last;
};
