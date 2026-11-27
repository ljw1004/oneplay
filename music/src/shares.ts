/**
 * Shares module for OnePlay Music (M14).
 *
 * Persists share roots in IndexedDB + OneDrive app folder, with runtime-only
 * denied state that is intentionally never persisted.
 */

import { type Favorites, type RootsMap, isFavRef, type Favorite } from './favorites.js';
import { type MusicFolder, isMusicFolder, walkFolder } from './indexer.js';
import { log, logCatch, logError } from './logger.js';
import { resolveWalkableRootForItemRef } from './roots.js';
import { parsePrimaryDocument, ProviderHttpError, type PrimaryStore } from './provider.js';
import type { OneDriveProvider } from './onedrive-provider.js';
import type { NativeLibrary } from './native-library.js';

export interface SharesDeps {
    /** Redemption proves access to the resolved folder, including an explicitly reconnected share. */
    readonly readPlaybackDenials?: () => Promise<readonly string[]>;
    readonly beginSourceProbe?: NativeLibrary['beginSourceProbe'];
    /** The native player must withdraw the removed root even if deleting its index later stalls. */
    readonly onDisconnect?: (remainingRoots: string[], removedRoot: string) => Promise<void>;
    documents: PrimaryStore;
    oneDrive: Pick<OneDriveProvider, 'readShareIdentity' | 'redeemShareFolder'>;
    dbGet<T>(key: string): Promise<T | undefined>;
    dbPut(key: string, value: unknown): Promise<void>;
}

export interface ShareRecordPersisted {
    readonly id: string;
    readonly shareId: string;
    readonly name: string;
    readonly rootKey: string;
    readonly driveId: string;
    readonly rootItemId: string;
    readonly addedAt: number;
    readonly updatedAt: number;
}

interface SharesData {
    readonly version: number;
    readonly updatedAt: number;
    readonly shares: readonly ShareRecordPersisted[];
}

export interface RemoveImpact {
    readonly uniqueTrackCount: number;
    readonly affectedFavoriteCount: number;
    readonly folderPinCount: number;
}

export interface Shares {
    hasLoadedMembership?(): boolean;
    getAll(): readonly ShareRecordPersisted[];
    loadFromCache(): Promise<void>;
    /** True after reading a valid document or confirming there is none (404). */
    pullFromOneDrive(): Promise<boolean>;
    addFromUrl(url: string, signal?: AbortSignal): Promise<ShareRecordPersisted>;
    rename(id: string, nextName: string): Promise<void>;
    remove(id: string): Promise<void>;
    setDeniedState(rootKey: string, reason: string | undefined): void;
    getDeniedCount(): number;
    getDeniedRootKeys(): ReadonlySet<string>;
    getDeniedReason(rootKey: string): string | undefined;
    computeRemoveImpact(share: ShareRecordPersisted, favorites: Favorites, roots: RootsMap): RemoveImpact;
}

const IDB_KEY = 'shares';
const DOCUMENT = 'shares.json';

function sortByAddedAt(shares: readonly ShareRecordPersisted[]): ShareRecordPersisted[] {
    return [...shares].sort((a, b) => a.addedAt - b.addedAt);
}

function normalizeShare(share: ShareRecordPersisted): ShareRecordPersisted {
    return {
        ...share,
        rootKey: share.rootKey.startsWith('share:') ? share.rootKey : `share:${share.shareId}`,
    };
}

function collectTrackKeysFromFolder(
    folder: MusicFolder,
    driveId: string,
    out: Set<string>,
): void {
    for (const child of Object.values(folder.children)) {
        if (isMusicFolder(child)) {
            collectTrackKeysFromFolder(child, driveId, out);
        } else {
            out.add(`${driveId}:${child.id}`);
        }
    }
}

export function createShares(deps: SharesDeps, onChange: () => void): Shares {
    let loadedMembership = false;
    let shares: ShareRecordPersisted[] = [];
    let updatedAt = 0;
    const deniedByRootKey = new Map<string, string>();

    let uploadDirty = false;
    let uploadRunning = false;

    const toData = (): SharesData => ({ version: 1, updatedAt, shares });

    const saveLocal = async (): Promise<void> => {
        await deps.dbPut(IDB_KEY, toData()).catch(logCatch('shares:dbPut'));
    };

    const scheduleOneDriveUploadFireAndForget = (): void => {
        uploadDirty = true;
        if (uploadRunning) return;
        uploadRunning = true;
        (async () => {
            while (uploadDirty) {
                uploadDirty = false;
                try {
                    await deps.documents.write(DOCUMENT, JSON.stringify(toData()));
                    log('shares: saved to OneDrive');
                } catch (e) {
                    if (e instanceof ProviderHttpError) logError(`shares: OneDrive save failed: ${e.status}`);
                    else logCatch('shares:onedrive-save')(e);
                }
            }
            uploadRunning = false;
        })();
    };

    return {
        getAll: () => shares,
        hasLoadedMembership: () => loadedMembership,

        async loadFromCache() {
            const [cached, denied] = await Promise.all([
                deps.dbGet<SharesData>(IDB_KEY).catch(() => undefined), deps.readPlaybackDenials?.(),
            ]);
            for (const root of denied ?? []) deniedByRootKey.set(root, 'Waiting for OneDrive to confirm access');
            if (!cached || !Array.isArray(cached.shares)) return;
            loadedMembership = true;
            shares = sortByAddedAt(cached.shares.map(normalizeShare));
            updatedAt = cached.updatedAt || 0;
            onChange();
        },

        async pullFromOneDrive() {
            try {
                const text = await deps.documents.read(DOCUMENT);
                if (text === null) {
                    loadedMembership = true;
                    return true;
                }
                const server = parsePrimaryDocument(text, 'shares:onedrive-load') as SharesData;
                if (!server || !Array.isArray(server.shares)) return false;
                const serverTime = server.updatedAt || 0;
                if (loadedMembership && serverTime <= updatedAt) return true;
                const previous = shares;
                const next = sortByAddedAt(server.shares.map(normalizeShare));
                await deps.dbPut(IDB_KEY, {version:1, updatedAt:serverTime, shares:next});
                // A local edit admitted during this write wins. Reconcile its graph on the next pull.
                if (shares !== previous) return false;
                shares = next;
                updatedAt = serverTime;
                loadedMembership = true;
                onChange();
                return true;
            } catch (error) {
                if (error instanceof ProviderHttpError) logError(`shares: OneDrive load failed: ${error.status}`);
                else logCatch('shares:onedrive-load')(error);
                return false;
            }
        },

        async addFromUrl(url, signal) {
            const trimmed = url.trim();
            if (!trimmed) throw new Error('Share URL is required');
            log('shares:addFromUrl start');
            const { shareId, token } = await deps.oneDrive.readShareIdentity(trimmed, signal);

            if (shares.some((s) => s.shareId === shareId)) {
                throw new Error('This share is already connected');
            }

            const rootKey = 'share:' + shareId;
            const applyAccess = deps.beginSourceProbe?.(rootKey);
            const { driveId, rootItemId, name, response } = await deps.oneDrive.redeemShareFolder(token, signal);
            signal?.throwIfAborted();
            const now = Date.now();
            const record: ShareRecordPersisted = {
                id: crypto.randomUUID(),
                shareId,
                name,
                rootKey,
                driveId,
                rootItemId,
                addedAt: now,
                updatedAt: now,
            };
            loadedMembership = true;
            shares = sortByAddedAt([...shares, record]);
            updatedAt = now;
            const proof = applyAccess?.(response, true, () => shares.some(s => s.id === record.id));
            const [, granted] = await Promise.all([saveLocal(), proof?.catch(logCatch('shares:confirm playback access'))]);
            if (granted) deniedByRootKey.delete(rootKey);
            onChange();
            scheduleOneDriveUploadFireAndForget();
            log('shares:addFromUrl success');
            return record;
        },

        async rename(id, nextName) {
            const trimmed = nextName.trim();
            if (!trimmed) return;
            const existing = shares.find((s) => s.id === id);
            if (!existing || existing.name === trimmed) return;
            shares = shares.map((s) =>
                s.id !== id ? s : { ...s, name: trimmed, updatedAt: Date.now() });
            updatedAt = Date.now();
            await saveLocal();
            onChange();
            scheduleOneDriveUploadFireAndForget();
        },

        async remove(id) {
            const removed = shares.find(s => s.id === id);
            if (!removed) return;
            shares = shares.filter((s) => s.id !== id);
            updatedAt = Date.now();
            try { await Promise.all([saveLocal(), deps.onDisconnect?.(shares.map(s => s.rootKey), removed.rootKey)]); }
            finally {
                onChange();
                scheduleOneDriveUploadFireAndForget();
            }
        },

        setDeniedState(rootKey, reason) {
            const prev = deniedByRootKey.get(rootKey);
            if (reason === undefined) {
                if (prev === undefined) return;
                deniedByRootKey.delete(rootKey);
                onChange();
                return;
            }
            if (prev === reason) return;
            deniedByRootKey.set(rootKey, reason);
            onChange();
        },

        getDeniedCount: () => shares.filter(s => deniedByRootKey.has(s.rootKey)).length,
        getDeniedRootKeys: () => new Set(deniedByRootKey.keys()),
        getDeniedReason: (rootKey) => deniedByRootKey.get(rootKey),

        computeRemoveImpact(share, favorites, roots) {
            const rootKey = share.rootKey;
            const allFavorites = favorites.getAll();
            const trackKeys = new Set<string>();
            let affectedFavoriteCount = 0;

            const collectFromRef = (ref: import('./favorites.js').ItemRef): string[] => {
                if (ref.sourceRootKey !== rootKey) return [];
                if (!ref.isFolder) return [`${ref.driveId}:${ref.itemId}`];
                const root = resolveWalkableRootForItemRef(ref, roots);
                if (!root) return [];
                const folder = walkFolder(root.folder, ref.path);
                if (!folder) return [];
                const out = new Set<string>();
                collectTrackKeysFromFolder(folder, ref.driveId, out);
                return [...out];
            };

            const collectFromFavorite = (fav: Favorite, visited: Set<string>): Set<string> => {
                if (visited.has(fav.id)) return new Set<string>();
                visited.add(fav.id);

                if (fav.kind === 'shortcut') return new Set(collectFromRef(fav.target));

                const result = new Set<string>();
                for (const member of fav.members) {
                    if (isFavRef(member)) {
                        const nested = allFavorites.find((f) => f.id === member.favId);
                        if (!nested) continue;
                        for (const key of collectFromFavorite(nested, new Set(visited))) result.add(key);
                        continue;
                    }
                    for (const key of collectFromRef(member)) result.add(key);
                }
                return result;
            };

            for (const fav of allFavorites) {
                const keys = collectFromFavorite(fav, new Set());
                if (keys.size === 0) continue;
                affectedFavoriteCount += 1;
                for (const key of keys) trackKeys.add(key);
            }

            return {
                uniqueTrackCount: trackKeys.size,
                folderPinCount: favorites.getFolderPins().filter(pin => pin.sourceRootKey === rootKey && pin.connectionId === share.id).length,
                affectedFavoriteCount,
            };
        },
    };
}
