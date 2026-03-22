# Project Milestones and Validation

OnePlay Music is a mobile-first single-page PWAs: music/ indexes a user's OneDrive music folder and plays it back with full offline support.

## HOW TO PLAN A MILESTONE

If the user asks you to plan a milestone, these are the steps to take.

1. Read all of PLAN.md (the current document) to learn about the milestone, in the context of past and future milestones. This document lists only the bare essential deliverables and validation steps for each milestone.
2. Read all prior PLAN_M{n}.md milestone documents as well
3. Ask any important initial clarifying questions about the milestone you might have.
  - If you're not asking any questions at all for the entire planning, something's wrong! I know that this file isn't fully specified. There must be important things for you to clarify.
  - It's better to eliminate unknowns in the milestone by discovering facts, not by asking the user. Do not ask questions that can be answered from the repo or system (for example, "where is this struct?" or "which UI component should we use?" when exploration can make it clear). Only ask once you have exhausted reasonable research.
     - **Discoverable facts** (repo/system truth): explore first: Before asking, run targeted searches and check likely sources of truth (configs/manifests/entrypoints/schemas/types/constants). Ask only if: multiple plausible candidates; nothing found but you need a missing identifier/context; or ambiguity is actually product intent. If asking, present concrete candidates (paths/service names) + recommend one.Never ask questions you can answer from your environment (e.g., "where is this struct").
    - **Preferences/tradeoffs** (not discoverable): ask early. These are intent or implementation preferences that cannot be derived from exploration. Provide 2–4 mutually exclusive options + a recommended default. If unanswered, proceed with the recommended option and record it as an assumption in the final plan.
  - When you ask a question, the user doesn't have your context. You must phrase your questions so as to include FULL context, tradeoffs, background, explanation of terms. Don't use jargon. A good question is typically 2-5 sentences long.
  - Questions should where possible offer multiple choices, and your recommendation.
  - Questions should be meaningful; don't include filler choices that are obviously wrong or irrelevant.
  - You SHOULD ask many questions, but each question must: materially change the spec/plan, OR confirm/lock an assumption, OR choose between meaningful tradeoffs. And it must not be answerable by research.
  - Keep asking until you can clearly state: goal + success criteria, audience, in/out of scope, constraints, current state, and the key preferences/tradeoffs.
  - Bias toward questions over guessing: if any high-impact ambiguity remains, do NOT plan yet—ask.
  - Once intent is stable, proceed with implementation planning...
  - Once intent is stable, keep asking until the spec is decision complete: approach, interfaces (APIs/schemas/I/O), data flow, edge cases/failure modes, testing + acceptance criteria, rollout/monitoring, and any migrations/compat constraints.
4. Research milestone-relevant aspects of how `codex app-server` works and how to use it. These are your resources:
   - Read the official documentation for `codex app-server` at fbsource/third-party/codex/main/codex-rs/app-server/README.md
   - Read the official client at fbsource/third-party/codex/main/codex-rs/app-server-test-client/README.md
   - Read as needed the source code implementation of `codex app-server` should we have questions about how it works, at fbsource/third-party/codex/main/codex-rs/app-server
   - Reverse-engineer as needed OpenAI's Codex extension for VSCode, should we have questions about how they use `codex app-server`. The extension is stored in vsix/vsix.extension.js (for their extension) and vsix/vsix.index.js (for their webview). A user can download a fresh version by running scripts/fetch_vsix.sh (but an AI can't due to sandbox internet restructions).
5. Research milestone-relevant aspects of how ClaudeMode does the work, starting from xplat/vscode/modules/dvsc-core/src/extension-host/casdk/ClaudeAgent.ts
6. Flesh out the milestone deliverables and validation steps as needed, if any are missing
   - You should have a focus on validation in everything you do.
   - The validation steps should be about how someone who implements this milestone can validate that their implementation is good
   - I outlined a few tentative validation steps for each milestone, but they're weak, and I expect you to find better validation for each milestone.
   - Make sure to include the basics: typechecker clean and `arc lint` clean
7. Develop your plan for the milestone and write it to a new PLAN_M{n}.md file.
   - A great plan is very detailed—intent- and implementation-wise—so that it can be handed to another engineer or agent to be implemented right away. It must be **decision complete**, where the implementer does not need to make any decisions. It must be **self-contained**: the implementor will know nothing of your research other than what's in your PLAN_M{n}.md file.
   - The plan must include validation steps, i.e. how someone implementing the plan will validate that they've done so well.
8. Are there better-engineering blockers? If so, bail!
   - The user always wants things done the right way, with clean engineering, good architecture. Never any shortcuts. It's normal that your plan work discovers a structural architectural problem that must be fixed before your plan can proceed.
   - If the architectural problem is small enough to solve, then include that as a phase in your plan. But if it's a major one, worthy of a whole separate plan in its own right, then you should bail, tell the user the problem, and leave them to insert a new milestone specifically for that better engineering.
   - The user is always delighted to hear about better engineering.
9. Present your PLAN_M{n}.md file to Claude and ask for its feedback.
   - If you couldn't get Claude to run for whatever reason, the user wants you to abort and report what's wrong.
   - You can trust Claude has already read AGENTS.md, and is able to do its own autonomous research.
   - If Claude found no problems with your plan, you may proceed.
   - Otherwise, you must address the issues Claude found: (1) if you agree with the issues, then update your plan, (2) if you disagree with Claude's findings, then update your plan to defend your perspective better.
   - Keep iterating with Claude until you no longer make changes (either because you've taken on Claude's feedback from past rounds, or because your plan no successfully defends its positions so Claude accepts them). However, if you take more than 10 rounds, then somethig is wrong, so stop and let the user know.
   - We aren't looking for "blocker vs non-blocker" decisions. Instead for every suggestion from Claude you must evaluate "will this improve my plan? if so then modify your plan, and if not then pre-emptively defend (in the plan) why not". And if you made modifications or defenses, then circle back with Claude again.
   - Do NOT reference previous rounds when you invoke it: Claude does best if starting from scratch each round, so it can re-examine the whole ask from fundamentals. Note that each time you invoke Claude it has no memory of previous invocations, which is good and will help this goal! Also, avoid asking it something like "please review the updated files" since (1) you should not reference previous rounds implicitly or explicitly, (2) it has no understanding of what the updates were; it only knows about the current state of files+repo on disk.
10. Ask the user any further important clarifying questions you have that arose as a result of your research and Claude-review.
   - Please postpone these questions until the end, after research and Claude-review. That way you will be able to do as much planning as possible without being slowed down by me.
   - Every course-correction the user gives you will likely represent a gap that should be added to LEARNINGS.md or ARCHITECTURE.md. And similarly for many clarifying questions. Please update with these learnings. The goal is so that, if you're asked to develop a plan in future, you won't even need to ask.
   - Please be careful to follow the "learnings decision tree" -- LEARNINGS.md for durable engineering wisdom, ARCHITECTURE.md for things that will apply to CodexAgent.ts in its finished state, PLAN_M{n}.md for milestone-specific notes
11. Present the plan for user review and signoff.
   - First, double-check that it is a completely self-contained handoff document.

Please use the following format for your PLAN_M{n}.md files:
```
# M{n} plan: {title}

## Summary
{brief summary of deliverables+validation for this milestone from PLAN.md, augmented as you see fit}

## HOW TO EXECUTE A MILESTONE
{please include verbatim the content of "how to execute" section of PLAN.md, for the benefit of readers who will read PLAN_M{n}.md but won't read PLAN.md itself

## Locked user decisions
{write out all the decisions that the user made}

## PLAN
{... your plan goes here, in whatever format you see fit. You might include API, algorithms, files changed, testing}

## BETTER ENGINEERING INSIGHTS + BACKLOG ADDITIONS
{what architectural insights you learned, about our codebase or about how things should be done, plus what better engineering has been deferred or will be needed in future}

## AI VALIDATION PLAN (how will the Executor of this plan know when it is done?)
{... what AI will do to validate its work, the "definition of done". This may include typechecking it, running it, running unit and integration tests, creating new tests}

## AI VALIDATION RESULTS (how did the Executor show that it was done?)
{this will be filled during execution}

## USER VALIDATION SUGGESTIONS
{A walkthrough of steps the user can follow, so they can see what you have built}
```

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
3. Review your own code. Also, ask Claude to review your work
   - You will need to provide it contect: your plan document PLAN_M{n}.md, and tell it which files or functions you've worked on. Ask it also to review your validation steps.
   - If Claude found no blockers or problems with your work, you may proceed. Do static checking (formatting, eslint, typechecking). If you need any fixes, static check again to make sure it's clean.
   - If you couldn't get Claude to run for whatever reason, the user wants you to abort and report what's wrong.
   - Keep iterating with Claude until you no longer make changes (either because you've taken on Claude's feedback from past rounds, or because your plan no successfully defends its positions so Claude accepts them). However, if you take more than 10 rounds, then somethig is wrong, so stop and let the user know.
   - We aren't looking for "blocker vs non-blocker" decisions. Instead for every suggestion from Claude you must evaluate "will this improve my code? if so then modify your code, and if not then pre-emptively defend (in code comments) why not". And if you made modifications or comments, then circle back with Claude again.
   - Do NOT reference previous rounds when you invoke it: Claude does best if starting from scratch each round, so it can re-examine the whole ask from fundamentals. Note that each time you invoke Claude it has no memory of previous invocations, which is good and will help this goal! Also, avoid asking it something like "please review the updated files" since (1) you should not reference previous rounds implicitly or explicitly, (2) it has no understanding of what the updates were; it only knows about the current state of files+repo on disk.
4. After implementation, do a "better engineering" phase
   - Clean up LEARNINGS.md and ARCHITECTURE.md. If any information there is just restating information from other files then delete it. If it would belong better elsewhere, move it. Please be careful to follow the "learnings decision tree" -- LEARNINGS.md for durable engineering wisdom, ARCHITECTURE.md for things that will apply to CodexAgent.ts in its finished state, PLAN_M{n}.md for milestone-specific notes
   - You will have several Claude review tasks to do, below. You must launch all the following Claude review tasks in parallel, since they each take some time: prepare all their inputs, then execute them all in parallel. You should start addressing the first findings as soon as you get them, rather than waiting for all to be consolidated. You can be doing your own review while you wait for Claude.
   - (1) Review the code for correctness. Also ask Claude to evaluate this.
   - (2) Validate whether work obeys the codebase style guidelines in AGENTS.md. Also ask Claude to evaluate this. The user is INSISTENT that they must be obeyed.
   - (3) Validate whether the work obeys each learning you gathered in LEARNINGS.md. Also ask Claude to evaluate this. (A separate instance of Claude; it can't do too much in one go).
   - (4) Validate whether the work has satisfied the milestone's goals. Also ask Claude to evaluate this.
   - (5) Check if there is KISS, or consolidation, or refactoring that would improve quality of codebase. Also ask Claude the same question.
   - If you make changes, they'll need a pass of static checking (formatting, eslint, typechecking), and again to make sure it's clean.
   - You might decide to do better engineering yourself. If not, write notes about whats needed in the "BETTER ENGINEERING INSIGHTS" section of the plan.
   - Tell the user how you have done code cleanup. The user is passionate about clean code and will be delighted to hear how you have improved it.
5. Upon completion, ask for user review. Tell the user what to test, what commands to use, what gestures to try out, what to look for


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


