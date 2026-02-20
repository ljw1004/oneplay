/**
 * Unit tests for media-title.ts.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanMediaSessionTitle, stripAudioExtension } from '../../src/media-title.js';

describe('stripAudioExtension', () => {
    it('removes known audio extensions case-insensitively', () => {
        assert.equal(stripAudioExtension('Track.MP3'), 'Track');
        assert.equal(stripAudioExtension('Track.flac'), 'Track');
    });

    it('leaves non-audio extensions unchanged', () => {
        assert.equal(stripAudioExtension('Track.txt'), 'Track.txt');
    });
});

describe('cleanMediaSessionTitle', () => {
    it('iteratively removes album prefix, bracket index, and numeric prefix', () => {
        assert.equal(
            cleanMediaSessionTitle('Heroic Anthems [01] 01 - Track Title.mp3', 'Heroic Anthems'),
            'Track Title',
        );
    });

    it('can remove repeated album prefixes across multiple passes', () => {
        assert.equal(
            cleanMediaSessionTitle('Heroic Anthems - Heroic Anthems [01] Track Title.mp3', 'Heroic Anthems'),
            'Track Title',
        );
    });

    it('does not remove album text that appears mid-title', () => {
        assert.equal(
            cleanMediaSessionTitle('Track about Heroic Anthems.mp3', 'Heroic Anthems'),
            'Track about Heroic Anthems',
        );
    });

    it('falls back to original extension-stripped title if stripping empties the string', () => {
        assert.equal(cleanMediaSessionTitle('[01].mp3', ''), '[01]');
    });

    it('strips simple numeric track prefixes', () => {
        assert.equal(cleanMediaSessionTitle('01 Track Title.mp3', ''), 'Track Title');
        assert.equal(cleanMediaSessionTitle('2 - Track Title.mp3', ''), 'Track Title');
    });

    it('does not strip year-like numeric titles', () => {
        assert.equal(cleanMediaSessionTitle('1999.mp3', ''), '1999');
    });
});

