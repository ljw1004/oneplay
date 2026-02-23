/**
 * Playwright regression tests for the tree view.
 *
 * Usage:
 *   npm test                          runs all tests
 *   npm test -- "settings"            runs tests matching "settings"
 *
 * Uses the shared Chromium profile at /tmp/oneplay-profile so the user's
 * sign-in session is available. Tests run against http://localhost:5500/music/.
 *
 * INVARIANT: Each test function receives a fresh page (same browser context).
 * Tests are run sequentially. A test signals failure by throwing.
 */

const { chromium } = require("playwright");
const fs = require("fs");
const os = require("os");
const path = require("path");

const URL = process.env.ONEPLAY_MUSIC_TEST_URL || "http://localhost:5500/music/";
const PROFILE = "/tmp/oneplay-profile";
const TREE_NOT_VISIBLE_ERROR = "Tree not visible after 15s — is the user signed in?";

/** Parse --log <file> from argv. If present, all output is tee'd to the file
 *  so progress can be monitored via `tail -f` while sandbox-escape buffers stdout. */
const logFileIdx = process.argv.indexOf("--log");
const logFile = logFileIdx !== -1 ? process.argv[logFileIdx + 1] : null;
if (logFile) {
    fs.writeFileSync(logFile, ""); // truncate
    process.argv.splice(logFileIdx, 2); // remove --log <file> from argv
}

/** Writes a line to stdout and optionally to the log file. */
function emit(line) {
    console.log(line);
    if (logFile) fs.appendFileSync(logFile, line + "\n");
}

emit(`DATESTAMP: ${new Date().toString()}`);
emit(`URL: ${URL}`);

// Guardrail: integration tests must use condition-based waits, not fixed sleeps.
const waitForTimeoutPattern = new RegExp("waitFor" + "Timeout\\s*\\(");
if (waitForTimeoutPattern.test(fs.readFileSync(__filename, "utf8"))) {
    emit("ERROR: fixed timeout waits are forbidden. Use deterministic wait helpers instead.");
    process.exit(1);
}

let passed = 0;
let failed = 0;
const failures = [];

/** Waits for breadcrumb count to equal n. */
async function waitForBreadcrumbCount(page, n, timeout = 5000) {
    await page.waitForFunction(
        (count) => document.querySelectorAll("#breadcrumbs .tree-row").length === count,
        n,
        { timeout },
    );
}

/** Waits for the settings page to be visible. */
async function waitForSettingsOpen(page, timeout = 3000) {
    await page.waitForSelector("#settings-container:not([hidden])", { timeout });
}

/** Waits for the generic action dropdown to be visible. */
async function waitForActionDropdown(page, timeout = 3000) {
    await page.locator(".action-dropdown").first().waitFor({ state: "visible", timeout });
}

/** Waits for select mode to match expected active state. */
async function waitForSelectMode(page, active, timeout = 3000) {
    await page.waitForFunction(
        (expected) => document.body.classList.contains("select-mode") === expected,
        active,
        { timeout },
    );
}

/** Reads a test sequence counter from window. */
async function getTestSeq(page, key) {
    return await page.evaluate((k) => {
        const value = window[k];
        return typeof value === "number" ? value : 0;
    }, key);
}

/** Waits for a window sequence counter to increase above prev. */
async function waitForSeqIncrease(page, key, prev, timeout = 8000) {
    await page.waitForFunction(
        (args) => {
            const value = window[args.key];
            return typeof value === "number" && value > args.prev;
        },
        { key, prev },
        { timeout },
    );
}

/** Waits for playback to settle to a ready checkpoint (hooked in playback.ts). */
async function waitForPlaybackReady(page, prevSeq, timeout = 12000) {
    await waitForSeqIncrease(page, "_testPlaybackSeq", prevSeq, timeout);
}

/** Asserts a sequence counter does not increase for a short observation window. */
async function expectSeqUnchangedFor(page, key, prev, windowMs = 1000) {
    const unchanged = await page.evaluate(({ seqKey, baseline, holdMs }) => new Promise((resolve) => {
        const startedAt = performance.now();
        const check = () => {
            const value = window[seqKey];
            if (typeof value === "number" && value > baseline) {
                resolve(false);
                return;
            }
            if (performance.now() - startedAt >= holdMs) {
                resolve(true);
                return;
            }
            requestAnimationFrame(check);
        };
        check();
    }), { seqKey: key, baseline: prev, holdMs: windowMs });
    assert(unchanged, `Expected ${key} to stay <= ${prev} for ${windowMs}ms`);
}

/** Forces Date.now to a deterministic test clock value. */
async function setFakeNow(page, nowMs) {
    await page.evaluate((nextNow) => {
        if (typeof window._testDateNowOriginal !== "function") {
            window._testDateNowOriginal = Date.now;
        }
        window._testNowMs = nextNow;
        Date.now = () => window._testNowMs;
    }, nowMs);
}

/** Ensures playback expansion is visible, then cycles mode to target text. */
async function setPlaybackMode(page, targetMode) {
    await page.evaluate(() => {
        const footer = document.getElementById("footer");
        if (!(footer instanceof HTMLElement)) return;
        footer.classList.add("expanded");
        const expansion = footer.querySelector(".expansion");
        if (expansion instanceof HTMLElement) {
            expansion.style.maxHeight = expansion.scrollHeight + "px";
        }
    });
    const label = page.locator(".mode-label");
    await label.waitFor({ state: "visible", timeout: 3000 });
    for (let i = 0; i < 8; i++) {
        const current = await page.evaluate(() =>
            document.querySelector(".mode-label")?.textContent ?? "");
        if (current === targetMode) return;
        await label.click();
        await page.waitForFunction(
            (prev) => document.querySelector(".mode-label")?.textContent !== prev,
            current,
            { timeout: 2000 },
        );
    }
    const actual = await page.evaluate(() => document.querySelector(".mode-label")?.textContent ?? "");
    throw new Error(`Failed to reach mode "${targetMode}", got "${actual}"`);
}

/** Dispatches a synthetic timeupdate event on the app audio element. */
async function dispatchAudioTimeupdate(page) {
    await page.evaluate(() => {
        const audio = document.getElementById("player");
        if (audio instanceof HTMLAudioElement) audio.dispatchEvent(new Event("timeupdate"));
    });
}

/** Dispatches a synthetic ended event on the app audio element. */
async function dispatchAudioEnded(page) {
    await page.evaluate(() => {
        const audio = document.getElementById("player");
        if (audio instanceof HTMLAudioElement) audio.dispatchEvent(new Event("ended"));
    });
}

/** Waits for FLIP overflow cleanup to finish (hooked in tree.ts). */
async function waitForFlipSettled(page, prevSeq, timeout = 3000) {
    await waitForSeqIncrease(page, "_testTreeFlipSeq", prevSeq, timeout);
}

/** Waits for at least min favorite icons at root. */
async function waitForFavIconCount(page, min, timeout = 5000) {
    await page.waitForFunction(
        (expected) => document.querySelectorAll("#children .fav-icon").length >= expected,
        min,
        { timeout },
    );
}

/** Ensures there is at least one favorite icon at root, creating test data if needed. */
async function ensureFavoritesExist(page) {
    let iconCount = await page.evaluate(() =>
        document.querySelectorAll("#children .fav-icon").length
    );
    if (iconCount > 0) return true;
    const created = await createTestFavorites(page);
    if (!created) return false;
    iconCount = await page.evaluate(() =>
        document.querySelectorAll("#children .fav-icon").length
    );
    return iconCount > 0;
}

/** Ensures there are at least two playlists for duplicate-name validation tests. */
async function ensureAtLeastTwoPlaylists(page) {
    if (!await ensureFavoritesExist(page)) return false;
    return await page.evaluate(async () => {
        const favs = window._testFavorites;
        if (!favs) return false;
        // Prevent this helper from persisting seeded playlists to IndexedDB/OneDrive.
        favs._testOnlySuppressSave(true);
        const playlists = favs.getAll().filter(f => f.kind === "playlist");
        if (playlists.length >= 2) return true;
        const shortcut = favs.getAll().find(f => f.kind === "shortcut");
        await favs.add({
            kind: "playlist",
            id: crypto.randomUUID(),
            name: `Extra Playlist ${Date.now()}`,
            members: shortcut ? [{ favId: shortcut.id }] : [],
            hasPrivatePlayback: false,
        });
        return true;
    });
}

/** Navigates down until at least one file row is visible, or returns undefined. */
async function findFirstFileRow(page) {
    for (let attempt = 0; attempt < 5; attempt++) {
        const file = page.locator("#children .tree-row.file").first();
        if (await file.count() > 0) return file;
        await clickFirstFolder(page);
    }
    const file = page.locator("#children .tree-row.file").first();
    return (await file.count() > 0) ? file : undefined;
}

/** Clicks a track row and waits for playback readiness sequence to advance. */
async function clickTrackAndWaitForPlaybackReady(page, row) {
    const prevPlaybackSeq = await getTestSeq(page, "_testPlaybackSeq");
    await row.click();
    await waitForPlaybackReady(page, prevPlaybackSeq);
}

/** Opens settings from the OnePlay Music row icon. */
async function openSettingsPage(page) {
    const icon = page.locator("#breadcrumbs .tree-row").first().locator(".row-icon", { hasText: /[☰⚠]/ });
    await icon.click();
    await waitForSettingsOpen(page);
}

/** Closes settings via header X. */
async function closeSettingsPage(page) {
    await page.locator("#settings-container .settings-close").click();
    await page.waitForSelector("#tree-container:not([hidden])", { timeout: 3000 });
}

/** Sets timer duration via settings UI and closes settings. */
async function setTimerDurationSetting(page, value) {
    await openSettingsPage(page);
    await page.locator("#settings-container .settings-timer-select").selectOption(value);
    await closeSettingsPage(page);
}

/** Returns true when the current playback folder has at least 2 file tracks. */
async function hasAtLeastTwoTracksInCurrentPlaybackFolder(page) {
    return await page.evaluate(() => {
        const info = window._testPlayback?.getInfo();
        const roots = window._testTreeRoots;
        if (!info || !roots) return false;
        const root = roots.get(info.folder[1]);
        if (!root || root.type !== "onedrive") return false;
        let folder = root.folder;
        for (const segment of info.folder.slice(2)) {
            const next = folder.children?.[segment];
            if (!(next && typeof next === "object" && "children" in next)) return false;
            folder = next;
        }
        let count = 0;
        const walk = (f) => {
            for (const name of Object.keys(f.children)) {
                const child = f.children[name];
                if (child && typeof child === "object" && "children" in child) {
                    walk(child);
                } else {
                    count += 1;
                }
                if (count >= 2) return;
            }
        };
        walk(folder);
        return count >= 2;
    });
}

/** Opens tree search mode from the OnePlay Music row. */
async function openSearchMode(page) {
    await page.locator("#breadcrumbs .row-icon-search").first().click();
    await page.waitForSelector("#breadcrumbs .search-header", { timeout: 3000 });
}

/** Closes tree search mode via the top-right X button. */
async function closeSearchMode(page) {
    await page.locator("#breadcrumbs .search-close").click();
    await page.waitForSelector("#breadcrumbs .search-header", { state: "hidden", timeout: 3000 });
}

/** Fills the active search query and waits for input value sync. */
async function setSearchQuery(page, query) {
    await page.locator("#breadcrumbs .search-input").fill(query);
    await page.waitForFunction(
        (q) => {
            const input = document.querySelector("#breadcrumbs .search-input");
            return input instanceof HTMLInputElement && input.value === q;
        },
        query,
        { timeout: 3000 },
    );
}

/** Finds the first OneDrive track fixture from in-memory roots. */
async function getFirstOneDriveTrackFixture(page) {
    return await page.evaluate(() => {
        const roots = window._testTreeRoots;
        if (!roots) return null;
        for (const [key, root] of roots) {
            if (root.type !== "onedrive") continue;
            const walk = (folder, folderPath) => {
                const names = Object.keys(folder.children).sort((a, b) => a.localeCompare(b));
                for (const name of names) {
                    const child = folder.children[name];
                    if (child && typeof child === "object" && "children" in child) {
                        const nested = walk(child, [...folderPath, name]);
                        if (nested) return nested;
                        continue;
                    }
                    return {
                        rootKey: key,
                        driveId: root.info.driveId,
                        folderPath,
                        folderId: folder.id,
                        fileName: name,
                        fileId: child.id,
                    };
                }
                return null;
            };
            const found = walk(root.folder, []);
            if (found) return found;
        }
        return null;
    });
}

/** Finds the first loaded share-track fixture from in-memory roots. */
async function getFirstShareTrackFixture(page) {
    return await page.evaluate(() => {
        const roots = window._testTreeRoots;
        if (!roots) return null;
        for (const [key, root] of roots) {
            if (root.type !== "share" || !root.folder) continue;
            const walk = (folder, folderPath) => {
                const names = Object.keys(folder.children).sort((a, b) => a.localeCompare(b));
                for (const name of names) {
                    const child = folder.children[name];
                    if (child && typeof child === "object" && "children" in child) {
                        const nested = walk(child, [...folderPath, name]);
                        if (nested) return nested;
                        continue;
                    }
                    return {
                        rootKey: key,
                        driveId: root.driveId,
                        folderPath,
                        folderId: folder.id,
                        fileName: name,
                        fileId: child.id,
                    };
                }
                return null;
            };
            const found = walk(root.folder, []);
            if (found) return found;
        }
        return null;
    });
}

/** Exits select mode through Cancel and waits for state update. */
async function exitSelectMode(page) {
    await page.locator("#select-cancel").click();
    await waitForSelectMode(page, false);
}

/** Navigates to the app and waits for the tree to be visible. */
async function setup(page) {
    // Clear M10 state persistence keys so each test starts fresh.
    // Clearing is once-per-test-page (sessionStorage-guarded), so tests can
    // still verify persistence across reloads within the same page.
    // All oneplay_music_* keys are cleared including auth lifecycle keys
    // (oneplay_music_auth_lineage_time, oneplay_music_redirect_attempt, oneplay_music_redirect_result).
    // Auto-redirect (prompt=none) is not reliable on localhost: Microsoft may
    // require an interactive confirmation interstitial, which prompt=none
    // cannot satisfy (it returns interaction_required instead).
    // addInitScript runs before every page load (including SW-triggered
    // reloads), so persisted state from a previous test can never leak
    // through.
    await page.addInitScript(() => {
        if (!sessionStorage.getItem("__oneplay_music_test_cleared")) {
            Object.keys(localStorage).filter(k => k.startsWith("oneplay_music_")).forEach(k => localStorage.removeItem(k));
            sessionStorage.setItem("__oneplay_music_test_cleared", "1");
        }
        // Suppress SW registration entirely. The init page already unregistered
        // any active SW. If the app re-registers (even a no-op SW), the
        // transition from "no controller" to "new controller" fires
        // controllerchange, and the SW_DEBUG handler calls location.reload(),
        // destroying test state mid-flight. Stubbing register() prevents this.
        if (navigator.serviceWorker) {
            navigator.serviceWorker.register = () => Promise.resolve(/** @type {any} */ ({}));
        }
    });
    await page.goto(URL, { waitUntil: "domcontentloaded" });
    // Wait for tree to appear. Timeout is generous to accommodate Entra
    // auto-redirect round-trip when tokens are near expiry (>21hrs old).
    await page.waitForSelector("#tree-container:not([hidden])", { timeout: 15000 })
        .catch(() => { throw new Error(TREE_NOT_VISIBLE_ERROR); });
}

/** Configures pre-navigation startup state for terminal-UI tests. */
async function configureStartupScenario(page, options) {
    await page.addInitScript((opts) => {
        Object.keys(localStorage).filter((k) => k.startsWith("oneplay_music_") || k === "account_info")
            .forEach((k) => localStorage.removeItem(k));
        sessionStorage.removeItem("code_verifier");
        if (opts.signedIn) {
            localStorage.setItem("access_token", "startup-test-access-token");
            localStorage.setItem("refresh_token", "startup-test-refresh-token");
        } else {
            localStorage.setItem("access_token", "null: startup test signed-out");
            localStorage.setItem("refresh_token", "null: startup test signed-out");
        }
        if (navigator.serviceWorker) {
            navigator.serviceWorker.register = () => Promise.resolve(/** @type {any} */ ({}));
        }
        if (opts.forceOffline) {
            Object.defineProperty(window.navigator, "onLine", {
                configurable: true,
                get: () => false,
            });
        }
        if (typeof opts.startupDeadlineMs === "number"
            && Number.isFinite(opts.startupDeadlineMs)
            && opts.startupDeadlineMs > 0) {
            window._testStartupDeadlineMs = opts.startupDeadlineMs;
        } else {
            delete window._testStartupDeadlineMs;
        }
        if (opts.hangFirstTimeIndexBatch) {
            const nativeFetch = window.fetch.bind(window);
            window.fetch = (input, init) => {
                const url = typeof input === "string"
                    ? input
                    : (input instanceof URL ? input.href
                        : (input instanceof Request ? input.url : String(input)));
                if (!url.includes("graph.microsoft.com/v1.0")) return nativeFetch(input, init);
                if (url.includes("/v1.0/me/drive?")
                    && url.includes("$select=id,owner")) {
                    return Promise.resolve(new Response(JSON.stringify({
                        id: "startup-test-drive-id",
                        owner: { user: { displayName: "Startup Test Drive" } },
                    }), { status: 200, headers: { "Content-Type": "application/json" } }));
                }
                if (url.includes("/v1.0/me/drive/special/music?")
                    && url.includes("$select=name,id,cTag,eTag,size,lastModifiedDateTime,folder")) {
                    return Promise.resolve(new Response(JSON.stringify({
                        id: "startup-test-music-root-id",
                        name: "Music",
                        size: 12345,
                        lastModifiedDateTime: "2026-01-01T00:00:00Z",
                        cTag: "startup-test-ctag",
                        eTag: "startup-test-etag",
                        folder: { childCount: 1 },
                    }), { status: 200, headers: { "Content-Type": "application/json" } }));
                }
                if (url.includes("/v1.0/$batch")) return new Promise(() => {});
                return Promise.resolve(new Response("", { status: 404 }));
            };
        }
        if (opts.hangFetch) {
            window.fetch = () => new Promise(() => {});
        }
    }, options);
}

/** Clicks the OneDrive account row (from root level). */
async function clickAccount(page) {
    await page.locator("#children .tree-row.folder", { hasText: "OneDrive" }).click();
    // Wait for account to appear as breadcrumb (not a fixed timeout — first
    // page load after SW unregistration can be slow).
    await page.locator("#breadcrumbs .tree-row", { hasText: "OneDrive" })
        .waitFor({ timeout: 5000 });
}

/** Clicks the first folder in #children. */
async function clickFirstFolder(page) {
    const before = await page.locator("#breadcrumbs .tree-row").count();
    await page.locator("#children .tree-row.folder").first().click();
    // Wait for a new breadcrumb to appear (navigation completed).
    await page.locator(`#breadcrumbs .tree-row:nth-child(${before + 1})`)
        .waitFor({ timeout: 5000 });
}

/**
 * Creates test favorites via _testOnlySuppressSave. Navigates to OneDrive,
 * finds the first folder, creates a shortcut and a playlist. Returns to root.
 * INVARIANT: tree must be visible and at root level on entry.
 */
async function createTestFavorites(page) {
    // Suppress saving so we don't persist test data
    await page.evaluate(() => {
        const favModule = window._testFavorites;
        if (favModule) favModule._testOnlySuppressSave(true);
    });
    // We need access to favorites — let's check if it's exposed
    const hasFavAccess = await page.evaluate(() => typeof window._testFavorites !== "undefined");
    if (!hasFavAccess) {
        // Can't create test favorites — some tests may skip
        return false;
    }
    // Create a shortcut to the first OneDrive folder
    await page.evaluate(async () => {
        const favs = window._testFavorites;
        // Get the first OneDrive account's first folder from the tree roots
        const roots = window._testTreeRoots;
        if (!roots) return;
        let driveId, folder;
        for (const [key, root] of roots) {
            if (root.type === "onedrive") {
                driveId = key;
                folder = root.folder;
                break;
            }
        }
        if (!driveId || !folder) return;
        const entries = Object.entries(folder.children);
        const folders = entries.filter(([, item]) => item.children !== undefined);
        if (folders.length === 0) return;
        const firstFolder = folders[0];
        const shortcutId = crypto.randomUUID();
        await favs.add({
            kind: "shortcut",
            id: shortcutId,
            name: firstFolder[0],
            target: {
                driveId,
                itemId: firstFolder[1].id,
                path: [firstFolder[0]],
                isFolder: true,
            },
            hasPrivatePlayback: false,
        });
        // Create a playlist
        await favs.add({
            kind: "playlist",
            id: crypto.randomUUID(),
            name: "Test Playlist",
            members: [{ favId: shortcutId }],
            hasPrivatePlayback: false,
        });
    });
    // Navigate to root to see favorites
    await page.locator("#breadcrumbs .tree-row", { hasText: "OnePlay Music" }).click();
    await waitForBreadcrumbCount(page, 1);
    await waitForFavIconCount(page, 1);
    return true;
}

/**
 * Enters select mode via right-click on the first child row.
 * Requires page to be at a level with child rows.
 */
async function enterSelectViaRightClick(page, rowSelector = "#children .tree-row[data-path]") {
    const row = page.locator(rowSelector).first();
    await row.click({ button: "right" });
    await waitForSelectMode(page, true);
}

// ---------------------------------------------------------------------------
// Tests — organized by feature area
// ---------------------------------------------------------------------------


module.exports = {
    chromium,
    fs,
    os,
    path,
    URL,
    PROFILE,
    TREE_NOT_VISIBLE_ERROR,
    emit,
    waitForBreadcrumbCount,
    waitForSettingsOpen,
    waitForActionDropdown,
    waitForSelectMode,
    getTestSeq,
    waitForSeqIncrease,
    waitForPlaybackReady,
    expectSeqUnchangedFor,
    setFakeNow,
    setPlaybackMode,
    dispatchAudioTimeupdate,
    dispatchAudioEnded,
    waitForFlipSettled,
    waitForFavIconCount,
    ensureFavoritesExist,
    ensureAtLeastTwoPlaylists,
    findFirstFileRow,
    clickTrackAndWaitForPlaybackReady,
    openSettingsPage,
    closeSettingsPage,
    setTimerDurationSetting,
    hasAtLeastTwoTracksInCurrentPlaybackFolder,
    openSearchMode,
    closeSearchMode,
    setSearchQuery,
    getFirstOneDriveTrackFixture,
    getFirstShareTrackFixture,
    exitSelectMode,
    setup,
    configureStartupScenario,
    clickAccount,
    clickFirstFolder,
    createTestFavorites,
    enterSelectViaRightClick,
};
