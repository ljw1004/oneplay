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
3. Review your own code. Also, ask GPT Sol 6.2 High to review your work
   - You will need to provide it contect: your plan document PLAN_M{n}.md, and tell it which files or functions you've worked on. Ask it also to review your validation steps.
   - If Sol found no blockers or problems with your work, you may proceed. Do static checking (formatting, eslint, typechecking). If you need any fixes, static check again to make sure it's clean.
   - If you couldn't get Sol to run for whatever reason, the user wants you to abort and report what's wrong.
   - Keep iterating with Sol until you no longer make changes (either because you've taken on Sol's feedback from past rounds, or because your plan no successfully defends its positions so Sol accepts them). However, if you take more than 10 rounds, then somethig is wrong, so stop and let the user know.
   - We aren't looking for "blocker vs non-blocker" decisions. Instead for every suggestion from Sol you must evaluate "will this improve my code? if so then modify your code, and if not then pre-emptively defend (in code comments) why not". And if you made modifications or comments, then circle back with Sol again.
   - Do NOT reference previous rounds when you invoke it: Sol does best if starting from scratch each round, so it can re-examine the whole ask from fundamentals. Note that each time you invoke Sol it has no memory of previous invocations, which is good and will help this goal! Also, avoid asking it something like "please review the updated files" since (1) you should not reference previous rounds implicitly or explicitly, (2) it has no understanding of what the updates were; it only knows about the current state of files+repo on disk.
4. After implementation, do a "better engineering" phase
   - Clean up LEARNINGS.md and ARCHITECTURE.md. If any information there is just restating information from other files then delete it. If it would belong better elsewhere, move it. Please be careful to follow the "learnings decision tree" -- LEARNINGS.md for durable engineering wisdom, ARCHITECTURE.md for things that will apply to CodexAgent.ts in its finished state, PLAN_M{n}.md for milestone-specific notes
   - You will have several GPT Sol 6.2 High review tasks to do, below. You must launch all the following Sol review tasks in parallel, since they each take some time: prepare all their inputs, then execute them all in parallel. You should start addressing the first findings as soon as you get them, rather than waiting for all to be consolidated. You can be doing your own review while you wait for Sol.
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
- Folder pins sync across devices. Disconnecting a share forgets its folder pins. Reconnecting the same link starts with no folder pins. Download progress is device-local. Only physical folder pins contribute to physical folder arrows. Show a solid arrow after the explicit pin's name, dots above it and no arrow or offline folder menu below it. The pinned breadcrumb explains coverage. Both shapes have the existing downloading animation and blocked, hitting-a-wall variant.
- Folder pins follow the existing favorites upload and pull rules. Unpinning changes the requested folder set. Each player applies its existing audio-cache cleanup policy.
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

Resolve each explicit folder with the same folder walk used for a shortcut. Use its physical source and item ID as its stable owner key, qualified by the connection UUID for a share. Include it alongside offline favorites when computing the union of physical `driveId:itemId` keys. Thus a track requested by a folder and a playlist downloads once and remains available when either owner is removed. Folder pins contribute active and retained keys. A paused favorite continues to contribute retained keys under its existing rules.

The bundled app already accepts opaque owner IDs, source-grouped keys and a completeness flag. Publish the combined owner list through `native-pins.ts` using the existing fence and Swift manifest. Both kinds of intent load in the same favorites document. A temporarily unavailable share keeps its owner with incomplete membership under the existing native policy.

In the PWA, pass the combined active and retained key sets to the existing `downloads.setPinnedKeys`. With a nonempty retained set, cleanup removes unowned blobs. With an empty retained set, the M11 guard skips cleanup. Removing the final pin clears its mark and can leave previously downloaded audio playable in the browser cache. [M11 cleanup decision](PLAN-M11.md)

Separate membership changes from progress updates in `index.ts`. Recompute the pinned subtrees when the pins, relevant favorite contents, access or index change. Use the time-sliced walk and cached owner counts from `native-pins.ts` for both clients. Once the PWA download projection and the favorite dialog read those counts, remove their duplicate `collectPhysicalTracks` traversal and fallback. A file completion updates counts for its owners. Opening a folder or rendering a badge reads the projection. A library of 30,000 tracks should remain browsable while pinning a large folder.

### 4. Use the selection bar and the existing offline arrow

In `select.ts`, show the folder button for one selected physical **subfolder** of OneDrive or a share. Reuse the existing right-button dropdown. Build the short folder confirmation with `showModal` and `addModalActions`. The favorite dialog keeps its own quota, pause and progress controls. Keep existing selection actions for tracks, favorite roots, playlist members and multiple selections. At confirmation, use the folder the listener opened the dialog for and the committed pins. Cancel leaves them alone.

| Physical folder row | Arrow after its name | Folder actions |
| --- | --- | --- |
| No folder pin here, above or below | None | Make available offline |
| Explicit pin, with no pinned ancestor | Solid | Make unavailable offline |
| Contains explicit pins below it and has no covering pin | Dotted | Make available offline and Make unavailable offline |
| Covered by a pinned ancestor | None | Hide the folder button |

The source root can show dots above a pin and keeps its existing nonselectable behavior. Use the same rules in child rows and breadcrumbs so the solid arrow identifies the covering ancestor. Playlist-only downloads do not mark a physical folder. Build the explicit-pin and ancestor path lookups when pin membership changes. For a dotted arrow, use the existing offline-state classifier and the cached progress of the marked descendant owners. The ancestor needs only to know whether any of them is incomplete. It can show completion while unmarked albums remain online-only. Reuse `tree.ts:setOfflineBadge`, its motion and wall, and give the arrow stroke a dotted variant in `index.css`. Keep the badge passive and distinguish partial marking in its accessible label.

## BETTER ENGINEERING INSIGHTS + BACKLOG ADDITIONS

The existing abstractions already distinguish a logical favorite, a physical folder reference, and an offline track with several owners. M18 adds one collection of folder references to the synced document. The existing favorites uploader, share lifecycle and platform download policies already handle these edits.

## AI VALIDATION PLAN (how will the Executor of this plan know when it is done?)

1. **Modes on both players.** Choose One in OneDrive. Tap a song in a new favorite with remembering off and verify One. Choose Shuffle there, play an ordinary folder and verify Shuffle, choose All there, then tap a song back in the favorite and verify Shuffle and the exact track. On a deterministic shuffle fixture, also check which track actually plays next. Repeat with remembering on. Verify a private sequential bookmark resumes, an explicit track starts at zero, and a refresh leaves the live mode alone.
2. **Pins, UI and overlap.** Pin Books/Dune. Check the solid arrow on Dune, dots on Books, and no arrow or folder button below Dune. Check both actions on Books. Exercise pinning Books and removing it, then removing Books while only Dune is marked. Keep one Dune track in an offline playlist throughout. Inspect the owner sets and actual offline playback. Remove the last remaining pin and check the empty owner set and cleared badge on both platforms. Verify the browser’s empty-set guard retains cached audio and Swift releases the file once the last owner and playback lease are gone. Test the dotted arrow during download, when blocked, and at completion. Check a share folder, Cancel, and the existing favorite/select controls.
3. **Sync and offline use.** Pin on one device while online. After its upload succeeds, refresh the other and verify matching intent and independent download counts. In a fixture, edit offline, reopen and verify the local edit. With the cloud copy still older, reconnect and pull. Verify that the local pin survives and the pull issues no PUT. Make another favorites edit online and verify that its successful whole-document upload carries both edits to the second device. Disconnect the share and re-add the same link. Its former folder pins should be gone. On native iOS, also cold-open with a still-connected but temporarily unavailable share and verify its existing incomplete-owner retention.
4. **Scale and release.** Measure projection time and the longest main-thread slice on a 30,000-track fixture. Verify progress notifications and navigation do not trigger another subtree walk. Run `npm run build` and `npm run test:unit` in `music/`, the native OnePlayMusic scheme tests and the signed LuPhone13 checks. Run `arc lint` where configured. Deploy before Playwright, announce and monitor `/tmp/oneplay-music-test.log`, and exercise the local and production suites including mobile screenshots of the partial menu and pinned breadcrumb. Follow the commands and timeout workflow in [AGENTS.md](../../AGENTS.md#testing).

## AI VALIDATION RESULTS (how did the Executor show that it was done?)

Pending implementation.

## USER VALIDATION SUGGESTIONS

Try the mode sequence in check 1 with a playlist you recognize. For folders, pin one album inside a larger collection, open a disc inside it and look up at the breadcrumbs for the pinned album. Keep one song through an offline playlist, clear the collection’s folder pins, then play that song offline.
