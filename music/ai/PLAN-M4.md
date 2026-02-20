# Plan: Milestone 4 — Hierarchical Tree View

## Implementation Approach

**This milestone must be implemented by a team/swarm**, per the working process in MILESTONES.md. Even if the work isn't highly parallelizable, use a team with coordinated task assignment.

## Context

M1-M3 established build/deploy/test infrastructure, OneDrive auth, and music indexing. The app currently renders a flat summary view (account name, top-level folders with track counts) after sign-in and index load. M4 replaces this with the core navigation experience: a hierarchical tree with breadcrumb navigation, scroll-direction locking, and the visual foundation for all future milestones.

**User decisions captured during planning:**
- Switch from dark theme to light theme (off-white #fffef9, dark text #3a3330)
- Log panel hidden by default, toggled via 📋 icon on the app root row
- Scroll-direction locking via JS touch events (snap to H or V per gesture, never both)
- ⚙ icon on account row opens a simple dropdown menu (just "Sign out" for now)
- No track counts shown next to folder names — keep rows clean

## Tree Hierarchy

The tree root is the app itself: **"MyMusic"**. Below it are account nodes, and below those are the music folders/files from the index.

```
- MyMusic 📋 🔍(future)
  - accountDisplayName ⚙
    - folder1
    - folder2
    - ...
```

- **MyMusic** (root): always present. Has app-level icons:
  - 📋 toggles the log panel (replaces the separate log toggle button)
  - 🔍 for search (M12, not implemented now)
- **accountDisplayName** (account node): one per connected OneDrive account. Has ⚙ icon opening a dropdown with "Sign out".
- Below the account node: the music folder tree from `MusicData.folder`.

## Files Overview

| File | Action | Purpose |
|---|---|---|
| `tree.ts` | **Create** | Tree view component: state, rendering, navigation, scroll-locking |
| `index.ts` | **Modify** | Replace flat summary with tree view; wire tree to data lifecycle |
| `index.html` | **Modify** | CSS overhaul (light theme, tree styles); add tree DOM structure |
| `logger.ts` | **Modify** | Log panel hidden by default (toggled by tree's 📋 icon, not a separate button) |
| `manifest.json` | **Modify** | Update theme_color/background_color to match light theme |

## 1. New File: `tree.ts`

### State

```typescript
/** Path from root to a folder. ["MyMusic"] is the app root, ["MyMusic", "John"] is an account. */
type FolderPath = readonly string[];
```

Internal state (closed over in factory function):
- `accounts: Map<string, { folder: MusicFolder; info: AccountInfo; reindexing: boolean }>` — one entry per connected account
- `selectedPath: FolderPath` — currently expanded folder. Defaults to `["MyMusic"]`.
- DOM refs: `breadcrumbsEl`, `childrenEl`

### Public API

```typescript
/** Creates the tree view. Factory function (not a class). */
export function createTree(container: HTMLElement): TreeView;

interface TreeView {
    setAccount(name: string, folder: MusicFolder, info: AccountInfo, reindexing?: boolean): void;
    getSelectedPath(): FolderPath;
    setSelectedPath(path: FolderPath): void;
    onTrackClick: (path: FolderPath) => void;   // wired by index.ts; M5 will use
    onPlayClick: (path: FolderPath) => void;     // wired by index.ts; M5 will use
    onSignOut: (accountName: string) => void;    // wired by index.ts
}
```

### Rendering

On every `selectedPath` change, re-render two sections:

**Breadcrumbs** — one row per ancestor, from "MyMusic" root down to selected folder (inclusive). Each clickable to navigate up. Grey background. Never scrolls horizontally (CSS `overflow: hidden`).

**Children** — immediate children of selected folder, sorted folders-first then alphabetically. Folders bold, tracks regular. Scrolls vertically and horizontally (with JS direction locking).

Special cases for the virtual nodes:
- If `selectedPath` is `["MyMusic"]`: children are the account names (one per connected account)
- If `selectedPath` is `["MyMusic", accountName]`: children are top-level music folders from that account's index
- Deeper paths: children come from `MusicFolder.children`

### `makeRow` (single function for all rows)

Creates a `<div class="tree-row ...">` with:
- CSS classes: `.folder`/`.file`, `.selected`, `.breadcrumb`, `.indent-N` (N capped at 4)
- Text content via `textContent` (no innerHTML, no escaping needed)
- If selected folder (not root, not account): play button `▷` (sticky right, `event.stopPropagation()`)
- If "MyMusic" root row: 📋 icon (toggles log panel)
- If account row in breadcrumbs: ⚙ icon (opens sign-out dropdown)
- Click handler: folders navigate, files call `onTrackClick`

### `resolveFolder`

Walks the tree: `["MyMusic"]` → virtual root, `["MyMusic", account]` → account's top folder, deeper → walks `MusicFolder.children`. If path is broken (folder renamed/deleted during re-index), resets `selectedPath` to the deepest valid prefix and re-renders.

### Scroll-Direction Locking

Attached to `childrenEl`. JavaScript touch event handling:
- `touchstart`: record initial position, clear lock
- `touchmove`: on first move beyond 5px threshold, compute `|dx| > |dy|` → lock to H (hide overflowY) or V (hide overflowX)
- `touchend`: reset both overflow to `auto`

All listeners `{ passive: true }`.

### ⚙ Settings Dropdown

When ⚙ is clicked on account row:
- Create a small absolute-positioned dropdown below the icon
- Contains "Sign out" option
- Click outside or on an option dismisses it
- Sign out calls `onSignOut(accountName)`

### 📋 Log Toggle

When 📋 is clicked on the MyMusic root row:
- Toggle `.visible` class on `#log-panel`
- `event.stopPropagation()` to prevent row click

## 2. Modified: `index.html`

### DOM Structure

```html
<body>
    <div id="status">Loading...</div>
    <div id="tree-container" hidden>
        <div id="breadcrumbs"></div>
        <div id="children"></div>
    </div>
    <div id="log-panel"></div>
</body>
```

No separate log toggle button — it's the 📋 icon on the MyMusic root row.

### CSS Changes

**Theme switch** (dark → light):
- `html, body`: background `#fffef9`, color `#3a3330`
- `.signin-btn`: keep blue, adjust `.signout-btn` border/text for light bg
- `.error-msg`: `#c00` (was `#f66`)
- `.progress-bar` bg: `#ddd` (was `#333`)

**Tree layout**:
```css
#tree-container { display: flex; flex-direction: column; flex: 1; min-height: 0; width: 100%; }
#breadcrumbs { background: #f2efe5; flex-shrink: 0; overflow: hidden; }
#children { flex: 1; overflow-x: auto; overflow-y: auto; -webkit-overflow-scrolling: touch; overscroll-behavior: none; }
```

**Row styling**:
```css
:root { --row-height: 48px; }
.tree-row { height: var(--row-height); display: flex; align-items: center; white-space: nowrap; cursor: pointer; border-left: 3px solid transparent; padding-left: calc(20px * var(--indent, 0)); }
.indent-0 { --indent: 0; } ... .indent-4 { --indent: 4; }
.tree-row.folder { font-weight: 600; }
.tree-row.selected { background: #fef3c7; border-left-color: #d97706; }
#breadcrumbs .tree-row { background: #f2efe5; }
```

**Play button** (sticky right): `position: sticky; right: 0; margin-left: auto; background: inherit;`

**Settings dropdown**: absolute-positioned, white background, shadow, z-index above tree.

**Log panel**: `display: none` by default, `.visible` class shows it. `pointer-events: none` preserved.

**Remove**: `.data-view`, `.dir-list`, `.dir-item`, `.account-header`, `.index-summary`, `.reindex-indicator`, `#log-toggle` CSS classes (M3 summary view and standalone log toggle no longer used). Keep `.index-progress` / `.progress-bar` / `.status-line` for first-time indexing.

## 3. Modified: `logger.ts`

- Remove `installLogToggle()` — log toggling is now handled by tree.ts via the 📋 icon
- Remove `:empty` / `:not(:empty)` CSS-based visibility logic from index.html
- Log panel still receives all entries in DOM (for Playwright), just not visible by default

## 4. Modified: `index.ts`

**Replace `renderSummary` with `showTree`:**
```typescript
let tree: TreeView | undefined;

function showTree(info: AccountInfo, data: MusicData): void {
    document.getElementById('status')!.hidden = true;
    document.getElementById('tree-container')!.hidden = false;
    if (!tree) {
        tree = createTree(document.getElementById('tree-container')!);
        tree.onTrackClick = (path) => log(`track click: ${path.join('/')}`);
        tree.onPlayClick = (path) => log(`play click: ${path.join('/')}`);
        tree.onSignOut = (accountName) => signOut(async () => {
            localStorage.removeItem('account_info');
            await dbClear();
        });
    }
    tree.setAccount(info.displayName, data.folder, info);
}
```

**Sign-out**: Via `onSignOut` callback from tree's ⚙ dropdown.

**Keep**: `renderIndexing` for first-time progress.

**Remove**: `renderSummary`, `renderReindexing`, `escapeHtml`.

## 5. Modified: `manifest.json`

Update `background_color` and `theme_color` to `"#fffef9"`.

## Key Patterns from Example Code

Carried forward:
- **Breadcrumb+children split**: Only one slice of tree visible at a time (O(1) for 30k-track library)
- **`makeRow` single function**: Creates rows for both breadcrumbs and children with flag-driven styling
- **Indent capping at 4**: Prevents excessive indentation in deep hierarchies
- **Sticky play button**: `position: sticky; right: 0` stays visible during horizontal scroll
- **Row height 48px**: CSS variable `--row-height` for touch-friendly targets
- **`overscroll-behavior: none`**: Prevents rubber-banding on scroll containers
- **Callback pattern**: `onTrackClick`/`onPlayClick`/`onSignOut` as public properties, set by wiring code in `index.ts`

Not carried forward (deferred or simplified):
- FLIP animation (adds complexity without core M4 value; can revisit later)
- Checkboxes (M8 select mode)
- Playback indicators (M5)
- Multiple roots/favorites (M7)
- Custom wheel event handling (only needed when coordinating multiple scroll containers; we have one)

## Implementation Sequence

1. **`index.html`**: CSS overhaul (light theme + tree styles) + new DOM elements
2. **`logger.ts`**: Simplify — remove toggle function, log panel hidden by default via CSS
3. **`tree.ts`**: Create — full tree component with rendering, navigation, scroll-locking, ⚙ dropdown, 📋 toggle
4. **`index.ts`**: Replace summary rendering with tree view; wire callbacks
5. **`manifest.json`**: Update colors
6. **Build + local test**: `npm run build` (zero errors), Playwright on localhost
7. **Deploy + production test**: `npm run deploy`, Playwright on unto.me/mymusic/

## Validation

### Build
`npm run build` — zero TypeScript errors.

### Playwright Automated Tests (via sandbox-escape)

1. Page loads without JS errors
2. After sign-in: `#tree-container` visible, `#status` hidden
3. Breadcrumbs div has at least one row ("MyMusic" root)
4. Children div has rows (account name)
5. Click account → breadcrumbs show MyMusic > account, children show top-level music folders
6. Click a folder → breadcrumbs grow, children refresh
7. Click "MyMusic" breadcrumb → back to top level showing accounts
8. Long track names: verify `white-space: nowrap` and container scrollable
9. 📋 icon: click it, verify log panel visibility toggles
10. Mobile viewport (375x812): repeat navigation test
11. Screenshots at multiple navigation depths

### Human Testing Checklist

1. Open localhost:5500 — light theme, sign in
2. Tree renders with "MyMusic" root, account as child
3. Click account → see top-level music folders
4. Click folder → siblings disappear, children appear, breadcrumbs show path
5. Click breadcrumb → navigate up
6. Scroll vertically through a long folder listing
7. Find a long track name, swipe horizontally → scroll locks to H axis only
8. Play button `▷` visible on selected folder (below account level)
9. ⚙ icon on account → dropdown with Sign out
10. 📋 icon on MyMusic root → log panel toggles
11. Deploy to production, test on iPhone

### Scale
30k tracks: only breadcrumbs (3-5 items) + current folder's children (typically < 200) are in DOM. `resolveFolder` walk is O(depth). No performance concern.

## Preparing for Future Milestones

- M5 (Playback): `onTrackClick`/`onPlayClick` callbacks ready. Tree can add `setPlaybackState(folder, track, phase)` method to show chevron/spinner indicators and playback folder highlighting.
- M7 (Favorites): The tree already has a virtual root ("MyMusic") with children below it. Favorites/playlists will become additional children of the root alongside accounts.
- M8 (Select mode): Row structure supports adding checkbox pseudo-elements.
- M9 (State persistence): `getSelectedPath()`/`setSelectedPath()` methods ready.
- M12 (Search): 🔍 icon will be added to the MyMusic root row alongside 📋.

## Validation Results

### Build
`npm run build` — zero TypeScript errors.

### Playwright Tests (18/18 passing)
```
  ✓ tree: loads with root and account
  ✓ indent: breadcrumbs indent by depth
  ✓ indent: children indent deeper than parent
  ✓ nav: breadcrumb click navigates up
  ✓ log: toggles on clipboard icon click
  ✓ settings: gear works on selected breadcrumb
  ✓ settings: gear works on non-selected breadcrumb
  ✓ settings: gear works on child row
  ✓ settings: dropdown positioned near gear icon
  ✓ settings: sign-out button visible and properly sized
  ✓ settings: dropdown renders on non-selected breadcrumb
  ✓ scroll: no inline overflow styles on children
  ✓ playback: footer hidden initially
  ✓ playback: audio element exists hidden
  ✓ playback: play button shows ghost triangle
  ✓ playback: clicking track shows footer
  ✓ playback: footer structure
  ✓ playback: play button changes to filled after play

18 passed, 0 failed
```

### Production Deployment
Deployed to https://unto.me/mymusic/ via `npm run deploy`. Screenshots verified on both localhost:5500 and production — identical rendering: light theme, MyMusic breadcrumb with clipboard icon, favorites placeholder, OneDrive account row with gear icon.

### Code Review
- Internal review: high quality, clean adherence to plan with documented deviations.
- Codex review: initial review raised 4 blockers. Two were fixed (test-run.sh exit code propagation, setSelectedPath invariant enforcement). Two were justified as deliberate documented decisions (scroll-direction locking deferral, driveId keying). Codex re-review: **signoff approved, no blockers remain**.

### Fixes Applied During Validation
1. `test-run.sh`: Added `-f` flag to curl so test failures propagate as non-zero exit codes.
2. `tree.ts` `setSelectedPath()`: Added guard enforcing the invariant that selectedPath must start with "MyMusic".

### Deviations from Plan (Documented in LEARNINGS.md)
- Scroll-direction locking: deliberately deferred — overflow toggling resets scroll position on Safari, and per-frame restoration causes jerkiness on iOS.
- Account key is driveId (stable) rather than displayName (volatile). Display text decoupled via makeRow.
- FLIP animation added as post-plan quality improvement.
- `.breadcrumb` CSS class replaced by `#breadcrumbs .tree-row` DOM ancestry selector.
