import type { DownloadSnapshot } from './downloads.js';
import { isFavRef, type PlaylistMember, type Favorite, type RootsMap } from './favorites.js';
import { logCatch } from './logger.js';
import type { NativeLibrary } from './native-library.js';
import { isMusicFolder, walkFolder, type MusicFolder } from './indexer.js';
import { resolveWalkableRootForItemRef } from './roots.js';

interface Inventory {
    revision: number;
    files?: Record<string, number>;
    missing?: string[];
    added?: Record<string, number>;
    error?: string;
    quota: number;
    total: number;
}

/** One document projects favorites into native pin owners. Only a library revision walks folders.
 * Completion deltas update the affected favorites by physical key, including duplicate playlist routes. */
export function createNativePins(library: NativeLibrary, render: (playabilityChanged: boolean) => void) {
    let sizes = new Map<string, number>(), downloadedKeys = new Set<string>(), queuedKeys = new Set<string>();
    let reverse = new Map<string, Set<string>>();
    let counts = new Map<string, { total: number; downloaded: number; bytes: number; complete: boolean }>();
    let quotaBytes = 2 ** 30, totalBytes = 0, lastError: string | undefined;
    let revision: number | undefined, projection = 0;
    let publication: {signature: string; ack: Promise<unknown>} | undefined;
    type Inputs = { favorites: readonly Favorite[]; roots: RootsMap; denied: ReadonlySet<string>; done: Promise<void>; failed?: boolean };
    let latest: Inputs | undefined;
    let pulling = false, requested = false, editing = false;

    /** Coalesce visible signals. A revision gap causes Swift to return a complete inventory. */
    async function refresh() {
        requested = true;
        if (pulling) return;
        pulling = true;
        try {
            do {
                requested = false;
                try {
                    const sample = await library.pins('snapshot', {after: revision ?? null}) as Inventory;
                    let changed = false;
                    const full = sample.files !== undefined;
                    if (full) {
                        const next = Object.keys(sample.files!);
                        changed = next.length !== downloadedKeys.size || next.some(key => !downloadedKeys.has(key));
                        sizes = new Map();
                        downloadedKeys = new Set();
                        queuedKeys = new Set(sample.missing);
                        for (const count of counts.values()) { count.downloaded = 0; count.bytes = 0; }
                    }
                    for (const [key, bytes] of Object.entries(sample.files ?? sample.added ?? {})) {
                        if (downloadedKeys.has(key)) continue;
                        if (!full) changed = true;
                        downloadedKeys.add(key);
                        sizes.set(key, bytes);
                        queuedKeys.delete(key);
                        for (const id of reverse.get(key) ?? []) {
                            const count = counts.get(id)!;
                            count.downloaded++;
                            count.bytes += bytes;
                        }
                    }
                    revision = sample.revision;
                    lastError = sample.error;
                    totalBytes = sample.total;
                    quotaBytes = sample.quota;
                    render(changed);
                } catch (error) { logCatch('offline inventory')(error); }
            } while (requested);
        }
        finally { pulling = false; }
    }
    window.addEventListener('oneplay-pins', refresh);
    window.addEventListener('pageshow', refresh);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) return refresh(); });

    async function control(action: string, args?: Record<string, unknown>) {
        try { await library.pins(action, args); await refresh(); }
        catch (error) { lastError = 'Could not update offline downloads.'; render(false); logCatch('offline controls')(error); }
    }

    async function project(favorites: readonly Favorite[], roots: RootsMap, denied: ReadonlySet<string>) {
        const version = ++projection;
        const owners = [];
        const links = new Map<string, Set<string>>();
        const nextCounts: typeof counts = new Map();
        const byId = new Map(favorites.map(f => [f.id, f]));
        let slice = performance.now();
        for (const favorite of favorites) {
            let complete = true;
            const sources = new Map<string, Set<string>>();
            const keys = new Set<string>();
            const seenFavorites = new Set<string>();
            const seenFolders = new Map<string, Set<MusicFolder>>();
            const refs: PlaylistMember[] = [{favId: favorite.id}];
            while (refs.length) {
                const ref = refs.pop()!;
                if (isFavRef(ref)) {
                    if (seenFavorites.has(ref.favId)) continue;
                    seenFavorites.add(ref.favId);
                    const f = byId.get(ref.favId);
                    if (!f) { complete = false; continue; }
                    if (f.kind === 'shortcut') refs.push(f.target);
                    else for (const member of f.members) refs.push(member);
                    continue;
                }
                const root = resolveWalkableRootForItemRef(ref, roots);
                if (!root || denied.has(root.key)) { complete = false; continue; }
                const parent = ref.path.length ? walkFolder(root.folder, ref.path.slice(0, -1)) : undefined;
                const node = ref.path.length ? parent?.children[ref.path.at(-1)!] : root.folder;
                // Healing can lag an index rename. Only the same item can replace its prior ownership.
                if (!node || node.id !== ref.itemId || isMusicFolder(node) !== ref.isFolder) { complete = false; continue; }
                if (root.reindexing) complete = false;
                let group = sources.get(root.key);
                if (!group) sources.set(root.key, group = new Set());
                let seen = seenFolders.get(root.key);
                if (!seen) seenFolders.set(root.key, seen = new Set());
                const pending = [node];
                while (pending.length) {
                    const item = pending.pop()!;
                    if (isMusicFolder(item)) {
                        if (seen.has(item)) continue;
                        seen.add(item);
                        for (const child of Object.values(item.children)) pending.push(child);
                    } else {
                        const key = ref.driveId + ':' + item.id;
                        keys.add(key);
                        group.add(key);
                    }
                    if (performance.now() - slice > 8) {
                        await new Promise(resolve => setTimeout(resolve, 0));
                        if (version !== projection) return;
                        slice = performance.now();
                    }
                }
            }
            for (const key of keys) {
                let ids = links.get(key);
                if (!ids) links.set(key, ids = new Set());
                ids.add(favorite.id);
            }
            nextCounts.set(favorite.id, {total: keys.size, downloaded: 0, bytes: 0, complete});
            if (favorite.offlinePin) owners.push({id: favorite.id, paused: favorite.offlinePin.paused, complete,
                sources: Object.fromEntries(Array.from(sources, ([root, members]) => [root, [...members]]))});
        }
        // Inventory can change across a yielded library walk. Count against the latest snapshot at commit.
        for (const [key, ids] of links) {
            const bytes = sizes.get(key);
            if (bytes === undefined) continue;
            for (const id of ids) { const count = nextCounts.get(id)!; count.downloaded++; count.bytes += bytes; }
        }
        reverse = links;
        counts = nextCounts;
        render(false);
        const next = JSON.stringify(owners);
        if (publication?.signature !== next) publication = {signature: next, ack: library.pins('owners', {revision: version, owners})};
        const sent = publication;
        try { await sent.ack; await refresh(); }
        catch (error) {
            if (publication !== sent) return;
            publication = undefined;
            throw error;
        }
    }

    return {
        refresh,
        async fenceEdit() {
            publication = undefined;
            latest = undefined;
            editing = true;
            try { await library.pins('fence', {revision: ++projection}); }
            catch (error) { editing = false; throw error; }
            return () => { editing = false; };
        },
        getSnapshot(): DownloadSnapshot {
            return {downloadedKeys, queuedKeys, overQuota: totalBytes > quotaBytes, lastError,
                evidence: library.getEvidence(), quotaBytes, totalBytes};
        },
        setQuota: (gb: number) => control('quota', {quota: gb}),
        clearError: () => control('retry'),
        favoriteProgress: (id: string) => counts.get(id),
        async publishOwners(favorites: readonly Favorite[], roots: RootsMap, denied: ReadonlySet<string>, known: boolean) {
            if (!known || editing) return;
            // Tree rendering recreates root wrappers. Only source folder identity, reindexing,
            // denial and favorite edits can invalidate physical membership.
            const physical: RootsMap = new Map([...roots].filter(([, r]) => r.type === 'onedrive' || r.type === 'share'));
            const prev = latest;
            const unchanged = prev && !prev.failed && prev.favorites.length === favorites.length && favorites.every((f,i) => f === prev.favorites[i])
                && prev.denied.size === denied.size && [...denied].every(k => prev.denied.has(k))
                && prev.roots.size === physical.size && [...physical].every(([k,r]) => {
                    const old = prev.roots.get(k);
                    return old && 'folder' in r && 'folder' in old && r.folder === old.folder && r.reindexing === old.reindexing;
                });
            if (!unchanged) latest = {favorites, roots: physical, denied, done: project(favorites, physical, denied)};
            // A sync arriving mid-walk may supersede a local edit's projection. Its caller still
            // waits for the surviving durable publication before closing the modal.
            let observed: Inputs | undefined;
            do {
                observed = latest;
                try { await observed?.done; }
                catch (error) { if (observed && latest === observed) { observed.failed = true; throw error; } }
            } while (observed !== latest);
        },
    };
}
