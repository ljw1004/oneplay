/**
 * Unit tests for search.ts (M15).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    runSearchSingleWalk,
    runSearchIncrementalRefinement,
    isIncrementalRefinement,
} from '../../src/search.js';
import {
    createFavorites,
    type Favorite,
    type Favorites,
    type FavoritesDeps,
    type ItemRef,
    type Playlist,
    type PlaylistMember,
    type RootsMap,
} from '../../src/favorites.js';
import { type EvidenceState } from '../../src/auth.js';
import { type AccountInfo, type MusicFolder } from '../../src/indexer.js';

const MAIN_DRIVE = 'drive-main';
const SHARE_DRIVE = 'drive-share';

const sinkDeps: FavoritesDeps = {
    authFetch() { return Promise.reject(new Error('no network')); },
    dbGet() { throw new Error('unexpected dbGet'); },
    dbPut() { return Promise.resolve(); },
};

const accountInfo = (driveId: string): AccountInfo => ({ driveId, displayName: driveId });

function buildMainFolder(): MusicFolder {
    return {
        id: 'root-main',
        children: {
            Classical: {
                id: 'f-classical',
                children: {
                    'Symphony No. 9.mp3': { id: 't-sym9' },
                    'Symphony No. 5.mp3': { id: 't-sym5' },
                },
            },
            Rock: {
                id: 'f-rock',
                children: {
                    'Song One.mp3': { id: 't-song1' },
                    'Song Two.mp3': { id: 't-song2' },
                },
            },
            MixFolder: {
                id: 'f-mix',
                children: {
                    'Mix Song.mp3': { id: 't-mix-song' },
                },
            },
        },
    };
}

function buildShareFolder(driveId = SHARE_DRIVE): MusicFolder {
    return {
        id: `root-share-${driveId}`,
        children: {
            Shared: {
                id: 'f-shared',
                children: {
                    'Shared Song.mp3': { id: 't-shared-song' },
                },
            },
        },
    };
}

function buildRoots(options?: {
    shareKey?: string;
    shareDriveId?: string;
    shareFolder?: MusicFolder;
}): RootsMap {
    const shareKey = options?.shareKey ?? 'share:one';
    const shareDriveId = options?.shareDriveId ?? SHARE_DRIVE;
    const shareFolder = options?.shareFolder ?? buildShareFolder(shareDriveId);
    const roots: RootsMap = new Map();
    roots.set(MAIN_DRIVE, {
        type: 'onedrive',
        key: MAIN_DRIVE,
        name: 'OneDrive',
        folder: buildMainFolder(),
        info: accountInfo(MAIN_DRIVE),
        reindexing: false,
    });
    roots.set(shareKey, {
        type: 'share',
        key: shareKey,
        name: 'Shared',
        driveId: shareDriveId,
        folder: shareFolder,
        reindexing: false,
    });
    return roots;
}

function itemRef(
    driveId: string,
    itemId: string,
    path: readonly string[],
    isFolder: boolean,
    sourceRootKey?: string,
): ItemRef {
    return { driveId, itemId, path, isFolder, sourceRootKey };
}

async function makeFavorites(seed: readonly Favorite[]): Promise<Favorites> {
    const favorites = createFavorites(sinkDeps, () => {});
    for (const fav of seed) await favorites.add(fav);
    return favorites;
}

function runSearch(
    roots: RootsMap,
    favorites: Favorites,
    query: string,
    options?: {
        maxResults?: number;
        deniedRootKeys?: ReadonlySet<string>;
        evidenceState?: EvidenceState;
        downloadedTrackKeys?: ReadonlySet<string>;
    },
) {
    return runSearchSingleWalk({
        roots,
        favorites,
        query,
        maxResults: options?.maxResults ?? 500,
        deniedRootKeys: options?.deniedRootKeys ?? new Set<string>(),
        evidenceState: options?.evidenceState ?? 'evidence:signed-in',
        downloadedTrackKeys: options?.downloadedTrackKeys ?? new Set<string>(),
    });
}

describe('runSearchSingleWalk', () => {
    it('returns zero results for empty query', async () => {
        const roots = buildRoots();
        const favorites = await makeFavorites([]);
        const result = runSearch(roots, favorites, '   ');

        assert.equal(result.results.length, 0);
        assert.equal(result.capped, false);
    });

    it('matches case-insensitive multi-term substrings with AND semantics', async () => {
        const roots = buildRoots();
        const favorites = await makeFavorites([]);
        const result = runSearch(roots, favorites, 'sYm 9');

        const names = result.results.filter((r) => r.kind === 'track').map((r) => r.name);
        assert(names.includes('Symphony No. 9.mp3'));
        assert(!names.includes('Symphony No. 5.mp3'));
    });

    it('hard-stops at the global maxResults cap', async () => {
        const manyChildren: Record<string, { id: string }> = {};
        for (let i = 0; i < 20; i++) manyChildren[`Song ${i}.mp3`] = { id: `t-many-${i}` };
        const roots: RootsMap = new Map();
        roots.set(MAIN_DRIVE, {
            type: 'onedrive',
            key: MAIN_DRIVE,
            name: 'OneDrive',
            folder: { id: 'root-many', children: { Many: { id: 'f-many', children: manyChildren } } },
            info: accountInfo(MAIN_DRIVE),
            reindexing: false,
        });

        const favorites = await makeFavorites([]);
        const result = runSearch(roots, favorites, 'song', { maxResults: 3 });

        assert.equal(result.results.length, 3);
        assert.equal(result.capped, true);
    });

    it('dedups physical tracks/folders globally and keeps first accepted encounter', async () => {
        const roots = buildRoots();
        const favorites = await makeFavorites([{
            kind: 'playlist',
            id: 'pl-rock',
            name: 'Rock Mix',
            members: [itemRef(MAIN_DRIVE, 'f-rock', ['Rock'], true)],
            hasPrivatePlayback: false,
        } as Playlist]);

        const result = runSearch(roots, favorites, 'song one');
        const trackHits = result.results.filter((r) => r.kind === 'track');

        assert.equal(trackHits.length, 1);
        assert.equal(trackHits[0].path[1], 'fav:pl-rock');
    });

    it('excluded matches do not consume dedup keys', async () => {
        const sharedCarryFolder: MusicFolder = {
            id: 'root-carry',
            children: {
                Main: {
                    id: 'f-main-carry',
                    children: {
                        'Carry Song.mp3': { id: 't-carry' },
                    },
                },
            },
        };
        const blockedCarryFolder: MusicFolder = {
            id: 'root-blocked-carry',
            children: {
                Blocked: {
                    id: 'f-blocked-carry',
                    children: {
                        'Carry Song.mp3': { id: 't-carry' },
                    },
                },
            },
        };
        const roots = buildRoots({
            shareKey: 'share:blocked',
            shareDriveId: MAIN_DRIVE,
            shareFolder: blockedCarryFolder,
        });
        roots.set(MAIN_DRIVE, {
            type: 'onedrive',
            key: MAIN_DRIVE,
            name: 'OneDrive',
            folder: sharedCarryFolder,
            info: accountInfo(MAIN_DRIVE),
            reindexing: false,
        });

        const favorites = await makeFavorites([{
            kind: 'playlist',
            id: 'pl-denied-carry',
            name: 'Denied Carry',
            members: [itemRef(MAIN_DRIVE, 't-carry', ['Blocked', 'Carry Song.mp3'], false, 'share:blocked')],
            hasPrivatePlayback: false,
        } as Playlist]);

        const result = runSearch(roots, favorites, 'carry', {
            deniedRootKeys: new Set(['share:blocked']),
        });

        const tracks = result.results.filter((r) => r.kind === 'track');
        assert.equal(tracks.length, 1);
        assert.deepEqual(tracks[0].path, ['OnePlay Music', MAIN_DRIVE, 'Main', 'Carry Song.mp3']);
    });

    it('skips denied share roots and favorites referencing denied shares', async () => {
        const roots = buildRoots({ shareKey: 'share:denied' });
        const favorites = await makeFavorites([{
            kind: 'shortcut',
            id: 'sc-shared',
            name: 'Shared Shortcut',
            target: itemRef(SHARE_DRIVE, 'f-shared', ['Shared'], true, 'share:denied'),
            hasPrivatePlayback: false,
        }]);

        const result = runSearch(roots, favorites, 'shared', {
            deniedRootKeys: new Set(['share:denied']),
        });

        assert.equal(result.results.length, 0);
    });

    it('filters tracks by downloadedTrackKeys in terminal evidence states', async () => {
        const roots = buildRoots();
        const favorites = await makeFavorites([]);

        const result = runSearch(roots, favorites, 'song', {
            evidenceState: 'evidence:signed-out',
            downloadedTrackKeys: new Set([`${MAIN_DRIVE}:t-song1`]),
        });

        const trackIds = result.results
            .filter((r) => r.kind === 'track')
            .map((r) => `${r.driveId}:${r.itemId}`);
        assert.deepEqual(trackIds, [`${MAIN_DRIVE}:t-song1`]);
    });

    it('does not recurse through nested FavRef members for hits', async () => {
        const roots = buildRoots();
        const members: PlaylistMember[] = [itemRef(MAIN_DRIVE, 'f-rock', ['Rock'], true)];
        const favorites = await makeFavorites([
            {
                kind: 'playlist',
                id: 'pl-child',
                name: 'Child Rock',
                members,
                hasPrivatePlayback: false,
            } as Playlist,
            {
                kind: 'playlist',
                id: 'pl-parent',
                name: 'Parent Chain',
                members: [{ favId: 'pl-child' }],
                hasPrivatePlayback: false,
            } as Playlist,
        ]);

        const result = runSearch(roots, favorites, 'song one');
        const parentNestedHits = result.results.filter((r) =>
            r.kind === 'track' && r.path[1] === 'fav:pl-parent' && r.path[2] === 'm:0');

        assert.equal(parentNestedHits.length, 0);
    });

    it('returns bucket-ordered results: favorites, folders, tracks', async () => {
        const roots = buildRoots();
        const favorites = await makeFavorites([{
            kind: 'playlist',
            id: 'pl-mix',
            name: 'Mix Favorite',
            members: [itemRef(MAIN_DRIVE, 'f-rock', ['Rock'], true)],
            hasPrivatePlayback: false,
        } as Playlist]);

        const result = runSearch(roots, favorites, 'mix');
        const kinds = result.results.map((r) => r.kind);
        const rank = (kind: string): number => (kind === 'favorite' ? 0 : kind === 'folder' ? 1 : 2);

        assert(kinds.includes('favorite'));
        assert(kinds.includes('folder'));
        assert(kinds.includes('track'));
        for (let i = 1; i < kinds.length; i++) {
            assert(rank(kinds[i - 1]) <= rank(kinds[i]));
        }
    });

    it('suppresses duplicate physical folder hit when shortcut favorite already matched', async () => {
        const roots = buildRoots();
        const favorites = await makeFavorites([{
            kind: 'shortcut',
            id: 'sc-rock',
            name: 'Rock',
            target: itemRef(MAIN_DRIVE, 'f-rock', ['Rock'], true),
            hasPrivatePlayback: false,
        }]);

        const result = runSearch(roots, favorites, 'rock');
        const folderHits = result.results.filter((r) => r.kind === 'folder');
        const favoriteHits = result.results.filter((r) => r.kind === 'favorite');

        assert.equal(favoriteHits.length, 1);
        assert.equal(favoriteHits[0].path[1], 'fav:sc-rock');
        assert.equal(folderHits.length, 0);
    });
});

describe('runSearchIncrementalRefinement', () => {
    it('filters prior uncapped results for normalized-prefix refinement', () => {
        const incremental = runSearchIncrementalRefinement({
            previousQuery: 'song',
            query: 'song t',
            previousResults: [
                { kind: 'track', name: 'Song One.mp3', path: ['OnePlay Music', 'x', 'Song One.mp3'] },
                { kind: 'track', name: 'Song Two.mp3', path: ['OnePlay Music', 'x', 'Song Two.mp3'] },
                { kind: 'track', name: 'Song.mp3', path: ['OnePlay Music', 'x', 'Song.mp3'] },
            ],
            previousCapped: false,
        });

        assert(incremental);
        const names = incremental.results.map((r) => r.name);
        assert.deepEqual(names, ['Song Two.mp3']);
    });

    it('returns undefined when prior results were capped', () => {
        const incremental = runSearchIncrementalRefinement({
            previousQuery: 'con',
            query: 'cons',
            previousResults: [{ kind: 'track', name: 'Consul.mp3', path: ['OnePlay Music', 'x'] }],
            previousCapped: true,
        });
        assert.equal(incremental, undefined);
    });

    it('returns undefined when previous query is not a prefix of next', () => {
        const incremental = runSearchIncrementalRefinement({
            previousQuery: 'son t',
            query: 'song t',
            previousResults: [{ kind: 'track', name: 'Consul.mp3', path: ['OnePlay Music', 'x'] }],
            previousCapped: false,
        });
        assert.equal(incremental, undefined);
    });
});

describe('isIncrementalRefinement', () => {
    it('accepts normalized prefix refinement across terms', () => {
        assert.equal(isIncrementalRefinement(' song ', 'song t'), true);
    });

    it('rejects non-prefix query change', () => {
        assert.equal(isIncrementalRefinement('son t', 'song t'), false);
    });
});
