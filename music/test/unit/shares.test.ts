import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createShares, type SharesDeps } from '../../src/shares.js';

interface MockResponse {
    readonly status: number;
    readonly body?: unknown;
}

function makeResponse(status: number, body?: unknown): Response {
    return new Response(body !== undefined ? JSON.stringify(body) : '', {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

function makeDeps(handler: (url: string) => MockResponse): SharesDeps {
    return {
        authFetch(url) {
            const next = handler(url);
            return Promise.resolve(makeResponse(next.status, next.body));
        },
        dbGet() { return Promise.resolve(undefined); },
        dbPut() { return Promise.resolve(); },
    };
}

describe('shares:addFromUrl', () => {
    it('surfaces Graph error message for share-open failures', async () => {
        const shares = createShares(makeDeps((url) => {
            if (url.includes('/shares/') && url.endsWith('?$select=id')) {
                return { status: 403, body: { error: { code: 'accessDenied', message: 'Access denied' } } };
            }
            return { status: 404 };
        }), () => {});

        await assert.rejects(
            () => shares.addFromUrl('https://example.com/share'),
            /Access denied/,
        );
    });

    it('adds valid folder share', async () => {
        const shares = createShares(makeDeps((url) => {
            if (url.includes('/shares/') && url.endsWith('?$select=id')) {
                return { status: 200, body: { id: 'sid-1' } };
            }
            if (url.includes('/shares/') && url.includes('/driveItem')) {
                return {
                    status: 200,
                    body: {
                        id: 'root-item-1',
                        name: 'Shared Library',
                        folder: { childCount: 1 },
                        parentReference: { driveId: 'drive-1' },
                    },
                };
            }
            return { status: 404 };
        }), () => {});

        const record = await shares.addFromUrl('https://example.com/share');
        assert.equal(record.shareId, 'sid-1');
        assert.equal(record.driveId, 'drive-1');
        assert.equal(record.rootItemId, 'root-item-1');
        assert.equal(record.rootKey, 'share:sid-1');
        assert.equal(shares.getAll().length, 1);
    });

    it('rejects duplicate shareId', async () => {
        const shares = createShares(makeDeps((url) => {
            if (url.includes('/shares/') && url.endsWith('?$select=id')) {
                return { status: 200, body: { id: 'sid-dup' } };
            }
            if (url.includes('/shares/') && url.includes('/driveItem')) {
                return {
                    status: 200,
                    body: {
                        id: 'root-item-1',
                        name: 'Shared Library',
                        folder: { childCount: 1 },
                        parentReference: { driveId: 'drive-1' },
                    },
                };
            }
            return { status: 404 };
        }), () => {});

        await shares.addFromUrl('https://example.com/share');
        await assert.rejects(
            () => shares.addFromUrl('https://example.com/share'),
            /already connected/,
        );
    });

    it('rejects non-folder share', async () => {
        const shares = createShares(makeDeps((url) => {
            if (url.includes('/shares/') && url.endsWith('?$select=id')) {
                return { status: 200, body: { id: 'sid-file' } };
            }
            if (url.includes('/shares/') && url.includes('/driveItem')) {
                return {
                    status: 200,
                    body: {
                        id: 'file-item',
                        name: 'song.mp3',
                        parentReference: { driveId: 'drive-1' },
                    },
                };
            }
            return { status: 404 };
        }), () => {});

        await assert.rejects(
            () => shares.addFromUrl('https://example.com/file-share'),
            /Only folder shares are supported/,
        );
    });

    it('requires special/music for whole-drive share', async () => {
        const shares = createShares(makeDeps((url) => {
            if (url.includes('/shares/') && url.endsWith('?$select=id')) {
                return { status: 200, body: { id: 'sid-root' } };
            }
            if (url.includes('/shares/') && url.includes('/driveItem')) {
                return {
                    status: 200,
                    body: {
                        id: 'drive-root',
                        name: 'Root',
                        folder: { childCount: 12 },
                        root: {},
                        parentReference: { driveId: 'drive-1' },
                    },
                };
            }
            if (url.includes('/drives/drive-1/special/music')) {
                return { status: 403, body: { error: { message: 'forbidden' } } };
            }
            return { status: 404 };
        }), () => {});

        await assert.rejects(
            () => shares.addFromUrl('https://example.com/root-share'),
            /forbidden/,
        );
    });
});

it('verifies the resolved share on reconnect and withdraws it before local cache cleanup completes', async () => {
    const grants: string[] = [];
    const disconnected: Array<[string[], string]> = [];
    let finishSave!: () => void;
    let pendingSave: Promise<void> | undefined;
    const shares = createShares({
        ...makeDeps(() => ({status: 404})),
        async authFetch(url) {
            const item = url.includes('/driveItem');
            return new Response(JSON.stringify(item
                ? {id:'root', folder:{}, name:'Shared', parentReference:{driveId:'drive'}}
                : {id:'same'}), {headers:{'X-OnePlay-Account-Proof':item ? 'verified item' : 'metadata'}});
        },
        async dbPut() { await pendingSave; },
        beginSourceProbe(root) {
            return async (r, allowed, connected) => {
                assert.equal(root, 'share:same');
                assert.ok(allowed && connected());
                grants.push(r.headers.get('X-OnePlay-Account-Proof')!);
                return true;
            };
        },
        async onDisconnect(remaining, root) { disconnected.push([remaining, root]); },
    }, () => {});
    const original = await shares.addFromUrl('https://example.test/s');
    pendingSave = new Promise(resolve => { finishSave = resolve; });
    const removing = shares.remove(original.id);
    assert.deepEqual(disconnected, [[[], 'share:same']]);
    assert.equal(shares.getAll().length, 0);
    finishSave();
    await removing;
    const replacement = await shares.addFromUrl('https://example.test/s');
    assert.notEqual(replacement.id, original.id);
    assert.deepEqual(grants, ['verified item', 'verified item']);
});

it('renders cached share denials before any probe and counts only connected shares', async () => {
    const denied = ['share:book', 'share:removed'];
    const calls: string[] = [];
    const { createNativeLibrary } = await import('../../src/native-library.js');
    const native = createNativeLibrary({ async postMessage(message) {
        calls.push(String(message.action ?? message.op));
        if (message.op === 'state') return {driveID:'library', evidence:'evidence:not-online'};
        assert.equal(message.action, 'readAccess');
        return {subscription:'replacement', denied, snapshot:{accessRevision:7}};
    } });
    await native.loadAccountState('state');
    const shares = createShares({
        authFetch: async () => { throw Error('No Graph request is needed to show the cached permissions'); },
        dbGet: async <T>() => ({shares:[{id:'book', shareId:'book', rootKey:'share:book'}]} as T),
        dbPut: async () => {},
        readPlaybackDenials: native.readPlaybackDenials,
    }, () => {});
    await shares.loadFromCache();
    assert.deepEqual([...shares.getDeniedRootKeys()], denied);
    assert.ok(shares.getDeniedReason('share:book'));
    assert.equal(shares.getDeniedCount(), 1);
    assert.deepEqual(calls, ['state','readAccess'], 'replaying cached denials must never publish a new grant or denial');
});
