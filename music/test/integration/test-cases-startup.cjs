const URL = globalThis.__ONEPLAY_TEST_URL;

module.exports = {

    // -- Startup --------------------------------------------------------------

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
                hasStartupError: !!document.querySelector("#status .startup-error"),
                hasDeadlineExceeded: logs.some((entry) =>
                    typeof entry.message === "string" && entry.message.startsWith("startup: deadline exceeded (")),
                hasCompleteDeadline: logs.some((entry) => entry.message === "startup complete: deadline"),
            };
        });
        assert(state.hasIndexProgress, "Expected indexing progress UI to remain visible after startup deadline window");
        assert(!state.hasStartupError, "Did not expect startup error while first-time indexing is in progress");
        assert(!state.hasDeadlineExceeded, "Did not expect startup deadline exceeded log during first-time indexing");
        assert(!state.hasCompleteDeadline, "Did not expect startup complete: deadline during first-time indexing");
    },
};
