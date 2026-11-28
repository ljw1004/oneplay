import type { Downloads, DownloadSnapshot, PinProgress } from './downloads.js';
import { isFavRef, type PlaylistMember, type Favorite, type FolderPin, type RootsMap } from './favorites.js';
import { logCatch } from './logger.js';
import type { NativeLibrary } from './native-library.js';
import { isMusicFolder, walkFolder, type MusicFolder } from './indexer.js';
import { folderPinOwnerId, folderPinPathKey, isWalkableRoot, resolveWalkableRootForItemRef } from './roots.js';

interface Inventory {
    revision: number;
    files?: Record<string, number>;
    queuedCount: number;
    transferAllowed?: boolean;
    unavailable?: Record<string, string>;
    added?: Record<string, number>;
    quota: number;
    total: number;
}

interface Sources {
    roots: RootsMap;
    favorites: ReadonlyMap<string, Favorite>;
    denied: ReadonlySet<string>;
}

/** Expand an owner's logical references into physical files. The visited sets deduplicate
 * overlapping playlist routes. Missing indexes and pending renames make the result incomplete. */
async function walkOwner(start: PlaylistMember, sources: Sources, current: () => boolean,
    visitFile: (source: string, key: string, name: string) => void): Promise<boolean> {
    const refs = [start];
    const seenFavorites = new Set<string>();
    const seenFolders = new Map<string, Set<MusicFolder>>();
    let complete = true, slice = performance.now();
    while (refs.length) {
        if (performance.now() - slice > 6) {
            await new Promise(resolve => setTimeout(resolve, 0));
            if (!current()) return false;
            slice = performance.now();
        }
        const ref = refs.pop()!;
        if (isFavRef(ref)) {
            if (seenFavorites.has(ref.favId)) continue;
            seenFavorites.add(ref.favId);
            const favorite = sources.favorites.get(ref.favId);
            if (!favorite) { complete = false; continue; }
            if (favorite.kind === 'shortcut') refs.push(favorite.target);
            else for (const member of favorite.members) refs.push(member);
            continue;
        }
        const root = resolveWalkableRootForItemRef(ref, sources.roots);
        if (!root || sources.denied.has(root.key)) { complete = false; continue; }
        const parent = ref.path.length ? walkFolder(root.folder, ref.path.slice(0, -1)) : undefined;
        const node = ref.path.length ? parent?.children[ref.path.at(-1)!] : root.folder;
        if (!node || node.id !== ref.itemId || isMusicFolder(node) !== ref.isFolder) { complete = false; continue; }
        if (root.type !== 'demo' && root.reindexing) complete = false;
        let seen = seenFolders.get(root.key);
        if (!seen) seenFolders.set(root.key, seen = new Set());
        const pending: [string, typeof node][] = [[ref.path.at(-1) ?? '', node]];
        while (pending.length) {
            const [name, item] = pending.pop()!;
            if (isMusicFolder(item)) {
                if (!seen.has(item)) {
                    seen.add(item);
                    for (const child of Object.entries(item.children)) pending.push(child);
                }
            } else visitFile(root.key, ref.driveId + ':' + item.id, name);
            if (performance.now() - slice > 6) {
                await new Promise(resolve => setTimeout(resolve, 0));
                if (!current()) return false;
                slice = performance.now();
            }
        }
    }
    return complete;
}

/** Both players walk a committed library revision once. A completed file updates
 * only its owners, including overlapping physical folders and playlist routes. */
export function createOfflinePins(backend: NativeLibrary | Downloads, render: (playabilityChanged: boolean) => void) {
    const library = 'pins' in backend ? backend : undefined;
    const browser = 'setPinnedKeys' in backend ? backend : undefined;
    const nativeFiles = new Map<string, number>();
    // The browser supplies its live map on each full notification. Swift supplies deltas.
    let sizes: ReadonlyMap<string, number> = nativeFiles;
    let queuedCount = 0;
    let transferAllowed: boolean | undefined;
    let unavailable = new Map<string, string | undefined>();
    let reverse = new Map<string, Set<string>>();
    let counts = new Map<string, PinProgress>();
    let folderCoverage = new Map<string, {partial: boolean; blocked: boolean; owners: string[]}>();
    let sources: Sources | undefined;
    // An unmarked dialog keeps its total. A partial dialog keeps the union of its marked recordings.
    let preview: {key: string; keys?: Set<string>; count?: PinProgress} | undefined;
    let quotaBytes = 2 ** 30, totalBytes = 0, lastError: string | undefined;
    let revision: number | undefined, projection = 0;
    type Inputs = {
        favorites: readonly Favorite[];
        roots: RootsMap;
        denied: ReadonlySet<string>;
        pins: readonly FolderPin[];
        sharesKnown: boolean;
    };
    let latest: Inputs | undefined;
    let pulling = false, requested = false;

    /** A full inventory replaces the device baseline. Deltas touch only the owners of each new file. */
    function applyInventory(files: Iterable<readonly [string, number]>, full: boolean): boolean {
        if (full) {
            unavailable.clear();
            if (library) nativeFiles.clear();
            for (const count of counts.values()) { count.downloaded = 0; count.bytes = 0; delete count.unavailable; delete count.warnings; }
        }
        let changed = full;
        for (const [key, bytes] of files) {
            if (library) {
                if (nativeFiles.has(key)) continue;
                nativeFiles.set(key, bytes);
            }
            changed = true;
            for (const id of reverse.get(key) ?? []) {
                const count = counts.get(id)!;
                count.downloaded++;
                count.bytes += bytes;
            }
        }
        return changed;
    }

    /** A terminal response blocks only the owners waiting for that recording. A fresh
     * queue or native inventory supplies a new baseline before transfers resume. */
    function markUnavailable(key: string, reason?: string): void {
        if (unavailable.has(key) || sizes.has(key)) return;
        unavailable.set(key, reason);
        for (const owner of reverse.get(key) ?? []) {
            const count = counts.get(owner)!;
            count.unavailable = (count.unavailable ?? 0) + 1;
            if (reason) (count.warnings ??= new Set()).add(reason);
        }
    }

    if (browser) browser.onStateChange = inventory => {
        if (inventory && 'unavailable' in inventory) {
            markUnavailable(inventory.unavailable);
            render(false);
            return;
        }
        if (inventory && 'files' in inventory) sizes = inventory.files;
        const changed = inventory && ('files' in inventory
            ? applyInventory(inventory.files, true) : applyInventory([inventory.added], false));
        render(!!changed);
    };

    /** Coalesce visible signals. A revision gap causes Swift to return a complete inventory. */
    async function refresh() {
        if (!library) return;
        requested = true;
        if (pulling) return;
        pulling = true;
        try {
            do {
                requested = false;
                try {
                    const sample = await library.pins('snapshot', {after: revision ?? null}) as Inventory;
                    queuedCount = sample.queuedCount;
                    transferAllowed = sample.transferAllowed;
                    const changed = applyInventory(Object.entries(sample.files ?? sample.added ?? {}), !!sample.files);
                    for (const [key, reason] of Object.entries(sample.unavailable ?? {})) markUnavailable(key, reason);
                    revision = sample.revision;
                    lastError = undefined;
                    totalBytes = sample.total;
                    quotaBytes = sample.quota;
                    render(changed);
                } catch (error) { logCatch('offline inventory')(error); }
            } while (requested);
        }
        finally { pulling = false; }
    }
    if (library) {
        window.addEventListener('oneplay-pins', refresh);
        window.addEventListener('pageshow', refresh);
        document.addEventListener('visibilitychange', () => { if (!document.hidden) return refresh(); });
    }

    /** Publish the latest committed owners and their coverage. Only marked subtrees enter this walk. */
    async function project({favorites, pins, roots, denied, sharesKnown}: Inputs) {
        const version = ++projection;
        const owners = [];
        const active = new Set<string>(), retained = new Set<string>();
        const coverage: typeof folderCoverage = new Map();
        let membershipComplete = true;
        const links = new Map<string, Set<string>>();
        const nextCounts: typeof counts = new Map();
        const context = {roots, denied, favorites: new Map(favorites.map(f => [f.id, f]))};
        const entries: {id: string; ref: PlaylistMember; paused: boolean}[] = [];
        for (const f of favorites) if (f.offlinePin) entries.push({id: f.id, ref: {favId:f.id}, paused:f.offlinePin.paused});
        // The favorites document already holds the healed, outermost folder pins.
        for (const pin of pins) {
            const id = folderPinOwnerId(pin);
            const root = roots.get(pin.sourceRootKey);
            // A reconnected link has a fresh owner namespace. Until the share list
            // loads, an absent root still needs its incomplete owner to retain native files.
            if (root?.type === 'share' && root.connectionId !== pin.connectionId) continue;
            if (!root && (!pin.connectionId || sharesKnown)) continue;
            for (let depth = 0; depth <= pin.path.length; depth++) {
                const key = folderPinPathKey(pin.sourceRootKey, pin.connectionId, pin.path.slice(0, depth));
                const branch = coverage.get(key);
                if (branch) branch.owners.push(id);
                else coverage.set(key, {partial:depth < pin.path.length, blocked:denied.has(pin.sourceRootKey), owners:[id]});
            }
            entries.push({id, ref: pin, paused: false});
        }
        for (const {id, ref, paused} of entries) {
            const groups = new Map<string, Record<string, string>>();
            const keys = new Set<string>();
            const complete = await walkOwner(ref, context, () => version === projection, (source, key, name) => {
                if (library) {
                    let group = groups.get(source);
                    if (!group) groups.set(source, group = Object.create(null) as Record<string, string>);
                    group[key] = name;
                }
                if (keys.has(key)) return;
                keys.add(key);
                let ids = links.get(key);
                if (!ids) links.set(key, ids = new Set());
                ids.add(id);
                if (browser) {
                    retained.add(key);
                    if (!paused) active.add(key);
                }
            });
            if (version !== projection) return;
            if (!complete) membershipComplete = false;
            nextCounts.set(id, {total: keys.size, downloaded: 0, bytes: 0, complete});
            if (library) {
                owners.push({id, paused, complete,
                    sources: Object.fromEntries(groups)});
            }
        }
        // Inventory can change across a yielded library walk. Count against the latest snapshot at commit.
        for (const [key, bytes] of sizes) {
            for (const id of links.get(key) ?? []) { const count = nextCounts.get(id)!; count.downloaded++; count.bytes += bytes; }
        }
        reverse = links;
        counts = nextCounts;
        // A moved folder or a newly overlapping playlist inherits existing terminal results.
        const blocked = unavailable;
        unavailable = new Map();
        for (const [key, reason] of blocked) markUnavailable(key, reason);
        folderCoverage = coverage;
        sources = context;
        preview = undefined;
        render(false);
        if (browser) await browser.setPinnedKeys(active, retained, membershipComplete);
        if (!library) return;
        await library.pins('owners', {revision: version, owners});
        await refresh();
    }

    /** An unpinned favorite or folder has no background owner. Its open dialog uses the
     * same walker once and shows the track total until the dialog closes or the index changes. */
    function previewProgress(key: string, ref: PlaylistMember): PinProgress | undefined {
        if (!sources) return;
        if (preview?.key !== key) {
            const selection: NonNullable<typeof preview> = {key};
            preview = selection;
            const keys = new Set<string>();
            walkOwner(ref, sources, () => selection === preview, (_, file) => keys.add(file)).then(complete => {
                if (selection !== preview) return;
                selection.count = {total: keys.size, downloaded: 0, bytes: 0, complete};
                render(false);
            }).catch(logCatch('offline dialog count'));
        }
        return preview.count;
    }

    return {
        refresh,
        getSnapshot(): DownloadSnapshot {
            if (browser) return browser.getSnapshot();
            return {files:sizes, queuedCount, overQuota: totalBytes > quotaBytes, lastError,
                evidence: library!.getEvidence(), transferAllowed, quotaBytes, totalBytes};
        },
        async setQuota(gb: number) {
            if (browser) return browser.setQuota(gb);
            try { await library!.pins('quota', {quota: gb}); await refresh(); }
            catch (error) { lastError = 'Could not update the storage limit.'; render(false); logCatch('offline quota')(error); }
        },
        clearError: browser?.clearError,
        favoriteProgress(id: string) {
            const favorite = sources?.favorites.get(id);
            return counts.get(id) ?? (favorite && !favorite.offlinePin ? previewProgress(id, {favId:id}) : undefined);
        },
        getFolderCoverage: () => folderCoverage,
        folderProgress(folder?: FolderPin): (PinProgress & {childFolders?: number}) | undefined {
            if (!folder) { preview = undefined; return; }
            const path = folderPinPathKey(folder.sourceRootKey, folder.connectionId, folder.path);
            const branch = folderCoverage.get(path);
            if (branch && !branch.partial) { preview = undefined; return counts.get(branch.owners[0]); }
            if (branch) {
                if (preview?.key !== path || !preview.keys) {
                    const owners = new Set(branch.owners);
                    const keys = new Set<string>();
                    for (const [file, ids] of reverse) {
                        for (const id of ids) if (owners.has(id)) { keys.add(file); break; }
                    }
                    preview = {key:path, keys};
                }
                const keys = preview.keys!;
                let downloaded = 0, bytes = 0, blocked = 0;
                for (const [file, size] of sizes) if (keys.has(file)) { downloaded++; bytes += size; }
                const warnings = new Set<string>();
                for (const [file, reason] of unavailable) if (keys.has(file)) {
                    blocked++;
                    if (reason) warnings.add(reason);
                }
                return {total:keys.size, childFolders:branch.owners.length, downloaded, bytes, unavailable:blocked, warnings,
                    complete:branch.owners.every(id => counts.get(id)?.complete)};
            }
            const root = sources?.roots.get(folder.sourceRootKey);
            if (!root || (root.type === 'share' && root.connectionId !== folder.connectionId)) return;
            return previewProgress('folder:' + JSON.stringify([path, folder.itemId]), folder);
        },
        async publishOwners(favorites: readonly Favorite[], pins: readonly FolderPin[], roots: RootsMap, denied: ReadonlySet<string>, favoritesKnown: boolean, sharesKnown: boolean) {
            if (!favoritesKnown) return;
            // Tree rendering recreates root wrappers. Only source folder identity, reindexing,
            // denial and favorite edits can invalidate physical membership.
            const physical: RootsMap = new Map([...roots].filter(([, r]) => r.type === 'share' || isWalkableRoot(r)));
            const prev = latest;
            const unchanged = prev && prev.sharesKnown === sharesKnown && prev.pins === pins
                && prev.favorites.length === favorites.length && favorites.every((f,i) => {
                    const old = prev.favorites[i];
                    // Names, playback modes and private bookmarks do not change download membership.
                    return f.id === old.id && f.offlinePin?.paused === old.offlinePin?.paused
                        && (f.kind === 'shortcut' ? old.kind === 'shortcut' && f.target === old.target
                            : old.kind === 'playlist' && f.members === old.members);
                })
                && prev.denied.size === denied.size && [...denied].every(k => prev.denied.has(k))
                && prev.roots.size === physical.size && [...physical].every(([k,r]) => {
                    const old = prev.roots.get(k);
                    return old && 'folder' in r && 'folder' in old && r.folder === old.folder && ('reindexing' in r && r.reindexing) === ('reindexing' in old && old.reindexing)
                        && (r.type !== 'share' || (old.type === 'share' && r.connectionId === old.connectionId));
                });
            if (unchanged) return;
            const inputs = {favorites, pins, roots: physical, denied, sharesKnown};
            latest = inputs;
            try { await project(inputs); }
            catch (error) {
                if (latest === inputs) latest = undefined;
                throw error;
            }
        },
    };
}
