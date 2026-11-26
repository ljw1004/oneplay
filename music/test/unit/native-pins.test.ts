import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createNativePins } from '../../src/native-pins.js';
import { createNativeLibrary } from '../../src/native-library.js';
import type { Favorite, RootsMap } from '../../src/favorites.js';

it('drains pin completions in a 30k library without walking membership again and retains a moved target', async () => {
    Object.assign(globalThis, {window: new EventTarget(), document: new EventTarget()});
    const children = Object.fromEntries(Array.from({length: 30_000}, (_, i) => ['track-' + i, {id: String(i)}]));
    let walks = 0, cursor = 0, ownerMessages = 0;
    const roots: RootsMap = new Map([['share:s', {type: 'share', key: 'share:s', name: 'Album', driveId: 'd',
        reindexing: false, folder: {id: 'folder', get children() { walks++; return children; }}}]]);
    const favorite: Favorite = {id: 'f', name: 'Music', kind: 'shortcut', hasPrivatePlayback: false,
        target: {driveId:'d', sourceRootKey:'share:s', itemId:'folder', path:[], isFolder:true}, offlinePin:{paused:false}};
    const owners: {complete: boolean; sources: Record<string,string[]>}[][] = [];
    let fragments = "";
    const api = createNativeLibrary({async postMessage(message) {
        if (message.action === 'ownerPart') {
            if (message.first) fragments = '';
            fragments += message.text;
            if (message.last) { owners.push(JSON.parse(fragments)); ownerMessages++; }
            return {};
        }
        if (message.action === 'owners') { owners.push(message.owners as typeof owners[number]); ownerMessages++; return {}; }
        return message.after === null ? {revision:0, files:{}, missing:[], quota:2**30, total:0}
            : {revision:++cursor, added:{['d:' + cursor]:100}, quota:2**30, total:100 * cursor};
    }});
    const pins = createNativePins(api, () => {});
    const start = performance.now();
    await pins.publishOwners([favorite], roots, new Set(), true);
    const before = walks;
    const walkMs = performance.now() - start;
    const deltas = performance.now();
    for (let i = 0; i < 200; i++) await pins.refresh();
    console.log('30k tracks, projection ms=' + walkMs.toFixed(1) + ', 200 completions ms=' + (performance.now()-deltas).toFixed(1));
    assert.deepEqual(pins.favoriteProgress('f'), {total:30_000, downloaded:200, bytes:20_000, complete:true});
    assert.equal(walks, before);
    assert.equal(ownerMessages, 1);
    await pins.publishOwners([{...favorite, target:{...favorite.target, path:['old folder']}}], roots, new Set(), true);
    assert.equal(owners.at(-1)?.[0].complete, false);
    await pins.publishOwners([], roots, new Set(), false);
    assert.equal(ownerMessages, 2);
});

it('keeps both edit and refresh pending through the winning owner write and propagates its rejection', async () => {
    Object.assign(globalThis, {window: new EventTarget(), document: new EventTarget()});
    const writes: Array<{accept: () => void; reject: () => void}> = [];
    const api = createNativeLibrary({async postMessage(message) {
        if (message.action !== 'owners') return {revision:1, files:{}, total:0, quota:2**30};
        return new Promise((resolve, reject) => writes.push({accept: () => resolve(true), reject: () => reject(new Error('disk full'))}));
    }});
    const pins = createNativePins(api, () => {});
    const playlist: Favorite = {id:'f', kind:'playlist', name:'Mix', members:[], offlinePin:{paused:false}, hasPrivatePlayback:false};
    const roots: RootsMap = new Map();
    const edit = pins.publishOwners([], roots, new Set(), true);
    const refresh = pins.publishOwners([playlist], roots, new Set(), true);
    const result = Promise.allSettled([edit,refresh]);
    assert.equal(writes.length, 2);
    writes[0].accept();
    writes[1].reject();
    assert.deepEqual((await result).map(r => r.status), ['rejected','rejected']);
    const retry = pins.publishOwners([playlist], roots, new Set(), true);
    writes[2].accept();
    await retry;
});
