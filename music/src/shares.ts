/**
 * Shares module for OnePlay Music (M14).
 *
 * Persists share roots in IndexedDB + OneDrive app folder, with runtime-only
 * denied state that is intentionally never persisted.
 */

import { type Favorites, type RootsMap, isFavRef, type Favorite } from './favorites.js';
import { type MusicFolder, isMusicFolder, walkFolder } from './indexer.js';
import { log, logCatch, logError, errorMessage } from './logger.js';
import { resolveWalkableRootForItemRef } from './roots.js';
import { type AuthFetch } from './auth.js';

export interface SharesDeps {
    authFetch: AuthFetch;
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
}

export interface Shares {
    getAll(): readonly ShareRecordPersisted[];
    loadFromCache(): Promise<void>;
    pullFromOneDrive(): Promise<void>;
    addFromUrl(url: string, signal?: AbortSignal): Promise<ShareRecordPersisted>;
    rename(id: string, nextName: string): Promise<void>;
    remove(id: string): Promise<void>;
    setDeniedState(rootKey: string, reason: string | undefined): void;
    getDeniedCount(): number;
    getDeniedRootKeys(): ReadonlySet<string>;
    getDeniedReason(rootKey: string): string | undefined;
    computeRemoveImpact(rootKey: string, favorites: Favorites, roots: RootsMap): RemoveImpact;
}

const IDB_KEY = 'shares';
const ONEDRIVE_PATH = '/me/drive/special/approot:/shares.json:/content';

function encodeShareUrlToken(url: string): string {
    const b64 = btoa(url).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    return `u!${b64}`;
}

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

async function readResponseBodyForLog(response: Response): Promise<string> {
    try {
        const text = await response.clone().text();
        return text || '<empty>';
    } catch (e) {
        const msg = errorMessage(e);
        return `<unreadable body: ${msg}>`;
    }
}

async function logAddFromUrlResponse(
    step: 'meta' | 'driveItem' | 'special-music',
    response: Response,
): Promise<void> {
    const body = await readResponseBodyForLog(response);
    const msg = `shares:addFromUrl:${step} response url=${response.url} status=${response.status} ok=${response.ok} body=${body}`;
    if (response.ok) log(msg);
    else logError(msg);
}

async function extractGraphErrorMessage(
    response: Response,
    fallback: string,
): Promise<string> {
    try {
        const parsed = await response.clone().json() as {
            readonly error?: { readonly message?: unknown };
        };
        const message = parsed.error?.message;
        return typeof message === 'string' && message.trim() ? message : fallback;
    } catch {
        return fallback;
    }
}

export function createShares(deps: SharesDeps, onChange: () => void): Shares {
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
                    const r = await deps.authFetch(
                        `https://graph.microsoft.com/v1.0${ONEDRIVE_PATH}`,
                        false,
                        {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(toData()),
                        },
                    );
                    if (!r.ok) logError(`shares: OneDrive save failed: ${r.status}`);
                    else log('shares: saved to OneDrive');
                } catch (e) {
                    logCatch('shares:onedrive-save')(e);
                }
            }
            uploadRunning = false;
        })();
    };

    return {
        getAll: () => shares,

        async loadFromCache() {
            const cached = await deps.dbGet<SharesData>(IDB_KEY).catch(() => undefined);
            if (!cached || !Array.isArray(cached.shares)) return;
            shares = sortByAddedAt(cached.shares.map(normalizeShare));
            updatedAt = cached.updatedAt || 0;
            onChange();
        },

        async pullFromOneDrive() {
            await deps.authFetch(`https://graph.microsoft.com/v1.0${ONEDRIVE_PATH}`, false)
                .then(async (r) => {
                    if (!r.ok) {
                        if (r.status !== 404) logError(`shares: OneDrive load failed: ${r.status}`);
                        return;
                    }
                    const server: SharesData = await r.json();
                    if (!server || !Array.isArray(server.shares)) return;
                    if ((server.updatedAt || 0) <= updatedAt) return;
                    shares = sortByAddedAt(server.shares.map(normalizeShare));
                    updatedAt = server.updatedAt;
                    await saveLocal();
                    onChange();
                })
                .catch(logCatch('shares:onedrive-load'));
        },

        async addFromUrl(url, signal) {
            const trimmed = url.trim();
            if (!trimmed) throw new Error('Share URL is required');
            log(`shares:addFromUrl start url=${trimmed}`);
            const token = encodeShareUrlToken(trimmed);

            const metaR = await deps.authFetch(
                `https://graph.microsoft.com/v1.0/shares/${token}?$select=id`,
                false,
                { headers: { Prefer: 'redeemSharingLink' }, signal },
            );
            await logAddFromUrlResponse('meta', metaR);
            if (!metaR.ok) {
                throw new Error(await extractGraphErrorMessage(
                    metaR,
                    `Cannot open share URL (${metaR.status})`,
                ));
            }
            const meta = await metaR.json().catch(() => ({} as Record<string, unknown>));
            const shareId = typeof meta.id === 'string' && meta.id ? meta.id : token;

            if (shares.some((s) => s.shareId === shareId)) {
                throw new Error('This share is already connected');
            }

            const itemR = await deps.authFetch(
                `https://graph.microsoft.com/v1.0/shares/${token}/driveItem?$select=id,name,folder,root,parentReference,createdBy`,
                false,
                { headers: { Prefer: 'redeemSharingLink' }, signal },
            );
            await logAddFromUrlResponse('driveItem', itemR);
            if (!itemR.ok) {
                throw new Error(await extractGraphErrorMessage(
                    itemR,
                    `Cannot read shared item (${itemR.status})`,
                ));
            }
            const item = await itemR.json();
            if (!item?.folder) throw new Error('Only folder shares are supported');

            const driveIdRaw = item.parentReference?.driveId;
            if (typeof driveIdRaw !== 'string' || !driveIdRaw) throw new Error('Share missing driveId');
            const driveId = driveIdRaw;

            let rootItem = item;
            const isWholeDriveShare = item.root !== undefined && item.root !== null;
            if (isWholeDriveShare) {
                const musicR = await deps.authFetch(
                    `https://graph.microsoft.com/v1.0/drives/${encodeURIComponent(driveId)}/special/music?$select=id,name,folder,createdBy`,
                    false,
                    { signal },
                );
                await logAddFromUrlResponse('special-music', musicR);
                if (!musicR.ok) {
                    throw new Error(await extractGraphErrorMessage(
                        musicR,
                        'Whole-drive share must expose Music folder',
                    ));
                }
                rootItem = await musicR.json();
                if (!rootItem?.folder) throw new Error('Music special folder is not accessible');
            }

            const ownerName = typeof rootItem?.createdBy?.user?.displayName === 'string'
                ? rootItem.createdBy.user.displayName : undefined;
            const name = isWholeDriveShare
                ? (ownerName || rootItem.name || item.name || 'Shared Music')
                : (item.name || 'Shared Music');
            const now = Date.now();
            const record: ShareRecordPersisted = {
                id: crypto.randomUUID(),
                shareId,
                name,
                rootKey: `share:${shareId}`,
                driveId,
                rootItemId: rootItem.id,
                addedAt: now,
                updatedAt: now,
            };
            shares = sortByAddedAt([...shares, record]);
            updatedAt = now;
            await saveLocal();
            onChange();
            scheduleOneDriveUploadFireAndForget();
            log(`shares:addFromUrl success shareId=${record.shareId} rootKey=${record.rootKey} driveId=${record.driveId}`);
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
            if (!shares.some((s) => s.id === id)) return;
            shares = shares.filter((s) => s.id !== id);
            updatedAt = Date.now();
            await saveLocal();
            onChange();
            scheduleOneDriveUploadFireAndForget();
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

        getDeniedCount: () => deniedByRootKey.size,
        getDeniedRootKeys: () => new Set(deniedByRootKey.keys()),
        getDeniedReason: (rootKey) => deniedByRootKey.get(rootKey),

        computeRemoveImpact(rootKey, favorites, roots) {
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
                affectedFavoriteCount,
            };
        },
    };
}
