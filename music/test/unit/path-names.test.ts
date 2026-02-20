/**
 * Unit tests for path-names.ts.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { type Favorites, type RootsMap } from '../../src/favorites.js';
import { resolvePathTailDisplayName } from '../../src/path-names.js';

function makeRoots(): RootsMap {
    return new Map([
        ['fav:pl', { type: 'playlist', key: 'fav:pl', name: 'Heroic Anthems', members: [] }],
        ['share:one', { type: 'share', key: 'share:one', name: 'Shared Mixes', driveId: 'drive-share', reindexing: false }],
    ]);
}

describe('resolvePathTailDisplayName', () => {
    it('resolves depth-2 root keys to root names', () => {
        const roots = makeRoots();
        assert.equal(
            resolvePathTailDisplayName(['OnePlay Music', 'fav:pl'], roots, undefined),
            'Heroic Anthems',
        );
        assert.equal(
            resolvePathTailDisplayName(['OnePlay Music', 'share:one'], roots, undefined),
            'Shared Mixes',
        );
    });

    it('resolves m:N segments through favorites resolver for favorite roots', () => {
        const roots = makeRoots();
        let called = false;
        const favorites: Pick<Favorites, 'resolvePathSegmentName'> = {
            resolvePathSegmentName(path: readonly string[]) {
                called = true;
                assert.equal(path[path.length - 1], 'm:0');
                return 'Riders Of The Lost Ark';
            },
        };
        assert.equal(
            resolvePathTailDisplayName(['OnePlay Music', 'fav:pl', 'm:0'], roots, favorites),
            'Riders Of The Lost Ark',
        );
        assert.equal(called, true);
    });

    it('returns raw segment for non-m segments and missing resolvers', () => {
        const roots = makeRoots();
        assert.equal(
            resolvePathTailDisplayName(['OnePlay Music', 'fav:pl', 'Track Name.mp3'], roots, undefined),
            'Track Name.mp3',
        );
        assert.equal(
            resolvePathTailDisplayName(['OnePlay Music', 'fav:pl', 'm:3'], roots, undefined),
            'm:3',
        );
        assert.equal(
            resolvePathTailDisplayName(['OnePlay Music', 'missing-root'], roots, undefined),
            'missing-root',
        );
    });
});
