const URL = globalThis.__ONEPLAY_TEST_URL;

module.exports = {

    // -- Playback -------------------------------------------------------------

    /** Footer is hidden when page first loads (no playback folder). */
    async "playback: footer hidden initially"(page) {
        const visible = await page.evaluate(() => {
            const f = document.getElementById("footer");
            return f && f.classList.contains("visible");
        });
        assert(!visible, "Footer should be hidden initially");
    },

    /** Audio element exists and is hidden. */
    async "playback: audio element exists hidden"(page) {
        const exists = await page.evaluate(() => {
            const a = document.getElementById("player");
            return a && a.hidden && a.tagName === "AUDIO";
        });
        assert(exists, "Audio element should exist, be hidden, and be an AUDIO tag");
    },

    /** Play button shows ▷ on selected folder (not the playback folder). */
    async "playback: play button shows ghost triangle"(page) {
        await clickAccount(page);
        await clickFirstFolder(page);
        const playText = await page.locator(".play-btn").first().textContent();
        assert(playText.includes("\u25B7"), "Expected ghost triangle ▷ on play button");
    },

    /** Clicking a file row shows the footer with title and play/pause. */
    async "playback: clicking track shows footer"(page) {
        await clickAccount(page);
        const file = await findFirstFileRow(page);
        if (!file) return; // skip if no files found
        await clickTrackAndWaitForPlaybackReady(page, file);
        const visible = await page.evaluate(() => {
            const f = document.getElementById("footer");
            return f && f.classList.contains("visible");
        });
        assert(visible, "Footer should be visible after clicking a track");
    },

    /** Footer has title, play/pause button, and indicator SVG. */
    async "playback: footer structure"(page) {
        await clickAccount(page);
        const file = await findFirstFileRow(page);
        if (!file) return;
        await clickTrackAndWaitForPlaybackReady(page, file);
        const structure = await page.evaluate(() => {
            const footer = document.getElementById("footer");
            return {
                title: footer.querySelector(".footer-title") !== null,
                playpause: footer.querySelector(".footer-playpause") !== null,
                indicator: footer.querySelector(".footer-indicator") !== null,
            };
        });
        assert(structure.title, "Footer should have title element");
        assert(structure.playpause, "Footer should have play/pause button");
        assert(structure.indicator, "Footer should have indicator SVG");
    },

    /** After clicking play on a folder, the play button changes to filled ▶. */
    async "playback: play button changes to filled after play"(page) {
        await clickAccount(page);
        await clickFirstFolder(page);
        const playBtn = page.locator(".play-btn").first();
        if (await playBtn.count() === 0) return;
        await clickTrackAndWaitForPlaybackReady(page, playBtn);
        const text = await page.locator(".play-btn").first().textContent();
        assert(text.includes("\u25B6"), "Expected filled triangle ▶ after clicking play");
    },

    /** Selected folders with no immediate children suppress the play button. */
    async "playback: selected empty folder hides play button"(page) {
        const emptyName = `Empty Playlist ${Date.now()}`;
        const created = await page.evaluate(async (name) => {
            const favs = window._testFavorites;
            if (!favs) return false;
            favs._testOnlySuppressSave(true);
            await favs.add({
                kind: "playlist",
                id: crypto.randomUUID(),
                name,
                members: [],
                hasPrivatePlayback: false,
            });
            return true;
        }, emptyName);
        if (!created) return;

        const row = page.locator("#children .tree-row.folder", { hasText: emptyName }).first();
        await row.waitFor({ state: "visible", timeout: 5000 });
        await row.click();
        await page.locator("#breadcrumbs .tree-row.selected").waitFor({ state: "visible", timeout: 5000 });

        const playCount = await page.locator("#breadcrumbs .tree-row.selected .play-btn").count();
        assert(playCount === 0, `Expected no play button on selected empty folder, got ${playCount}`);
    },

    /** In terminal evidence state, selected folders with only unavailable file children hide play button. */
    async "playback: selected folder with only unavailable file children hides play button"(page) {
        const blockedName = `Unavailable Files ${Date.now()}`;
        const missingTrackName = `missing-${Date.now()}-${Math.random().toString(36).slice(2)}.mp3`;
        const prepared = await page.evaluate(async ({ name, missingName }) => {
            const favs = window._testFavorites;
            const roots = window._testTreeRoots;
            const auth = window._testAuth;
            if (!favs || !roots || !auth) return false;
            let driveId = "";
            for (const [key, root] of roots) {
                if (root.type === "onedrive") {
                    driveId = key;
                    break;
                }
            }
            if (!driveId) return false;
            favs._testOnlySuppressSave(true);
            await favs.add({
                kind: "playlist",
                id: crypto.randomUUID(),
                name,
                members: [{
                    driveId,
                    itemId: "missing-item",
                    path: [missingName],
                    isFolder: false,
                }],
                hasPrivatePlayback: false,
            });
            auth.transition("evidence:not-online");
            return true;
        }, { name: blockedName, missingName: missingTrackName });
        if (!prepared) return;

        const row = page.locator("#children .tree-row.folder", { hasText: blockedName }).first();
        await row.waitFor({ state: "visible", timeout: 5000 });
        await row.click();
        await page.waitForFunction(
            () => document.querySelectorAll("#children .tree-row.file.unavailable").length > 0,
            undefined,
            { timeout: 5000 },
        );
        const playCount = await page.locator("#breadcrumbs .tree-row.selected .play-btn").count();
        assert(playCount === 0, `Expected no play button when all immediate files are unavailable, got ${playCount}`);
    },

    /** In evidence:not-online, folder Play with zero playable tracks shows modal alert and doesn't start playback. */
    async "playback: offline folder play with no playable tracks shows alert"(page) {
        const blockedName = `Blocked Offline ${Date.now()}`;
        const prepared = await page.evaluate(async (name) => {
            const favs = window._testFavorites;
            const roots = window._testTreeRoots;
            const playback = window._testPlayback;
            if (!favs || !roots || !playback) return false;
            let driveId = "";
            let driveRoot = undefined;
            for (const [key, root] of roots) {
                if (root.type === "onedrive") {
                    driveId = key;
                    driveRoot = root;
                    break;
                }
            }
            if (!driveId || !driveRoot) return false;
            const hasFileDescendant = (folder) => {
                for (const [, item] of Object.entries(folder.children)) {
                    if (item.children !== undefined) {
                        if (hasFileDescendant(item)) return true;
                    } else {
                        return true;
                    }
                }
                return false;
            };
            const findFolderWithFileDescendant = (folder, path = []) => {
                for (const [childName, child] of Object.entries(folder.children)) {
                    if (child.children === undefined) continue;
                    const childPath = [...path, childName];
                    if (hasFileDescendant(child)) return { itemId: child.id, path: childPath };
                    const deeper = findFolderWithFileDescendant(child, childPath);
                    if (deeper) return deeper;
                }
                return undefined;
            };
            const target = findFolderWithFileDescendant(driveRoot.folder);
            if (!target) return false;
            favs._testOnlySuppressSave(true);
            await favs.add({
                kind: "playlist",
                id: crypto.randomUUID(),
                name,
                members: [{
                    driveId,
                    itemId: target.itemId,
                    path: target.path,
                    isFolder: true,
                }],
                hasPrivatePlayback: false,
            });
            window._testAlerts = [];
            window.alert = (msg) => { window._testAlerts.push(String(msg)); };
            return true;
        }, blockedName);
        if (!prepared) return;

        const row = page.locator("#children .tree-row.folder", { hasText: blockedName }).first();
        await row.waitFor({ state: "visible", timeout: 5000 });
        await row.click();
        const playBtn = page.locator("#breadcrumbs .tree-row.selected .play-btn").first();
        await playBtn.waitFor({ state: "visible", timeout: 5000 });

        const prevPlaybackSeq = await getTestSeq(page, "_testPlaybackSeq");
        await page.evaluate(() => {
            const playback = window._testPlayback;
            const btn = document.querySelector("#breadcrumbs .tree-row.selected .play-btn");
            if (!playback || !btn) return;
            playback.setAvailabilityContext("evidence:not-online", () => false);
            btn.click();
        });
        await page.waitForFunction(
            () => Array.isArray(window._testAlerts) && window._testAlerts.length > 0,
            undefined,
            { timeout: 3000 },
        );

        const state = await page.evaluate(() => ({
            alertText: Array.isArray(window._testAlerts) && window._testAlerts[0] ? window._testAlerts[0] : "",
            footerVisible: !!document.getElementById("footer")?.classList.contains("visible"),
            playbackSeq: typeof window._testPlaybackSeq === "number" ? window._testPlaybackSeq : 0,
        }));
        assert(state.alertText.includes("No offline tracks"), `Expected offline-alert text, got "${state.alertText}"`);
        assert(!state.footerVisible, "Footer should remain hidden when play is blocked");
        assert(state.playbackSeq === prevPlaybackSeq,
            `Playback sequence should not advance when blocked (before=${prevPlaybackSeq}, after=${state.playbackSeq})`);
    },

    // -- Expanded controls ----------------------------------------------------

    /** Footer is visible after clicking a track but has no .expanded class. */
    async "expanded: not expanded initially"(page) {
        await clickAccount(page);
        const file = await findFirstFileRow(page);
        if (!file) return;
        await clickTrackAndWaitForPlaybackReady(page, file);
        const state = await page.evaluate(() => {
            const f = document.getElementById("footer");
            return {
                visible: f && f.classList.contains("visible"),
                expanded: f && f.classList.contains("expanded"),
            };
        });
        assert(state.visible, "Footer should be visible after clicking a track");
        assert(!state.expanded, "Footer should not have .expanded class initially");
    },

    /** Expansion DOM contains all required elements: shell, wheel, text, thumb,
     *  4 edge buttons, and close button. */
    async "expanded: expansion DOM structure"(page) {
        await clickAccount(page);
        const file = await findFirstFileRow(page);
        if (!file) return;
        await clickTrackAndWaitForPlaybackReady(page, file);
        const dom = await page.evaluate(() => {
            const footer = document.getElementById("footer");
            return {
                expansion: footer.querySelector(".expansion") !== null,
                shell: footer.querySelector(".scrubber-shell") !== null,
                wheel: footer.querySelector(".scrubber-wheel") !== null,
                text: footer.querySelector(".scrubber-text") !== null,
                thumb: footer.querySelector(".scrubber-thumb") !== null,
                edgeButtons: footer.querySelectorAll(".scrubber-edge-button").length,
            };
        });
        assert(dom.expansion, "Should have .expansion element");
        assert(dom.shell, "Should have .scrubber-shell element");
        assert(dom.wheel, "Should have .scrubber-wheel element");
        assert(dom.text, "Should have .scrubber-text element");
        assert(dom.thumb, "Should have .scrubber-thumb element");
        assert(dom.edgeButtons === 4, `Should have 4 edge buttons, got ${dom.edgeButtons}`);
    },

    /** Expansion has visible height (> 100px) when .expanded class is set. */
    async "expanded: expansion visible when expanded class set"(page) {
        await clickAccount(page);
        const file = await findFirstFileRow(page);
        if (!file) return;
        await clickTrackAndWaitForPlaybackReady(page, file);
        await page.evaluate(() => {
            const footer = document.getElementById("footer");
            const expansion = footer.querySelector(".expansion");
            footer.classList.add("expanded");
            expansion.style.maxHeight = expansion.scrollHeight + "px";
        });
        await page.waitForFunction(() => {
            const expansion = document.getElementById("footer")?.querySelector(".expansion");
            return !!expansion && expansion.getBoundingClientRect().height > 100;
        }, undefined, { timeout: 3000 });
        const height = await page.evaluate(() => {
            const expansion = document.getElementById("footer").querySelector(".expansion");
            return expansion.getBoundingClientRect().height;
        });
        assert(height > 100, `Expansion height should be > 100px when expanded, got ${height}`);
    },

    // -- Favorites ------------------------------------------------------------

    /** Favorites: fav icons visible (either from persisted data or test-created). */
    async "favorites: fav icons visible at root"(page) {
        if (!await ensureFavoritesExist(page)) return;
        const iconCount = await page.evaluate(() =>
            document.querySelectorAll("#children .fav-icon").length
        );
        assert(iconCount >= 1, `Expected >= 1 fav icons, got ${iconCount}`);
    },

    /** Navigate into favorite, click breadcrumb to go back. */
    async "favorites: breadcrumbs work in favorites"(page) {
        if (!await ensureFavoritesExist(page)) return;
        const starRow = page.locator("#children .tree-row.folder").filter({
            has: page.locator(".fav-icon", { hasText: "☆" })
        }).first();
        if (await starRow.count() === 0) return;
        await starRow.click();
        await waitForBreadcrumbCount(page, 2);
        // Click first subfolder to go deeper
        const subfolder = page.locator("#children .tree-row.folder").first();
        if (await subfolder.count() > 0) {
            await subfolder.click();
            await waitForBreadcrumbCount(page, 3);
        }
        // Click OnePlay Music breadcrumb to go back to root
        await page.locator("#breadcrumbs .tree-row", { hasText: "OnePlay Music" }).click();
        await waitForBreadcrumbCount(page, 1);
        const breadcrumbCount = await page.locator("#breadcrumbs .tree-row").count();
        assert(breadcrumbCount === 1, `Expected 1 breadcrumb at root, got ${breadcrumbCount}`);
    },

    /** Reload page — favorites still present (persisted in IndexedDB). */
    async "favorites: persist across reload"(page) {
        let before = await page.evaluate(() =>
            document.querySelectorAll("#children .fav-icon").length
        );
        if (before === 0) return; // skip if no persisted favorites
        await page.goto(URL, { waitUntil: "domcontentloaded" });
        await page.waitForSelector("#tree-container:not([hidden])", { timeout: 15000 });
        await waitForFavIconCount(page, 1, 10000);
        const after = await page.evaluate(() =>
            document.querySelectorAll("#children .fav-icon").length
        );
        assert(after >= 1, `Expected >= 1 fav icons after reload, got ${after}`);
    },

    /** Favorite rows never show cloud/warning account icons. */
    async "favorites: no account icons on favorites"(page) {
        const accountIconOnFavs = await page.evaluate(() => {
            const rows = document.querySelectorAll("#children .tree-row");
            for (const row of rows) {
                const icon = row.querySelector(".fav-icon");
                const rowIcon = row.querySelector(".row-icon");
                if (icon && rowIcon && /[☁⚠]/.test(rowIcon.textContent || "")) return true;
            }
            return false;
        });
        assert(!accountIconOnFavs, "Favorite rows should not have account status icons");
    },

    // -- Select mode ----------------------------------------------------------

    /** Right-click on a child row enters select mode. */
    async "select: right-click enters select mode"(page) {
        await clickAccount(page);
        const row = page.locator("#children .tree-row[data-path]").first();
        await row.click({ button: "right" });
        await waitForSelectMode(page, true);
        const state = await page.evaluate(() => ({
            hasSelectMode: document.body.classList.contains("select-mode"),
            checkboxCount: document.querySelectorAll("#children .select-check").length,
            actionBarVisible: getComputedStyle(document.getElementById("action-bar")).display !== "none",
            cancelVisible: getComputedStyle(document.getElementById("select-cancel")).display !== "none",
        }));
        assert(state.hasSelectMode, "body should have select-mode class");
        assert(state.checkboxCount >= 1, `Expected checkboxes, got ${state.checkboxCount}`);
        assert(state.actionBarVisible, "Action bar should be visible");
        assert(state.cancelVisible, "Cancel button should be visible");
    },

    /** Same-path re-render (entering select mode) preserves live scroll position. */
    async "select: entering mode preserves live scroll position"(page) {
        const prevFlipSeq = await getTestSeq(page, "_testTreeFlipSeq");
        await clickAccount(page);
        await waitForFlipSettled(page, prevFlipSeq);
        const baseline = await page.evaluate(() => {
            // Normalize layout so footer visibility changes don't affect this test.
            const footer = document.getElementById("footer");
            if (footer instanceof HTMLElement) {
                footer.classList.remove("expanded");
                footer.classList.remove("visible");
            }
            const children = document.getElementById("children");
            if (!(children instanceof HTMLElement)) return { ok: false, reason: "missing #children" };
            const maxScroll = Math.max(0, children.scrollHeight - children.clientHeight);
            if (maxScroll < 80) return { ok: false, reason: `insufficient overflow (${maxScroll})` };

            children.scrollTop = 0;
            const targetTop = Math.min(maxScroll, Math.max(40, maxScroll - 10));
            children.scrollTop = targetTop;

            const row = children.querySelector(".tree-row[data-path]");
            if (!(row instanceof HTMLElement)) return { ok: false, reason: "missing row" };
            const rect = row.getBoundingClientRect();
            row.dispatchEvent(new MouseEvent("contextmenu", {
                bubbles: true,
                cancelable: true,
                button: 2,
                clientX: rect.left + 24,
                clientY: rect.top + rect.height / 2,
            }));

            return { ok: true, targetTop };
        });
        assert(baseline.ok, `Expected scroll baseline setup: ${baseline.reason || "unknown"}`);
        await waitForSelectMode(page, true);
        const afterTop = await page.evaluate(() => {
            const children = document.getElementById("children");
            return children instanceof HTMLElement ? children.scrollTop : -1;
        });
        const delta = Math.abs(afterTop - baseline.targetTop);
        assert(delta <= 1, `Expected scrollTop preserved on select-mode re-render (target=${baseline.targetTop}, actual=${afterTop}, delta=${delta.toFixed(2)})`);
        await exitSelectMode(page);
    },

    /** Diagnostic-only: synthetic long-press + follow-up click should emit error log if immediate exit occurs. */
    async "select: long-press immediate-exit logs error"(page) {
        await clickAccount(page);
        await page.evaluate(() => {
            if (Array.isArray(window.__ONEPLAY_MUSIC_LOGS)) window.__ONEPLAY_MUSIC_LOGS.length = 0;
        });
        const target = await page.evaluate(() => {
            const children = document.getElementById("children");
            if (!(children instanceof HTMLElement)) return null;
            const row = children.querySelector(".tree-row[data-path]");
            if (!(row instanceof HTMLElement)) return null;
            const rect = row.getBoundingClientRect();
            const point = { x: rect.left + 24, y: rect.top + rect.height / 2 };
            row.dispatchEvent(new PointerEvent("pointerdown", {
                bubbles: true,
                pointerId: 71,
                isPrimary: true,
                button: 0,
                clientX: point.x,
                clientY: point.y,
            }));
            return { point, pathKey: row.dataset.path || "" };
        });
        assert(target, "Expected selectable row for long-press diagnostic test");

        await page.evaluate(() => new Promise((resolve) => {
            const deadline = performance.now() + 620;
            const tick = () => {
                if (performance.now() >= deadline) resolve(undefined);
                else requestAnimationFrame(tick);
            };
            tick();
        }));
        await waitForSelectMode(page, true);
        await page.evaluate(({ pathKey, point }) => {
            const rows = Array.from(document.querySelectorAll("#children .tree-row[data-path]"));
            const row = rows.find((r) => r instanceof HTMLElement && r.dataset.path === pathKey);
            if (!(row instanceof HTMLElement)) return;
            row.dispatchEvent(new PointerEvent("pointerup", {
                bubbles: true,
                pointerId: 71,
                isPrimary: true,
                button: 0,
                clientX: point.x,
                clientY: point.y,
            }));
            row.dispatchEvent(new MouseEvent("click", {
                bubbles: true,
                cancelable: true,
                button: 0,
                clientX: point.x,
                clientY: point.y,
            }));
        }, target);
        await waitForSelectMode(page, false);
        const hasDiagnosticError = await page.evaluate(() => {
            const logs = Array.isArray(window.__ONEPLAY_MUSIC_LOGS) ? window.__ONEPLAY_MUSIC_LOGS : [];
            return logs.some((entry) =>
                entry && entry.level === "error"
                && typeof entry.message === "string"
                && entry.message.includes("select: suspicious immediate exit after long-press"));
        });
        assert(hasDiagnosticError, "Expected long-press immediate-exit diagnostic logError entry");
    },

    /** Right-click on a selectable breadcrumb enters select mode. */
    async "select: right-click breadcrumb enters select mode"(page) {
        await clickAccount(page);
        await clickFirstFolder(page);
        await enterSelectViaRightClick(page, "#breadcrumbs .tree-row[data-path]:nth-child(3)");
        const breadcrumbChecked = await page.evaluate(() =>
            document.querySelectorAll("#breadcrumbs .select-check.checked").length
        );
        assert(breadcrumbChecked === 1,
            `Expected 1 checked breadcrumb after right-click, got ${breadcrumbChecked}`);
        await exitSelectMode(page);
    },

    /** Cancel exits select mode. */
    async "select: cancel exits select mode"(page) {
        await clickAccount(page);
        await enterSelectViaRightClick(page);
        // Verify we're in select mode
        let inSelectMode = await page.evaluate(() =>
            document.body.classList.contains("select-mode"));
        assert(inSelectMode, "Should be in select mode before cancel");
        // Click cancel
        await exitSelectMode(page);
        const state = await page.evaluate(() => ({
            hasSelectMode: document.body.classList.contains("select-mode"),
            checkboxCount: document.querySelectorAll("#children .select-check").length,
            actionBarHidden: getComputedStyle(document.getElementById("action-bar")).display === "none",
        }));
        assert(!state.hasSelectMode, "body should not have select-mode class after cancel");
        assert(state.checkboxCount === 0, `Expected 0 checkboxes, got ${state.checkboxCount}`);
        assert(state.actionBarHidden, "Action bar should be hidden after cancel");
    },

    /** Checkbox toggles on row click in select mode. */
    async "select: checkbox toggles on row click"(page) {
        await clickAccount(page);
        await enterSelectViaRightClick(page);
        // The first row should be checked (it was right-clicked to enter)
        const firstCheck = await page.evaluate(() => {
            const check = document.querySelector("#children .tree-row .select-check");
            if (!check) return null;
            const style = getComputedStyle(check);
            return {
                checked: check.classList.contains("checked"),
                background: style.backgroundColor,
                border: style.borderColor,
            };
        });
        assert(firstCheck?.checked, "First row should have checked checkbox after right-click");
        assert(firstCheck?.background === firstCheck?.border,
            `Checked checkbox fill and border should match, got background=${firstCheck?.background} border=${firstCheck?.border}`);
        assert(firstCheck?.background !== "rgb(255, 254, 249)",
            `Checked checkbox should be filled (not opaque unchecked color), got ${firstCheck?.background}`);
        // Click the second row to toggle it
        const secondRow = page.locator("#children .tree-row[data-path]").nth(1);
        if (await secondRow.count() > 0) {
            await secondRow.click();
            await page.waitForFunction(
                () => document.querySelectorAll("#children .select-check.checked").length === 2,
                undefined,
                { timeout: 2000 },
            );
            const checkedCount = await page.evaluate(() =>
                document.querySelectorAll("#children .select-check.checked").length
            );
            assert(checkedCount === 2, `Expected 2 checked after clicking second row, got ${checkedCount}`);
        }
        // Clean up
        await exitSelectMode(page);
    },

    /** Select mode shows checkboxes on selectable breadcrumbs only. */
    async "select: checkboxes on selectable breadcrumbs only"(page) {
        await clickAccount(page);
        await clickFirstFolder(page);
        await enterSelectViaRightClick(page, "#breadcrumbs .tree-row[data-path]:nth-child(3)");
        const state = await page.evaluate(() => {
            const rows = Array.from(document.querySelectorAll("#breadcrumbs .tree-row"));
            return rows.map((row, idx) => ({
                idx,
                name: row.querySelector(".row-name")?.textContent || "",
                hasCheck: row.querySelector(".select-check") !== null,
            }));
        });
        assert(!state[0].hasCheck, "OnePlay Music breadcrumb should not have a checkbox");
        const oneDrive = state.find(r => r.name === "OneDrive");
        assert(oneDrive && !oneDrive.hasCheck, "OneDrive breadcrumb should not have a checkbox");
        const selectableCount = state.filter(r => r.hasCheck).length;
        assert(selectableCount >= 1, `Expected >=1 selectable breadcrumb checkbox, got ${selectableCount}`);
        await exitSelectMode(page);
    },

    /** Clicking a selectable breadcrumb in select mode toggles selection, no navigation. */
    async "select: selectable breadcrumb toggles without nav"(page) {
        await clickAccount(page);
        await clickFirstFolder(page);
        await enterSelectViaRightClick(page);
        const beforeBreadcrumbs = await page.locator("#breadcrumbs .tree-row").count();
        await page.locator("#breadcrumbs .tree-row[data-path]").nth(2).click();
        await page.waitForFunction(
            () => document.querySelectorAll(".select-check.checked").length === 2,
            undefined,
            { timeout: 2000 },
        );
        const after = await page.evaluate(() => ({
            breadcrumbs: document.querySelectorAll("#breadcrumbs .tree-row").length,
            hasSelectMode: document.body.classList.contains("select-mode"),
            breadcrumbChecked: document.querySelectorAll("#breadcrumbs .select-check.checked").length,
        }));
        assert(after.breadcrumbs === beforeBreadcrumbs,
            `Expected breadcrumb count unchanged (${beforeBreadcrumbs}), got ${after.breadcrumbs}`);
        assert(after.hasSelectMode, "Select mode should remain active after selectable breadcrumb toggle");
        assert(after.breadcrumbChecked === 1,
            `Expected 1 checked breadcrumb after toggle, got ${after.breadcrumbChecked}`);
        await exitSelectMode(page);
    },

    /** OneDrive row is a no-op in select mode (does not navigate or exit). */
    async "select: OneDrive is no-op in select mode"(page) {
        await clickAccount(page);
        await clickFirstFolder(page);
        // We're now at depth 3, enter select mode
        await enterSelectViaRightClick(page);
        const beforeBreadcrumbs = await page.locator("#breadcrumbs .tree-row").count();
        const checkedBefore = await page.evaluate(() =>
            document.querySelectorAll(".select-check.checked").length
        );
        await page.locator("#breadcrumbs .tree-row", { hasText: "OneDrive" }).click();
        const after = await page.evaluate(() => ({
            breadcrumbs: document.querySelectorAll("#breadcrumbs .tree-row").length,
            hasSelectMode: document.body.classList.contains("select-mode"),
            checked: document.querySelectorAll(".select-check.checked").length,
        }));
        assert(after.breadcrumbs === beforeBreadcrumbs,
            `Expected breadcrumb count unchanged (${beforeBreadcrumbs}), got ${after.breadcrumbs}`);
        assert(after.hasSelectMode, "Expected select mode to remain active after OneDrive tap");
        assert(after.checked === checkedBefore,
            `Expected checked count unchanged (${checkedBefore}), got ${after.checked}`);
        await exitSelectMode(page);
    },

    /** OnePlay Music row is a no-op in select mode (does not navigate or exit). */
    async "select: OnePlay Music is no-op in select mode"(page) {
        await clickAccount(page);
        await clickFirstFolder(page);
        await enterSelectViaRightClick(page);
        const beforeBreadcrumbs = await page.locator("#breadcrumbs .tree-row").count();
        const checkedBefore = await page.evaluate(() =>
            document.querySelectorAll(".select-check.checked").length
        );
        await page.locator("#breadcrumbs .tree-row", { hasText: "OnePlay Music" }).click();
        const after = await page.evaluate(() => ({
            breadcrumbs: document.querySelectorAll("#breadcrumbs .tree-row").length,
            hasSelectMode: document.body.classList.contains("select-mode"),
            checked: document.querySelectorAll(".select-check.checked").length,
        }));
        assert(after.breadcrumbs === beforeBreadcrumbs,
            `Expected breadcrumb count unchanged (${beforeBreadcrumbs}), got ${after.breadcrumbs}`);
        assert(after.hasSelectMode, "Expected select mode to remain active after OnePlay Music tap");
        assert(after.checked === checkedBefore,
            `Expected checked count unchanged (${checkedBefore}), got ${after.checked}`);
        await exitSelectMode(page);
    },

    /** Action bar text updates with selection count (type-aware summary). */
    async "select: action bar text updates"(page) {
        await clickAccount(page);
        await enterSelectViaRightClick(page);
        const text = await page.evaluate(() =>
            document.querySelector(".action-bar-text")?.textContent
        );
        // After selecting one folder row: "1 Folder"
        assert(text && text.includes("1"), `Expected text with "1", got "${text}"`);
        // Click second row
        const secondRow = page.locator("#children .tree-row[data-path]").nth(1);
        if (await secondRow.count() > 0) {
            await secondRow.click();
            await page.waitForFunction(
                () => (document.querySelector(".action-bar-text")?.textContent || "").includes("2"),
                undefined,
                { timeout: 2000 },
            );
            const text2 = await page.evaluate(() =>
                document.querySelector(".action-bar-text")?.textContent
            );
            assert(text2 && text2.includes("2"), `Expected text with "2", got "${text2}"`);
        }
        await exitSelectMode(page);
    },

    /** Entering select mode must not shift row text x-position. */
    async "select: entering mode does not shift text"(page) {
        await clickAccount(page);
        const before = await page.evaluate(() => {
            const name = document.querySelector("#children .tree-row[data-path] .row-name");
            return name ? name.getBoundingClientRect().left : null;
        });
        assert(before !== null, "Expected a row name before entering select mode");
        await enterSelectViaRightClick(page);
        const after = await page.evaluate(() => {
            const name = document.querySelector("#children .tree-row[data-path] .row-name");
            return name ? name.getBoundingClientRect().left : null;
        });
        assert(after !== null, "Expected a row name after entering select mode");
        const delta = Math.abs(after - before);
        assert(delta <= 0.75, `Expected row text x-shift <= 0.75px, got ${delta.toFixed(2)}px`);
        await exitSelectMode(page);
    },

    /** Horizontal scroll in children keeps checkbox x-position fixed. */
    async "select: horizontal scroll keeps checkbox fixed"(page) {
        const prevFlipSeq = await getTestSeq(page, "_testTreeFlipSeq");
        await clickAccount(page);
        await waitForFlipSettled(page, prevFlipSeq);
        await enterSelectViaRightClick(page);
        const result = await page.evaluate(async () => {
            const children = document.getElementById("children");
            const row = children?.querySelector(".tree-row[data-path]");
            const name = row?.querySelector(".row-name");
            const check = row?.querySelector(".select-check");
            if (!children || !row || !name || !check) return { ok: false, reason: "missing nodes" };
            row.style.width = "2000px";
            row.style.minWidth = "2000px";
            const spacer = document.createElement("div");
            spacer.style.width = "2500px";
            spacer.style.height = "1px";
            children.appendChild(spacer);
            children.scrollLeft = 0;
            await new Promise(requestAnimationFrame);
            const maxScroll = children.scrollWidth - children.clientWidth;
            if (maxScroll < 80) return { ok: false, reason: `insufficient overflow (${maxScroll})` };
            const before = {
                checkLeft: check.getBoundingClientRect().left,
                nameLeft: name.getBoundingClientRect().left,
                scrollLeft: children.scrollLeft,
            };
            children.scrollLeft = Math.min(180, maxScroll);
            await new Promise(requestAnimationFrame);
            const after = {
                checkLeft: check.getBoundingClientRect().left,
                nameLeft: name.getBoundingClientRect().left,
                scrollLeft: children.scrollLeft,
            };
            return {
                ok: true,
                checkDelta: after.checkLeft - before.checkLeft,
                nameDelta: after.nameLeft - before.nameLeft,
                scrollDelta: after.scrollLeft - before.scrollLeft,
            };
        });
        assert(result.ok, `Expected horizontal overflow test setup to succeed: ${result.reason || "unknown"}`);
        assert(Math.abs(result.scrollDelta) >= 40,
            `Expected horizontal scroll delta >= 40px, got ${result.scrollDelta.toFixed(2)}px`);
        assert(Math.abs(result.checkDelta) <= 0.75,
            `Expected checkbox x-shift <= 0.75px during horizontal scroll, got ${result.checkDelta.toFixed(2)}px`);
        await exitSelectMode(page);
    },

    /** Share button is always visible in select mode (always has at least "New Playlist"). */
    async "select: share button always visible"(page) {
        await clickAccount(page);
        await enterSelectViaRightClick(page);
        const shareVisible = await page.evaluate(() => {
            const btn = document.querySelector('#action-bar .share-btn');
            return btn && getComputedStyle(btn).visibility !== 'hidden';
        });
        assert(shareVisible, "Share button should be visible when row selected");
        await exitSelectMode(page);
    },

    /** Single-favorite offline modal exits select mode when opened from action-bar menu. */
    async "select: offline modal exits select mode on open"(page) {
        if (!await ensureFavoritesExist(page)) return;
        const favRow = page.locator("#children .tree-row", {
            has: page.locator(".fav-icon"),
        }).first();
        if (await favRow.count() === 0) return;

        await favRow.click({ button: "right" });
        await waitForSelectMode(page, true);

        await page.locator("#action-bar .right-btn").click();
        await waitForActionDropdown(page);

        const offlineItem = page.locator(".action-dropdown button", {
            hasText: /Available offline|Make available offline/i,
        }).first();
        assert(await offlineItem.count() > 0, "Expected offline menu item in favorite dropdown");

        await offlineItem.click();
        await waitForSelectMode(page, false);

        const hasOfflineModal = await page.evaluate(() =>
            Array.from(document.querySelectorAll(".modal h3"))
                .some(h => /Available Offline|Make Available Offline/i.test(h.textContent || ""))
        );
        assert(hasOfflineModal, "Expected offline modal to open");

        const closeBtn = page.locator(".modal .modal-close").first();
        if (await closeBtn.count() > 0) {
            await closeBtn.click();
        }
        await page.waitForSelector(".modal-backdrop", { state: "hidden", timeout: 3000 });
    },

    /** Create playlist modal disables Create until name is non-empty and unique. */
    async "select: create playlist name validation disables Create"(page) {
        if (!await ensureFavoritesExist(page)) return;
        const duplicateName = await page.evaluate(() => {
            const favs = window._testFavorites;
            if (!favs) return "";
            const first = favs.getAll().find(f => f.kind === "playlist");
            return first ? first.name : "";
        });
        if (!duplicateName) return;
        await clickAccount(page);
        await enterSelectViaRightClick(page);

        await page.locator("#action-bar .share-btn").click();
        await waitForActionDropdown(page);
        await page.locator(".action-dropdown button", { hasText: "Put in new playlist" }).first().click();

        const input = page.locator(".modal input[type='text']").first();
        const createBtn = page.locator(".modal .modal-confirm", { hasText: "Create" }).first();
        await page.waitForFunction(() => {
            const el = document.querySelector(".modal input[type='text']");
            return !!el && document.activeElement === el;
        }, undefined, { timeout: 2000 });
        const createBackdropTopBiased = await page.evaluate(() =>
            document.querySelector(".modal-backdrop")?.classList.contains("text-entry-modal") === true
        );
        assert(createBackdropTopBiased, "Create playlist modal should use top-biased backdrop");
        assert(await createBtn.isDisabled(), "Create should be disabled for empty name");

        await input.fill(duplicateName);
        assert(await createBtn.isDisabled(), "Create should be disabled for duplicate playlist name");

        await input.fill(`Unique Playlist ${Date.now()}`);
        assert(!(await createBtn.isDisabled()), "Create should be enabled for unique non-empty name");

        await page.locator(".modal .modal-cancel").first().click();
        await page.waitForSelector(".modal-backdrop", { state: "hidden", timeout: 3000 });
        await exitSelectMode(page);
    },

    /** Rename modal disables Save until name is non-empty and unique among playlists. */
    async "select: rename playlist name validation disables Save"(page) {
        if (!await ensureAtLeastTwoPlaylists(page)) return;

        const playlistRow = page.locator("#children .tree-row", {
            has: page.locator(".fav-icon", { hasText: "♫" }),
        }).first();
        if (await playlistRow.count() === 0) return;

        const selectedName = (await playlistRow.locator(".row-name").first().textContent())?.trim() || "";
        const duplicateName = await page.evaluate((name) => {
            const favs = window._testFavorites;
            if (!favs) return "";
            const names = favs.getAll()
                .filter(f => f.kind === "playlist")
                .map(f => f.name.trim());
            return names.find(n => n && n !== name) || "";
        }, selectedName);
        if (!duplicateName) return;

        await playlistRow.click({ button: "right" });
        await waitForSelectMode(page, true);

        await page.locator("#action-bar .right-btn").click();
        await waitForActionDropdown(page);
        await page.locator(".action-dropdown button", { hasText: "Rename" }).first().click();
        await waitForSelectMode(page, false);

        const input = page.locator(".modal input[type='text']").first();
        const saveBtn = page.locator(".modal .modal-confirm", { hasText: "Save" }).first();
        await page.waitForFunction(() => {
            const el = document.querySelector(".modal input[type='text']");
            return !!el && document.activeElement === el;
        }, undefined, { timeout: 2000 });
        const renameBackdropTopBiased = await page.evaluate(() =>
            document.querySelector(".modal-backdrop")?.classList.contains("text-entry-modal") === true
        );
        assert(renameBackdropTopBiased, "Rename modal should use top-biased backdrop");

        await input.fill("   ");
        assert(await saveBtn.isDisabled(), "Save should be disabled for empty name");

        await input.fill(duplicateName);
        assert(await saveBtn.isDisabled(), "Save should be disabled for duplicate playlist name");

        await input.fill(`${selectedName} ${Date.now()}`);
        assert(!(await saveBtn.isDisabled()), "Save should be enabled for unique non-empty name");

        await page.locator(".modal .modal-cancel").first().click();
        await page.waitForSelector(".modal-backdrop", { state: "hidden", timeout: 3000 });
    },

    /** Favorite badges are non-interactive: tapping icon navigates, no popup. */
    async "favorites: tapping fav badge navigates without popup"(page) {
        if (!await ensureFavoritesExist(page)) return;
        const favoriteRow = page.locator("#children .tree-row.folder", {
            has: page.locator(".fav-icon"),
        }).first();
        if (await favoriteRow.count() === 0) return;

        const favIcon = favoriteRow.locator(".fav-icon").first();
        await favIcon.click();
        await waitForBreadcrumbCount(page, 2);

        const dropdownCount = await page.locator(".action-dropdown").count();
        assert(dropdownCount === 0, `Expected no dropdown from favorite badge tap, got ${dropdownCount}`);
    },

    /** Select mode hides the footer and shows action bar. */
    async "select: footer hidden in select mode"(page) {
        await clickAccount(page);
        await enterSelectViaRightClick(page);
        const state = await page.evaluate(() => ({
            footerDisplay: getComputedStyle(document.getElementById("footer")).display,
            actionBarDisplay: getComputedStyle(document.getElementById("action-bar")).display,
        }));
        assert(state.footerDisplay === "none", `Footer should be hidden, got ${state.footerDisplay}`);
        assert(state.actionBarDisplay !== "none", "Action bar should be visible");
        await exitSelectMode(page);
    },

    /** DOM structure: #action-bar and #select-cancel exist. */
    async "select: DOM elements exist"(page) {
        const exists = await page.evaluate(() => ({
            actionBar: document.getElementById("action-bar") !== null,
            selectCancel: document.getElementById("select-cancel") !== null,
        }));
        assert(exists.actionBar, "action-bar element should exist");
        assert(exists.selectCancel, "select-cancel element should exist");
    },

    /** Right-click a non-shortcut OneDrive folder, open share popup,
     *  click "Add as Shortcut", verify modal, click Create, verify shortcut. */
    async "select: shortcut modal creates shortcut"(page) {
        await clickAccount(page);
        // Suppress saves so test data isn't persisted
        await page.evaluate(() => {
            const favs = window._testFavorites;
            if (favs) favs._testOnlySuppressSave(true);
        });
        // Find a folder that isn't already a shortcut
        const targetName = await page.evaluate(() => {
            const favs = window._testFavorites;
            if (!favs) return null;
            const shortcuts = favs.getAll()
                .filter(f => f.kind === "shortcut")
                .map(f => f.name);
            const rows = document.querySelectorAll("#children .tree-row[data-path]");
            for (const r of rows) {
                const name = r.textContent.trim();
                if (!shortcuts.includes(name)) return name;
            }
            return null;
        });
        assert(targetName, "Should find a non-shortcut folder");
        // Right-click the target to enter select mode
        await page.locator("#children .tree-row", { hasText: targetName }).click({ button: "right" });
        await waitForSelectMode(page, true);
        // Click share button to open popup
        await page.locator("#action-bar .share-btn").click();
        await waitForActionDropdown(page);
        // Click "Add as Shortcut" in the popup
        const hasShortcutOption = await page.locator(".action-dropdown button", { hasText: "Add as Shortcut" }).count();
        assert(hasShortcutOption > 0, "Share popup should have 'Add as Shortcut' option");
        await page.locator(".action-dropdown button", { hasText: "Add as Shortcut" }).click();
        await page.locator(".modal").waitFor({ state: "visible", timeout: 3000 });
        // Verify modal
        const modal = await page.evaluate(() => {
            const m = document.querySelector(".modal");
            if (!m) return null;
            return {
                title: m.querySelector("h3")?.textContent || "",
                hasCheckbox: m.querySelector("input[type='checkbox']") !== null,
                buttons: Array.from(m.querySelectorAll("button")).map(b => b.textContent.trim()),
            };
        });
        assert(modal, "Shortcut modal should appear");
        assert(modal.title === "Add new shortcut", `Title should be "Add new shortcut", got "${modal.title}"`);
        assert(modal.hasCheckbox, "Modal should have hasPrivatePlayback checkbox");
        assert(modal.buttons.includes("Create"), "Modal should have Create button");
        assert(modal.buttons.includes("Cancel"), "Modal should have Cancel button");
        // Count favorites before
        const countBefore = await page.evaluate(() =>
            window._testFavorites.getAll().length);
        // Click Create
        await page.locator(".modal button", { hasText: "Create" }).click();
        await waitForSelectMode(page, false);
        await page.waitForFunction((beforeCount) => {
            const favs = window._testFavorites;
            return !!favs && favs.getAll().length === beforeCount + 1;
        }, countBefore, { timeout: 5000 });
        // Verify: select mode exited, shortcut added
        const after = await page.evaluate(() => ({
            selectMode: document.body.classList.contains("select-mode"),
            favCount: window._testFavorites.getAll().length,
        }));
        assert(!after.selectMode, "Select mode should exit after create");
        assert(after.favCount === countBefore + 1, `Favorite count should increase by 1 (was ${countBefore}, now ${after.favCount})`);
    },

};
