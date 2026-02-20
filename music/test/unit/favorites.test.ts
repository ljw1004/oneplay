/**
 * Unit tests for favorites.ts algorithms.
 *
 * Tests the pure algorithmic paths: cycle detection (DFS), healing of broken
 * references (two-phase path/ID repair), child resolution through FavRef
 * chains, display name resolution for synthetic "m:N" segments, and M8
 * mutation methods (rename, addMembers, removeMembers, setHasPrivatePlayback).
 *
 * I/O deps use sink stubs: dbPut is a no-op (since add/heal await save()
 * as a side effect), authFetch rejects (caught by save()'s .catch()),
 * dbGet throws (unexpected in unit tests).
 * See LEARNINGS.md "DI over extraction".
 *
 * Run: npm run test:unit
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    createFavorites, type FavoritesDeps, type Favorites,
    type RootsMap, type Root, type Shortcut, type Playlist,
    type ItemRef, type FavRef, type PlaylistMember,
} from '../../src/favorites.js';
import { type MusicFolder, type AccountInfo } from '../../src/indexer.js';

// ---------------------------------------------------------------------------
// DI stubs — dbPut is a sink (save() is a normal side effect of add/heal),
// authFetch rejects silently (caught by save()'s internal .catch()),
// dbGet throws (never expected in these test paths).
// ---------------------------------------------------------------------------

const sinkDeps: FavoritesDeps = {
    authFetch() { return Promise.reject(new Error('no network in unit test')); },
    dbGet() { throw new Error('unexpected dbGet in unit test'); },
    dbPut() { return Promise.resolve(); },
};

// ---------------------------------------------------------------------------
// Test fixture helpers
// ---------------------------------------------------------------------------

/**
 * Builds a RootsMap with one OneDrive root containing:
 *
 *   Music/
 *     Rock/
 *       album1/
 *         track1.mp3  (id: "file1")
 *         track2.mp3  (id: "file2")
 *       album2/
 *         track3.mp3  (id: "file3")
 *     Jazz/
 *       standards.mp3 (id: "file4")
 */
const DRIVE_ID = 'test-drive';

function buildTestRoots(): RootsMap {
    const folder: MusicFolder = {
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

    const info: AccountInfo = { driveId: DRIVE_ID, displayName: 'Test' };
    const roots: RootsMap = new Map();
    roots.set(DRIVE_ID, {
        type: 'onedrive', key: DRIVE_ID, name: 'OneDrive',
        folder, info, reindexing: false,
    });
    return roots;
}

/** Convenience: create favorites with a change counter. */
function makeFavs(): { favs: Favorites; changeCount: () => number } {
    let count = 0;
    const favs = createFavorites(sinkDeps, () => { count++; });
    return { favs, changeCount: () => count };
}

/** Shorthand for an ItemRef into the test tree. */
const itemRef = (path: string[], itemId: string, isFolder: boolean): ItemRef => ({
    driveId: DRIVE_ID, itemId, path, isFolder,
});

/** Shorthand for a FavRef. */
const favRef = (favId: string): FavRef => ({ favId });

/** Shorthand for a Shortcut with hasPrivatePlayback defaulting to false. */
const shortcut = (id: string, name: string, target: ItemRef, hasPrivatePlayback = false): Shortcut => ({
    kind: 'shortcut', id, name, target, hasPrivatePlayback,
});

/** Shorthand for a Playlist with hasPrivatePlayback defaulting to false. */
const playlist = (id: string, name: string, members: PlaylistMember[], hasPrivatePlayback = false): Playlist => ({
    kind: 'playlist', id, name, members, hasPrivatePlayback,
});

// ---------------------------------------------------------------------------
// 1. Cycle detection — 5 tests
// ---------------------------------------------------------------------------

describe('cycle detection', () => {
    it('self-cycle: playlist cannot contain itself', async () => {
        const { favs } = makeFavs();
        await favs.add(playlist('P1', 'P1', []));
        assert.equal(favs.wouldCreateCycle('P1', 'P1'), true);
    });

    it('direct cycle: P1→P2, adding P1 to P2 is a cycle', async () => {
        const { favs } = makeFavs();
        await favs.add(playlist('P1', 'P1', [favRef('P2')]));
        await favs.add(playlist('P2', 'P2', []));
        assert.equal(favs.wouldCreateCycle('P2', 'P1'), true);
    });

    it('long chain: P1→P2→P3, adding P1 to P3 is a cycle', async () => {
        const { favs } = makeFavs();
        await favs.add(playlist('P1', 'P1', [favRef('P2')]));
        await favs.add(playlist('P2', 'P2', [favRef('P3')]));
        await favs.add(playlist('P3', 'P3', []));
        assert.equal(favs.wouldCreateCycle('P3', 'P1'), true);
    });

    it('no cycle: P1→P2, P3 independent, adding P1 to P3 is safe', async () => {
        const { favs } = makeFavs();
        await favs.add(playlist('P1', 'P1', [favRef('P2')]));
        await favs.add(playlist('P2', 'P2', []));
        await favs.add(playlist('P3', 'P3', []));
        assert.equal(favs.wouldCreateCycle('P3', 'P1'), false);
    });

    it('missing ref: FavRef to unknown favorite returns false (no throw)', async () => {
        const { favs } = makeFavs();
        await favs.add(playlist('P1', 'P1', [favRef('ghost')]));
        // "ghost" doesn't exist — DFS terminates, no cycle
        assert.equal(favs.wouldCreateCycle('P1', 'ghost'), false);
    });
});

// ---------------------------------------------------------------------------
// 2. Healing — 7 tests
// ---------------------------------------------------------------------------

describe('healing', () => {
    /** Builds the idToPath map matching the test tree. */
    function buildIdMap(): Map<string, { driveId: string; path: string[] }> {
        const m = new Map<string, { driveId: string; path: string[] }>();
        m.set('root', { driveId: DRIVE_ID, path: [] });
        m.set('rock', { driveId: DRIVE_ID, path: ['Rock'] });
        m.set('album1', { driveId: DRIVE_ID, path: ['Rock', 'album1'] });
        m.set('file1', { driveId: DRIVE_ID, path: ['Rock', 'album1', 'track1.mp3'] });
        m.set('file2', { driveId: DRIVE_ID, path: ['Rock', 'album1', 'track2.mp3'] });
        m.set('album2', { driveId: DRIVE_ID, path: ['Rock', 'album2'] });
        m.set('file3', { driveId: DRIVE_ID, path: ['Rock', 'album2', 'track3.mp3'] });
        m.set('jazz', { driveId: DRIVE_ID, path: ['Jazz'] });
        m.set('file4', { driveId: DRIVE_ID, path: ['Jazz', 'standards.mp3'] });
        return m;
    }

    const buildPerRootMaps = (): Map<string, Map<string, { driveId: string; path: string[] }>> =>
        new Map([[DRIVE_ID, buildIdMap()]]);

    it('healthy ref: matching path+id is unchanged', async () => {
        const { favs, changeCount } = makeFavs();
        const roots = buildTestRoots();
        await favs.add(shortcut('s1', 'Rock', itemRef(['Rock'], 'rock', true)));
        const before = favs.getAll()[0] as Shortcut;
        await favs.heal(buildPerRootMaps(), roots);
        const after = favs.getAll()[0] as Shortcut;
        // Unchanged — same object reference
        assert.equal(after, before);
        // onChange was only called for the add(), not for heal()
        assert.equal(changeCount(), 1);
    });

    it('heal by path: same path, different itemId → updated itemId', async () => {
        const { favs } = makeFavs();
        const roots = buildTestRoots();
        // Shortcut points to ['Rock'] but with wrong itemId
        await favs.add(shortcut('s1', 'Rock', itemRef(['Rock'], 'wrong-id', true)));
        await favs.heal(buildPerRootMaps(), roots);
        const after = favs.getAll()[0] as Shortcut;
        assert.equal(after.target.itemId, 'rock');
        assert.deepEqual(after.target.path, ['Rock']);
    });

    it('heal by ID: path broken, itemId in idToPath → updated path', async () => {
        const { favs } = makeFavs();
        const roots = buildTestRoots();
        // Shortcut points to a stale path, but itemId still in the index
        await favs.add(shortcut('s1', 'Rock', itemRef(['OldRock'], 'rock', true)));
        await favs.heal(buildPerRootMaps(), roots);
        const after = favs.getAll()[0] as Shortcut;
        assert.deepEqual(after.target.path, ['Rock']);
        assert.equal(after.target.itemId, 'rock');
    });

    it('broken shortcut removed: neither path nor ID resolves', async () => {
        const { favs } = makeFavs();
        const roots = buildTestRoots();
        await favs.add(shortcut('s1', 'Gone', itemRef(['NoSuch'], 'no-such-id', true)));
        await favs.heal(buildPerRootMaps(), roots);
        assert.equal(favs.getAll().length, 0);
    });

    it('broken playlist member dropped: 1 of 3 broken → playlist has 2', async () => {
        const { favs } = makeFavs();
        const roots = buildTestRoots();
        await favs.add(playlist('pl1', 'Mix', [
            itemRef(['Rock'], 'rock', true),              // healthy
            itemRef(['Ghost'], 'ghost-id', false),         // broken
            itemRef(['Jazz'], 'jazz', true),               // healthy
        ]));
        await favs.heal(buildPerRootMaps(), roots);
        const pl = favs.getAll()[0] as Playlist;
        assert.equal(pl.members.length, 2);
    });

    it('idempotent: healing twice produces the same result', async () => {
        const { favs } = makeFavs();
        const roots = buildTestRoots();
        await favs.add(shortcut('s1', 'Rock', itemRef(['OldRock'], 'rock', true)));
        await favs.heal(buildPerRootMaps(), roots);
        const first = favs.getAll()[0] as Shortcut;
        await favs.heal(buildPerRootMaps(), roots);
        const second = favs.getAll()[0] as Shortcut;
        // After second heal, nothing changed — same reference
        assert.equal(second, first);
    });

    it('broken FavRef removed: FavRef to deleted favorite → member dropped', async () => {
        const { favs } = makeFavs();
        const roots = buildTestRoots();
        await favs.add(playlist('pl1', 'Mix', [
            itemRef(['Rock'], 'rock', true),
            favRef('deleted-fav'),  // no favorite with this ID
        ]));
        await favs.heal(buildPerRootMaps(), roots);
        const pl = favs.getAll()[0] as Playlist;
        assert.equal(pl.members.length, 1);
    });

    it('preserves sourceRootKey across heal-by-path and heal-by-id', async () => {
        const { favs } = makeFavs();
        const roots = buildTestRoots();
        const baseRoot = roots.get(DRIVE_ID) as Root;
        roots.set('share:s1', {
            type: 'share',
            key: 'share:s1',
            name: 'Share',
            driveId: DRIVE_ID,
            folder: (baseRoot as Extract<Root, { type: 'onedrive' }>).folder,
            reindexing: false,
        });
        await favs.add(shortcut('s1', 'Rock', {
            ...itemRef(['Rock'], 'wrong-id', true),
            sourceRootKey: 'share:s1',
        }));
        const perRoot = new Map<string, Map<string, { driveId: string; path: string[] }>>([
            ['share:s1', buildIdMap()],
        ]);
        await favs.heal(perRoot, roots);
        const sc = favs.getAll()[0] as Shortcut;
        assert.equal(sc.target.sourceRootKey, 'share:s1');
    });

    it('preserves unresolved denied share refs', async () => {
        const { favs } = makeFavs();
        const roots = buildTestRoots();
        await favs.add(shortcut('s1', 'Denied', {
            driveId: DRIVE_ID,
            itemId: 'missing',
            path: ['NoSuch'],
            isFolder: true,
            sourceRootKey: 'share:s1',
        }));
        await favs.heal(new Map(), roots, new Set(['share:s1']));
        const sc = favs.getAll()[0] as Shortcut;
        assert.equal(sc.target.sourceRootKey, 'share:s1');
        assert.equal(sc.target.itemId, 'missing');
    });

    it('removes refs bound to explicitly removed share root', async () => {
        const { favs } = makeFavs();
        const roots = buildTestRoots();
        await favs.add(shortcut('s1', 'Gone', {
            driveId: DRIVE_ID,
            itemId: 'rock',
            path: ['Rock'],
            isFolder: true,
            sourceRootKey: 'share:s1',
        }));
        await favs.heal(new Map(), roots, new Set(), new Set(['share:s1']));
        assert.equal(favs.getAll().length, 0);
    });
});

// ---------------------------------------------------------------------------
// 3. Resolution — 6 tests
// ---------------------------------------------------------------------------

describe('resolution', () => {
    /** Adds a shortcut to Rock and returns its ID. */
    async function addRockShortcut(favs: Favorites): Promise<string> {
        const id = 'sc-rock';
        await favs.add(shortcut(id, 'Rock', itemRef(['Rock'], 'rock', true)));
        return id;
    }

    it('shortcut resolves folder: children of Rock (folders first, alpha)', async () => {
        const { favs } = makeFavs();
        const roots = buildTestRoots();
        const id = await addRockShortcut(favs);
        const children = favs.resolveChildren(id, [], roots);
        assert.ok(children);
        // Rock has album1 (folder), album2 (folder) — sorted alphabetically
        assert.deepEqual(children, [
            ['album1', true],
            ['album2', true],
        ]);
    });

    it('shortcut walks subPath: subPath=["album1"] → album1 children', async () => {
        const { favs } = makeFavs();
        const roots = buildTestRoots();
        const id = await addRockShortcut(favs);
        const children = favs.resolveChildren(id, ['album1'], roots);
        assert.ok(children);
        // album1 has track1.mp3, track2.mp3 (files, sorted alpha)
        assert.deepEqual(children, [
            ['track1.mp3', false],
            ['track2.mp3', false],
        ]);
    });

    it('playlist top-level: 3 members → m:0, m:1, m:2', async () => {
        const { favs } = makeFavs();
        const roots = buildTestRoots();
        await favs.add(playlist('pl1', 'Mix', [
            itemRef(['Rock', 'album1', 'track1.mp3'], 'file1', false),
            itemRef(['Rock'], 'rock', true),
            itemRef(['Jazz'], 'jazz', true),
        ]));
        const children = favs.resolveChildren('pl1', [], roots);
        assert.ok(children);
        assert.deepEqual(children, [
            ['m:0', false],  // file
            ['m:1', true],   // folder
            ['m:2', true],   // folder
        ]);
    });

    it('playlist m:N into folder: subPath=["m:1"] → Rock children', async () => {
        const { favs } = makeFavs();
        const roots = buildTestRoots();
        await favs.add(playlist('pl1', 'Mix', [
            itemRef(['Rock', 'album1', 'track1.mp3'], 'file1', false),
            itemRef(['Rock'], 'rock', true),
        ]));
        const children = favs.resolveChildren('pl1', ['m:1'], roots);
        assert.ok(children);
        assert.deepEqual(children, [
            ['album1', true],
            ['album2', true],
        ]);
    });

    it('FavRef chain: playlist → FavRef → shortcut → shortcut target children', async () => {
        const { favs } = makeFavs();
        const roots = buildTestRoots();
        // Shortcut to Rock
        const scId = await addRockShortcut(favs);
        // Playlist with one FavRef member pointing to the shortcut
        await favs.add(playlist('pl1', 'Chain', [favRef(scId)]));
        // Navigate into the FavRef member: subPath=["m:0"] should resolve
        // through the shortcut into Rock's children
        const children = favs.resolveChildren('pl1', ['m:0'], roots);
        assert.ok(children);
        assert.deepEqual(children, [
            ['album1', true],
            ['album2', true],
        ]);
    });

    it('cycle in FavRef chain: P1→P2→P1 returns undefined, no hang', async () => {
        const { favs } = makeFavs();
        const roots = buildTestRoots();
        await favs.add(playlist('P1', 'P1', [favRef('P2')]));
        await favs.add(playlist('P2', 'P2', [favRef('P1')]));
        // Navigate into the cycle: P1 → m:0 → P2 → m:0 → P1 (cycle!)
        const children = favs.resolveChildren('P1', ['m:0', 'm:0'], roots);
        assert.equal(children, undefined);
    });
});

// ---------------------------------------------------------------------------
// 4. Display name — 4 tests
// ---------------------------------------------------------------------------

describe('display name', () => {
    it('ItemRef member: path ["Rock","album1"] → "album1"', async () => {
        const { favs } = makeFavs();
        await favs.add(playlist('pl1', 'Mix', [
            itemRef(['Rock', 'album1'], 'album1', true),
        ]));
        assert.equal(favs.resolveDisplayName('pl1', 'm:0'), 'album1');
    });

    it('FavRef member: FavRef to shortcut "My Faves" → "My Faves"', async () => {
        const { favs } = makeFavs();
        await favs.add(shortcut('sc1', 'My Faves', itemRef(['Rock'], 'rock', true)));
        await favs.add(playlist('pl1', 'Chain', [favRef('sc1')]));
        assert.equal(favs.resolveDisplayName('pl1', 'm:0'), 'My Faves');
    });

    it('non-member segment: "SomeFolder" → unchanged', async () => {
        const { favs } = makeFavs();
        await favs.add(playlist('pl1', 'Mix', [
            itemRef(['Rock'], 'rock', true),
        ]));
        assert.equal(favs.resolveDisplayName('pl1', 'SomeFolder'), 'SomeFolder');
    });

    it('out-of-range: "m:99" → unchanged', async () => {
        const { favs } = makeFavs();
        await favs.add(playlist('pl1', 'Mix', [
            itemRef(['Rock'], 'rock', true),
        ]));
        assert.equal(favs.resolveDisplayName('pl1', 'm:99'), 'm:99');
    });

    it('resolvePathSegmentName walks FavRef chain for nested playlists', async () => {
        const { favs } = makeFavs();
        // Playlist2 has a folder member "album1"
        await favs.add(playlist('pl2', 'Playlist2', [
            itemRef(['Rock', 'album1'], 'album1', true),
        ]));
        // Playlist1 has Playlist2 as its 0th member
        await favs.add(playlist('pl1', 'Playlist1', [favRef('pl2')]));
        // Path: OnePlay Music > fav:pl1 > m:0 (=Playlist2) > m:0 (=album1)
        // The last "m:0" should resolve against Playlist2, not Playlist1
        const path = ['OnePlay Music', 'fav:pl1', 'm:0', 'm:0'];
        assert.equal(favs.resolvePathSegmentName(path), 'album1');
    });
});

// ---------------------------------------------------------------------------
// 5. Validation — 2 tests
// ---------------------------------------------------------------------------

describe('validation', () => {
    it('reject file shortcut: isFolder=false → add returns false', async () => {
        const { favs } = makeFavs();
        const result = await favs.add(
            shortcut('s1', 'Bad', itemRef(['Rock', 'album1', 'track1.mp3'], 'file1', false)),
        );
        assert.equal(result, false);
        assert.equal(favs.getAll().length, 0);
    });

    it('accept folder shortcut: isFolder=true → add returns true', async () => {
        const { favs } = makeFavs();
        const result = await favs.add(
            shortcut('s1', 'Good', itemRef(['Rock'], 'rock', true)),
        );
        assert.equal(result, true);
        assert.equal(favs.getAll().length, 1);
    });
});

// ---------------------------------------------------------------------------
// 6. Rename — 3 tests
// ---------------------------------------------------------------------------

describe('rename', () => {
    it('changes playlist name', async () => {
        const { favs, changeCount } = makeFavs();
        await favs.add(playlist('pl1', 'OldName', []));
        const before = changeCount();
        await favs.rename('pl1', 'NewName');
        const pl = favs.getAll()[0] as Playlist;
        assert.equal(pl.name, 'NewName');
        assert.equal(changeCount(), before + 1);
    });

    it('trims whitespace', async () => {
        const { favs } = makeFavs();
        await favs.add(playlist('pl1', 'OldName', []));
        await favs.rename('pl1', '  Trimmed  ');
        const pl = favs.getAll()[0] as Playlist;
        assert.equal(pl.name, 'Trimmed');
    });

    it('rejects empty name', async () => {
        const { favs, changeCount } = makeFavs();
        await favs.add(playlist('pl1', 'KeepMe', []));
        const before = changeCount();
        await favs.rename('pl1', '   ');
        const pl = favs.getAll()[0] as Playlist;
        assert.equal(pl.name, 'KeepMe');
        // onChange was NOT called for the rejected rename
        assert.equal(changeCount(), before);
    });
});

// ---------------------------------------------------------------------------
// 7. addMembers — 2 tests
// ---------------------------------------------------------------------------

describe('addMembers', () => {
    it('adds to playlist, skips duplicates', async () => {
        const { favs, changeCount } = makeFavs();
        const track1 = itemRef(['Rock', 'album1', 'track1.mp3'], 'file1', false);
        const track2 = itemRef(['Rock', 'album1', 'track2.mp3'], 'file2', false);
        await favs.add(playlist('pl1', 'Mix', [track1]));
        const before = changeCount();
        // Add track2 (new) and track1 (duplicate — same driveId+itemId)
        await favs.addMembers('pl1', [track2, track1]);
        const pl = favs.getAll()[0] as Playlist;
        // Only track2 was added; track1 was a duplicate
        assert.equal(pl.members.length, 2);
        assert.equal(changeCount(), before + 1);
    });

    it('cycle-checks FavRef', async () => {
        const { favs } = makeFavs();
        // P1 contains FavRef→P2
        await favs.add(playlist('P1', 'P1', [favRef('P2')]));
        await favs.add(playlist('P2', 'P2', []));
        // Adding FavRef→P1 to P2 would create cycle P2→P1→P2; should be skipped
        await favs.addMembers('P2', [favRef('P1')]);
        const p2 = favs.getAll()[1] as Playlist;
        assert.equal(p2.members.length, 0);
    });
});

// ---------------------------------------------------------------------------
// 8. removeMembers — 2 tests
// ---------------------------------------------------------------------------

describe('removeMembers', () => {
    it('removes by index', async () => {
        const { favs, changeCount } = makeFavs();
        const t1 = itemRef(['Rock', 'album1', 'track1.mp3'], 'file1', false);
        const t2 = itemRef(['Rock', 'album1', 'track2.mp3'], 'file2', false);
        const t3 = itemRef(['Rock', 'album2', 'track3.mp3'], 'file3', false);
        await favs.add(playlist('pl1', 'Mix', [t1, t2, t3]));
        const before = changeCount();
        // Remove middle element (index 1)
        await favs.removeMembers('pl1', [1]);
        const pl = favs.getAll()[0] as Playlist;
        assert.equal(pl.members.length, 2);
        // Remaining: t1 and t3 (t2 was removed)
        assert.equal((pl.members[0] as ItemRef).itemId, 'file1');
        assert.equal((pl.members[1] as ItemRef).itemId, 'file3');
        assert.equal(changeCount(), before + 1);
    });

    it('handles unsorted indices', async () => {
        const { favs } = makeFavs();
        const t1 = itemRef(['Rock', 'album1', 'track1.mp3'], 'file1', false);
        const t2 = itemRef(['Rock', 'album1', 'track2.mp3'], 'file2', false);
        const t3 = itemRef(['Rock', 'album2', 'track3.mp3'], 'file3', false);
        await favs.add(playlist('pl1', 'Mix', [t1, t2, t3]));
        // Pass indices out of order: [2, 0] — should still remove correctly
        await favs.removeMembers('pl1', [2, 0]);
        const pl = favs.getAll()[0] as Playlist;
        assert.equal(pl.members.length, 1);
        // Only t2 (index 1) remains
        assert.equal((pl.members[0] as ItemRef).itemId, 'file2');
    });
});

// ---------------------------------------------------------------------------
// 9. setHasPrivatePlayback — 1 test
// ---------------------------------------------------------------------------

describe('setHasPrivatePlayback', () => {
    it('toggles the field', async () => {
        const { favs, changeCount } = makeFavs();
        await favs.add(playlist('pl1', 'Mix', []));
        // Initially false (default)
        assert.equal((favs.getAll()[0] as Playlist).hasPrivatePlayback, false);
        const before = changeCount();
        // Set to true
        await favs.setHasPrivatePlayback('pl1', true);
        assert.equal((favs.getAll()[0] as Playlist).hasPrivatePlayback, true);
        assert.equal(changeCount(), before + 1);
        // Set back to false
        await favs.setHasPrivatePlayback('pl1', false);
        assert.equal((favs.getAll()[0] as Playlist).hasPrivatePlayback, false);
        assert.equal(changeCount(), before + 2);
    });
});

// ---------------------------------------------------------------------------
// 10. setOfflinePin — 3 tests
// ---------------------------------------------------------------------------

describe('setOfflinePin', () => {
    it('sets offlinePin, triggers onChange', async () => {
        const { favs, changeCount } = makeFavs();
        await favs.add(playlist('pl1', 'Mix', []));
        const before = changeCount();
        await favs.setOfflinePin('pl1', { paused: false });
        const fav = favs.getAll()[0] as Playlist;
        assert.deepEqual(fav.offlinePin, { paused: false });
        assert.equal(changeCount(), before + 1);
    });

    it('clears offlinePin with undefined, triggers onChange', async () => {
        const { favs, changeCount } = makeFavs();
        await favs.add(playlist('pl1', 'Mix', []));
        await favs.setOfflinePin('pl1', { paused: false });
        const before = changeCount();
        await favs.setOfflinePin('pl1', undefined);
        const fav = favs.getAll()[0] as Playlist;
        assert.equal(fav.offlinePin, undefined);
        assert.equal(changeCount(), before + 1);
    });

    it('normalize preserves offlinePin when present', async () => {
        const { favs } = makeFavs();
        await favs.add(playlist('pl1', 'Mix', []));
        await favs.setOfflinePin('pl1', { paused: true });
        const fav = favs.getAll()[0] as Playlist;
        assert.deepEqual(fav.offlinePin, { paused: true });
    });
});
