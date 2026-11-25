/** Browser playback owns its audible occurrence, HTML audio element and play order.
 * Row paths belong to one library revision. A removed occurrence keeps its admitted
 * media identity and former neighbors until a new song takes over. */
import { type FolderPath } from './tree.js';
import { log, logError, logCatch } from './logger.js';
import { type Favorites, type Favorite, type RootsMap } from './favorites.js';
import { dbGet, dbPut } from './db.js';
import { type EvidenceState, type AuthFetch } from './auth.js';
import { type TimerDuration } from './settings.js';
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
    type HeldBookmark,
    type GlobalPlaybackSave,
    findFirstPlayableIdxIn as findFirstPlayableIdxInList,
    findNextPlayableIdxAfter as findNextPlayableIdxAfterInList,
    findNextPlayableIdxWrapped as findNextPlayableIdxWrappedInList,
    getMediaSessionPositionState,
    inTerminalEvidenceState,
    isTrackPlayableNow,
    parseFavoritePlaybackStorageValue, parseGlobalPlaybackSave,
    reduceRefreshedTrackList,
    shuffleTrackList as shuffleTrackListPure,
    timerDurationMs,
} from './playback-engine.js';
import {
    type AccountsMap,
    buildLibraryQueue, type LibraryQueue, type QueueEntry,
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
    playTrack(path: FolderPath, accounts: AccountsMap): Promise<void>;
    /** Build folder queue and play first playable entry. */
    playFolder(path: FolderPath, accounts: AccountsMap): Promise<void>;
    /** Immediately release the media element and invalidate queued work on account sign-out. */
    stop(): void;
    /** Collapse expanded controls (used when entering select mode). */
    collapse(): void;
    /** Update favorites/roots references for logical traversal. */
    setContext(favorites: Favorites, roots: RootsMap, denied?: ReadonlySet<string>, sharesKnown?: boolean): void;
    /** Hold natural/manual boundaries until a durable library edit is rebuilt. */
    fenceQueueEdit(): Promise<void>;
    refreshLibraryQueue(saved?: boolean): Promise<void>;
    /** Set downloads ref for offline-blob checks. */
    setDownloads(downloads: Downloads): void;
    /** Update timer duration backing timer mode. */
    setTimerDuration(duration: TimerDuration): void;
    /** Provide evidence state and cache/block predicates for playability checks. */
    setAvailabilityContext(
        state: EvidenceState,
        isTrackCached: (path: FolderPath) => boolean,
        isTrackBlocked?: (path: FolderPath) => boolean,
        isEntryCached?: (entry: QueueEntry) => boolean,
    ): void;
    /** Restore visual state without eagerly loading audio on startup. */
    restoreVisualState(
        folder: FolderPath, track: FolderPath, mode: PlaybackMode,
        expandedState: boolean, time: number,
        favId?: string, accounts?: AccountsMap, bookmark?: Partial<GlobalPlaybackSave>,
    ): Promise<boolean>;
    /** Called when user clicks the footer chevron indicator. Wired by index.ts. */
    onChevronClick: () => void;
    /** Called after every playback state change. Wired by index.ts → tree.setPlaybackInfo. */
    onPlaybackChange: (info: PlaybackInfo | undefined, advanced?: boolean) => void;
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
    migrateLegacyFavorite?: (id: string) => Promise<void>,
): Playback {
    // -----------------------------------------------------------------------
    // State
    // -----------------------------------------------------------------------

    // -- Core state ----------------------------------------------------------
    // Queue + active-track state owned by playback.
    let queue: LibraryQueue | undefined;
    let current: QueueEntry | undefined;
    let held: HeldBookmark | undefined;
    let phase: 'loading' | 'loaded' = 'loading';
    let trackList: QueueEntry[] = [];
    let currentTrackIdx = -1;
    let asyncCounter = 0;
    let savedNeighbors: {snapshot: HeldBookmark; id?: string} | undefined;
    let generation = '';
    let selection = 0;
    let libraryRevision = 0;
    let refreshRequest = 0;
    let boundary: 'ended' | 'next' | 'prev' | undefined;
    let edit: {saved: boolean; done: Promise<void>; resolve: () => void} | undefined;
    let pendingSave: {done: Promise<void>; resolve: () => void} | undefined;
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
    let configuredMode: PlaybackMode | undefined;
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
    let deniedRoots: ReadonlySet<string> = new Set();
    let sharesKnown = true;

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

    let isEntryCachedFn: ((entry: QueueEntry) => boolean) | undefined;
    const isPlayable = (entry: QueueEntry): boolean => !deniedRoots.has(entry.sourceRootKey)
        && isTrackPlayableNow(entry.path, evidenceState, path => isEntryCachedFn?.(entry) ?? isTrackCachedFn(path),
            path => current === entry && held ? false : isTrackBlockedFn(path));

    /** Former neighbors retain their old priority through any number of intervening edits. */
    function heldNeighbor(direction: 'before' | 'after'): number | undefined {
        if (!held) return undefined;
        const positions = new Map(trackList.map((t, i) => [t.key, i]));
        for (const key of held[direction]) {
            const idx = positions.get(key);
            if (idx !== undefined && isPlayable(trackList[idx])) return idx;
        }
        return undefined;
    }
    const computeNextTrackIdx = (): number | undefined => held
        ? (playbackMode === 'one' ? undefined : heldNeighbor('after'))
        : computeNextIdx(playbackMode, currentTrackIdx, trackList, isPlayable);

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
        const trackName = current?.title ?? '<none>';
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
    /** Capture inputs before the first yield. Standalone browser clients may supply just AccountsMap. */
    function describe(folder: FolderPath, key?: string): Promise<LibraryQueue | undefined> {
        if (folder[1]?.startsWith('fav:') && (!favoritesRef || favoritesRef.hasLoadedMembership?.() === false))
            return Promise.resolve(undefined);
        const roots = new Map(rootsRef);
        if (!favoritesRef) for (const [rootKey, account] of accountsRef) {
            roots.set(rootKey, {type: 'onedrive', key: rootKey, name: rootKey, folder: account.folder,
                info: {driveId: account.driveId, displayName: rootKey}, reindexing: false});
        }
        return buildLibraryQueue(folder, roots, favoritesRef?.getAll() ?? [], deniedRoots, key, sharesKnown);
    }

    // -- Per-favorite state persistence -------------------------------------
    // Storage failures are intentionally swallowed; persistence is best-effort.
    const savePlaybackStateFireAndForget = (): void => {
        if (!activeFavId || !activeFavHasPrivatePlayback || !current || !queue) return;
        const time = restoredCurrentTime ?? audioEl.currentTime;
        const state = buildFavoritePlaybackStorageValue(current.path, time, {key: current.key, folderKey: queue.folderKey, folder: queue.folder});
        try { localStorage.setItem(`oneplay_music_fav:${activeFavId}`, state); } catch { /* quota */ }
    };

    const savePlaybackModeFireAndForget = (): void => {
        if (!activeFavId || !activeFavHasPrivatePlayback || !favoritesRef) return;
        favoritesRef.setMode(activeFavId, playbackMode).catch(logCatch('playback:save-mode'));
    };

    /** A large former pass lives in IDB. The global record points at the exact acknowledged snapshot. */
    async function persistNeighbors(snapshot: HeldBookmark): Promise<void> {
        if (savedNeighbors?.snapshot === snapshot) return;
        if (snapshot.before.length + snapshot.after.length <= 128) {
            savedNeighbors = {snapshot};
        } else {
            const id = crypto.randomUUID();
            await dbPut('oneplay_music_held', {id, snapshot});
            savedNeighbors = {snapshot, id};
        }
    }

    const saveMmPlayback = (requireDurable = false): void => {
        if (!queue || !current) return;
        const state = buildGlobalPlaybackStorageValue(queue.folder, current.path, playbackMode, activeFavId,
            {key: current.key, folderKey: queue.folderKey, generation,
                ...(savedNeighbors?.snapshot.entry.key === current.key && (held || edit)
                    ? savedNeighbors.id ? {heldId: savedNeighbors.id} : {held: savedNeighbors.snapshot} : {})});
        // An acknowledged playlist mutation needs this structural record across a crash.
        // Routine playback remains available if the browser temporarily declines a save.
        try { localStorage.setItem('oneplay_music_playback', state); } catch (error) { if (requireDurable) throw error; }
    };

    /** Saves oneplay_music_time separately so high-frequency writes stay small. */
    const saveMmTime = (): void => {
        if (!current) return;
        const time = restoredCurrentTime ?? audioEl.currentTime;
        try { localStorage.setItem('oneplay_music_time', JSON.stringify({generation, time})); } catch { /* quota */ }
    };
    // -- Playback controls ---------------------------------------------------
    /** Starts playback without toggling pause state. */
    function doPlay(playErrorTag = 'play-on-play'): void {
        // Cold-start: visual state may be restored while audio has no src.
        // First explicit play resolves URL and seeks to restored position.
        if (audioEl.paused && !audioEl.src && current) {
            playNext(current, currentTrackIdx, true, restoredCurrentTime);
            return;
        }
        if (!audioEl.paused) return;
        audioEl.play().catch(logCatch(playErrorTag));
    }

    /** Moves to previous playable track using mode-aware wrap rules. */
    function doPrev(): void {
        if (edit) { boundary = 'prev'; return; }
        const idx = held ? heldNeighbor('before') : computePrevIdx(playbackMode, currentTrackIdx, trackList, isPlayable);
        if (idx === undefined) return;
        rearmTimerFromUserInteractionIfPlaying('prev');
        playNext(trackList[idx], idx, true);
    }

    /** Manual Next may leave One and end-of-track Timer, including a removed song. */
    function doNext(): void {
        if (edit) { boundary = 'next'; return; }
        let idx = held ? heldNeighbor('after') : playbackMode === 'repeat'
            ? findNextPlayableIdxWrappedInList(trackList, currentTrackIdx, isPlayable)
            : findNextPlayableIdxAfterInList(trackList, currentTrackIdx, isPlayable);
        if (idx === undefined && !held && playbackMode === 'shuffle') {
            shuffleTrackList();
            idx = computeFirstPlayableIdxAfterReshuffle(trackList, isPlayable);
        }
        if (idx === undefined) { if (held) clearSession(); return; }
        rearmTimerFromUserInteractionIfPlaying('next');
        playNext(trackList[idx], idx, true, 0, true);
    }

    /** Streams and unloaded sources may have an infinite or unknown duration. */
    const getDuration = (): number | undefined => {
        const duration = audioEl.duration;
        return Number.isFinite(duration) && duration > 0 ? duration : undefined;
    };

    /** Sample live timing when the wheel opens or receives a media time update. */
    const showCurrentTime = (): void => {
        const duration = getDuration();
        scrubberTimeEl.textContent = audioEl.readyState >= HTMLMediaElement.HAVE_METADATA && duration !== undefined
            ? `${timeString(audioEl.currentTime)} / ${timeString(duration)}` : '';
    };

    const seekBy = (delta: number): void => {
        const duration = getDuration();
        if (duration === undefined) return;
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
        footerEl,
        getMode: () => playbackMode,
        getDuration,
        onScrubStart: () => {
            if (getDuration() === undefined) return undefined;
            cancelSeekDebounce();
            const counter = asyncCounter;
            const src = audioEl.src;
            const wasPlaying = !audioEl.paused;
            // A replay can reuse the same URL, and a source can change within a play.
            const isCurrent = () => asyncCounter === counter && audioEl.src === src;
            return {
                startTime: audioEl.currentTime,
                isCurrent,
                commitScrubIfCurrent(seconds) {
                    if (!isCurrent()) return;
                    const duration = getDuration();
                    if (duration !== undefined) {
                        if (Math.abs(duration - seconds) < 0.1) {
                            audioEl.currentTime = duration - 0.02;
                            audioEl.pause();
                        } else {
                            audioEl.currentTime = seconds;
                            if (wasPlaying && audioEl.paused) audioEl.play().catch(logCatch('play-on-scrub-release'));
                        }
                    }
                    rearmTimerFromUserInteractionIfPlaying('scrub');
                },
            };
        },
        onModeCycleClick: () => {
            const prevMode = playbackMode;
            const currentIdx = MODES.indexOf(playbackMode);
            playbackMode = MODES[(currentIdx + 1) % MODES.length];
            log(`playback mode: ${playbackMode}`);
            if (playbackMode === 'shuffle') {
                shuffleTrackList();
            } else if (prevMode === 'shuffle') {
                // Leaving shuffle must restore canonical traversal order.
                trackList = queue?.tracks ?? [];
                currentTrackIdx = trackList.findIndex(t => t.key === current?.key);
            }
            if (playbackMode === 'timer') {
                armTimerFromNowIfPlaying('mode-enter');
            } else if (prevMode === 'timer') {
                clearTimerDeadline('mode-leave');
            }
            urlEngine.clearPrefetchState();
            if (activeFavHasPrivatePlayback) configuredMode = playbackMode;
            savePlaybackModeFireAndForget();
            savePlaybackStateFireAndForget();
            saveMmPlayback();
        },
        onExpandedChange: (expanded) => {
            if (expanded && phase !== 'loading' && !ui.isScrubbing()) showCurrentTime();
            view.onExpandedChange(expanded);
        },
        onChevronClick: () => { if (!held) view.onChevronClick(); },
        onFooterPlayPauseClick: () => {
            if (audioEl.paused) doPlay('play-on-playpause');
            else audioEl.pause();
        },
        onCenterTapToggle: () => {
            if (audioEl.paused && !audioEl.src && current) {
                playNext(current, currentTrackIdx, true, restoredCurrentTime);
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
                const trackName = current?.title ?? '<none>';
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
        const visible = !!current;
        indicatorSvg.setAttribute('aria-disabled', String(!!held));
        footerEl.classList.toggle('visible', visible);
        if (!visible) {
            updateMediaSession();
            return;
        }

        titleEl.textContent = current?.title ?? '';
        indicatorSvg.classList.remove('loading', 'loaded');
        indicatorSvg.classList.add(phase);
        scrubberTextEl.classList.toggle('loading', phase === 'loading');
        if (phase === 'loading') scrubberTimeEl.textContent = '';
        updateMediaSession();
    };
    const updateMediaSession = (): void => {
        if (!('mediaSession' in navigator)) return;
        if (!current) {
            navigator.mediaSession.metadata = null;
            return;
        }
        const { title, album } = deriveMediaSessionFields(current.title, current.album);
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

    audioEl.addEventListener('ended', handleNaturalEnd);
    function handleNaturalEnd(): void {
        const t0 = performance.now();
        // Guard: `audio.load()` on a src-less element can emit synthetic ended.
        if (!audioEl.src || audioEl.src === window.location.href) return;
        cancelSeekDebounce();
        if (!current) return;
        if (edit) { boundary = 'ended'; return; }

        log('ENDED...');

        // Save outgoing state before choosing next index.
        savePlaybackStateFireAndForget();

        const timerMs = timerDurationMs(timerDurationSetting);
        if (playbackMode === 'timer') {
            if (timerMs === undefined) {
                clearTimerDeadline('ended-end-of-track');
                if (held) clearSession();
                log('ENDED: end-of-track reached, stopping');
                return;
            }
            if (isTimerExpiredNow(Date.now())) {
                const deadlineAtCatch = timerDeadlineMs;
                clearTimerDeadline('ended-expired');
                const lagMs = deadlineAtCatch === undefined ? undefined : Math.max(0, Date.now() - deadlineAtCatch);
                if (held) clearSession();
                logError(`ENDED: missed expiry caught at ended, stopping (lagMs=${lagMs ?? 'unknown'})`);
                return;
            }
        }

        let nextIdx = computeNextTrackIdx();
        if (nextIdx === undefined && !held && playbackMode === 'shuffle') {
            shuffleTrackList();
            nextIdx = computeFirstPlayableIdxAfterReshuffle(trackList, isPlayable);
        }
        if (nextIdx === undefined) {
            if (held) clearSession();
            return;
        }
        const next = trackList[nextIdx];
        // Consume the prepared occurrence synchronously while Safari can still advance under lock.
        const blob = urlEngine.consumePrefetchedBlobUrl(next.key);
        const syncUrl = blob ?? urlEngine.getCachedTrackUrl(next.driveId, next.itemId);
        if (syncUrl) {
            // Keep sync path gapless: assign src directly and play.
            asyncCounter += 1;
            urlEngine.clearPrefetchState();
            urlEngine.revokeCurrentBlobUrl();
            urlEngine.setCurrentBlobUrl(blob);
            held = undefined;
            current = next;
            generation = crypto.randomUUID();
            restoredCurrentTime = 0;
            currentTrackIdx = nextIdx;
            phase = 'loading';
            audioEl.src = syncUrl;
            audioEl.play().catch((e) => {
                suppressTimerPauseClear = false;
                logCatch('play-sync-ended')(e);
            });
            updateFooter();
            view.onPlaybackChange(getInfo()!, true);
            saveMmPlayback();
            saveMmTime();
            savePlaybackStateFireAndForget();
            log(`ENDED: sync play, total taken=${Math.round(performance.now() - t0)}ms`);
        } else {
            // Async fallback reuses full `playNext` pipeline with race guards.
            logError('ENDED: async fallback');
            playNext(next, nextIdx, true, 0, true);
        }
    }

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

    audioEl.addEventListener('seeked', () => { saveMmTime(); savePlaybackStateFireAndForget(); updatePositionState(); });

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

        if (!edit) urlEngine.maybePrefetchNearEnd(audioEl.currentTime, audioEl.duration, {
            getNext: () => trackList[computeNextTrackIdx() ?? -1],
            getOfflineBlob: async (driveId, itemId) =>
                downloadsRef?.getOfflineBlob(driveId, itemId).catch(() => undefined),
        });

        if (!ui.isExpanded() || phase === 'loading' || ui.isScrubbing() || localSeekTarget !== null) {
            updatePositionState();
            return;
        }
        showCurrentTime();
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
    async function playNext(entry: QueueEntry, idx: number, shouldPlay: boolean, startTime?: number, advanced = false): Promise<void> {
        log('PLAYNEXT...');
        cancelSeekDebounce();
        suppressTimerPauseClear = false;
        if (!isPlayable(entry)) return;
        const path = entry.path;
        if (idx >= 0) held = undefined;
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

        current = entry;
        generation = crypto.randomUUID();
        restoredCurrentTime = startTime ?? 0;
        lastSavedTimeBucket = -1;
        currentTrackIdx = idx;
        phase = 'loading';
        updateFooter();
        bumpTestPlaybackSeq();
        view.onPlaybackChange(getInfo()!, advanced);
        saveMmPlayback();

        saveMmTime();
        savePlaybackStateFireAndForget();

        // Offline cache first keeps offline-first behavior and reduces latency.
        const offlineBlob = await downloadsRef?.getOfflineBlob(entry.driveId, entry.itemId).catch(() => undefined);
        if (counter !== asyncCounter) {
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

        const cached = urlEngine.getTrackUrl(entry.driveId, entry.itemId);
        const url = cached.type === 'value' ? cached.value : await cached.promise;
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

    /** Clear the audible lease and global bookmark together when no eligible handoff remains. */
    function formerNeighbors(): HeldBookmark {
        return held ?? {entry: current!, before: trackList.slice(0, currentTrackIdx).reverse().map(t => t.key),
            after: trackList.slice(currentTrackIdx + 1).map(t => t.key)};
    }

    function clearSession(): void {
        if (edit?.saved) {
            edit.resolve();
            edit = undefined;
            footerEl.removeAttribute('aria-busy');
        }
        savedNeighbors = undefined;
        ++asyncCounter;
        ++refreshRequest;
        current = undefined;
        held = undefined;
        queue = undefined;
        boundary = undefined;
        trackList = [];
        currentTrackIdx = -1;
        activeFavId = undefined;
        activeFavHasPrivatePlayback = false;
        restoredCurrentTime = undefined;
        cancelSeekDebounce();
        clearTimerDeadline('stop');
        audioEl.pause();
        audioEl.removeAttribute('src');
        audioEl.load();
        urlEngine.clearPrefetchState();
        urlEngine.revokeCurrentBlobUrl();
        try { localStorage.removeItem('oneplay_music_playback'); localStorage.removeItem('oneplay_music_time'); } catch { /* quota */ }
        updateFooter();
        view.onPlaybackChange(undefined);
    }

    /** Match the audible entry when the walk commits. An earlier track may have finished during the walk. */
    async function refreshLibraryQueue(saved = false): Promise<void> {
        const request = ++refreshRequest;
        const pending = edit;
        if (pending && saved) { pending.saved = true; pendingSave?.resolve(); pendingSave = undefined; }
        if (pending && !pending.saved) return;
        const previous = queue;
        if (previous && current) {
            const fresh = await describe(previous.folder, previous.folderKey);
            if (request !== refreshRequest || pending !== edit || previous !== queue || !fresh) {
                // A saved edit stays fenced and unacknowledged until its source index arrives.
                if (saved && pending) await pending.done;
                return;
            }
            if (!current) return;
            if (activeFavId) {
                const favorite = favoritesRef?.getAll().find(f => f.id === activeFavId);
                const newMode = favorite?.hasPrivatePlayback ? favorite.mode ?? 'all' : undefined;
                if (favorite && newMode !== configuredMode) {
                    playbackMode = newMode ?? 'all';
                    clearTimerDeadline('favorite-mode-changed');
                    armTimerFromNowIfPlaying('favorite-mode-changed');
                    ui.setModeLabelText(playbackMode);
                    urlEngine.clearPrefetchState();
                }
                configuredMode = newMode;
                activeFavHasPrivatePlayback = !!favorite?.hasPrivatePlayback;
            }
            const revised = reduceRefreshedTrackList({freshTrackList: fresh.tracks, prevTrackList: trackList,
                playbackTrack: current, playbackMode, keyOf: t => t.key, random: Math.random});
            const nextKey = trackList[computeNextTrackIdx() ?? -1]?.key;
            if (revised.currentTrackIdx < 0 && !held) {
                const removed = pending && savedNeighbors?.snapshot.entry.key === current.key
                    ? savedNeighbors.snapshot : formerNeighbors();
                if (savedNeighbors?.snapshot !== removed) {
                    const wasCurrent = current;
                    await persistNeighbors(removed);
                    if (request !== refreshRequest || previous !== queue || wasCurrent !== current) return refreshLibraryQueue(saved);
                }
                held = removed;
            }
            trackList = revised.trackList;
            currentTrackIdx = revised.currentTrackIdx;
            if (currentTrackIdx >= 0) { current = trackList[currentTrackIdx]; held = undefined; savedNeighbors = undefined; }
            queue = fresh;
            if (nextKey !== trackList[computeNextTrackIdx() ?? -1]?.key) urlEngine.clearPrefetchState();
            updateFooter();
            view.onPlaybackChange(getInfo());
            saveMmPlayback();
            savePlaybackStateFireAndForget();
        }
        // Duplicate publications can observe the same commit, but can consume its deferred boundary only once.
        if (pending === edit) {
            edit = undefined;
            footerEl.removeAttribute('aria-busy');
            pending?.resolve();
            const waiting = boundary;
            boundary = undefined;
            if (waiting === 'ended') handleNaturalEnd();
            else if (waiting === 'next') doNext();
            else if (waiting === 'prev') doPrev();
        }
    }

    /** Keep playing the old selection until the new canonical order and saved spot are ready.
     * A concurrent edit reprojects the selected folder and tapped occurrence by their original keys. */
    async function selectQueue(path: FolderPath, accounts: AccountsMap, tapped: boolean): Promise<void> {
        const intent = ++selection;
        accountsRef = accounts;
        // Let Safari authorize this element in the initiating gesture, before a large walk yields.
        if (!audioEl.src && navigator.userActivation?.isActive) audioEl.load();
        const sameFolder = !!(tapped && queue && pathStartsWith(path, queue.folder));
        const folder = tapped ? (sameFolder ? queue!.folder : path.slice(0, -1)) : path;
        let revision = libraryRevision;
        let chosen = await describe(folder, sameFolder ? queue!.folderKey : undefined);
        if (intent !== selection) return;
        if (!chosen) { view.onPlayBlockedNoPlayableTracks(folder); return; }
        const folderKey = chosen.folderKey;
        const initiallyEmpty = !chosen.tracks.length;
        const tappedKey = tapped ? chosen.tracks.find(t => pathEquals(t.path, path))?.key : undefined;
        if (tapped && !tappedKey) { view.onPlayBlockedNoPlayableTracks(folder); return; }
        // Save the outgoing favorite before reading, including a fresh Play on that very favorite.
        savePlaybackStateFireAndForget();
        const favorite = favoritesRef?.getAll().find(f => path[1] === 'fav:' + f.id);
        let saved = !tapped && favorite?.hasPrivatePlayback
            ? parseFavoritePlaybackStorageValue(localStorage.getItem('oneplay_music_fav:' + favorite.id)) : undefined;
        if (!tapped && favorite?.hasPrivatePlayback && !saved?.key && favorite.mode !== 'shuffle') {
            if (migrateLegacyFavorite) {
                // The initial membership may still be waiting on another share. Only its
                // matched key can carry old time across an intervening edit.
                await migrateLegacyFavorite(favorite.id);
                saved = parseFavoritePlaybackStorageValue(localStorage.getItem('oneplay_music_fav:' + favorite.id));
                if (!saved?.key) saved = undefined;
            } else if (!saved) {
                const old = await dbGet<PerFavoritePlaybackState>('playback:' + favorite.id).catch(() => undefined);
                if (old && Array.isArray(old.trackPath)) saved = {track: old.trackPath, time: old.currentTime};
            }
        }
        // A saved edit can be waiting for an entirely different share to load. Once the
        // local write settles, a new complete selection can supersede that live queue.
        let reproject = !!edit;
        while (intent === selection && (pendingSave || reproject || revision !== libraryRevision)) {
            if (pendingSave) await pendingSave.done;
            revision = libraryRevision;
            reproject = false;
            chosen = await describe(folder, folderKey);
        }
        if (intent !== selection) return;
        if (!chosen) { view.onPlayBlockedNoPlayableTracks(folder); return; }
        const firstIdx = findFirstPlayableIdxInList(chosen.tracks, isPlayable);
        const selectedIdx = tapped ? chosen.tracks.findIndex(t => t.key === tappedKey && isPlayable(t)) : firstIdx;
        if (selectedIdx === undefined || selectedIdx < 0) {
            // A once-nonempty target may disappear while its selection waits for an edit.
            // Leave the existing song alone when that intent can no longer be fulfilled.
            if (initiallyEmpty && !chosen.tracks.length && !tapped && !inTerminalEvidenceState(evidenceState) && !isTrackBlockedFn(folder)) clearSession();
            else view.onPlayBlockedNoPlayableTracks(folder);
            return;
        }
        const fav = updateActiveFavorite(chosen.folder);
        configuredMode = fav?.hasPrivatePlayback ? fav.mode ?? 'all' : undefined;
        if (fav?.hasPrivatePlayback) {
            playbackMode = isValidMode(fav.mode) ? fav.mode : 'all';
            if (playbackMode !== 'timer') clearTimerDeadline('favorite-mode-restore');
            ui.setModeLabelText(playbackMode);
        }
        const resume = !tapped && fav?.hasPrivatePlayback && playbackMode !== 'shuffle' && saved
            ? chosen.tracks.find(t => (saved!.key ? t.key === saved!.key : pathEquals(t.path, saved!.track)) && isPlayable(t))
            : undefined;
        const target = resume ?? chosen.tracks[selectedIdx];
        const keepPass = sameFolder && playbackMode === 'shuffle' && queue?.folderKey === folderKey;
        const revised = reduceRefreshedTrackList({freshTrackList: chosen.tracks, prevTrackList: keepPass ? trackList : [],
            playbackTrack: tapped ? target : undefined, playbackMode, keyOf: t => t.key, random: Math.random});
        ++refreshRequest;
        edit?.resolve();
        edit = undefined;
        footerEl.removeAttribute('aria-busy');
        savedNeighbors = undefined;
        queue = chosen;
        trackList = revised.trackList;
        held = undefined;
        boundary = undefined;
        const idx = !tapped && playbackMode === 'shuffle' ? findFirstPlayableIdxInList(trackList, isPlayable)!
            : trackList.findIndex(t => t.key === target.key);
        await playNext(trackList[idx], idx, true, resume && Number.isFinite(saved?.time) ? Math.max(0, saved!.time) : 0);
    }

    // -- Public API ----------------------------------------------------------
    const getInfo = (): PlaybackInfo | undefined =>
        queue && current && !held ? {folder: queue.folder, track: current.path, phase} : undefined;

    const view: Playback = {
        getInfo,
        stop() {
            ++selection;
            pendingSave?.resolve();
            pendingSave = undefined;
            edit?.resolve();
            edit = undefined;
            footerEl.removeAttribute('aria-busy');
            clearSession();
        },
        collapse() { ui.setExpanded(false); },

        setContext(favorites, roots, denied = new Set(), known = true) {
            ++libraryRevision;
            favoritesRef = favorites;
            rootsRef = roots;
            deniedRoots = denied;
            sharesKnown = known;
            if (current && (denied.has(current.sourceRootKey) || known && current.sourceRootKey.startsWith('share:')
                && !roots.has(current.sourceRootKey))) clearSession();
        },

        async fenceQueueEdit() {
            ++libraryRevision;
            ++refreshRequest;
            if (edit) { edit.saved = false; }
            else {
                let release!: () => void;
                const done = new Promise<void>(resolve => { release = resolve; });
                edit = {saved: false, done, resolve: release};
                urlEngine.clearPrefetchState();
            }
            if (!pendingSave) {
                let release!: () => void;
                const done = new Promise<void>(resolve => { release = resolve; });
                pendingSave = {done, resolve: release};
            }
            if (!current || !queue) return;
            footerEl.setAttribute('aria-busy', 'true');
            // If the page dies between the library write and its revised queue, the old song
            // can be restored from these exact bytes and neighbors. A surviving key still wins.
            try {
                const snapshot = held ?? formerNeighbors();
                await persistNeighbors(snapshot);
                saveMmPlayback(true);
                saveMmTime();
            } catch (error) {
                pendingSave?.resolve();
                pendingSave = undefined;
                edit?.resolve();
                edit = undefined;
                footerEl.removeAttribute('aria-busy');
                throw error;
            }
        },
        refreshLibraryQueue,
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

        setAvailabilityContext(state, isTrackCached, isTrackBlocked, isEntryCached) {
            evidenceState = state;
            isEntryCachedFn = isEntryCached;
            isTrackCachedFn = isTrackCached;
            isTrackBlockedFn = isTrackBlocked ?? (() => false);
        },

        playTrack(path, accounts) { return selectQueue(path, accounts, true); },
        playFolder(path, accounts) { return selectQueue(path, accounts, false); },

        onChevronClick: () => {},
        onPlaybackChange: () => {},
        onExpandedChange: () => {},
        onPlayBlockedNoPlayableTracks: () => {},

        async restoreVisualState(folder, track, mode, expandedState, time, favId, accounts, bookmark) {
            // Restore once from the matching revision and never displace an explicit selection.
            if (selection) return true;
            if (accounts) accountsRef = accounts;
            const revision = libraryRevision;
            const initial = await describe(folder, bookmark?.folderKey ?? '');
            if (selection) return true;
            if (!initial || revision !== libraryRevision) return false;
            const entry = initial.tracks.find(t => bookmark?.key ? t.key === bookmark.key : pathEquals(t.path, track));
            let orphan = entry ? undefined : bookmark?.held;
            if (!entry && bookmark?.heldId) {
                const stored = await dbGet<{id: string; snapshot: HeldBookmark}>('oneplay_music_held');
                if (selection) return true;
                if (revision !== libraryRevision) return false;
                if (stored?.id === bookmark.heldId) orphan = parseGlobalPlaybackSave({...bookmark, held: stored.snapshot})?.held;
            }
            if ((!entry && !orphan) || (orphan && (deniedRoots.has(orphan.entry.sourceRootKey)
                || sharesKnown && orphan.entry.sourceRootKey.startsWith('share:') && !rootsRef.has(orphan.entry.sourceRootKey)))) {
                clearSession();
                return true;
            }
            queue = initial;
            playbackMode = mode;
            current = entry ?? orphan!.entry;
            held = orphan;
            savedNeighbors = orphan ? {snapshot: orphan, id: bookmark?.heldId} : undefined;
            const revised = reduceRefreshedTrackList({freshTrackList: initial.tracks, prevTrackList: [],
                playbackTrack: current, playbackMode, keyOf: t => t.key, random: Math.random});
            trackList = revised.trackList;
            currentTrackIdx = revised.currentTrackIdx;
            phase = 'loaded';
            activeFavId = favId;
            const favorite = favoritesRef?.getAll().find(f => f.id === favId);
            activeFavHasPrivatePlayback = !!favorite?.hasPrivatePlayback;
            configuredMode = activeFavHasPrivatePlayback ? favorite?.mode ?? 'all' : undefined;
            restoredCurrentTime = time;
            generation = crypto.randomUUID();
            saveMmPlayback();
            saveMmTime();
            updateFooter();
            ui.setModeLabelText(playbackMode);
            bumpTestPlaybackSeq();
            view.onPlaybackChange(getInfo());
            expansionEl.style.transition = 'none';
            ui.setExpanded(expandedState);
            requestAnimationFrame(() => { expansionEl.style.transition = ''; });
            return true;
        },
    };

    return view;
}
