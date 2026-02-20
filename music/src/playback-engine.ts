/**
 * Playback policy and URL/prefetch engine.
 *
 * Scope:
 * - Pure playback policy helpers (playability/index selection/timer conversions).
 * - MediaSession field/position derivation helpers.
 * - Download URL cache + near-end prefetch state machine.
 *
 * Non-scope:
 * - DOM rendering/gesture handling (owned by playback-ui.ts).
 * - Audio element event wiring and app-level side-effect orchestration
 *   (owned by playback.ts).
 */
import { type FolderPath } from './tree.js';
import { log, logError, errorDetail } from './logger.js';
import { type AuthFetch, type EvidenceState } from './auth.js';
import { type PlaybackMode } from './playback.js';
import { type TimerDuration } from './settings.js';
import { cleanMediaSessionTitle } from './media-title.js';

export type SyncPromise<T> = { type: 'value'; value: T } | { type: 'promise'; promise: Promise<T> };

export type PathEquals = (a: FolderPath, b: FolderPath) => boolean;

type UrlCacheEntry = {
    sync: { expiration: number; url: string } | undefined;
    async: { counter: number; promise: Promise<string | undefined> } | undefined;
};

export async function fetchDownloadUrl(
    driveId: string,
    itemId: string,
    authFetch: AuthFetch,
): Promise<string | undefined> {
    const r = await authFetch(
        `https://graph.microsoft.com/v1.0/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}?$select=@microsoft.graph.downloadUrl`,
        false,
    );
    if (!r.ok) {
        logError(`fetchDownloadUrl: ${r.status}`);
        return undefined;
    }
    const data = await r.json();
    return data['@microsoft.graph.downloadUrl'];
}

export const timerDurationMs = (duration: TimerDuration): number | undefined => {
    switch (duration) {
        case '15m': return 15 * 60_000;
        case '30m': return 30 * 60_000;
        case '45m': return 45 * 60_000;
        case '60m': return 60 * 60_000;
        case 'end-of-track': return undefined;
    }
};

export const inTerminalEvidenceState = (evidenceState: EvidenceState): boolean =>
    evidenceState === 'evidence:signed-out' || evidenceState === 'evidence:not-online';

export const isTrackPlayableNow = (
    path: FolderPath,
    evidenceState: EvidenceState,
    isTrackCached: (path: FolderPath) => boolean,
    isTrackBlocked: (path: FolderPath) => boolean,
): boolean =>
    !isTrackBlocked(path) && (!inTerminalEvidenceState(evidenceState) || isTrackCached(path));

export const findFirstPlayableIdxIn = (
    list: readonly FolderPath[],
    isPlayable: (path: FolderPath) => boolean,
): number | undefined => {
    for (let i = 0; i < list.length; i++) {
        if (isPlayable(list[i])) return i;
    }
    return undefined;
};

export const findLastPlayableIdxIn = (
    list: readonly FolderPath[],
    isPlayable: (path: FolderPath) => boolean,
): number | undefined => {
    for (let i = list.length - 1; i >= 0; i--) {
        if (isPlayable(list[i])) return i;
    }
    return undefined;
};

export const findNextPlayableIdxAfter = (
    list: readonly FolderPath[],
    idx: number,
    isPlayable: (path: FolderPath) => boolean,
): number | undefined => {
    for (let i = Math.max(0, idx + 1); i < list.length; i++) {
        if (isPlayable(list[i])) return i;
    }
    return undefined;
};

export const findPrevPlayableIdxBefore = (
    list: readonly FolderPath[],
    idx: number,
    isPlayable: (path: FolderPath) => boolean,
): number | undefined => {
    for (let i = Math.min(list.length - 1, idx - 1); i >= 0; i--) {
        if (isPlayable(list[i])) return i;
    }
    return undefined;
};

export const findNextPlayableIdxWrapped = (
    list: readonly FolderPath[],
    idx: number,
    isPlayable: (path: FolderPath) => boolean,
): number | undefined => {
    if (list.length === 0) return undefined;
    if (idx < 0) return findFirstPlayableIdxIn(list, isPlayable);
    for (let step = 1; step <= list.length; step++) {
        const i = (idx + step) % list.length;
        if (isPlayable(list[i])) return i;
    }
    return undefined;
};

export const findPrevPlayableIdxWrapped = (
    list: readonly FolderPath[],
    idx: number,
    isPlayable: (path: FolderPath) => boolean,
): number | undefined => {
    if (list.length === 0) return undefined;
    if (idx < 0) return findLastPlayableIdxIn(list, isPlayable);
    for (let step = 1; step <= list.length; step++) {
        const i = (idx - step + list.length * 2) % list.length;
        if (isPlayable(list[i])) return i;
    }
    return undefined;
};

export const computeNextIdx = (
    mode: PlaybackMode,
    currentTrackIdx: number,
    trackList: readonly FolderPath[],
    isPlayable: (path: FolderPath) => boolean,
): number | undefined => {
    switch (mode) {
        case 'one': return undefined;
        case 'timer':
            return findNextPlayableIdxAfter(trackList, currentTrackIdx, isPlayable);
        case 'shuffle':
            return findNextPlayableIdxAfter(trackList, currentTrackIdx, isPlayable);
        case 'repeat':
            return findNextPlayableIdxWrapped(trackList, currentTrackIdx, isPlayable);
        case 'all':
        default:
            return findNextPlayableIdxAfter(trackList, currentTrackIdx, isPlayable);
    }
};

export const computePrevIdx = (
    mode: PlaybackMode,
    currentTrackIdx: number,
    trackList: readonly FolderPath[],
    isPlayable: (path: FolderPath) => boolean,
): number | undefined =>
    mode === 'shuffle' || mode === 'repeat'
        ? findPrevPlayableIdxWrapped(trackList, currentTrackIdx, isPlayable)
        : findPrevPlayableIdxBefore(trackList, currentTrackIdx, isPlayable);

export const computeFirstPlayableIdxAfterReshuffle = (
    trackList: readonly FolderPath[],
    isPlayable: (path: FolderPath) => boolean,
): number | undefined =>
    findNextPlayableIdxAfter(trackList, 0, isPlayable) ?? findFirstPlayableIdxIn(trackList, isPlayable);

export type ShuffleResult = {
    trackList: FolderPath[];
    currentTrackIdx: number;
};

interface ShuffleArgs {
    trackList: readonly FolderPath[];
    currentTrackIdx: number;
    random: () => number;
}

export const shuffleTrackList = ({
    trackList, currentTrackIdx, random,
}: ShuffleArgs): ShuffleResult => {
    const next = [...trackList];
    if (next.length <= 1) return { trackList: next, currentTrackIdx };

    const validCurrentIdx = currentTrackIdx >= 0 && currentTrackIdx < next.length
        ? currentTrackIdx
        : -1;
    if (validCurrentIdx > 0) {
        [next[0], next[validCurrentIdx]] = [next[validCurrentIdx], next[0]];
    }
    const start = validCurrentIdx >= 0 ? 1 : 0;
    for (let i = next.length - 1; i > start; i--) {
        const j = start + Math.floor(random() * (i - start + 1));
        [next[i], next[j]] = [next[j], next[i]];
    }
    return {
        trackList: next,
        currentTrackIdx: validCurrentIdx >= 0 ? 0 : -1,
    };
};

const didTrackSetChange = (
    freshTrackList: readonly FolderPath[],
    prevTrackList: readonly FolderPath[],
    pathEquals: PathEquals,
): boolean =>
    freshTrackList.length !== prevTrackList.length
    || freshTrackList.some(path => !prevTrackList.some(candidate => pathEquals(candidate, path)));

export interface RefreshTrackListArgs {
    freshTrackList: readonly FolderPath[];
    prevTrackList: readonly FolderPath[];
    playbackTrack: FolderPath | undefined;
    playbackMode: PlaybackMode;
    pathEquals: PathEquals;
    random: () => number;
}

export interface RefreshTrackListResult {
    trackList: FolderPath[];
    currentTrackIdx: number;
    didReshuffle: boolean;
}

export const reduceRefreshedTrackList = ({
    freshTrackList,
    prevTrackList,
    playbackTrack,
    playbackMode,
    pathEquals,
    random,
}: RefreshTrackListArgs): RefreshTrackListResult => {
    const currentTrackIdxFor = (list: readonly FolderPath[]): number =>
        playbackTrack ? list.findIndex(path => pathEquals(path, playbackTrack)) : -1;

    if (playbackMode !== 'shuffle') {
        const trackList = [...freshTrackList];
        return {
            trackList,
            currentTrackIdx: currentTrackIdxFor(trackList),
            didReshuffle: false,
        };
    }

    if (!didTrackSetChange(freshTrackList, prevTrackList, pathEquals)) {
        const trackList = [...prevTrackList];
        return {
            trackList,
            currentTrackIdx: currentTrackIdxFor(trackList),
            didReshuffle: false,
        };
    }

    const shuffled = shuffleTrackList({
        trackList: freshTrackList,
        currentTrackIdx: currentTrackIdxFor(freshTrackList),
        random,
    });
    return {
        trackList: shuffled.trackList,
        currentTrackIdx: shuffled.currentTrackIdx,
        didReshuffle: true,
    };
};

export interface FavoritePlaybackSave {
    track: FolderPath;
    time: number;
}

export const buildFavoritePlaybackStorageValue = (
    track: FolderPath,
    time: number,
): string => JSON.stringify({ track, time });

const parseFolderPathArray = (value: unknown): FolderPath | undefined =>
    Array.isArray(value) && value.every(part => typeof part === 'string')
        ? value as FolderPath
        : undefined;

export const parseFavoritePlaybackStorageValue = (
    raw: string | null,
): FavoritePlaybackSave | undefined => {
    if (!raw) return undefined;
    try {
        const parsed = JSON.parse(raw) as { track?: unknown; time?: unknown };
        const track = parseFolderPathArray(parsed.track);
        if (!track) return undefined;
        const time = typeof parsed.time === 'number' && Number.isFinite(parsed.time) && parsed.time > 0
            ? parsed.time
            : 0;
        return { track, time };
    } catch {
        return undefined;
    }
};

export const pickRestoreCandidate = (
    trackList: readonly FolderPath[],
    savedTrack: FolderPath | undefined,
    savedTime: number | undefined,
    pathEquals: PathEquals,
    isPlayable: (path: FolderPath) => boolean,
): { idx: number; time: number } | undefined => {
    if (!savedTrack) return undefined;
    const idx = trackList.findIndex(path => pathEquals(path, savedTrack));
    if (idx < 0 || !isPlayable(trackList[idx])) return undefined;
    const time = typeof savedTime === 'number' && Number.isFinite(savedTime) && savedTime > 0 ? savedTime : 0;
    return { idx, time };
};

export const buildGlobalPlaybackStorageValue = (
    folder: FolderPath,
    track: FolderPath,
    mode: PlaybackMode,
    favId: string | undefined,
): string => JSON.stringify({ folder, track, mode, favId });

export type MediaSessionFields = { filename: string; album: string; title: string };

export const deriveMediaSessionFields = (
    filename: string,
    album: string,
): MediaSessionFields => ({
    filename,
    album,
    title: cleanMediaSessionTitle(filename, album),
});

export type MediaSessionPositionStatePayload = {
    duration: number;
    position: number;
    playbackRate: number;
};

export const getMediaSessionPositionState = (
    duration: number,
    currentTime: number,
    playbackRate: number,
): MediaSessionPositionStatePayload | undefined => {
    if (!(Number.isFinite(duration) && duration > 0)) return undefined;
    if (!Number.isFinite(currentTime)) return undefined;
    if (!(Number.isFinite(playbackRate) && playbackRate > 0)) return undefined;
    return {
        duration,
        position: Math.max(0, Math.min(currentTime, duration)),
        playbackRate,
    };
};

interface PrefetchArgs {
    readonly asyncCounter: number;
    readonly getNextPath: () => FolderPath | undefined;
    readonly resolveTrackIds: (path: FolderPath) => { driveId: string; itemId: string } | undefined;
    readonly getOfflineBlob: (driveId: string, itemId: string) => Promise<Blob | undefined>;
}

export class PlaybackUrlEngine {
    private static readonly MAX_URL_LIFETIME_MS = 60 * 60_000;
    private static readonly NEAR_EXPIRY_MS = 2 * 60_000;
    private readonly urlCache = new Map<string, UrlCacheEntry>();
    private urlCacheCounter = 0;
    private prefetchedNextPath: FolderPath | undefined;
    private prefetchedNextBlobUrl: string | undefined;
    private nearEndFired = false;
    private prefetchGeneration = 0;
    private currentBlobUrl: string | undefined;

    public constructor(private readonly authFetch: AuthFetch) {}

    public getTrackUrl(driveId: string, itemId: string): SyncPromise<string | undefined> {
        const key = `${driveId}:${itemId}`;
        const now = Date.now();
        const entry = this.urlCache.get(key) ?? { sync: undefined, async: undefined };

        if (entry.sync && entry.sync.expiration > now) {
            if (entry.async === undefined && entry.sync.expiration - PlaybackUrlEngine.NEAR_EXPIRY_MS < now) {
                log(`getTrackUrl: near-expiry refresh for ${itemId.slice(0, 8)}`);
                this.kickOffFetch(key, driveId, itemId, entry);
            }
            return { type: 'value', value: entry.sync.url };
        }

        if (entry.async) return { type: 'promise', promise: entry.async.promise };

        log(`getTrackUrl: cache miss for ${itemId.slice(0, 8)}`);
        for (const [k, e] of this.urlCache) {
            if (e.sync && e.sync.expiration < now) e.sync = undefined;
            if (!e.sync && !e.async) this.urlCache.delete(k);
        }
        return { type: 'promise', promise: this.kickOffFetch(key, driveId, itemId, entry) };
    }

    public setCurrentBlobUrl(url: string | undefined): void {
        this.currentBlobUrl = url;
    }

    public revokeCurrentBlobUrl(): void {
        if (!this.currentBlobUrl) return;
        URL.revokeObjectURL(this.currentBlobUrl);
        this.currentBlobUrl = undefined;
    }

    public clearPrefetchState(): void {
        if (this.prefetchedNextBlobUrl) {
            URL.revokeObjectURL(this.prefetchedNextBlobUrl);
            this.prefetchedNextBlobUrl = undefined;
        }
        this.prefetchedNextPath = undefined;
        this.nearEndFired = false;
    }

    public consumePrefetchedBlobUrlForPath(
        path: FolderPath,
        pathEquals: (a: FolderPath, b: FolderPath) => boolean,
    ): string | undefined {
        if (!this.prefetchedNextBlobUrl || !this.prefetchedNextPath || !pathEquals(this.prefetchedNextPath, path)) {
            return undefined;
        }
        const url = this.prefetchedNextBlobUrl;
        this.prefetchedNextBlobUrl = undefined;
        return url;
    }

    public maybePrefetchNearEnd(currentTime: number, duration: number, args: PrefetchArgs): void {
        if (this.nearEndFired || duration <= 0 || currentTime < duration - 60) return;
        this.nearEndFired = true;
        this.prefetchNextTrackFireAndForget(args);
    }

    private decodeTempauth(url: string): number | undefined {
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

    private kickOffFetch(key: string, driveId: string, itemId: string, entry: UrlCacheEntry): Promise<string | undefined> {
        const counter = this.urlCacheCounter++;
        const promise = (async (): Promise<string | undefined> => {
            try {
                const r = await this.authFetch(
                    `https://graph.microsoft.com/v1.0/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}?$select=@microsoft.graph.downloadUrl`,
                    false,
                    { timeoutMs: 15_000 },
                );
                const entry2 = this.urlCache.get(key) ?? { sync: undefined, async: undefined };
                if (entry2.async?.counter !== counter) return undefined;
                entry2.async = undefined;
                if (!r.ok) {
                    logError(`getTrackUrl fetch failed: ${r.status}`);
                    this.urlCache.set(key, entry2);
                    return undefined;
                }
                const data = await r.json();
                const url: string = data['@microsoft.graph.downloadUrl'];
                const now = Date.now();
                const parsedExpiry = this.decodeTempauth(url);
                const expiration = parsedExpiry !== undefined
                    ? Math.min(parsedExpiry, now + PlaybackUrlEngine.MAX_URL_LIFETIME_MS)
                    : now + PlaybackUrlEngine.MAX_URL_LIFETIME_MS;
                entry2.sync = { expiration, url };
                this.urlCache.set(key, entry2);
                return url;
            } catch (e) {
                const entry2 = this.urlCache.get(key) ?? { sync: undefined, async: undefined };
                if (entry2.async?.counter === counter) entry2.async = undefined;
                this.urlCache.set(key, entry2);
                logError(`getTrackUrl fetch error: ${errorDetail(e)}`);
                return undefined;
            }
        })();
        entry.async = { counter, promise };
        this.urlCache.set(key, entry);
        return promise;
    }

    private prefetchNextTrackFireAndForget(args: PrefetchArgs): void {
        const generation = args.asyncCounter;
        this.prefetchGeneration = generation;
        (async () => {
            const nextPath = args.getNextPath();
            if (!nextPath) return;
            const ids = args.resolveTrackIds(nextPath);
            if (!ids) return;

            log(`prefetch: starting for ${nextPath[nextPath.length - 1]}`);
            const offlineBlob = await args.getOfflineBlob(ids.driveId, ids.itemId);
            if (this.prefetchGeneration !== generation) return;

            if (offlineBlob) {
                this.prefetchedNextBlobUrl = URL.createObjectURL(offlineBlob);
                this.prefetchedNextPath = nextPath;
                log('prefetch: blob URL created from offline cache');
                return;
            }

            const result = this.getTrackUrl(ids.driveId, ids.itemId);
            if (result.type === 'promise') {
                await result.promise;
                if (this.prefetchGeneration !== generation) return;
            }
            this.prefetchedNextPath = nextPath;
            log(`prefetch: URL cache warmed (${result.type})`);
        })().catch((e) => {
            logError(`prefetch error: ${errorDetail(e)}`);
        });
    }
}
