/**
 * Shared root-resolution helpers for ItemRef-based traversal.
 *
 * INVARIANTS:
 * - Walkable roots are exactly OneDrive account roots and share roots with a
 *   loaded MusicFolder.
 * - ItemRef resolution prefers sourceRootKey when present.
 * - Legacy ItemRefs (no sourceRootKey) fall back by driveId only when there is
 *   exactly one matching root and that root is an account root.
 */

import { type MusicFolder } from './indexer.js';
import { type FolderPin, type ItemRef, type Root, type RootsMap } from './favorites.js';

/** Native retention follows a folder ID through renames within one connection. */
export function folderPinOwnerId(pin: FolderPin): string {
    return 'folder:' + JSON.stringify([pin.sourceRootKey, pin.connectionId ?? null, pin.itemId]);
}

/** Pin paths are scoped to the current share connection. JSON preserves segment boundaries. */
export function folderPinPathKey(sourceRootKey: string, connectionId: string | undefined, path: readonly string[]): string {
    return JSON.stringify([sourceRootKey, connectionId ?? null, ...path]);
}

/** Root variant that can be traversed as a folder tree. */
export type WalkableRoot =
    | Extract<Root, { readonly type: 'onedrive' }>
    | (Extract<Root, { readonly type: 'share' }> & { readonly folder: MusicFolder });

/** Returns true when the root is traversable (onedrive/share with loaded folder). */
export function isWalkableRoot(root: Root | undefined): root is WalkableRoot {
    return root !== undefined
        && (root.type === 'onedrive' || root.type === 'share')
        && root.folder !== undefined;
}

/** Follow playlist member segments to the source whose access applies to this row. */
export function isPathDeniedByShare(path: readonly string[], denied: ReadonlySet<string>, roots: RootsMap): boolean {
    if (!denied.size) return false;
    if (denied.has(path[1])) return true;
    let root = roots.get(path[1]);
    for (let depth = 2; root?.type === 'playlist'; depth++) {
        const memberIndex = /^m:(\d+)$/.exec(path[depth] ?? '');
        const member = memberIndex && root.members[Number(memberIndex[1])];
        if (!member) return false;
        if (!('favId' in member)) return !!member.sourceRootKey && denied.has(member.sourceRootKey);
        root = roots.get('fav:' + member.favId);
    }
    return root?.type === 'shortcut' && !!root.target.sourceRootKey && denied.has(root.target.sourceRootKey);
}

/** Returns a root's backing driveId when available. */
function rootDriveId(root: Root): string | undefined {
    if (root.type === 'onedrive') return root.info.driveId;
    if (root.type === 'share') return root.driveId;
    return undefined;
}

/**
 * Resolves the walkable root for an ItemRef.
 *
 * Resolution order:
 * 1) sourceRootKey (strict)
 * 2) legacy driveId fallback only when exactly one matching root exists and
 *    that root is a OneDrive account root.
 */
export function resolveWalkableRootForItemRef(
    ref: ItemRef,
    roots: RootsMap,
): WalkableRoot | undefined {
    if (ref.sourceRootKey) {
        const byKey = roots.get(ref.sourceRootKey);
        return isWalkableRoot(byKey) ? byKey : undefined;
    }

    const matches = [...roots.values()].filter((root) => rootDriveId(root) === ref.driveId);
    if (matches.length !== 1 || matches[0].type !== 'onedrive') return undefined;
    return isWalkableRoot(matches[0]) ? matches[0] : undefined;
}
