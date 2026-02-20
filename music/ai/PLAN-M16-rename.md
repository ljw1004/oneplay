# PLAN-M16-rename

## Title
Milestone 16: Rename to OnePlay Music + Repository Restructure for OnePlay

## Summary
Rename the app from **MyMusic** to **OnePlay Music**, switch to the new Azure app registration, cut production over to `https://unto.me/oneplay/music/`, and then restructure the repository so it can host both `music` and `video` apps with a separate `shared` code directory.

This plan is explicitly split into two gated phases:
1. Identity/runtime cutover in the current layout.
2. Directory restructure for the new OnePlay multi-app layout.

There is **no cross-app data sharing** at all.

## HOW TO EXECUTE A PLAN

1. Implement the plan
   - Start by writing out the plan into the repository.
   - Use teams/swarms. Even if it's not parallelizable, still use a team.
   - Each subagent can be told about this plan file to guide their work.
   - Validate implementation autonomously with build/tests/deploy/production verification.
   - Once complete, add a "Validation" section at the bottom with commands and results.
2. Ask another agent for review of implementation and validation.
3. After implementation, do a review phase
   - Clean up `LEARNINGS.md` (remove duplication; move content if better placed).
   - Ask for code review and simplification/refactor opportunities.
   - Tell the user what cleanups were made.
4. Upon completion, ask for human review
   - Tell the user exactly what to test manually and what to look for.

## Locked Product Decisions
1. App name becomes **OnePlay Music**.
2. Azure client ID becomes `e4adae2b-3cf8-4ce8-b59f-d341b3bacbf6`.
3. New production home is `https://unto.me/oneplay/music/`.
4. Internal root path token is hard-renamed from `"MyMusic"` to `"OnePlay Music"` now.
5. Runtime/tooling key namespaces are hard-renamed now to music-scoped OnePlay names.
6. No compatibility migration of old keys/data; cold start is intentional.
7. Two-phase gated execution (phase A then phase B), with validation at each gate.
8. Top-level directories in final structure are `music`, `video`, and `shared` (no `apps` directory).
9. `shared` is flat (`shared/*.ts`), not `shared/ts`.
10. `video` is placeholder-only in this milestone.
11. No npm workspaces.
12. All development remains in current repo (`mymusic2`) until user copies to `~/code/oneplay`.

## Hard Isolation Invariants (Music vs Video)
1. No shared localStorage keys between apps.
2. No shared IndexedDB database names between apps.
3. No shared service-worker cache prefixes between apps.
4. No shared `/tmp` test profile/log paths between apps.
5. No shared auth/session storage key namespaces between apps.
6. `shared/` may contain reusable code only; it must not define shared persisted-key constants.

## Public API / Interface / Naming Changes
1. `FolderPath` root segment changes from `"MyMusic"` to `"OnePlay Music"` throughout source/tests/docs.
2. Integration env var changes from `MYMUSIC_TEST_URL` to `ONEPLAY_MUSIC_TEST_URL`.
3. Runtime naming changes to music-scoped OnePlay conventions (examples):
   - IndexedDB DB: `oneplay-music-cache`
   - SW cache: `oneplay-music-${CACHE_VERSION}`
   - Logs key: `oneplay_music_logs`
   - Integration profile/log files: `/tmp/oneplay-music-profile`, `/tmp/oneplay-music-test.log`
4. Deploy target path changes from `/untome/mymusic` to `/untome/oneplay/music`.

## Phase A: OnePlay Music Identity + Runtime Cutover (Current Layout)

### A1. Branding and User-Facing Identity
1. Update `index.html` title and user-visible "MyMusic" labels to "OnePlay Music".
2. Update `manifest.json` `name`/`short_name` to "OnePlay Music".
3. Update docs/comments where they describe user-visible naming.

### A2. Auth Cutover
1. Replace auth `CLIENT_ID` with `e4adae2b-3cf8-4ce8-b59f-d341b3bacbf6`.
2. Keep redirect URI derivation logic path-based; ensure docs/examples reference `/oneplay/music/`.
3. Update auth-related tests/fixtures that rely on old values.

### A3. Internal Token and Namespace Rename
1. Replace all hardcoded `"MyMusic"` root token usage in domain/UI/tests.
2. Rename MyMusic-prefixed runtime identifiers to music-scoped OnePlay identifiers.
3. Rename test env var/profile/log naming to OnePlay Music naming.
4. Keep functionality unchanged except naming/cutover behavior.

### A4. Production Cutover
1. Update deploy script target to `/mnt/disks/pod7disk/www/untome/oneplay/music`.
2. Update production test default guidance to `https://unto.me/oneplay/music/`.

### A5. Documentation Updates
1. Update `ARCHITECTURE.md` invariants to the new root token/name.
2. Update `LEARNINGS.md` entries mentioning MyMusic URLs/names where applicable.
3. Update `AGENTS.md` references to production URL and test URL env var/path names.
4. Update `ai/MILESTONES.md` rename item status/context.

## Phase A Validation Gate
1. `npm run build`
2. `npm run test:unit`
3. `npm run deploy`
4. Fast integration pass with timeout; log path `/tmp/oneplay-music-test.log`.
5. Full localhost integration run.
6. Full production integration run:
   - `ONEPLAY_MUSIC_TEST_URL=https://unto.me/oneplay/music/ npm test`
7. Verify:
   - App root row displays "OnePlay Music".
   - OAuth flow works with new app registration.
   - Offline-first startup behavior unchanged.
   - No old MyMusic key namespace is read/written in new runtime.

## Phase B: Repository Restructure for OnePlay (still in current repo)

### B1. Target Directory Structure
```text
/
  AGENTS.md
  CLAUDE.md
  music/
    src/
    assets/
    test/
    ai/
    package.json
    tsconfig.json
    tsconfig.unit.json
    index.html
    manifest.json
    sw.js
    deploy-counter.txt
  video/
    src/
    assets/
    test/
    ai/
    package.json
    README.md
  shared/
    *.ts
```

### B2. Music App Move
1. Move all music `.ts` files into `music/src/`.
2. Move music PNG assets into `music/assets/`.
3. Move tests into `music/test/`.
4. Move markdown files (except root `AGENTS.md` and `CLAUDE.md`) into `music/ai/`.
5. Keep `music` app runnable/deployable with its own scripts.

### B3. Video Placeholder
1. Create `video/` with placeholder structure only.
2. Provide minimal `video/README.md` clarifying placeholder status.
3. Do not add runtime/product behavior for video in this milestone.

### B4. Shared Directory
1. Create flat `shared/` directory for reusable code files.
2. Keep it scaffold-only in this milestone (no extraction required yet).
3. Forbid data key/state constant sharing via `shared/`.

### B5. Scripts and Path Cleanup
1. Update build/test/deploy scripts to new `music/` paths.
2. Remove absolute machine-specific path assumptions where possible.
3. Ensure integration runner/log/profile defaults are OnePlay Music scoped.

## Phase B Validation Gate
1. Music app still builds/tests/deploys from new location.
2. Localhost and production integration suites pass from restructured paths.
3. Production verified again at `https://unto.me/oneplay/music/`.
4. Confirm no accidental cross-app runtime key collisions by naming audit.
5. Confirm docs and commands point to new structure.

## Risks and Mitigations
1. Risk: Hard root-token rename can break persisted path restore.
   - Mitigation: intentional cold start; no migration; verify clean startup and fresh state behavior.
2. Risk: Missed key rename causes stale data contamination.
   - Mitigation: grep audit for `MyMusic`, `mymusic`, and old env/path prefixes.
3. Risk: Script/path breakage after move.
   - Mitigation: explicit phase B validation gate before handoff.
4. Risk: SW cache confusion across old/new URL paths.
   - Mitigation: new cache prefix + deploy verification on new origin/path.

## Handoff to New GitHub Repository
1. Perform all implementation in current `mymusic2` repo.
2. After user approval, user copies content into `~/code/oneplay` (excluding `.git`, `node_modules`, `dist`, `dist-test`).
3. User creates initial commit in `https://github.com/ljw1004/oneplay.git` on `main`.

## Assumptions and Defaults
1. Cold start after rename is acceptable and desired.
2. No backward-compatibility layer for old MyMusic namespaces is required.
3. `video` remains non-functional scaffold in this milestone.
4. `shared` exists for future code reuse but stays minimally populated now.

## Validation
Validation run date: **2026-02-19**.

1. Build
   - Command: `npm run build`
   - Result: pass.
2. Unit tests
   - Command: `npm run test:unit`
   - Result: pass (`119 passed, 0 failed`).
3. Deploy
   - Command: `npm run deploy`
   - Result: pass to `https://unto.me/oneplay/music/`.
   - Notes: deploy script was hardened to create target dir if missing and force readable server perms (`--perms --chmod=Du=rwx,Dgo=rx,Fu=rw,Fgo=r`) after a real `favicon.png` 403 caused by restrictive file mode.
4. Fast integration pass (localhost)
   - Log file: `/tmp/oneplay-music-test.log`
   - Command: `timeout 45 npm test -- "settings"`
   - Result: pass (`17 passed, 0 failed`).
5. Full integration pass (localhost)
   - Log file: `/tmp/oneplay-music-test.log`
   - Command: `npm test`
   - Result: pass (`82 passed, 0 failed`).
6. Full integration pass (production)
   - Log file: `/tmp/oneplay-music-test.log`
   - Command: `ONEPLAY_MUSIC_TEST_URL=https://unto.me/oneplay/music/ npm test`
   - Result: pass (`82 passed, 0 failed`).
7. Namespace audit
   - Command: `rg -n "\\bMyMusic\\b|\\bmm_|mymusic_|mymusic-|MYMUSIC_TEST_URL|/tmp/mymusic|unto.me/mymusic|mymusic-cache|mymusic_logs" --glob "*.ts" --glob "*.cjs" --glob "*.sh" --glob "*.html" --glob "*.json" --glob "!PLAN-*" --glob "!example/**" --glob "!dist/**" --glob "!dist-test/**" --glob "!node_modules/**"`
   - Result: no matches in runtime/test/docs targeted by Phase A (`NO_OLD_NAMESPACES_FOUND`).
