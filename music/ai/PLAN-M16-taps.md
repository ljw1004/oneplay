# PLAN-M16-taps

## Title
Milestone 16: Remove favorite icon tap-to-popup; consolidate into select mode action bar

## Summary

Change the interaction model for managing favorites. Previously, tapping the ☆/♫ icon on a favorite row opened a dropdown popup with actions (Remember my spot, Rename, Make available offline, Delete). Now, the only way to access these actions is: long-press the favorite to enter select mode, then tap the right-hand action bar button.

This simplifies the interaction model: ☆/♫ icons become purely informational badges, and the action bar is the single entry point for all favorite management.

## Design changes (DESIGN.md)

The following changes have been made to DESIGN.md:

1. **Icons section (lines 62-63)**: ♫ and ☆ are now described as "non-tappable badges" rather than interactive icons with popups. They no longer have hit areas or click behavior. The text directs users to long-press + action bar instead.

2. **Shortcut creation modal info text (line 176)**: Changed from "Once created, tap ☆ to alter settings or make available offline" to "Once created, long-press and use the action bar to alter settings or make available offline".

3. **Action bar right button (line 180)**: Added "This is the sole entry point for managing individual favorites" to make the consolidation explicit.

4. **Available Offline section (lines 226-229)**: Removed references to "nested icons don't activate popups" (moot since no icons activate popups now). Changed "via the favorite's popup" to "via the favorite popup in select mode (long-press the favorite, then tap the action bar's right button)". Changed "click the favorite icon to learn more" to "long-press the favorite and use the action bar to learn more". Changed "menu item in a popup" to "in the action bar popup".

## Milestone changes (MILESTONES.md)

- **M8 line 165**: Changed "The icon on a shortcut/playlist opens a dropdown" to "The only way to manage a shortcut/playlist is via select mode: long-press to select it, then use the action bar's right button".

## Code changes required

### tree.ts

1. **Remove `onFavIconClick` from the view callbacks interface** (~line 88). This callback is no longer needed since favorite icons are non-interactive.

2. **Remove the hit-area wrapper around favorite icons** (~lines 693-700). Currently a `hitArea` span wraps the icon with a click listener that calls `view.onFavIconClick`. Replace with a plain `favIcon` span (no click handler, no hit area sizing). The icon remains for visual identification but has no interaction.

3. **Remove the default stub** for `onFavIconClick` (~line 417).

### select.ts

1. **Remove the `onFavIconClick` handler wiring** (~line 1219-1222). This is where `index.ts` wires `onFavIconClick` to call `showDropdown` with `buildFavItems`. Since the icon is no longer tappable, this wiring is deleted.

2. **The `showDropdown` function itself stays** — it's still used by the action bar's share button (line 649) and the action bar's right button (line 1163). Those are the correct remaining entry points.

3. **`buildFavItems` stays** — it's called from the action bar right button handler (line 1162) which is now the sole entry point.

### index.html / CSS

1. **Remove any 44px hit-area styling** for the fav-icon tap target. The icon can revert to its natural inline size since it's just a badge now.

### Integration tests (tree.test.cjs)

1. **Remove or update any tests** that click on ☆/♫ icons to open dropdowns. These tests should instead long-press the favorite row, then click the action bar right button.

## What does NOT change

- The ☆/♫ icons still render in the tree (they're visual badges showing favorite type).
- The action bar right button behavior is unchanged — it already shows the favorite popup when a single favorite is selected.
- `showDropdown` and `buildFavItems` are unchanged.
- The dropdown contents (Remember my spot, Rename, Make available offline, Delete) are unchanged.
- Long-press to enter select mode is unchanged.
- The share button (left action bar button) is unchanged.
- Nested favorite icons (inside playlists) are unchanged — they were already non-interactive.
- Search result favorite icons are unchanged — they were already non-interactive badges.

## Validation

- Long-press a favorite → enters select mode → tap right action bar button → dropdown appears with correct items.
- Verify ☆/♫ icons are visible but not tappable (no hover cursor, no click response).
- All existing dropdown actions work: Remember my spot toggle, Rename (playlist), Make available offline, Delete.
- Select multiple favorites → right button shows delete (not favorite popup), consistent with existing behavior.
- Mobile: verify no 44px hit area on the icons; tapping the icon area does nothing special.
