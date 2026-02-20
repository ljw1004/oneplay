# Plan: Milestone 6 — Expanded Controls & Scrubber Wheel

## Context

M1–M5 are complete: dev infrastructure, OneDrive auth, indexing, hierarchical tree view with FLIP animations, and playback with a collapsed footer bar. M6 adds an expanded controls panel that slides up from the footer when the user swipes up, containing an iPod-style scrubber wheel for precise seeking, edge buttons for ±30s/±15s skip and prev/next track, a close button, and a time display. The playlist area above remains fully interactive.

**User decisions:**
- Swipe up on footer to expand; swipe down, close ×, or tap non-interactive area to collapse
- Expansion sized to fit content (not fixed 50vh), animated slide ~300ms
- No shuffle/repeat modes in M6 (deferred)
- Local seek tracking: rapid ±15s/±30s taps accumulate without waiting for audio element

## Files Overview

| File | Action | Purpose |
|------|--------|---------|
| `playback.ts` | **Modify** | Expansion DOM, scrubber logic, swipe detection, local seek, prev/next |
| `index.html` | **Modify** | New CSS for expansion, scrubber wheel, restructure footer from grid to flex+bar |
| `test-tree.js` | **Modify** | Add `expanded:` tests |
| `index.ts` | **No changes** | Existing wiring sufficient |
| `tree.ts` | **No changes** | NORMAL/EXPANDED/SELECT state machine deferred to M8 |

## Architecture

The expanded controls are owned by `playback.ts` (within `createPlayback`), since they are intimately coupled to audio state. No new module — KISS.

### DOM structure after M6

```
#footer (flex column, border-top, background)
  ├── .expansion (max-height: 0 → animated to fit content)
  │    └── .expansion-inner (relative, centers scrubber)
  │         ├── button.expansion-close (× grey circle, absolute top-right)
  │         └── .scrubber-shell (touch-action: none, aspect-ratio 1/1)
  │              ├── .scrubber-wheel (radial-gradient ring)
  │              ├── .scrubber-text (currentTime / duration, centered)
  │              ├── button.scrubber-edge-button.left (⏮ prev)
  │              ├── button.scrubber-edge-button.right (⏭ next)
  │              ├── button.scrubber-edge-button.top (+30s)
  │              ├── button.scrubber-edge-button.bottom (-15s)
  │              └── .scrubber-thumb[hidden] (rotated via --thumb-angle)
  └── .footer-bar (grid: auto 1fr auto — the existing collapsed controls)
       ├── SVG.footer-indicator
       ├── div.footer-title
       └── button.footer-playpause
```

### CSS restructuring

Current `#footer` has `display: grid` with columns. This changes to `display: flex; flex-direction: column`. The grid layout moves to a new `.footer-bar` child div. The expansion uses `max-height: 0` with `overflow: hidden; transition: max-height 300ms`. When expanding, measure `expansion.scrollHeight` and animate to that explicit pixel value (animating to `auto` doesn't work); recompute on orientation change. Edge buttons must be ≥44×44 CSS px for touch targets.

## Key Implementation Details

### 1. Expand/collapse

- `expanded` boolean in `createPlayback` is the single source of truth
- `setExpanded(value)` toggles `footerEl.classList.toggle('expanded', value)`
- Collapse triggers: close button click, tap on `.expansion-inner` background (`e.target === e.currentTarget`), swipe down, chevron click (auto-collapse before navigating tree)

### 2. Swipe detection

Pointer tracking on `.footer-bar` (swipe up to expand) and `.expansion-inner` (swipe down to collapse). Track `swipeStartY` on `pointerdown`, check delta on `pointermove`, consume when threshold (30px) reached. Swipes on `.scrubber-shell` are consumed by scrubber (touch-action: none), so they don't trigger collapse.

### 3. Scrubber interaction (adapted from example/controls.ts)

- **radiusAndAngleForEvent**: classifies pointer position as 'inside' / 'wheel' / 'outside' using dynamically-measured button radii. Module-level pure function.
- **Pointer capture**: `pointerdown` on wheel zone → `setPointerCapture`, record start angle/time, show thumb. Cancel any pending local seek debounce on scrub start.
- **Angle tracking**: `pointermove` → compute delta from start, handle wraparound via `Math.round((lastDelta - baseDelta) / 2π) * 2π`, 216 seconds per full rotation
- **Duration guard**: all scrub/seek math gated behind `Number.isFinite(duration) && duration > 0`; scrub UI disabled until audio has valid metadata
- **Clamp**: thumb stops at [0, duration]
- **Apply on release**: `pointerup` → set `audioEl.currentTime`, hide thumb. Safari near-end guard: `duration - 0.02` and pause
- **Race guard**: use `asyncCounter` (already exists in playback.ts) as a session ID — record it on scrub start, check on move/up. Also check `scrubStartSrc === audioEl.src` as a belt-and-suspenders guard.
- **pointercancel**: handle exactly like pointerup cleanup (clear capture/state/timers). iOS Safari fires this frequently on system gestures.

### 4. Edge buttons

- Top (+30s): calls `seekBy(+30)`
- Bottom (-15s): calls `seekBy(-15)`
- Left (prev): calls internal `playPrev()` — plays `trackList[currentTrackIdx - 1]` if available
- Right (next): calls internal `playNextTrack()` — plays `trackList[currentTrackIdx + 1]` if available

### 5. Local seek tracking

`seekBy(delta)` accumulates rapid taps: reads from `localSeekTarget ?? audioEl.currentTime`, adds delta, clamps to [0, duration], updates time display immediately, debounces 200ms before applying to `audioEl.currentTime`. During accumulation, `timeupdate` does not overwrite the display. Cancel pending debounce on: scrub start, track change (`playNext`), and audio `ended` event.

### 6. Center tap = play/pause

Click handler on `.scrubber-shell`: if `radiusAndAngleForEvent` returns 'inside', toggle audio play/pause.

### 7. Time display

`timeupdate` event updates `.scrubber-text` when expanded, not scrubbing, and no local seek pending. Format: `m:ss` or `h:mm:ss` for audiobooks exceeding 60 minutes.

## Key Invariants

- **Expansion state**: `expanded` boolean is the single source of truth. All collapse paths go through `setExpanded(false)`.
- **Scrub lifecycle**: `scrubPointerId` defined only during active scrub. `timeupdate` defers to scrub/local-seek display. Track-change mid-scrub detected via `asyncCounter` mismatch (session ID) and `scrubStartSrc` check. `pointercancel` handled identically to `pointerup` cleanup.
- **Local seek**: `localSeekTarget` is meaningful only while debounce timer is active. Multiple taps read from `localSeekTarget` (not stale `audioEl.currentTime`). Debounce cancelled on scrub start, track change, and audio ended.
- **Duration validity**: scrub/seek math gated behind `Number.isFinite(duration) && duration > 0`.
- **Gesture arbitration**: once a pointer is captured for scrubbing on `.scrubber-shell` (touch-action: none), it cannot trigger panel swipe. Panel swipe only fires from `.footer-bar` and non-scrubber areas of `.expansion-inner`.
- **Playlist area remains usable**: tree-container has `flex: 1; min-height: 0`, so it shrinks to accommodate the expanded footer. No dimming overlay.

## Implementation Sequence

1. CSS: add expansion/scrubber styles, restructure `#footer` from grid to flex+bar
2. DOM: wrap existing footer children in `.footer-bar`, create expansion DOM
3. Expand/collapse: `setExpanded`, close button, tap-outside, swipe gesture
4. Scrubber: `radiusAndAngleForEvent`, `timeString`, pointer handlers, thumb
5. Edge buttons: +30s, -15s, prev, next
6. Local seek: `seekBy` with debounce
7. Time display: `timeupdate` listener
8. Center tap: play/pause on inside zone
9. Tests: `expanded:` suite for DOM structure, class toggling, close button
10. Build, test locally, deploy, verify production

## Validation

### Codex Review Summary

Codex approved the plan ("solid for M6, I'd ship this"). Three high-risk items incorporated:
1. **seekBy debounce vs scrub race** → cancel pending debounce on scrub start, track change, and ended event
2. **Session ID for scrub guard** → use existing `asyncCounter` as monotonic session ID alongside `scrubStartSrc` check
3. **Duration invalid states** → gate all scrub/seek math behind `Number.isFinite(duration) && duration > 0`

Medium-risk items incorporated: `pointercancel` handled like `pointerup`, explicit `scrollHeight` pixel values for max-height animation, gesture arbitration (scrub vs panel-swipe locked per pointer), edge buttons ≥44×44px.

### Automated (Playwright)
- `expanded: not expanded initially` — footer visible but no `.expanded` class
- `expanded: expansion DOM structure` — all elements present (shell, wheel, text, thumb, 4 edge buttons, close)
- `expanded: expansion visible when expanded class set` — expansion height > 100px when `.expanded`
- `expanded: close button collapses` — clicking close removes `.expanded`
- All prior tests (tree, indent, nav, log, settings, scroll, playback) still pass

### Manual (on iPhone)
1. Swipe up on footer → expansion slides up smoothly
2. Swipe down → collapses
3. Close × → collapses
4. Tap non-interactive area → collapses
5. Scrub through 1-hour audiobook chapter with ~2s precision
6. ±15s and ±30s taps work, rapid taps accumulate
7. Prev/next track work
8. Center tap toggles play/pause
9. Time display updates during playback
10. Playlist area above remains scrollable and clickable
11. Deploy + test on production
