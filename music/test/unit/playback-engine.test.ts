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
    pickRestoreCandidate,
    reduceRefreshedTrackList,
    shuffleTrackList,
    type PathEquals,
} from '../../src/playback-engine.js';
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
            pathEquals,
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
            pathEquals,
            random: () => 0,
        });
        assert.deepEqual(result.trackList, prev);
        assert.equal(result.currentTrackIdx, 1);
        assert.equal(result.didReshuffle, false);
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
            pathEquals,
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
