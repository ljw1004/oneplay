import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    buildFavoritePlaybackStorageValue,
    buildGlobalPlaybackStorageValue,
    computeFirstPlayableIdxAfterReshuffle,
    computeNextIdx,
    computePrevIdx,
    deriveMediaSessionFields,
    getMediaSessionPositionState,
    parseFavoritePlaybackStorageValue,
    parseGlobalPlaybackSave, parseGlobalPlaybackTime,
    pickRestoreCandidate,
    reduceRefreshedTrackList,
    shuffleTrackList,
    PlaybackUrlEngine,
    type PathEquals,
} from '../../src/playback-engine.js';
import { createOneDriveProvider } from '../../src/onedrive-provider.js';
import type { AuthFetchOptions } from '../../src/auth.js';
import { cleanMediaSessionTitle } from '../../src/media-title.js';
import type { FolderPath } from '../../src/tree.js';
import type { PlaybackMode } from '../../src/playback.js';

const path = (name: string): FolderPath => ['OnePlay Music', 'drive', `${name}.mp3`];
const pathEquals: PathEquals = (a, b) => a.length === b.length && a.every((s, i) => s === b[i]);
const alwaysPlayable = (): boolean => true;

const runShuffle = (
    list: readonly FolderPath[],
    currentTrackIdx: number,
    random: () => number,
): { trackList: FolderPath[]; currentTrackIdx: number } =>
    shuffleTrackList({ trackList: list, currentTrackIdx, random });

describe('shuffleTrackList', () => {
    it('moves current track to index 0 and remaps index', () => {
        const a = path('a');
        const b = path('b');
        const c = path('c');
        const d = path('d');
        const result = runShuffle([a, b, c, d], 2, () => 0);
        assert.deepEqual(result.trackList[0], c);
        assert.equal(result.currentTrackIdx, 0);
        assert.equal(result.trackList.length, 4);
        assert.deepEqual(
            [...result.trackList].sort((x, y) => x[2].localeCompare(y[2])),
            [a, b, c, d].sort((x, y) => x[2].localeCompare(y[2])),
        );
    });

    it('keeps current index at -1 when no current track', () => {
        const result = runShuffle([path('a'), path('b')], -1, () => 0.5);
        assert.equal(result.currentTrackIdx, -1);
        assert.equal(result.trackList.length, 2);
    });
});

describe('reduceRefreshedTrackList', () => {
    it('non-shuffle replaces list with fresh canonical order', () => {
        const fresh = [path('a'), path('b')];
        const prev = [path('b'), path('a')];
        const result = reduceRefreshedTrackList({
            freshTrackList: fresh,
            prevTrackList: prev,
            playbackTrack: fresh[1],
            playbackMode: 'all',
            keyOf: path => JSON.stringify(path),
            random: () => 0,
        });
        assert.deepEqual(result.trackList, fresh);
        assert.equal(result.currentTrackIdx, 1);
        assert.equal(result.didReshuffle, false);
    });

    it('shuffle preserves existing order when track set is unchanged', () => {
        const a = path('a');
        const b = path('b');
        const c = path('c');
        const prev = [c, a, b];
        const freshDifferentOrder = [b, c, a];
        const result = reduceRefreshedTrackList({
            freshTrackList: freshDifferentOrder,
            prevTrackList: prev,
            playbackTrack: a,
            playbackMode: 'shuffle',
            keyOf: path => JSON.stringify(path),
            random: () => 0,
        });
        assert.deepEqual(result.trackList, prev);
        assert.equal(result.currentTrackIdx, 1);
        assert.equal(result.didReshuffle, false);
    });

    it('keeps a surviving permutation and remaps every shifted row by occurrence key', () => {
        const old = ['C', 'A', 'B'].map((key, i) => ({key, row: i}));
        const fresh = ['A', 'B', 'C'].map((key, i) => ({key, row: i}));
        const revised = reduceRefreshedTrackList({freshTrackList: fresh, prevTrackList: old, playbackTrack: old[0],
            playbackMode: 'shuffle', keyOf: t => t.key, random: () => { throw Error('unexpected reshuffle'); }});
        assert.deepEqual(revised.trackList, [fresh[2], fresh[0], fresh[1]]);
        assert.equal(revised.currentTrackIdx, 0);
    });

    it('shuffle reshuffles when track set changes', () => {
        const a = path('a');
        const b = path('b');
        const c = path('c');
        const prev = [a, b];
        const fresh = [a, b, c];
        const result = reduceRefreshedTrackList({
            freshTrackList: fresh,
            prevTrackList: prev,
            playbackTrack: b,
            playbackMode: 'shuffle',
            keyOf: path => JSON.stringify(path),
            random: () => 0,
        });
        assert.equal(result.currentTrackIdx, 0);
        assert.equal(result.didReshuffle, true);
        assert.equal(result.trackList.length, 3);
    });
});

describe('navigation decisions', () => {
    const list = [path('a'), path('b'), path('c')];

    it('computePrevIdx wraps only in repeat/shuffle', () => {
        assert.equal(computePrevIdx('all', 1, list, alwaysPlayable), 0);
        assert.equal(computePrevIdx('one', 0, list, alwaysPlayable), undefined);
        assert.equal(computePrevIdx('repeat', 0, list, alwaysPlayable), 2);
        assert.equal(computePrevIdx('shuffle', 0, list, alwaysPlayable), 2);
    });

    it('computeNextIdx follows mode rules', () => {
        const cases: Array<{ mode: PlaybackMode; expected: number | undefined }> = [
            { mode: 'one', expected: undefined },
            { mode: 'all', expected: 1 },
            { mode: 'timer', expected: 1 },
            { mode: 'shuffle', expected: 1 },
            { mode: 'repeat', expected: 1 },
        ];
        for (const c of cases) {
            assert.equal(computeNextIdx(c.mode, 0, list, alwaysPlayable), c.expected);
        }
        assert.equal(computeNextIdx('repeat', 2, list, alwaysPlayable), 0);
    });

    it('computeFirstPlayableIdxAfterReshuffle prefers successor then falls back to first', () => {
        const onlyFirstPlayable = (p: FolderPath): boolean => p[2] === 'a.mp3';
        const onlyThirdPlayable = (p: FolderPath): boolean => p[2] === 'c.mp3';
        assert.equal(computeFirstPlayableIdxAfterReshuffle(list, onlyThirdPlayable), 2);
        assert.equal(computeFirstPlayableIdxAfterReshuffle(list, onlyFirstPlayable), 0);
    });
});

describe('favorite playback persistence helpers', () => {
    it('build+parse roundtrips favorite payload', () => {
        const value = buildFavoritePlaybackStorageValue(path('song'), 42);
        const parsed = parseFavoritePlaybackStorageValue(value);
        assert.deepEqual(parsed, { track: path('song'), time: 42 });
    });

    it('parse handles missing/corrupt payloads', () => {
        assert.equal(parseFavoritePlaybackStorageValue(null), undefined);
        assert.equal(parseFavoritePlaybackStorageValue('{bad json}'), undefined);
        assert.equal(parseFavoritePlaybackStorageValue(JSON.stringify({ track: 'bad', time: 3 })), undefined);
        assert.deepEqual(
            parseFavoritePlaybackStorageValue(JSON.stringify({ track: path('song'), time: -5 })),
            { track: path('song'), time: 0 },
        );
    });

    it('binds the time checkpoint to a single play of an occurrence', () => {
        const legacy = {folder: path('folder'), track: path('a'), mode: 'repeat'};
        const saved = {...legacy, key: 'A', folderKey: 'album', generation: 'play-2'};
        assert.equal(parseGlobalPlaybackTime('13.5', parseGlobalPlaybackSave(legacy)), 13.5);
        assert.equal(parseGlobalPlaybackTime('13.5', parseGlobalPlaybackSave(saved)), 0);
        assert.equal(parseGlobalPlaybackTime('{"generation":"play-1","time":41}', saved), 0);
        assert.equal(parseGlobalPlaybackTime('{"generation":"play-2","time":4.5}', saved), 4.5);
        assert.equal(parseGlobalPlaybackSave({...saved, held: {entry: null}}), undefined);
        assert.equal(parseGlobalPlaybackSave({...saved, folderKey: ''}), undefined);
    });

    it('pickRestoreCandidate validates membership/playability and clamps time', () => {
        const list = [path('a'), path('b')];
        const playableOnlyA = (p: FolderPath): boolean => p[2] === 'a.mp3';
        assert.deepEqual(
            pickRestoreCandidate(list, path('a'), 15, pathEquals, playableOnlyA),
            { idx: 0, time: 15 },
        );
        assert.deepEqual(
            pickRestoreCandidate(list, path('a'), -3, pathEquals, playableOnlyA),
            { idx: 0, time: 0 },
        );
        assert.equal(pickRestoreCandidate(list, path('b'), 10, pathEquals, playableOnlyA), undefined);
        assert.equal(pickRestoreCandidate(list, path('z'), 10, pathEquals, alwaysPlayable), undefined);
    });

    it('buildGlobalPlaybackStorageValue serializes expected shape', () => {
        const raw = buildGlobalPlaybackStorageValue(path('folder'), path('track'), 'repeat', 'fav-1');
        const parsed = JSON.parse(raw) as {
            folder: FolderPath;
            track: FolderPath;
            mode: PlaybackMode;
            favId?: string;
        };
        assert.deepEqual(parsed.folder, path('folder'));
        assert.deepEqual(parsed.track, path('track'));
        assert.equal(parsed.mode, 'repeat');
        assert.equal(parsed.favId, 'fav-1');
    });
});

describe('media session helpers', () => {
    it('deriveMediaSessionFields computes title from filename+album', () => {
        const fields = deriveMediaSessionFields('Track.mp3', 'Album');
        assert.equal(fields.filename, 'Track.mp3');
        assert.equal(fields.album, 'Album');
        assert.equal(fields.title, cleanMediaSessionTitle('Track.mp3', 'Album'));
    });

    it('getMediaSessionPositionState clamps and validates values', () => {
        assert.deepEqual(getMediaSessionPositionState(10, 12, 1), {
            duration: 10,
            position: 10,
            playbackRate: 1,
        });
        assert.deepEqual(getMediaSessionPositionState(10, -5, 1), {
            duration: 10,
            position: 0,
            playbackRate: 1,
        });
        assert.equal(getMediaSessionPositionState(NaN, 2, 1), undefined);
        assert.equal(getMediaSessionPositionState(10, 2, 0), undefined);
    });
});

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}

describe('browser playback URL renewal', () => {
    it('shares one lookup through body decoding and returns a ready successor synchronously', async () => {
        const entered = deferred<void>();
        const body = deferred<string>();
        const mediaUrl = 'https://audio.example/next.mp3';
        const calls: Array<{ retry: boolean; options?: AuthFetchOptions }> = [];
        const provider = createOneDriveProvider(async (_url, retry, options) => {
            calls.push({ retry, options });
            const response = new Response();
            response.text = () => { entered.resolve(); return body.promise; };
            return response;
        });
        const engine = new PlaybackUrlEngine(provider.media.playbackUrl);
        const initial = engine.getTrackUrl('drive', 'item');
        assert.equal(initial.type, 'promise');
        await entered.promise;
        assert.deepEqual(engine.getTrackUrl('drive', 'item'), initial);
        assert.deepEqual(calls, [{ retry: false, options: { timeoutMs: 15_000 } }]);
        body.resolve(JSON.stringify({ '@microsoft.graph.downloadUrl': mediaUrl }));
        assert.equal(await initial.promise, mediaUrl);
        assert.equal(engine.getCachedTrackUrl('drive', 'item'), mediaUrl);
        assert.deepEqual(engine.getTrackUrl('drive', 'item'), { type: 'value', value: mediaUrl });
    });

    it('retries after a provider throws before returning a promise', async () => {
        const mediaUrl = 'https://audio.example/next.mp3';
        let calls = 0;
        const engine = new PlaybackUrlEngine(() => {
            if (++calls === 1) throw new Error('Lookup unavailable');
            return Promise.resolve({ url: mediaUrl });
        });
        const first = engine.getTrackUrl('drive', 'item');
        assert.equal(first.type, 'promise');
        assert.equal(await first.promise, undefined);
        const second = engine.getTrackUrl('drive', 'item');
        assert.equal(second.type, 'promise');
        assert.equal(await second.promise, mediaUrl);
    });

    it('renews a near-expiry URL while preserving it on failure and clearing it on confirmed absence', async () => {
        const exp = Math.floor((Date.now() + 60_000) / 1000);
        const mediaUrl = 'https://audio.example/next.mp3?tempauth=' + btoa(JSON.stringify({ exp }));
        let calls = 0;
        let renewed = deferred<Response>();
        const provider = createOneDriveProvider(async () => ++calls === 1
            ? Response.json({ '@microsoft.graph.downloadUrl': mediaUrl }) : renewed.promise);
        const engine = new PlaybackUrlEngine(provider.media.playbackUrl);
        const initial = engine.getTrackUrl('drive', 'item');
        assert.equal(initial.type, 'promise');
        assert.equal(await initial.promise, mediaUrl);
        for (const result of [new Response(null, { status: 503 }), Response.json({})]) {
            assert.deepEqual(engine.getTrackUrl('drive', 'item'), { type: 'value', value: mediaUrl });
            assert.deepEqual(engine.getTrackUrl('drive', 'item'), { type: 'value', value: mediaUrl });
            renewed.resolve(result);
            // Drain the lookup and Response body microtasks before observing the ready cache.
            await new Promise<void>(resolve => setImmediate(resolve));
            assert.equal(engine.getCachedTrackUrl('drive', 'item'), result.ok ? undefined : mediaUrl);
            renewed = deferred<Response>();
        }
        assert.equal(calls, 3);
    });
});
