import type { NativeLibrary } from './native-library.js';
import { createPlaybackUi, timeString } from './playback-ui.js';
import type { FolderPath } from './tree.js';
import type { PlaybackInfo } from './playback.js';

interface RangeBar {
    readonly name?: string;
    readonly size?: number;
    readonly cached?: [number, number][];
    readonly fetching?: [number, number][];
    readonly lookup?: boolean;
}

interface NativeSample {
    readonly bars?: RangeBar[];
    readonly item?: string;
    readonly path?: FolderPath;
    readonly state?: 'loading' | 'positioning' | 'playing' | 'paused' | 'stalled' | 'error' | 'ended';
    readonly position?: number;
    readonly duration?: number;
    readonly message?: string;
}

interface PlaybackReply { readonly sequence: number; readonly snapshot: NativeSample }

/** Swift owns the clock and queue. Each document paints only replies newer than its last sample. */
export function attachNativePlayback(native: NativeLibrary, footer: HTMLElement,
    updateTree: (info: PlaybackInfo | undefined) => void, reveal: (path: FolderPath) => void,
    showError: (message: string) => void) {
    footer.classList.add('native-player');
    let sample: NativeSample = {};
    let sequence = 0;
    let sampledAt = 0;
    const position = () => Math.min(sample.duration ?? 0, (sample.position ?? 0) +
        (sample.state === 'playing' ? (performance.now() - sampledAt) / 1000 : 0));
    let positionTimer: number | undefined;
    let positionWaitVisible = false;
    let treeItem: string | undefined;
    let treePhase: PlaybackInfo['phase'] | undefined;
    function paintIndicators(): void {
        const loading = sample.state === 'loading' || sample.state === 'stalled' || positionWaitVisible;
        const phase = loading ? 'loading' : 'loaded';
        if (treeItem !== sample.item || treePhase !== phase) {
            updateTree(sample.path ? {folder: sample.path.slice(0, -1), track: sample.path, phase} : undefined);
            treeItem = sample.item;
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
        footer.classList.toggle('visible', !!path);
        if (sample.state !== 'positioning' || last.state !== 'positioning' || last.item !== sample.item ||
            action === 'seek' || action === 'skip') {
            window.clearTimeout(positionTimer);
            positionWaitVisible = false;
            // A quick reposition keeps the chosen time visible. A sustained wait still gets feedback.
            if (sample.state === 'positioning') positionTimer = window.setTimeout(() => {
                positionWaitVisible = true;
                paintIndicators();
            }, 250);
        }
        paintIndicators();
        if (!path) return;
        ui.titleEl.textContent = path[path.length - 1];
        ui.setPlayPausePlaying(['playing', 'positioning', 'stalled', 'loading'].includes(sample.state ?? ''));
        if (strip && !strip.hidden && sample.bars) paintRanges(strip, sample);
        if (!ui.isScrubbing()) ui.scrubberTimeEl.textContent = sample.duration
            ? `${timeString(position())} / ${timeString(sample.duration)}` : sample.state === 'positioning' ? '0:00' : '';
        if (sample.state === 'error' && (last.item !== sample.item || last.state !== 'error'))
            showError(`${sample.message}. Tap Play to retry.`);
    }

    async function send(action: string, args: Record<string, unknown> = {}): Promise<void> {
        try {
            const debugRanges = !!strip && !strip.hidden && ui.isExpanded() && !document.hidden;
            paint(await native.playback(action, {...args, debugRanges}) as PlaybackReply, action);
        } catch {
            if (action !== 'snapshot') showError('The player could not apply that command. Try again.');
        }
    }

    const toggle = () => {
        const action = ['playing', 'positioning', 'loading', 'stalled'].includes(sample.state ?? '') ? 'pause' : 'play';
        send(action, {item: sample.item});
        return action;
    };
    const ui = createPlaybackUi({
        footerEl: footer,
        getMode: () => 'all',
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
        try { await send('snapshot'); } finally { reading = false; }
    }
    window.setInterval(refresh, 1000);
    document.addEventListener('visibilitychange', refresh);
    refresh();
    return {
        start: (tracks: {driveId: string; itemId: string; path: FolderPath}[], index: number) => send('start', {tracks, index}),
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
