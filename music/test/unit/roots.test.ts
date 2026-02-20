/**
 * Unit tests for roots.ts resolver rules.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { type Root, type RootsMap, type ItemRef } from '../../src/favorites.js';
import { type MusicFolder, type AccountInfo } from '../../src/indexer.js';
import { resolveWalkableRootForItemRef, isWalkableRoot } from '../../src/roots.js';

const folder = (): MusicFolder => ({ id: 'root', children: {} });
const accountInfo = (driveId: string): AccountInfo => ({ driveId, displayName: 'Account' });

function itemRef(driveId: string, sourceRootKey?: string): ItemRef {
    return { driveId, itemId: 'x', path: [], isFolder: true, sourceRootKey };
}

function rootMap(roots: Root[]): RootsMap {
    return new Map(roots.map(r => [r.key, r]));
}

describe('isWalkableRoot', () => {
    it('accepts onedrive and loaded share roots', () => {
        const onedrive: Root = {
            type: 'onedrive',
            key: 'd1',
            name: 'OneDrive',
            folder: folder(),
            info: accountInfo('d1'),
            reindexing: false,
        };
        const share: Root = {
            type: 'share',
            key: 'share:s1',
            name: 'Share',
            driveId: 'd2',
            folder: folder(),
            reindexing: false,
        };
        assert.equal(isWalkableRoot(onedrive), true);
        assert.equal(isWalkableRoot(share), true);
    });

    it('rejects unloaded share and favorite roots', () => {
        const share: Root = {
            type: 'share',
            key: 'share:s1',
            name: 'Share',
            driveId: 'd2',
            folder: undefined,
            reindexing: false,
        };
        const shortcut: Root = {
            type: 'shortcut',
            key: 'fav:1',
            name: 'Shortcut',
            target: itemRef('d1'),
        };
        assert.equal(isWalkableRoot(share), false);
        assert.equal(isWalkableRoot(shortcut), false);
    });
});

describe('resolveWalkableRootForItemRef', () => {
    it('uses sourceRootKey first', () => {
        const roots = rootMap([
            {
                type: 'onedrive',
                key: 'd1',
                name: 'OneDrive',
                folder: folder(),
                info: accountInfo('d1'),
                reindexing: false,
            },
            {
                type: 'share',
                key: 'share:s1',
                name: 'Share',
                driveId: 'd1',
                folder: folder(),
                reindexing: false,
            },
        ]);
        const resolved = resolveWalkableRootForItemRef(itemRef('d1', 'share:s1'), roots);
        assert.equal(resolved?.type, 'share');
        assert.equal(resolved?.key, 'share:s1');
    });

    it('falls back to unique account root for legacy refs', () => {
        const roots = rootMap([{
            type: 'onedrive',
            key: 'd1',
            name: 'OneDrive',
            folder: folder(),
            info: accountInfo('d1'),
            reindexing: false,
        }]);
        const resolved = resolveWalkableRootForItemRef(itemRef('d1'), roots);
        assert.equal(resolved?.type, 'onedrive');
        assert.equal(resolved?.key, 'd1');
    });

    it('rejects ambiguous fallback when share exists on same drive', () => {
        const roots = rootMap([
            {
                type: 'onedrive',
                key: 'd1',
                name: 'OneDrive',
                folder: folder(),
                info: accountInfo('d1'),
                reindexing: false,
            },
            {
                type: 'share',
                key: 'share:s1',
                name: 'Share',
                driveId: 'd1',
                folder: folder(),
                reindexing: false,
            },
        ]);
        const resolved = resolveWalkableRootForItemRef(itemRef('d1'), roots);
        assert.equal(resolved, undefined);
    });

    it('ignores shortcut roots when legacy fallback resolves account', () => {
        const roots = rootMap([
            {
                type: 'onedrive',
                key: 'd1',
                name: 'OneDrive',
                folder: folder(),
                info: accountInfo('d1'),
                reindexing: false,
            },
            {
                type: 'shortcut',
                key: 'fav:1',
                name: 'Shortcut',
                target: itemRef('d1'),
            },
        ]);
        const resolved = resolveWalkableRootForItemRef(itemRef('d1'), roots);
        assert.equal(resolved?.type, 'onedrive');
        assert.equal(resolved?.key, 'd1');
    });
});
