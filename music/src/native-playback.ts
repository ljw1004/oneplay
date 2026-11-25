import type { NativeLibrary } from './native-library.js';
import { createPlaybackUi, timeString } from './playback-ui.js';
import type { FolderPath } from './tree.js';
import type { LibraryQueue } from './tracks.js';
import type { TimerDuration } from './settings.js';
import type { PlaybackMode, PlaybackInfo } from './playback.js';

interface RangeBar {
    readonly name?: string;
    readonly size?: number;
    readonly cached?: [number, number][];
    readonly fetching?: [number, number][];
    readonly lookup?: boolean;
}

interface NativeSample {
    readonly hasHistory?: boolean;
    readonly bars?: RangeBar[];
    readonly mode?: PlaybackMode;
    readonly session?: string;
    readonly folder?: FolderPath;
    readonly folderKey?: string;
    readonly sourceRootKey?: string;
    readonly revision?: number;
    readonly fenced?: boolean;
    readonly title?: string;
    readonly item?: string;
    readonly targetRevision?: number;
    readonly advanced?: boolean;
    readonly path?: FolderPath;
    readonly state?: 'buffering' | 'positioning' | 'playing' | 'paused' | 'error' | 'ended';
    readonly position?: number;
    readonly duration?: number;
    readonly message?: string;
}

interface PlaybackReply { readonly sequence: number; readonly snapshot: NativeSample }

/** Swift owns the clock and queue. Each document paints only replies newer than its last sample. */
export function attachNativePlayback(native: NativeLibrary, footer: HTMLElement,
    updateTree: (info: PlaybackInfo | undefined, advanced?: boolean) => void, reveal: (path: FolderPath) => void,
    showError: (message: string) => void,
    rebuild?: (folder: FolderPath, key: string) => Promise<LibraryQueue | undefined> | undefined,
    getConnected?: () => readonly string[] | undefined,
    saveFavoriteMode?: (folder: FolderPath, mode: PlaybackMode) => Promise<void>,
    favoriteSettings?: (folder: FolderPath) => {favorite?: string; mode?: PlaybackMode},
    migratePrivateSpots?: (only?: string) => Promise<void>,
    legacySession?: () => {folder: FolderPath; track: FolderPath; seconds: number; mode: PlaybackMode; timer: TimerDuration; consume: () => void} | undefined) {
    footer.classList.add('native-player');
    let sample: NativeSample = {};
    let sequence = 0;
    let sampledAt = 0;
    let projectedSources: {session: string; roots: Set<string>} | undefined;
    const position = () => Math.min(sample.duration || Infinity, (sample.position ?? 0) +
        (sample.state === 'playing' ? (performance.now() - sampledAt) / 1000 : 0));
    let bufferTimer: number | undefined;
    let bufferWaitVisible = false;
    let targetCommands = 0;
    let treePath: string | undefined;
    let issuedRevision = 0;
    let buildGeneration = 0;
    let refreshGeneration = 0;
    let pendingSelection: {queue: LibraryQueue; key?: string; timer: TimerDuration; mode?: PlaybackMode} | undefined;
    let intent: {id: string; base: Promise<string>} | undefined;
    let pendingRevision = false;
    let awaitingSave = false;
    let publication: {done: Promise<void>; resolve: () => void} | undefined;
    let refreshing: Promise<void> | undefined;
    let refreshAgain = false;
    let retrying = false;
    let treePhase: PlaybackInfo['phase'] | undefined;
    function paintIndicators(advanced = false, targetChanged = false): void {
        // Only a sustained input wait can show the spinner. Once visible it covers local
        // preparation between reads until Swift reports playable output for this target.
        const canStartWait = !targetCommands && sample.state === 'buffering';
        if (targetChanged || (sample.state !== 'positioning' && sample.state !== 'buffering')) bufferWaitVisible = false;
        if (targetChanged || !canStartWait) {
            window.clearTimeout(bufferTimer);
            bufferTimer = undefined;
        }
        if (canStartWait && !bufferWaitVisible && bufferTimer === undefined) {
            bufferTimer = window.setTimeout(() => {
                bufferWaitVisible = true;
                paintIndicators();
            }, 250);
        }
        const loading = bufferWaitVisible;
        const phase = loading ? 'loading' : 'loaded';
        const path = JSON.stringify([sample.folder, sample.path]);
        if (treePath !== path || treePhase !== phase) {
            updateTree(sample.path ? {folder: sample.folder?.length ? sample.folder : sample.path.slice(0, -1), track: sample.path, phase} : undefined, advanced);
            treePath = path;
            treePhase = phase;
        }
        ui.indicatorSvg.classList.toggle('loading', loading);
        ui.indicatorSvg.classList.toggle('loaded', !loading);
        ui.scrubberTextEl.classList.toggle('loading', loading);
    }

    function paint(reply: PlaybackReply, action?: string): void {
        if (reply.sequence <= sequence) return;
        sequence = reply.sequence;
        const last = sample;
        sample = reply.snapshot;
        sampledAt = performance.now();
        const path = sample.path;
        footer.classList.toggle('visible', !!sample.item);
        ui.setModeLabelText(sample.mode ?? 'all');
        ui.indicatorSvg.setAttribute('aria-disabled', String(!path));
        if (last.session !== sample.session || !intent && last.hasHistory === undefined && sample.hasHistory === false) {
            issuedRevision = sample.revision ?? 0;
            pendingRevision = !!sample.fenced;
            awaitingSave = false;
            publication?.resolve();
            publication = undefined;
            if (action !== 'start') refreshLibraryQueue().catch(() => { pendingRevision = true; });
        }
        const itemChanged = last.item !== sample.item;
        paintIndicators(sample.advanced && !!last.item && itemChanged && last.session === sample.session,
            itemChanged || last.targetRevision !== sample.targetRevision);
        if (!sample.item) return;
        ui.titleEl.textContent = sample.title ?? path?.at(-1) ?? '';
        ui.setPlayPausePlaying(['playing', 'positioning', 'buffering'].includes(sample.state ?? ''));
        if (strip && !strip.hidden && sample.bars) paintRanges(strip, sample);
        if (!ui.isScrubbing()) ui.scrubberTimeEl.textContent = sample.duration
            ? `${timeString(position())} / ${timeString(sample.duration)}` : timeString(position());
        if (sample.state === 'error' && (last.item !== sample.item || last.state !== 'error'))
            showError(`${sample.message}. Tap Play to retry.`);
    }

    /** Defer a new spinner while a command is in flight. A rejected command keeps the current target's visible wait. */
    async function applyAndPaint(action: string, args: Record<string, unknown>): Promise<PlaybackReply> {
        const changesTarget = ['seek', 'skip', 'next', 'previous', 'play', 'pause', 'start'].includes(action);
        if (changesTarget) { targetCommands++; paintIndicators(); }
        try {
            if (['play', 'next', 'previous', 'seek', 'skip'].includes(action)) {
                await native.waitForPlaybackAccess?.(root => {
                    if (sample.sourceRootKey === root) return true; // A held song can be outside the revised queue.
                    if (projectedSources && projectedSources.session === sample.session) return projectedSources.roots.has(root);
                    const folderRoot = sample.folder?.[1];
                    return !folderRoot || folderRoot.startsWith('fav:') || folderRoot === root;
                });
            }
            const debugRanges = !!strip && !strip.hidden && ui.isExpanded() && !document.hidden;
            const reply = await native.playback(action, {...args, debugRanges}) as PlaybackReply;
            paint(reply, action);
            return reply;
        } finally {
            if (changesTarget) { targetCommands--; paintIndicators(); }
        }
    }

    async function send(action: string, args: Record<string, unknown> = {}): Promise<void> {
        try { await applyAndPaint(action, args); }
        catch { if (action !== 'snapshot') showError('The player could not apply that command. Try again.'); }
    }

    const toggle = () => {
        const action = ['playing', 'positioning', 'buffering'].includes(sample.state ?? '') ? 'pause' : 'play';
        send(action, {item: sample.item});
        return action;
    };
    const ui = createPlaybackUi({
        footerEl: footer,
        getMode: () => sample.mode ?? 'all',
        onModeCycleClick: async () => {
            const {session, mode} = sample;
            await send('cycleMode', {item: sample.item});
            if (session === sample.session && mode !== sample.mode && sample.mode && sample.folder) {
                try { await saveFavoriteMode?.(sample.folder, sample.mode); }
                catch { showError('Could not save this favorite’s play mode.'); }
            }
        },
        getDuration: () => sample.duration || undefined,
        onScrubStart: () => {
            if (!sample.duration) return undefined;
            const item = sample.item;
            return {startTime: position(), isCurrent: () => item === sample.item,
                commitScrubIfCurrent: seconds => send('seek', {item, seconds})};
        },
        onExpandedChange: () => { if (strip) send('snapshot'); },
        onChevronClick: () => { if (sample.path) reveal(sample.path); },
        onFooterPlayPauseClick: toggle, onCenterTapToggle: toggle,
        onPrev: () => send('previous', {item: sample.item}), onNext: () => send('next', {item: sample.item}),
        onSeekBy: seconds => send('skip', {item: sample.item, seconds}),
    });
    const strip = native.state.debugPlayback ? document.createElement('div') : undefined;
    if (strip) {
        strip.className = 'audio-ranges';
        strip.hidden = true;
        paintRanges(strip, {bars: [{}, {}, {}]});
        ui.expansionEl.prepend(strip);
    }
    window.addEventListener('oneplay-playback', event => {
        if (!document.hidden) paint((event as CustomEvent<PlaybackReply>).detail);
    });
    // Read on attach and resume. A suspended page owes Swift no work for the queue to advance.
    let reading = false;
    async function refresh(): Promise<void> {
        if (document.hidden || reading) return;
        reading = true;
        try {
            await send('snapshot');
            if (pendingRevision && !awaitingSave && !retrying && !pendingSelection && !refreshing) {
                retrying = true;
                try { await refreshLibraryQueue(); } catch { pendingRevision = true; } finally { retrying = false; }
            }
        } finally { reading = false; }
    }
    window.setInterval(refresh, 1000);
    document.addEventListener('visibilitychange', refresh);
    refresh();
    /** Small albums commit in one message. The chunks of a large library are private
     * to this document until commit. A newer intent invalidates the loop at its next await. */
    async function transfer(queue: LibraryQueue, action: 'start' | 'revise', args: Record<string, unknown>): Promise<void> {
        const generation = ++buildGeneration;
        const {tracks, ...folder} = queue;
        const commit = async (data: Record<string, unknown>) => {
            const connected = getConnected?.();
            if (connected) await native.syncPlaybackMembership(connected);
            await native.waitForPlaybackAccess?.(root => tracks.some(t => t.sourceRootKey === root));
            if (generation !== buildGeneration) return;
            const reply = await applyAndPaint(action, {...folder, ...favoriteSettings?.(folder.folder), ...args, ...data});
            const session = reply.snapshot.session;
            const accepted = action === 'start' ? session !== args.base
                : session === args.session && reply.snapshot.revision === args.revision && !reply.snapshot.fenced;
            if (accepted && generation === buildGeneration && session && session === sample.session && reply.snapshot.folderKey === folder.folderKey) {
                projectedSources = {session, roots: new Set(tracks.map(t => t.sourceRootKey))};
            }
            if (action === 'revise' && reply.snapshot.session === args.session) {
                if (reply.snapshot.fenced) throw new Error('Edit is still pending');
                if ((reply.snapshot.revision ?? 0) >= Number(args.revision)) {
                    pendingRevision = false;
                    publication?.resolve();
                    publication = undefined;
                }
            }
        };
        try {
            if (tracks.length <= 512) {
                await commit({tracks});
                return;
            }
            const build = crypto.randomUUID();
            await native.playback('beginQueue', {build, count: tracks.length, ...args});
            for (let offset = 0; offset < tracks.length; offset += 512) {
                if (generation !== buildGeneration) return;
                await native.playback('queueChunk', {build, offset, tracks: tracks.slice(offset, offset + 512)});
            }
            if (generation === buildGeneration) await commit({build});
        } catch {
            if (generation === buildGeneration) {
                pendingRevision = action === 'revise';
                showError('The player could not load this queue. Try again.');
                if (action === 'revise') throw new Error('Queue revision was not acknowledged');
            }
        } finally {
            if (generation === buildGeneration && action === 'start') pendingSelection = undefined;
        }
    }

    /** Invalidate a slow build at the tap, before traversal yields to another event. */
    function beginSelection(): void {
        ++buildGeneration;
        ++refreshGeneration;
        pendingSelection = undefined;
        const id = crypto.randomUUID();
        const base = native.playback('intent', {intent: id})
            .then(reply => (reply as {base: string}).base).catch(() => '');
        intent = {id, base};
    }

    /** Cancel only the vanished selection. A newer tap can arrive before WebKit replies. */
    async function clearSelectionIntent(): Promise<void> {
        const cancelled = intent;
        intent = undefined;
        pendingSelection = undefined;
        if (cancelled) await send('cancelIntent', {intent: cancelled.id});
    }

    async function start(queue: LibraryQueue, index: number, selected: boolean, timer: TimerDuration, mode?: PlaybackMode): Promise<void> {
        if (!intent) beginSelection();
        const target = intent!;
        const generation = buildGeneration;
        ++refreshGeneration;
        pendingSelection = {queue, key: selected ? queue.tracks[index].key : undefined, timer, mode};
        const favorite = favoriteSettings?.(queue.folder).favorite;
        if (favorite) await migratePrivateSpots?.(favorite);
        const base = await target.base;
        if (target !== intent || generation !== buildGeneration) return;
        await transfer(queue, 'start', {intent: target.id, base, index, selected, timer, ...(!favoriteSettings && mode && {mode})});
        if (target === intent && !pendingSelection) intent = undefined;
    }

    /** The next durable library edit must not leave an obsolete successor playing under lock. */
    async function fenceQueueEdit(): Promise<void> {
        ++buildGeneration;
        ++refreshGeneration;
        while (sample.session && sample.folder?.[1]?.startsWith('fav:')) {
            const session = sample.session;
            const revision = ++issuedRevision;
            const reply = await native.playback('fence', {session, revision}) as PlaybackReply;
            paint(reply);
            if (reply.snapshot.session === session && reply.snapshot.fenced && Number(reply.snapshot.revision) >= revision) {
                pendingRevision = true;
                awaitingSave = true;
                return;
            }
        }
    }

    /** Concurrent publishers wait for the same final acknowledgment. Data arriving during
     * a walk requests another projection before the callers publish their tree changes. */
    function refreshLibraryQueue(saved = false): Promise<void> {
        if (saved) awaitingSave = false;
        if (saved && pendingRevision && !publication) {
            let resume!: () => void;
            const done = new Promise<void>(resolve => { resume = resolve; });
            publication = {done, resolve: resume};
        }
        refreshAgain = true;
        if (!refreshing) refreshing = Promise.resolve().then(async () => {
            try {
                while (refreshAgain) {
                    refreshAgain = false;
                    await projectLibrary();
                }
            } finally { refreshing = undefined; }
        });
        // A transient transfer failure or an unloaded share leaves the original edit
        // waiting. A later projection wakes its publisher after Swift accepts the order.
        const waiting = saved && publication;
        return waiting ? refreshing.catch(() => { pendingRevision = true; }).then(() => waiting.done) : refreshing;
    }

    async function projectLibrary(): Promise<void> {
        const refresh = ++refreshGeneration;
        if (!intent || pendingSelection) ++buildGeneration;
        const connected = getConnected?.();
        if (connected) await native.syncPlaybackMembership(connected);
        if (awaitingSave || (intent && !pendingSelection)) return;
        await migratePrivateSpots?.();
        if (refresh !== refreshGeneration) return;
        // Only an empty native installation admits the bundled origin's old global record.
        // An explicit tap invalidates this walk before it can install a paused session.
        const legacy = sample.hasHistory === false && !sample.session && !intent && legacySession?.();
        if (legacy && rebuild) {
            const queue = await rebuild(legacy.folder, '');
            if (refresh !== refreshGeneration || intent) return;
            if (queue) {
                const index = queue.tracks.findIndex(t => t.path.length === legacy.track.length && t.path.every((v, i) => v === legacy.track[i]));
                if (index >= 0) await transfer(queue, 'start', {base: '', index, selected: true, mode: legacy.mode,
                    timer: legacy.timer, legacyPosition: legacy.seconds});
                if (index < 0 || sample.hasHistory) legacy.consume();
                return;
            }
        }
        if (pendingSelection && rebuild) {
            const {queue, key, timer, mode} = pendingSelection;
            const latest = await rebuild(queue.folder, queue.folderKey);
            if (refresh !== refreshGeneration || !latest) return;
            const index = key ? latest.tracks.findIndex(t => t.key === key) : 0;
            if (latest.tracks[index]) { await start(latest, index, !!key, timer, mode); return; }
            ++buildGeneration;
            await clearSelectionIntent();
            if (refresh !== refreshGeneration) return;
            showError('The selected track or folder is no longer available.');
        }
        if (!sample.session || !sample.folder?.length || !sample.folderKey || !rebuild) return;
        const session = sample.session;
        const queue = await rebuild(sample.folder, sample.folderKey);
        if (refresh !== refreshGeneration || session !== sample.session) return;
        if (!queue && pendingRevision) throw new Error('Waiting for the playlist’s source index');
        if (queue) await transfer(queue, 'revise', {session: sample.session, revision: ++issuedRevision});
    }
    return {
        start, beginSelection, fenceQueueEdit,
        async cancelSelection(): Promise<void> {
            await clearSelectionIntent();
            if (!intent) await refreshLibraryQueue();
        },
        refreshLibraryQueue,
        setTimer: (timer: TimerDuration) => send('timer', {timer}),
        currentFolder: () => sample.folder,
        collapse: () => ui.setExpanded(false),
        setDebugEnabled(enabled: boolean): void {
            if (!strip || strip.hidden === !enabled) return;
            strip.hidden = !enabled;
            // Recompute the open drawer height and immediately update its native subscription.
            if (ui.isExpanded()) ui.setExpanded(true);
        },
        currentPath: () => sample.path,
    };
}

/** All colored spans use file byte offsets. The white line uses elapsed time as a fraction of duration. */
function paintRanges(strip: HTMLElement, sample: NativeSample): void {
    strip.replaceChildren(...(sample.bars ?? []).map((bar, index) => {
        const slot = document.createElement('div');
        const label = document.createElement('div');
        const role = ['Prev', 'Current', 'Next'][index];
        label.textContent = bar.name ? role + ' · ' + bar.name : role;
        const rail = document.createElement('div');
        rail.className = 'audio-range-rail';
        slot.append(label, rail);
        slot.title = bar.name ? role + ' · ' + bar.name : 'No ' + role.toLowerCase() + ' track';
        if (!bar.name) { slot.className = 'empty'; return slot; }
        const bytes = bar.cached?.reduce((total, [start, end]) => total + end - start, 0) ?? 0;
        rail.setAttribute('role', 'img');
        rail.setAttribute('aria-label', [slot.title, `${bytes} bytes cached`, bar.lookup ? 'Graph lookup' : '',
            ...(bar.fetching ?? []).map(([start, end]) => `fetching bytes ${start} through ${end - 1}`)].filter(Boolean).join(', '));
        for (const [kind, ranges] of [['cached', bar.cached], ['fetching', bar.fetching]] as const) {
            for (const [start, end] of ranges ?? []) {
                const segment = document.createElement('i');
                segment.className = kind;
                segment.style.left = `${100 * start / bar.size!}%`;
                segment.style.width = `${100 * (end - start) / bar.size!}%`;
                rail.append(segment);
            }
        }
        if (index === 1 && sample.duration) {
            const marker = document.createElement('i');
            marker.className = 'marker';
            marker.style.left = `${Math.min(100, 100 * (sample.position ?? 0) / sample.duration)}%`;
            rail.append(marker);
        }
        if (bar.lookup) {
            const dot = document.createElement('i');
            dot.className = 'lookup';
            rail.append(dot);
        }
        return slot;
    }));
}
