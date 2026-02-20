# Plan: Milestone 5 — Playback

## Context

M1–M4 are complete: dev infrastructure, OneDrive auth, indexing, and hierarchical tree view with FLIP animations. The app can browse a 30k-track OneDrive music library but can't play anything. M5 adds the core playback experience: click a track to stream it from OneDrive, a footer bar with play/pause and current-track info, and a "playback folder" concept for sequential playback of folder descendants.

**User decisions:**
- Collapsed footer only (expanded scrubber/wheel deferred to M6)
- Hidden `<audio>` element in HTML, custom UI controls it
- Inline SVG glyph (chevron >/spinner ⟳) prepended to current track row, faithfully adapted from `example/` visual design

## Files Overview

| File | Action | Purpose |
|------|--------|---------|
| `playback.ts` | **Create** | Audio element, footer DOM, track enumeration, download URLs, auto-advance |
| `tree.ts` | **Modify** | Add `setPlaybackInfo`, SVG indicator in rows, playback-folder highlighting, ▷/▶ toggle |
| `index.ts` | **Modify** | Wire tree↔playback callbacks, maintain accounts reference |
| `index.html` | **Modify** | Add `<audio>` element, footer CSS, SVG indicator CSS, playback-folder CSS |
| `test-tree.js` | **Modify** | Add `playback:` tests |

## Architecture

A new `playback.ts` module owns the audio element, footer bar, download URL fetching, track enumeration, and auto-advance. It communicates via a single callback: `onPlaybackChange(info)`. `index.ts` wires tree clicks → playback actions, and playback events → tree indicator updates.

```
Tree click → [index.ts] → playback.playTrack/playFolder
                               ↓
                    playback.onPlaybackChange(info)
                               ↓
              [index.ts] → tree.setPlaybackInfo(info)
                               ↓
                    [tree.ts] re-renders with indicators
```

## 1. New: `playback.ts`

### State & Types

```typescript
export interface PlaybackInfo {
    readonly folder: FolderPath;   // playback folder (recursive descendants form the playlist)
    readonly track: FolderPath;    // currently playing/loading track
    readonly phase: 'loading' | 'loaded';
}
```

Internal state: playbackFolder, playbackTrack, phase, trackList (sorted recursive descendants), asyncCounter (prevents stale track loads).

### Public API

```typescript
export interface Playback {
    getInfo(): PlaybackInfo | undefined;
    playTrack(path: FolderPath, accounts: Map<string, { folder: MusicFolder }>): void;
    playFolder(path: FolderPath, accounts: Map<string, { folder: MusicFolder }>): void;
    onChevronClick: () => void;
    onPlaybackChange: (info: PlaybackInfo | undefined) => void;
}
export function createPlayback(audioEl: HTMLAudioElement, footerEl: HTMLElement): Playback;
```

### Key Functions

- `collectTracks` — depth-first walk matching tree.ts sort order (folders first, alpha within group)
- `fetchDownloadUrl` — GET `/me/drive/items/{id}?$select=@microsoft.graph.downloadUrl` via authFetch
- `resolveTrack` / `resolveFolderFromPath` — walk accounts Map to get file ID / MusicFolder
- `setTrack` — async counter pattern, set phase, fetch URL, set audio src, play

### Audio Events

- `loadeddata` → phase='loaded', update footer + onPlaybackChange
- `ended` → auto-advance to next track in trackList
- `error` → log, attempt advance

### Footer Bar

Grid layout: SVG indicator | title (2 lines, -webkit-line-clamp: 2) | play/pause (44×44px)
Hidden when no playback folder. Indicator click → onChevronClick. Play/pause → toggle audio.

### Track Click Logic

If track within current playbackFolder → keep folder, play track.
Else → set folder to track's parent, rebuild trackList, play track.

## 2. Changes: `tree.ts`

- `setPlaybackInfo(info)` — stores info, re-renders
- `makeRow` adds `.playback-folder` / `.playback-child` classes
- Current track gets prepended SVG indicator (chevron/spinner, `.loading`/`.loaded` CSS)
- Play button: `▶` if folder IS playback folder, `▷` otherwise
- Path helpers: `pathEquals`, `pathStartsWith`

## 3. Changes: `index.ts`

- Module-level `accountData` Map, updated on showTree
- Wire tree.onTrackClick → playback.playTrack
- Wire tree.onPlayClick → playback.playFolder
- Wire playback.onPlaybackChange → tree.setPlaybackInfo
- Wire playback.onChevronClick → tree.setSelectedPath(track parent)

## 4. Changes: `index.html`

- Add `<audio id="player" hidden>` and `<div id="footer">`
- CSS: footer bar (#e5f1fc bg, grid layout, safe-area padding)
- CSS: SVG indicator (stroke #354b87, spin animation for loading)
- CSS: .playback-folder (#e5f1fc bg), .playback-child (#c4d8ef border)

## Validation

### Automated (Playwright)
- Footer hidden initially, visible after track click
- Footer structure: indicator, title, play/pause
- Audio element exists hidden
- Play button glyph toggle

### Manual Checklist
1. Click track → footer appears, audio plays
2. Loading spinner → chevron on loaded
3. Title shows 2 lines, long names truncated
4. Play/pause toggles audio
5. ▷ on folder → sequential playback; ▷ becomes ▶
6. Auto-advance on track end
7. Track outside folder → folder changes
8. Footer chevron → tree navigates to track
9. Playback folder highlighted in tree
10. Mobile viewport correct
11. Deploy + test on iPhone

## Validation Results

### Automated (Playwright) — 18/18 passing
All tests pass on both localhost:5500 and production (https://unto.me/mymusic/):
- `tree:`, `indent:`, `nav:`, `log:`, `settings:`, `scroll:` — all prior tests green
- `playback: footer hidden initially` — ✓
- `playback: audio element exists hidden` — ✓
- `playback: play button shows ghost triangle` — ✓
- `playback: clicking track shows footer` — ✓
- `playback: footer structure` — ✓
- `playback: play button changes to filled after play` — ✓

### Visual verification (Playwright screenshots, mobile 375×812)
- Footer bar anchored to bottom, light blue (#e5f1fc) background
- Track title wraps to 2 lines for long names, ellipsis on overflow
- Play/pause button 44×44px touch target, navy blue (#354b87)
- Chevron > indicator on current track row in tree
- Playback folder has light blue background highlight
- ▶ (filled) on selected folder when it IS the playback folder

### Codex code review — all issues addressed
1. **Race condition (High)** — Fixed: `playNext()` resets audio (pause + removeAttribute src + load) before async fetch, preventing stale ended/error events
2. **Empty folder (High)** — Fixed: explicit stop + state clear + onPlaybackChange emit
3. **Failure paths (Medium)** — Fixed: auto-advance past missing/failed tracks
4. **Play/pause desync (Medium)** — Fixed: button text driven by audio `play`/`pause` events, not optimistic
5. **Stale accountData (Medium)** — Fixed: `accountData.clear()` on driveId change
6. **O(n) findIndex (Low)** — Fixed: maintain `currentTrackIdx` alongside `playbackTrack`
7. **URL encoding (Low)** — Fixed: `encodeURIComponent(fileId)` in Graph URL
