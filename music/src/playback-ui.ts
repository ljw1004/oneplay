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
 * - Storage/network/media-session side effects beyond direct UI interactions.
 */
import { log, logCatch } from './logger.js';
import { type PlaybackMode } from './playback.js';

export interface PlaybackUiDeps {
    readonly audioEl: HTMLAudioElement;
    readonly footerEl: HTMLElement;
    readonly getMode: () => PlaybackMode;
    readonly getPhase: () => 'loading' | 'loaded';
    readonly getAsyncCounter: () => number;
    readonly onModeCycleClick: () => void;
    readonly onExpandedChange: (expanded: boolean) => void;
    readonly onChevronClick: () => void;
    readonly onFooterPlayPauseClick: () => void;
    readonly onCenterTapToggle: () => 'play' | 'pause' | undefined;
    readonly onPrev: () => void;
    readonly onNext: () => void;
    readonly onSeekBy: (delta: number) => void;
    readonly onCancelSeekDebounce: () => void;
    readonly onRearmTimerFromScrub: () => void;
}

export interface PlaybackUiController {
    readonly indicatorSvg: SVGSVGElement;
    readonly titleEl: HTMLDivElement;
    readonly scrubberTextEl: HTMLDivElement;
    readonly scrubberTimeEl: HTMLSpanElement;
    readonly expansionEl: HTMLDivElement;
    setModeLabelText(mode: PlaybackMode): void;
    setPlayPausePlaying(isPlaying: boolean): void;
    setExpanded(value: boolean): void;
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

/**
 * Classifies a pointer event's position relative to the scrubber shell center.
 * Returns ['inside' | 'wheel' | 'outside', rawAngle] where rawAngle is
 * the angle in radians from center (atan2). The wheel zone is determined
 * dynamically from the average radius of the four edge buttons.
 */
function radiusAndAngleForEvent(shell: HTMLElement, event: { clientX: number; clientY: number }): ['inside' | 'wheel' | 'outside', number] {
    const rect = shell.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const radius = Math.hypot(event.clientX - centerX, event.clientY - centerY);
    const angle = Math.atan2(event.clientY - centerY, event.clientX - centerX);
    const wheelButtons = Array.from(shell.querySelectorAll<HTMLButtonElement>('.scrubber-edge-button'));
    const [buttonRadius] = wheelButtons.reduce(([avg, count], b) => {
        const bRect = b.getBoundingClientRect();
        const r = Math.hypot(bRect.left + bRect.width / 2 - centerX, bRect.top + bRect.height / 2 - centerY);
        return [(avg * count + r) / (count + 1), count + 1];
    }, [0, 0]);
    const wheelThickness = Math.max(Math.min(rect.width - buttonRadius * 2, 60), 40);
    const radiusType = radius < buttonRadius - wheelThickness / 2 ? 'inside'
        : radius > buttonRadius + wheelThickness / 2 ? 'outside' : 'wheel';
    return [radiusType, angle];
}

export function createPlaybackUi(deps: PlaybackUiDeps): PlaybackUiController {
    const { footerEl, audioEl } = deps;

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
    const gripper = document.createElement('div');
    gripper.className = 'footer-gripper';

    // -- Expansion DOM -------------------------------------------------------

    const expansion = document.createElement('div');
    expansion.className = 'expansion';

    const expansionInner = document.createElement('div');
    expansionInner.className = 'expansion-inner';

    // Mode label button: top-left of expansion-inner, shows current mode
    const modeLabel = document.createElement('button');
    modeLabel.className = 'mode-label';
    modeLabel.type = 'button';
    modeLabel.textContent = deps.getMode();

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
    footerEl.append(gripper, expansion, footerBar);

    // -- Expand/collapse -----------------------------------------------------

    let expanded = false;
    const setExpanded = (value: boolean): void => {
        if (value && !footerEl.classList.contains('visible')) return;
        expanded = value;
        footerEl.classList.toggle('expanded', value);
        expansion.style.maxHeight = value ? `${expansion.scrollHeight}px` : '0';
        if (value) {
            modeLabel.textContent = deps.getMode();
            if (deps.getPhase() !== 'loading') {
                const duration = audioEl.duration;
                if (audioEl.readyState >= HTMLMediaElement.HAVE_METADATA && Number.isFinite(duration) && duration > 0) {
                    scrubberTime.textContent = `${timeString(audioEl.currentTime)} / ${timeString(duration)}`;
                }
            }
        }
        deps.onExpandedChange(value);
    };

    // -- Mode and drawer handlers -------------------------------------------

    modeLabel.addEventListener('click', (e) => {
        e.stopPropagation();
        deps.onModeCycleClick();
        modeLabel.textContent = deps.getMode();
    });

    let wasLandscape = window.matchMedia('(orientation: landscape)').matches;
    window.addEventListener('resize', () => {
        const isLandscape = window.matchMedia('(orientation: landscape)').matches;
        if (!wasLandscape && isLandscape && expanded) {
            setExpanded(false);
            log('playback: collapsed expanded controls on landscape entry');
        }
        wasLandscape = isLandscape;
        if (expanded) expansion.style.maxHeight = `${expansion.scrollHeight}px`;
    });

    expansionInner.addEventListener('click', (e) => {
        if (e.target === e.currentTarget) setExpanded(false);
    });

    gripper.addEventListener('click', () => {
        if (document.body.classList.contains('select-mode')) return;
        setExpanded(!expanded);
    });

    // -- Gripper hit zone ----------------------------------------------------

    const GRIPPER_EXTEND_PX = 22;
    const safeAreaBottom = (): number =>
        parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sab')) || 0;
    const gripperOverlay = document.createElement('div');
    gripperOverlay.style.cssText =
        'position:absolute;left:0;right:0;top:-' + GRIPPER_EXTEND_PX + 'px;'
        + 'height:' + GRIPPER_EXTEND_PX + 'px;pointer-events:auto';
    footerEl.appendChild(gripperOverlay);

    let swipeStartY: number | null = null;
    let swipePointerId: number | null = null;
    document.addEventListener('pointerdown', (e) => {
        if (expanded) return;
        if (document.body.classList.contains('select-mode')) return;
        if (!footerEl.classList.contains('visible')) return;
        const footerTop = footerEl.getBoundingClientRect().top;
        const safeAreaCutoff = window.innerHeight - safeAreaBottom();
        if (e.clientY < footerTop - GRIPPER_EXTEND_PX || e.clientY > safeAreaCutoff) return;
        swipeStartY = e.clientY;
        swipePointerId = e.pointerId;
    }, true);
    document.addEventListener('pointermove', (e) => {
        if (e.pointerId !== swipePointerId || swipeStartY === null) return;
        if (swipeStartY - e.clientY >= 30) {
            swipeStartY = null;
            swipePointerId = null;
            setExpanded(true);
        }
    });
    document.addEventListener('pointerup', (e) => {
        if (e.pointerId !== swipePointerId) return;
        swipeStartY = null;
        swipePointerId = null;
    });
    document.addEventListener('pointercancel', (e) => {
        if (e.pointerId !== swipePointerId) return;
        swipeStartY = null;
        swipePointerId = null;
    });

    let expansionSwipeStartY: number | null = null;
    let expansionSwipePointerId: number | null = null;
    document.addEventListener('pointerdown', (e) => {
        if (!expanded) return;
        const footerTop = footerEl.getBoundingClientRect().top;
        const safeAreaCutoff = window.innerHeight - safeAreaBottom();
        if (e.clientY < footerTop - GRIPPER_EXTEND_PX || e.clientY >= safeAreaCutoff) return;
        const shellRect = scrubberShell.getBoundingClientRect();
        const inShellArea = e.clientX >= shellRect.left && e.clientX <= shellRect.right
            && e.clientY >= shellRect.top && e.clientY <= shellRect.bottom;
        if (inShellArea) {
            const [zone] = radiusAndAngleForEvent(scrubberShell, e);
            if (zone === 'wheel') return;
        }
        expansionSwipeStartY = e.clientY;
        expansionSwipePointerId = e.pointerId;
    }, true);
    document.addEventListener('pointermove', (e) => {
        if (e.pointerId !== expansionSwipePointerId || expansionSwipeStartY === null) return;
        if (e.clientY - expansionSwipeStartY >= 30) {
            expansionSwipeStartY = null;
            expansionSwipePointerId = null;
            setExpanded(false);
        }
    });
    document.addEventListener('pointerup', (e) => {
        if (e.pointerId !== expansionSwipePointerId) return;
        expansionSwipeStartY = null;
        expansionSwipePointerId = null;
    });
    document.addEventListener('pointercancel', (e) => {
        if (e.pointerId !== expansionSwipePointerId) return;
        expansionSwipeStartY = null;
        expansionSwipePointerId = null;
    });

    // -- Footer controls -----------------------------------------------------

    indicatorSvg.addEventListener('click', (e) => {
        e.stopPropagation();
        setExpanded(false);
        deps.onChevronClick();
    });
    playpauseBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deps.onFooterPlayPauseClick();
    });
    skipFwdBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deps.onSeekBy(+30);
    });
    skipBackBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deps.onSeekBy(-15);
    });
    prevBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deps.onPrev();
    });
    nextBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deps.onNext();
    });

    // -- Scrubber interaction ------------------------------------------------

    let scrubPointerId: number | undefined;
    let scrubSessionId = 0;
    let scrubStartSrc = '';
    let scrubWasPlaying = false;
    let scrubRawStartAngle = 0;
    let scrubLastDelta = 0;
    let scrubStartTime = 0;
    let scrubLastTime = 0;

    const endScrub = (pointerId: number): void => {
        if (pointerId !== scrubPointerId) return;
        if (scrubberShell.hasPointerCapture(pointerId)) scrubberShell.releasePointerCapture(pointerId);
        scrubPointerId = undefined;
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
        const duration = audioEl.duration;
        if (!(Number.isFinite(duration) && duration > 0)) return;
        const [zone, rawAngle] = radiusAndAngleForEvent(scrubberShell, e);
        if (zone !== 'wheel') return;
        e.stopPropagation();
        deps.onCancelSeekDebounce();
        scrubberShell.setPointerCapture(e.pointerId);
        scrubPointerId = e.pointerId;
        scrubSessionId = deps.getAsyncCounter();
        scrubStartSrc = audioEl.src;
        scrubWasPlaying = !audioEl.paused;
        scrubRawStartAngle = rawAngle;
        scrubLastDelta = 0;
        scrubStartTime = audioEl.currentTime;
        scrubLastTime = scrubStartTime;
        scrubberThumb.classList.remove('fading');
        scrubberThumb.removeAttribute('hidden');
        syncThumbGeometry();
        setThumbAngle(rawAngle);
    });

    scrubberShell.addEventListener('pointermove', (e) => {
        if (e.pointerId !== scrubPointerId) return;
        if (scrubSessionId !== deps.getAsyncCounter() || scrubStartSrc !== audioEl.src) {
            endScrub(e.pointerId);
            return;
        }
        const duration = audioEl.duration;
        if (!(Number.isFinite(duration) && duration > 0)) return;
        const [, rawAngle] = radiusAndAngleForEvent(scrubberShell, e);
        const baseAngleDelta = rawAngle - scrubRawStartAngle;
        const angleDelta = baseAngleDelta + Math.round((scrubLastDelta - baseAngleDelta) / (Math.PI * 2)) * Math.PI * 2;
        const desiredTime = scrubStartTime + (angleDelta / (Math.PI * 2)) * 216;
        scrubLastTime = Math.max(0, Math.min(duration, desiredTime));
        scrubLastDelta = (scrubLastTime - scrubStartTime) / 216 * Math.PI * 2;
        scrubberTime.textContent = `${timeString(scrubLastTime)} / ${timeString(duration)}`;
        setThumbAngle(scrubLastDelta + scrubRawStartAngle);
    });

    scrubberShell.addEventListener('pointerup', (e) => {
        if (e.pointerId !== scrubPointerId) return;
        if (scrubSessionId === deps.getAsyncCounter() && scrubStartSrc === audioEl.src) {
            const duration = audioEl.duration;
            if (Number.isFinite(duration) && duration > 0) {
                const isNearEnd = Math.abs(duration - scrubLastTime) < 0.1;
                if (isNearEnd) {
                    audioEl.currentTime = duration - 0.02;
                    audioEl.pause();
                } else {
                    audioEl.currentTime = scrubLastTime;
                    if (scrubWasPlaying && audioEl.paused) {
                        audioEl.play().catch(logCatch('play-on-scrub-release'));
                    }
                }
            }
            deps.onRearmTimerFromScrub();
        }
        endScrub(e.pointerId);
    });
    scrubberShell.addEventListener('pointercancel', (e) => endScrub(e.pointerId));
    scrubberShell.addEventListener('lostpointercapture', (e) => endScrub(e.pointerId));

    scrubberShell.addEventListener('click', (e) => {
        const [zone] = radiusAndAngleForEvent(scrubberShell, e);
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

        setExpanded,
        isExpanded: () => expanded,
        isScrubbing: () => scrubPointerId !== undefined,
    };
}
