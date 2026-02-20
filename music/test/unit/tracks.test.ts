/**
 * Unit tests for tracks.ts — shared track traversal.
 *
 * Tests the pure functions: collectTracks, collectLogicalTracks,
 * collectPhysicalTracks, resolveTrackIds. Uses the same buildTestRoots
 * fixture as favorites.test.ts.
 *
 * Run: npm run test:unit
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    type AccountsMap,
    collectTracks, collectLogicalTracks,
    collectPhysicalTracks, resolveTrackIds,
} from '../../src/tracks.js';
import {
    createFavorites, type FavoritesDeps, type Favorites,
    type RootsMap, type ItemRef, type FavRef, type Shortcut, type Playlist,
    type PlaylistMember,
} from '../../src/favorites.js';
import { type MusicFolder, type AccountInfo } from '../../src/indexer.js';

// ---------------------------------------------------------------------------
// Test fixtures (same tree as favorites.test.ts)
// ---------------------------------------------------------------------------

const DRIVE_ID = 'test-drive';

const sinkDeps: FavoritesDeps = {
    authFetch() { return Promise.reject(new Error('no network')); },
    dbGet() { throw new Error('unexpected dbGet'); },
    dbPut() { return Promise.resolve(); },
};

function buildTestFolder(): MusicFolder {
    return {
        id: 'root',
        children: {
            Rock: {
                id: 'rock',
                children: {
                    album1: {
                        id: 'album1',
                        children: {
                            'track1.mp3': { id: 'file1' },
                            'track2.mp3': { id: 'file2' },
                        },
                    },
                    album2: {
                        id: 'album2',
                        children: {
                            'track3.mp3': { id: 'file3' },
                        },
                    },
                },
            },
            Jazz: {
                id: 'jazz',
                children: {
                    'standards.mp3': { id: 'file4' },
                },
            },
        },
    };
}

function buildTestRoots(): RootsMap {
    const folder = buildTestFolder();
    const info: AccountInfo = { driveId: DRIVE_ID, displayName: 'Test' };
    const roots: RootsMap = new Map();
    roots.set(DRIVE_ID, {
        type: 'onedrive', key: DRIVE_ID, name: 'OneDrive',
        folder, info, reindexing: false,
    });
    return roots;
}

function buildAccounts(): AccountsMap {
    return new Map([[DRIVE_ID, { folder: buildTestFolder(), driveId: DRIVE_ID }]]);
}

function makeFavs(): Favorites {
    return createFavorites(sinkDeps, () => {});
}

const itemRef = (path: string[], itemId: string, isFolder: boolean): ItemRef => ({
    driveId: DRIVE_ID, itemId, path, isFolder,
});
const favRef = (favId: string): FavRef => ({ favId });

const shortcut = (id: string, name: string, target: ItemRef): Shortcut => ({
    kind: 'shortcut', id, name, target, hasPrivatePlayback: false,
});
const playlist = (id: string, name: string, members: PlaylistMember[]): Playlist => ({
    kind: 'playlist', id, name, members, hasPrivatePlayback: false,
});

// ---------------------------------------------------------------------------
// collectTracks
// ---------------------------------------------------------------------------

describe('collectTracks', () => {
    it('physical folder → sorted file paths (folders-first, alpha)', () => {
        const folder = buildTestFolder();
        const paths = collectTracks(['OnePlay Music', DRIVE_ID], folder);
        // Order: Jazz/standards.mp3, Rock/album1/track1, track2, Rock/album2/track3
        assert.equal(paths.length, 4);
        assert.deepEqual(paths[0], ['OnePlay Music', DRIVE_ID, 'Jazz', 'standards.mp3']);
        assert.deepEqual(paths[1], ['OnePlay Music', DRIVE_ID, 'Rock', 'album1', 'track1.mp3']);
        assert.deepEqual(paths[2], ['OnePlay Music', DRIVE_ID, 'Rock', 'album1', 'track2.mp3']);
        assert.deepEqual(paths[3], ['OnePlay Music', DRIVE_ID, 'Rock', 'album2', 'track3.mp3']);
    });

    it('empty folder → empty array', () => {
        const empty: MusicFolder = { id: 'empty', children: {} };
        assert.deepEqual(collectTracks(['OnePlay Music', 'x'], empty), []);
    });
});

// ---------------------------------------------------------------------------
// collectLogicalTracks
// ---------------------------------------------------------------------------

describe('collectLogicalTracks', () => {
    it('shortcut root → expands through target to physical files', async () => {
        const favs = makeFavs();
        const roots = buildTestRoots();
        const accounts = buildAccounts();
        await favs.add(shortcut('s1', 'Rock', itemRef(['Rock'], 'rock', true)));
        const tracks = collectLogicalTracks(
            ['OnePlay Music', 'fav:s1'], accounts, favs, roots,
        );
        assert.equal(tracks.length, 3); // album1: 2 tracks + album2: 1 track
        // Paths should route through the shortcut
        assert.equal(tracks[0][1], 'fav:s1');
    });

    it('playlist with ItemRef members → collects each member files', async () => {
        const favs = makeFavs();
        const roots = buildTestRoots();
        const accounts = buildAccounts();
        await favs.add(playlist('pl1', 'Mix', [
            itemRef(['Rock', 'album1'], 'album1', true),
            itemRef(['Jazz'], 'jazz', true),
        ]));
        const tracks = collectLogicalTracks(
            ['OnePlay Music', 'fav:pl1'], accounts, favs, roots,
        );
        // album1: 2 tracks + Jazz: 1 track
        assert.equal(tracks.length, 3);
    });

    it('playlist with FavRef → follows reference, collects transitively', async () => {
        const favs = makeFavs();
        const roots = buildTestRoots();
        const accounts = buildAccounts();
        await favs.add(shortcut('s1', 'Rock', itemRef(['Rock'], 'rock', true)));
        await favs.add(playlist('pl1', 'Chain', [favRef('s1')]));
        const tracks = collectLogicalTracks(
            ['OnePlay Music', 'fav:pl1'], accounts, favs, roots,
        );
        assert.equal(tracks.length, 3); // Rock: 3 tracks total
    });

    it('cycle in FavRef chain → terminates without infinite loop', async () => {
        const favs = makeFavs();
        const roots = buildTestRoots();
        const accounts = buildAccounts();
        await favs.add(playlist('P1', 'P1', [favRef('P2')]));
        await favs.add(playlist('P2', 'P2', [favRef('P1')]));
        const tracks = collectLogicalTracks(
            ['OnePlay Music', 'fav:P1'], accounts, favs, roots,
        );
        // Cycle detected, no infinite loop
        assert.equal(tracks.length, 0);
    });

    it('same-drive legacy ItemRef is ambiguous when share root exists', async () => {
        const favs = makeFavs();
        const roots = buildTestRoots();
        const accounts = buildAccounts();
        const accountRoot = roots.get(DRIVE_ID) as Extract<import('../../src/favorites.js').Root, { type: 'onedrive' }>;
        roots.set('share:s1', {
            type: 'share',
            key: 'share:s1',
            name: 'Share',
            driveId: DRIVE_ID,
            folder: accountRoot.folder,
            reindexing: false,
        });
        await favs.add(shortcut('s1', 'Legacy', itemRef(['Rock'], 'rock', true)));
        const tracks = collectLogicalTracks(
            ['OnePlay Music', 'fav:s1'], accounts, favs, roots,
        );
        assert.equal(tracks.length, 0);
    });

    it('share ItemRef resolves via sourceRootKey', async () => {
        const favs = makeFavs();
        const roots = buildTestRoots();
        const accounts = buildAccounts();
        const accountRoot = roots.get(DRIVE_ID) as Extract<import('../../src/favorites.js').Root, { type: 'onedrive' }>;
        roots.set('share:s1', {
            type: 'share',
            key: 'share:s1',
            name: 'Share',
            driveId: DRIVE_ID,
            folder: accountRoot.folder,
            reindexing: false,
        });
        await favs.add(shortcut('s1', 'Shared Rock', {
            ...itemRef(['Rock'], 'rock', true),
            sourceRootKey: 'share:s1',
        }));
        const tracks = collectLogicalTracks(
            ['OnePlay Music', 'fav:s1'], accounts, favs, roots,
        );
        assert.equal(tracks.length, 3);
    });
});

// ---------------------------------------------------------------------------
// collectPhysicalTracks
// ---------------------------------------------------------------------------

describe('collectPhysicalTracks', () => {
    it('shortcut → returns {driveId, itemId} for each file', async () => {
        const favs = makeFavs();
        const roots = buildTestRoots();
        await favs.add(shortcut('s1', 'Rock', itemRef(['Rock'], 'rock', true)));
        const result = collectPhysicalTracks('s1', favs, roots);
        assert.equal(result.length, 3);
        const ids = result.map(r => r.itemId).sort();
        assert.deepEqual(ids, ['file1', 'file2', 'file3']);
    });

    it('playlist with mixed members → deduped by driveId:itemId', async () => {
        const favs = makeFavs();
        const roots = buildTestRoots();
        // Playlist with a folder member (album1) and a file member (track1 from album1)
        await favs.add(playlist('pl1', 'Mix', [
            itemRef(['Rock', 'album1'], 'album1', true),
            itemRef(['Rock', 'album1', 'track1.mp3'], 'file1', false),
        ]));
        const result = collectPhysicalTracks('pl1', favs, roots);
        // album1 contributes file1 and file2; the explicit file1 is a dupe
        assert.equal(result.length, 2);
        const ids = result.map(r => r.itemId).sort();
        assert.deepEqual(ids, ['file1', 'file2']);
    });

    it('shared track across two favorites → appears once', async () => {
        const favs = makeFavs();
        const roots = buildTestRoots();
        await favs.add(shortcut('s1', 'Album1', itemRef(['Rock', 'album1'], 'album1', true)));
        // A playlist referencing the same shortcut
        await favs.add(playlist('pl1', 'Chain', [favRef('s1')]));

        const r1 = collectPhysicalTracks('s1', favs, roots);
        const r2 = collectPhysicalTracks('pl1', favs, roots);
        // Both should return the same 2 tracks (file1, file2)
        assert.equal(r1.length, 2);
        assert.equal(r2.length, 2);
    });
});

// ---------------------------------------------------------------------------
// resolveTrackIds
// ---------------------------------------------------------------------------

describe('resolveTrackIds', () => {
    it('physical path → correct {driveId, itemId}', () => {
        const accounts = buildAccounts();
        const favs = makeFavs();
        const roots = buildTestRoots();
        const result = resolveTrackIds(
            ['OnePlay Music', DRIVE_ID, 'Rock', 'album1', 'track1.mp3'],
            accounts, favs, roots,
        );
        assert.ok(result);
        assert.equal(result.driveId, DRIVE_ID);
        assert.equal(result.itemId, 'file1');
    });

    it('broken path → undefined', () => {
        const accounts = buildAccounts();
        const favs = makeFavs();
        const roots = buildTestRoots();
        const result = resolveTrackIds(
            ['OnePlay Music', DRIVE_ID, 'NoSuch', 'file.mp3'],
            accounts, favs, roots,
        );
        assert.equal(result, undefined);
    });

    it('logical path through shortcut → correct {driveId, itemId}', async () => {
        const accounts = buildAccounts();
        const favs = makeFavs();
        const roots = buildTestRoots();
        await favs.add(shortcut('s1', 'Rock', itemRef(['Rock'], 'rock', true)));
        const result = resolveTrackIds(
            ['OnePlay Music', 'fav:s1', 'album1', 'track2.mp3'],
            accounts, favs, roots,
        );
        assert.ok(result);
        assert.equal(result.driveId, DRIVE_ID);
        assert.equal(result.itemId, 'file2');
    });
});
