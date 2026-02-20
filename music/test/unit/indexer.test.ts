import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex, type MusicDriveItem } from '../../src/indexer.js';
import { type AuthFetch, type AuthFetchOptions } from '../../src/auth.js';

type Step =
    | 'success'
    | 'load-fail'
    | 'stack-only-load-fail'
    | 'nonok-text-read-fail'
    | 'invalid-json'
    | 'missing-responses';

const ROOT_DRIVE_ITEM: MusicDriveItem = {
    id: 'root-folder',
    name: 'Music',
    size: 1,
    lastModifiedDateTime: '2026-01-01T00:00:00Z',
    cTag: 'ctag',
    eTag: 'etag',
    folder: { childCount: 0 },
};

function buildSuccessBatchResponse(options?: AuthFetchOptions): Response {
    const raw = typeof options?.body === 'string' ? options.body : '{"requests":[]}';
    const parsed = JSON.parse(raw) as { requests?: Array<{ id?: string }> };
    const responses = (parsed.requests ?? []).map((req) => {
        const id = String(req.id ?? '');
        if (id.startsWith('children-')) return { id, status: 200, headers: {}, body: { value: [] } };
        if (id.startsWith('cache-')) return { id, status: 404, headers: {}, body: {} };
        if (id.startsWith('write-')) return { id, status: 200, headers: {}, body: {} };
        return { id, status: 200, headers: {}, body: {} };
    });
    return new Response(
        JSON.stringify({ responses }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
}

function createScriptedAuthFetch(steps: readonly Step[]): { authFetch: AuthFetch; getCallCount: () => number } {
    let callCount = 0;
    const authFetch: AuthFetch = async (_url, _retryOn429, options): Promise<Response> => {
        const step = steps[Math.min(callCount, steps.length - 1)];
        callCount++;
        if (step === 'success') return buildSuccessBatchResponse(options);
        if (step === 'load-fail') {
            return {
                ok: true,
                status: 200,
                statusText: 'OK',
                text: () => Promise.reject(new TypeError('Load failed')),
            } as unknown as Response;
        }
        if (step === 'stack-only-load-fail') {
            return {
                ok: true,
                status: 200,
                statusText: 'OK',
                text: () => {
                    const err = new TypeError('');
                    err.stack = '@https://unto.me/oneplay/music/dist/indexer.js:336:32';
                    return Promise.reject(err);
                },
            } as unknown as Response;
        }
        if (step === 'nonok-text-read-fail') {
            return {
                ok: false,
                status: 500,
                statusText: 'Internal Server Error',
                text: () => Promise.reject(new TypeError('Load failed')),
            } as unknown as Response;
        }
        if (step === 'invalid-json') return new Response('not json', { status: 200 });
        return new Response(JSON.stringify({ unexpected: true }), { status: 200 });
    };
    return { authFetch, getCallCount: () => callCount };
}

describe('buildIndex poison-pill retries', () => {
    it('retries on load-family failure and then succeeds', async () => {
        const scripted = createScriptedAuthFetch(['load-fail', 'success', 'success']);
        const data = await buildIndex(ROOT_DRIVE_ITEM, () => {}, scripted.authFetch, 'drive', 'primary');
        assert.equal(data.count, 0);
        assert.equal(scripted.getCallCount(), 3);
    });

    it('retries on stack-only load-family failure and then succeeds', async () => {
        const scripted = createScriptedAuthFetch(['stack-only-load-fail', 'success', 'success']);
        const data = await buildIndex(ROOT_DRIVE_ITEM, () => {}, scripted.authFetch, 'drive', 'primary');
        assert.equal(data.count, 0);
        assert.equal(scripted.getCallCount(), 3);
    });

    it('resets poison after successful batches between failures', async () => {
        const scripted = createScriptedAuthFetch([
            'success', 'load-fail',
            'success', 'load-fail',
            'success', 'load-fail',
            'success', 'success',
        ]);
        const data = await buildIndex(ROOT_DRIVE_ITEM, () => {}, scripted.authFetch, 'drive', 'primary');
        assert.equal(data.count, 0);
        assert.equal(scripted.getCallCount(), 8);
    });

    it('gives up after poison reaches 3 with no intervening success', async () => {
        const scripted = createScriptedAuthFetch(['load-fail', 'load-fail', 'load-fail']);
        await assert.rejects(
            buildIndex(ROOT_DRIVE_ITEM, () => {}, scripted.authFetch, 'drive', 'primary'),
            (e: unknown) => {
                const msg = e instanceof Error ? e.message : String(e);
                assert(msg.includes('body unreadable') || msg.includes('Load failed'));
                return true;
            },
        );
        assert.equal(scripted.getCallCount(), 3);
    });

    it('retries non-load failures and gives up at poison 3', async () => {
        const scripted = createScriptedAuthFetch(['missing-responses']);
        await assert.rejects(
            buildIndex(ROOT_DRIVE_ITEM, () => {}, scripted.authFetch, 'drive', 'primary'),
            (e: unknown) => {
                const msg = e instanceof Error ? e.message : String(e);
                assert(msg.includes('missing responses[]'));
                return true;
            },
        );
        assert.equal(scripted.getCallCount(), 3);
    });

    it('includes context when non-ok response text cannot be read', async () => {
        const scripted = createScriptedAuthFetch(['nonok-text-read-fail', 'nonok-text-read-fail', 'nonok-text-read-fail']);
        await assert.rejects(
            buildIndex(ROOT_DRIVE_ITEM, () => {}, scripted.authFetch, 'drive', 'primary'),
            (e: unknown) => {
                const msg = e instanceof Error ? e.message : String(e);
                assert(msg.includes('batch POST failed status=500'));
                assert(msg.includes('<body unreadable:'));
                return true;
            },
        );
        assert.equal(scripted.getCallCount(), 3);
    });

    it('retries invalid json failures and gives up at poison 3', async () => {
        const scripted = createScriptedAuthFetch(['invalid-json']);
        await assert.rejects(
            buildIndex(ROOT_DRIVE_ITEM, () => {}, scripted.authFetch, 'drive', 'primary'),
            (e: unknown) => {
                const msg = e instanceof Error ? e.message : String(e);
                assert(msg.includes('invalid JSON'));
                assert(msg.includes('snippet=not json'));
                return true;
            },
        );
        assert.equal(scripted.getCallCount(), 3);
    });
});
