/**
 * MediaSession title cleanup heuristics.
 *
 * Invariant: this module is pure string-in/string-out logic with no side effects,
 * so it can be unit tested independently from playback UI concerns.
 */

const AUDIO_EXTENSION_RE = /\.(mp3|m4a|flac|wav|ogg|aac|wma|opus|aiff?)$/i;
const LEADING_SEPARATOR_RE = /^[\s._\-:|]+/;
const LEADING_BRACKET_INDEX_RE = /^\s*[\[(]\s*(?:(?:track|trk|disc|disk|cd)\s*)?\d{1,3}[a-z]?\s*[\])]\s*[-._:|)]*\s*/i;
const LEADING_NUMERIC_INDEX_RE = /^\s*(?:(?:track|trk|disc|disk|cd)\s*)?\d{1,3}[a-z]?(?:\s*[-._:|)]\s*|\s+(?=[A-Za-z]))+/i;
const MAX_STRIP_PASSES = 12;

/** Strip common audio file extensions. */
export const stripAudioExtension = (name: string): string =>
    name.replace(AUDIO_EXTENSION_RE, '');

const escapeRegExp = (s: string): string =>
    s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const stripAlbumPrefixOnce = (title: string, album: string): string => {
    const tokens = album.trim().split(/[\s._\-:|]+/).filter((s) => s.length > 0);
    if (tokens.length === 0) return title;
    const pattern = `^\\s*${tokens.map(escapeRegExp).join('[\\s._\\-:|]+')}(?=$|[\\s._\\-:|\\[(])`;
    const re = new RegExp(pattern, 'i');
    const withoutAlbum = title.replace(re, '');
    return withoutAlbum === title
        ? title
        : withoutAlbum.replace(LEADING_SEPARATOR_RE, '').trimStart();
};

const stripOneLeadingNoiseComponent = (title: string, album: string): string => {
    const withoutAlbum = stripAlbumPrefixOnce(title, album);
    if (withoutAlbum !== title) return withoutAlbum;

    const withoutBracketIndex = title.replace(LEADING_BRACKET_INDEX_RE, '');
    if (withoutBracketIndex !== title) return withoutBracketIndex.trimStart();

    const withoutNumericIndex = title.replace(LEADING_NUMERIC_INDEX_RE, '');
    if (withoutNumericIndex !== title) return withoutNumericIndex.trimStart();

    const withoutSeparators = title.replace(LEADING_SEPARATOR_RE, '').trimStart();
    return withoutSeparators !== title ? withoutSeparators : title;
};

/**
 * Cleans noisy track names for lock-screen/car metadata.
 *
 * Strategy: repeatedly remove one leading noise component (album prefix,
 * bracketed index, numeric index, separators) until stable. Escape hatch:
 * if stripping would erase the title, fall back to the original extension-
 * stripped title.
 */
export const cleanMediaSessionTitle = (rawTitle: string, album: string): string => {
    const original = stripAudioExtension(rawTitle).trim();
    if (original.length === 0) return '';

    let current = original;
    for (let i = 0; i < MAX_STRIP_PASSES; i += 1) {
        const next = stripOneLeadingNoiseComponent(current, album).trim();
        if (next === current) break;
        if (next.length === 0) return original;
        current = next;
    }

    const cleaned = current.replace(/\s+/g, ' ').trim();
    return cleaned.length === 0 ? original : cleaned;
};

