/**
 * Playback orchestration for OnePlay Music.
 *
 * State model:
 * - `playbackFolder`: folder whose recursive descendants define the queue.
 * - `playbackTrack`: current logical track path being loaded/played.
 * - `currentTrackIdx`: index of `playbackTrack` in `trackList` (`-1` when none).
 * - `trackList`: logical paths through favorites/accounts; physical resolution
 *   is deferred until `playNext` so queue identity matches tree navigation.
 * - `playbackMode`: global default `'all'`, with per-favorite overrides.
 *
 * Architectural invariants:
 * - `playbackTrack === trackList[currentTrackIdx]` when both are defined.
 * - `trackList` stores logical paths; physical file resolution happens in `playNext`.
 * - UI play/pause state is driven by media events, not optimistic button toggles.
 * - `onPlaybackChange` is the single outbound state-change signal to the tree.
 */
import { type FolderPath } from './tree.js';
import { log, logError, logCatch } from './logger.js';
import { type Favorites, type Favorite, type RootsMap } from './favorites.js';
import { dbGet } from './db.js';
import { type EvidenceState, type AuthFetch } from './auth.js';
import { type TimerDuration } from './settings.js';
import { resolvePathTailDisplayName } from './path-names.js';
import {
    type PlaybackUiController,
    createPlaybackUi,
    timeString,
} from './playback-ui.js';
import {
    PlaybackUrlEngine,
    buildFavoritePlaybackStorageValue,
    buildGlobalPlaybackStorageValue,
    computeFirstPlayableIdxAfterReshuffle,
    computeNextIdx,
    computePrevIdx,
    deriveMediaSessionFields,
    fetchDownloadUrl,
    findFirstPlayableIdxIn as findFirstPlayableIdxInList,
    findNextPlayableIdxAfter as findNextPlayableIdxAfterInList,
    findNextPlayableIdxWrapped as findNextPlayableIdxWrappedInList,
    getMediaSessionPositionState,
    inTerminalEvidenceState,
    isTrackPlayableNow,
    parseFavoritePlaybackStorageValue,
    pickRestoreCandidate,
    reduceRefreshedTrackList,
    shuffleTrackList as shuffleTrackListPure,
    timerDurationMs,
} from './playback-engine.js';
import {
    type AccountsMap,
    collectTracks, collectLogicalTracks,
    resolveTrack, resolveLogicalTrack, resolveFolderFromPath,
    resolveTrackIds,
} from './tracks.js';
import { type Downloads } from './downloads.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Playback modes. Owned by playback; favorites persists this value. */
export type PlaybackMode = 'one' | 'timer' | 'all' | 'repeat' | 'shuffle';
const MODES: readonly PlaybackMode[] = ['one', 'timer', 'all', 'repeat', 'shuffle'];
export const isValidMode = (s: unknown): s is PlaybackMode =>
    typeof s === 'string' && (MODES as readonly string[]).includes(s);

/** Re-export AccountsMap so callers importing from playback.ts remain stable. */
export type { AccountsMap } from './tracks.js';

/** Tree-facing playback info used for row indicators. */
export interface PlaybackInfo {
    readonly folder: FolderPath;
    readonly track: FolderPath;
    readonly phase: 'loading' | 'loaded';
}

export interface Playback {
    /** Current playback state, or undefined when nothing is selected. */
    getInfo(): PlaybackInfo | undefined;
    /** Play a specific track and update folder context if needed. */
    playTrack(path: FolderPath, accounts: AccountsMap): void;
    /** Build folder queue and play first playable entry. */
    playFolder(path: FolderPath, accounts: AccountsMap): Promise<void>;
    /** Collapse expanded controls (used when entering select mode). */
    collapse(): void;
    /** Update favorites/roots references for logical traversal. */
    setContext(favorites: Favorites, roots: RootsMap): void;
    /** Set downloads ref for offline-blob checks. */
    setDownloads(downloads: Downloads): void;
    /** Update timer duration backing timer mode. */
    setTimerDuration(duration: TimerDuration): void;
    /** Provide evidence state and cache/block predicates for playability checks. */
    setAvailabilityContext(
        state: EvidenceState,
        isTrackCached: (path: FolderPath) => boolean,
        isTrackBlocked?: (path: FolderPath) => boolean,
    ): void;
    /** Restore visual state without eagerly loading audio on startup. */
    restoreVisualState(
        folder: FolderPath, track: FolderPath, mode: PlaybackMode,
        expandedState: boolean, time: number,
        favId?: string, accounts?: AccountsMap,
    ): void;
    /** Called when user clicks the footer chevron indicator. Wired by index.ts. */
    onChevronClick: () => void;
    /** Called after every playback state change. Wired by index.ts → tree.setPlaybackInfo. */
    onPlaybackChange: (info: PlaybackInfo | undefined) => void;
    /** Called when expanded state changes. Wired by index.ts to persist oneplay_music_view. */
    onExpandedChange: (expanded: boolean) => void;
    /** Called when folder play is user-triggered but no playable tracks exist. */
    onPlayBlockedNoPlayableTracks: (path: FolderPath) => void;
}

/** Legacy IDB shape used for M9 fallback reads during migration. */
interface PerFavoritePlaybackState {
    readonly trackPath: readonly string[];
    readonly currentTime: number;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

const pathEquals = (a: FolderPath, b: FolderPath): boolean =>
    a.length === b.length && a.every((s, i) => s === b[i]);

// Prefix test intentionally uses exact segment equality so logical-path
// comparisons remain stable even when names contain similar substrings.
const pathStartsWith = (path: FolderPath, prefix: FolderPath): boolean =>
    path.length >= prefix.length && prefix.every((s, i) => s === path[i]);
export function createPlayback(
    audioEl: HTMLAudioElement,
    footerEl: HTMLElement,
    authFetch: AuthFetch,
): Playback {
    // -----------------------------------------------------------------------
    // State
    // -----------------------------------------------------------------------

    // -- Core state ----------------------------------------------------------
    // Queue + active-track state owned by playback.
    let playbackFolder: FolderPath | undefined;
    let playbackTrack: FolderPath | undefined;
    let phase: 'loading' | 'loaded' = 'loading';
    let trackList: FolderPath[] = [];
    let currentTrackIdx = -1;
    let asyncCounter = 0;
    // Integration harness watches this for deterministic readiness checks.
    const bumpTestPlaybackSeq = (): void => {
        const w = window as unknown as Record<string, unknown>;
        const current = typeof w._testPlaybackSeq === 'number' ? w._testPlaybackSeq as number : 0;
        w._testPlaybackSeq = current + 1;
    };

    // -- Playback mode state -------------------------------------------------
    // INVARIANT: playbackMode is the active mode. Global default is 'all'.
    // When playing within a hasPrivatePlayback favorite, mode is loaded from
    // the favorite and restored on re-entry. On exit, it reverts to 'all'.
    // Timer mode requires deadline bookkeeping; non-timer modes ignore it.
    let playbackMode: PlaybackMode = 'all';
    let timerDurationSetting: TimerDuration = '30m';
    let timerDeadlineMs: number | undefined;
    let suppressTimerPauseClear = false;

    // -- Per-favorite playback state ----------------------------------------
    // INVARIANT: activeFavId is set when playing within a favorite (path[1]
    // starts with "fav:"). activeFavHasPrivatePlayback tracks whether to
    // save/restore mode and track/time position.
    let activeFavId: string | undefined;
    let activeFavHasPrivatePlayback = false;
    let lastSavedTimeBucket = -1;
    // -- Cold-start restore state (M10) -------------------------------------
    // INVARIANT: restoredCurrentTime is set by restoreVisualState and consumed
    // by the cold-start play path on first explicit play. Cleared on success.
    let restoredCurrentTime: number | undefined;

    // -- Favorites/roots context (set via setContext) -----------------------
    // INVARIANT: favoritesRef and rootsRef are updated on every favorites
    // change, so logical resolution stays aligned with the tree graph.
    let favoritesRef: Favorites | undefined;
    let rootsRef: RootsMap = new Map();

    // -- Downloads reference (set via setDownloads) -------------------------
    // Used to check offline cache before streaming in playNext().
    let downloadsRef: Downloads | undefined;

    // -- Availability evidence -----------------------------------------------
    // In terminal evidence states, non-cached tracks are treated as unavailable.
    let evidenceState: EvidenceState = 'no-evidence';
    let isTrackCachedFn: (path: FolderPath) => boolean = () => false;
    let isTrackBlockedFn: (path: FolderPath) => boolean = () => false;

    // -- URL / prefetch subsystem --------------------------------------------
    const urlEngine = new PlaybackUrlEngine(authFetch);

    // Centralized playability predicate keeps ended/next/prev/folder-play aligned.
    const isTrackPlayableNowInContext = (path: FolderPath): boolean =>
        isTrackPlayableNow(path, evidenceState, isTrackCachedFn, isTrackBlockedFn);

    /** Finds first playable index in trackList. */
    const findFirstPlayableIdx = (): number | undefined =>
        findFirstPlayableIdxInList(trackList, isTrackPlayableNowInContext);
    /** Finds next playable index after idx (no wrap). */
    const findNextPlayableIdxAfter = (idx: number): number | undefined =>
        findNextPlayableIdxAfterInList(trackList, idx, isTrackPlayableNowInContext);
    /** Finds next playable index with wrap. If idx < 0, returns first playable. */
    const findNextPlayableIdxWrapped = (idx: number): number | undefined =>
        findNextPlayableIdxWrappedInList(trackList, idx, isTrackPlayableNowInContext);
    /** Finds first playable index in provided list. */
    const findFirstPlayableIdxIn = (list: readonly FolderPath[]): number | undefined =>
        findFirstPlayableIdxInList(list, isTrackPlayableNowInContext);
    /** Computes next playable index for ended/prefetch given mode + position. */
    const computeNextTrackIdx = (): number | undefined =>
        computeNextIdx(playbackMode, currentTrackIdx, trackList, isTrackPlayableNowInContext);

    // -- Timer helpers -------------------------------------------------------
    // Timer state is modeled as an optional absolute deadline.
    const armTimerFromNowIfPlaying = (reason: string): void => {
        if (playbackMode !== 'timer' || audioEl.paused) return;
        const durationMs = timerDurationMs(timerDurationSetting);
        timerDeadlineMs = durationMs === undefined ? undefined : Date.now() + durationMs;
        log(`timer: armed (${reason}) duration=${timerDurationSetting} deadline=${timerDeadlineMs ?? 'end-of-track'}`);
    };

    const clearTimerDeadline = (reason: string): void => {
        const hadTimerState = timerDeadlineMs !== undefined || suppressTimerPauseClear;
        timerDeadlineMs = undefined;
        suppressTimerPauseClear = false;
        if (hadTimerState) log(`timer: cleared (${reason})`);
    };

    const isTimerExpiredNow = (nowMs: number): boolean =>
        timerDurationMs(timerDurationSetting) !== undefined
        && timerDeadlineMs !== undefined
        && nowMs >= timerDeadlineMs;

    const expireTimerAndPauseInPlace = (reason: string): void => {
        const trackName = playbackTrack ? playbackTrack[playbackTrack.length - 1] : '<none>';
        log(`timer: fired (${reason}) track=${trackName} at=${audioEl.currentTime.toFixed(2)}s`);
        clearTimerDeadline(`expire:${reason}`);
        audioEl.pause();
        updateFooter();
        view.onPlaybackChange(getInfo()!);
    };

    const rearmTimerFromUserInteractionIfPlaying = (reason: string): void => {
        if (playbackMode !== 'timer') return;
        clearTimerDeadline(`user:${reason}`);
        armTimerFromNowIfPlaying(`user:${reason}`);
    };
    // -- Local seek state ----------------------------------------------------
    // INVARIANT: localSeekTarget is meaningful only while seekDebounceTimer is
    // active. Multiple rapid taps read localSeekTarget instead of potentially
    // stale audioEl.currentTime.
    let localSeekTarget: number | null = null;
    let seekDebounceTimer: ReturnType<typeof setTimeout> | null = null;

    const cancelSeekDebounce = (): void => {
        if (seekDebounceTimer !== null) {
            clearTimeout(seekDebounceTimer);
            seekDebounceTimer = null;
        }
        localSeekTarget = null;
    };

    /** Queue shuffle wrapper preserving current-track semantics. */
    const shuffleTrackList = (): void => {
        const shuffled = shuffleTrackListPure({
            trackList,
            currentTrackIdx,
            random: Math.random,
        });
        trackList = shuffled.trackList;
        currentTrackIdx = shuffled.currentTrackIdx;
    };
    /** Recomputes trackList from current state and re-finds currentTrackIdx. */
    const refreshTrackList = (): void => {
        if (!playbackFolder) return;
        let fresh: FolderPath[];
        if (playbackFolder[1]?.startsWith('fav:') && favoritesRef) {
            fresh = collectLogicalTracks(playbackFolder, accountsRef, favoritesRef, rootsRef);
        } else {
            const folder = resolveFolderFromPath(playbackFolder, accountsRef);
            if (!folder) return;
            fresh = collectTracks(playbackFolder, folder);
        }
        const reduced = reduceRefreshedTrackList({
            freshTrackList: fresh,
            prevTrackList: trackList,
            playbackTrack,
            playbackMode,
            pathEquals,
            random: Math.random,
        });
        trackList = reduced.trackList;
        currentTrackIdx = reduced.currentTrackIdx;
    };

    let playFolderCounter = 0;

    // -- Per-favorite state persistence -------------------------------------
    // Storage failures are intentionally swallowed; persistence is best-effort.
    const savePlaybackStateFireAndForget = (): void => {
        if (!activeFavId || !activeFavHasPrivatePlayback || !playbackTrack) return;
        const time = restoredCurrentTime ?? audioEl.currentTime;
        const state = buildFavoritePlaybackStorageValue(playbackTrack, time);
        try { localStorage.setItem(`oneplay_music_fav:${activeFavId}`, state); } catch { /* quota */ }
    };

    const savePlaybackModeFireAndForget = (): void => {
        if (!activeFavId || !activeFavHasPrivatePlayback || !favoritesRef) return;
        favoritesRef.setMode(activeFavId, playbackMode).catch(logCatch('playback:save-mode'));
    };

    const saveMmPlayback = (): void => {
        if (!playbackFolder || !playbackTrack) return;
        const state = buildGlobalPlaybackStorageValue(
            playbackFolder,
            playbackTrack,
            playbackMode,
            activeFavId,
        );
        try { localStorage.setItem('oneplay_music_playback', state); } catch { /* quota */ }
    };

    /** Saves oneplay_music_time separately so high-frequency writes stay small. */
    const saveMmTime = (): void => {
        try { localStorage.setItem('oneplay_music_time', String(audioEl.currentTime)); } catch { /* quota */ }
    };
    // -- Playback controls ---------------------------------------------------
    /** Starts playback without toggling pause state. */
    function doPlay(playErrorTag = 'play-on-play'): void {
        // Cold-start: visual state may be restored while audio has no src.
        // First explicit play resolves URL and seeks to restored position.
        if (audioEl.paused && !audioEl.src && playbackTrack && currentTrackIdx >= 0) {
            playNext(playbackTrack, currentTrackIdx, true, restoredCurrentTime);
            return;
        }
        if (!audioEl.paused) return;
        audioEl.play().catch(logCatch(playErrorTag));
    }

    /** Moves to previous playable track using mode-aware wrap rules. */
    function doPrev(): void {
        if (trackList.length === 0) return;
        // Save outgoing state before any queue index change.
        savePlaybackStateFireAndForget();
        const idx = computePrevIdx(
            playbackMode,
            currentTrackIdx,
            trackList,
            isTrackPlayableNowInContext,
        );
        if (idx === undefined) return;
        rearmTimerFromUserInteractionIfPlaying('prev');
        playNext(trackList[idx], idx, true);
    }

    /** Moves to next playable track using mode-aware progression rules. */
    function doNext(): void {
        if (trackList.length === 0) return;
        // Save outgoing state before any queue index change.
        savePlaybackStateFireAndForget();
        if (playbackMode === 'shuffle') {
            let nextIdx = findNextPlayableIdxAfter(currentTrackIdx);
            if (nextIdx === undefined) {
                // End of pass in shuffle: reshuffle for a fresh pass.
                shuffleTrackList();
                nextIdx = computeFirstPlayableIdxAfterReshuffle(trackList, isTrackPlayableNowInContext);
            }
            if (nextIdx !== undefined) {
                rearmTimerFromUserInteractionIfPlaying('next');
                playNext(trackList[nextIdx], nextIdx, true);
            }
            return;
        }
        const idx = playbackMode === 'repeat'
            ? findNextPlayableIdxWrapped(currentTrackIdx)
            : findNextPlayableIdxAfter(currentTrackIdx);
        if (idx === undefined) return;
        rearmTimerFromUserInteractionIfPlaying('next');
        playNext(trackList[idx], idx, true);
    }

    const seekBy = (delta: number): void => {
        const duration = audioEl.duration;
        if (!(Number.isFinite(duration) && duration > 0)) return;
        const base = localSeekTarget ?? audioEl.currentTime;
        const target = Math.max(0, Math.min(duration, base + delta));
        localSeekTarget = target;
        scrubberTimeEl.textContent = `${timeString(target)} / ${timeString(duration)}`;
        if (seekDebounceTimer !== null) clearTimeout(seekDebounceTimer);
        seekDebounceTimer = setTimeout(() => {
            seekDebounceTimer = null;
            localSeekTarget = null;
            audioEl.currentTime = target;
        }, 200);
        rearmTimerFromUserInteractionIfPlaying('seek');
    };
    // -- UI wiring -----------------------------------------------------------
    // playback-ui owns DOM and gesture mechanics; this module supplies policy callbacks.
    const ui: PlaybackUiController = createPlaybackUi({
        audioEl,
        footerEl,
        getMode: () => playbackMode,
        getPhase: () => phase,
        getAsyncCounter: () => asyncCounter,
        onModeCycleClick: () => {
            const prevMode = playbackMode;
            const currentIdx = MODES.indexOf(playbackMode);
            playbackMode = MODES[(currentIdx + 1) % MODES.length];
            log(`playback mode: ${playbackMode}`);
            if (playbackMode === 'shuffle') {
                shuffleTrackList();
            } else if (prevMode === 'shuffle') {
                // Leaving shuffle must restore canonical traversal order.
                refreshTrackList();
            }
            if (playbackMode === 'timer') {
                armTimerFromNowIfPlaying('mode-enter');
            } else if (prevMode === 'timer') {
                clearTimerDeadline('mode-leave');
            }
            savePlaybackModeFireAndForget();
            savePlaybackStateFireAndForget();
            saveMmPlayback();
        },
        onExpandedChange: (expanded) => view.onExpandedChange(expanded),
        onChevronClick: () => view.onChevronClick(),
        onFooterPlayPauseClick: () => {
            if (audioEl.paused) doPlay('play-on-playpause');
            else audioEl.pause();
        },
        onCenterTapToggle: () => {
            if (audioEl.paused && !audioEl.src && playbackTrack && currentTrackIdx >= 0) {
                playNext(playbackTrack, currentTrackIdx, true, restoredCurrentTime);
                return 'play';
            }
            const willPlay = audioEl.paused;
            if (willPlay) audioEl.play().catch(logCatch('play-on-center-tap'));
            else audioEl.pause();
            return willPlay ? 'play' : 'pause';
        },
        onPrev: doPrev,
        onNext: doNext,
        onSeekBy: seekBy,
        onCancelSeekDebounce: cancelSeekDebounce,
        onRearmTimerFromScrub: () => rearmTimerFromUserInteractionIfPlaying('scrub'),
    });

    const {
        indicatorSvg,
        titleEl,
        scrubberTextEl,
        scrubberTimeEl,
        expansionEl,
    } = ui;

    // Drive play/pause affordance from media events, never optimistically.
    // This avoids UI desync when `audio.play()` is rejected by autoplay policy.
    audioEl.addEventListener('play', () => {
        ui.setPlayPausePlaying(true);
        if (playbackMode === 'timer') {
            if (suppressTimerPauseClear) {
                suppressTimerPauseClear = false;
            } else if (timerDeadlineMs === undefined) {
                const trackName = playbackTrack ? playbackTrack[playbackTrack.length - 1] : '<none>';
                log(`timer: track started, arming timer track=${trackName} duration=${timerDurationSetting}`);
                armTimerFromNowIfPlaying('play-event');
            }
        }
        updatePositionState();
    });

    audioEl.addEventListener('pause', () => {
        ui.setPlayPausePlaying(false);
        if (playbackMode === 'timer') {
            if (!suppressTimerPauseClear) {
                clearTimerDeadline('pause-event');
            }
        } else {
            suppressTimerPauseClear = false;
        }
        savePlaybackStateFireAndForget();
        saveMmTime();
        updatePositionState();
    });
    // MediaSession support is partial on Safari; register each action defensively.
    if ('mediaSession' in navigator) {
        const registerMediaSessionAction = (
            action: MediaSessionAction,
            handler: MediaSessionActionHandler,
        ): void => {
            try {
                navigator.mediaSession.setActionHandler(action, handler);
            } catch { /* unsupported action */ }
        };

        registerMediaSessionAction('play', () => doPlay('play-on-mediasession'));
        registerMediaSessionAction('pause', () => audioEl.pause());
        registerMediaSessionAction('previoustrack', doPrev);
        registerMediaSessionAction('nexttrack', doNext);
        registerMediaSessionAction('seekto', (details) => {
            if (details.seekTime == null || !Number.isFinite(audioEl.duration)) return;
            audioEl.currentTime = Math.max(0, Math.min(details.seekTime, audioEl.duration));
            rearmTimerFromUserInteractionIfPlaying('seek-mediasession');
            updatePositionState();
        });
        registerMediaSessionAction('seekforward', (details) => seekBy(details.seekOffset ?? 10));
        registerMediaSessionAction('seekbackward', (details) => seekBy(-(details.seekOffset ?? 10)));
    }
    // Backstop: if timers expired while backgrounded, reconcile on visibility.
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible' || playbackMode !== 'timer') return;
        if (!isTimerExpiredNow(Date.now())) return;
        if (!audioEl.paused) {
            expireTimerAndPauseInPlace('visibilitychange');
            return;
        }
        clearTimerDeadline('visibilitychange-paused');
    });
    /** Syncs footer DOM with current playback state. */
    const updateFooter = (): void => {
        const visible = playbackFolder !== undefined;
        footerEl.classList.toggle('visible', visible);
        if (!visible) {
            updateMediaSession();
            return;
        }

        titleEl.textContent = playbackTrack
            ? resolvePathTailDisplayName(playbackTrack, rootsRef, favoritesRef)
            : '';
        indicatorSvg.classList.remove('loading', 'loaded');
        indicatorSvg.classList.add(phase);
        scrubberTextEl.classList.toggle('loading', phase === 'loading');
        if (phase === 'loading') scrubberTimeEl.textContent = '';
        updateMediaSession();
    };
    // MediaSession metadata/position are derived from logical-path display names.
    const getMediaSessionFieldsForTrack = (path: FolderPath) => {
        const filename = resolvePathTailDisplayName(path, rootsRef, favoritesRef);
        const parentPath = path.slice(0, -1);
        const album = parentPath.length >= 2
            ? resolvePathTailDisplayName(parentPath, rootsRef, favoritesRef)
            : '';
        return deriveMediaSessionFields(filename, album);
    };

    const updateMediaSession = (): void => {
        if (!('mediaSession' in navigator)) return;
        if (!playbackTrack) {
            navigator.mediaSession.metadata = null;
            return;
        }
        const { title, album } = getMediaSessionFieldsForTrack(playbackTrack);
        try {
            navigator.mediaSession.metadata = new MediaMetadata({ title, album });
        } catch {
            navigator.mediaSession.metadata = null;
        }
    };

    const updatePositionState = (): void => {
        if (!('mediaSession' in navigator)) return;
        const state = getMediaSessionPositionState(
            audioEl.duration,
            audioEl.currentTime,
            audioEl.playbackRate,
        );
        if (!state) return;
        try {
            navigator.mediaSession.setPositionState(state);
        } catch { /* Safari may throw on edge-case float values */ }
    };
    // -- Audio lifecycle handlers -------------------------------------------
    audioEl.addEventListener('loadeddata', () => {
        phase = 'loaded';
        // Deferred clear: only consume restored time after successful load,
        // so failed attempts can still retry from the intended position.
        restoredCurrentTime = undefined;
        updateFooter();
        updatePositionState();
        bumpTestPlaybackSeq();
        view.onPlaybackChange(getInfo()!);
    });

    audioEl.addEventListener('ended', () => {
        const t0 = performance.now();
        // Guard: `audio.load()` on a src-less element can emit synthetic ended.
        if (!audioEl.src || audioEl.src === window.location.href) return;
        cancelSeekDebounce();
        if (!playbackTrack) return;

        log('ENDED...');

        // Save outgoing state before choosing next index.
        savePlaybackStateFireAndForget();

        const timerMs = timerDurationMs(timerDurationSetting);
        if (playbackMode === 'timer') {
            if (timerMs === undefined) {
                clearTimerDeadline('ended-end-of-track');
                log('ENDED: end-of-track reached, stopping');
                return;
            }
            if (isTimerExpiredNow(Date.now())) {
                const deadlineAtCatch = timerDeadlineMs;
                clearTimerDeadline('ended-expired');
                const lagMs = deadlineAtCatch === undefined ? undefined : Math.max(0, Date.now() - deadlineAtCatch);
                logError(`ENDED: missed expiry caught at ended, stopping (lagMs=${lagMs ?? 'unknown'})`);
                return;
            }
        }

        let nextIdx = computeNextTrackIdx();
        if (nextIdx === undefined) {
            if (playbackMode === 'shuffle') {
                // End of shuffled list: reshuffle for another pass.
                shuffleTrackList();
                nextIdx = computeFirstPlayableIdxAfterReshuffle(trackList, isTrackPlayableNowInContext);
            } else if (playbackMode === 'one') {
                log('ENDED: mode=one, stopped after track');
                return;
            } else if (playbackMode === 'timer') {
                log('ENDED: reached end of playable tracks');
                return;
            } else {
                log('ENDED: reached end of playable tracks');
                return;
            }
        }
        if (nextIdx === undefined) {
            log('ENDED: no playable successor');
            return;
        }
        const nextPath = trackList[nextIdx];
        if (!nextPath) {
            logError('ENDED: no playable successor');
            return;
        }

        // Sync-first advance path reduces iOS background playback drops by
        // avoiding async gaps between tracks when a URL/blob is already ready.
        let syncUrl: string | undefined;
        const prefetchedBlobUrl = urlEngine.consumePrefetchedBlobUrlForPath(nextPath, pathEquals);
        if (prefetchedBlobUrl) {
            syncUrl = prefetchedBlobUrl;
            urlEngine.setCurrentBlobUrl(syncUrl);
            log('ENDED: prefetchedNextBlobUrl hit');
        }

        if (!syncUrl) {
            const ids = favoritesRef
                ? resolveTrackIds(nextPath, accountsRef, favoritesRef, rootsRef)
                : undefined;
            if (ids) {
                const result = urlEngine.getTrackUrl(ids.driveId, ids.itemId);
                if (result.type === 'value' && result.value) {
                    syncUrl = result.value;
                    log('ENDED: syncUrl hit');
                }
            }
        }

        if (syncUrl) {
            // Keep sync path gapless: assign src directly and play.
            asyncCounter += 1;
            urlEngine.clearPrefetchState();
            playbackTrack = nextPath;
            currentTrackIdx = nextIdx;
            phase = 'loading';
            audioEl.src = syncUrl;
            audioEl.play().catch((e) => {
                suppressTimerPauseClear = false;
                logCatch('play-sync-ended')(e);
            });
            updateFooter();
            view.onPlaybackChange(getInfo()!);
            saveMmPlayback();
            log(`ENDED: sync play, total taken=${Math.round(performance.now() - t0)}ms`);
        } else {
            // Async fallback reuses full `playNext` pipeline with race guards.
            logError('ENDED: async fallback');
            playNext(nextPath, nextIdx, true);
        }
    });

    audioEl.addEventListener('error', () => {
        if (!audioEl.src || audioEl.src === window.location.href) return;
        const e = audioEl.error;
        logError(`ERROR: code=${e?.code ?? '?'} ${e?.message ?? 'unknown'}`);
        // Deliberately do not auto-advance on errors; preserve user control.
        phase = 'loaded';
        updateFooter();
        bumpTestPlaybackSeq();
        view.onPlaybackChange(getInfo()!);
    });

    audioEl.addEventListener('seeked', updatePositionState);

    // Throttled persistence + near-end prefetch.
    audioEl.addEventListener('timeupdate', () => {
        if (playbackMode === 'timer' && isTimerExpiredNow(Date.now())) {
            expireTimerAndPauseInPlace('timeupdate');
            return;
        }

        const bucket = Math.floor(audioEl.currentTime / 5);
        if (bucket !== lastSavedTimeBucket) {
            lastSavedTimeBucket = bucket;
            saveMmTime();
            // Private-playback favorites keep per-fav state hot during playback.
            if (activeFavHasPrivatePlayback) savePlaybackStateFireAndForget();
        }

        urlEngine.maybePrefetchNearEnd(audioEl.currentTime, audioEl.duration, {
            asyncCounter,
            getNextPath: () => {
                const nextIdx = computeNextTrackIdx();
                if (nextIdx === undefined) return undefined;
                return trackList[nextIdx];
            },
            resolveTrackIds: (path) => favoritesRef
                ? resolveTrackIds(path, accountsRef, favoritesRef, rootsRef)
                : undefined,
            getOfflineBlob: async (driveId, itemId) =>
                downloadsRef?.getOfflineBlob(driveId, itemId).catch(() => undefined),
        });

        if (!ui.isExpanded() || phase === 'loading' || ui.isScrubbing() || localSeekTarget !== null) {
            updatePositionState();
            return;
        }
        const duration = audioEl.duration;
        scrubberTimeEl.textContent = audioEl.readyState < HTMLMediaElement.HAVE_METADATA || !(Number.isFinite(duration) && duration > 0)
            ? ''
            : `${timeString(audioEl.currentTime)} / ${timeString(duration)}`;
        updatePositionState();
    });

    // -- Core playback pipeline ---------------------------------------------
    /** Accounts map reference, updated on each playTrack/playFolder call. */
    let accountsRef: AccountsMap = new Map();

    /**
     * Detects and sets active favorite from a path.
     * Saves outgoing favorite state before switching contexts.
     */
    const updateActiveFavorite = (path: FolderPath): Favorite | undefined => {
        if (path.length < 2 || !path[1].startsWith('fav:') || !favoritesRef) {
            if (activeFavId) {
                savePlaybackStateFireAndForget();
                activeFavId = undefined;
                activeFavHasPrivatePlayback = false;
                playbackMode = 'all';
                clearTimerDeadline('favorite-context-clear');
                ui.setModeLabelText(playbackMode);
            }
            return undefined;
        }
        const newFavId = path[1].slice(4);
        const fav = favoritesRef.getAll().find(f => f.id === newFavId);
        if (!fav) return undefined;

        if (activeFavId && activeFavId !== newFavId) {
            savePlaybackStateFireAndForget();
        }
        activeFavId = newFavId;
        activeFavHasPrivatePlayback = fav.hasPrivatePlayback;
        lastSavedTimeBucket = -1;
        if (!fav.hasPrivatePlayback) {
            playbackMode = 'all';
            clearTimerDeadline('favorite-non-private');
            ui.setModeLabelText(playbackMode);
        }
        return fav;
    };
    /**
     * Loads and plays a track. Stops current audio immediately to prevent races.
     *
     * INVARIANT: every call increments asyncCounter; stale async completions
     * from older transitions are ignored.
     */
    async function playNext(path: FolderPath, idx: number, shouldPlay: boolean, startTime?: number): Promise<void> {
        log('PLAYNEXT...');
        cancelSeekDebounce();
        suppressTimerPauseClear = false;
        if (!isTrackPlayableNowInContext(path)) {
            log(`PLAYNEXT: blocked known-unavailable track ${path.join('/')}`);
            return;
        }
        asyncCounter += 1;
        const counter = asyncCounter;

        // New target invalidates old prefetch assumptions.
        urlEngine.clearPrefetchState();

        // Prevent blob URL leaks when leaving offline blob playback.
        urlEngine.revokeCurrentBlobUrl();

        suppressTimerPauseClear = shouldPlay
            && playbackMode === 'timer'
            && timerDurationMs(timerDurationSetting) !== undefined
            && timerDeadlineMs !== undefined;

        // Reset media element before async URL work so old lifecycle events
        // cannot fire into the new transition.
        audioEl.pause();
        audioEl.removeAttribute('src');
        audioEl.load();

        playbackTrack = path;
        currentTrackIdx = idx;
        phase = 'loading';
        updateFooter();
        bumpTestPlaybackSeq();
        view.onPlaybackChange(getInfo()!);
        saveMmPlayback();

        // Offline cache first keeps offline-first behavior and reduces latency.
        const ids = favoritesRef ? resolveTrackIds(path, accountsRef, favoritesRef, rootsRef) : undefined;
        const offlineBlob = ids ? await downloadsRef?.getOfflineBlob(ids.driveId, ids.itemId).catch(() => undefined) : undefined;
        if (counter !== asyncCounter) 
        {
            logError('PLAYNEXT: stale after offline blob fetch');
            return;
        }

        if (offlineBlob) {
            const blobUrl = URL.createObjectURL(offlineBlob);
            urlEngine.setCurrentBlobUrl(blobUrl);
            audioEl.src = blobUrl;
            if (startTime !== undefined && startTime > 0) {
                audioEl.addEventListener('loadedmetadata', () => {
                    if (counter !== asyncCounter) return;
                    const clamped = Math.min(startTime, audioEl.duration > 0 ? audioEl.duration - 0.5 : startTime);
                    if (clamped > 0) audioEl.currentTime = clamped;
                }, { once: true });
            }
            if (shouldPlay) {
                audioEl.play().catch((e) => {
                    suppressTimerPauseClear = false;
                    logCatch('play-offline')(e);
                });
            } else {
                suppressTimerPauseClear = false;
            }
            log('PLAYNEXT: offlineBlob playing');
            return;
        }

        // Resolve logical path to physical file id before URL lookup.
        const file = favoritesRef
            ? resolveLogicalTrack(path, accountsRef, favoritesRef, rootsRef)
            : resolveTrack(path, accountsRef);
        if (!file) {
            suppressTimerPauseClear = false;
            phase = 'loaded';
            updateFooter();
            bumpTestPlaybackSeq();
            view.onPlaybackChange(getInfo()!);
            logError(`PLAYNEXT:track not found: ${path.join('/')}`);
            return;
        }

        log(`fetching URL: ${path[path.length - 1]}`);
        // Prefer URL cache hit for ended/prefetch continuity; network otherwise.
        let url: string | undefined;
        if (ids) {
            const cached = urlEngine.getTrackUrl(ids.driveId, ids.itemId);
            if (cached.type === 'value') {
                url = cached.value;
            } else {
                url = await cached.promise;
            }
        } else {
            url = path[1]?.startsWith('fav:')
                ? undefined
                : await fetchDownloadUrl(path[1], file.id, authFetch);
        }
        if (counter !== asyncCounter) {
            logError('PLAYNEXT: stale after URL fetch');
            return;
        }

        if (!url) {
            suppressTimerPauseClear = false;
            phase = 'loaded';
            updateFooter();
            bumpTestPlaybackSeq();
            view.onPlaybackChange(getInfo()!);
            logError(`PLAYNEXT: no download URL for ${path.join('/')}`);
            return;
        }

        audioEl.src = url;
        // Startup/restore seek is applied after metadata so duration clamping is valid.
        if (startTime !== undefined && startTime > 0) {
            audioEl.addEventListener('loadedmetadata', () => {
                if (counter !== asyncCounter) return; // stale
                const clamped = Math.min(startTime, audioEl.duration > 0 ? audioEl.duration - 0.5 : startTime);
                if (clamped > 0) audioEl.currentTime = clamped;
            }, { once: true });
        }
        if (shouldPlay) {
            audioEl.play().catch((e) => {
                suppressTimerPauseClear = false;
                logCatch('play')(e);
            });
            log('PLAYNEXT: audioEl.play');
        } else {
            suppressTimerPauseClear = false;
            logError('PLAYNEXT: should not play');
        }
    }

    // -- Public API ----------------------------------------------------------
    const getInfo = (): PlaybackInfo | undefined =>
        playbackFolder && playbackTrack
            ? { folder: playbackFolder, track: playbackTrack, phase }
            : undefined;

    const view: Playback = {
        getInfo,

        collapse() { ui.setExpanded(false); },

        setContext(favorites, roots) {
            favoritesRef = favorites;
            rootsRef = roots;
            // Refresh trackList reactively when favorites/roots mutate.
            refreshTrackList();
        },

        setDownloads(downloads) {
            downloadsRef = downloads;
        },

        setTimerDuration(duration) {
            timerDurationSetting = duration;
            if (playbackMode === 'timer') {
                // Duration changes restart timer semantics from "now".
                if (audioEl.paused) {
                    clearTimerDeadline('duration-change-paused');
                } else {
                    armTimerFromNowIfPlaying('duration-change-playing');
                }
            }
        },

        setAvailabilityContext(state, isTrackCached, isTrackBlocked) {
            evidenceState = state;
            isTrackCachedFn = isTrackCached;
            isTrackBlockedFn = isTrackBlocked ?? (() => false);
        },

        playTrack(path, accounts) {
            accountsRef = accounts;
            // Invalidate in-flight playFolder restore reads so explicit user
            // track intent cannot be clobbered by stale async resume.
            playFolderCounter += 1;
            const fav = updateActiveFavorite(path);

            if (fav?.hasPrivatePlayback) {
                playbackMode = isValidMode(fav.mode) ? fav.mode : 'all';
                if (playbackMode !== 'timer') clearTimerDeadline('play-track-mode-restore');
                ui.setModeLabelText(playbackMode);
            }

            const inFolder = playbackFolder && pathStartsWith(path, playbackFolder);
            if (!inFolder) {
                // Track click outside current folder retargets queue to track parent.
                const parentPath = path.slice(0, -1);
                if (favoritesRef && parentPath.length >= 2 && parentPath[1].startsWith('fav:')) {
                    playbackFolder = parentPath;
                    const t0 = performance.now();
                    trackList = collectLogicalTracks(parentPath, accounts, favoritesRef, rootsRef);
                    log(`collectLogicalTracks: ${trackList.length} tracks in ${Math.round(performance.now() - t0)}ms`);
                } else {
                    const parentFolder = resolveFolderFromPath(parentPath, accounts);
                    if (!parentFolder) {
                        logError(`parent folder not found: ${parentPath.join('/')}`);
                        return;
                    }
                    playbackFolder = parentPath;
                    trackList = collectTracks(parentPath, parentFolder);
                }
                log(`playback folder: ${parentPath.join('/')} (${trackList.length} tracks)`);
            }
            const idx = trackList.findIndex(t => pathEquals(t, path));
            playNext(path, idx >= 0 ? idx : 0, true);
        },

        async playFolder(path, accounts) {
            accountsRef = accounts;
            playFolderCounter += 1;
            const myCounter = playFolderCounter;
            const fav = updateActiveFavorite(path);

            // Build queue from logical or physical root, matching selected path type.
            let folderTracks: FolderPath[];
            if (favoritesRef && path.length >= 2 && path[1].startsWith('fav:')) {
                const t0 = performance.now();
                folderTracks = collectLogicalTracks(path, accounts, favoritesRef, rootsRef);
                log(`collectLogicalTracks: ${folderTracks.length} tracks in ${Math.round(performance.now() - t0)}ms`);
            } else {
                const folder = resolveFolderFromPath(path, accounts);
                if (!folder) {
                    logError(`folder not found: ${path.join('/')}`);
                    return;
                }
                folderTracks = collectTracks(path, folder);
            }

            if (folderTracks.length === 0) {
                if (inTerminalEvidenceState(evidenceState) || isTrackBlockedFn(path)) {
                    log('playback: blocked folder play (empty/unavailable)');
                    view.onPlayBlockedNoPlayableTracks(path);
                    return;
                }
                // Empty-but-available folder is a valid stop state, not an error.
                audioEl.pause();
                audioEl.removeAttribute('src');
                playbackFolder = path;
                trackList = folderTracks;
                playbackTrack = undefined;
                currentTrackIdx = -1;
                phase = 'loading';
                updateFooter();
                view.onPlaybackChange(getInfo());
                log('playback: folder is empty');
                return;
            }
            const firstPlayableIdx = findFirstPlayableIdxIn(folderTracks);
            if (firstPlayableIdx === undefined) {
                log('playback: blocked folder play (no playable tracks)');
                view.onPlayBlockedNoPlayableTracks(path);
                return;
            }

            playbackFolder = path;
            trackList = folderTracks;
            log(`playback folder: ${path.join('/')} (${trackList.length} tracks)`);

            if (fav?.hasPrivatePlayback) {
                playbackMode = isValidMode(fav.mode) ? fav.mode : 'all';
                if (playbackMode !== 'timer') clearTimerDeadline('play-folder-mode-restore');
                ui.setModeLabelText(playbackMode);

                if (playbackMode !== 'shuffle') {
                    // Restore favorite-local state: localStorage first for sync startup,
                    // then legacy IDB fallback for migration compatibility.
                    const favId = fav.id;
                    const fromLocalStorage = parseFavoritePlaybackStorageValue(
                        localStorage.getItem(`oneplay_music_fav:${favId}`),
                    );
                    let savedTrack = fromLocalStorage?.track;
                    let savedTime = fromLocalStorage?.time ?? 0;

                    if (!savedTrack) {
                        const saved = await dbGet<PerFavoritePlaybackState>(`playback:${favId}`).catch(() => undefined);
                        // Staleness guard prevents late restore from clobbering newer intent.
                        if (myCounter !== playFolderCounter) return; // staleness guard
                        if (saved && Array.isArray(saved.trackPath)) {
                            savedTrack = saved.trackPath as FolderPath;
                            savedTime = saved.currentTime ?? 0;
                            const migrated = buildFavoritePlaybackStorageValue(savedTrack, savedTime);
                            try { localStorage.setItem(`oneplay_music_fav:${favId}`, migrated); } catch { /* quota */ }
                        }
                    }

                    const candidate = pickRestoreCandidate(
                        trackList,
                        savedTrack,
                        savedTime,
                        pathEquals,
                        isTrackPlayableNowInContext,
                    );
                    if (candidate) {
                        currentTrackIdx = candidate.idx;
                        log(`playback: restoring fav ${favId} at track ${currentTrackIdx}, time=${Math.round(candidate.time)}s`);
                        playNext(trackList[currentTrackIdx], currentTrackIdx, true, candidate.time);
                        return;
                    }
                }
            }
            // Default start path: beginning, or fresh shuffle pick in shuffle mode.
            if (playbackMode === 'shuffle') {
                // Fresh folder-play shuffle ignores stale carried index.
                currentTrackIdx = -1;
                shuffleTrackList();
            }
            const startIdx = findFirstPlayableIdx();
            if (startIdx === undefined) {
                log('playback: blocked folder play after shuffle (no playable tracks)');
                view.onPlayBlockedNoPlayableTracks(path);
                return;
            }
            playNext(trackList[startIdx], startIdx, true);
        },

        onChevronClick: () => {},
        onPlaybackChange: () => {},
        onExpandedChange: () => {},
        onPlayBlockedNoPlayableTracks: () => {},

        restoreVisualState(folder, track, mode, expandedState, time, favId, accounts) {
            // Startup restore is intentionally visual-only to keep cold start instant.
            // Actual URL load is deferred until explicit play intent.
            if (accounts) accountsRef = accounts;

            playbackFolder = folder;
            playbackTrack = track;
            playbackMode = mode;
            clearTimerDeadline('restore-visual-state');
            phase = 'loaded'; // visual state: show as loaded (paused, not loading)

            if (favId && favoritesRef) {
                const fav = favoritesRef.getAll().find(f => f.id === favId);
                activeFavId = favId;
                activeFavHasPrivatePlayback = fav?.hasPrivatePlayback ?? false;
            }

            refreshTrackList();
            if (currentTrackIdx < 0) {
                // Restored pointer no longer valid after index/favorites evolution.
                log('restoreVisualState: restored track not found in track list, clearing');
                playbackFolder = undefined;
                playbackTrack = undefined;
                activeFavId = undefined;
                activeFavHasPrivatePlayback = false;
                updateFooter();
                view.onPlaybackChange(undefined);
                return;
            }

            restoredCurrentTime = time;

            updateFooter();
            ui.setModeLabelText(playbackMode);
            bumpTestPlaybackSeq();
            view.onPlaybackChange(getInfo()!);

            // Suppress first-load animation so restored expanded state snaps in place.
            expansionEl.style.transition = 'none';
            ui.setExpanded(expandedState);
            requestAnimationFrame(() => { expansionEl.style.transition = ''; });
        },
    };

    return view;
}
