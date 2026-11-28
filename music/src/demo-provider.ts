/** The public catalog supplies the same byte identity to download and playback. */
import type { MusicFile, MusicFolder } from './indexer.js';
import { MediaUnavailableError, ProviderHttpError, type BrowserMedia } from './provider.js';

export const DEMO_SOURCE = 'demo';
export const DEMO_INDEX_URL = 'https://ljw1004.github.io/oneplay-test/music/index.json';
const RAW = 'https://raw.githubusercontent.com/ljw1004/oneplay-test/';
const sha = /^[a-f0-9]{40}$/;
type Track = Readonly<{path: string; bytes: number; blob: string}>;
export type DemoManifest = Readonly<{schemaVersion: 1; mediaCommit: string; tracks: readonly Track[]}>;
type DemoRecording = Readonly<{url: string; bytes: number}>;
export type DemoCatalog = Readonly<{
    manifest: DemoManifest;
    folder: MusicFolder;
    recordings: ReadonlyMap<string, DemoRecording>;
    credits: string;
}>;

/** RFC 3986 segment encoding matches Swift and preserves the Git spelling. */
function escapeSegment(segment: string): string {
    return encodeURIComponent(segment).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

/** Validate every track before a snapshot can become a cache or a walkable source. */
export function parseDemoCatalog(value: unknown): DemoCatalog {
    const invalid = () => new Error('Invalid demo catalog');
    if (!value || typeof value !== 'object') throw invalid();
    const {schemaVersion, mediaCommit, tracks} = value as Partial<DemoManifest>;
    if (schemaVersion !== 1 || typeof mediaCommit !== 'string' || !sha.test(mediaCommit)
        || !Array.isArray(tracks) || !tracks.length) throw invalid();
    type Folder = MusicFolder & {children: Record<string, Folder | MusicFile>};
    const folder: Folder = {id: 'folder-', children: Object.create(null)};
    const recordings = new Map<string, DemoRecording>();
    const spellings = new Map<string, string>();
    const base = RAW + mediaCommit + '/';
    const validated: Track[] = [];
    for (const track of tracks) {
        if (!track || typeof track !== 'object') throw invalid();
        const {path, bytes, blob} = track as Track;
        if (typeof path !== 'string' || !/\.mp3$/i.test(path) || /[\\\u0000-\u001f\u007f]/.test(path)
            || typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes <= 0
            || typeof blob !== 'string' || !sha.test(blob)) throw invalid();
        const parts = path.split('/');
        let current = folder;
        let escapedPath = '';
        let original = '';
        for (const [index, part] of parts.entries()) {
            if (!part || part === '.' || part === '..') throw invalid();
            escapedPath += (index ? '/' : '') + escapeSegment(part);
            original += '/' + part;
            const normalized = original.normalize('NFC');
            const prior = spellings.get(normalized);
            if (prior !== undefined && prior !== original) throw invalid();
            spellings.set(normalized, original);
            const child = current.children[part];
            if (index === parts.length - 1) {
                if (child) throw invalid();
                const id = blob + '-' + escapedPath;
                current.children[part] = {id};
                recordings.set(id, {url: base + 'Music/' + escapedPath, bytes});
            } else {
                if (child && !('children' in child)) throw invalid();
                const next: Folder = child ?? {id: 'folder-' + escapedPath, children: Object.create(null)};
                current.children[part] = next;
                current = next;
            }
        }
        validated.push({path, bytes, blob});
    }
    return {manifest: {schemaVersion, mediaCommit, tracks: validated}, folder, recordings, credits: base + 'credits.txt'};
}

/** Load one complete manifest without browser credentials and revalidate any HTTP cache hit. */
export async function fetchDemoCatalog(signal: AbortSignal): Promise<DemoCatalog> {
    const response = await fetch(DEMO_INDEX_URL, {
        credentials: 'omit', cache: 'no-cache', redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    });
    if (response.status !== 200) throw new ProviderHttpError(response.status);
    const text = new TextDecoder('utf-8', {fatal: true}).decode(await response.arrayBuffer());
    return parseDemoCatalog(JSON.parse(text));
}

/** Read immutable recordings with no auth, preserving the normal browser cache key contract. */
export function createDemoMedia(current: () => DemoCatalog | undefined): BrowserMedia {
    function recording(driveId: string, itemId: string): DemoRecording {
        const entry = driveId === DEMO_SOURCE ? current()?.recordings.get(itemId) : undefined;
        if (!entry) throw new MediaUnavailableError('Demo recording is unavailable');
        return entry;
    }
    return {
        async playbackUrl(driveId, itemId) {
            return {url: recording(driveId, itemId).url};
        },
        async download(driveId, itemId, signal) {
            const {url, bytes} = recording(driveId, itemId);
            const response = await fetch(url, {credentials: 'omit', redirect: 'error',
                signal: AbortSignal.any([signal, AbortSignal.timeout(180_000)])});
            if (response.status !== 200) throw new ProviderHttpError(response.status);
            const body = await response.blob();
            if (body.size !== bytes) throw new Error('Demo recording length mismatch');
            return body.type === 'audio/mpeg' ? body : body.slice(0, body.size, 'audio/mpeg');
        },
    };
}
