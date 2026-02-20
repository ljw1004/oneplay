# PLAN-M16-timer

## Title
Milestone 16: Timer Mode (Non-Fragment, Blob-First)

## Summary
Implement `timer` playback mode without media fragments. Timer behavior is enforced in playback control logic using wall-clock checks and playback events, so it works consistently for streamed URLs and offline blob URLs.

This plan explicitly rejects fragment-based timer enforcement (`#t=...`) for production logic because iPhone PWA playback fails on blob fragments (`NotSupportedError`, code 9), and blob playback is a core app path.

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


## Scope
- In scope:
  - Add `timer` to playback mode cycle and persistence.
  - Implement timer run lifecycle in `playback.ts`.
  - Wire timer duration setting from `index.ts`/settings into playback.
  - Add integration tests for timer behavior and regressions.
  - Remove temporary startup timer-fragment test harness.
- Out of scope:
  - Error audit, CarPlay/media session, dark theme, popup interaction redesign, rename/app registration changes.

## Locked Product Behavior
1. Timer uses wall-clock elapsed time when playing.
2. If timer expires mid-track and callbacks are available, pause immediately and keep position.
3. Timer mode may auto-advance to next track while time remains.
4. `end-of-track` means finish the current track and stop before advancing.
5. Changing timer duration while timer is active applies immediately from now.
6. If user pauses and later presses play in timer mode, timer re-arms to full selected duration from that play moment.
7. If timer already expired and user presses play in timer mode, timer re-arms to full duration.
8. User `next-track`, `prev-track`, and seek/scrub interactions in timer mode re-arm the timer from the interaction moment.

## Prerequisite Cleanup (must happen first)
1. Remove temporary startup blob-fragment test override from `index.ts`:
   - Remove constants `TIMER_FRAG_TEST_SOURCE_URL`, `TIMER_FRAG_TEST_FRAGMENT`.
   - Remove `enterTimerFragmentStartupTestModeAndStartPlayback()`.
   - Remove early return `if (enterTimerFragmentStartupTestModeAndStartPlayback()) return;` from `onBodyLoad()`.
2. Remove deploy packaging of test asset in `package.json` (`timer-frag-test-source.mp3`).
3. Remove local test asset file `timer-frag-test-source.mp3` from repo root.
4. Confirm normal offline-first startup flow is restored.

## Public API / Type Changes
1. In `playback.ts`:
   - `PlaybackMode` becomes:
     - `'one' | 'timer' | 'all' | 'repeat' | 'shuffle'`
   - `MODES` order:
     - `['one', 'timer', 'all', 'repeat', 'shuffle']`
2. Add to `Playback` interface:
   - `setTimerDuration(duration: TimerDuration): void`
3. In `index.ts` wiring:
   - After `createPlayback(...)`, call `playback.setTimerDuration(timerDuration)`.
   - In settings `onTimerChange`, after localStorage write, call `playback?.setTimerDuration(next)`.

## Playback Design (Decision Complete)

### Timer State in `playback.ts`
1. Add state:
   - `timerDurationSetting: TimerDuration = '30m'`
   - `timerDeadlineMs: number | undefined`
2. No fragment state, no ticker interval state, no URL rewriting for timer.
3. Deadline is only meaningful in numeric timer durations while playback is active.

### Helper Functions
1. `timerDurationMs(d: TimerDuration): number | undefined`
   - `15m|30m|45m|60m` map to ms.
   - `end-of-track` returns `undefined`.
2. `armTimerFromNowIfPlaying(reason: string): void`
   - Preconditions: `playbackMode === 'timer'` and `audioEl.paused === false`.
   - Numeric duration: `timerDeadlineMs = Date.now() + ms`.
   - `end-of-track`: `timerDeadlineMs = undefined`.
3. `clearTimerDeadline(reason: string): void`
   - `timerDeadlineMs = undefined`.
4. `isTimerExpiredNow(nowMs: number): boolean`
   - Numeric only: `timerDeadlineMs !== undefined && nowMs >= timerDeadlineMs`.
   - For `end-of-track`, always false here (handled only in `ended`).
5. `expireTimerAndPauseInPlace(reason: string): void`
   - Clear deadline.
   - `audioEl.pause()`.
   - Keep current track/folder/mode unchanged.

### Event-Driven Expiry Checks (no `setInterval` ticker)
1. `timeupdate`:
   - If `playbackMode === 'timer'` and numeric duration and expired now, call `expireTimerAndPauseInPlace('timeupdate')`.
2. `ended`:
   - If `playbackMode !== 'timer'`, existing logic unchanged.
   - If timer duration is `end-of-track`, stop and do not advance.
   - If numeric and expired now, stop and do not advance.
   - Else timer behaves like `all` for next-track selection (sequential, no wrap).
3. `play` event:
   - If `playbackMode === 'timer'`, arm timer from now.
4. `pause` event:
   - If `playbackMode === 'timer'`, clear deadline.
5. `visibilitychange` to visible:
   - If `playbackMode === 'timer'` and numeric duration and expired now:
     - If audio still playing, pause in place.
     - If already paused, keep paused and clear deadline.
   - This is a backstop for coarsened/missed background callbacks.

### Mode Changes
1. Mode label click handler:
   - On entering timer while currently playing: arm from now.
   - On entering timer while paused: do not arm until `play` event.
   - On leaving timer: clear deadline.
2. Preserve existing shuffle transition behavior (`prevMode === 'shuffle'` refresh logic).

### Duration Changes at Runtime
1. `setTimerDuration(next)` updates `timerDurationSetting`.
2. If currently in timer mode and playing, immediately re-arm from now using new duration.
3. If paused, do not arm until next play.

### Restore and Per-Favorite Mode
1. Restoring mode `timer` from `mm_playback` or per-favorite mode only sets mode.
2. Timer deadline is not persisted.
3. First subsequent play in timer mode arms a fresh full duration.
4. If per-favorite mode restores to timer in `playFolder`/`playTrack`, no special arm call required beyond normal `play` event path.

## Invariants
1. Timer logic never mutates URL sources for cutoff enforcement.
2. Blob and streamed playback paths use identical timer decisions.
3. Timer mode ordering is sequential (`all`-like), never shuffle.
4. Pause always clears active timer deadline; play in timer mode always re-arms from now.
5. Timer deadline is runtime-only and never persisted.

## Test Plan

### Integration (`test/integration/tree.test.cjs`)
1. Mode cycle includes timer:
   - From `all`, expected sequence: `repeat -> shuffle -> one -> timer -> all`.
2. Timer numeric mid-track stop:
   - Start timer playback.
   - Monkeypatch `Date.now` to past deadline.
   - Trigger/wait for `timeupdate` and assert paused in same track.
3. Timer numeric auto-advance while remaining:
   - Keep `Date.now` before deadline.
   - Trigger `ended` and assert next track starts.
4. Timer `end-of-track` behavior:
   - Set settings duration `end-of-track`.
   - Trigger `ended` and assert no next-track transition.
5. Duration change immediate apply:
   - Start timer playback with long duration.
   - Change to shorter duration.
   - Move `Date.now` beyond new deadline and assert stop.
6. Pause/resume semantics:
   - Start timer playback, pause, wait/advance clock, resume.
   - Assert play re-arms full duration (not residual).
7. Restore semantics:
   - Restore with timer mode, verify first play arms and runs timer.
8. Non-timer regression:
   - Confirm `all`, `repeat`, `shuffle`, `one` keep current behavior.
9. Interaction re-arm semantics:
   - In timer mode, verify `next-track` and `prev-track` re-arm a fresh full timer window.
   - In timer mode, verify seek/scrub interactions re-arm a fresh full timer window.

### Unit tests (if extracted helpers are pure)
1. `timerDurationMs` mapping.
2. `isTimerExpiredNow` logic.
3. Mode guard behavior for `end-of-track` vs numeric deadline checks.

## Validation Workflow
1. `npm run build`
2. `npm run test:unit`
3. `npm run deploy`
4. Fast integration pass with timeout and `/tmp/mymusic-test.log`
5. Full local integration suite
6. Full production integration suite (`MYMUSIC_TEST_URL=https://unto.me/mymusic/`)

## Assumptions and Defaults
1. No countdown UI is required in M16 timer mode.
2. Timer precision in iPhone background is best-effort due callback coarsening.
3. If iOS suppresses callbacks while backgrounded, `ended` and `visibilitychange` backstops handle overdue expiry when events resume.
4. Global timer duration remains a settings value; per-favorite state stores mode only.

## Validation
- Date: February 19, 2026
- Peer review:
  - Claude review (`/tmp/m16-review-result.md`) reported no correctness issues or regressions for timer mode; residual risks noted were iOS background callback coarsening and device clock changes.
- Commands run:
  - `npm run build` — pass
  - `npm run test:unit` — pass (95 passed, 0 failed)
  - `npm run deploy` — pass
  - `timeout 45 npm test -- "timer"` — pass (9 passed, 0 failed). Log: `/tmp/mymusic-test.log`
  - `npm test` (localhost) — pass (78 passed, 0 failed, ~34s)
  - `MYMUSIC_TEST_URL=https://unto.me/mymusic/ npm test` (production) — pass (78 passed, 0 failed, ~29s)
- Timer-specific integration coverage validated:
  - Numeric mid-track expiry pause-in-place
  - Numeric auto-advance before deadline
  - `next` and `prev` interaction re-arm
  - Seek interaction re-arm
  - `end-of-track` stop behavior
  - Runtime duration change re-arm
  - Pause/resume re-arm
  - Restore-to-timer first-play arm
