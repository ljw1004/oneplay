const URL = globalThis.__ONEPLAY_TEST_URL;

module.exports = {

    // -----------------------------------------------------------------------
    // M9: Playback modes
    // -----------------------------------------------------------------------

    /** Mode label exists in expansion and shows default mode. */
    async "mode: label exists with default"(page) {
        // Click a track to enable footer
        await clickAccount(page);
        await clickFirstFolder(page);
        const firstTrack = page.locator("#children .tree-row.file").first();
        if (await firstTrack.count() === 0) return; // skip if no files
        await clickTrackAndWaitForPlaybackReady(page, firstTrack);
        // Check mode label exists and shows 'all' (default)
        const modeInfo = await page.evaluate(() => {
            const label = document.querySelector(".mode-label");
            return label ? { text: label.textContent, visible: true } : { visible: false };
        });
        assert(modeInfo.visible, "Mode label should exist in expansion");
        assert(modeInfo.text === "all", `Default mode should be "all", got "${modeInfo.text}"`);
    },

    /** Clicking mode label cycles through modes. */
    async "mode: cycle through modes"(page) {
        await clickAccount(page);
        await clickFirstFolder(page);
        const firstTrack = page.locator("#children .tree-row.file").first();
        if (await firstTrack.count() === 0) return;
        await clickTrackAndWaitForPlaybackReady(page, firstTrack);
        // Expand the footer to see mode label
        await page.evaluate(() => {
            const footer = document.getElementById("footer");
            footer.classList.add("expanded");
            const expansion = footer.querySelector(".expansion");
            expansion.style.maxHeight = expansion.scrollHeight + "px";
        });
        await page.locator(".mode-label").waitFor({ state: "visible", timeout: 3000 });
        // Expected cycle: all → repeat → shuffle → one → timer → all
        const expected = ["repeat", "shuffle", "one", "timer", "all"];
        for (const exp of expected) {
            await page.locator(".mode-label").click();
            await page.waitForFunction(
                (expectedText) => document.querySelector(".mode-label")?.textContent === expectedText,
                exp,
                { timeout: 2000 },
            );
            const text = await page.evaluate(() =>
                document.querySelector(".mode-label").textContent);
            assert(text === exp, `Expected mode "${exp}" after click, got "${text}"`);
        }
    },

    /** Mode label is tappable with minimum 44px target. */
    async "mode: label meets 44px minimum"(page) {
        await clickAccount(page);
        await clickFirstFolder(page);
        const firstTrack = page.locator("#children .tree-row.file").first();
        if (await firstTrack.count() === 0) return;
        await clickTrackAndWaitForPlaybackReady(page, firstTrack);
        // Expand
        await page.evaluate(() => {
            const footer = document.getElementById("footer");
            footer.classList.add("expanded");
            const expansion = footer.querySelector(".expansion");
            expansion.style.maxHeight = expansion.scrollHeight + "px";
        });
        await page.locator(".mode-label").waitFor({ state: "visible", timeout: 3000 });
        const size = await page.evaluate(() => {
            const label = document.querySelector(".mode-label");
            const rect = label.getBoundingClientRect();
            return { width: rect.width, height: rect.height };
        });
        assert(size.width >= 44, `Mode label width ${size.width} should be >= 44px`);
        assert(size.height >= 44, `Mode label height ${size.height} should be >= 44px`);
    },

    /** Numeric timer expiry pauses immediately and keeps the current track. */
    async "timer: numeric expiry pauses in place"(page) {
        await setTimerDurationSetting(page, "15m");
        await clickAccount(page);
        await clickFirstFolder(page);
        const firstTrack = page.locator("#children .tree-row.file").first();
        if (await firstTrack.count() === 0) return;
        await clickTrackAndWaitForPlaybackReady(page, firstTrack);

        const baseNow = await page.evaluate(() => Date.now());
        await setFakeNow(page, baseNow);
        await setPlaybackMode(page, "timer");
        const beforeTrack = await page.evaluate(() =>
            window._testPlayback?.getInfo()?.track?.join("/") ?? "");

        await setFakeNow(page, baseNow + 16 * 60 * 1000);
        await dispatchAudioTimeupdate(page);
        const state = await page.evaluate(() => {
            const audio = document.getElementById("player");
            return {
                paused: audio instanceof HTMLAudioElement ? audio.paused : true,
                track: window._testPlayback?.getInfo()?.track?.join("/") ?? "",
            };
        });
        assert(state.paused, "Timer expiry should pause playback");
        assert(state.track === beforeTrack,
            `Timer expiry should keep current track (${beforeTrack}), got ${state.track}`);
    },

    /** Numeric timer advances on ended while time remains. */
    async "timer: numeric mode auto-advances before deadline"(page) {
        await setTimerDurationSetting(page, "15m");
        await clickAccount(page);
        await clickFirstFolder(page);
        const firstTrack = page.locator("#children .tree-row.file").first();
        if (await firstTrack.count() === 0) return;
        await clickTrackAndWaitForPlaybackReady(page, firstTrack);

        const hasSuccessor = await hasAtLeastTwoTracksInCurrentPlaybackFolder(page);
        if (!hasSuccessor) return;

        const baseNow = await page.evaluate(() => Date.now());
        await setFakeNow(page, baseNow);
        await setPlaybackMode(page, "timer");

        const beforeTrack = await page.evaluate(() =>
            window._testPlayback?.getInfo()?.track?.join("/") ?? "");
        const prevSeq = await getTestSeq(page, "_testPlaybackSeq");
        await setFakeNow(page, baseNow + 60 * 1000);
        await dispatchAudioEnded(page);
        await waitForPlaybackReady(page, prevSeq);
        const afterTrack = await page.evaluate(() =>
            window._testPlayback?.getInfo()?.track?.join("/") ?? "");
        assert(afterTrack !== beforeTrack,
            `Timer should auto-advance before deadline; stayed on ${afterTrack}`);
    },

    /** Next/prev interactions re-arm timer from interaction time. */
    async "timer: next and prev re-arm from interaction time"(page) {
        await setTimerDurationSetting(page, "15m");
        await clickAccount(page);
        await clickFirstFolder(page);
        const firstTrack = page.locator("#children .tree-row.file").first();
        if (await firstTrack.count() === 0) return;
        await clickTrackAndWaitForPlaybackReady(page, firstTrack);
        if (!await hasAtLeastTwoTracksInCurrentPlaybackFolder(page)) return;

        const baseNow = await page.evaluate(() => Date.now());
        await setFakeNow(page, baseNow);
        await setPlaybackMode(page, "timer");

        await setFakeNow(page, baseNow + 14 * 60 * 1000);
        const nextSeq = await getTestSeq(page, "_testPlaybackSeq");
        await page.locator(".scrubber-edge-button.right").click();
        await waitForPlaybackReady(page, nextSeq);

        await setFakeNow(page, baseNow + 20 * 60 * 1000);
        await dispatchAudioTimeupdate(page);
        const playingAfterNext = await page.evaluate(() => {
            const audio = document.getElementById("player");
            return audio instanceof HTMLAudioElement ? !audio.paused : false;
        });
        assert(playingAfterNext, "Next interaction should re-arm timer");

        await setFakeNow(page, baseNow + 28 * 60 * 1000);
        const prevSeq = await getTestSeq(page, "_testPlaybackSeq");
        await page.locator(".scrubber-edge-button.left").click();
        await waitForPlaybackReady(page, prevSeq);

        await setFakeNow(page, baseNow + 34 * 60 * 1000);
        await dispatchAudioTimeupdate(page);
        const playingAfterPrev = await page.evaluate(() => {
            const audio = document.getElementById("player");
            return audio instanceof HTMLAudioElement ? !audio.paused : false;
        });
        assert(playingAfterPrev, "Prev interaction should re-arm timer");

        await setFakeNow(page, baseNow + 45 * 60 * 1000);
        await dispatchAudioTimeupdate(page);
        const pausedAfterPrevWindow = await page.evaluate(() => {
            const audio = document.getElementById("player");
            return audio instanceof HTMLAudioElement ? audio.paused : true;
        });
        assert(pausedAfterPrevWindow, "Timer should still expire after the re-armed prev window");
    },

    /** Seek interactions from scrubber controls re-arm timer from interaction time. */
    async "timer: seek interaction re-arms from interaction time"(page) {
        await setTimerDurationSetting(page, "15m");
        await clickAccount(page);
        await clickFirstFolder(page);
        const firstTrack = page.locator("#children .tree-row.file").first();
        if (await firstTrack.count() === 0) return;
        await clickTrackAndWaitForPlaybackReady(page, firstTrack);

        const baseNow = await page.evaluate(() => Date.now());
        await setFakeNow(page, baseNow);
        await setPlaybackMode(page, "timer");

        await setFakeNow(page, baseNow + 14 * 60 * 1000);
        await page.locator(".scrubber-edge-button.top").click();

        await setFakeNow(page, baseNow + 20 * 60 * 1000);
        await dispatchAudioTimeupdate(page);
        const stillPlaying = await page.evaluate(() => {
            const audio = document.getElementById("player");
            return audio instanceof HTMLAudioElement ? !audio.paused : false;
        });
        assert(stillPlaying, "Seek interaction should re-arm timer");

        await setFakeNow(page, baseNow + 31 * 60 * 1000);
        await dispatchAudioTimeupdate(page);
        const pausedAfterSeekWindow = await page.evaluate(() => {
            const audio = document.getElementById("player");
            return audio instanceof HTMLAudioElement ? audio.paused : true;
        });
        assert(pausedAfterSeekWindow, "Timer should expire after seek-based re-arm window");
    },

    /** End-of-track timer stops at ended and never advances. */
    async "timer: end-of-track stops on ended"(page) {
        await setTimerDurationSetting(page, "end-of-track");
        await clickAccount(page);
        await clickFirstFolder(page);
        const firstTrack = page.locator("#children .tree-row.file").first();
        if (await firstTrack.count() === 0) return;
        await clickTrackAndWaitForPlaybackReady(page, firstTrack);

        const baseNow = await page.evaluate(() => Date.now());
        await setFakeNow(page, baseNow);
        await setPlaybackMode(page, "timer");
        const beforeTrack = await page.evaluate(() =>
            window._testPlayback?.getInfo()?.track?.join("/") ?? "");
        const beforeSeq = await getTestSeq(page, "_testPlaybackSeq");

        await setFakeNow(page, baseNow + 4 * 60 * 60 * 1000);
        await dispatchAudioEnded(page);
        await expectSeqUnchangedFor(page, "_testPlaybackSeq", beforeSeq, 1200);
        const afterTrack = await page.evaluate(() =>
            window._testPlayback?.getInfo()?.track?.join("/") ?? "");
        assert(afterTrack === beforeTrack,
            `End-of-track timer should keep current track (${beforeTrack}), got ${afterTrack}`);
    },

    /** Changing timer duration while active applies immediately from now. */
    async "timer: duration change re-arms active timer from now"(page) {
        await setTimerDurationSetting(page, "60m");
        await clickAccount(page);
        await clickFirstFolder(page);
        const firstTrack = page.locator("#children .tree-row.file").first();
        if (await firstTrack.count() === 0) return;
        await clickTrackAndWaitForPlaybackReady(page, firstTrack);

        const baseNow = await page.evaluate(() => Date.now());
        await setFakeNow(page, baseNow);
        await setPlaybackMode(page, "timer");
        await setTimerDurationSetting(page, "15m");

        await setFakeNow(page, baseNow + 16 * 60 * 1000);
        await dispatchAudioTimeupdate(page);
        const paused = await page.evaluate(() => {
            const audio = document.getElementById("player");
            return audio instanceof HTMLAudioElement ? audio.paused : true;
        });
        assert(paused, "Timer should expire after shortening duration while active");
    },

    /** Pause/resume in timer mode re-arms a full duration from resume time. */
    async "timer: pause-resume re-arms full duration"(page) {
        await setTimerDurationSetting(page, "15m");
        await clickAccount(page);
        await clickFirstFolder(page);
        const firstTrack = page.locator("#children .tree-row.file").first();
        if (await firstTrack.count() === 0) return;
        await clickTrackAndWaitForPlaybackReady(page, firstTrack);

        const baseNow = await page.evaluate(() => Date.now());
        await setFakeNow(page, baseNow);
        await setPlaybackMode(page, "timer");

        await page.locator("#footer .footer-playpause").click(); // pause
        await page.waitForFunction(() => {
            const audio = document.getElementById("player");
            return audio instanceof HTMLAudioElement && audio.paused;
        }, { timeout: 3000 });

        await setFakeNow(page, baseNow + 20 * 60 * 1000);
        await page.locator("#footer .footer-playpause").click(); // resume
        await page.waitForFunction(() => {
            const audio = document.getElementById("player");
            return audio instanceof HTMLAudioElement && !audio.paused;
        }, { timeout: 3000 });

        await setFakeNow(page, baseNow + 21 * 60 * 1000);
        await dispatchAudioTimeupdate(page);
        const stillPlaying = await page.evaluate(() => {
            const audio = document.getElementById("player");
            return audio instanceof HTMLAudioElement ? !audio.paused : false;
        });
        assert(stillPlaying, "Resume should re-arm timer; playback should continue after 1 minute");

        await setFakeNow(page, baseNow + 40 * 60 * 1000);
        await dispatchAudioTimeupdate(page);
        const pausedAfterExpiry = await page.evaluate(() => {
            const audio = document.getElementById("player");
            return audio instanceof HTMLAudioElement ? audio.paused : true;
        });
        assert(pausedAfterExpiry, "Playback should pause once resumed timer duration elapses");
    },

    /** Restored timer mode arms on first post-restore play. */
    async "timer: restored timer mode arms on first play"(page) {
        await setTimerDurationSetting(page, "15m");
        await clickAccount(page);
        await clickFirstFolder(page);
        const firstTrack = page.locator("#children .tree-row.file").first();
        if (await firstTrack.count() === 0) return;
        await clickTrackAndWaitForPlaybackReady(page, firstTrack);
        await setPlaybackMode(page, "timer");

        await page.reload({ waitUntil: "domcontentloaded" });
        await page.waitForSelector("#tree-container:not([hidden])", { timeout: 15000 });

        const baseNow = await page.evaluate(() => Date.now());
        await setFakeNow(page, baseNow + 60 * 1000);
        const prevSeq = await getTestSeq(page, "_testPlaybackSeq");
        await page.locator("#footer .footer-playpause").click();
        await waitForPlaybackReady(page, prevSeq);

        await setFakeNow(page, baseNow + 17 * 60 * 1000);
        await dispatchAudioTimeupdate(page);
        const paused = await page.evaluate(() => {
            const audio = document.getElementById("player");
            return audio instanceof HTMLAudioElement ? audio.paused : true;
        });
        assert(paused, "Restored timer mode should expire after first resumed play window");
    },

    /** Playing a track inside a shortcut works via logical path resolution. */
    async "logical: play track in shortcut"(page) {
        // Ensure test favorites exist
        const created = await createTestFavorites(page);
        if (!created) return;
        // Navigate to root to see favorites
        await page.locator("#breadcrumbs .tree-row", { hasText: "OnePlay Music" }).click();
        await waitForBreadcrumbCount(page, 1);
        // Click the first shortcut row (has ☆ icon)
        const clicked = await page.evaluate(() => {
            const rows = document.querySelectorAll("#children .tree-row");
            for (const r of rows) {
                const icon = r.querySelector(".fav-icon");
                if (icon && icon.textContent.includes("\u2606")) {
                    r.click();
                    return true;
                }
            }
            return false;
        });
        if (!clicked) return; // no shortcut found
        await waitForBreadcrumbCount(page, 2);
        // Click a file inside the shortcut
        const trackRow = page.locator("#children .tree-row.file").first();
        if (await trackRow.count() === 0) return;
        await clickTrackAndWaitForPlaybackReady(page, trackRow);
        // Verify footer shows and has a track title
        const footerState = await page.evaluate(() => {
            const footer = document.getElementById("footer");
            const title = footer.querySelector(".footer-title");
            return {
                visible: footer.classList.contains("visible"),
                hasTitle: title && title.textContent.length > 0,
            };
        });
        assert(footerState.visible, "Footer should be visible after playing track in shortcut");
        assert(footerState.hasTitle, "Footer should show track title");
    },

    /** Per-favorite mode: setMode persists and getAll returns it. */
    async "mode: per-favorite setMode persists"(page) {
        const created = await createTestFavorites(page);
        if (!created) return;
        const result = await page.evaluate(async () => {
            const favs = window._testFavorites;
            const all = favs.getAll();
            const shortcut = all.find(f => f.kind === "shortcut");
            if (!shortcut) return { error: "no shortcut" };
            // Set mode to 'shuffle'
            await favs.setMode(shortcut.id, "shuffle");
            const updated = favs.getAll().find(f => f.id === shortcut.id);
            return { mode: updated.mode };
        });
        assert(!result.error, result.error || "");
        assert(result.mode === "shuffle", `Expected mode "shuffle", got "${result.mode}"`);
    },

    /** In shuffle mode, folder Play inside a private-playback favorite ignores
     *  saved track/time, for both the favorite root and nested subfolders. */
    async "mode: shuffle play ignores saved position in favorites and subfolders"(page) {
        const created = await createTestFavorites(page);
        if (!created) return;

        await page.locator("#breadcrumbs .tree-row", { hasText: "OnePlay Music" }).click();
        await waitForBreadcrumbCount(page, 1);

        const clicked = await page.evaluate(() => {
            const rows = document.querySelectorAll("#children .tree-row");
            for (const r of rows) {
                const icon = r.querySelector(".fav-icon");
                if (icon && icon.textContent.includes("\u2606")) {
                    r.click();
                    return true;
                }
            }
            return false;
        });
        if (!clicked) return;
        await waitForBreadcrumbCount(page, 2);

        const favId = await page.evaluate(() => {
            const row = document.querySelectorAll("#breadcrumbs .tree-row")[1];
            if (!(row instanceof HTMLElement) || !row.dataset.path) return undefined;
            const path = JSON.parse(row.dataset.path);
            const rootKey = Array.isArray(path) ? path[1] : undefined;
            return (typeof rootKey === "string" && rootKey.startsWith("fav:"))
                ? rootKey.slice(4) : undefined;
        });
        if (!favId) return;

        await page.evaluate(async (id) => {
            const favs = window._testFavorites;
            await favs.setHasPrivatePlayback(id, true);
            await favs.setMode(id, "shuffle");
        }, favId);

        const rootSeedRow = await findFirstFileRow(page);
        if (!rootSeedRow) return;
        const rootSavedTrack = await rootSeedRow.evaluate((el) =>
            el instanceof HTMLElement && el.dataset.path ? JSON.parse(el.dataset.path) : undefined);
        if (!Array.isArray(rootSavedTrack)) return;
        const rootSecondTrack = await page.locator("#children .tree-row.file").nth(1).evaluate((el) =>
            el instanceof HTMLElement && el.dataset.path ? JSON.parse(el.dataset.path) : undefined).catch(() => undefined);
        if (!Array.isArray(rootSecondTrack)) return;

        await page.evaluate(({ id, track }) => {
            localStorage.setItem(`oneplay_music_fav:${id}`, JSON.stringify({ track, time: 123 }));
        }, { id: favId, track: rootSavedTrack });
        await page.evaluate(() => { Math.random = () => 0; });

        await page.locator("#breadcrumbs .tree-row").nth(1).click();
        await waitForBreadcrumbCount(page, 2);
        const topSeq = await getTestSeq(page, "_testPlaybackSeq");
        await page.locator("#breadcrumbs .tree-row.selected .play-btn").click();
        await waitForPlaybackReady(page, topSeq);
        const topTrack = await page.evaluate(() => window._testPlayback?.getInfo?.()?.track);
        assert(JSON.stringify(topTrack) === JSON.stringify(rootSecondTrack),
            "Shuffle Play should start with a fresh random track, not the previously current index");
        const topTime = await page.evaluate(() => {
            const audio = document.getElementById("player");
            return (audio instanceof HTMLAudioElement) ? audio.currentTime : NaN;
        });
        assert(Number.isFinite(topTime) && topTime < 20,
            `Shuffle Play at favorite root should ignore saved time; got ${topTime}s`);

        const childFolder = page.locator("#children .tree-row.folder").first();
        if (await childFolder.count() === 0) return;
        const before = await page.locator("#breadcrumbs .tree-row").count();
        await childFolder.click();
        await waitForBreadcrumbCount(page, before + 1);

        const subSeedRow = await findFirstFileRow(page);
        if (!subSeedRow) return;
        const subSavedTrack = await subSeedRow.evaluate((el) =>
            el instanceof HTMLElement && el.dataset.path ? JSON.parse(el.dataset.path) : undefined);
        if (!Array.isArray(subSavedTrack)) return;

        await page.evaluate(({ id, track }) => {
            localStorage.setItem(`oneplay_music_fav:${id}`, JSON.stringify({ track, time: 137 }));
        }, { id: favId, track: subSavedTrack });

        const depth = await page.locator("#breadcrumbs .tree-row").count();
        assert(depth > 2, "Expected to be inside a favorite subfolder");
        const subSeq = await getTestSeq(page, "_testPlaybackSeq");
        await page.locator("#breadcrumbs .tree-row.selected .play-btn").click();
        await waitForPlaybackReady(page, subSeq);
        const subTime = await page.evaluate(() => {
            const audio = document.getElementById("player");
            return (audio instanceof HTMLAudioElement) ? audio.currentTime : NaN;
        });
        assert(Number.isFinite(subTime) && subTime < 20,
            `Shuffle Play in favorite subfolder should ignore saved time; got ${subTime}s`);
    },

};
