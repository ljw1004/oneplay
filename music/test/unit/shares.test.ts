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
            if (url.includes('/shares/') && url.includes('?$select=id')) {
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
            if (url.includes('/shares/') && url.includes('?$select=id')) {
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
            if (url.includes('/shares/') && url.includes('?$select=id')) {
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
            if (url.includes('/shares/') && url.includes('?$select=id')) {
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
            if (url.includes('/shares/') && url.includes('?$select=id')) {
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
