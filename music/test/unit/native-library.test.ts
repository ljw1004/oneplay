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

it('rebases current source evidence, drops superseded probes and requires the verified account proof', async () => {
    const calls: Record<string, unknown>[] = [];
    let revision = 8;
    let conflict = true;
    const native = createNativeLibrary({async postMessage(m) {
        calls.push(m);
        if (m.action === 'snapshot') return {subscription: 'doc', snapshot: {accessRevision: revision}};
        assert.equal(m.subscription, 'doc');
        if (conflict) { revision++; conflict = false; }
        const staleProof = m.proof === 'expired';
        const applied = !staleProof && m.base === revision;
        if (applied) revision++;
        return {subscription: 'doc', applied, staleProof, snapshot: {accessRevision: revision}};
    }});
    const response = (proof: string) => new Response('', {status: 403, headers: {'X-OnePlay-Account-Proof': proof}});
    const connected = () => true;
    const before = native.beginSourceProbe('share:album');
    const latest = native.beginSourceProbe('share:album');
    assert.equal(await before(response('old'), false, connected), false);
    assert.equal(await latest(new Response('', {status: 401, headers: {'X-OnePlay-Account-Error': 'interactionRequired'}}), false, connected), false);
    assert.equal(await latest(new Response('', {status: 403}), false, connected), false);
    assert.equal(calls.length, 0);
    assert.equal(await latest(response('current'), true, connected), true);
    assert.deepEqual(calls.filter(m => m.action === 'access').map(m => [m.base, m.allowed, m.proof]),
        [[8, ['share:album'], 'current'], [9, ['share:album'], 'current']]);
    assert.equal(await native.beginSourceProbe('share:album')(response('expired'), false, connected), false);
    assert.equal(calls.length, 4, 'account renewal invalidated the old probe without another submission');
    assert.equal(await native.beginSourceProbe('share:album')(response('removed'), true, () => false), false);
    assert.equal(calls.length, 4, 'a query from a disconnected record cannot grant its replacement access');
});

it('commits disconnect before reconnect, then ignores a reply belonging to another document', async () => {
    const sent: Record<string, unknown>[] = [];
    let didEnter!: () => void, resume!: () => void;
    const entered = new Promise<void>(resolve => { didEnter = resolve; });
    const released = new Promise<void>(resolve => { resume = resolve; });
    let revision = 5;
    let currentDocument = 'original';
    const native = createNativeLibrary({async postMessage(m) {
        if (m.action === 'snapshot') return {subscription: currentDocument, snapshot: {accessRevision: revision}};
        sent.push(m);
        if (m.disconnected) { didEnter(); await released; }
        const applied = m.subscription === currentDocument && m.base === revision;
        if (applied) revision++;
        return {subscription: currentDocument, applied, snapshot: {accessRevision: revision}};
    }});
    const first = native.syncPlaybackMembership([], 'share:s');
    await entered;
    const second = native.syncPlaybackMembership(['share:s']);
    resume();
    await Promise.all([first, second, native.waitForPlaybackAccess()]);
    await native.syncPlaybackMembership(['share:s']);
    assert.deepEqual(sent.map(m => [m.base, m.connected, m.disconnected]), [[5, [], ['share:s']], [6, ['share:s'], undefined]]);
    const probe = native.beginSourceProbe('share:s');
    currentDocument = 'replacement';
    await assert.rejects(probe(new Response('', {headers: {'X-OnePlay-Account-Proof':'old'}}), false, () => true),
        /document was replaced/);
    assert.equal(revision, 7);
    assert.equal(sent.length, 3, 'the old document cannot rebase a denial onto the replacement subscription');
});

it('requires a failed denial to reach Swift before admitting playback even after another share succeeds', async () => {
    let fail = true, revision = 0;
    const denied: string[] = [];
    const native = createNativeLibrary({async postMessage(m) {
        if (m.action === 'snapshot') return {subscription:'doc', snapshot:{accessRevision:0}};
        if ((m.denied as string[]).length) {
            if (fail) throw Error('Access write unavailable');
            denied.push(...m.denied as string[]);
        }
        return {subscription:'doc', applied:true, snapshot:{accessRevision:++revision}};
    }});
    const response = new Response('', {headers:{'X-OnePlay-Account-Proof':'verified'}});
    await assert.rejects(native.beginSourceProbe('share:book')(response, false, () => true));
    assert.equal(await native.beginSourceProbe('share:music')(response, true, () => true), true);
    await native.waitForPlaybackAccess(root => root === 'share:music');
    await assert.rejects(native.waitForPlaybackAccess(), /Access write unavailable/);
    fail = false;
    await native.waitForPlaybackAccess();
    await native.waitForPlaybackAccess();
    assert.deepEqual(denied, ['share:book']);
});

it('discards a retired account proof, and releases a superseded failed denial only after newer evidence arrives', async () => {
    let revision = 0, fail = true;
    const native = createNativeLibrary({async postMessage(m) {
        if (m.action === 'snapshot') return {subscription:'doc', snapshot:{accessRevision:revision}};
        if (fail) throw Error('Access write unavailable');
        const staleProof = m.proof === 'old';
        if (!staleProof) revision++;
        return {subscription:'doc', applied:!staleProof, staleProof, snapshot:{accessRevision:revision}};
    }});
    const response = (proof: string) => new Response('', {headers:{'X-OnePlay-Account-Proof':proof}});
    const root = 'share:book';
    await assert.rejects(native.beginSourceProbe(root)(response('old'), false, () => true));
    fail = false;
    await native.waitForPlaybackAccess();
    assert.equal(revision, 0, 'Swift discarded the retired proof without changing access');

    fail = true;
    await assert.rejects(native.beginSourceProbe(root)(response('current'), false, () => true));
    const newer = native.beginSourceProbe(root);
    fail = false;
    await assert.rejects(native.waitForPlaybackAccess(), /Waiting for confirmed playback access/);
    await native.waitForPlaybackAccess(k => k !== root);
    assert.equal(await newer(response('current'), true, () => true), true);
    await native.waitForPlaybackAccess();
    assert.equal(revision, 1);
});
