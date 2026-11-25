const URL = globalThis.__ONEPLAY_TEST_URL;

module.exports = {

    /** A request that completes after Reload appears cannot replace it with indexing or the tree. */
    async "startup: late account details preserve the deadline UI"(page) {
        await configureStartupScenario(page, { signedIn: true, hangFirstTimeIndexBatch: true,
            holdAccountDetails: true, startupDeadlineMs: 120 });
        await page.goto(URL, { waitUntil: "domcontentloaded" });
        await page.locator(".startup-error").waitFor();
        await page.waitForFunction(() => typeof window._testReleaseDetails === "function");
        await page.evaluate(() => window._testReleaseDetails());
        await page.waitForFunction(() => window._testStartedBatch);
        assert(await page.locator(".startup-error").isVisible(), "Late indexing replaced Reload");
    },

    /** A cold launch upgrades both old stores before an edit can reuse a playlist row. */
    async "startup: browser bookmarks follow shifted rows and reject removed recordings"(page) {
        await page.route(URL + "seed-bookmarks", r => r.fulfill({contentType: "text/html", body: "<title>Seed</title>"}));
        await page.route(URL + "bookmark-fixture.wav", r => r.fulfill({contentType: "audio/wav", body: silentWav()}));
        await page.goto(URL + "seed-bookmarks");
        await page.evaluate(async () => {
            const {dbPut, audioPut} = await import("./dist/db.js");
            const blob = await (await fetch("bookmark-fixture.wav")).blob();
            for (const id of ["A", "B", "C"]) await audioPut("primary:" + id, blob);
            const files = ["A", "B", "C"].map(itemId => ({driveId: "primary", itemId,
                path: [itemId + ".mp3"], isFolder: false}));
            await dbPut("index:primary", {kind: "MusicData", count: 3, folder: {id: "p",
                children: Object.fromEntries(files.map(f => [f.path[0], {id: f.itemId}]))}});
            await dbPut("favorites", {version: 1, updatedAt: 1, favorites: ["global", "private", "disabled"].map(id =>
                ({kind: "playlist", id, name: id, members: [...files], offlinePin: {paused: true}, hasPrivatePlayback: id === "private"}))});
            await dbPut("playback:private", {trackPath: ["OnePlay Music", "fav:private", "m:1"], currentTime: 13.5});
            await dbPut("playback:disabled", {trackPath: ["OnePlay Music", "fav:disabled", "m:2"], currentTime: 6});
            localStorage.account_info = JSON.stringify({driveId: "primary", displayName: "OneDrive"});
            const folder = ["OnePlay Music", "fav:global"];
            localStorage.oneplay_music_playback = JSON.stringify({folder, track: [...folder, "m:1"], mode: "all"});
            localStorage.oneplay_music_time = "7.25";
        });
        await page.addInitScript(() => Object.defineProperty(navigator, "onLine", {get: () => false}));
        await page.goto(URL);
        await page.waitForFunction(() => JSON.parse(localStorage.oneplay_music_playback)?.key
            && JSON.parse(localStorage.getItem("oneplay_music_fav:private"))?.key
            && JSON.parse(localStorage.getItem("oneplay_music_fav:disabled"))?.key);
        const before = await page.evaluate(() => [JSON.parse(localStorage.oneplay_music_playback),
            JSON.parse(localStorage.getItem("oneplay_music_fav:private")), JSON.parse(localStorage.oneplay_music_time)]);
        assert(before[1].time === 13.5 && before[2].generation === before[0].generation && before[2].time === 7.25,
            "Legacy times must survive migration into matched checkpoints");
        // Simulate a library edit while closed, with no opportunity to rewrite the active bookmark.
        await page.goto(URL + "seed-bookmarks");
        await page.evaluate(async () => {
            const {dbGet, dbPut} = await import("./dist/db.js");
            const data = await dbGet("favorites");
            for (const fav of data.favorites) fav.members.shift();
            await dbPut("favorites", data);
        });
        await page.goto(URL);
        await page.waitForFunction(() => window._testPlayback?.getInfo()?.track?.at(-1) === "m:0");
        const shifted = await page.evaluate(() => JSON.parse(localStorage.oneplay_music_playback));
        assert(shifted.key === before[0].key && shifted.track.at(-1) === "m:0", "B must move from row 1 to row 0");
        const playPrivate = async () => {
            await page.evaluate(() => window._testTree.setSelectedPath(["OnePlay Music", "fav:private"]));
            await page.locator("#breadcrumbs .selected .play-btn").click();
            await page.waitForFunction(() => !document.querySelector("audio").paused && document.querySelector("audio").currentTime > 0);
        };
        await playPrivate();
        let position = await page.evaluate(() => [window._testPlayback.getInfo()?.track.at(-1), document.querySelector("audio").currentTime]);
        assert(position[0] === "m:0" && position[1] >= 13 && position[1] < 16, "Private Play must resume B at its new row");

        await page.goto(URL + "seed-bookmarks");
        await page.evaluate(async () => {
            const {dbGet, dbPut} = await import("./dist/db.js");
            const data = await dbGet("favorites");
            for (const fav of data.favorites) fav.members.shift();
            await dbPut("favorites", data);
        });
        await page.evaluate(saved => { localStorage.oneplay_music_playback = JSON.stringify(saved); }, shifted);
        await page.goto(URL);
        await page.locator("#tree-container:visible").waitFor();
        await page.waitForFunction(() => window._testPlayback && !localStorage.getItem("oneplay_music_playback"));
        assert(!await page.evaluate(() => window._testPlayback.getInfo()), "C must never inherit B's position");
        await playPrivate();
        position = await page.evaluate(() => document.querySelector("audio").currentTime);
        assert(position < 3, "A missing private occurrence must start the first playable track at zero");
    },

    /** All cached roots participate in the first validation of a restored shared-folder path. */
    async "startup: offline share restores folder and scroll"(page) {
        await page.route(URL + "seed-share", r => r.fulfill({ contentType: "text/html", body: "<title>Seed</title>" }));
        await page.goto(URL + "seed-share");
        await page.evaluate(async () => {
            const { dbPut } = await import("./dist/db.js");
            const share = { id: "row", name: "Shared Music", rootKey: "share:abc", shareId: "abc", driveId: "shared", rootItemId: "folder" };
            const path = ["OnePlay Music", share.rootKey, "Album"];
            const tracks = Object.fromEntries(Array.from({length:80}, (_, i) => [i + ".mp3", { id: String(i) }]));
            await dbPut("shares", { shares: [share] });
            await dbPut("index-share:abc", { kind: "MusicData", count: 80, folder: { id: "s", children: { Album: { id: "a", children: tracks } } } });
            await dbPut("index:primary", { kind: "MusicData", count: 0, folder: { id: "p", children: {} } });
            localStorage.account_info = JSON.stringify({ driveId:"primary", displayName:"OneDrive" });
            localStorage.oneplay_music_view = JSON.stringify({ path, expanded:false });
            localStorage.oneplay_music_scroll = JSON.stringify({ [JSON.stringify(path)]: { top:180 } });
        });
        await page.addInitScript(() => Object.defineProperty(navigator, "onLine", {get: () => false}));
        await page.goto(URL, {waitUntil:"domcontentloaded"});
        await page.locator("#tree-container:visible").waitFor();
        assert(await page.locator("#children .tree-row").count() === 80, "Cached shared album disappeared");
        assert(await page.locator("#children").evaluate(el => el.scrollTop) === 180, "Saved share scroll was lost");
    },


    /** Signed-out + no cache reaches sign-in terminal UI without hanging on placeholder. */
    async "startup: no-auth no-cache shows sign-in terminal"(page) {
        await configureStartupScenario(page, { signedIn: false, forceOffline: false, hangFetch: false });
        await page.goto(URL, { waitUntil: "domcontentloaded" });
        await page.waitForSelector("#status .signin-btn", { timeout: 3000 });
        const state = await page.evaluate(() => ({
            hasSignIn: !!document.querySelector("#status .signin-btn"),
            hasStartupError: !!document.querySelector("#status .startup-error"),
            treeVisible: document.querySelector("#tree-container") instanceof HTMLElement
                ? !document.querySelector("#tree-container").hidden
                : false,
            signInCompleteLevel: (
                (Array.isArray(window.__ONEPLAY_MUSIC_LOGS) ? window.__ONEPLAY_MUSIC_LOGS : [])
                    .find((entry) => entry.message === "startup complete: sign-in")
            )?.level,
        }));
        assert(state.hasSignIn, "Expected sign-in button terminal UI");
        assert(!state.hasStartupError, "Did not expect startup error for signed-out no-cache");
        assert(!state.treeVisible, "Tree should remain hidden in signed-out no-cache startup");
        assert(state.signInCompleteLevel === "info",
            `Expected "startup complete: sign-in" to be info, got ${state.signInCompleteLevel}`);
    },

    /** Signed-in + no cache + offline reaches startup error terminal immediately. */
    async "startup: signed-in no-cache offline shows startup error quickly"(page) {
        await configureStartupScenario(page, { signedIn: true, forceOffline: true, hangFetch: false });
        const t0 = Date.now();
        await page.goto(URL, { waitUntil: "domcontentloaded" });
        await page.waitForSelector("#status .startup-error button", { timeout: 2000 });
        const elapsedMs = Date.now() - t0;
        const state = await page.evaluate(() => ({
            hasReload: !!document.querySelector("#status .startup-error button"),
            hasSignInCta: Array.from(document.querySelectorAll("#status button.signin-btn"))
                .map((el) => (el instanceof HTMLButtonElement ? (el.textContent ?? "").trim() : ""))
                .includes("Sign in with OneDrive"),
            startupCompleteErrorLevel: (
                (Array.isArray(window.__ONEPLAY_MUSIC_LOGS) ? window.__ONEPLAY_MUSIC_LOGS : [])
                    .find((entry) => entry.message === "startup complete: error")
            )?.level,
            fellThroughWrongLevel: (Array.isArray(window.__ONEPLAY_MUSIC_LOGS) ? window.__ONEPLAY_MUSIC_LOGS : [])
                .some((entry) =>
                    entry.message === "startup: fell through without terminal UI"
                    && entry.level !== "error"),
        }));
        assert(state.hasReload, "Expected startup error reload button in offline no-cache startup");
        assert(!state.hasSignInCta, "Did not expect sign-in UI in offline signed-in no-cache startup");
        assert(elapsedMs < 2000, `Expected immediate offline terminal UI, got ${elapsedMs}ms`);
        assert(state.startupCompleteErrorLevel === "error",
            `Expected "startup complete: error" to be error, got ${state.startupCompleteErrorLevel}`);
        assert(!state.fellThroughWrongLevel, "If present, fell-through startup logs must be error-level");
    },

    /** Signed-in + no cache + hanging pull reaches deadline terminal quickly. */
    async "startup: signed-in no-cache hanging pull hits deadline terminal"(page) {
        const startupDeadlineMs = 180;
        await configureStartupScenario(page, {
            signedIn: true,
            forceOffline: false,
            hangFetch: true,
            startupDeadlineMs,
        });
        const t0 = Date.now();
        await page.goto(URL, { waitUntil: "domcontentloaded" });
        await page.waitForSelector("#status .startup-error button", { timeout: 1500 });
        const elapsedMs = Date.now() - t0;
        const levels = await page.evaluate(() => {
            const logs = Array.isArray(window.__ONEPLAY_MUSIC_LOGS) ? window.__ONEPLAY_MUSIC_LOGS : [];
            const deadlineExceeded = logs.find((entry) =>
                typeof entry.message === "string" && entry.message.startsWith("startup: deadline exceeded ("));
            const completeDeadline = logs.find((entry) => entry.message === "startup complete: deadline");
            const fellThroughWrongLevel = logs.some((entry) =>
                entry.message === "startup: fell through without terminal UI" && entry.level !== "error");
            return {
                deadlineExceededLevel: deadlineExceeded?.level,
                completeDeadlineLevel: completeDeadline?.level,
                fellThroughWrongLevel,
            };
        });
        assert(elapsedMs >= startupDeadlineMs - 80,
            `Expected deadline terminal after ~${startupDeadlineMs}ms, got ${elapsedMs}ms`);
        assert(elapsedMs <= 1500, `Expected fast deadline terminal UI, got ${elapsedMs}ms`);
        assert(levels.deadlineExceededLevel === "error",
            `Expected "startup: deadline exceeded (...)" to be error, got ${levels.deadlineExceededLevel}`);
        assert(levels.completeDeadlineLevel === "error",
            `Expected "startup complete: deadline" to be error, got ${levels.completeDeadlineLevel}`);
        assert(!levels.fellThroughWrongLevel, "If present, fell-through startup logs must be error-level");
    },

    /** Signed-in + no cache + first-time indexing should bypass deadline and keep progress UI visible. */
    async "startup: signed-in no-cache first-time indexing bypasses deadline"(page) {
        const startupDeadlineMs = 180;
        await configureStartupScenario(page, {
            signedIn: true,
            forceOffline: false,
            hangFetch: false,
            hangFirstTimeIndexBatch: true,
            startupDeadlineMs,
        });
        const t0 = Date.now();
        await page.goto(URL, { waitUntil: "domcontentloaded" });
        await page.waitForSelector("#status .index-progress", { timeout: 1500 });
        await page.waitForFunction(
            ({ startedAt, minElapsedMs }) => Date.now() - startedAt >= minElapsedMs,
            { startedAt: t0, minElapsedMs: startupDeadlineMs + 160 },
            { timeout: 1500 },
        );
        const state = await page.evaluate(() => {
            const logs = Array.isArray(window.__ONEPLAY_MUSIC_LOGS) ? window.__ONEPLAY_MUSIC_LOGS : [];
            return {
                hasIndexProgress: !!document.querySelector("#status .index-progress"),
                rootRequestCache: window._testMusicRootRequestCache,
                hasStartupError: !!document.querySelector("#status .startup-error"),
                hasDeadlineExceeded: logs.some((entry) =>
                    typeof entry.message === "string" && entry.message.startsWith("startup: deadline exceeded (")),
                hasCompleteDeadline: logs.some((entry) => entry.message === "startup complete: deadline"),
            };
        });
        assert(state.hasIndexProgress, "Expected indexing progress UI to remain visible after startup deadline window");
        assert(state.rootRequestCache === "no-store",
            "A saved folder ETag can validate a stale recursive size. The root probe must bypass the HTTP cache.");
        assert(!state.hasStartupError, "Did not expect startup error while first-time indexing is in progress");
        assert(!state.hasDeadlineExceeded, "Did not expect startup deadline exceeded log during first-time indexing");
        assert(!state.hasCompleteDeadline, "Did not expect startup complete: deadline during first-time indexing");
    },
};
