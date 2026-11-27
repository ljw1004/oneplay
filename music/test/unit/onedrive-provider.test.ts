import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createOneDriveProvider } from '../../src/onedrive-provider.js';
import type { AuthFetchOptions } from '../../src/auth.js';
import { MediaUnavailableError, ProviderHttpError } from '../../src/provider.js';

it('reads and writes existing primary app documents and separates absence from failed reads', async () => {
    let response = new Response('{"version":1}');
    const calls: Array<{ url: string; retry: boolean; options?: AuthFetchOptions }> = [];
    const { documents } = createOneDriveProvider(async (url, retry, options) => {
        calls.push({ url, retry, options });
        return response;
    });
    const text = await documents.read('favorites.json');
    assert.equal(text, '{"version":1}');
    response = new Response(null, { status: 204 });
    await documents.write('favorites.json', text);
    const path = 'https://graph.microsoft.com/v1.0/me/drive/special/approot:/favorites.json:/content';
    assert.deepEqual(calls, [
        { url: path, retry: false, options: undefined },
        { url: path, retry: false, options: { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: text } },
    ]);
    response = new Response(null, { status: 404 });
    assert.equal(await documents.read('shares.json'), null);
    response = new Response(null, { status: 503 });
    await assert.rejects(documents.read('shares.json'), ProviderHttpError);
    response = new Response();
    response.text = async () => { throw new Error('private body'); };
    await assert.rejects(documents.read('shares.json'), { message: 'shares:onedrive-load: body unreadable status=200' });
});

it('downloads the complete CDN body with the original signal and no Graph credentials', async () => {
    const signal = new AbortController().signal;
    const url = 'https://audio.example/recording';
    const { media } = createOneDriveProvider(async (request, retry, options) => {
        assert.match(request, /drives\/drive%20id\/items\/item%2Fid\?\$select=@microsoft\.graph\.downloadUrl$/);
        assert.equal(retry, false);
        assert.deepEqual(options, { signal });
        return Response.json({ '@microsoft.graph.downloadUrl': url });
    }, undefined, async (request, options) => {
        assert.equal(request, url);
        assert.equal(options?.signal, signal);
        assert.equal(new Headers(options?.headers).has('Authorization'), false);
        assert.notEqual(options?.credentials, 'include');
        return new Response(new Blob(['complete'], { type: 'audio/mpeg' }));
    });
    assert.equal(await (await media.download('drive id', 'item/id', signal)).text(), 'complete');
});

it('uses the encoded link when share metadata has no usable ID', async () => {
    const link = 'https://share.example/link';
    const token = 'u!' + Buffer.from(link).toString('base64url');
    let metadata = Response.json({ id: 'graph-id' });
    const provider = createOneDriveProvider(async () => metadata);
    assert.deepEqual(await provider.readShareIdentity(link), { shareId: 'graph-id', token });
    for (const response of [Response.json(null), Response.json({}), new Response('malformed')]) {
        metadata = response;
        assert.deepEqual(await provider.readShareIdentity(link), { shareId: token, token });
    }
});

it('propagates cancellation while reading a share identity body', async () => {
    const aborted = new DOMException('Body read canceled', 'AbortError');
    const metadata = new Response();
    metadata.text = async () => { throw aborted; };
    const provider = createOneDriveProvider(async () => metadata);
    await assert.rejects(provider.readShareIdentity('https://share.example/link'), error => error === aborted);
});

it('keeps missing media, returned errors and body failures distinct', async () => {
    let metadata = Response.json({});
    let content = new Response(null, { status: 404 });
    const signal = new AbortController().signal;
    const { media } = createOneDriveProvider(async () => metadata, undefined, async () => content);
    await assert.rejects(media.download('drive', 'song', signal), MediaUnavailableError);
    metadata = new Response(null, { status: 401 });
    await assert.rejects(media.download('drive', 'song', signal), { status: 401 });
    metadata = Response.json({ '@microsoft.graph.downloadUrl': 'https://audio.example/item' });
    await assert.rejects(media.download('drive', 'song', signal), { status: 404 });
    metadata = Response.json({ '@microsoft.graph.downloadUrl': 'https://audio.example/item' });
    content = new Response();
    const failure = new TypeError('Failed to fetch body');
    content.blob = async () => { throw failure; };
    await assert.rejects(media.download('drive', 'song', signal), error => error === failure);
});
