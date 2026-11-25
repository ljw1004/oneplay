import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createNativeLibrary } from '../../src/native-library.js';

it('preserves caller options, response metadata and empty bodies on the native bridge', async () => {
    let sent: Record<string, unknown> = {};
    const native = createNativeLibrary({ async postMessage(message) {
        sent = message;
        return { status: 204, statusText: 'No Content', headers: { ETag: 'version' }, body: '' };
    } });
    const response = await native.fetch('https://graph.microsoft.com/v1.0/$batch', true, {
        method: 'POST', body: '{}', headers: { Prefer: 'redeemSharingLink', 'Content-Type': 'application/json' },
        cache: 'no-store', timeoutMs: 6000,
    });
    assert.match(String(sent.id), /^[\da-f-]{36}$/i);
    assert.deepEqual({ ...sent, id: '' }, {
        op: 'request', id: '', url: 'https://graph.microsoft.com/v1.0/$batch', retryOn429: true,
        follow: false, method: 'POST', headers: { prefer: 'redeemSharingLink', 'content-type': 'application/json' },
        body: '{}', cache: 'no-store', timeoutMs: 6000,
    });
    assert.equal(response.status, 204);
    assert.equal(response.statusText, 'No Content');
    assert.equal(response.headers.get('etag'), 'version');
    assert.equal(response.body, null);
});

it('reassembles a 30k-track index, including a multibyte character split at a chunk boundary', async () => {
    const tracks = Array.from({ length: 30_000 }, (_, i) => `曲-${i}`);
    const source = JSON.stringify({ padding: 'a'.repeat(256 * 1024 - 13) + '🎵', tracks });
    const bytes = Buffer.from(source);
    assert.equal(bytes[256 * 1024] >> 6, 2, 'boundary splits a UTF-8 character');
    let offset = 0;
    let id: unknown;
    const native = createNativeLibrary({ async postMessage(message) {
        if (message.op === 'request') {
            id = message.id;
            assert.equal(message.follow, true);
            return { status: 200, statusText: 'OK', headers: { 'Content-Type': 'application/json' }, chunked: true };
        }
        assert.equal(message.op, 'chunk');
        assert.equal(message.id, id);
        const chunk = bytes.subarray(offset, offset + 256 * 1024);
        offset += chunk.length;
        return { body: chunk.toString('base64'), done: offset === bytes.length };
    } });
    const result = await native.followContent('https://cdn.example/index');
    assert.equal(await result.text(), source);
    assert.equal(offset, bytes.length);
});

it('aborting an in-flight chunk releases the native spool and ignores a late reply', async () => {
    const controller = new AbortController();
    const ops: unknown[] = [];
    const native = createNativeLibrary({ async postMessage(message) {
        ops.push(message.op);
        if (message.op === 'request') return { status: 200, headers: {}, chunked: true };
        if (message.op === 'chunk') controller.abort();
        return { body: 'YQ==', done: true };
    } });
    await assert.rejects(native.fetch('https://graph.microsoft.com/v1.0/me', false, { signal: controller.signal }),
        { name: 'AbortError' });
    assert.deepEqual(ops, ['request', 'chunk', 'abort']);
    await assert.rejects(native.fetch('https://graph.microsoft.com/v1.0/me', false, { signal: controller.signal }),
        { name: 'AbortError' });
    assert.equal(ops.length, 3);
});

it('aborts promptly while another caller still owns the shared SDK acquisition', async () => {
    const controller = new AbortController();
    const ops: unknown[] = [];
    let release!: (value: unknown) => void;
    const sdk = new Promise(resolve => { release = resolve; });
    const native = createNativeLibrary({ async postMessage(message) {
        ops.push(message.op);
        if (message.op === 'request') return sdk;
    } });
    const fetch = native.fetch('https://graph.microsoft.com/v1.0/me', false, { signal: controller.signal });
    controller.abort();
    await assert.rejects(fetch, { name: 'AbortError' });
    assert.deepEqual(ops, ['request', 'abort']);
    release({ status: 200, chunked: true });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(ops, ['request', 'abort'], 'a late response must never read a chunk');
});
