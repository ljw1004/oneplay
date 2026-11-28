/** Remote app documents. Only a confirmed absence is returned as null. */
export interface PrimaryStore {
    read(name: string, signal?: AbortSignal): Promise<string | null>;
    write(name: string, text: string, signal?: AbortSignal): Promise<void>;
}

/** Media access for HTML audio and the browser's complete-file cache. */
export interface BrowserMedia {
    /** expiresAt is an absolute timestamp in epoch milliseconds. */
    playbackUrl(driveId: string, itemId: string): Promise<Readonly<{ url: string; expiresAt?: number }>>;
    download(driveId: string, itemId: string, signal: AbortSignal): Promise<Blob>;
}

/** Preserve the transport status for the caller's retry and evidence policy. */
export class ProviderHttpError extends Error {
    constructor(readonly status: number, message = 'HTTP ' + status) {
        super(message);
    }
}

/** The provider responded successfully but supplied no playable URL. */
export class MediaUnavailableError extends Error {}
export class MediaTransientError extends Error {}

/** App-folder reads return HTTP 200. Keep payload text out of diagnostics. */
export function parsePrimaryDocument(text: string, operation: string): unknown {
    try { return JSON.parse(text); }
    catch { throw new Error(operation + ': invalid JSON status=200'); }
}
