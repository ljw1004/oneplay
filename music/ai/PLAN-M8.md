# Plan: Milestone 8 — Select Mode, Action Bar & Modals

## Context

M1–M7 are complete: dev infrastructure, OneDrive auth, indexing, hierarchical tree with FLIP animations, playback with footer/scrubber, and the favorites data layer (shortcuts ☆, playlists ♫). M7 added test seed data (`seedTestFavorites()`) that must be removed in M8. M8 adds the **UI layer** for managing favorites: select mode with checkboxes, an action bar with icons, modal dialogs for all CRUD operations, and a per-favorite dropdown for quick settings.

## Key design decisions

1. **New module `select.ts`** — Select mode state spans tree rendering, footer replacement, and favorites mutation. A dedicated module follows the existing factory pattern and avoids bloating tree.ts or playback.ts.

2. **Breadcrumbs remain navigational in select mode** — Only `#children` rows get checkboxes. Breadcrumb clicks still navigate (confirmed with user).

3. **`hasPrivatePlayback` field + UI now, behavior in M9** — The boolean field is added to `Shortcut`/`Playlist` types. The checkbox appears in create/toggle modals. No playback behavior yet.

4. **Action bar is a three-zone horizontal bar** — `#action-bar` is a new body-level sibling of `#footer`. Left zone: share circle button (popup menu for shortcut/playlist actions). Center: selection summary text ("N Tracks" / "N Folders" / "N Selected"). Right zone: "..." circle button (popup menu for delete/rename/memory; hidden when no actions apply). CSS `body.select-mode` hides `#footer` and shows `#action-bar`. Circle button styling from iOS Photos: ~48px white circles with subtle shadow. Playback.ts needs no new API methods — the CSS class handles mutual exclusion, and the swipe-up handler checks `body.select-mode`.

5. **Tests suppress saving** — Expose `favorites._testOnlySuppressSave(suppress)` which replaces `dbPut`/`authFetch` with no-ops when suppressed. Named to make the test-only intent explicit. Tests suppress saving, delete existing favorites, create their own, mutate freely, then reload to restore real data. The existing DI architecture (`FavoritesDeps`) makes this a simple swap.

## State machine

```
NORMAL ↔ EXPANDED ↔ SELECT

Entry to SELECT: long-press or right-click on a child row
  → calls playback.collapse() to reset expanded state
  → adds body.select-mode CSS class
  → swipe-up suppressed while body.select-mode is present

Exit from SELECT: Cancel button, or action completed
  → removes body.select-mode, restoring footer visibility

Modal Cancel → returns to SELECT (not NORMAL)
Select Cancel → returns to NORMAL
```

Coordination: `body.select-mode` CSS class for visibility + explicit `playback.collapse()` call on SELECT entry to reset playback's internal `expanded` state. Pure inversion of control via callbacks in `index.ts`.

**Selection lifecycle:** Selection is cleared whenever the user navigates via breadcrumbs (even in select mode). Selections are contextual to the current folder view — hidden off-screen items must not be actionable.

## Files modified

| File | Action | Summary |
|------|--------|---------|
| `select.ts` | **Create** | Select mode state, long-press/right-click detection, action bar DOM, all modals, fav icon dropdown, icon availability computation |
| `favorites.ts` | **Modify** | Add `hasPrivatePlayback` to types; add `rename()`, `addMembers()`, `removeMembers()`, `setHasPrivatePlayback()`, `_testOnlySuppressSave()` methods |
| `tree.ts` | **Modify** | Add `setSelectMode()`, `onSelectToggle`, `onFavIconClick` to TreeView; checkbox rendering in `makeRow()` for child rows |
| `playback.ts` | **Modify** | Expose `collapse()` on Playback interface; swipe-up handler checks `body.select-mode` |
| `index.ts` | **Modify** | Remove `seedTestFavorites()` + seed logic; wire select module; state machine callbacks |
| `index.html` | **Modify** | Add `#action-bar` + `#select-cancel` elements; all new CSS |
| `test/integration/tree.test.cjs` | **Modify** | Update favorites tests (no more seed data); add `select:` tests |
| `test/unit/favorites.test.ts` | **Modify** | Add tests for rename, addMembers, removeMembers, setHasPrivatePlayback |

## 1. Data layer: `favorites.ts` changes

### New fields on types

```typescript
interface Shortcut {
    // ... existing fields ...
    readonly hasPrivatePlayback: boolean;  // NEW: data-only in M8, wired in M9
}

interface Playlist {
    // ... existing fields ...
    readonly hasPrivatePlayback: boolean;  // NEW
}
```

Default to `false` for existing data (backward-compatible: `fav.hasPrivatePlayback ?? false`).

### New methods on Favorites interface

```typescript
/** Rename a favorite. Persists and calls onChange. */
rename(id: string, newName: string): Promise<void>;

/** Add members to an existing playlist. Skips duplicates (by driveId+itemId
 *  for ItemRefs, by favId for FavRefs). Cycle-checks FavRefs. */
addMembers(playlistId: string, members: PlaylistMember[]): Promise<void>;

/** Remove members at given indices from a playlist. */
removeMembers(playlistId: string, indices: number[]): Promise<void>;

/** Toggle hasPrivatePlayback on a favorite. */
setHasPrivatePlayback(id: string, value: boolean): Promise<void>;

/** Suppress persistence (for testing only). When suppressed, dbPut and authFetch
 *  become no-ops. Mutations still happen in memory and call onChange.
 *  INVARIANT: must only be called from test harnesses via page.evaluate. */
_testOnlySuppressSave(suppress: boolean): void;
```

### Duplicate detection in `addMembers`

- ItemRef duplicates: same `driveId` + `itemId` already in playlist
- FavRef duplicates: same `favId` already in playlist
- Silently ignored per DESIGN.md

### Edge-case contracts (per Codex review)

- `removeMembers(indices)`: sorts indices descending internally to avoid index-shift bugs. Caller may pass unsorted.
- `rename(id, newName)`: trims whitespace; rejects empty/whitespace-only names (returns without mutation).
- `addMembers()`: cycle-checks each FavRef member before adding. Cross-playlist FavRef inserts are allowed when cycle-safe.

## 2. Tree changes: `tree.ts`

### New TreeView interface members

```typescript
/** Update select mode rendering state. */
setSelectMode(active: boolean, selectedPaths: ReadonlySet<string>): void;

/** Called when user clicks a row in select mode. Wired by index.ts. */
onSelectToggle: (path: FolderPath) => void;

/** Called when user clicks a ☆/♫ icon on a favorite root. Wired by index.ts. */
onFavIconClick: (path: FolderPath, anchorEl: HTMLElement) => void;
```

### Checkbox rendering in `makeRow()`

When `selectModeActive` and the row is NOT a breadcrumb (only child rows get checkboxes):

```typescript
if (selectModeActive && !opts.isBreadcrumb && !isAppRoot) {
    const check = document.createElement('span');
    const pathKey = JSON.stringify(opts.path);
    check.className = 'select-check' + (selectedPaths.has(pathKey) ? ' checked' : '');
    check.textContent = selectedPaths.has(pathKey) ? '\u2713' : '';
    el.prepend(check);
    el.classList.add('has-checkbox');
}
```

### Click handler in select mode

When `selectModeActive` and `!opts.isBreadcrumb`, the click handler calls `view.onSelectToggle(opts.path)` instead of folder navigation or track click. Breadcrumb clicks still navigate normally.

### Fav icon click handler

When `isFavoriteRoot`, the `.fav-icon` span gets a click handler (with `e.stopPropagation()`) that calls `view.onFavIconClick(opts.path, favIcon)`.

## 3. Playback changes: `playback.ts`

Two changes:

1. **Expose `collapse()` on the `Playback` interface** — calls internal `setExpanded(false)`. Called by `index.ts` on SELECT entry to reset the expanded state (CSS hiding alone leaves `expanded = true` internally, causing bugs on SELECT exit).

2. **Swipe-up guard** — one line in the swipe-up pointerdown handler:
```typescript
if (document.body.classList.contains('select-mode')) return;
```

## 4. Select module: `select.ts` (new file)

### Factory structure

```typescript
export function createSelect(
    treeContainer: HTMLElement,
    actionBarEl: HTMLElement,
    cancelBtn: HTMLElement,
    favorites: Favorites,
    tree: TreeView,
    roots: RootsMap,
): Select

export interface Select {
    isActive(): boolean;
    getSelectedPaths(): ReadonlySet<string>;
    toggle(path: FolderPath): void;
    enterSelectModeWithRow(path: FolderPath): void;
    exitSelectMode(): void;
    showFavDropdown(path: FolderPath, anchorEl: HTMLElement): void;
    setRoots(roots: RootsMap): void;  // update after re-index or favorites change

    onEnterSelect: () => void;
    onExitSelect: () => void;
}
```

Dependencies passed at construction (not via post-construction setters) per Codex feedback. Only `setRoots()` exposed as an update method since roots change on re-index and favorites mutation.

### Long-press detection

Document-level `pointerdown` on capture phase, targeting `#children .tree-row[data-path]`:

```
pointerdown on child row (e.isPrimary && e.button === 0 only)
  → start 500ms timer, record pointerId + position
pointermove → if moved > 10px, cancel timer (scrolling)
pointerup → cancel timer (tap)
pointercancel → cancel timer (iOS system gesture)
timer fires → enterSelectModeWithRow(path), set contextmenu-suppress flag
```

Right-click: `contextmenu` listener on `#children`, `e.preventDefault()` only when target is a selectable row (has `data-path`), find nearest `.tree-row[data-path]`, enter select mode.

Both ignore the MyMusic root row (`path.length <= 1`).

CSS: add `-webkit-touch-callout: none` on `.tree-row` to prevent iOS long-press callout.

### Action bar DOM (built in createSelect)

Three-zone horizontal layout, inspired by iOS Photos:

```
#action-bar  (flex row, space-between)
  .action-btn.share-btn     ○ share glyph (box with upward arrow)
  .action-bar-text           "3 Tracks" / "2 Folders" / "5 Selected" / "Select Items"
  .action-btn.more-btn       ○ ⋯  (hidden when no applicable actions)
```

Circle buttons: ~48px, white background, subtle shadow, centered glyph in `#3c3c43`.

Cancel button: `#select-cancel`, `position: fixed`, top-right.

### Selection summary text

Computed from the selected paths + roots/index data:
- All selected items are tracks (leaf nodes) → "N Tracks"
- All selected items are folders → "N Folders"
- Mixed → "N Selected"
- Nothing selected → "Select Items"

### Share popup (dropdown from share button)

A lightweight dropdown (appended to `document.body`, positioned via `getBoundingClientRect`). Items:

1. **"Add as Shortcut ☆"** — shown only if exactly 1 item selected AND it's a OneDrive folder (checked via the index, not via DOM class) AND not already a shortcut target. Tapping opens the shortcut modal.
2. **"Add to existing playlist ♫"** — shown only if 1+ playlists already exist. Tapping opens the playlist picker modal.
3. **"Put in new playlist ♫"** — always shown. Tapping opens the create-playlist modal.

The share button is always visible (at minimum "Put in new playlist" is available).

### More popup (dropdown from ⋯ button)

Same dropdown pattern. Items:

1. **"Delete"** — shown when ALL selected items share the same context: all top-level favorites, or all members of the SAME playlist. Tapping opens the delete modal.
2. **"Rename"** — shown when exactly 1 playlist is selected. Tapping opens the rename modal.
3. **"Remember my spot"** — shown when 1+ selected items are top-level favorites. Tapping toggles `hasPrivatePlayback` on each. Text says "Remember my spot ✓" when all selected have it on, "Remember my spot" when off, omitted if mixed (simplification for M8).

The ⋯ button is hidden entirely when none of these conditions are met.

### Shortcut eligibility

A row can be added as a shortcut if it's a OneDrive folder in the index. This applies regardless of tree position: under an account root, inside a shortcut expansion, inside a playlist expansion. The check uses the index data (`isFolder` from the index tree), not DOM attributes — business logic derives from the data model, not display.

### Modals

All modals use a shared helper: `showModal(title, body, actions) → {element, close()}`. Backdrop click or Cancel button calls `close()` which removes from DOM. Uses `position: fixed`, `z-index: 200`.

**a) Shortcut modal** (from share popup → "Add as Shortcut") — Title "Add new shortcut", checkbox "Remember my spot", Create/Cancel. On Create: call `favorites.add({kind:'shortcut', ...target, hasPrivatePlayback})`, exit select mode.

**b) Playlist picker modal** (from share popup → "Add to Playlist") — Title "Add to playlist", buttons for each existing playlist, plus "Create..." button, Cancel. Click existing → `favorites.addMembers(playlistId, selectedItems)`, exit select mode. Click "Create..." → opens create-playlist sub-dialog.

**c) Create playlist modal** (from share popup → "New Playlist", or from playlist picker → "Create...") — Name field, checkbox "Remember my spot", Create/Cancel. On Create: `favorites.add({kind:'playlist', name, members: selectedItems, hasPrivatePlayback})`, exit select mode.

**d) Delete modal** (from more popup → "Delete") — Text is context-aware ("Delete favorite" or "Remove from playlist"). Red Delete button, Cancel. On Delete: for favorites → `favorites.remove(id)`; for playlist items → `favorites.removeMembers(playlistId, indices)`. Exit select mode.

**e) Rename modal** (from more popup → "Rename") — Same layout as create-playlist (name field, Create→Rename button, Cancel). Title "Rename playlist". On Rename: `favorites.rename(id, newName)`, exit select mode.

**f) Fav icon dropdown** — Same pattern as settings dropdown. Options: "Remember my spot" (toggle), "Delete", "Rename" (playlists only). Triggered from tree row fav icon click, not from action bar.

### Converting selected paths to favorites operations

Selected paths need to be mapped to operation parameters:
- A path like `["MyMusic", "fav:uuid"]` where the favorite is a **shortcut** → resolves to the underlying ItemRef target (the OneDrive folder the shortcut points to). Shortcuts are transparent wrappers; playlists should contain the actual OneDrive folder, never a reference to a shortcut.
- A path like `["MyMusic", "fav:uuid"]` where the favorite is a **playlist** → FavRef with `favId = path[1].slice(4)`
- A path like `["MyMusic", "fav:uuid", "m:2"]` → playlist member at index 2
- A path like `["MyMusic", driveId, "folder"]` → OneDrive folder → create ItemRef

## 5. Wiring: `index.ts` changes

1. **Remove** `seedTestFavorites()` function and the seed check in `initFavorites()`.

2. **Create select module** in `showTree()` (after tree, playback, and favorites are all created):
```typescript
select = createSelect(treeContainer, actionBarEl, cancelBtn, favorites, tree, tree.getRoots());

select.onEnterSelect = () => {
    playback.collapse();  // reset expanded state (not just CSS hiding)
    document.body.classList.add('select-mode');
};
select.onExitSelect = () => {
    document.body.classList.remove('select-mode');
};

tree.onSelectToggle = (path) => {
    select.toggle(path);
    tree.setSelectMode(select.isActive(), select.getSelectedPaths());
};
tree.onFavIconClick = (path, anchor) => select.showFavDropdown(path, anchor);
```

3. **Update favorites onChange** to also sync roots to select module.
4. **Update all root mutation paths** (tree.setAccount, tree.setFavorites) to call `select.setRoots(tree.getRoots())` — not just on favorites change.

## 6. CSS additions in `index.html`

### Select mode body class
```css
body.select-mode #footer { display: none !important; }
body.select-mode #action-bar { display: flex; }
body.select-mode #select-cancel { display: block; }
```

### Action bar
```css
#action-bar {
    display: none;
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    background: #e8e8ed;
    border-top: 1px solid #c8c8cc;
    padding: 8px 16px;
    padding-bottom: calc(8px + env(safe-area-inset-bottom) / 2);
    position: relative;
    z-index: 1;
    flex-shrink: 0;
}
.action-bar-text {
    font-size: 17px;
    font-weight: 600;
    color: #1c1c1e;
    text-align: center;
    flex: 1;
}
```

### Circle buttons (iOS Photos style)
```css
.action-btn {
    width: 48px; height: 48px;
    border-radius: 50%;
    background: #fff;
    box-shadow: 0 1px 3px rgba(0,0,0,0.12);
    border: none;
    display: flex;
    align-items: center; justify-content: center;
    font-size: 20px;
    color: #3c3c43;
    cursor: pointer;
    flex-shrink: 0;
    -webkit-tap-highlight-color: transparent;
}
.action-btn:active {
    background: #e5e5ea;
}
/* Reserve space for more button even when hidden, to keep text centered */
.more-btn.hidden {
    visibility: hidden;
}
```

### Dropdown popups (share menu, more menu)
```css
.action-dropdown {
    position: fixed;
    background: #fff;
    border-radius: 14px;
    box-shadow: 0 8px 32px rgba(0,0,0,0.2);
    min-width: 220px;
    z-index: 210;
    overflow: hidden;
}
.action-dropdown button {
    display: block;
    width: 100%;
    padding: 14px 20px;
    border: none;
    background: none;
    text-align: left;
    font-size: 17px;
    color: #1c1c1e;
    cursor: pointer;
}
.action-dropdown button:active {
    background: #e5e5ea;
}
.action-dropdown button + button {
    border-top: 1px solid #e5e5ea;
}
```

### Checkboxes
```css
.select-check {
    width: 22px; height: 22px;
    border: 2px solid #c8c8cc;
    border-radius: 50%;
    display: inline-flex;
    align-items: center; justify-content: center;
    flex-shrink: 0;
    margin-right: 8px;
    font-size: 14px; color: white;
    transition: background-color 150ms;
}
.select-check.checked {
    background: #007aff;
    border-color: #007aff;
}
/* Reduce base padding when checkbox present so rows don't shift.
 * Uses a class (not :has()) to avoid CSS perf concerns. */
.tree-row.has-checkbox {
    padding-left: calc(4px + 20px * var(--indent, 0));
}
/* Suppress iOS long-press callout on tree rows */
.tree-row {
    -webkit-touch-callout: none;
}
```

### Modals
```css
.modal-backdrop {
    position: fixed; inset: 0;
    background: rgba(0,0,0,0.4);
    display: flex;
    align-items: center; justify-content: center;
    z-index: 200;
}
.modal {
    background: #fff; border-radius: 14px;
    width: min(340px, calc(100% - 40px));
    padding: 24px;
    box-shadow: 0 8px 32px rgba(0,0,0,0.25);
}
```

### Cancel button
```css
#select-cancel {
    display: none;
    position: fixed;
    top: calc(env(safe-area-inset-top) + 8px);
    right: calc(env(safe-area-inset-right) + 12px);
    z-index: 100;
    /* ... styling ... */
}
```

## 7. Testing strategy

### Test save suppression

`favorites._testOnlySuppressSave(true)` replaces `dbPut` and `authFetch` with no-ops. Tests call this via `page.evaluate`, then freely create/delete/rename favorites. Page reload restores real data from IndexedDB.

### Integration tests (`select:` prefix)

| Test | What it verifies |
|------|-----------------|
| `select: long-press enters select mode` | Checkboxes appear on child rows, action bar visible, cancel button visible |
| `select: right-click enters select mode` | Same via contextmenu |
| `select: cancel exits select mode` | Checkboxes gone, action bar hidden, returns to NORMAL |
| `select: modal cancel returns to select mode` | Open modal → Cancel → still in select mode with selection preserved |
| `select: checkbox toggles on row click` | Click row → .select-check.checked appears/disappears |
| `select: no checkbox on breadcrumbs` | Breadcrumb rows have no .select-check |
| `select: breadcrumbs navigate in select mode` | Clicking breadcrumb navigates, clears selection |
| `select: action bar text shows track/folder count` | Shows "N Tracks" for tracks, "N Folders" for folders, "N Selected" for mixed |
| `select: share button always visible` | Share circle button present in action bar |
| `select: share popup shows contextual items` | Shortcut option only for single OneDrive folder; playlist options shown correctly |
| `select: more button hidden when no actions apply` | Only OneDrive folders selected → ⋯ button has `visibility: hidden` |
| `select: more popup shows delete/rename/memory` | Correct items shown based on selection context |
| `select: entering select collapses expanded` | Start with expanded footer, long-press → expanded collapses |
| `select: cannot expand in select mode` | In select mode, swipe-up does not expand footer |
| `select: shortcut modal opens and creates` | Share → "Add as Shortcut" → modal → Create → favorite appears |
| `select: playlist picker shows existing` | Share → "Add to Playlist" → modal lists existing playlists |
| `select: new playlist modal creates` | Share → "New Playlist" → modal → Create → playlist appears |
| `select: delete favorite works` | ⋯ → Delete → confirm → favorite removed |
| `select: fav icon dropdown opens` | Click ☆/♫ icon → dropdown with options |
| `select: long-press canceled by scroll` | Pointerdown + move > 10px → no select mode |

### Updated favorites tests

Remove dependency on seed data. Tests that need favorites create them via save-disabled mutations and verify UI.

### Unit tests (favorites.test.ts)

- `rename: changes playlist name`
- `addMembers: adds to playlist, skips duplicates`
- `removeMembers: removes by index`
- `setHasPrivatePlayback: toggles the field`

## 8. Implementation sequence

0. **Save plan to disk** as `PLAN-M8.md` in the repository root (required per working process before implementation begins).
1. **favorites.ts**: Add `hasPrivatePlayback` field, new methods, `_testOnlySuppressSave()`
2. **Unit tests**: Test new favorites methods
3. **tree.ts**: Add `setSelectMode()`, checkbox rendering, `onSelectToggle`, `onFavIconClick`
4. **playback.ts**: Add `body.select-mode` guard to swipe-up
5. **select.ts**: Create module — long-press, action bar, modals, fav dropdown
6. **index.html**: Add DOM elements + all CSS
7. **index.ts**: Remove seed data, wire select module
8. **Integration tests**: All `select:` tests
9. **Build, test locally, deploy, verify production**

## Key invariants

1. **NORMAL / EXPANDED / SELECT are mutually exclusive.** Enforced by `body.select-mode` CSS class, explicit `playback.collapse()` on SELECT entry, and swipe-up guard.
2. **Modal Cancel → SELECT, Select Cancel → NORMAL.** Canceling a modal returns to select mode with selection preserved. Canceling select mode returns to normal.
3. **Breadcrumbs always navigate.** Only `#children` rows get checkboxes in select mode. Navigation clears the selection.
4. **Mixed-context delete disabled.** Delete is only enabled when all selected items are from the same context (all top-level favorites, or all members of the same playlist). The ⋯ button is hidden entirely when no actions apply.
5. **Share button always visible; ⋯ button conditionally visible.** Share always has at least "Put in new playlist". The ⋯ button uses `visibility: hidden` (not `display: none`) when inapplicable, to keep the center text centered via flex layout.
6. **Shortcut eligibility checks the index, not the DOM.** Whether a selected item is a folder is determined from the index data, not from CSS classes or DOM attributes.
7. **Duplicate items silently ignored.** `addMembers` checks driveId+itemId / favId before appending.
8. **Cycle safety preserved.** `addMembers` cycle-checks each FavRef before adding.
9. **Selected paths use JSON.stringify for set membership.** Mirrors `data-path` attribute convention.
10. **Save suppression for tests.** `_testOnlySuppressSave(true)` makes mutations in-memory only. Page reload restores persisted state.
11. **pointercancel handled.** Long-press timer and all pointer-tracking state cleaned up on cancel.
12. **Long-press guards:** Only primary pointer (`isPrimary && button === 0`). `-webkit-touch-callout: none` on rows.
13. **Shortcuts are transparent in playlists.** When adding a shortcut to a playlist, the underlying OneDrive folder (ItemRef) is added, not a FavRef to the shortcut. Playlists should never contain shortcut references — only OneDrive folders/tracks and other playlists.
14. **All zoom disabled.** Viewport meta `maximum-scale=1 user-scalable=no` + CSS `touch-action: pan-x pan-y` on html. The app is a fixed-layout tool, not a document — zoom serves no purpose and causes layout bugs.

## Codex review

Codex raised 4 blockers and 6 should-fixes. All addressed:

**Blockers resolved:**
1. **Expanded state not cleared on SELECT entry** → Added explicit `playback.collapse()` call via new `Playback.collapse()` API method.
2. **Selection lifecycle on breadcrumb navigation** → Selection clears on any breadcrumb navigation.
3. **Mixed-context delete ambiguity** → Disabled 🗑 for mixed contexts in M8.
4. **`setSaveEnabled` as production API** → Renamed to `_testOnlySuppressSave()` with invariant documentation.

**Should-fixes resolved:**
1. **Constructor-based DI for select.ts** → Pass all deps at construction; only `setRoots()` as update method.
2. **Long-press event guards** → Added `isPrimary && button === 0` checks, `-webkit-touch-callout: none`.
3. **`:has()` avoidable** → Use `.has-checkbox` class instead.
4. **Edge-case contracts** → `removeMembers` sorts descending; `rename` trims/rejects empty; `addMembers` cycle-checks.
5. **Roots sync incomplete** → Wire `select.setRoots()` from all root mutation paths.
6. **Missing tests** → Added: expanded→select collapse, modal cancel→select, breadcrumb clears selection, long-press scroll cancel, cannot expand in select mode.
