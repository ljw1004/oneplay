# Project Milestones and Validation

## Working process

IMPORTANT: we must validate every step of the way. The project milestones will reflect this.

Milestones: We will do only one milestone at a time.
1. Then EnterPlanMode to do research and planning. Use teams/swarms if possible.
   - It is fine during planning to have back-and-forth with the human to clarify the milestone's goals, and any other important clarifying questions.
   - The research should includ study of DESIGN.md to understand what UX will be built in this milestone.
   - It should also include having subagents review `example/` for patterns relevant to that milestone (this is reference code only; fresh code will be written). The examples show proven approaches for auth, indexing, tree rendering, playback controls, and scrubber interaction. An agent should distill relevant learnings before implementation begins.
   - It should also include subagents reading all prior plan documents.
   - The plan should always have a focus on AI autonomous validation and testing, during and upon completion.
   - If you're not asking any questions at all for the entire planning, something's wrong! I know the design doc and this file are not fully specified. There must be important things for you to clarify.
2. Present the plan to a different agent for review and act on its feedback (e.g. if you are Claude then ask Codex, and vice versa)
   - You'll want to provide it context, e.g. the plan document, design document. You can trust it has read AGENTS.md but nothing else.
   - Of the two, Codex is my trusted senior engineer. You should respect it. If you disagree with its takes, you must invoke it again and try to justify yourselves. Do not proceed with your plan until you have Codex signoff.
   - It's not possible to have an ongoing dialog with these other agents. You have to provide full context to it each time.
4. Present the plan for human review and signoff.
   - Upon acceptance, plans MUST be written out into the repository as PLAN-M1.md, PLAN-M2.md and so on.
   - The plan should include relevant parts of design, and relevant digests or summaries and learnings from example code.
5. Implement the plan
   - Start by writing out the plan into the repository
   - Use teams/swarms. Even if it's not parallelizable, still use a team.
   - Each subagent can be told about the milestone's plan file to guide their work, if appropriate.
   - You should check your implementation with AI autonomous validation and testing.
   - The hope is that implementation can be done with a minimum of human interaction, preferably none at all.
   - Once it is complete, add a "Validation" section to the bottom of the plan showing how you have validated it and what were the results.
6. Ask the other agent for review of your implementation.
   - You will need to provide it contect: your plan document PLAN-Mn.md, and tell it which files or functions you've worked on. Ask it also to review your validation steps.
   - Again, codex is my trusted senior engineer, and I want you to get Codex signoff.
7. After implementation, do a "review" phase
   - Clean up LEARNINGS.md. If any information there is just restating information from other files (AGENTS.md, SANDBOX.md) then delete it. If it would belong better elsewhere, move it.
   - Ask your own subagent and also other agent to validate whether the changes have satisfied their goals
   - Ask your own subagent and also other agent for code review
   - Ask your own subagent and also other agent if there is KISS, or consolidation, or refactoring that would improve quality of codebase
   - Tell the user how you have done code cleanup. The user is passionate about clean code and will be delighted to hear how you have improved it.
8. Upon completion, ask for human review. Tell the user what to test, what commands to use, what gestures to try out, what to look for

## Milestone 1: Development infrastructure

The goal is to establish that we can "close the loop" by fully testing what we have produced. I'm expecting a lot of back and forth between AI and human at this stage.

1. We have a webpage running on a local webserver. The AI should decide how+when we will run the local webserver and what it should be.
2. The AI agent can retrieve + click the page using playwright
3. The human can view the page also, when the local webserver is running
4. The AI and human can both deploy to the production website https://unto.me/oneplay/music/
5. The AI and human can both retrieve the page from the production website
6. The human can install the production website onto is iPhone
7. On localhost the code can generate logs/telemetry which the AI can read.

For the local webserver, use npm serve package: `serve -l 5500 -n` from repo root.
In the restructured repo layout, music is served at `http://localhost:5500/music/` (and video at `/video/`).

For deploying to production, `rsync --recursive --times --compress --progress --delete ./ lu@unto.me:/mnt/disks/pod7disk/www/untome/oneplay/music --exclude='eslint.config.js' --exclude='*.ts' --include='dist/' --include='dist/**' --include='*.html' --include='*.css' --include='*.jpg' --include='*.png' --include='manifest.json' --exclude='*'"`


## Milestone 2: OneDrive authentication

The goal is to establish that we can sign in. This step will also involve lots of back and forth.

The file example/utils.ts contains some utility functions I wrote for this. They may provide guidance.

1. The webpage has OneDrive signin that works for 24 hours, plus Entra hidden iframe for signin after 24hrs if it works. Once signed in it displays something about the music folder, e.g. directory listing. Save it to cache (IndexedDB). Display both the cached value and the live value. There is a working signout button too (which also clears the cache). We have readonly permissions for the Music folder, and readwrite permissions for the app-specific folder. This IndexedDB cache is only a test one for this milestone.
2. The human agent can sign into the app on localhost. Moreover, once the human has signed in, then the AI can on subsequent launches benefit from the existing signin. Also, if something was cached by one party (AI or human), then it is available to the next party.
3. The same is true once deployed to production.
4. We won't yet be able to test "Entra signin after 24 hours". We'll come back to that tomorrow.

## Milestone 3: Indexing

The goal is to get real data into our cache, so both local and remote testing by AI will work well, and the AI can proceed autonomously with no further human intervention.

The file example/musicdata.ts and example/index.ts contains code I wrote for a previous version of this. It may provide guidance.

1. We have figured out a schema for the music index. We can index the user's music collection. The index is available on IndexedDB. It should be keyed by which account is being used.
2. When AI or human sign in, cached data is available. If the index is found to be out of date (by some kind of checksum) then we display cached data if available but also kick off a background refresh of that folder and of anything else that's needed.
3. This works both locally and remote

## Milestone 4: Hierarchical tree view

The core navigation experience, the visual backbone of the app.

- Tree with multiple roots (one per OneDrive account; favorites/playlists added in M7)
- Click folder: hide siblings, show ancestors (breadcrumbs) + children
- Click breadcrumb: navigate up
- Breadcrumbs: grey background, never scroll horizontally
- Selected folder: yellow background, play button ▷
- Folders bold, tracks regular
- Vertical scroll; horizontal scroll for long track names (gesture snap so scrolls are unambiguous)
- Icons: ⚙ on account.

Validate: Browse full music library on mobile. Long names scroll. Breadcrumbs work.

## Milestone 5: Playback

Play music from the tree view with a footer controls bar.

- HTML5 Audio element; click track to play
- Playback folder concept: ▷ on selected folder sets playback to recursive descendants
- ▶ (filled) if the selected folder is already the playback folder
- Auto-advance to next track; loading spinner while buffering
- Footer bar (anchored to bottom, not floating pill):
  - Two full lines for track title
  - Play/Pause glyph at right (no border/chrome, like Podcasts app)
  - Current-track indicator at left (chevron > playing, spinner ⟳ loading)
- Clicking chevron in footer scrolls/expands tree to show current track
- Clicking a track outside playback folder: sets playback folder to track's parent
- Footer hidden when no playback folder
- Browser autoplay policy: first play requires user gesture

Validate: Play, pause, resume. Auto-advance. Stream from OneDrive. Footer correct on mobile.

## Milestone 6: Expanded controls & scrubber wheel

The iPod-style scrubber for precise seeking, especially audiobooks.

- Swipe-up on footer expands to half-screen (animated)
- Playlist area above remains visible and usable (not dimmed)
- iPod scrubber wheel (circular touch surface):
  - Hold+drag: arc lozenge thumb (~45°), angle tracking, velocity control
  - Thumb stops at track start/end
  - currentTime / duration in wheel center
- Tap zones: top +30s, bottom -15s, left prev-track, right next-track
- Local seek tracking (rapid taps accumulate without waiting for audio element)
- Top-left: shuffle mode, tap to cycle: one → timer → all → repeat → shuffle
  - "timer" mode = sleep timer (stop after 30 minutes)
- Top-right: close ✕ (grey circle, like Safari share). Also tap non-active area to close.
- Expanded controls auto-collapse if select mode is entered (M8)
- Cannot expand while in select mode

Validate: Scrub through 1-hour audiobook chapter with ~2s precision. ±15s/±30s, prev/next, shuffle modes all work.

## Milestone 7: Favorites (data layer + tree integration)

This milestone is about creating the data model for favorites, and persisting+loading it.

- Data model:
  - Shortcuts ☆: reference to a folder (by path + ID)
  - Playlists ♫: ordered list of references to folders/files/other favorites. So we need to figure out a way to identify favorites, including healing if they get renamed.
  - Cycle detection for playlist-in-playlist at moment of adding them.
- We will have to store the playlists! They should be stored on the onedrive server. That's because they're precious, and represent considerable investment on the part of the user, and they must not be lost. But they should also be cached locally in indexdb.
- Each favorite can have its own playback state: currentTrack, currentPositionWithinTrack, a boolean for "has own state" vs "use global" (but we won't wire this up to the UI yet)
- Broken reference tolerance: silently keep references to moved/renamed items; auto-heal when found again.
   - Auto-heal prefers to auto-heal (and update state) by OneDrive identity. Failing that, by name. Failing that, the item is deleted.
- For display, if you expand a shortcut or playlist, then it expands its contents inside it (following redirections as needed)
- If a shortcut/playlist is inside another playlist, then as a child item it still gets its icon ☆♫
- For now we won't yet worry about playback-folder and favorites. That will come later.

Validation: For now, let's hard-code some logic that if no favorites are present, then on page load we'll create them: one shortcut to a folder in the music database, and one playlist containing three items: a track, a folder in the music database, and the favorite. And save this to disk. We should see it rendering and expanding properly, and loading properly.

## Milestone 8: Select mode, action bar & modals

The UI for managing favorites: select mode, action bar, and all modal dialogs.

- Long-press / right-click → enter select mode (animated, like Outlook)
- Checkboxes on all rows (except top-level "OnePlay Music1")
- Cancel button at top-right
- Action bar replaces playback controls: "Select items" / "3 selected · 58 tracks"
- Action bar icons (enabled/disabled per selection context):
  - ☆ Shortcut: modal with title, "has own playback" checkbox, Create/Cancel
  - ♫ Playlist: modal listing existing playlists + "Create..." → sub-dialog (name, checkbox, Create/Cancel)
  - 🗑 Delete: confirmation modal, red Delete / Cancel. Wording: "Delete favorite" or "Remove from playlist"
  - (...) More: popup with Rename (→ sub-dialog) and Toggle playback memory
- Icon availability rules per DESIGN.md table
- Duplicate items silently ignored when adding to playlist
- The only way to manage a shortcut/playlist is via select mode: long-press to select it, then use the action bar's right button which lets you (1) choose "custom playback" vs "inherit global", (2) delete it, (3) rename if it's a playlist
- State machine: NORMAL ↔ EXPANDED ↔ SELECT, with mutual exclusivity constraints
- And of course delete the test logic from the previous milestone.

Validate: Long-press to select. Create shortcut, create playlist, add to playlist, rename, delete, toggle memory. All modals work on mobile.

## Milestone 9: Playback modes

Have the concept of "playback folder" properly working. I suppose the playback folder is a "logical path" inside the hierarchical tree that includes shortcuts, playlists, favorites. As distinct from a "physical path" that refers to the path within a OneDrive root or Share root.

- The playback folder might be in a favorite, or a folder within that favorite, or a folder inside OneDrive or one of the other share links.
- Will it be possible to compute all recursive children of the playback folder quickly enough? I hope so. We'll add logging and measure it.
- Once we've computed that set, then "shuffle" can be done by shuffling this list.
- The movement to "next track" and "prev track" must be within the logical space
- But when we're playing, we need to resolve it to a "physical track" so we know how to identify its url for sake of OneDrive (or, later on, local download cache)
- In this milestone we implement the modes: play-one, play-to-timer, play-all, repeat, shuffle-and-repeat. The timer will stop after 30mins. The choice of modes will appear as "one|time|all|repeat|shuffle" in the top left of the expanded playback area, and tapping will cycle through them. If the current playback folder is a favorite or a child of one, and the current playback folder has "remember my spot", then the choice of mode will be stored for that favorite (and uploaded). However, I think there's no need ever to upload the "global" mode, nor to upload the current-track nor current-position-within-current-track, even for favorites that remember their spot; it's enough for that information to be stored solely in IndexDB.
- We already have the UX and storage for favorites, "remember my spot". If this is enabled then current-track, current-position-within-track and current-playback-mode are stored local to that favorite. Hence, if you quit the app and come back and play that shortcut again, you'll pick up exactly where you left off. If you play an item within that shortcut, it'll reset current-track and current-position-within-track, but will respect the shortcut-mode.
- If you click on a folder or track within a favorite, that has the usual meaning of "set logical parent as the current playback folder"
- If you click on the chevron in the playback area at the bottom, it will expand the *logical* track that's playing. Thus if you were playing within a playlist, it'll expand that playlist.
- Actually, we'll defer "timer" until a later milestone.

## Milestone 10: State persistence & memory

The app restores to exactly where you left off.

- All M10 state goes in localStorage (not IndexedDB). localStorage is synchronous, so state can be read before first render with no flash of wrong content. IndexedDB stays pure as a cache of what gets stored on OneDrive, not more. Per-favorite currentTime/currentTrack will be migrated out of IndexedDB into localStorage.
- Persist to localStorage on every meaningful state change:
  - Current view (which folder is expanded, per-folder scroll position map, and whether the playback-expanded area is visible)
  - Playback state (folder, track, currentTime, mode) — both for "remember my spot" favorites and for global (non-favorite) playback. Global playback state is persisted so that "close app, reopen → exact same state" works even for casual listening.
  - We won't persist whether we're playing or paused; the app will always start paused.
- currentTime is saved periodically (every few seconds) to localStorage. This is cheap, robust against app crashes and iOS killing the PWA, and covers all cases without needing to enumerate every "user stopped playing" scenario. Per-favorite playback mode is only uploaded to IndexedDB+OneDrive when aspects other than currentTime change like mode (no periodic upload just for mode/currentTime).
- Per-folder scroll position map is persisted to localStorage across restarts. This matters because OneDrive re-auth via redirect counts as a restart and happens often. When navigating to a new folder, scroll to top. When navigating to a parent folder via breadcrumbs, restore saved scroll position.
- State persists indefinitely until sign-out. No TTL or expiry logic. The worst case (stale path to a renamed/deleted folder) already degrades gracefully — the app falls back to root. This matches music app conventions (Spotify, Apple Music, Podcasts) and avoids KISS-violating expiry complexity.

Validate: Close app, reopen → exact same state (right folder, right scroll position, right track and position, paused). Switch audiobook favorites → each resumes. Refresh page during playback → resumes at same position (paused). Reopen after days → same state.

## Milestone 11: Offline audio downloads

Download audio files for offline playback. The offline-first architecture (launch from cache, background network, graceful failure) is already established from M3 onward; this milestone adds the ability to pre-download actual audio content.

- Download ↓ icon (and animation) for favorites
- Menu options in favorites popup
- "Available offline" modal triggered by popup
- Pinning, global queue, pausing+resuming, concurrent downloads
- Global quota and management
- Audio plays from offline IndexDB if available
- Quota management
- Separately, as part of the "network traffic indicator" spirit of this milestone, also have a spinner on OnePlay Music when pulling index/favorites, or pushing favorites
- Switch to ServiceWorker architecture. We'll have "debug mode", an always-on "🕷" icon fixed at the top left of the app, which shows that the worker aggressively detects controller change and does location.reload() during debugging. Have it controlled by a constant boolean, so I can disable the icon+behavior for release.

Validate: Mark a favorite for offline. Downloads complete. Music plays with no connectivity. Incomplete downloads restart when connectivity returns.

## Milestone 12: Entra and playback experience

We wish to fix two "feels like it's working and stays connected" reliability issues

- Entra login. We'll do this via redirect shortly after app launch. The design is in DESIGN.md "Memory" section. It is quite involved!
- For playback to continue on iPhone while in the background, we must set the next track's URL *synchronously* in our callback for the previous track's OnCompleted handler; we can't allow any awaits. This means that the next URL should already have been fetched earlier (including for blob urls for cached files), and stored somewhere so it's synchronously available. We'll need to rework our code for retrieving next-track-url. Probably it will return "next two track urls", and we'll keep a cache. It will be tricky to design a beautiful API for this, one that offers "here's what I know synchronously and here's an async thing too if you need it". I think the example code solved this problem.


## Milestone 13: Settings

Add the settings page, and support shared links.

- Move from current Cloud icon on Onedrive, towards a Gear icon on OnePlay Music.
- Move the current OnePlay Music sync spinner, to one that's split between OnePlay Music and OneDrive
- Create the Settings page, entry and exit and contents
- Sign out and reconnect will work
- Share-add, share-remove will bring up modals, but they'll be no-ops; share implementation is a future milestone
- timer will work and be persisted, but timer mode is left to a future milestone
- indexing progress with live updates will work, but won't show shares yet. Refresh-now button will work
- debug flag will work

Validation: open settings works and scrolls right and buttons have good hit areas, tree state is restored, share modal appears, timer setting persists, debug toggle works, indexing shows up right and refreshes upon button click, sign-out / reconnect flows still work.

## Milestone 14: Shares

Shares will work end to end. M13 stubbed the Settings UI (add/remove modals with no-op handlers); this milestone builds the data layer, indexing, tree integration, and wires everything up.

- Share data model and persistence (IndexedDB + OneDrive app folder, same pattern as favorites)
- Add share: wire the modal, resolve the URL via Graph API, derive initial name, persist, add to tree, kick off background indexing
- Remove share: wire the modal, show affected favorite count, disconnect, heal favorites
- Rename share: wire the rename icon and modal, persist
- Extend indexer to handle share drives. Share indexes stored on the primary OneDrive app folder. Serialized after primary index. Per-share ⟳ spinner on the tree row
- Share roots in the tree (after accounts). Expandable, browsable, not selectable in select mode. Children can be favorited and added to playlists
- Denied shares: per-share error state from permission failures, ⚠ on gear icon, error text in Settings. Does not affect global evidence state
- Healing: when any share is denied, don't remove shared ItemRefs from favorites. Items from denied shares shown as unavailable
- Playback and offline downloads work for share tracks (existing driveId:itemId machinery)
- Background refresh includes share probes alongside primary OneDrive probe

Validate: Add share → appears in tree, indexes, browsable. Rename in Settings. Create shortcut/playlist from share content → plays correctly. Mark share-based favorite offline → downloads and plays without connectivity. Remove share → affected favorites count shown, healing runs. Denied share → ⚠ icon, tracks grey out, error in Settings. Share failures don't disrupt primary OneDrive. Full cycle on mobile.

It will be hard to validate the "heal" algorithm. I want this covered by unit tests and synthetic data. It will also be hard to exercise "denied" scenarios. It would be good to see 


## Milestone 15: Search

Full-text search over the music library, favorites, and folders.

- Search icon 🔍 on the OnePlay Music title row, enters search mode with auto-focus on edit. Exits select mode if active.
- Tree state restored on exit
- Live search on every keystroke, incremental optimization, with results in correct order, capped.
- Search timing logged and checked against 300ms target.
- Only available (non-greyed-out) tracks appear in results; folders and favorites omitted if all their immediate children are unavailable.
- Tapping a result exits search and navigates to it in the tree, playing if it's a track. Path disambiguation if multiple paths.
- Search state (filter text, scroll position) restored across open/close within same session
- Search button hidden until the index is loaded (same as the tree itself).

Validate: Open search, type a query, results appear instantly. Multiword match works. Tap a track result → navigates to it in the tree and plays. Tap a folder → navigates. Tap a favorite → navigates. Exit search → tree state fully restored (same folder, same scroll position). Search while offline → only cached/available items shown. Cap at 500 results visible with indicator. Re-open search → previous query and scroll position preserved. Performance: log search time, confirm < 300ms on full library.


## Milestone 16: Polish

Miscellaneous cleanup items. We'll plan and implement each one individually.

- Timer mode. Add "timer" to the mode selector in the expanded playback area. Then we have to implement the player aspects. The tricky thing is that timer will allow tracks to advance to the next track if there's still time remaining, but they might cause playback to be paused part way through the track if time runs out.
- Loading. Sometimes we get stuck in "Loading..." indefinitely. We should never get stuck indefinitely: either show user a failure + remediation, or complete.
- Change design from "tapping on favorite icon shows popup" to "only way to get popup is by long-holding and then tap the right hand action button"
- Indexing. Sometimes it fails, and it's not clear what next. Must retry better and show failures better.
- For carplay, I believe we need to expose more media information via MediaSession APIs? I want my car to be able to see the current track name, and for next/prev buttons to work. Also, in iPhone when we swipe down to see the command-center, I wonder MediaSession will make this richer?
- Dark Theme, accessible from the Settings dialog. I bet there are a lot of hard-coded colors.
- Rename the app to "OnePlay Music". I've created a new app registration on the Azure developer portal, with client-id e4adae2b-3cf8-4ce8-b59f-d341b3bacbf6 and redirect URIs for localhost and `https://unto.me/oneplay/music/` (plus `/index.html`).
- Refactor any files longer than 800 lines
- Solve "async URLs"
- Comprehensive error audit: what error conditions are there? (especially network errors). Are they being displayed+logged? How can the user act/recover for each?

Validate: Timer mode cycles correctly in the mode selector and pauses playback mid-track when time expires. Tracks auto-advance if time remains. MediaSession API: current track name, artist/album (if available) appear in iPhone Control Center and CarPlay; hardware next/prev buttons advance tracks. Dark theme: toggle in Settings, all screens render correctly (tree, expanded controls, scrubber, settings, modals, select mode) with no hard-coded light colours leaking through. Theme persists across restarts. Error audit: trigger network failures, expired auth, missing tracks — each shows a user-visible message with a recovery path, and logs to console.
