# M15 Search Plan (Approved After Round-6 Review)

## Summary
Implement M15 search with a synchronous single-walk query engine, hard cap at 500 accepted results, and tree-integrated search mode UI.

Spec is in DESIGN.md lines 329 to 361

## HOW TO EXECUTE A PLAN

1. Implement the plan
   - Start by writing out the plan into the repository
   - Use teams/swarms. Even if it's not parallelizable, still use a team.
   - Each subagent can be told about the milestone's plan file to guide their work, if appropriate.
   - You should check your implementation with AI autonomous validation and testing.
   - The hope is that implementation can be done with a minimum of human interaction, preferably none at all.
   - Once it is complete, add a "Validation" section to the bottom of the plan showing how you have validated it and what were the results.
2. Ask the other agent for review of your implementation.
   - You will need to provide it contect: your plan document PLAN-Mn.md, and tell it which files or functions you've worked on. Ask it also to review your validation steps. Do *NOT* tell it about previous chats you've had with it: it should approach with a clean mind.
   - Again, codex is my trusted senior engineer, and I want you to get Codex signoff.
3. After implementation, do a "review" phase
   - Clean up LEARNINGS.md. If any information there is just restating information from other files (AGENTS.md, SANDBOX.md) then delete it. If it would belong better elsewhere, move it.
   - Ask your own subagent and also other agent to validate whether the changes have satisfied their goals
   - Ask your own subagent and also other agent for code review
   - Ask your own subagent and also other agent if there is KISS, or consolidation, or refactoring that would improve quality of codebase
   - Tell the user how you have done code cleanup. The user is passionate about clean code and will be delighted to hear how you have improved it.
4. Upon completion, ask for human review. Tell the user what to test, what commands to use, what gestures to try out, what to look for

## Locked Product Decisions
1. Include shares in search scope.
2. Hard-stop at 500 accepted results.
3. Start naive now; no chunking/prefix optimization unless timing evidence and explicit approval.
4. Do not recursively traverse nested `FavRef` for search hits.
5. Dedup physical folders/tracks globally; winner is first accepted encounter.
6. Opening search exits select mode and collapses expanded playback.
7. Empty query returns zero results.
8. Search query and search-results scroll persist only in-memory for the current page lifecycle.

## Public API / Types
1. Add `search.ts`.
2. Export `runSearchSingleWalk(options)` returning `{ results, capped, elapsedMs }`.
3. `options` include `roots`, `favorites`, `query`, `maxResults`, `deniedRootKeys`, `evidenceState`, and `downloadedTrackKeys: ReadonlySet<string>`.
4. `SearchResult` includes `kind`, `name`, and full logical `path` (`FolderPath` rooted at `['MyMusic', rootKey, ...]`), plus optional physical identity fields where needed.
5. Extend `tree.ts` interface with `openSearchMode`, `closeSearchMode`, `setSearchResults`, `isSearchModeOpen`, and callbacks `onSearchOpen`, `onSearchClose`, `onSearchQueryChange`, `onSearchResultClick`.

## Search Algorithm
1. If query is empty after trim, return zero results immediately.
2. Normalize query into lowercase terms; each term must be substring-matched in result name (AND semantics).
3. Walk in this order per query: top-level favorites, then OneDrive roots, then share roots.
4. Favorites resolve ItemRefs against full `RootsMap` (accounts + shares).
5. Denied share handling:
   - Skip denied share root subtrees in root walks.
   - Skip favorites ItemRefs when `sourceRootKey` is denied.
   - If needed for legacy ref, use resolved root key and skip when denied.
6. Do not recurse through nested `FavRef` during hit traversal.
7. Immediate-child availability rule:
   - Shortcut: immediate children are target folder immediate children.
   - Playlist: immediate children are direct members.
   - Playlist `FavRef` child counts available iff referenced favorite ID exists.
8. Track availability rule:
   - Track unavailable if denied-root path.
   - In terminal evidence states, track must have `driveId:itemId` in `downloadedTrackKeys`.
9. Dedup keys:
   - Track key: `driveId:itemId`.
   - Folder key: `driveId:itemId`.
   - Favorite key: favorite ID.
10. Only accepted results consume dedup keys.
11. Use three buckets during scan: favorites, folders, tracks.
12. Global cap counter across all buckets; stop entire walk when accepted count reaches 500.
13. Return bucket-ordered results: favorites, then folders, then tracks.

## Tree/UI Behavior
1. Search mode is rendered in the tree top row with `input type="search"` and close button.
2. Opening search triggers select exit and playback collapse.
3. While search mode is active, `tree.render()` early-returns to prevent clobbering search results and suppresses path-correction callbacks.
4. Closing search triggers one fresh normal render.
5. Cap indicator row uses stable selector class (for example `.search-cap-row`), is non-clickable, non-focusable, not `.tree-row`, and has no `data-path`.

## Click Behavior Contract
1. Folder/favorite hit sequence: close search, set selected path to `result.path`.
2. Track hit sequence: close search, set selected path to `result.path.slice(0, -1)`, call existing `tree.onTrackClick(result.path)`.

## Orchestration in `index.ts`
1. Maintain `searchOpen`, `searchQuery`, `searchScrollTop`.
2. Build `downloadedTrackKeys` from `downloads.getSnapshot().downloadedKeys` at query time.
3. Run search synchronously on every query change.
4. If search is open, re-run current query on relevant state changes that affect availability or roots.
5. Log per query: elapsed time, result count, capped flag; warn above 300ms.

## Testing
1. Add `test/unit/search.test.ts`.
2. Unit cases cover empty query, matching semantics, global cap, dedup correctness, excluded-does-not-consume-dedup, denied-share skipping, terminal availability from `downloadedTrackKeys`, FavRef non-recursive policy, and bucket ordering.
3. Integration cases in `test/integration/tree.test.cjs` cover open/close UX, select exit, playback collapse, hit navigation/play sequence, cap-row semantics, denied-share filtering including favorites->denied members, and terminal evidence filtering.

## Validation Workflow
1. `npm run build`
2. `npm run test:unit`
3. `npm run deploy`
4. Run integration fast pass with timeout and inspect `/tmp/mymusic-test.log`.
5. Run full local integration suite.
6. Run production integration suite with `MYMUSIC_TEST_URL=https://unto.me/mymusic/`.
7. Collect metrics from logs for query latency and `>300ms` warnings.

## Assumptions and Defaults
1. Single-walk synchronous search is the M15 implementation baseline.
2. Redundant encounters between favorites walk and share-root walk are accepted in this milestone.
3. No persistence of search state to localStorage in M15.
4. Any optimization beyond this plan is deferred and requires measured evidence plus approval.

## Validation
1. `npm run build` passed.
2. `npm run test:unit` passed (89 tests, 0 failed), including new `test/unit/search.test.ts` coverage.
3. `npm run deploy` passed, publishing latest M15 changes.
4. Fast integration pass with timeout:
   - Command: `timeout 45 npm test`
   - Log file: `/tmp/mymusic-test.log`
   - Result: 70 passed, 0 failed.
5. Full local integration suite:
   - Command: `npm test`
   - Result: 70 passed, 0 failed.
6. Full production integration suite:
   - Command: `MYMUSIC_TEST_URL=https://unto.me/mymusic/ npm test`
   - Result: 70 passed, 0 failed.
7. Search timing metrics (from runtime logs via Playwright):
   - Local (`http://localhost:5500`): `elapsedMs=6`, `results=159`, `capped=false`, `slowLogCount=0`.
   - Production (`https://unto.me/mymusic/`): `elapsedMs=6`, `results=159`, `capped=false`, `slowLogCount=0`.
8. Runtime snapshot metrics (local + production):
   - `favoriteCount=7`, roots `{ onedrive: 1, share: 1, favorite: 7 }`
   - downloads snapshot `{ downloadedKeys: 0, queuedKeys: 0, totalBytes: 0, overQuota: false, evidence: "no-evidence" }`
9. External review artifacts collected:
   - `/tmp/m15-codex-review.md`
   - `/tmp/m15-codex-review2.md`
