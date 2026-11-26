# M18 plan: Playback modes and offline folders

## Summary

A listener can play an ordinary album in the current mode, return to a favorite in its own last chosen mode, and keep a OneDrive or shared folder offline directly from the tree. The hosted PWA and bundled iOS app must agree. The acceptance test removes a folder pin while a playlist still owns one of its tracks, then plays that track offline on both players. [M18 requirements](../../TODO.md#attach-behaviors-to-existing-folders)

## HOW TO EXECUTE A MILESTONE

[Please include what follows verbatim when you write a PLAN_M{n}.md file. It will be used to guide anyone who executes on your plan.]

If the user asks you to execute on a plan, these are the steps to take.

1. Implement the plan
   - You should check your work with AI autonomous validation and testing.
   - The hope is that implementation can be done with a minimum of user interaction, preferably none at all.
   - Once it is complete, fill in the "Validation" section to the bottom of the plan showing how you have validated it and what were the results.
   - You might have discovered better engineering
2. Perform your testing and validation
   - Update the "AI VALIDATION RESULTS" section of your PLAN_M{n}.md file
3. Review your own code. For peer review, use only the five specialist roles in step 4. Every round, including review after fixes, requires a dedicated KISS reviewer.
   - You will need to provide it contect: your plan document PLAN_M{n}.md, and tell it which files or functions you've worked on. Ask it also to review your validation steps.
   - If Sol found no blockers or problems with your work, you may proceed. Do static checking (formatting, eslint, typechecking). If you need any fixes, static check again to make sure it's clean.
   - If you couldn't get Sol to run for whatever reason, the user wants you to abort and report what's wrong.
   - Keep iterating with Sol until you no longer make changes (either because you've taken on Sol's feedback from past rounds, or because your plan no successfully defends its positions so Sol accepts them). However, if you take more than 10 rounds, then somethig is wrong, so stop and let the user know.
   - We aren't looking for "blocker vs non-blocker" decisions. Instead for every suggestion from Sol you must evaluate "will this improve my code? if so then modify your code, and if not then pre-emptively defend (in code comments) why not". And if you made modifications or comments, then circle back with Sol again.
   - Do NOT reference previous rounds when you invoke it: Sol does best if starting from scratch each round, so it can re-examine the whole ask from fundamentals. Note that each time you invoke Sol it has no memory of previous invocations, which is good and will help this goal! Also, avoid asking it something like "please review the updated files" since (1) you should not reference previous rounds implicitly or explicitly, (2) it has no understanding of what the updates were; it only knows about the current state of files+repo on disk.
4. After implementation, do a "better engineering" phase
   - Clean up LEARNINGS.md and ARCHITECTURE.md. If any information there is just restating information from other files then delete it. If it would belong better elsewhere, move it. Please be careful to follow the "learnings decision tree" -- LEARNINGS.md for durable engineering wisdom, ARCHITECTURE.md for things that will apply to CodexAgent.ts in its finished state, PLAN_M{n}.md for milestone-specific notes
   - Launch the five GPT Sol 6.2 High specialists below in parallel on the same revision. Read the KISS findings alongside the other reports before deciding which suggestions warrant a change. Give the KISS reviewer the accepted product trade-offs and ask which proposed guarantees or existing machinery can be dropped.
   - (1) Review the code for correctness. Also ask Sol to evaluate this.
   - (2) Validate whether work obeys the codebase style guidelines in AGENTS.md. Also ask Sol to evaluate this. The user is INSISTENT that they must be obeyed.
   - (3) Validate whether the work obeys each learning you gathered in LEARNINGS.md. Also ask Sol to evaluate this. (A separate instance of Sol; it can't do too much in one go).
   - (4) Validate whether the work has satisfied the milestone's goals. Also ask Sol to evaluate this.
   - (5) Check if there is KISS, or consolidation, or refactoring that would improve quality of codebase. Also ask Sol the same question.
   - If you make changes, they'll need a pass of static checking (formatting, eslint, typechecking), and again to make sure it's clean.
   - You might decide to do better engineering yourself. If not, write notes about whats needed in the "BETTER ENGINEERING INSIGHTS" section of the plan.
   - Tell the user how you have done code cleanup. The user is passionate about clean code and will be delighted to hear how you have improved it.
5. Upon completion, ask for user review. Tell the user what to test, what commands to use, what gestures to try out, what to look for

## Locked user decisions

- One active playback mode. Starting a shortcut, playlist, or song within one uses the last mode explicitly picked while playing that favorite. A favorite with no saved mode and a folder under OneDrive or a share both inherit the current mode. “Remember my spot” controls position independently.
- Manage a physical folder by long-pressing it and using the folder icon at the bottom right of the existing selection bar. Keep the existing Play control. A partially marked folder offers **Make available offline** and **Make unavailable offline**. Removal clears all folder pins at and below the selection. Other download owners keep their tracks.
- Folder pins sync across devices. Disconnecting a share forgets its folder pins. Reconnecting the same link starts with no folder pins and may show the link’s last cached listing while it refreshes. Download progress is device-local. Only physical folder pins contribute to physical folder arrows. Show a solid arrow after the explicit pin's name, dots above it and no arrow or offline folder menu below it. The pinned breadcrumb explains coverage. Both shapes have the existing downloading animation and blocked, hitting-a-wall variant.
- Folder pins follow the existing favorites upload and pull rules. Unpinning changes the requested folder set. Each player applies its existing audio-cache cleanup policy. Re-downloading after changing pins is routine. Re-pinning while deletion is in progress has no prescribed intermediate outcome.
- Plan for the current PWA and bundled iOS builds only. The owner confirmed there are no existing users and upgrade work is outside M18. Use the current IndexedDB stores and version.
- Use a fresh GPT‑6.2 Sol reviewer at High reasoning effort for this plan review. The execution checklist follows MILESTONES.md with Sol named as reviewer.

## PLAN

### 1. Use the mode already stored on each favorite

On a successful folder Play or track tap, select `favorite.mode ?? currentMode`. Resolve the favorite from the outer logical root of the queue, as the players do today. An ordinary OneDrive/share route has no favorite. The initial mode for a new session is All. Only an explicit mode pick writes to the playing favorite. The live session mode and the favorite’s optional starting preference are sufficient. Remove the redundant `configuredMode` state in both players, including its Swift checkpoint field and queue-revision argument. Browsing, Next and resuming from the footer keep the active mode.

- **Browser.** In `playback.ts`, remove the All resets on leaving a favorite or entering a non-private favorite. Use the effective mode before selecting the first track or restoring a private bookmark. A track tap starts the chosen track at zero. Folder Play in Shuffle starts a fresh pass. Tapping in an existing shuffle queue can keep its pass if the previous mode was also Shuffle. Keep the private flag on position saves and remove it from the mode save. Use the existing `Favorites.setMode` and its local save path. An immediate return to the same favorite should see the listener’s last pick.
- **Bundled iOS.** In `index.ts`, pass a favorite’s optional mode to the existing native start command independently of the private bookmark ID. For a mode-cycle command, capture its acceptance and the existing playback snapshot before awaiting checkpoint writes in `LibraryController.swift`. In `native-playback.ts`, use the reply’s `applied` flag and its snapshot’s `folder` and `mode` to save the pick to the playing favorite. The folder route already identifies its owner. In `NativePlayback.swift`, fall back to the live mode, including when deciding whether to resume a bookmark. Remove the favorite-exit reset. On both players, queue refresh or a change to “Remember my spot” updates the queue or position policy without applying a new starting mode to the live session.

### 2. Add folder pins to the favorites document

Add one `folderPins` array to `FavoritesData` in `favorites.ts`, alongside the favorites array. Each entry is an existing `ItemRef` for a physical folder, with an explicit `sourceRootKey` for both OneDrive and share routes. A share pin also records the connection UUID already assigned by `shares.ts`. Use it when matching pins for edits, healing, badges and download ownership, since reconnecting the same link reuses its root key. An absent array reads as empty. These references have no Home rows. Favorite modes stay in `Favorite.mode`. Use the existing IndexedDB record, `favorites.json`, serialized edits and upload pump. An edit saves locally and triggers a best-effort upload of the whole favorites document. A pull adopts a newer remote document. An older or absent remote copy leaves the local document in place. If an upload fails while offline, a later successful favorites save can carry the folder edit to other devices. [Original sync decision](PLAN-M7.md#persistence)

- **Make available offline** adds the selected folder once. Its whole subtree, including later indexed additions, is covered. Replace explicit pins inside it with the parent pin in that same edit. The parent now expresses the entire request.
- **Make unavailable offline** removes the explicit pin on the selected folder and every explicit descendant pin in one local edit. Compare path **segments** within the same physical source. A similarly named folder in another share or a sibling such as `Bookshelf` is a different branch. Shortcut and playlist pins remain independent.
- Extend the existing favorite-reference healing pass to the folder refs, using the same indexed paths, IDs, verified-root rules and explicit share-removal callback. On disconnect, await the serialized local favorites edit that clears pins for the removed connection UUID before waiting for remote cache cleanup. Today the final healing callback runs after the best-effort Graph delete; an offline disconnect should save the user’s choice without waiting for that request. Re-adding the link gets a fresh connection UUID, so its folders start without the former pins even if another device sees the new connection before it receives the pin edit. Heal folder refs against folder nodes using the same path-then-ID order as shortcuts. Use the existing share records, indexing policy and cache layout. [Favorite healing](../src/favorites.ts) · [Share disconnect](../src/index-sync.ts)

### 3. Feed both kinds of pin into the existing downloaders

Resolve each explicit folder with the same folder walk used for a shortcut. Use its physical source and item ID as its stable owner key, qualified by the connection UUID for a share. Include it alongside offline favorites when computing the union of physical `driveId:itemId` keys. A recording requested by both a folder and a playlist occupies one cache entry and stays available when either owner is removed. Folder pins contribute active and retained keys. A paused favorite continues to contribute retained keys under its existing rules.

The bundled app already accepts opaque owner IDs, source-grouped keys and a completeness flag. Publish the combined owner list through `native-pins.ts` to the Swift manifest. Both kinds of intent load in the same favorites document. A temporarily unavailable share keeps its owner with incomplete membership under the existing native policy.

In the PWA, pass the combined active and retained key sets to the existing `downloads.setPinnedKeys`. With a nonempty retained set, cleanup removes unowned blobs. With an empty retained set, the M11 guard skips cleanup. Removing the final pin clears its mark and can leave previously downloaded audio playable in the browser cache. [M11 cleanup decision](PLAN-M11.md)

Separate membership changes from progress updates in `index.ts`. Recompute the pinned subtrees when the pins, relevant favorite contents, access or index change. Use the time-sliced walk and cached owner counts from `native-pins.ts` for both clients. Once the PWA download projection and the favorite dialog read those counts, remove their duplicate `collectPhysicalTracks` traversal and fallback. A file completion updates counts for its owners. Opening a folder or rendering a badge reads the projection. A library of 30,000 tracks should remain browsable while pinning a large folder.

### 4. Use the selection bar and the existing offline arrow

In `select.ts`, show the folder button for one selected physical **subfolder** of OneDrive or a share. Reuse the existing right-button dropdown. Open the existing favorite offline dialog for both favorites and physical folders. The dropdown has one item, **Make available offline** for unmarked folders or **Available offline…** for explicit and partial folders. The dialog uses that item as its title and shares the existing name/status row, progress display, device quota picker and close control. Favorites keep their pause/resume policy. Unmarked folders show the folder name, recursive track count and the make-available action. Explicit pins show the folder name, local progress and the make-unavailable action. Partial folders show **1 child folder** or **N child folders** beside the dotted badge and the unique track totals, downloaded bytes or progress of those marked descendants. Their dialog offers both make-available and make-unavailable actions. Closing an idle dialog leaves folder pins unchanged. The dialog confirms the local favorites save. A failed local save leaves the action available. Each downloader reconciles the committed pins in the background. Keep existing selection actions for tracks, favorite roots, playlist members and multiple selections. At confirmation, use the folder the listener opened the dialog for and the committed pins.

| Physical folder row | Arrow after its name | Actions in the offline dialog |
| --- | --- | --- |
| No folder pin here, above or below | None | Make available offline |
| Explicit pin, with no pinned ancestor | Solid | Make unavailable offline |
| Contains explicit pins below it and has no covering pin | Dotted | Make available offline and Make unavailable offline |
| Covered by a pinned ancestor | None | Hide the folder button |

The source root can show dots above a pin and keeps its existing nonselectable behavior. Child rows show their own coverage. Show only the rightmost offline arrow in the breadcrumb trail. A deeper dotted or solid arrow suppresses the dotted arrows above it. Breadcrumbs beneath an explicit pin leave its solid arrow visible. Playlist-only downloads do not mark a physical folder. Build the explicit-pin and ancestor path lookups when pin membership changes. For a dotted arrow, use the existing offline-state classifier and the cached progress of the marked descendant owners. The ancestor needs only to know whether any of them is incomplete. It can show completion while unmarked albums remain online-only. Reuse `tree.ts:setOfflineBadge`, its motion and wall, and place the dotted arrowhead’s dots in mirrored pairs. Keep the badge passive and distinguish partial marking in its accessible label.

## BETTER ENGINEERING INSIGHTS + BACKLOG ADDITIONS

The selection bar opens one offline dialog for both favorites and physical folders. The two players share one time-sliced owner walk. Only marked owners participate in the background projection. An unmarked folder or favorite is counted on demand while its dialog is open. File completions update owner counts directly. The browser reads verified blob sizes in one IndexedDB cursor pass and shares that same inventory with the dialog.

Pin edits, queue edits and saved mode changes notify the consumers that need them. A committed queue edit can advance even when a separate offline-owner write fails. Swift keeps the previous membership of each incomplete owner. Each owner has its own stable namespace. An unresolved new owner cannot establish that it shares files with an unrelated removed one.

A source UUID identifies a particular connection to a share link. The cached listing belongs to the link, and the saved pins belong to this connection. Reconnecting can reuse the listing immediately. Both players can resolve a pin from a complete cached listing while offline. A later verified index lets the favorites model heal moved references. Disconnect first saves the removal of the connection’s pins and favorite references. If this save fails, the share stays connected and the same dialog can retry.

## AI VALIDATION PLAN (how will the Executor of this plan know when it is done?)

1. **Modes on both players.** Choose One in OneDrive. Tap a song in a new favorite with remembering off and verify One. Choose Shuffle there, play an ordinary folder and verify Shuffle, choose All there, then tap a song back in the favorite and verify Shuffle and the exact track. On a deterministic shuffle fixture, also check which track actually plays next. Repeat with remembering on. Verify a private sequential bookmark resumes, an explicit track starts at zero, and a refresh leaves the live mode alone.
2. **Pins, UI and overlap.** Pin Books/Dune. Check the solid arrow on Dune, dots on Books, and no arrow or folder button below Dune. Check both actions on Books. Exercise pinning Books and removing it, then removing Books while only Dune is marked. Keep one Dune track in an offline playlist throughout. Inspect the owner sets and actual offline playback. Remove the last remaining pin and check the empty owner set and cleared badge on both platforms. Verify the browser’s empty-set guard retains cached audio and Swift releases the file once the last owner and playback lease are gone. Test the dotted arrow during download, when blocked, and at completion. Check a share folder, Cancel, and the existing favorite/select controls.
3. **Sync and offline use.** Pin on one device while online. After its upload succeeds, refresh the other and verify matching intent and independent download counts. In a fixture, edit offline, reopen and verify the local edit. With the cloud copy still older, reconnect and pull. Verify that the local pin survives and the pull issues no PUT. Make another favorites edit online and verify that its successful whole-document upload carries both edits to the second device. Disconnect the share and re-add the same link. Its former folder pins should be gone. On native iOS, also cold-open with a still-connected but temporarily unavailable share and verify its existing incomplete-owner retention.
4. **Scale and release.** Measure projection time and the longest main-thread slice on a 30,000-track fixture. Verify progress notifications and navigation do not trigger another subtree walk. Run `npm run build` and `npm run test:unit` in `music/`, the native OnePlayMusic scheme tests and the signed LuPhone13 checks. Run `arc lint` where configured. Deploy before Playwright, announce and monitor `/tmp/oneplay-music-test.log`, and exercise the local and production suites including mobile screenshots of the partial menu, its offline dialog and the pinned breadcrumb. Follow the commands and timeout workflow in [AGENTS.md](../../AGENTS.md#testing).

## AI VALIDATION RESULTS (how did the Executor show that it was done?)

### User-visible behavior

- On the 390 × 844 production layout, a partial folder shows **Available offline…**, **2 child folders** and a dotted arrow, then **3 tracks, 3 Mb ✓**. A recording in both children counted once. At a partial parent the trail showed one dotted arrow. Entering its explicitly pinned album replaced that with one solid arrow on the album. Returning to the parent restored its dotted arrow. Tests checked the symmetry of the rendered dots and exercised a trusted touch hold, release and both partial actions. A 750 ms HID hold on the iOS simulator also kept the selected folder active on release.
- Browser and bundled tests exercised playback modes, bookmarks and the actual successor in Shuffle. Both players played the surviving playlist recording offline after folder removal. Removing the last owner in its bundled dialog cleared the arrow immediately. Swift kept the playing file until natural end, then freed the bytes.
- Separate clients adopted the same uploaded pin intent with different device progress. An offline edit survived reopening and reached the other client on a later upload. Mobile WebKit pulled a share pin captured from the real PWA save path. Disconnect/reconnect tests on both web origins covered the old connection UUID and failed disk writes.

### Library and storage measurements

- The original browser subtree walk took 0.15 ms median per notification for a 500-track favorite alone, or 11.8 ms with an additional unpinned 29,500-track shortcut (100 samples). The replacement did zero subtree walks during navigation and all 499 completions. Counting the unpinned library shortcut happened only when its dialog opened. An open quota picker retained focus across 495 progress updates.
- With 500 downloads spread across 50 albums in a 30,000-track library, the actual Chromium progress callback took 0.10 ms median, 1.30 ms at the 95th percentile and 1.60 ms maximum on production. Five navigations completed during the burst. A separate production run bulk-unpinned 500 files in eight IndexedDB transactions. Confirmation took 72 ms, down from 493 ms. A surviving playlist recording played offline. An injected transaction failure rolled back the batch. Of the 500 notifications, only 50 album state transitions replaced visible rows. Separately, healing a moved 500-track folder in a depth-40 index took 6.2 ms of JavaScript across two turns, 4.3 ms maximum. The recovery implementation does the lookup only in healing.
- Across 502 native WebKit progress callbacks with 50 marked albums, both the 95th percentile and maximum rendering time were 2 ms. Two navigation clicks together took 24 ms. The bundled simulator published a 500-track owner from a 30,000-track library in 53 ms in an isolated run, with 12 ms between event-loop samples at most during publication. The 503 progress signals arrived over 8.33 s with a longest sampled interval of 101 ms. Concurrent runs reached 106 and 262 ms. These intervals include host scheduling and native-to-WebKit delivery.
- The production profile’s 17 cached recordings averaged 5.52 MB each, about 195 recordings per GiB. An isolated iPhone 17e simulator running Mobile Safari used 500 real WAVs and a 30,000-track library. The 2 GiB limit paused new work at 385 recordings and 2,156,000,000 bytes. Raising it to 5 GiB completed all 500 at 2,800,000,000 bytes. The 117 new recordings each transferred once. After terminating Safari and reopening offline, a trusted tap played a newly downloaded WAV from IndexedDB without a media request. The fixture and temporary simulator were removed.
- On LuPhone13, cold inventory for 500 sparse files with 2.8 GB of logical audio took 43 ms. The signed test added one indexed MP3, raised the quota, completed only that download and verified advancing playback after an offline cold reopen.
- On the iOS simulator, removing 499 of 500 files while one remained in a playlist took 721 ms to confirm in an isolated run and 1,006 ms during the full suite. Deleting in short batches brought the longest sampled main-actor interval down from 558 ms to 20.5 ms and 49.2 ms respectively. A folder navigation completed in 2 ms during deletion in each run.

### Review and release verification

The first implementation received one round of five specialist reviews and nine general reviews. Its dedicated KISS reviewer never saw the later pin-retention machinery. Recovery used dedicated GPT-6.2 Sol High KISS review across the entire milestone and treated re-downloading as routine.

The recovery removed cross-owner inheritance, the native unpin journal, transfer staging during pin edits and the requirement to finish cache cleanup before confirming a save. The favorites model owns pin normalization and healing. The dialog reads the current saved state after a local error, and both players supply the queue count directly. The existing native task-ID journal and ordering of remote cache writes during disconnect predate M18. They remain part of the deployed native recovery and remote index cleanup contracts. [M17 native transfers](PLAN-M17-ios.md)

On build 333, one IndexedDB transaction removed 500 unowned files. In the focused production test the dialog closed in 9.3 ms, navigation took 0.5 ms and background cleanup finished in 80.8 ms. The playlist recording played offline. A forced transaction abort on both web origins preserved every file and its reported size. On the iOS simulator, local save and eventual cleanup of 499 files measured 16 ms and 626 ms in build 332, and 71 ms and 978 ms in build 333.

Before recovery, five signed acceptance checks passed on LuPhone13. The separate test host was removed and the regular app updated to build 53. Playwright uses isolated accounts and fixture Graph responses on both localhost and the hosted release. The listener’s personal browser profile requires an interactive reconnect on each origin.

Recovery ran five dedicated GPT-6.2 Sol High KISS reviews of the whole milestone. The fifth recommended shipping. Web build 334 passed all 177 unit tests and 112 Playwright cases on each origin. Chromium and WebKit verified the disconnect retry on both origins. During 500 downloads across 50 albums in a 30,000-track library, the hosted progress callback took 1.2 ms at the 95th percentile and 1.4 ms maximum. Removing the 500 files closed the dialog in 9.1 ms and finished background cleanup in 64.5 ms. A separate Mobile Safari run filled 2.8 GB with 500 recordings and played a newly downloaded recording after an offline cold restart.

The native simulator passed 59 tests with one opt-in live-account test skipped. In an isolated run with the release’s bundled page, removing 499 files saved the edit in 16 ms, completed disk cleanup in 461 ms and allowed offline playback of the surviving playlist recording.

LuPhone13 received the regular signed app in place. The device listed one OnePlay Music installation, `me.unto.oneplay.music` version 1.0 (54), with the same 34 bundled web resources verified against production. The phone required its passcode for remote launch, so playback on build 54 was verified on the simulator.

## USER VALIDATION SUGGESTIONS

Try the mode sequence in check 1 with a playlist you recognize. For folders, pin one album inside a larger collection, open a disc inside it and look up at the breadcrumbs for the pinned album. Keep one song through an offline playlist, clear the collection’s folder pins, then play that song offline.
