const URL = globalThis.__ONEPLAY_TEST_URL;

module.exports = {

    // -- Tree loading ---------------------------------------------------------

    /** Tree loads with at least one breadcrumb and one child row. */
    async "tree: loads with root and account"(page) {
        const breadcrumbCount = await page.locator("#breadcrumbs .tree-row").count();
        assert(breadcrumbCount >= 1, `Expected breadcrumbs >= 1, got ${breadcrumbCount}`);
        const childCount = await page.locator("#children .tree-row").count();
        assert(childCount >= 1, `Expected children >= 1, got ${childCount}`);
    },

    // -- Indentation ----------------------------------------------------------

    /** Breadcrumbs indent progressively by depth (indent-0, indent-1, ...). */
    async "indent: breadcrumbs indent by depth"(page) {
        await clickAccount(page);
        await clickFirstFolder(page);
        const classes = await page.evaluate(() =>
            Array.from(document.querySelectorAll("#breadcrumbs .tree-row"))
                .map(el => el.className)
        );
        assert(classes[0].includes("indent-0"), `Root should be indent-0, got: ${classes[0]}`);
        assert(classes[1].includes("indent-1"), `Account should be indent-1, got: ${classes[1]}`);
        assert(classes[2].includes("indent-2"), `Folder should be indent-2, got: ${classes[2]}`);
    },

    /** Children indent one level deeper than their parent breadcrumb. */
    async "indent: children indent deeper than parent"(page) {
        await clickAccount(page);
        const childClasses = await page.evaluate(() =>
            Array.from(document.querySelectorAll("#children .tree-row.folder"))
                .slice(0, 3)
                .map(el => el.className)
        );
        for (const cls of childClasses) {
            assert(cls.includes("indent-2"), `Child of account should be indent-2, got: ${cls}`);
        }
    },

    // -- Navigation -----------------------------------------------------------

    /** Clicking a breadcrumb navigates back up to that level. */
    async "nav: breadcrumb click navigates up"(page) {
        await clickAccount(page);
        await clickFirstFolder(page);
        await page.locator("#breadcrumbs .tree-row", { hasText: "OnePlay Music" }).click();
        await waitForBreadcrumbCount(page, 1);
        const breadcrumbCount = await page.locator("#breadcrumbs .tree-row").count();
        assert(breadcrumbCount === 1, `Expected 1 breadcrumb after nav to root, got ${breadcrumbCount}`);
    },

    // -- Search ---------------------------------------------------------------

    /** Opening search swaps in the search header; closing restores tree rows. */
    async "search: open and close toggles search header"(page) {
        await openSearchMode(page);
        await page.waitForFunction(() => {
            const input = document.querySelector("#breadcrumbs .search-input");
            return input !== null && document.activeElement === input;
        }, undefined, { timeout: 3000 });
        await closeSearchMode(page);
        const breadcrumbRows = await page.locator("#breadcrumbs .tree-row").count();
        assert(breadcrumbRows >= 1, `Expected normal breadcrumbs after close, got ${breadcrumbRows}`);
    },

    /** Opening search exits select mode before rendering search results. */
    async "search: opening search exits select mode"(page) {
        await enterSelectViaRightClick(page);
        await openSearchMode(page);
        await waitForSelectMode(page, false);
        const inSelect = await page.evaluate(() => document.body.classList.contains("select-mode"));
        assert(!inSelect, "Expected select mode to be cleared when search opens");
    },

    /** Opening search collapses expanded playback controls. */
    async "search: opening search collapses expanded playback"(page) {
        const firstFile = await findFirstFileRow(page);
        assert(firstFile, "Expected at least one playable track row");
        await clickTrackAndWaitForPlaybackReady(page, firstFile);
        await page.locator("#footer .footer-gripper").click();
        await page.waitForFunction(
            () => document.getElementById("footer")?.classList.contains("expanded") === true,
            undefined,
            { timeout: 3000 },
        );
        await openSearchMode(page);
        const expanded = await page.evaluate(() =>
            document.getElementById("footer")?.classList.contains("expanded") === true);
        assert(!expanded, "Expected search open to collapse expanded playback");
    },

    /** Track-hit click closes search, selects parent folder, and starts playback. */
    async "search: track hit navigates and starts playback"(page) {
        const fixture = await getFirstOneDriveTrackFixture(page);
        assert(fixture, "Expected OneDrive track fixture");
        await openSearchMode(page);
        await setSearchQuery(page, fixture.fileName);
        await page.waitForFunction(
            () => document.querySelectorAll("#children .tree-row.file").length > 0,
            undefined,
            { timeout: 5000 },
        );
        const firstTrackPath = await page.locator("#children .tree-row.file").first().getAttribute("data-path");
        assert(firstTrackPath, "Expected first search-track row to have data-path");
        const expectedParentPath = JSON.stringify(JSON.parse(firstTrackPath).slice(0, -1));
        const prevPlaybackSeq = await getTestSeq(page, "_testPlaybackSeq");
        await page.locator("#children .tree-row.file").first().click();
        await waitForPlaybackReady(page, prevPlaybackSeq);
        await page.waitForSelector("#breadcrumbs .search-header", { state: "hidden", timeout: 3000 });
        const selectedPath = await page.evaluate(() =>
            document.querySelector("#breadcrumbs .tree-row.selected")?.dataset.path || "");
        assert(selectedPath === expectedParentPath,
            `Expected selected folder ${expectedParentPath}, got ${selectedPath}`);
    },

    /** Denied-root filtering removes favorites whose direct members point at denied roots. */
    async "search: denied-root favorites members are filtered"(page) {
        const fixture = await getFirstShareTrackFixture(page) || await getFirstOneDriveTrackFixture(page);
        assert(fixture, "Expected track fixture for denied-root search test");
        const query = `M15Denied ${Date.now()}`;
        await page.evaluate(async ({ data, q }) => {
            const favs = window._testFavorites;
            const shares = window._testShares;
            if (!favs || !shares) return;
            favs._testOnlySuppressSave(true);
            await favs.add({
                kind: "playlist",
                id: crypto.randomUUID(),
                name: q,
                members: [{
                    driveId: data.driveId,
                    itemId: data.fileId,
                    path: [...data.folderPath, data.fileName],
                    isFolder: false,
                    sourceRootKey: data.rootKey,
                }],
                hasPrivatePlayback: false,
            });
            shares.setDeniedState(data.rootKey, "Permission denied (403)");
        }, { data: fixture, q: query });

        await openSearchMode(page);
        await setSearchQuery(page, query);
        await page.waitForFunction(
            () => document.querySelectorAll("#children .tree-row").length === 0,
            undefined,
            { timeout: 5000 },
        );
        const rowCount = await page.locator("#children .tree-row").count();
        assert(rowCount === 0, `Expected denied-root favorite to be filtered out, got ${rowCount} rows`);
        await page.evaluate((rootKey) => {
            window._testShares?.setDeniedState(rootKey, undefined);
        }, fixture.rootKey);
    },

    /** Terminal evidence states show no non-cached track hits. */
    async "search: terminal evidence filters non-cached tracks"(page) {
        const fixture = await getFirstOneDriveTrackFixture(page);
        assert(fixture, "Expected OneDrive track fixture");
        await page.evaluate(async () => {
            await window._testDownloads?.clear();
            window._testAuth?.transition("evidence:not-online");
        });
        await openSearchMode(page);
        await setSearchQuery(page, fixture.fileName);
        await page.waitForFunction(
            () => document.querySelectorAll("#children .tree-row.file").length === 0,
            undefined,
            { timeout: 5000 },
        );
        const trackCount = await page.locator("#children .tree-row.file").count();
        assert(trackCount === 0, `Expected no track hits in terminal evidence state, got ${trackCount}`);
        await page.evaluate(() => window._testAuth?.transition("evidence:signed-in"));
    },

    // -- Log toggle -----------------------------------------------------------

    /** Clipboard log icon is debug-only; when debug is enabled, tapping it toggles the log panel. */
    async "log: clipboard icon is debug-only and toggles panel"(page) {
        await openSettingsPage(page);
        const maybeTurnOff = page.locator("#settings-container button", { hasText: "Turn off" }).first();
        if (await maybeTurnOff.count() > 0) await maybeTurnOff.click();
        await closeSettingsPage(page);

        const hiddenByDefault = await page.locator(".row-icon", { hasText: "📋" }).count();
        assert(hiddenByDefault === 0, `Expected no clipboard icon by default, got ${hiddenByDefault}`);

        await openSettingsPage(page);
        await page.locator("#settings-container button", { hasText: "Turn on" }).click();
        await closeSettingsPage(page);

        const logBefore = await page.evaluate(() =>
            document.getElementById("log-panel").classList.contains("visible"));
        assert(!logBefore, "Log panel should start hidden");

        await page.locator(".row-icon", { hasText: "📋" }).click();
        const logAfter = await page.evaluate(() =>
            document.getElementById("log-panel").classList.contains("visible"));
        assert(logAfter, "Log panel should be visible after click");

        await page.locator(".row-icon", { hasText: "📋" }).click();
        const logFinal = await page.evaluate(() =>
            document.getElementById("log-panel").classList.contains("visible"));
        assert(!logFinal, "Log panel should be hidden after second click");
    },

    // -- Settings -------------------------------------------------------------

    /** OnePlay Music owns settings/warning icon; OneDrive rows have no cloud/warning icon. */
    async "settings: icon ownership is OnePlay Music-only"(page) {
        const state = await page.evaluate(() => {
            const myMusic = document.querySelector("#breadcrumbs .tree-row");
            const myMusicHasSettingsIcon = Array.from(myMusic?.querySelectorAll(".row-icon") || [])
                .some(el => /[☰⚠]/.test(el.textContent || ""));
            const oneDriveRows = Array.from(document.querySelectorAll(".tree-row"))
                .filter(row => row.querySelector(".row-name")?.textContent === "OneDrive");
            const oneDriveHasCloudOrWarning = oneDriveRows.some(row =>
                Array.from(row.querySelectorAll(".row-icon")).some(el => /[☁⚠]/.test(el.textContent || "")));
            return { myMusicHasSettingsIcon, oneDriveHasCloudOrWarning };
        });
        assert(state.myMusicHasSettingsIcon, "OnePlay Music row should expose menu/warning icon");
        assert(!state.oneDriveHasCloudOrWarning, "OneDrive rows should not show cloud/warning icon");
    },

    /** Signed-out evidence flips the OnePlay Music menu icon from ☰ to ⚠. */
    async "settings: signed-out evidence shows warning icon"(page) {
        await page.evaluate(() => window._testAuth.transition("evidence:signed-out"));
        await page.waitForFunction(() => {
            const row = document.querySelector("#breadcrumbs .tree-row");
            return !!row && Array.from(row.querySelectorAll(".row-icon")).some(el => (el.textContent || "").includes("⚠"));
        }, undefined, { timeout: 3000 });
        const warningStyle = await page.evaluate(() => {
            const row = document.querySelector("#breadcrumbs .tree-row");
            const icon = row ? Array.from(row.querySelectorAll(".row-icon"))
                .find((el) => (el.textContent || "").includes("⚠")) : null;
            if (!(icon instanceof HTMLElement)) return { hasWarningClass: false, color: "" };
            return {
                hasWarningClass: icon.classList.contains("row-icon-warning"),
                color: getComputedStyle(icon).color,
            };
        });
        const warningRgb = (warningStyle.color.match(/\d+/g) || []).map(Number);
        assert(warningStyle.hasWarningClass, "Expected signed-out warning icon to have row-icon-warning class");
        assert(warningRgb.length >= 3 && warningRgb[0] > 150 && warningRgb[1] < 120 && warningRgb[2] < 120,
            `Expected warning icon to be red-ish, got "${warningStyle.color}"`);
        await page.evaluate(() => window._testAuth.transition("evidence:signed-in"));
        await page.waitForFunction(() => {
            const row = document.querySelector("#breadcrumbs .tree-row");
            return !!row && Array.from(row.querySelectorAll(".row-icon")).some(el => (el.textContent || "").includes("☰"));
        }, undefined, { timeout: 3000 });
    },

    /** Latest index failure flips OnePlay Music menu icon to warning and clears back to menu. */
    async "settings: latest index failure shows warning icon"(page) {
        await page.evaluate(() => {
            window._testSetLatestIndexFailure?.({
                label: "Pending Share",
                message: "Probe failed (503)",
            });
        });
        await page.waitForFunction(() => {
            const row = document.querySelector("#breadcrumbs .tree-row");
            return !!row && Array.from(row.querySelectorAll(".row-icon")).some((el) => (el.textContent || "").includes("⚠"));
        }, undefined, { timeout: 3000 });
        const warningClass = await page.evaluate(() => {
            const row = document.querySelector("#breadcrumbs .tree-row");
            const icon = row ? Array.from(row.querySelectorAll(".row-icon"))
                .find((el) => (el.textContent || "").includes("⚠")) : null;
            return icon instanceof HTMLElement && icon.classList.contains("row-icon-warning");
        });
        assert(warningClass, "Expected warning icon class when latest index failure is set");

        await page.evaluate(() => {
            window._testSetLatestIndexFailure?.();
        });
        await page.waitForFunction(() => {
            const row = document.querySelector("#breadcrumbs .tree-row");
            return !!row && Array.from(row.querySelectorAll(".row-icon")).some((el) => (el.textContent || "").includes("☰"));
        }, undefined, { timeout: 3000 });
    },

    /** Tapping a share root without loaded data opens Settings instead of inert folder navigation. */
    async "settings: share without data tap opens settings"(page) {
        await page.evaluate(() => {
            const tree = window._testTree;
            if (!tree) return;
            const existingShares = [];
            for (const [key, root] of tree.getRoots()) {
                if (root.type !== "share") continue;
                existingShares.push({
                    key,
                    name: root.name,
                    driveId: root.driveId,
                    folder: root.folder,
                    reindexing: root.reindexing,
                });
            }
            tree.setShareRoots([
                ...existingShares,
                {
                    key: "share:test-no-data",
                    name: "Pending Share",
                    driveId: "drive-test",
                    reindexing: false,
                },
            ]);
            tree.setSelectedPath(["OnePlay Music"]);
        });
        const before = await page.evaluate(() => JSON.stringify(window._testTree?.getSelectedPath?.() || []));
        await page.locator("#children .tree-row.folder", { hasText: "Pending Share" }).click();
        await waitForSettingsOpen(page);
        const after = await page.evaluate(() => JSON.stringify(window._testTree?.getSelectedPath?.() || []));
        assert(after === before, `Expected selectedPath unchanged after tapping share without data (${before}), got ${after}`);
        await closeSettingsPage(page);
        await page.evaluate(() => {
            const tree = window._testTree;
            if (!tree) return;
            const restoredShares = [];
            for (const [key, root] of tree.getRoots()) {
                if (root.type !== "share" || key === "share:test-no-data") continue;
                restoredShares.push({
                    key,
                    name: root.name,
                    driveId: root.driveId,
                    folder: root.folder,
                    reindexing: root.reindexing,
                });
            }
            tree.setShareRoots(restoredShares);
            tree.setSelectedPath(["OnePlay Music"]);
        });
    },

    /** Opening/closing settings preserves selected path and scroll exactly. */
    async "settings: close restores tree path and scroll"(page) {
        await clickAccount(page);
        await clickFirstFolder(page);
        const before = await page.evaluate(() => {
            const children = document.getElementById("children");
            const max = Math.max(0, children.scrollHeight - children.clientHeight);
            children.scrollTop = Math.min(120, max);
            return {
                selectedPath: document.querySelector("#breadcrumbs .tree-row.selected")?.dataset.path || "",
                scrollTop: children.scrollTop,
                scrollLeft: children.scrollLeft,
            };
        });

        await openSettingsPage(page);
        await closeSettingsPage(page);

        const after = await page.evaluate(() => {
            const children = document.getElementById("children");
            return {
                selectedPath: document.querySelector("#breadcrumbs .tree-row.selected")?.dataset.path || "",
                scrollTop: children.scrollTop,
                scrollLeft: children.scrollLeft,
            };
        });
        assert(after.selectedPath === before.selectedPath,
            `Expected selected path to round-trip (${before.selectedPath}), got ${after.selectedPath}`);
        assert(after.scrollTop === before.scrollTop,
            `Expected scrollTop to round-trip (${before.scrollTop}), got ${after.scrollTop}`);
        assert(after.scrollLeft === before.scrollLeft,
            `Expected scrollLeft to round-trip (${before.scrollLeft}), got ${after.scrollLeft}`);
    },

    /** Any click target in the settings title bar closes settings; body taps do not. */
    async "settings: entire title bar closes settings"(page) {
        const assertClosed = async (label) => {
            await page.waitForSelector("#tree-container:not([hidden])", { timeout: 3000 });
            const state = await page.evaluate(() => ({
                settingsHidden: !!document.getElementById("settings-container")?.hidden,
                treeHidden: !!document.getElementById("tree-container")?.hidden,
            }));
            assert(state.settingsHidden, `Expected settings hidden after ${label}`);
            assert(!state.treeHidden, `Expected tree visible after ${label}`);
        };

        await openSettingsPage(page);
        await page.locator("#settings-container .settings-menu").click();
        await assertClosed("hamburger click");

        await openSettingsPage(page);
        await page.locator("#settings-container .settings-title").click();
        await assertClosed("title click");

        await openSettingsPage(page);
        const blankPoint = await page.evaluate(() => {
            const header = document.querySelector("#settings-container .settings-header");
            const title = document.querySelector("#settings-container .settings-title");
            const close = document.querySelector("#settings-container .settings-close");
            if (!(header instanceof HTMLElement)
                || !(title instanceof HTMLElement)
                || !(close instanceof HTMLElement)) return null;
            const headerRect = header.getBoundingClientRect();
            const titleRect = title.getBoundingClientRect();
            const closeRect = close.getBoundingClientRect();
            const x = Math.floor((titleRect.right + closeRect.left) / 2);
            const y = Math.floor(headerRect.top + headerRect.height / 2);
            const insideGap = x > titleRect.right && x < closeRect.left && x > headerRect.left && x < headerRect.right;
            return insideGap ? { x, y } : null;
        });
        assert(blankPoint, "Expected a clickable blank point in settings header");
        await page.mouse.click(blankPoint.x, blankPoint.y);
        await assertClosed("blank header click");

        await openSettingsPage(page);
        await page.locator("#settings-container .settings-close").click();
        await assertClosed("close icon click");

        await openSettingsPage(page);
        await page.locator("#settings-container .settings-body").click({ position: { x: 24, y: 24 } });
        const stillOpen = await page.evaluate(() => ({
            settingsHidden: !!document.getElementById("settings-container")?.hidden,
            treeHidden: !!document.getElementById("tree-container")?.hidden,
        }));
        assert(!stillOpen.settingsHidden, "Expected body tap to keep settings open");
        assert(stillOpen.treeHidden, "Expected body tap to keep tree hidden");
        await closeSettingsPage(page);
    },

    /** OneDrive auth button label follows evidence state (Sign out vs Reconnect). */
    async "settings: auth button label follows evidence state"(page) {
        await page.evaluate(() => window._testAuth.transition("evidence:signed-in"));
        await openSettingsPage(page);
        const signedInLabel = await page.locator("#settings-container .settings-section", { hasText: "OneDrive" })
            .locator("button").first().textContent();
        assert((signedInLabel || "").includes("Sign out"), `Expected Sign out button, got "${signedInLabel}"`);
        await closeSettingsPage(page);

        await page.evaluate(() => window._testAuth.transition("evidence:signed-out"));
        await openSettingsPage(page);
        const signedOutLabel = await page.locator("#settings-container .settings-section", { hasText: "OneDrive" })
            .locator("button").first().textContent();
        assert((signedOutLabel || "").includes("Reconnect"), `Expected Reconnect button, got "${signedOutLabel}"`);
        const reconnectStyle = await page.evaluate(() => {
            const section = Array.from(document.querySelectorAll("#settings-container .settings-section"))
                .find((el) => (el.textContent || "").includes("OneDrive"));
            const btn = section ? section.querySelector("button") : null;
            if (!(btn instanceof HTMLButtonElement)) return { className: "", color: "", beforeBg: "" };
            return {
                className: btn.className,
                color: getComputedStyle(btn).color,
                beforeBg: getComputedStyle(btn, "::before").backgroundColor,
            };
        });
        const reconnectTextRgb = (reconnectStyle.color.match(/\d+/g) || []).map(Number);
        const reconnectBgRgb = (reconnectStyle.beforeBg.match(/\d+/g) || []).map(Number);
        assert(reconnectStyle.className.includes("settings-pill-reconnect"),
            `Expected reconnect button to include settings-pill-reconnect class, got "${reconnectStyle.className}"`);
        assert(reconnectTextRgb.length >= 3 && reconnectTextRgb[0] > 220 && reconnectTextRgb[1] > 220 && reconnectTextRgb[2] > 220,
            `Expected reconnect text to be light/white, got "${reconnectStyle.color}"`);
        assert(reconnectBgRgb.length >= 3 && reconnectBgRgb[2] > 160 && reconnectBgRgb[0] < 80,
            `Expected reconnect CTA background to be blue-ish, got "${reconnectStyle.beforeBg}"`);
        await closeSettingsPage(page);
    },

    /** Sign-out/reconnect actions close settings (auth handoff stubbed in tests). */
    async "settings: auth action closes settings with stubs"(page) {
        await page.evaluate(() => {
            window._testSettingsAction = "";
            window._testSettingsReconnect = () => { window._testSettingsAction = "reconnect"; };
            window._testAuth.transition("evidence:signed-out");
        });
        await openSettingsPage(page);
        await page.locator("#settings-container button", { hasText: "Reconnect..." }).click();
        const reconnectState = await page.evaluate(() => ({
            action: window._testSettingsAction,
            settingsHidden: !!document.getElementById("settings-container")?.hidden,
        }));
        assert(reconnectState.action === "reconnect", `Expected reconnect hook to run, got "${reconnectState.action}"`);
        assert(reconnectState.settingsHidden, "Settings should close before reconnect handoff");

        await page.evaluate(() => {
            window._testSettingsAction = "";
            window._testSettingsSignOut = () => { window._testSettingsAction = "signout"; };
            window._testAuth.transition("evidence:signed-in");
        });
        await openSettingsPage(page);
        await page.locator("#settings-container button", { hasText: "Sign out" }).click();
        const signoutState = await page.evaluate(() => ({
            action: window._testSettingsAction,
            settingsHidden: !!document.getElementById("settings-container")?.hidden,
        }));
        assert(signoutState.action === "signout", `Expected signout hook to run, got "${signoutState.action}"`);
        assert(signoutState.settingsHidden, "Settings should close before signout handoff");
        await page.evaluate(() => {
            delete window._testSettingsReconnect;
            delete window._testSettingsSignOut;
            delete window._testSettingsAction;
        });
    },

    /** Shared section is empty by default; only Add-share action is visible in M13. */
    async "settings: shared section defaults to add-only"(page) {
        await page.evaluate(() => { window._testSettingsShareRows = []; });
        await openSettingsPage(page);
        const shareRows = await page.locator("#settings-container .settings-share-row").count();
        assert(shareRows === 0, `Expected no share rows by default, got ${shareRows}`);
        const addButtons = await page.locator("#settings-container button", { hasText: "Add share URL..." }).count();
        assert(addButtons === 1, `Expected one add-share action, got ${addButtons}`);
        await page.evaluate(() => { delete window._testSettingsShareRows; });
        await closeSettingsPage(page);
    },

    /** Share modals invoke wired add/remove handlers (test hooks). */
    async "settings: share modals invoke handlers"(page) {
        await page.evaluate(() => {
            window._testSettingsShareRows = [{
                id: "s1",
                label: "Shared Library",
                removeImpactTracks: 3,
                removeImpactFavorites: 2,
            }];
            window._testSettingsAddCalls = 0;
            window._testSettingsRemoveCalls = 0;
            window._testSettingsAddShare = () => { window._testSettingsAddCalls += 1; };
            window._testSettingsRemoveShare = () => { window._testSettingsRemoveCalls += 1; };
        });
        await openSettingsPage(page);

        await page.locator("#settings-container button", { hasText: "Add share URL..." }).click();
        await page.locator(".modal").waitFor({ state: "visible", timeout: 3000 });
        const helpText = await page.locator(".modal p").first().textContent();
        assert((helpText || "").includes("music folders with you"),
            `Expected add-share help text in modal, got "${helpText}"`);
        await page.locator(".modal input[type='text']").fill("https://example.com/share");
        await page.locator(".modal button", { hasText: "Add" }).click();
        await page.waitForSelector(".modal-backdrop", { state: "hidden", timeout: 3000 });
        const addCalls = await page.evaluate(() => window._testSettingsAddCalls);
        assert(addCalls === 1, `Expected add-share handler to run once, got ${addCalls}`);

        await page.locator("#settings-container .settings-share-trash").click();
        await page.locator(".modal").waitFor({ state: "visible", timeout: 3000 });
        const removeTitle = await page.locator(".modal h3").textContent();
        assert((removeTitle || "").includes("Disconnect from share"),
            `Expected disconnect modal title, got \"${removeTitle}\"`);
        const removeText = await page.locator(".modal p").textContent();
        assert((removeText || "").includes("3 tracks") && (removeText || "").includes("2 playlists"),
            `Expected remove impact text in modal, got \"${removeText}\"`);
        await page.locator(".modal button", { hasText: "Disconnect" }).click();
        await page.waitForSelector(".modal-backdrop", { state: "hidden", timeout: 3000 });
        const removeCalls = await page.evaluate(() => window._testSettingsRemoveCalls);
        assert(removeCalls === 1, `Expected remove-share handler to run once, got ${removeCalls}`);

        await page.evaluate(() => {
            delete window._testSettingsShareRows;
            delete window._testSettingsAddShare;
            delete window._testSettingsRemoveShare;
            delete window._testSettingsAddCalls;
            delete window._testSettingsRemoveCalls;
        });
        await closeSettingsPage(page);
    },

    /** Disconnect modal omits impact text when the share contributes to no favorites. */
    async "settings: disconnect modal has no impact text for unused share"(page) {
        await page.evaluate(() => {
            window._testSettingsShareRows = [{
                id: "s1",
                label: "Shared Library",
                removeImpactTracks: 0,
                removeImpactFavorites: 0,
            }];
        });
        await openSettingsPage(page);
        await page.locator("#settings-container .settings-share-trash").click();
        await page.locator(".modal").waitFor({ state: "visible", timeout: 3000 });
        const title = await page.locator(".modal h3").textContent();
        assert((title || "").includes("Disconnect from share"),
            `Expected disconnect modal title, got \"${title}\"`);
        const hasInfoText = await page.locator(".modal p").count();
        assert(hasInfoText === 0, `Expected no impact text for unused share, got ${hasInfoText} paragraph(s)`);
        await page.locator(".modal button", { hasText: "Cancel" }).click();
        await page.waitForSelector(".modal-backdrop", { state: "hidden", timeout: 3000 });
        await page.evaluate(() => {
            delete window._testSettingsShareRows;
        });
        await closeSettingsPage(page);
    },

    /** Add-share modal keeps Cancel active while Add is in-flight and aborts on cancel. */
    async "settings: add-share modal shows spinner and cancel aborts in-flight request"(page) {
        await page.evaluate(() => {
            window._testSettingsAddCalls = 0;
            window._testSettingsAddAborts = 0;
            window._testSettingsAddShare = (_url, signal) => new Promise((_resolve, reject) => {
                window._testSettingsAddCalls += 1;
                signal?.addEventListener("abort", () => {
                    window._testSettingsAddAborts += 1;
                    reject(new DOMException("Aborted", "AbortError"));
                }, { once: true });
            });
        });
        await openSettingsPage(page);

        await page.locator("#settings-container button", { hasText: "Add share URL..." }).click();
        await page.locator(".modal").waitFor({ state: "visible", timeout: 3000 });
        await page.locator(".modal input[type='text']").fill("https://example.com/share");
        await page.locator(".modal .modal-confirm").click();
        const buttonState = await page.evaluate(() => {
            const cancel = document.querySelector(".modal .modal-cancel");
            const add = document.querySelector(".modal .modal-confirm");
            const label = add?.querySelector("span");
            const spinner = add?.querySelector(".modal-button-spinner");
            return {
                cancelDisabled: cancel instanceof HTMLButtonElement ? cancel.disabled : true,
                addDisabled: add instanceof HTMLButtonElement ? add.disabled : false,
                labelHidden: label instanceof HTMLElement ? label.hidden : false,
                spinnerVisible: spinner instanceof SVGElement
                    ? getComputedStyle(spinner).display !== "none" : false,
            };
        });
        assert(!buttonState.cancelDisabled, "Cancel should stay enabled while Add request is running");
        assert(buttonState.addDisabled, "Add should be disabled while request is in-flight");
        assert(buttonState.labelHidden, "Add label should hide while spinner is shown");
        assert(buttonState.spinnerVisible, "Add spinner should be visible while request is in-flight");

        await page.locator(".modal .modal-cancel").click();
        await page.waitForSelector(".modal-backdrop", { state: "hidden", timeout: 3000 });
        await page.waitForFunction(() => window._testSettingsAddAborts === 1, { timeout: 3000 });
        const counts = await page.evaluate(() => ({
            addCalls: window._testSettingsAddCalls,
            aborts: window._testSettingsAddAborts,
        }));
        assert(counts.addCalls === 1, `Expected one in-flight add call, got ${counts.addCalls}`);
        assert(counts.aborts === 1, `Expected one add abort, got ${counts.aborts}`);

        await page.evaluate(() => {
            delete window._testSettingsAddShare;
            delete window._testSettingsAddCalls;
            delete window._testSettingsAddAborts;
        });
        await closeSettingsPage(page);
    },

    /** Add-share modal has an inline clear button that clears URL and preserves focus. */
    async "settings: add-share modal clear button clears input"(page) {
        await openSettingsPage(page);

        await page.locator("#settings-container button", { hasText: "Add share URL..." }).click();
        await page.locator(".modal").waitFor({ state: "visible", timeout: 3000 });

        const clearHiddenInitially = await page.evaluate(() => {
            const clear = document.querySelector(".modal .modal-url-input-clear");
            return clear instanceof HTMLButtonElement && clear.hidden;
        });
        assert(clearHiddenInitially, "Clear button should be hidden when input is empty");

        const input = page.locator(".modal input[type='text']").first();
        await input.fill("https://example.com/share");
        const clearVisibleAfterInput = await page.evaluate(() => {
            const clear = document.querySelector(".modal .modal-url-input-clear");
            return clear instanceof HTMLButtonElement && !clear.hidden;
        });
        assert(clearVisibleAfterInput, "Clear button should be visible when input has text");

        await page.locator(".modal .modal-url-input-clear").click();
        const clearedState = await page.evaluate(() => {
            const inputEl = document.querySelector(".modal input[type='text']");
            const clear = document.querySelector(".modal .modal-url-input-clear");
            return {
                value: inputEl instanceof HTMLInputElement ? inputEl.value : "__missing__",
                focused: inputEl === document.activeElement,
                clearHidden: clear instanceof HTMLButtonElement ? clear.hidden : false,
            };
        });
        assert(clearedState.value === "", `Expected clear button to erase input, got "${clearedState.value}"`);
        assert(clearedState.focused, "Expected input focus to remain after clear");
        assert(clearedState.clearHidden, "Clear button should hide again after input is cleared");

        await page.locator(".modal .modal-cancel").click();
        await page.waitForSelector(".modal-backdrop", { state: "hidden", timeout: 3000 });
        await closeSettingsPage(page);
    },

    /** Synthetic denied-share state shows warning icon and denied reason row text. */
    async "settings: denied share warning and reason are visible"(page) {
        await page.evaluate(() => {
            window._testShares.setDeniedState("share:test-denied", "Permission denied (403)");
            window._testSettingsShareRows = [{
                id: "s-denied",
                label: "Denied Library",
                deniedReason: "Access unavailable: Permission denied (403)",
                removeImpactTracks: 0,
                removeImpactFavorites: 0,
            }];
        });
        const warningGlyph = await page.evaluate(() => {
            const icon = document.querySelector("#breadcrumbs .row-icon-settings");
            return (icon?.textContent || "").includes("⚠");
        });
        assert(warningGlyph, "Expected warning glyph on OnePlay Music row when denied share exists");

        await openSettingsPage(page);
        const deniedText = await page.locator("#settings-container .settings-share-denied").first().textContent();
        assert((deniedText || "").includes("Permission denied"),
            `Expected denied reason text, got \"${deniedText}\"`);
        await closeSettingsPage(page);

        await page.evaluate(() => {
            window._testShares.setDeniedState("share:test-denied", undefined);
            delete window._testSettingsShareRows;
        });
    },

    /** Timer selection persists across reload. */
    async "settings: timer persists across reload"(page) {
        await openSettingsPage(page);
        await page.locator("#settings-container .settings-timer-select").selectOption("45m");
        await closeSettingsPage(page);

        await page.goto(URL, { waitUntil: "domcontentloaded" });
        await page.waitForSelector("#tree-container:not([hidden])", { timeout: 15000 });
        await openSettingsPage(page);
        const selected = await page.evaluate(() => {
            const sel = document.querySelector("#settings-container .settings-timer-select");
            return sel instanceof HTMLSelectElement && sel.value === '45m';
        });
        assert(selected, "Expected 45m timer option to stay selected after reload");
        await closeSettingsPage(page);
    },

    /** Theme and timer selectors should share the exact same visual styling. */
    async "settings: theme selector matches timer selector styling"(page) {
        await openSettingsPage(page);
        const styleState = await page.evaluate(() => {
            const timer = document.querySelector("#settings-container .settings-timer-select");
            const theme = document.querySelector("#settings-container .settings-theme-select");
            if (!(timer instanceof HTMLSelectElement) || !(theme instanceof HTMLSelectElement)) {
                return { present: false, same: false, diffs: ["select missing"] };
            }
            const timerStyle = getComputedStyle(timer);
            const themeStyle = getComputedStyle(theme);
            const keys = [
                "borderTopWidth",
                "borderTopStyle",
                "borderTopColor",
                "borderRadius",
                "paddingTop",
                "paddingRight",
                "paddingBottom",
                "paddingLeft",
                "fontSize",
                "backgroundColor",
                "minHeight",
            ];
            const diffs = keys
                .filter((key) => timerStyle[key] !== themeStyle[key])
                .map((key) => `${key}: timer=${timerStyle[key]} theme=${themeStyle[key]}`);
            return { present: true, same: diffs.length === 0, diffs };
        });
        assert(styleState.present, "Expected both timer and theme selectors to exist");
        assert(styleState.same,
            `Expected timer/theme selector styles to match; diffs: ${styleState.diffs.join("; ")}`);
        await closeSettingsPage(page);
    },

    /** Debug toggle persists across reload and controls OnePlay Music debug glyph visibility. */
    async "settings: debug toggle persists and controls glyph"(page) {
        const getDebugState = async () => await page.evaluate(() => {
            const row = document.querySelector("#breadcrumbs .tree-row");
            if (!row) return { hasGlyph: false, icons: [] };
            const icons = Array.from(row.querySelectorAll(".row-icon")).map(el => el.textContent || "");
            const hasGlyph = icons.some(text =>
                text.includes("‽") || text.includes("🔑") || text.includes("🔒") || text.includes("🚫"));
            const rowName = (row.querySelector(".row-name")?.textContent || "").trim();
            return {
                hasGlyph,
                icons,
                rowName,
            };
        });
        await openSettingsPage(page);
        const maybeTurnOff = page.locator("#settings-container button", { hasText: "Turn off" }).first();
        if (await maybeTurnOff.count() > 0) await maybeTurnOff.click();
        const debugLineHiddenWhenOff = await page.locator("#settings-container .settings-debug-line").first().isHidden();
        assert(debugLineHiddenWhenOff, "Debug status line should be hidden when debug is off");
        await closeSettingsPage(page);
        const offState = await getDebugState();
        assert(!offState.hasGlyph, `Debug glyph should be hidden after explicit disable (icons=${JSON.stringify(offState.icons)})`);
        assert(offState.rowName === "OnePlay Music",
            `Expected plain OnePlay Music title when debug is off, got "${offState.rowName}"`);

        await openSettingsPage(page);
        await page.locator("#settings-container button", { hasText: "Turn on" }).click();
        const debugLineWhenOn = page.locator("#settings-container .settings-debug-line").first();
        const debugLineVisibleWhenOn = await debugLineWhenOn.isVisible();
        const debugLineTextWhenOn = await debugLineWhenOn.textContent();
        assert(debugLineVisibleWhenOn, "Debug status line should be visible when debug is on");
        assert((debugLineTextWhenOn || "").includes("Log, evidence indicator and version-refresh are turned on."),
            `Unexpected debug status line text: \"${debugLineTextWhenOn}\"`);
        await closeSettingsPage(page);
        const onState = await getDebugState();
        assert(onState.hasGlyph, `Debug glyph should appear after enabling debug (icons=${JSON.stringify(onState.icons)})`);
        assert(onState.rowName.startsWith("OnePlay Music") && onState.rowName.length > "OnePlay Music".length,
            `Expected deploy suffix in title when debug is on, got "${onState.rowName}"`);

        await page.goto(URL, { waitUntil: "domcontentloaded" });
        await page.waitForSelector("#tree-container:not([hidden])", { timeout: 15000 });
        const persistedState = await getDebugState();
        assert(persistedState.hasGlyph, `Debug glyph should persist across reload (icons=${JSON.stringify(persistedState.icons)})`);
        assert(persistedState.rowName.startsWith("OnePlay Music") && persistedState.rowName.length > "OnePlay Music".length,
            `Expected deploy suffix to persist in title when debug is on, got "${persistedState.rowName}"`);
    },

    /** Refresh button disables (not hidden) while pull is in-flight and checking text wins over progress. */
    async "settings: refresh button and indexing status update live"(page) {
        await page.evaluate(() => {
            window._testSettingsRefreshNow = () => new Promise((resolve) => {
                window._testSettingsRefreshResolve = resolve;
            });
        });
        await openSettingsPage(page);
        const refreshBtn = page.locator("#settings-container button", { hasText: "Refresh now" }).first();
        // Force deterministic idle status so this test doesn't wait on
        // background startup pull timing.
        await page.evaluate(() => {
            window._testSettings.updateIndexSection({
                checkingForUpdates: false,
                indexProgress: undefined,
                shareRows: [],
                latestFailure: undefined,
                lastIndexUpdatedAt: Date.now() - 60_000,
            });
        });
        const enabledBeforeClick = !(await refreshBtn.isDisabled());
        assert(enabledBeforeClick, "Refresh button should be enabled in forced idle state");
        await refreshBtn.click();
        const visibleDuringPull = await refreshBtn.isVisible();
        const disabledDuringPull = await refreshBtn.isDisabled();
        assert(visibleDuringPull, "Refresh button should remain visible while pull is in-flight");
        assert(disabledDuringPull, "Refresh button should disable while pull is in-flight");
        const checkingLineAfterClick = await page.locator("#settings-container .settings-index-line").textContent();
        assert((checkingLineAfterClick || "").includes("Checking for updates..."),
            `Expected checking line after refresh click, got "${checkingLineAfterClick}"`);

        await page.evaluate(() => {
            window._testSettings.updateIndexSection({
                checkingForUpdates: true,
                indexProgress: { fraction: 0.42, message: "Testing progress" },
                lastIndexUpdatedAt: Date.now() - 60_000,
            });
        });
        const checkingLine = await page.locator("#settings-container .settings-index-line").textContent();
        assert((checkingLine || "").includes("Checking for updates..."),
            `Expected checking line to win over progress, got "${checkingLine}"`);
        const checkingSpinner = await page.locator("#settings-container .settings-index-line .sync-spinner").count();
        assert(checkingSpinner === 1, `Expected one spinner during checking, got ${checkingSpinner}`);

        await page.evaluate(() => {
            window._testSettings.updateIndexSection({
                checkingForUpdates: false,
                indexProgress: { fraction: 0.42, message: "Testing progress" },
                lastIndexUpdatedAt: Date.now() - 60_000,
            });
        });
        const progressLine = await page.locator("#settings-container .settings-index-line").textContent();
        assert((progressLine || "").includes("OneDrive: 42%"),
            `Expected live progress line, got \"${progressLine}\"`);
        const progressSpinner = await page.locator("#settings-container .settings-index-line .sync-spinner").count();
        assert(progressSpinner === 1, `Expected one spinner during indexing progress, got ${progressSpinner}`);

        await page.evaluate(() => {
            window._testSettings.updateIndexSection({
                checkingForUpdates: false,
                indexProgress: undefined,
                shareRows: [{
                    id: "s1",
                    label: "Shared Mix",
                    progress: { fraction: 0.25, message: "Scanning" },
                }],
                lastIndexUpdatedAt: Date.now() - 60_000,
            });
        });
        const shareProgressLine = await page.locator("#settings-container .settings-index-line").textContent();
        assert((shareProgressLine || "").includes("Shared Mix: 25%"),
            `Expected live share progress line, got \"${shareProgressLine}\"`);
        const disabledDuringShareIndex = await refreshBtn.isDisabled();
        assert(disabledDuringShareIndex,
            "Refresh button should disable while share indexing progress is shown");

        await page.evaluate(() => {
            window._testSettings.updateIndexSection({
                checkingForUpdates: false,
                indexProgress: undefined,
                latestFailure: {
                    label: "Shared Mix",
                    message: "batch POST failed: 503 Load failed (https://graph.microsoft.com/v1.0/$batch)",
                    at: Date.now() - 30_000,
                },
                lastIndexUpdatedAt: Date.now() - 60_000,
            });
        });
        const failureLine = await page.locator("#settings-container .settings-index-line").textContent();
        assert((failureLine || "").includes("Last refresh failed: [Shared Mix] batch POST failed: 503 Load failed"),
            `Expected latest failure line in idle state, got "${failureLine}"`);
        assert(!(failureLine || "").includes("https://graph.microsoft.com"),
            `Expected failure line to strip URL noise, got "${failureLine}"`);
        const failureSpinner = await page.locator("#settings-container .settings-index-line .sync-spinner").count();
        assert(failureSpinner === 0, `Expected no spinner in idle failure state, got ${failureSpinner}`);
        const refreshUrgentClass = await refreshBtn.getAttribute("class");
        assert((refreshUrgentClass || "").includes("settings-pill-refresh-urgent"),
            `Expected refresh button to become urgent CTA on failure, got class="${refreshUrgentClass}"`);

        await page.evaluate(() => {
            if (typeof window._testSettingsRefreshResolve === "function") window._testSettingsRefreshResolve();
            window._testSettings.updateIndexSection({
                checkingForUpdates: false,
                indexProgress: undefined,
                latestFailure: undefined,
                lastIndexUpdatedAt: Date.now(),
            });
            delete window._testSettingsRefreshResolve;
            delete window._testSettingsRefreshNow;
        });
        const refreshVisibleAfter = await refreshBtn.isVisible();
        const refreshEnabledAfter = !(await refreshBtn.isDisabled());
        const idleLine = await page.locator("#settings-container .settings-index-line").textContent();
        const idleSpinner = await page.locator("#settings-container .settings-index-line .sync-spinner").count();
        const refreshClassAfterClear = await refreshBtn.getAttribute("class");
        assert(refreshVisibleAfter, "Refresh button should be visible after pull completion");
        assert(refreshEnabledAfter, "Refresh button should be enabled after pull completion");
        assert((idleLine || "").includes("Last updated"), `Expected idle last-updated line, got "${idleLine}"`);
        assert(idleSpinner === 0, `Expected no spinner in idle state, got ${idleSpinner}`);
        assert(!(refreshClassAfterClear || "").includes("settings-pill-refresh-urgent"),
            `Expected urgent CTA class to clear after failure clears, got class="${refreshClassAfterClear}"`);
        await closeSettingsPage(page);
    },

    /** Settings controls keep >=44px touch targets on mobile viewport. */
    async "settings: mobile controls meet 44px target"(page) {
        await page.setViewportSize({ width: 390, height: 844 });
        await openSettingsPage(page);
        const tooSmall = await page.evaluate(() => {
            const controls = Array.from(document.querySelectorAll(
                "#settings-container .settings-close, #settings-container .settings-pill, #settings-container .settings-share-trash",
            )).filter(el => getComputedStyle(el).display !== "none" && getComputedStyle(el).visibility !== "hidden");
            return controls.map(el => {
                const r = el.getBoundingClientRect();
                return { w: r.width, h: r.height };
            }).find(r => r.w < 44 || r.h < 44) || null;
        });
        assert(tooSmall === null, `Expected all controls >=44px, found ${JSON.stringify(tooSmall)}`);
        await closeSettingsPage(page);
    },

    // -- Scroll ---------------------------------------------------------------

    /** No inline overflow styles leak onto #children (would cause scroll
     *  position resets on Safari). */
    async "scroll: no inline overflow styles on children"(page) {
        await clickAccount(page);
        const prevFlipSeq = await getTestSeq(page, "_testTreeFlipSeq");
        await clickFirstFolder(page);
        await waitForFlipSettled(page, prevFlipSeq);
        const overflow = await page.evaluate(() => {
            const el = document.getElementById("children");
            return { x: el.style.overflowX, y: el.style.overflowY };
        });
        assert(overflow.x === "", `Expected no inline overflowX, got "${overflow.x}"`);
        assert(overflow.y === "", `Expected no inline overflowY, got "${overflow.y}"`);
    },

};
