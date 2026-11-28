import { isAbortError, readGraphJson, readGraphText, type AuthFetch, type AuthFetchOptions } from './auth.js';
import { buildIndex, type AccountInfo, type IndexProgress, type MusicDriveItem } from './indexer.js';
import { log, logCatch, logError } from './logger.js';
import { MediaUnavailableError, ProviderHttpError, type BrowserMedia, type PrimaryStore } from './provider.js';

const graph = 'https://graph.microsoft.com/v1.0';
const appRoot = `${graph}/me/drive/special/approot:`;
const folderFields = 'name,id,cTag,eTag,size,lastModifiedDateTime,folder';
const maxUrlLifetimeMs = 60 * 60_000;

/** A namespace belongs to the share link, independently of its current connection record. */
const shareCacheNamespace = (shareId: string): string => 'share-' + encodeURIComponent(shareId);

const appDocumentUrl = (name: string): string => `${appRoot}/${encodeURIComponent(name)}:/content`;

function decodeTempauth(url: string): number | undefined {
    try {
        const tempauth = new URL(url).searchParams.get('tempauth');
        if (!tempauth) return undefined;
        for (const part of tempauth.split('.')) {
            try {
                const normalized = part.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((part.length + 3) % 4);
                const raw = atob(normalized);
                const decoded = decodeURIComponent(raw.split('').map(c => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join(''));
                const obj = JSON.parse(decoded);
                const exp = parseInt(obj?.exp, 10);
                if (!isNaN(exp)) return exp * 1000;
            } catch { continue; }
        }
    } catch { /* invalid URL */ }
    return undefined;
}

function encodeShareUrlToken(url: string): string {
    const b64 = btoa(url).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    return `u!${b64}`;
}

/** Graph responses can contain reusable share links. Only the stage and HTTP status enter diagnostics. */
function logAddFromUrlResponse(step: string, response: Response): void {
    const write = response.ok ? log : logError;
    write(`shares:addFromUrl:${step} status=${response.status}`);
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

/** Bind Graph I/O to the transport for this app document, including native redirect proof. */
export function createOneDriveProvider(
    authFetch: AuthFetch,
    followContent?: (url: string, signal: AbortSignal) => Promise<Response>,
    fetchContent: typeof fetch = (url, init) => fetch(url, init),
) {
    const documents: PrimaryStore = {
        async read(name, signal) {
            const response = await authFetch(appDocumentUrl(name), false, signal ? { signal } : undefined);
            if (response.status === 404) return null;
            if (!response.ok) throw new ProviderHttpError(response.status);
            return readGraphText(response, name.replace(/\.json$/, '') + ':onedrive-load');
        },
        async write(name, text, signal) {
            const response = await authFetch(appDocumentUrl(name), false, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: text,
                ...(signal && { signal }),
            });
            if (!response.ok) throw new ProviderHttpError(response.status);
        },
    };

    /** Resolve a fresh capability with the caller's timeout or cancellation. */
    async function readDownloadUrl(driveId: string, itemId: string, operation: string, options: AuthFetchOptions): Promise<string> {
        const response = await authFetch(
            `${graph}/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}?$select=@microsoft.graph.downloadUrl`,
            false, options,
        );
        options.signal?.throwIfAborted();
        if (!response.ok) throw new ProviderHttpError(response.status);
        const data = await readGraphJson(response, operation);
        options.signal?.throwIfAborted();
        const url = data['@microsoft.graph.downloadUrl'];
        if (!url) throw new MediaUnavailableError('No media URL');
        return url;
    }

    const media: BrowserMedia = {
        async playbackUrl(driveId, itemId) {
            const url = await readDownloadUrl(driveId, itemId, 'playback URL', { timeoutMs: 15_000 });
            const limit = Date.now() + maxUrlLifetimeMs;
            const expiresAt = Math.min(decodeTempauth(url) ?? limit, limit);
            return { url, expiresAt };
        },
        async download(driveId, itemId, signal) {
            const url = await readDownloadUrl(driveId, itemId, 'download URL', { signal });
            // The signed content request uses the CDN capability alone.
            const response = await fetchContent(url, { signal });
            signal.throwIfAborted();
            if (!response.ok) throw new ProviderHttpError(response.status);
            return response.blob();
        },
    };

    return {
        documents,
        media,

        /** A 4xx proves connectivity, including a failed refresh mapped to 400. A 5xx supplies no evidence. */
        async fetchAccountInfo(signal?: AbortSignal): Promise<AccountInfo | 'auth' | 'network'> {
            const response = await authFetch(`${graph}/me/drive?$select=id,owner`, false, { signal });
            if (!response.ok) {
                logError(`fetchAccountInfo: ${response.status} ${response.statusText}`);
                return response.status >= 400 && response.status < 500 ? 'auth' : 'network';
            }
            const data = await readGraphJson(response, 'account details');
            return { driveId: data.id, displayName: data.owner?.user?.displayName ?? 'OneDrive' };
        },

        /** Keep the native account proof on the original response. */
        probeMusicFolder: (signal?: AbortSignal) => authFetch(`${graph}/me/drive/special/music?$select=${folderFields}`, false,
            { cache: 'no-store', signal }), // Recursive size can change without a new folder ETag.
        probeShareRoot: (driveId: string, rootItemId: string, signal?: AbortSignal) => authFetch(
            `${graph}/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(rootItemId)}?$select=${folderFields}`,
            false, { cache: 'no-store', signal }), // Recursive size can change without a new folder ETag.

        /** Run the existing schema-1 builder with the bound batch and redirect transport. */
        buildAndCacheIndex: (item: MusicDriveItem, onProgress: (progress: IndexProgress) => void,
            driveId: string, shareId?: string, signal?: AbortSignal) =>
            buildIndex(item, onProgress, authFetch, driveId,
                shareId === undefined ? 'primary' : shareCacheNamespace(shareId), followContent, signal),

        deleteShareCache: (shareId: string) => authFetch(
            `${appRoot}/${shareCacheNamespace(shareId)}`, false,
            { method: 'DELETE', timeoutMs: 30_000 }),

        /** Retain Graph's redemption preference for identity. The caller checks duplicates and opens its proof ticket before requesting the folder. */
        async readShareIdentity(url: string, signal?: AbortSignal) {
            const token = encodeShareUrlToken(url);

            const metaR = await authFetch(
                `${graph}/shares/${token}?$select=id`,
                false,
                { headers: { Prefer: 'redeemSharingLink' }, signal },
            );
            logAddFromUrlResponse('meta', metaR);
            if (!metaR.ok) {
                throw new Error(await extractGraphErrorMessage(
                    metaR,
                    `Cannot open share URL (${metaR.status})`,
                ));
            }
            const meta = await readGraphJson(metaR, 'share identity').catch(error => {
                if (isAbortError(error)) throw error;
                logCatch('shares:addFromUrl:meta')(error);
                return undefined;
            });
            signal?.throwIfAborted();
            const shareId = typeof meta?.id === 'string' && meta.id ? meta.id : token;
            return { shareId, token };
        },

        /** The final folder response supplies the native access proof for this binding. */
        async redeemShareFolder(token: string, signal?: AbortSignal) {
            const itemR = await authFetch(
                `${graph}/shares/${token}/driveItem?$select=id,name,folder,root,parentReference,createdBy`,
                false,
                { headers: { Prefer: 'redeemSharingLink' }, signal },
            );
            logAddFromUrlResponse('driveItem', itemR);
            if (!itemR.ok) {
                throw new Error(await extractGraphErrorMessage(
                    itemR,
                    `Cannot read shared item (${itemR.status})`,
                ));
            }
            const item = await readGraphJson(itemR, 'share item');
            if (!item?.folder) throw new Error('Only folder shares are supported');

            const driveIdRaw = item.parentReference?.driveId;
            if (typeof driveIdRaw !== 'string' || !driveIdRaw) throw new Error('Share missing driveId');
            const driveId = driveIdRaw;

            let rootItem = item;
            let rootResponse = itemR;
            const isWholeDriveShare = item.root !== undefined && item.root !== null;
            if (isWholeDriveShare) {
                const musicR = await authFetch(
                    `${graph}/drives/${encodeURIComponent(driveId)}/special/music?$select=id,name,folder,createdBy`,
                    false,
                    { signal },
                );
                logAddFromUrlResponse('special-music', musicR);
                if (!musicR.ok) {
                    throw new Error(await extractGraphErrorMessage(
                        musicR,
                        'Whole-drive share must expose Music folder',
                    ));
                }
                rootResponse = musicR;
                rootItem = await readGraphJson(musicR, 'shared music folder');
                if (!rootItem?.folder) throw new Error('Music special folder is not accessible');
            }

            const ownerName = typeof rootItem?.createdBy?.user?.displayName === 'string'
                ? rootItem.createdBy.user.displayName : undefined;
            const name = isWholeDriveShare
                ? (ownerName || rootItem.name || item.name || 'Shared Music')
                : (item.name || 'Shared Music');
            return { driveId, rootItemId: rootItem.id, name, response: rootResponse };
        },
    };
}

export type OneDriveProvider = ReturnType<typeof createOneDriveProvider>;
