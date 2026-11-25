# OnePlay Music interaction review

Current behavior for owner review, November 25, 2026. The hosted PWA and bundled iOS build 17 share most of the screen. Platform differences are called out below. The boxes are open review decisions, including existing behavior. They do not imply approval. Microsoft’s account chooser and Apple’s file picker use system-provided controls and wording.

## Interruption and recovery

| What the listener encounters | What the app actually does |
| --- | --- |
| iOS toast **“Audio output interrupted. Tap Play to retry.”** | Swift reports this when it expects its audio engine or player node to run and finds it stopped. Swift pushes the terminal state to the visible page. The page also samples the player clock about once per second and on foreground entry. A transition to error shows a toast, including when the page returns to the foreground and first observes the failure. This message by itself cannot identify the cause. |
| Tap Play after that error | **Restarts the failed occurrence at 0:00.** Ordinary pause and resume preserve position. If preparing the next recording failed, Swift lets the preceding one finish and offers the failed recording for retry. |
| Other iOS player failures | The error toast uses “{reason}. Tap Play to retry.” Reasons include “OneDrive denied access to this recording”, a lookup failure category, invalid or changed recording metadata, range or decoder errors, and a numeric failure code. A rejected control command shows “The player could not apply that command. Try again.” A failed background snapshot is silent. |
| Network delay during native playback | While loading or stalled, the row/footer and wheel can show a spinner. Transient Graph or media requests retry in place. Stop, a new selection or an applicable seek can supersede them. During a native seek, the chosen time stays visible for the first 250 ms. A prepared Next starts at 0:00 with the same grace period. A longer wait shows a spinner, and Swift clears it as soon as it queues playable audio. Paused seeks keep their time visible. |
| PWA media error | The browser player logs the error, keeps the selected track, and leaves recovery to the listener. Folder Play with no playable offline candidates can show the blocking alert “No offline tracks are available here.” |
| Lock, unlock, headset, call or car | The native audio session can keep playing under lock and the page can reattach to it. Explicit native interruption/route recovery, Now Playing metadata and remote command handling are pending. The PWA registers supported browser Media Session commands for Play, Pause, Previous, Next and seeking. The OS chooses which controls appear. |

- [ ] Should an interruption keep the playhead and offer **Resume**? Which interruptions, if any, should resume automatically?
- [ ] Should the message remain by the player until acted on? Today a toast replaces any previous toast and starts fading after about 2.6 seconds. The reported phrase “playback was interrupted. Press play to continue” is not an exact literal in either app.
- [ ] Which technical failures merit a listener-facing message, and should a short network stall show anything beyond the spinner?

[Native controls and error copy](../src/native-playback.ts) · [Swift terminal states and retry](../ios/App/NativePlayback.swift) · [Browser errors and system controls](../src/playback.ts)

## Launch, accounts and navigation

| Action or event | Visible result |
| --- | --- |
| Open or reload | “Loading...” while startup decides what to show. A cached library renders locally. First-time indexing shows “Indexing your music...”, “Starting index...” and progress. Cached libraries can remain usable while refresh continues. Native sign-in can show “Opening your OneDrive library...”. The PWA restores saved navigation and player appearance paused. The native page reconnects to a live player after a view reload. Cold native session restore is pending. |
| Sign in with OneDrive | The PWA redirects through Microsoft. Native presents Microsoft’s sign-in UI when interaction is needed. Cancelling native sign-in dismisses it. A failed attempt can show “OneDrive sign-in failed. Please try again.” |
| Reconnect or sign out in Settings | Reconnect tries the paired account. A mismatch can show “Reconnect with the OneDrive account used for this library.” Sign out acts immediately, without a confirmation. Native stops playback, retires the library view, clears account data and keeps the device theme. The view can be blank while WebKit clears its store. Browser sign-out follows the browser account flow. |
| Launch fails | “Could not finish startup. Please reload.” has a **Reload** button. Other startup states include “Cannot access Music folder: {status}”, “Indexing failed. Please try again.”, “This cached library belongs to a different OneDrive account.” and the native pre-page message “OnePlay could not open the account store. Close the app and try again.” |
| Tap a folder, breadcrumb, shortcut or playlist | Opens that location and shows children. Tapping the current breadcrumb leaves it in place. Scroll the child list independently. Favorites appear at the root. The empty hint reads “press and hold on a folder to add it to favorites”. The first favorite tap can show “Tip: Press and hold a favorite to customize it.” |
| Tap a shared folder | A share with no index opens Settings. A previously indexed denied share can still be browsed, with unavailable tracks greyed and inert. The menu glyph changes to a warning for signed-out evidence, a denied share or the latest refresh error. |
| Open Search and type | The magnifier closes Select, collapses the player, and opens “Search your library...”. The small × clears the input, the large × or Escape exits. A capped list says “[Only showing first 500 results]”. A query with no hits has no explanatory text. Reopening in the same document can restore the previous query and scroll; there is no timed expiry. |
| Tap a result | A folder opens in the tree. A track opens its parent and requests playback. The playing-row chevron, described below, explicitly scrolls the row into view. Native search hits resolving through a favorite can encounter the unsupported-folder message. |

- [ ] Review sign-out without confirmation, the reload/reconnect actions, the empty-search state, and how a denied share leads to Settings.

[Startup](../src/index-startup.ts) · [Account and search wiring](../src/index.ts) · [Tree and status indicators](../src/tree.ts)

## Player, queue and wheel

| Action or event | Visible or audible result |
| --- | --- |
| Tap a track or the folder Play button | The PWA builds the logical queue, including nested folders and playlists, and uses local audio when available. Native queues the immediate indexed files in the physical folder, starting with the selected or first file. The native decoder supports MP3. Other indexed formats can therefore produce a decoder error. Unsupported paths can show “Choose a track in a OneDrive album folder.” Other native guards show “Connect to OneDrive to play this track.” or “No tracks in this folder.” |
| Track starts, loads, pauses or advances | Footer title, Play/Pause, and matching row indicator follow selection. A spinner indicates loading and a chevron identifies a loaded track. The drawer shows elapsed/total time when available. The native player can advance while its view is absent. |
| Tap the footer chevron | Reveals the exact playing occurrence in its folder or playlist, closing Settings if necessary. Scrolls only far enough to expose the row and preserves expanded/collapsed size. |
| Open or close the player | Tap the gripper or swipe up to expand. Tap it again, swipe down outside the wheel, or tap empty drawer space to collapse. Entering landscape, Search or Select can collapse it. A top shadow appears on the expanded drawer. The footer Play/Pause remains usable separately. |
| Tap wheel center or edge buttons | Center toggles playback and flashes the action. Left/right select previous/next, top advances 30 seconds and bottom goes back 15. Native previous/next at an album boundary do nothing. In the offline or signed-out PWA, known-unavailable tracks are grey, omitted from search, and skipped by queue navigation. Exhausting playable successors can stop silently. Relative taps can accumulate during seek. A playing native +30 that reaches the end advances or finishes the queue. |
| Drag the wheel | The thumb follows the finger and previews the time, with 216 seconds per revolution. Release commits one clamped seek for the touched occurrence. Cancel/lost capture drops the gesture. In the iOS app, releasing within the final 0.1 seconds while playing follows the natural track ending. All starts the next track immediately, or finishes the queue at the exact duration of the last track. A paused scrub stays paused at the chosen position, including the exact end. In the PWA, the near-end gesture pauses 20 ms before the end. [Playing end scrub](../../experiments/ios-playback/Evidence/phase5/build20-end-scrub.png) · [Paused end scrub](../../experiments/ios-playback/Evidence/phase5/build19-end-scrub.png) |
| Turn on Settings → Debug and expand the native player | Above the wheel, **Prev · Current · Next** show filenames and compressed-file coverage. Black is absent, dark green is cached, a glowing red interval is an active media range GET, and the red dot at the start is a Graph item lookup. The current track has a white playback marker. On cellular, Next can pulse red for its URL lookup as the current song begins, then stay black until audio preparation near the join. A scrub can show one long red range as the missing blocks turn green. On unmetered Wi-Fi, Next can start turning green as soon as the 6 MB forward window reaches it. Holes earlier in Current can stay black. A cached signed URL lets a seek or Next fetch missing ranges without a Graph dot. The indicators are passive. Reduced Motion makes the red indicators steady. Debug off hides the strip immediately. It is available in the native Debug build. [Cellular lookup at 0:00](../../experiments/ios-playback/Evidence/phase5/build21-cellular-next.png) · [Range screenshot](../../experiments/ios-playback/Evidence/phase5/debug-range.png) |
| Tap mode label in the PWA | Cycles **one → timer → all → repeat → shuffle → one**. One stops after the track. All advances through the queue once. Repeat wraps. Shuffle plays a shuffled pass and reshuffles. Timer uses the configured interval or “End of track”. Manual Next and natural completion have separate rules. Native currently shows a disabled **all** label. |
| Private playback and returning to a favorite | PWA “Remember my spot” maintains favorite-specific playback context. Shared-library editing of this setting is available in native, while native private playback restoration and timers are pending. |

- [ ] Review the Debug cache colors, lookup dot and file labels while seeking or tapping Next.
- [ ] Review the controls at both drawer sizes, track reveal, near-end pause, spinner, mode and end-of-queue behavior, and the native folder limitation.

[Shared player gestures](../src/playback-ui.ts) · [Browser queue rules](../src/playback-engine.ts) · [Native folder admission](../src/index.ts)

## Select, favorites and offline audio

| Action or event | Visible result |
| --- | --- |
| Long-press or right-click an eligible row | Enters Select with that row checked and the player collapsed. Tap eligible children or breadcrumbs to change the selection. The action bar shows “Select Items”, a folder/track count, or “N Selected”. **Cancel** exits. Available actions depend on the selected items and their scope. |
| Tap the share/action button | Depending on selection, offers “Add as Shortcut ☆”, “Add to existing playlist ♫”, or “Put in new playlist ♫”. This menu organizes OnePlay favorites. |
| Create a shortcut or playlist | “Add new shortcut” shows the folder name and “Remember my spot”. “Create playlist” takes “Playlist name” and offers the same checkbox. Confirm with **Create** or cancel. Blank and duplicate playlist names disable submission. |
| Add to an existing playlist | “Add to playlist” lists eligible destinations. Tapping one adds the selection. Duplicate/cyclic additions can be skipped silently. |
| Tap ☆/♫ for a selected favorite | Toggle “Remember my spot”, open offline details where available, use playlist “Rename…” then **Save**, or “Delete…”. Shortcuts use their folder name. |
| Remove favorites or playlist members | Trash or “Delete…” opens “Delete favorite?”, “Delete N favorites?” or “Remove from playlist?”. It describes what will be removed. **Delete** confirms and **Cancel** backs out. The operation removes the favorite or membership and leaves the OneDrive recording in place. |
| Pin a favorite in the PWA | “Make available offline…” opens **Make Available Offline** or **Available Offline**. An unpinned favorite shows the track count; completed per-favorite bytes are estimated. **Make available offline** starts the pin, **Make unavailable offline** removes it. The × or backdrop closes details. Pin/unpin closes the sheet with no second confirmation. Native transient streaming memory has no pin controls or offline-availability badge. |
| Manage download progress in the PWA | Pause/resume, track and byte counts, progress, success check, and overall storage are visible in offline details. The storage selector offers 1, 2, 5 or 10 GB. Warnings include “Reached storage limit”, “Not signed in”, “Not online”, and the current download error. Row badges summarize available, pending or paused pins. |

- [ ] Review selection and dismissal, silent duplicate handling, destructive confirmations, “Remember my spot”, pin/unpin wording, progress and quota.

[Select menus and offline details](../src/select.ts) · [Favorite membership](../src/favorites.ts) · [Download states](../src/downloads.ts)

## Settings, dialogs and diagnostics

| Action or event | Visible result |
| --- | --- |
| Open or dismiss Settings | Tap the menu/warning glyph to open Settings. Its menu/× controls return to the library. The OneDrive section offers **Sign out** or **Reconnect...**. |
| Connect a share | **Add share URL...** opens instructions, URL entry, clear ×, **Add** and **Cancel**. Confirm shows progress and disables repeat submission. Failures appear inline. Examples include “Share URL is required”, “This share is already connected”, “Only folder shares are supported”, “Music special folder is not accessible” and service errors. |
| Edit or remove a share | The pencil opens “Rename share” with **Save**. Saving an unchanged or blank share name closes the dialog without changing the name. Disconnect opens “Disconnect from share”; when applicable it reports affected tracks and playlists. **Disconnect** confirms. Denied shares show “Access unavailable” with a reason such as expired sign-in (401), denied permission (403) missing share (404), or “Access unavailable: Shared folder is no longer accessible”. |
| Confirm, fail or dismiss a dialog | Standard dialogs support Cancel or tapping the backdrop. Confirm swaps its label for a spinner during the operation. Failure keeps the form available and displays the error or “Action failed”. The explicit Cancel on a pending share addition aborts the request. Backdrop dismissal closes the view. |
| Refresh the index | **Refresh now** starts a check and disables while busy. “Checking for updates...”, “Indexing…” and per-root percentage/progress give way to the last-updated time or “Last refresh failed: [label] message”. A failure draws attention to Refresh and the library menu. |
| Change timer duration or appearance | Timer choices are **15m, 30m, 45m, 60m, End of track**. Theme choices are **Light, Dark, Auto (system)**. The native playback timer is pending. Theme changes apply to the shared screen. |
| Turn Debug on or off | The settings text reads “Log, evidence indicator and version-refresh are turned on.” The native Debug player also shows the live cache strip when expanded. The root can show the build number, 📋 log toggle and evidence glyph. The browser debug glyph can simulate signed-out state. The log can include a separate “Swift · auth and playback” disclosure in native. A PWA service-worker update can reload the page when debug version-refresh is enabled. |
| Open native Debug playback tests | **Test local MP3 files…** opens a test sheet in Settings or from the native Debug signed-out screen. Starting a local test uses the system multi-file MP3 picker. **Test playing album…** uses the currently playing physical album. Choices include **Play from beginning**, **Play near first join**, **Force renewal now**, **Force renewal, hold 5s/10s**, **Playback status**, and **Stop playback**. Renewal options apply to OneDrive media. The hold delays delivery of the renewed successor URL at the join. Cancelling the picker is silent. An unsuitable selection can show “Choose an MP3 in a OneDrive album folder.” **Playback status** shows a transient current status such as “Stopped”, “Preparing playback”, “Paused at end of track”, “Playing track N” or a failure. Test failures can show “Could not start the playback test.” |
| A page is replaced | A fresh native view rebuilds the library UI and attaches to the live Swift session. A normal WebKit page reload and a test harness terminating its app host have different effects on playback. No in-app crash diagnosis is presented. |

- [ ] Review each share action and error, backdrop behavior during submission, refresh warnings, diagnostic controls and the Debug-only test vocabulary.

[Settings and share controls](../src/settings.ts) · [Dialog behavior](../src/modal.ts) · [Share validation](../src/shares.ts) · [Native test sheet](../src/index.ts)

The implementation and independent source audit establish the inventory. The current simulator fetching tests exercise network behavior. Physical call/headphone interruptions, car controls, Microsoft’s live dialogs and every possible third-party error message have not been reproduced for this review.
