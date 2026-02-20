/**
 * Select-mode dialog/domain helpers.
 *
 * Scope:
 * - Converts selected tree paths into playlist member refs.
 * - Resolves shortcut/share paths into concrete ItemRef payloads.
 *
 * Non-scope:
 * - Modal shell rendering mechanics (owned by modal.ts).
 * - Select state machine/orchestration (owned by select.ts).
 */
import { type Favorites, type RootsMap, type PlaylistMember, type ItemRef } from './favorites.js';
import { type MusicFolder } from './indexer.js';
import { walkFolder } from './indexer.js';
import { resolveWalkableRootForItemRef } from './roots.js';

interface ClassifiedPath {
    readonly path: readonly string[];
    readonly isFavRoot: boolean;
    readonly favId: string | undefined;
}

/**
 * Converts selected paths into PlaylistMember array for addMembers/add.
 * Shortcut roots resolve to their underlying ItemRef target.
 */
export function buildMembersFromSelection(
    selectedPaths: ReadonlySet<string>,
    classifyPath: (pathStr: string) => ClassifiedPath,
    favorites: Favorites,
    roots: RootsMap,
): PlaylistMember[] {
    const members: PlaylistMember[] = [];
    for (const pathStr of selectedPaths) {
        const cp = classifyPath(pathStr);
        if (cp.isFavRoot && cp.favId) {
            const fav = favorites.getAll().find((f) => f.id === cp.favId);
            if (fav?.kind === 'shortcut') {
                members.push({ ...fav.target });
            } else if (fav?.kind === 'playlist') {
                members.push({ favId: cp.favId });
            }
        } else if (cp.path.length >= 3) {
            const root = roots.get(cp.path[1]);
            const subPath = cp.path.slice(2);
            if (root?.type === 'onedrive') {
                const ref = walkToItemRef(root.folder, root.info.driveId, subPath);
                if (ref) members.push(ref);
            } else if (root?.type === 'share') {
                if (!root.folder) continue;
                const ref = walkToItemRef(root.folder, root.driveId, subPath, root.key);
                if (ref) members.push(ref);
            } else if (root?.type === 'shortcut') {
                const targetRoot = resolveWalkableRootForItemRef(root.target, roots);
                if (targetRoot) {
                    const targetFolder = walkFolder(targetRoot.folder, root.target.path);
                    if (!targetFolder) continue;
                    const driveId = targetRoot.type === 'onedrive' ? targetRoot.info.driveId : targetRoot.driveId;
                    const sourceRootKey = targetRoot.type === 'share' ? targetRoot.key : undefined;
                    const ref = walkToItemRef(targetFolder, driveId, subPath, sourceRootKey);
                    if (ref) {
                        members.push({
                            ...ref,
                            path: [...root.target.path, ...subPath],
                            sourceRootKey,
                        });
                    }
                }
            }
        }
    }
    return members;
}

/** Walks a MusicFolder tree to produce an ItemRef for the deepest resolved node. */
function walkToItemRef(
    folder: MusicFolder,
    driveId: string,
    subPath: readonly string[],
    sourceRootKey?: string,
): ItemRef | undefined {
    let current = folder;
    let itemId = folder.id;
    let isFolder = true;
    for (let i = 0; i < subPath.length; i++) {
        const child = current.children[subPath[i]];
        if (!child) return undefined;
        itemId = child.id;
        isFolder = 'children' in child;
        if (isFolder) current = child as typeof current;
    }
    return { driveId, itemId, path: [...subPath], isFolder, sourceRootKey };
}
