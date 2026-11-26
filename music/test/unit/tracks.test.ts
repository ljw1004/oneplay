/** Unit coverage for cached-track ID resolution and stable occurrences in a live playback queue. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildLibraryQueue, resolveTrackIds, type AccountsMap } from '../../src/tracks.js';
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

describe('live queue identity', () => {
    const root = ['OnePlay Music', 'fav:list'];
    const album = itemRef(['Rock', 'album1'], 'album1', true);
    const jazz = itemRef(['Jazz', 'standards.mp3'], 'file4', false);
    const child = playlist('child', 'Albums', [album]);
    const queue = async (members: PlaylistMember[], path = root, key?: string) =>
        (await buildLibraryQueue(path, buildTestRoots(), [playlist('list', 'List', members), child], new Set(), key))!;

    it('remaps nested folders and titles when an earlier member disappears', async () => {
        const before = await queue([jazz, favRef('child')], [...root, 'm:1', 'm:0']);
        const after = await queue([favRef('child')], [...before.folder], before.folderKey);
        assert.deepEqual(after.folder, [...root, 'm:0', 'm:0']);
        assert.deepEqual(after.tracks.map(t => t.key), before.tracks.map(t => t.key));
        assert.deepEqual(after.tracks.map(t => t.title), ['track1.mp3', 'track2.mp3']);
        assert.equal((await queue([jazz])).tracks[0].title, 'standards.mp3');
    });

    it('distinguishes routes to the same file and invalidates ambiguous duplicate groups', async () => {
        const before = (await queue([album, favRef('child'), favRef('child')])).tracks;
        const nested = await queue([album, favRef('child'), favRef('child')], [...root, 'm:1']);
        assert.equal(new Set(before.map(t => t.key)).size, 6);
        for (const count of [1, 3]) {
            const members = [album, ...Array.from({length: count}, () => favRef('child'))];
            const after = (await queue(members)).tracks;
            assert.equal(before[0].key, after[0].key);
            for (const t of before.slice(2)) assert.ok(!after.some(other => t.key === other.key));
            assert.deepEqual((await queue(members, [...nested.folder], nested.folderKey)).tracks, []);
        }
    });

    it('keeps an incomplete revision and filters a confirmed revoked source', async () => {
        const shared = {...album, sourceRootKey: 'share:s'};
        const roots = buildTestRoots();
        roots.set('share:s', {type: 'share', connectionId: 'connection', key: 'share:s', name: 'share', driveId: DRIVE_ID, reindexing: false});
        const favs = [playlist('list', 'List', [{...jazz, sourceRootKey: DRIVE_ID}, shared])];
        const selected = (await buildLibraryQueue(root, roots, favs, new Set()))!;
        assert.equal(selected.tracks.length, 1);
        assert.equal(await buildLibraryQueue(root, roots, favs, new Set(), selected.folderKey), undefined);
        assert.equal((await buildLibraryQueue(root, roots, favs, new Set(['share:s']), selected.folderKey))?.tracks.length, 1);
        // Path-only migration also needs a complete projection before declaring a bookmark missing.
        assert.equal(await buildLibraryQueue(root, roots, favs, new Set(), ''), undefined);
        roots.delete('share:s');
        assert.equal(await buildLibraryQueue(root, roots, favs, new Set(), '', false), undefined);
        assert.equal((await buildLibraryQueue(root, roots, favs, new Set(), '', true))?.tracks.length, 1);
    });
});
