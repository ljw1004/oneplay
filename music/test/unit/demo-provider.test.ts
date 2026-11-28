import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createDemoMedia, DEMO_SOURCE, parseDemoCatalog } from '../../src/demo-provider.js';
import { walkFolder } from '../../src/indexer.js';

const mediaCommit = 'a'.repeat(40);
const blob = 'b'.repeat(40);
const path = "Été/100% #?'/Élan: live (take 1).mp3";
const track = {path, bytes: 1234, blob};

describe('demo catalog', () => {
    it('preserves the spelling and derives independent byte and URL revisions', async () => {
        const first = parseDemoCatalog({schemaVersion: 1, mediaCommit, tracks: [track]});
        const file = walkFolder(first.folder, path.split('/').slice(0, -1))?.children[path.split('/').at(-1)!];
        assert.ok(file);
        const encoded = '%C3%89t%C3%A9/100%25%20%23%3F%27/%C3%89lan%3A%20live%20%28take%201%29.mp3';
        assert.equal(file.id, blob + '-' + encoded);
        const media = createDemoMedia(() => first);
        assert.deepEqual(await media.playbackUrl(DEMO_SOURCE, file.id), {
            url: 'https://raw.githubusercontent.com/ljw1004/oneplay-test/' + mediaCommit + '/Music/' + encoded,
        });
        const unrelated = parseDemoCatalog({schemaVersion: 1, mediaCommit: 'c'.repeat(40), tracks: [track]});
        assert.ok(unrelated.recordings.has(file.id));
        const replacement = parseDemoCatalog({schemaVersion: 1, mediaCommit, tracks: [{...track, blob: 'd'.repeat(40)}]});
        assert.ok(!replacement.recordings.has(file.id));
    });

    it('rejects corrupt, ambiguous and colliding paths before returning any snapshot', () => {
        const parse = (tracks: unknown[]) => parseDemoCatalog({schemaVersion: 1, mediaCommit, tracks});
        for (const [a, b] of [
            ['x.mp3', 'x.mp3/song.mp3'], ['É/x.mp3', 'E\u0301/y.mp3'], ['same.mp3', 'same.mp3'],
        ]) assert.throws(() => parse([{...track, path: a}, {...track, path: b}]));
        for (const path of ['/x.mp3', 'a/../x.mp3', 'a\\x.mp3', 'a/\ud800.mp3']) {
            assert.throws(() => parse([{...track, path}]));
        }
        assert.throws(() => parse([{...track, bytes: 0}]));
        assert.throws(() => parseDemoCatalog({schemaVersion: 2, mediaCommit, tracks: [track]}));
        assert.equal(Object.getPrototypeOf(parse([{...track, path: '__proto__/x.mp3'}]).folder.children), null);
    });

    it('spells delimiter and suffix fixtures exactly as the native catalog does', () => {
        const catalog = parseDemoCatalog({schemaVersion: 1, mediaCommit, tracks: [
            {...track, path: 'A/\u0301Tune.mp3'}, {...track, path: 'a\u0600.mp3'},
        ]});
        assert.ok(catalog.recordings.has(blob + '-A/%CC%81Tune.mp3'));
        assert.ok(catalog.recordings.has(blob + '-a%D8%80.mp3'));
    });
});
