import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex, isCurrentIndex, type MusicDriveItem, type MusicData } from '../../src/indexer.js';
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

    it('reports the HTTP failure independently of an unreadable error body', async () => {
        const scripted = createScriptedAuthFetch(['nonok-text-read-fail', 'nonok-text-read-fail', 'nonok-text-read-fail']);
        await assert.rejects(
            buildIndex(ROOT_DRIVE_ITEM, () => {}, scripted.authFetch, 'drive', 'primary'),
            (e: unknown) => {
                const msg = e instanceof Error ? e.message : String(e);
                assert(msg.includes('batch POST failed status=500'));
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
                assert(!msg.includes('not json'));
                return true;
            },
        );
        assert.equal(scripted.getCallCount(), 3);
    });
});

it('uses build 251 root and flattened subtree paths and writes identical UTF-8/base64 payloads', async () => {
    const folder = (id: string, name: string) => ({ ...ROOT_DRIVE_ITEM, id, name });
    const children: Record<string, unknown[]> = {
        'root-folder': [folder('parent', 'A'), folder('flat', 'A_B')],
        parent: [folder('nested', 'B')], nested: [{ id: 'track', name: 'Été 東京.mp3', file: {}, size: 1 }], flat: [],
    };
    const names: Record<string, string> = {
        'root-folder': 'index.json', parent: 'A.json', flat: 'A_B.json', nested: 'A_B.json',
    };
    for (const namespace of ['primary', 'share-123', '']) {
        const prefix = namespace ? namespace + '/' : '';
        const listings: string[] = [];
        const reads = new Set<string>();
        const writes = new Set<string>();
        const fetch: AuthFetch = async (url, _retry, options) => {
            assert(url.endsWith('/$batch'));
            const { requests } = JSON.parse(String(options?.body));
            return Response.json({ responses: requests.map((r: {
                id: string; method: string; url: string; body: string; headers: Record<string, string>;
            }) => {
                const id = r.id.slice(r.id.indexOf('-') + 1);
                if (r.id.startsWith('children-')) {
                    listings.push(id);
                    assert.equal(new URL(r.url, 'https://graph.microsoft.com').searchParams.get('$top'), '10000');
                    return { id: r.id, status: 200, body: { value: children[id],
                        '@odata.nextLink': 'https://graph.microsoft.com/v1.0/unused-page' } };
                }
                assert.equal(r.url, '/me/drive/special/approot:/' + prefix + names[id] + ':/content');
                if (r.method === 'GET') {
                    reads.add(id);
                    return { id: r.id, status: 404 };
                }
                assert.equal(r.method, 'PUT');
                assert.deepEqual(r.headers, { 'Content-Type': 'text/plain' });
                writes.add(id);
                if (id === 'nested') {
                    const payload = {
                        kind: 'MusicData', schemaVersion: 1, size: 1, lastModifiedDateTime: '2026-01-01T00:00:00Z',
                        cTag: 'ctag', eTag: 'etag', folder: { id: 'nested', children: { 'Été 東京.mp3': { id: 'track' } } },
                        count: 1,
                    };
                    assert.equal(r.body, Buffer.from(JSON.stringify(payload), 'utf8').toString('base64'));
                }
                return { id: r.id, status: 200 };
            }) });
        };
        const result = await buildIndex(ROOT_DRIVE_ITEM, () => {}, fetch, 'drive', namespace);
        assert.equal(result.schemaVersion, 1);
        assert.equal(result.count, 1);
        assert.deepEqual(listings.sort(), Object.keys(children).sort());
        assert.deepEqual(reads, new Set(Object.keys(names)));
        assert.deepEqual(writes, reads);
    }
});

it('opens an existing build 251 root without visiting descendants or rewriting the cloud cache', async () => {
    const cached: MusicData = {
        kind: 'MusicData', schemaVersion: 1, size: ROOT_DRIVE_ITEM.size,
        lastModifiedDateTime: 'older', cTag: 'older', eTag: 'older',
        folder: { id: ROOT_DRIVE_ITEM.id, children: { Album: { id: 'album', children: { 'Song.mp3': { id: 'song' } } } } },
        count: 1,
    };
    let batches = 0;
    let follows = 0;
    const fetch: AuthFetch = async (url, _retry, options) => {
        batches++;
        assert(url.endsWith('/$batch'));
        const { requests } = JSON.parse(String(options?.body));
        assert.deepEqual(requests.map((r: { method: string; id: string }) => [r.method, r.id]),
            [['GET', 'children-root-folder'], ['GET', 'cache-root-folder']]);
        assert.equal(requests[1].url, '/me/drive/special/approot:/primary/index.json:/content');
        return Response.json({ responses: [
            { id: 'children-root-folder', status: 200, body: { value: [{ id: 'album', name: 'Album', folder: {} }] } },
            { id: 'cache-root-folder', status: 302, headers: { Location: 'https://cdn.example/index' } },
        ] });
    };
    const result = await buildIndex(ROOT_DRIVE_ITEM, () => {}, fetch, 'drive', 'primary', async () => {
        follows++;
        return Response.json(cached);
    });
    assert.deepEqual(result, cached);
    assert.equal(batches, 1);
    assert.equal(follows, 1);
    assert(isCurrentIndex(cached, { ...ROOT_DRIVE_ITEM, id: 'other' }));
    assert(!isCurrentIndex({ ...cached, schemaVersion: 3 }, ROOT_DRIVE_ITEM));
    assert(!isCurrentIndex(cached, { ...ROOT_DRIVE_ITEM, size: 2 }));
});

it('invalid, unavailable, and malformed optional caches do not block a complete children listing', async () => {
    for (const cache of [
        { status: 302, headers: { Location: 'https://cdn.example/?sig=private' } },
        { status: 302, headers: {} },
        { status: 200, headers: { 'content-type': 'application/json' }, body: 'invalid-base64-!?' },
        { status: 503, headers: { 'Retry-After': '0' } },
    ]) {
        let calls = 0;
        const fetch: AuthFetch = async (url, _retry, options) => {
            calls++;
            assert(url.endsWith('/$batch'));
            const { requests } = JSON.parse(String(options?.body));
            return Response.json({ responses: requests.map(({ id }: { id: string }) => id.startsWith('cache-')
                ? { id, ...cache } : { id, status: 200, body: { value: [{ name: 'track.mp3', id: 'track', file: {}, size: 1 }] } }) });
        };
        const index = await buildIndex(ROOT_DRIVE_ITEM, () => {}, fetch, 'drive', 'primary',
            async () => new Response('sig=private', { headers: { 'Content-Type': 'application/json' } }));
        assert.equal(calls, 2);
        assert.equal(index.count, 1);
        assert.equal(index.folder.children['track.mp3'].id, 'track');
    }
});

it('bounds sustained envelope and subrequest throttling without enabling unbounded transport retries', async () => {
    for (const envelope of [true, false]) {
        let attempts = 0;
        const fetch: AuthFetch = async (_url, retry, options) => {
            attempts++;
            assert.equal(retry, false);
            assert(options?.signal);
            return envelope
                ? new Response(null, { status: 503, headers: { 'Retry-After': '0' } })
                : Response.json({ responses: [{ id: 'children-root-folder', status: 429, headers: { 'Retry-After': '0' } }] });
        };
        await assert.rejects(buildIndex(ROOT_DRIVE_ITEM, () => {}, fetch, 'drive', 'primary'), /still throttled/);
        assert.equal(attempts, 3);
    }
});

it('cancels both throttle backoff and an outstanding credential-free cache follow', async () => {
    for (const backoff of [true, false]) {
        const cancel = new AbortController();
        let calls = 0;
        const fetch: AuthFetch = async () => {
            calls++;
            if (backoff) {
                setImmediate(() => cancel.abort());
                return new Response(null, { status: 429, headers: { 'Retry-After': '30' } });
            }
            return Response.json({ responses: [{ id: 'cache-root-folder', status: 302,
                headers: { Location: 'https://cdn.example/content' } }] });
        };
        const follow = (_url: string, signal: AbortSignal): Promise<Response> => new Promise((_, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
            cancel.abort();
        });
        await assert.rejects(buildIndex(ROOT_DRIVE_ITEM, () => {}, fetch, 'drive', 'primary', follow, cancel.signal),
            { name: 'AbortError' });
        assert.equal(calls, 1);
    }
});

it('drains a dispatched cache write through its response body before disconnect completes', async () => {
    const cancel = new AbortController();
    let bodyRead = false;
    const fetch: AuthFetch = async (_url, _retry, options) => {
        const { requests } = JSON.parse(String(options?.body));
        if (!requests.some((r: { method: string }) => r.method === 'PUT')) return buildSuccessBatchResponse(options);
        cancel.abort();
        assert.equal(options?.signal?.aborted, false, 'an accepted cloud write must finish before DELETE');
        const response = buildSuccessBatchResponse(options);
        const read = response.text.bind(response);
        response.text = async () => {
            const body = await read();
            bodyRead = true;
            return body;
        };
        return response;
    };
    await assert.rejects(buildIndex(ROOT_DRIVE_ITEM, () => {}, fetch, 'drive', 'primary', undefined, cancel.signal),
        { name: 'AbortError' });
    assert(bodyRead);
});
