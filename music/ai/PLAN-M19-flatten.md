# M19 plan: Show OneDrive’s contents at home

## Summary

Give a listener with a single OneDrive library direct access to its folders and loose tracks from **OnePlay**. The hosted PWA and the bundled iOS app use the same tree. The acceptance case is to open Jazz, pin a folder, and add the first favorite or share without losing the listener’s place. [Todo entry](../../TODO.md#show-onedrives-contents-at-home-in-music)

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
   - If GPT Sol 6.2 High found no blockers or problems with your work, you may proceed. Do static checking (formatting, eslint, typechecking). If you need any fixes, static check again to make sure it's clean.
   - If you couldn't get GPT Sol 6.2 High to run for whatever reason, the user wants you to abort and report what's wrong.
   - Keep iterating with GPT Sol 6.2 High until you no longer make changes (either because you've taken on GPT Sol 6.2 High's feedback from past rounds, or because your plan no successfully defends its positions so GPT Sol 6.2 High accepts them). However, if you take more than 10 rounds, then somethig is wrong, so stop and let the user know.
   - We aren't looking for "blocker vs non-blocker" decisions. Instead for every suggestion from GPT Sol 6.2 High you must evaluate "will this improve my code? if so then modify your code, and if not then pre-emptively defend (in code comments) why not". And if you made modifications or comments, then circle back with GPT Sol 6.2 High again.
   - Do NOT reference previous rounds when you invoke it: GPT Sol 6.2 High does best if starting from scratch each round, so it can re-examine the whole ask from fundamentals. Note that each time you invoke GPT Sol 6.2 High it has no memory of previous invocations, which is good and will help this goal! Also, avoid asking it something like "please review the updated files" since (1) you should not reference previous rounds implicitly or explicitly, (2) it has no understanding of what the updates were; it only knows about the current state of files+repo on disk.
4. After implementation, do a "better engineering" phase
   - Clean up LEARNINGS.md and ARCHITECTURE.md. If any information there is just restating information from other files then delete it. If it would belong better elsewhere, move it. Please be careful to follow the "learnings decision tree" -- LEARNINGS.md for durable engineering wisdom, ARCHITECTURE.md for things that will apply to CodexAgent.ts in its finished state, PLAN_M{n}.md for milestone-specific notes
   - Launch the five GPT Sol 6.2 High specialists below in parallel on the same revision. Read the KISS findings alongside the other reports before deciding which suggestions warrant a change. Give the KISS reviewer the accepted product trade-offs and ask which proposed guarantees or existing machinery can be dropped.
   - (1) Review the code for correctness. Also ask GPT Sol 6.2 High to evaluate this.
   - (2) Validate whether work obeys the codebase style guidelines in AGENTS.md. Also ask GPT Sol 6.2 High to evaluate this. The user is INSISTENT that they must be obeyed.
   - (3) Validate whether the work obeys each learning you gathered in LEARNINGS.md. Also ask GPT Sol 6.2 High to evaluate this. (A separate instance of GPT Sol 6.2 High; it can't do too much in one go).
   - (4) Validate whether the work has satisfied the milestone's goals. Also ask GPT Sol 6.2 High to evaluate this.
   - (5) Check if there is KISS, or consolidation, or refactoring that would improve quality of codebase. Also ask GPT Sol 6.2 High the same question.
   - If you make changes, they'll need a pass of static checking (formatting, eslint, typechecking), and again to make sure it's clean.
   - You might decide to do better engineering yourself. If not, write notes about whats needed in the "BETTER ENGINEERING INSIGHTS" section of the plan.
   - Tell the user how you have done code cleanup. The user is passionate about clean code and will be delighted to hear how you have improved it.
5. Upon completion, ask for user review. Tell the user what to test, what commands to use, what gestures to try out, what to look for

## Locked user decisions

- Fold the account into **OnePlay** exactly when it is the only root. Folder pins and connectivity do not affect eligibility. Tapping **OnePlay** in normal browsing opens the account’s contents. Inside Jazz the trail reads **OnePlay › Jazz**.
- Show a single spinner when either the app sync spinner or the account reindex spinner would be visible. Otherwise show the account’s existing partial-download arrow when it qualifies. The usual rightmost-arrow rule and Select-mode spinner visibility still apply.
- When the first share or favorite appears, home shows the top-level entries. Inside Jazz, keep the folder open with **OnePlay › OneDrive › Jazz**. Removing the last other root reverses the presentation. The change is cosmetic and applies to the tree’s home list and breadcrumbs.

## Plan

1. **Derive home from the existing roots.** In the normal render path in `tree.ts`, after its existing startup/search guard, inspect the sole entry when `roots.size === 1`. A root of type `onedrive` qualifies. The roots map already represents cached favorites and connected shares, including unavailable shares. Let `resolveFolder` use the sole account’s key for an app-root selection, taking its existing account walk and sort. Hide the empty-favorites hint here. Keep the current hint on the ordinary root list. Document the visible rule in [DESIGN.md](DESIGN.md).
2. **Keep one navigation state.** The selected home is the existing app-root path. Its displayed folder while folded is the account path. After folder resolution, normalize a bare sole-account selection to home before the existing path-correction notification. This covers restore, a search or playback destination, and broken-path fallback. All deeper paths stay as they are. Use the actual displayed folder for child paths and availability checks. Use the existing `previousPath` slot for the last displayed folder’s scroll comparison and save. On first render, restore the displayed folder’s saved offset directly. This also restores folded home after a reload. Keep playback reveal on its current selection-and-resolution path since Search can defer tree rendering while roots change. A roots refresh simply renders the current selection.
3. **Build one visible root crumb.** For a folded trail, render the account prefix as the existing OnePlay header and omit the extra prefix. Its physical path supplies the existing folder badge lookup and deeper-arrow suppression. Its app-root presentation supplies Settings, the debug label and warning, the selected/current-location treatment and the existing reserved separator. In the existing folder-click handler the merged crumb targets its app-root prefix. Compute breadcrumb spinner visibility once from the existing Select guard and activity flags, and use it for the spinner and the merged crumb’s badge priority. Children and deeper breadcrumbs keep their full paths for selection, playback, search, and animation.
4. **Honor the first-favorite transition.** Shortcut and playlist Create currently navigate to the newly created favorite after saving. Share the two Create handlers’ existing save, close, exit and navigate sequence in `select.ts`. Use the tree’s sole-account lookup immediately before `await favorites.add(...)`, since the save publishes new roots before it returns. Skip the automatic navigation only when that pre-save lookup found a sole account. Adding a share or receiving a synced favorite already refreshes the roots.

## Better engineering insights and backlog additions

The implementation keeps the existing OnePlay breadcrumb and its navigation path in both layouts. A sole account supplies its indicators and home listing. The tree uses the last displayed folder to restore scrolling and reveal tracks. Opening Search hands the viewport to the results list. Both Create dialogs share the same save-and-exit action. Switching between the source list and the account contents follows the existing scroll policy for navigating between different lists. The membership transition preserves the selected location. Favorites storage and cloud recovery retain their existing write policy. The two players ship the same Create handlers. Browser tests exercise both dialogs, and bundled WebKit checks the native-backed membership publication.

## AI validation plan

- Use an isolated Playwright library with a top-level folder and a loose track. Exercise home, folder, return, selection and playback reveal. Check visible names, one current breadcrumb, and the full account key in child paths. Check a saved bare account route and a deep folder. Return from Jazz and reload folded home with a nonzero account-list scroll offset.
- Create a first shortcut from home and a first playlist from inside Jazz in separate fixtures. Add and remove a share through the roots update. Check the ordinary multi-root view and the return to folded home. A folder pin alone keeps home folded. Use existing fixtures and correct tests or helpers that unconditionally click OneDrive, keeping explicit multi-root coverage.
- With a pinned descendant, check the dotted arrow at home and its suppression by a deeper badge. Exercise sync only, reindex only, both, and neither. Check that the spinner wins only on the merged crumb, the arrow returns afterward, and Select hides the spinner. Capture folded and expanded mobile screenshots.
- From `music/`, run `npm run build` and `npm run test:unit`. Deploy before Playwright with `npm run deploy`. Run `npm test` against localhost and with `ONEPLAY_MUSIC_TEST_URL=https://unto.me/oneplay/music/` against production. Announce and monitor `/tmp/oneplay-music-test.log` with the repository’s timeout workflow. Verify the bundled UI in iOS WebKit and install the verified build on LuPhone13.

## AI validation results

The 34 shell assets on production build 351 match signed iOS build 67 after accounting for the platform build label and source-map annotations. All 177 unit tests passed. All 117 Playwright cases passed on localhost (156.7 s) and production (285.8 s). Both M19 Playwright cases passed in Chromium and in persistent WebKit against production. Each used a disposable library. They exercised first and later Create, loose-track reveal, first and last share, indicator priority, Search, and scroll restoration from both home path forms. Mobile WebKit screenshots show the folded and expanded trails.

LuPhone13 received build 67 in place. Device inventory confirmed version 1.0 (67) under the existing bundle identifier. The bundled WebKit test opened a folder directly from home, pinned 500 tracks in a 30,000-track library and verified that adding the first playlist expanded the breadcrumb in place. Two folder taps during these downloads took 5 ms on the simulator. The iOS suite passed 61 tests and skipped the opt-in live-account test. No personal playlists or accounts were used as test fixtures.

Five rounds of GPT Sol 6.2 High specialist review each included a dedicated KISS reviewer. The final round retained the shared roots lookup, existing OnePlay navigation path and common Create action. If root membership changes while Search owns the viewport, closing Search restores the newly visible list using its own saved offset. M19 specifies the selected location across membership changes.

A separate cold-reload check saved the bottom of the same 43-track library in both layouts. With playback restored, each reopened at 1,228 px from a saved 1,294 px. Startup lays out the tree before the footer reappears. Coordinating those two restorations is a pre-existing player-wide issue.

## User validation suggestions

Open Jazz from **OnePlay**, then tap **OnePlay** to return. Mark Jazz available offline and watch the root arrow during a refresh. Add the first favorite at home, or connect the first share while browsing Jazz, and check the resulting list and trail.
