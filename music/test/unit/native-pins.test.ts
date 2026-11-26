import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createOfflinePins } from '../../src/native-pins.js';
import { createNativeLibrary } from '../../src/native-library.js';
import { type Favorite, type FolderPin, type RootsMap } from '../../src/favorites.js';

it('updates 500 pinned tracks in a 30k library without walking favorites again and retains a moved target', async () => {
    Object.assign(globalThis, {window: new EventTarget(), document: new EventTarget()});
    const tracks = Array.from({length: 30_000}, (_, i) => ['track-' + i, {id: String(i)}]);
    const children = Object.fromEntries(tracks.slice(0, 500));
    const other = Object.fromEntries(tracks.slice(500));
    let walks = 0, cursor = 0, ownerMessages = 0;
    const roots: RootsMap = new Map([['share:s', {type: 'share', key: 'share:s', name: 'Album', driveId: 'd',
        connectionId: 'first', reindexing: false, folder: {id: 'root', children: {
            Album: {id: 'folder', get children() { walks++; return children; }},
            Other: {id: 'other', get children() { walks++; return other; }},
        }}}]]);
    const favorite: Favorite = {id: 'f', name: 'Music', kind: 'shortcut', hasPrivatePlayback: false,
        target: {driveId:'d', sourceRootKey:'share:s', itemId:'folder', path:['Album'], isFolder:true}, offlinePin:{paused:false}};
    const owners: {complete: boolean; sources: Record<string, Record<string, string>>}[][] = [];
    let fragments = "";
    const api = createNativeLibrary({async postMessage(message) {
        if (message.action === 'ownerPart') {
            if (message.first) fragments = '';
            fragments += message.text;
            if (message.last) { owners.push(JSON.parse(fragments)); ownerMessages++; }
            return {};
        }
        return message.after === null ? {revision:0, files:{}, queuedCount:0, quota:2**30, total:0}
            : {revision:++cursor, added:{['d:' + cursor]:100}, queuedCount:500-cursor, quota:2**30, total:100 * cursor};
    }});
    const pins = createOfflinePins(api, () => {});
    const unpinned: Favorite = {...favorite, id:'library', offlinePin:undefined,
        target:{...favorite.target, itemId:'root', path:[]}};
    const folderPins: FolderPin[] = [{...favorite.target, isFolder:true, sourceRootKey:'share:s', connectionId:'first'}];
    const start = performance.now();
    // Sample across event-loop turns, including the final native bridge serialization.
    let last = start, longest = 0;
    const sample = () => { const now = performance.now(); longest = Math.max(longest, now - last); last = now; };
    const timer = setInterval(sample, 0);
    try { await pins.publishOwners([favorite, unpinned], folderPins, roots, new Set(), true, true); }
    finally { sample(); clearInterval(timer); }
    const before = walks;
    const walkMs = performance.now() - start;
    const deltas = performance.now();
    for (let i = 0; i < 200; i++) await pins.refresh();
    await pins.publishOwners([{...favorite, mode:'one'}, unpinned], folderPins, new Map(roots), new Set(), true, true);
    console.log('30k library, 500 pinned tracks, two overlapping owners, projection ms=' + walkMs.toFixed(1)
        + ', longest event-loop interval ms=' + longest.toFixed(1) + ', 200 completions ms=' + (performance.now()-deltas).toFixed(1));
    const progress = {total:500, downloaded:200, bytes:20_000, complete:true};
    assert.deepEqual(pins.favoriteProgress('f'), progress);
    const [folderId] = pins.getFolderCoverage().get(JSON.stringify(['share:s','first','Album']))!.owners;
    assert.deepEqual(pins.favoriteProgress(folderId), progress);
    assert.equal(pins.getFolderCoverage().get(JSON.stringify(['share:s','first']))?.partial, true);
    assert.equal(walks, before);
    assert.equal(ownerMessages, 1);
    assert.equal(owners[0].length, 2);
    await pins.publishOwners([{...favorite, target:{...favorite.target, path:['old folder']}}], folderPins, roots, new Set(), true, true);
    assert.equal(owners.at(-1)?.[0].complete, false);
    // An unavailable connected share retains the same owner for Swift's cold manifest.
    const root = roots.get('share:s')!;
    assert.ok(root.type === 'share');
    roots.set(root.key, {...root, folder: undefined});
    await pins.publishOwners([], folderPins, roots, new Set(), true, true);
    assert.deepEqual(owners.at(-1), [{id:folderId, paused:false, complete:false, sources:{}}]);
    roots.set(root.key, {...root, connectionId:'second'});
    await pins.publishOwners([], folderPins, roots, new Set(), true, true);
    assert.deepEqual(owners.at(-1), []);
    assert.equal(pins.getFolderCoverage().size, 0);
    // Favorites can outlive the local share list. Only a known empty membership
    // can remove the old owner, even when both projections see identical empty roots.
    roots.delete(root.key);
    await pins.publishOwners([], folderPins, roots, new Set(), true, false);
    assert.deepEqual(owners.at(-1), [{id:folderId, paused:false, complete:false, sources:{}}]);
    await pins.publishOwners([], folderPins, roots, new Set(), true, true);
    assert.deepEqual(owners.at(-1), []);
    await pins.publishOwners([], [], roots, new Set(), false, true);
    assert.equal(ownerMessages, 6);
});
