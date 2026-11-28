/**
 * Playback footer/expansion UI component.
 *
 * Scope:
 * - Owns footer/expansion DOM construction and pointer/gesture wiring.
 * - Emits user-intent callbacks (mode cycle, play/pause, prev/next, seek).
 * - Owns transient scrub/expansion visual state.
 *
 * Non-scope:
 * - Playback policy decisions and track selection.
 * - Reading or controlling the media element.
 */
import { type PlaybackMode } from './playback.js';
import { logCatch } from './logger.js';

export interface DrawerState {
    readonly expanded: boolean;
    readonly autoExpand: boolean;
}

/** The workspace owns persistence and the tree owns marker geometry. */
export interface DrawerView {
    readonly initial: DrawerState;
    readonly onStateChange: (state: DrawerState) => void;
    readonly captureMarkerReveal: () => (() => void) | undefined;
    readonly coveredViews?: {readonly tree: HTMLElement; readonly settings: HTMLElement};
}

/** A wheel release is valid only for the play on which the pointer went down. */
interface ScrubGesture {
    readonly startTime: number;
    readonly isCurrent: () => boolean;
    /** Seek, apply the press-time play intent and rearm the sleep timer if this play still owns the gesture. */
    readonly commitScrubIfCurrent: (seconds: number) => void;
}

export interface PlaybackUiDeps {
    readonly footerEl: HTMLElement;
    readonly drawer?: DrawerView;
    readonly getMode: () => PlaybackMode;
    readonly getDuration: () => number | undefined;
    readonly onScrubStart: () => ScrubGesture | undefined;
    readonly onModeCycleClick?: () => void;
    readonly onLayoutChange: (expanded: boolean) => void;
    readonly onChevronClick: () => void;
    readonly onFooterPlayPauseClick: () => void;
    readonly onCenterTapToggle: () => 'play' | 'pause' | undefined;
    readonly onPrev: () => void;
    readonly onNext: () => void;
    readonly onSeekBy: (delta: number) => void;
}

export interface PlaybackUiController {
    readonly indicatorSvg: SVGSVGElement;
    readonly titleEl: HTMLDivElement;
    readonly scrubberTextEl: HTMLDivElement;
    readonly scrubberTimeEl: HTMLSpanElement;
    readonly expansionEl: HTMLDivElement;
    setModeLabelText(mode: PlaybackMode): void;
    setPlayPausePlaying(isPlaying: boolean): void;
    setTargetVisible(visible: boolean): boolean;
    restoreDrawer(): void;
    beginPlaybackAction(): number;
    updateDrawerAfterPlay(revision: number | undefined, firstTarget?: boolean): void;
    collapseForBrowsing(): void;
    collapseAfterStop(): void;
    resizeDrawer(): void;
    isExpanded(): boolean;
    isScrubbing(): boolean;
}

/**
 * Formats seconds as m:ss or h:mm:ss (for durations >= 60 minutes).
 */
export function timeString(seconds: number): string {
    const totalSecs = Math.floor(Math.max(0, seconds));
    const hrs = Math.floor(totalSecs / 3600);
    const mins = Math.floor((totalSecs % 3600) / 60);
    const secs = totalSecs % 60;
    return hrs > 0
        ? `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
        : `${mins}:${String(secs).padStart(2, '0')}`;
}

/** The captured pointer only needs its angle. Measure button geometry only for a hit test. */
function wheelPosition(shell: HTMLElement, event: PointerEvent | MouseEvent) {
    const rect = shell.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const x = event.clientX - centerX;
    const y = event.clientY - centerY;
    return {
        angle: Math.atan2(y, x),
        getZone() {
            const radius = Math.hypot(x, y);
            const buttons = Array.from(shell.querySelectorAll<HTMLButtonElement>('.scrubber-edge-button'));
            const buttonRadius = buttons.reduce((average, button, index) => {
                const r = button.getBoundingClientRect();
                const radius = Math.hypot(r.left + r.width / 2 - centerX, r.top + r.height / 2 - centerY);
                return (average * index + radius) / (index + 1);
            }, 0);
            const wheelThickness = Math.max(Math.min(rect.width - buttonRadius * 2, 60), 40);
            return radius < buttonRadius - wheelThickness / 2 ? 'inside'
                : radius > buttonRadius + wheelThickness / 2 ? 'outside' : 'wheel';
        },
    };
}

export function createPlaybackUi(deps: PlaybackUiDeps): PlaybackUiController {
    const { footerEl } = deps;

    // SVG indicator (chevron > when loaded, spinner ⟳ when loading)
    const indicatorSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    indicatorSvg.setAttribute('viewBox', '0 0 20 36');
    indicatorSvg.classList.add('footer-indicator', 'loaded');
    indicatorSvg.innerHTML = '<path d="M4 12 L10 19 L4 26"/><circle cx="10" cy="19" r="6"/>';

    const titleEl = document.createElement('div');
    titleEl.className = 'footer-title';

    const playpauseBtn = document.createElement('button');
    playpauseBtn.className = 'footer-playpause';
    playpauseBtn.type = 'button';
    playpauseBtn.textContent = '\u25B6\uFE0E'; // ▶︎

    // Wrap existing footer children in .footer-bar (the collapsed controls row)
    const footerBar = document.createElement('div');
    footerBar.className = 'footer-bar';
    footerBar.append(indicatorSvg, titleEl, playpauseBtn);

    // Gripper is a direct child of #footer, above expansion — it's the
    // top edge of the drawer, stays at top whether collapsed or expanded.
    const gripRow = document.createElement('div');
    gripRow.className = 'footer-grip-row';
    const gripper = document.createElement('button');
    gripper.type = 'button';
    gripper.className = 'footer-gripper';
    gripper.setAttribute('aria-label', 'Player controls');
    gripper.setAttribute('aria-expanded', 'false');
    gripRow.append(gripper);

    // -- Expansion DOM -------------------------------------------------------

    const expansion = document.createElement('div');
    expansion.className = 'expansion';
    expansion.inert = true;

    const expansionInner = document.createElement('div');
    expansionInner.className = 'expansion-inner';

    // Mode label button: top-left of expansion-inner, shows current mode
    const modeLabel = document.createElement('button');
    modeLabel.className = 'mode-label';
    modeLabel.type = 'button';
    modeLabel.textContent = deps.getMode();
    modeLabel.disabled = !deps.onModeCycleClick;

    const scrubberShell = document.createElement('div');
    scrubberShell.className = 'scrubber-shell';

    const scrubberWheel = document.createElement('div');
    scrubberWheel.className = 'scrubber-wheel';

    const scrubberText = document.createElement('div');
    scrubberText.className = 'scrubber-text';
    // Children: time text span + spinner SVG (only one visible at a time).
    // Spinner reuses the same circle+dasharray+spin pattern as track-indicator.
    const scrubberTime = document.createElement('span');
    const scrubberSpinner = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    scrubberSpinner.setAttribute('viewBox', '0 0 36 36');
    scrubberSpinner.classList.add('scrubber-spinner');
    scrubberSpinner.innerHTML = '<circle cx="18" cy="18" r="10"/>';
    scrubberText.append(scrubberTime, scrubberSpinner);

    // Scrub thumb: SVG arc lozenge. A single <circle> with stroke-dasharray
    // showing a 45° arc with stroke-linecap:round for curved ends.
    // Arc position controlled by stroke-dashoffset (not SVG rotation), so
    // the SVG bounding box stays axis-aligned and nothing gets clipped.
    const scrubberThumb = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    scrubberThumb.classList.add('scrubber-thumb');
    scrubberThumb.setAttribute('hidden', '');
    const thumbCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    thumbCircle.setAttribute('stroke-linecap', 'round');
    scrubberThumb.appendChild(thumbCircle);
    let thumbRadius = 0; // cached for setThumbAngle dashoffset math

    /** Syncs SVG circle geometry to current shell pixel size. */
    const syncThumbGeometry = (): void => {
        const w = scrubberShell.offsetWidth;
        scrubberThumb.setAttribute('viewBox', `0 0 ${w} ${w}`);
        const center = w / 2;
        thumbRadius = center - 32.5;
        const circumference = 2 * Math.PI * thumbRadius;
        const arcLength = circumference * 67.5 / 360;
        thumbCircle.setAttribute('cx', center.toString());
        thumbCircle.setAttribute('cy', center.toString());
        thumbCircle.setAttribute('r', thumbRadius.toString());
        thumbCircle.setAttribute('stroke-width', '60');
        thumbCircle.setAttribute('stroke-dasharray', `${arcLength} ${circumference - arcLength}`);
    };

    /** Positions the arc centered at the given angle (radians, atan2 convention). */
    const setThumbAngle = (angle: number): void => {
        const halfArc = Math.PI * 67.5 / 360;
        thumbCircle.setAttribute('stroke-dashoffset', (-(angle - halfArc) * thumbRadius).toString());
    };

    /** Creates a scrubber edge button at the given position with label text. */
    const makeEdgeBtn = (pos: string, label: string): HTMLButtonElement => {
        const btn = document.createElement('button');
        btn.className = `scrubber-edge-button ${pos}`;
        btn.type = 'button';
        btn.textContent = label;
        return btn;
    };

    const prevBtn = makeEdgeBtn('left', '\u23EE\uFE0E'); // ⏮︎
    const nextBtn = makeEdgeBtn('right', '\u23ED\uFE0E'); // ⏭︎
    const skipFwdBtn = makeEdgeBtn('top', '+30s');
    const skipBackBtn = makeEdgeBtn('bottom', '-15s');
    scrubberShell.append(scrubberWheel, scrubberText, prevBtn, nextBtn, skipFwdBtn, skipBackBtn, scrubberThumb);

    // Play/pause flash: centered in scrubber, animated on center tap
    const scrubberFlash = document.createElement('div');
    scrubberFlash.className = 'scrubber-flash';
    scrubberFlash.addEventListener('animationend', () => {
        scrubberFlash.classList.remove('animate');
    });
    scrubberShell.appendChild(scrubberFlash);
    expansionInner.append(modeLabel, scrubberShell);
    expansion.appendChild(expansionInner);

    // Gripper at top (drawer handle), expansion in middle, footer-bar at bottom
    footerEl.append(gripRow, expansion, footerBar);

    // -- Expand/collapse -----------------------------------------------------

    let {expanded, autoExpand} = deps.drawer?.initial ?? {expanded: false, autoExpand: true};
    let targetVisible = false;
    let actionRevision = 0;
    const fullHeight = matchMedia('(orientation: landscape) and (max-height: 500px)');
    const isExpanded = () => footerEl.classList.contains('expanded');

    /** Match the fixed landscape drawer, preserving the workspace sign-out lock. */
    function syncCoveredViews(): void {
        const views = deps.drawer?.coveredViews;
        if (!views) return;
        const covered = fullHeight.matches && isExpanded();
        if (covered && (views.tree.contains(document.activeElement) || views.settings.contains(document.activeElement))) {
            gripper.focus({preventScroll: true});
        }
        views.tree.inert = covered || footerEl.inert;
        views.settings.inert = covered;
    }

    function resizeDrawer(): void {
        if (isExpanded()) {
            expansion.style.setProperty('--drawer-content-height', `${expansion.scrollHeight}px`);
        }
    }

    /** The saved layout survives an absent target. Only a manual gesture changes preference. */
    function setExpanded(value: boolean, reason: 'manual' | 'automatic' | 'restore'): void {
        const show = value && targetVisible;
        if (show && document.body.classList.contains('select-mode')) return;
        const preference = reason === 'manual' ? value : autoExpand;
        const changed = value !== expanded || preference !== autoExpand;
        expanded = value;
        autoExpand = preference;
        if (changed) deps.drawer?.onStateChange({expanded, autoExpand});
        if (show === isExpanded()) return;

        const reveal = show && reason !== 'restore' && !fullHeight.matches ? deps.drawer?.captureMarkerReveal() : undefined;
        const revision = actionRevision;
        if (!show) {
            if (scrub) endScrub(scrub.pointerId);
            if (targetVisible && expansion.contains(document.activeElement)) gripper.focus({preventScroll: true});
        }
        if (reason === 'restore') expansion.style.transition = 'none';
        footerEl.classList.toggle('expanded', show);
        gripper.setAttribute('aria-expanded', String(show));
        expansion.inert = !show;
        if (show) {
            resizeDrawer();
            modeLabel.textContent = deps.getMode();
        }
        syncCoveredViews();
        if (reason === 'restore') {
            void expansion.offsetHeight; // Commit the restored layout before reenabling transitions.
            expansion.style.transition = '';
        }
        deps.onLayoutChange(show);
        if (!reveal) return;
        const revealIfCurrent = () => {
            if (expanded && targetVisible && actionRevision === revision && !fullHeight.matches) reveal();
        };
        const transition = expansion.getAnimations().find(animation =>
            (animation as CSSTransition).transitionProperty === 'max-height');
        if (transition) transition.finished.then(revealIfCurrent, () => {}).catch(logCatch('drawer marker reveal'));
        else revealIfCurrent();
    }

    // -- Mode and drawer handlers -------------------------------------------

    modeLabel.addEventListener('click', (e) => {
        e.stopPropagation();
        deps.onModeCycleClick?.();
        modeLabel.textContent = deps.getMode();
    });

    window.addEventListener('resize', resizeDrawer);
    fullHeight.addEventListener('change', syncCoveredViews);

    const setExpandedManually = (value: boolean): void => {
        if (!targetVisible || footerEl.inert) return;
        actionRevision++;
        setExpanded(value, 'manual');
    };

    expansionInner.addEventListener('click', (e) => {
        if (e.target === e.currentTarget) setExpandedManually(false);
    });

    gripper.addEventListener('click', () => {
        if (document.body.classList.contains('select-mode')) return;
        setExpandedManually(!isExpanded());
    });

    // -- Gripper hit zone ----------------------------------------------------

    const GRIPPER_EXTEND_PX = 22;
    const safeAreaBottom = (): number =>
        parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sab')) || 0;
    const gripperOverlay = document.createElement('div');
    gripperOverlay.className = 'compact-gripper-reach';
    gripperOverlay.style.height = `${GRIPPER_EXTEND_PX}px`;
    footerEl.appendChild(gripperOverlay);

    let drawerSwipe: {pointerId: number; startY: number; opening: boolean} | undefined;
    /** Only the compact drawer can begin a swipe in the 22 px above its edge. */
    document.addEventListener('pointerdown', (e) => {
        if (!targetVisible || footerEl.inert || e.button !== 0 || document.body.classList.contains('select-mode')) return;
        const opening = !isExpanded();
        const footerTop = footerEl.getBoundingClientRect().top;
        const safeAreaCutoff = window.innerHeight - safeAreaBottom();
        if (e.clientY < footerTop - (opening ? GRIPPER_EXTEND_PX : 0) || e.clientY >= safeAreaCutoff) return;
        if (!opening) {
            const target = e.target as Node;
            if (!footerEl.contains(target) || (scrubberShell.contains(target) && wheelPosition(scrubberShell, e).getZone() === 'wheel')) return;
        }
        drawerSwipe = {pointerId: e.pointerId, startY: e.clientY, opening};
    }, true);
    document.addEventListener('pointermove', (e) => {
        if (e.pointerId !== drawerSwipe?.pointerId) return;
        const {startY, opening} = drawerSwipe;
        if ((opening ? startY - e.clientY : e.clientY - startY) < 30) return;
        drawerSwipe = undefined;
        if (opening !== isExpanded()) setExpandedManually(opening);
    });
    const clearDrawerSwipe = (e: PointerEvent): void => {
        if (e.pointerId === drawerSwipe?.pointerId) drawerSwipe = undefined;
    };
    document.addEventListener('pointerup', clearDrawerSwipe);
    document.addEventListener('pointercancel', clearDrawerSwipe);

    // -- Footer controls -----------------------------------------------------

    indicatorSvg.addEventListener('click', (e) => {
        e.stopPropagation();
        deps.onChevronClick();
    });
    playpauseBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deps.onFooterPlayPauseClick();
    });
    skipFwdBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        actionRevision++;
        deps.onSeekBy(+30);
    });
    skipBackBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        actionRevision++;
        deps.onSeekBy(-15);
    });
    prevBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        actionRevision++;
        deps.onPrev();
    });
    nextBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        actionRevision++;
        deps.onNext();
    });

    // -- Scrubber interaction ------------------------------------------------

    let scrub: {
        pointerId: number;
        gesture: ScrubGesture;
        startAngle: number;
        previewTime: number;
    } | undefined;

    /** Cancellation only dismisses the thumb. As with the original wheel, the next
     * media update or reopening repaints the time, even when playback is paused. */
    const endScrub = (pointerId: number): void => {
        if (pointerId !== scrub?.pointerId) return;
        scrub = undefined;
        if (scrubberShell.hasPointerCapture(pointerId)) scrubberShell.releasePointerCapture(pointerId);
        scrubberThumb.classList.add('fading');
        scrubberThumb.addEventListener('transitionend', () => {
            if (scrubberThumb.classList.contains('fading')) {
                scrubberThumb.setAttribute('hidden', '');
                scrubberThumb.classList.remove('fading');
            }
        }, { once: true });
    };

    prevBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    nextBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    skipFwdBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    skipBackBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    modeLabel.addEventListener('pointerdown', (e) => e.stopPropagation());

    scrubberShell.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        const position = wheelPosition(scrubberShell, e);
        if (position.getZone() !== 'wheel') return;
        const gesture = deps.onScrubStart();
        if (!gesture) return;
        e.stopPropagation();
        scrubberShell.setPointerCapture(e.pointerId);
        scrub = { pointerId: e.pointerId, gesture, startAngle: position.angle, previewTime: gesture.startTime };
        scrubberThumb.classList.remove('fading');
        scrubberThumb.removeAttribute('hidden');
        syncThumbGeometry();
        setThumbAngle(position.angle);
    });

    scrubberShell.addEventListener('pointermove', (e) => {
        if (!scrub || e.pointerId !== scrub.pointerId) return;
        if (!scrub.gesture.isCurrent()) {
            endScrub(e.pointerId);
            return;
        }
        const duration = deps.getDuration();
        if (duration === undefined) return;
        const { angle: rawAngle } = wheelPosition(scrubberShell, e);
        // Keep the conversion order: at exactly half a turn, rounding decides
        // which way the drag wraps and can change the seek by 216 seconds.
        const lastDelta = (scrub.previewTime - scrub.gesture.startTime) / 216 * Math.PI * 2;
        const baseAngleDelta = rawAngle - scrub.startAngle;
        const angleDelta = baseAngleDelta + Math.round((lastDelta - baseAngleDelta) / (Math.PI * 2)) * Math.PI * 2;
        const desiredTime = scrub.gesture.startTime + (angleDelta / (Math.PI * 2)) * 216;
        scrub.previewTime = Math.max(0, Math.min(duration, desiredTime));
        scrubberTime.textContent = `${timeString(scrub.previewTime)} / ${timeString(duration)}`;
        setThumbAngle(scrub.startAngle + (scrub.previewTime - scrub.gesture.startTime) / 216 * Math.PI * 2);
    });

    scrubberShell.addEventListener('pointerup', (e) => {
        if (!scrub || e.pointerId !== scrub.pointerId) return;
        actionRevision++;
        scrub.gesture.commitScrubIfCurrent(scrub.previewTime);
        endScrub(e.pointerId);
    });
    scrubberShell.addEventListener('pointercancel', (e) => endScrub(e.pointerId));
    scrubberShell.addEventListener('lostpointercapture', (e) => endScrub(e.pointerId));

    scrubberShell.addEventListener('click', (e) => {
        const zone = wheelPosition(scrubberShell, e).getZone();
        if (zone !== 'inside') return;
        e.stopPropagation();
        const flash = deps.onCenterTapToggle();
        if (!flash) return;
        scrubberFlash.textContent = flash === 'play' ? '\u25B6\uFE0E' : '\u275A\u275A';
        scrubberFlash.classList.remove('animate');
        void scrubberFlash.offsetWidth;
        scrubberFlash.classList.add('animate');
    });

    return {
        indicatorSvg,
        titleEl,
        scrubberTextEl: scrubberText,
        scrubberTimeEl: scrubberTime,
        expansionEl: expansion,

        setModeLabelText(mode) {
            modeLabel.textContent = mode;
        },

        setPlayPausePlaying(isPlaying) {
            playpauseBtn.textContent = isPlaying ? '\u23F8\uFE0E' : '\u25B6\uFE0E';
        },

        setTargetVisible(visible) {
            if (visible === targetVisible) return false;
            targetVisible = visible;
            footerEl.classList.toggle('visible', visible);
            if (!visible) setExpanded(expanded, 'restore');
            return visible;
        },
        restoreDrawer() { setExpanded(expanded, 'restore'); },
        beginPlaybackAction: () => ++actionRevision,
        updateDrawerAfterPlay(revision, firstTarget) {
            if (revision === actionRevision && autoExpand) setExpanded(true, 'automatic');
            if (firstTarget && !isExpanded()) setExpanded(false, 'automatic');
        },
        collapseForBrowsing() {
            actionRevision++;
            setExpanded(false, 'automatic');
        },
        collapseAfterStop() { setExpanded(false, 'automatic'); },
        resizeDrawer,
        isExpanded,
        isScrubbing: () => scrub !== undefined,
    };
}
