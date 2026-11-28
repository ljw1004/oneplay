const URL = globalThis.__ONEPLAY_TEST_URL;
const retry = "#status .startup-retry";
const tree = "#tree-container:visible";
const signIn = "#status .signin-btn";
const failed = "OnePlay couldn’t open your library.";
const offline = "Connect to the internet, then try again.";

/** Seed an actual primary index, saved shared album and scroll offset. */
async function seedCachedShare(page) {
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
}

/** Delay delivery of the primary IDB result after the actual request completes. */
async function holdPrimaryCacheRead(page, {once = false, initiallyHidden = false} = {}) {
    await page.addInitScript(({url, once, initiallyHidden}) => {
        if (location.href !== url || (once && sessionStorage.cacheReadWasHeld)) return;
        window._testStartupOpeningWaitMs = 240;
        let hidden = initiallyHidden;
        Object.defineProperties(document, {
            hidden: {get: () => hidden},
            visibilityState: {get: () => hidden ? "hidden" : "visible"},
        });
        window._testSetHidden = next => {
            hidden = next;
            document.dispatchEvent(new Event("visibilitychange"));
        };
        const read = IDBObjectStore.prototype.get;
        IDBObjectStore.prototype.get = function (key) {
            const request = read.call(this, key);
            if (key !== "index:primary") return request;
            const delayed = {get result() { return request.result; }, get error() { return request.error; }};
            request.onsuccess = event => {
                sessionStorage.cacheReadWasHeld = "1";
                window._testReleaseCache = () => delayed.onsuccess(event);
                window._testRejectCache = () => {
                    IDBObjectStore.prototype.get = read;
                    Object.defineProperty(delayed, "error", {value: new DOMException("Fixture cache failure", "AbortError")});
                    delayed.onerror(event);
                };
            };
            request.onerror = event => delayed.onerror(event);
            return delayed;
        };
    }, {url: URL, once, initiallyHidden});
}

/** Assert the restored path and viewport, including after a background redraw. */
async function assertRestoredShare(page) {
    await page.locator(tree).waitFor();
    assert(await page.locator("#children .tree-row").count() === 80, "Cached shared album disappeared");
    assert(await page.locator("#children").evaluate(el => el.scrollTop) === 180, "Saved share scroll was lost");
}

/** Wait for a concrete startup status and verify adjacent actions. */
async function assertStartupFailure(page, text) {
    await page.locator("#status .startup-error").filter({hasText: text}).waitFor({timeout: 4500});
    assert(await page.locator(retry).isVisible(), "A settled failure needs Try again");
    assert(!await page.locator(signIn).isVisible(), "Retry and sign-in must be distinct outcomes");
}

/** An empty opening should immediately restore a known sign-in action on reconnect. */
async function assertSignInReturnsOnReconnect(page) {
    await page.locator(signIn).waitFor({timeout: 4500});
    await page.evaluate(() => window._testSetOnline(false));
    await assertStartupFailure(page, offline);
    await page.locator(retry).focus();
    await page.evaluate(() => window._testSetOnline(true));
    await page.locator(signIn).waitFor({timeout: 4500});
    assert(await page.evaluate(() => document.activeElement.matches(".signin-btn")), "Reconnect lost focus");
    assert(await page.evaluate(() => window._testAccountProbes) === 1, "Reconnect started another probe");
}

/** Record Graph requests without letting a startup fixture use real credentials. */
async function observeAccountProbe(page) {
    await page.addInitScript(() => {
        let online = false;
        Object.defineProperty(navigator, "onLine", {get: () => online});
        window._testGoOnline = () => {
            online = true;
            window.dispatchEvent(new Event("online"));
        };
        localStorage.access_token = "fixture-access";
        window._testAccountProbes = 0;
        const fetch = window.fetch.bind(window);
        window.fetch = (input, options) => {
            if (!String(input).includes("graph.microsoft.com")) return fetch(input, options);
            window._testAccountProbes++;
            return Promise.resolve(new Response(null, {status: 500}));
        };
    });
}

/** Stall the body of the actual OAuth exchange while keeping its headers available. */
async function holdTokenBody(page) {
    await page.route(URL + "seed-oauth", route => route.fulfill({contentType: "text/html", body: "<title>Seed</title>"}));
    await page.goto(URL + "seed-oauth");
    await page.evaluate(() => { sessionStorage.code_verifier = "fixture-verifier"; });
    await page.addInitScript(() => {
        window._testStartupOpeningWaitMs = 150;
        const fetch = window.fetch.bind(window);
        window.fetch = (input, init) => {
            const url = String(input);
            if (url.includes("login.microsoftonline.com") && url.endsWith("/token")) {
                sessionStorage.tokenRequests = String(Number(sessionStorage.tokenRequests || 0) + 1);
                sessionStorage.usedVerifier = new URLSearchParams(init.body).get("code_verifier");
                return Promise.resolve(new Response(new ReadableStream({
                    start(controller) {
                        window._testReleaseToken = () => {
                            controller.enqueue(new TextEncoder().encode(JSON.stringify({
                                access_token: "fixture-access", refresh_token: "fixture-refresh",
                            })));
                            controller.close();
                        };
                    },
                })));
            }
            if (url.includes("graph.microsoft.com")) return Promise.resolve(new Response(null, {status: 500}));
            return fetch(input, init);
        };
    });
}

module.exports = {
    /** Offline audio admission can use the local inventory while favorites have never loaded. */
    async 'startup: offline Resume uses cached audio independent of favorites' (page) {
        await page.route(URL + 'seed-resume', r => r.fulfill({contentType:'text/html', body:'<title>Seed</title>'}));
        await page.route(URL + 'resume.wav', r => r.fulfill({contentType:'audio/wav', body:silentWav()}));
        await page.goto(URL + 'seed-resume');
        await page.evaluate(async () => {
            const {dbPut, audioPut} = await import('./dist/db.js');
            const folder = ['OnePlay Music', 'drive'];
            await dbPut('index:drive', {kind:'MusicData', count:2, size:2, folder:{id:'root', children:{'Uncached.wav':{id:'a'}, 'Pinned.wav':{id:'b'}}}});
            await audioPut('drive:b', await (await fetch('resume.wav')).blob());
            localStorage.account_info = JSON.stringify({driveId:'drive', displayName:'Music'});
            localStorage.oneplay_music_playback = JSON.stringify({folder, track:[...folder,'Uncached.wav'], mode:'all'});
        });
        await page.addInitScript(() => Object.defineProperty(navigator, 'onLine', {get: () => false}));
        await page.goto(URL);
        const unavailable = page.locator('#children .file.unavailable').filter({hasText:'Uncached'});
        const grip = page.getByRole('button', {name:'Player controls'});
        await unavailable.waitFor();
        assert(await page.evaluate(() => !window._testFavorites.hasLoadedMembership()), 'The fixture has no saved favorites');
        await page.locator('.footer-playpause').click();
        assert(await grip.getAttribute('aria-expanded') === 'false', 'Offline Resume of an uncached target leaves the drawer compact');
        assert(await page.locator('audio').evaluate(el => el.paused), 'The unavailable target stays paused');
        await page.locator('#children .file').filter({hasText:'Pinned'}).click();
        await page.waitForFunction(() => {
            const audio = document.querySelector('audio');
            return !audio.paused && audio.currentSrc.startsWith('blob:') && document.getElementById('footer').classList.contains('expanded');
        });
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
        await seedCachedShare(page);
        await page.addInitScript(() => Object.defineProperty(navigator, "onLine", {get: () => false}));
        await page.goto(URL, {waitUntil:"domcontentloaded"});
        await page.locator("#tree-container:visible").waitFor();
        assert(await page.locator("#children .tree-row").count() === 80, "Cached shared album disappeared");
        assert(await page.locator("#children").evaluate(el => el.scrollTop) === 180, "Saved share scroll was lost");
    },



    async "startup: a delayed footer can restore the bottom of a saved album"(page) {
        await seedCachedShare(page);
        await page.addInitScript(() => Object.defineProperty(navigator, "onLine", {get: () => false}));
        await page.goto(URL);
        await assertRestoredShare(page);
        const top = await page.evaluate(() => {
            const list = document.querySelector("#children");
            const desired = list.scrollHeight - list.clientHeight + 50;
            const {path} = JSON.parse(localStorage.oneplay_music_view);
            localStorage.oneplay_music_scroll = JSON.stringify({[JSON.stringify(path)]: {top: desired}});
            return desired;
        });
        await page.reload();
        await page.locator(tree).waitFor();
        assert(await page.locator("#children").evaluate(el => el.scrollTop) < top, "The initial viewport must clamp the saved offset");
        await page.evaluate(() => {
            // A native snapshot reveals the footer, then redraws playback markers.
            const footer = document.querySelector("#footer");
            footer.style.height = "70px";
            footer.classList.add("visible");
            window._testTree.render();
        });
        assert(await page.locator("#children").evaluate(el => el.scrollTop) === top, "The footer redraw lost the saved bottom offset");
    },

    async "startup: late primary cache restores scroll and focus through the first pull"(page) {
        await seedCachedShare(page);
        await observeAccountProbe(page);
        await holdPrimaryCacheRead(page);
        await page.goto(URL, {waitUntil: "domcontentloaded"});
        await page.waitForFunction(() => window._testReleaseCache);
        await page.locator(retry).waitFor({timeout: 4500});
        assert(await page.locator("#status [role=status]").textContent() === "Still opening your library…",
            "The optional action must explain the wait in one polite status region");
        assert(await page.locator("#status [role=status]").count() === 1, "Expected one announcement source");
        await page.locator(retry).focus();
        await page.evaluate(() => window._testGoOnline());
        assert(await page.evaluate(() => window._testAccountProbes) === 0, "A reconnect must wait for the primary cache decision");
        await page.evaluate(() => window._testReleaseCache());
        await assertRestoredShare(page);
        await page.waitForFunction(() => window.__ONEPLAY_MUSIC_LOGS.some(entry => entry.message.startsWith("pull: complete")));
        assert(await page.locator(tree).evaluate(el => el.contains(document.activeElement)), "Focus was lost after cached recovery and sync");
        assert(await page.locator("#children").evaluate(el => el.scrollTop) === 180, "Recovery focus scrolled the library");
        assert(!await page.locator(retry).isVisible(), "A failed background pull displaced the usable library");
        await page.getByRole("button", {name: "Open settings"}).click();
        await page.locator("#settings-container:visible").waitFor();
        await page.locator(".settings-close").click();
        await assertRestoredShare(page);
    },

    async "startup: an opening wait starts fresh on wake and preserves unfocused recovery"(page) {
        await seedCachedShare(page);
        await observeAccountProbe(page);
        await holdPrimaryCacheRead(page);
        await page.clock.install();
        await page.goto(URL, {waitUntil: "domcontentloaded"});
        await page.waitForFunction(() => window._testReleaseCache);
        await page.evaluate(() => window._testSetHidden(true));
        await page.clock.runFor(600);
        assert(!await page.locator(retry).count(), "Observed background time produced a retry");
        await page.evaluate(() => window._testSetHidden(false));
        assert(!await page.locator(retry).count(), "Wake did not get a fresh visible interval");
        await page.evaluate(() => window._testReleaseCache());
        await assertRestoredShare(page);
        assert(await page.evaluate(() => document.activeElement === document.body), "Unfocused recovery moved focus");
    },

    async "startup: a replacement that starts hidden can recover late after wake"(page) {
        await seedCachedShare(page);
        await observeAccountProbe(page);
        await holdPrimaryCacheRead(page, {initiallyHidden: true});
        await page.clock.install();
        await page.goto(URL, {waitUntil: "domcontentloaded"});
        await page.waitForFunction(() => window._testReleaseCache);
        await page.clock.runFor(600);
        assert(!await page.locator(retry).count(), "A hidden replacement published retry");
        await page.evaluate(() => window._testSetHidden(false));
        assert(!await page.locator(retry).count(), "Wake immediately published retry");
        await page.clock.runFor(300);
        await page.locator(retry).waitFor({timeout: 4500});
        await page.evaluate(() => window._testSetHidden(true));
        await page.clock.runFor(600);
        await page.evaluate(() => window._testSetHidden(false));
        assert(await page.locator(retry).isVisible(), "An offered action was removed on wake");
        await page.evaluate(() => window._testReleaseCache());
        await assertRestoredShare(page);
    },

    async "startup: Try again replaces the stalled document and opens the same cache"(page) {
        await seedCachedShare(page);
        await observeAccountProbe(page);
        await holdPrimaryCacheRead(page, {once: true});
        await page.goto(URL, {waitUntil: "domcontentloaded"});
        await page.waitForFunction(() => window._testReleaseCache);
        await page.locator(retry).click({timeout: 4500});
        await assertRestoredShare(page);
        assert(await page.evaluate(() => typeof window._testReleaseCache) === "undefined", "Retry kept the old document");
    },

    async "startup: a rejected cache read fences browser pulls and preserves the index"(page) {
        await seedCachedShare(page);
        await observeAccountProbe(page);
        await holdPrimaryCacheRead(page);
        await page.goto(URL, {waitUntil: "domcontentloaded"});
        await page.waitForFunction(() => window._testRejectCache);
        await page.evaluate(() => {
            window._testGoOnline();
            window._testRejectCache();
        });
        await assertStartupFailure(page, failed);
        const state = await page.evaluate(async () => {
            window._testGoOnline();
            const {dbGet} = await import("./dist/db.js");
            return [window._testAccountProbes, (await dbGet("index:primary"))?.folder.id,
                (await dbGet("index-share:abc"))?.count];
        });
        assert(state[0] === 0 && state[1] === "p" && state[2] === 80, "Rejected primary read allowed Graph work or erased a cache");
    },

    async "startup: a partial first tree stays retired until document retry"(page) {
        await seedCachedShare(page);
        await observeAccountProbe(page);
        await page.addInitScript(url => {
            if (location.href !== url || sessionStorage.firstRenderThrew) return;
            const replace = Element.prototype.replaceChildren;
            Element.prototype.replaceChildren = function (...nodes) {
                if (this.id === "children" && nodes.length) {
                    sessionStorage.firstRenderThrew = "1";
                    throw new Error("Fixture first tree render failure");
                }
                return replace.apply(this, nodes);
            };
        }, URL);
        await page.goto(URL, {waitUntil: "domcontentloaded"});
        await assertStartupFailure(page, failed);
        assert(!await page.locator(tree).count() && await page.locator("#footer").isHidden(), "Partial controls remained visible");
        await page.evaluate(() => window._testGoOnline());
        assert(await page.evaluate(() => window._testAccountProbes) === 0, "Another pull started against a partial tree");
        await page.locator(retry).click({timeout: 4500});
        await assertRestoredShare(page);
    },

    async "startup: a partial render after successful first indexing closes pull admission again"(page) {
        await configureStartupScenario(page, {signedIn: true, mockGraph: true, completeFirstIndex: true});
        await page.addInitScript(() => {
            if (sessionStorage.firstIndexRenderThrew) return;
            const replace = Element.prototype.replaceChildren;
            Element.prototype.replaceChildren = function (...nodes) {
                if (this.id === "children" && nodes.length) {
                    sessionStorage.firstIndexRenderThrew = "1";
                    window._testSetOnline(false);
                    throw new Error("Fixture first-index render failure");
                }
                return replace.apply(this, nodes);
            };
        });
        await page.goto(URL, {waitUntil: "domcontentloaded"});
        await assertStartupFailure(page, failed);
        const cached = await page.evaluate(async () => {
            const {dbGet} = await import("./dist/db.js");
            return (await dbGet("index:startup-test-drive-id"))?.count;
        });
        assert(cached === 1, "The first index must have committed before the fixture failed rendering");
        await page.waitForFunction(() => window.__ONEPLAY_MUSIC_LOGS.some(entry => entry.message.startsWith("pull: complete")));
        await assertStartupFailure(page, failed);
        await page.evaluate(() => window._testSetOnline(true));
        assert(await page.evaluate(() => window._testAccountProbes) === 1, "The partial tree admitted another pull");
        await page.locator(retry).click({timeout: 4500});
        await page.locator("#children .file").filter({hasText:"Fixture.mp3"}).waitFor({timeout: 4500});
    },

    async "startup: signed out without a cache shows sign-in"(page) {
        await configureStartupScenario(page, {signedIn: false});
        await page.goto(URL, {waitUntil: "domcontentloaded"});
        await page.locator(signIn).waitFor();
        assert(!await page.locator(retry).count() && !await page.locator(tree).count(), "Sign-in competed with another startup outcome");
    },

    async "startup: first-ever offline launch keeps the two library choices" (page) {
        await configureStartupScenario(page, {signedIn: false, forceOffline: true});
        await page.goto(URL, {waitUntil: "domcontentloaded"});
        const connect = page.getByRole('button', {name:/Connect to OneDrive/});
        const demo = page.getByRole('button', {name:/Explore the demo library/});
        await connect.waitFor();
        await demo.waitFor();
        await demo.click();
        await page.getByText('The demo library needs an internet connection to open.').waitFor();
        await connect.click();
        await page.getByText('Connect to the internet to sign in to OneDrive.').waitFor();
        await page.evaluate(() => window._testSetOnline(true));
        assert(await connect.isVisible() && await demo.isVisible(), 'Reconnect hid a library choice');
    },

    async "startup: browser reconnect from an empty cache shows indexing and a settled failure"(page) {
        await configureStartupScenario(page, {signedIn: true, forceOffline: true, mockGraph: true, openingWaitMs: 150});
        await page.goto(URL, {waitUntil: "domcontentloaded"});
        await assertStartupFailure(page, offline);
        await page.evaluate(() => window._testSetOnline(true));
        await page.waitForFunction(() => window._testStartedBatch);
        await page.locator("#status .index-progress").waitFor();
        await page.evaluate(() => {
            window._testFailSubsequentBatches = true;
            window._testFailBatch();
        });
        await assertStartupFailure(page, failed);
        assert(await page.locator("#status .index-progress").count() === 0, "Progress survived a settled first-index failure");
    },

    async "startup: a reconnect during a failing pull opens a fresh attempt"(page) {
        await configureStartupScenario(page, {signedIn: true, mockGraph: true, holdAccountDetails: true});
        await page.goto(URL, {waitUntil: "domcontentloaded"});
        await page.waitForFunction(() => window._testReleaseDetails);
        await page.evaluate(() => {
            window._testSetOnline(false);
            window._testSetOnline(true);
            window._testReleaseDetails(500);
        });
        await page.locator("#status .index-progress").waitFor({timeout: 4500});
        assert(!await page.locator(retry).isVisible(), "The old connection displaced an active fresh attempt");
    },

    async "startup: failed indexing offers retry while reconnect waits for an old response"(page) {
        await configureStartupScenario(page, {signedIn: true, mockGraph: true, holdFavoritesUntilWake: true});
        await page.goto(URL, {waitUntil: "domcontentloaded"});
        await page.waitForFunction(() => window._testFailBatch && window._testDeliverFavoritesHeaders);
        await page.evaluate(() => {
            window._testDeliverFavoritesHeaders();
            window._testSetOnline(false);
            window._testSetOnline(true);
            window._testFailSubsequentBatches = true;
            window._testFailBatch();
        });
        await assertStartupFailure(page, failed);
        await page.evaluate(() => {
            window._testFailSubsequentBatches = false;
            window._testReleaseFavorites();
        });
        await page.locator("#status .index-progress").waitFor({timeout: 4500});
        assert(await page.evaluate(() => window._testAccountProbes) === 2, "The queued reconnect did not start a fresh pull");
    },

    async "startup: wake retries an offline opening even when the browser misses online"(page) {
        await configureStartupScenario(page, {signedIn: true, mockGraph: true, holdMusicProbe: true,
            holdFavoritesUntilWake: true});
        await page.goto(URL, {waitUntil: "domcontentloaded"});
        await page.waitForFunction(() => window._testFailMusicProbe && window._testDeliverFavoritesHeaders);
        await page.evaluate(() => {
            window._testSetOnline(false);
            window._testFailMusicProbe();
        });
        await assertStartupFailure(page, offline);
        await page.evaluate(() => window._testDeliverFavoritesHeaders());
        // The held successful response's headers can replace offline evidence
        // before wake, even though the pull still waits for its response body.
        await page.waitForFunction(() => window.__ONEPLAY_MUSIC_LOGS.some(entry =>
            entry.message.includes("evidence:not-online → evidence:signed-in")));
        await page.evaluate(() => {
            window._testSetOnline(true, false);
            document.dispatchEvent(new Event("visibilitychange"));
            window._testReleaseFavorites();
        });
        await page.locator("#status .index-progress").waitFor({timeout: 4500});
    },

    async "startup: a Music probe that establishes sign-out offers sign-in"(page) {
        await configureStartupScenario(page, {signedIn: true, mockGraph: true, musicRequiresAuth: true});
        await page.goto(URL, {waitUntil: "domcontentloaded"});
        await page.locator(signIn).waitFor({timeout: 4500});
        assert(!await page.locator(retry).isVisible(), "Sign-in should be available as soon as interaction is required");
    },

    async "startup: reconnect preserves sign-in after a rejected account probe"(page) {
        await configureStartupScenario(page, {signedIn: true, mockGraph: true, accountStatus: 401, noRefreshToken: true});
        await page.goto(URL, {waitUntil: "domcontentloaded"});
        await assertSignInReturnsOnReconnect(page);
    },

    async "startup: an empty library offers sign-in after a 401 without a refresh token"(page) {
        await configureStartupScenario(page, {signedIn: true, mockGraph: true, musicRequiresAuth: true, noRefreshToken: true});
        await page.goto(URL, {waitUntil: "domcontentloaded"});
        await page.locator(signIn).waitFor({timeout: 4500});
    },

    async "startup: a first-index batch 401 offers sign-in without a refresh token"(page) {
        await configureStartupScenario(page, {signedIn: true, mockGraph: true, batchRequiresAuth: true, noRefreshToken: true});
        await page.goto(URL, {waitUntil: "domcontentloaded"});
        await page.locator(signIn).waitFor({timeout: 4500});
        assert(await page.evaluate(() => window._testStartedBatch), "The fixture must reach the first index batch");
    },

    async "startup: a denied children request inside a successful batch offers sign-in"(page) {
        await configureStartupScenario(page, {signedIn: true, mockGraph: true, batchRequiresAuth: "children", noRefreshToken: true});
        await page.goto(URL, {waitUntil: "domcontentloaded"});
        await page.locator(signIn).waitFor({timeout: 4500});
        assert(await page.evaluate(() => window._testStartedBatch), "The fixture must reach a children request");
    },

    async "startup: a queued browser reconnect preserves the primary sign-in action"(page) {
        await configureStartupScenario(page, {signedIn: true, mockGraph: true, batchRequiresAuth: "children",
            noRefreshToken: true, holdChildrenAuth: true, holdFavoritesUntilWake: true});
        await page.goto(URL, {waitUntil: "domcontentloaded"});
        await page.waitForFunction(() => window._testReleaseChildrenAuth && window._testDeliverFavoritesHeaders);
        await page.evaluate(() => {
            window._testDeliverFavoritesHeaders();
            window._testSetOnline(false);
            window._testSetOnline(true);
            window._testReleaseChildrenAuth();
        });
        await assertSignInReturnsOnReconnect(page);
        await page.evaluate(() => window._testReleaseFavorites());
        await page.waitForFunction(() => window.__ONEPLAY_MUSIC_LOGS.some(entry => entry.message.startsWith("pull: complete")));
        await page.evaluate(() => window._testSetOnline(true));
        assert(await page.locator(signIn).isVisible() && await page.evaluate(() => window._testAccountProbes) === 1,
            "Reconnection alone must not replace a required sign-in");
    },

    async "startup: browser reconnect restores sign-in after a failed token refresh"(page) {
        await configureStartupScenario(page, {signedIn: true, mockGraph: true, musicRequiresAuth: true,
            holdFavoritesUntilWake: true});
        await page.goto(URL, {waitUntil: "domcontentloaded"});
        await page.waitForFunction(() => window._testDeliverFavoritesHeaders);
        await assertSignInReturnsOnReconnect(page);
        await page.evaluate(() => {
            window._testDeliverFavoritesHeaders();
            window._testReleaseFavorites();
        });
    },

    async "startup: late favorites auth evidence replaces generic retry with sign-in"(page) {
        await configureStartupScenario(page, {signedIn: true, mockGraph: true, holdFavoritesAuth: true});
        await page.goto(URL, {waitUntil: "domcontentloaded"});
        await assertStartupFailure(page, failed);
        await page.evaluate(() => window._testRejectFavoritesAuth());
        await page.locator(signIn).waitFor({timeout: 4500});
    },

    async "startup: auth confirmed after reconnect replaces a stale offline retry"(page) {
        await configureStartupScenario(page, {signedIn: true, mockGraph: true, holdMusicProbe: true,
            holdFavoritesAuth: true, holdShareProbe: true});
        await page.goto(URL, {waitUntil: "domcontentloaded"});
        await page.waitForFunction(() => window._testFailMusicProbe && window._testRejectFavoritesAuth && window._testFailShareProbe);
        await page.evaluate(() => {
            window._testSetOnline(false);
            window._testFailMusicProbe();
        });
        await assertStartupFailure(page, offline);
        await page.locator(retry).focus();
        await page.evaluate(() => {
            window._testSetOnline(true);
            window._testRejectFavoritesAuth();
        });
        // Keep the independent share request open until late auth evidence reaches the screen.
        await page.locator(signIn).waitFor({timeout: 4500});
        assert(await page.evaluate(() => document.activeElement.matches(".signin-btn")), "Late sign-in lost retry focus");
        assert(await page.evaluate(() => window._testAccountProbes) === 1, "Late sign-in started another probe");
        await page.evaluate(() => window._testFailShareProbe());
    },

    async "startup: invalidated browser credentials end opening while shares are held"(page) {
        await configureStartupScenario(page, {signedIn: true, mockGraph: true, holdFavoritesAuth: true,
            holdSharesDocument: true});
        await page.goto(URL, {waitUntil: "domcontentloaded"});
        await page.waitForFunction(() => window._testRejectFavoritesAuth && window._testReleaseShares);
        await page.evaluate(() => window._testRejectFavoritesAuth());
        await page.locator(signIn).waitFor({timeout: 4500});
        await page.evaluate(() => window._testReleaseShares());
    },

    async "startup: a late Music failure preserves confirmed browser sign-out"(page) {
        await configureStartupScenario(page, {signedIn: true, mockGraph: true, holdFavoritesAuth: true, holdMusicProbe: true});
        await page.goto(URL, {waitUntil: "domcontentloaded"});
        await page.waitForFunction(() => window._testRejectFavoritesAuth && window._testFailMusicProbe);
        await page.evaluate(() => window._testRejectFavoritesAuth());
        await page.waitForFunction(() => localStorage.access_token?.startsWith("null"));
        await page.evaluate(() => window._testFailMusicProbe());
        await page.locator(signIn).waitFor({timeout: 4500});
        assert(!await page.locator(retry).isVisible(), "A late 503 obscured the required sign-in");
    },

    async "startup: native sign-in queues a fresh pull unless connectivity drops"(page) {
        await page.route(URL + "seed-native-sync", route => route.fulfill({contentType: "text/html",
            body: '<div id="status" tabindex="-1"></div><div id="tree-container" hidden></div><div id="settings-container" hidden></div>'}));
        await page.goto(URL + "seed-native-sync");
        const outcomes = await page.evaluate(async () => {
            const {createIndexSync} = await import("./dist/index-sync.js");
            const {createIndexStartup} = await import("./dist/index-startup.js");
            const {createNativeLibrary} = await import("./dist/native-library.js");
            const outcomes = [];
            for (const disconnect of ["never", "before-reply", "after-reply"]) {
                const state = {driveID: "fixture", evidence: "evidence:signed-in"};
                const signInReply = Promise.withResolvers();
                const auth = createNativeLibrary({async postMessage(message) {
                    return message.op === "signIn" ? signInReply.promise : state;
                }});
                await auth.loadAccountState("state");
                const favoritesRead = Promise.withResolvers();
                const signInShown = Promise.withResolvers();
                const status = createIndexStartup({
                    swDebug: false, appVersionLabel: "fixture", getDebugEnabled: () => false,
                    getTestOpeningWaitMs: () => undefined, onSignIn() {},
                });
                let probes = 0;
                const sync = createIndexSync({
                    auth, accountData: new Map(),
                    oneDrive: {
                        async fetchAccountInfo() { return ++probes === 1 ? {driveId: "fixture", displayName: "Fixture"} : "network"; },
                        async probeMusicFolder() { return new Response(null, {status: 401}); },
                    },
                    canPull: () => true, hasInstalledTree: () => false,
                    getTree: () => undefined, getPlayback: () => undefined, getSelect: () => undefined,
                    getSettings: () => undefined, getShares: () => undefined,
                    getFavorites: () => ({pullFavoritesFromOneDrive: () => favoritesRead.promise}),
                    async ensureFavorites() {}, async ensureShares() {},
                    showSignIn() { status.showSignIn(); signInShown.resolve(); },
                    showOpening: status.showOpening,
                    showOpeningFailure: status.showFailure,
                    finishOpening: status.showFailureIfUnresolved,
                    computeAndPushOfflineState() {},
                });
                const startup = sync.requestPullFromOneDrive("startup");
                await signInShown.promise;
                document.querySelector(".signin-btn").disabled = true;
                const signingIn = auth.loadAccountState("signIn");
                if (disconnect === "before-reply") auth.applyEvidence("evidence:not-online");
                signInReply.resolve(state);
                await signingIn;
                const afterSignIn = sync.requestPullFromOneDrive("settings-refresh");
                if (disconnect === "after-reply") auth.applyEvidence("evidence:not-online");
                favoritesRead.resolve(false);
                await Promise.all([startup, afterSignIn]);
                outcomes.push([probes, !!document.querySelector(".startup-error[data-offline] ~ .startup-retry")]);
            }
            return outcomes;
        });
        assert(JSON.stringify(outcomes) === JSON.stringify([[2, false], [1, true], [1, true]]),
            "A connected sign-in needs a fresh pull, and an offline listener needs retry");
    },

    async "startup: native reconnect evidence wins even when its value is unchanged"(page) {
        await page.route(URL + "seed-native-evidence", route => route.fulfill({contentType: "text/html", body: "<title>Native fixture</title>"}));
        await page.goto(URL + "seed-native-evidence");
        const result = await page.evaluate(async () => {
            const {createNativeLibrary} = await import("./dist/native-library.js");
            const snapshot = Promise.withResolvers();
            const native = createNativeLibrary({postMessage: () => snapshot.promise});
            let notifications = 0;
            native.onEvidenceChange = () => notifications++;
            const pending = native.loadAccountState("state");
            native.applyEvidence("no-evidence");
            snapshot.resolve({driveID: "paired", evidence: "evidence:not-online"});
            await pending;
            return [native.state.driveID, native.getEvidence(), notifications];
        });
        assert(JSON.stringify(result) === JSON.stringify(["paired", "no-evidence", 0]),
            "A captured offline reply must preserve the pairing and the newer native observation");
    },

    async "startup: no cache and an unclassified server failure show the same retry action"(page) {
        await configureStartupScenario(page, {signedIn: true, mockGraph: true, accountStatus: 500});
        await page.goto(URL, {waitUntil: "domcontentloaded"});
        await assertStartupFailure(page, failed);
    },

    async "startup: active first-time indexing ends the visible wait and carries focus"(page) {
        await configureStartupScenario(page, {signedIn: true, mockGraph: true, holdAccountDetails: true, openingWaitMs: 180});
        await page.clock.install();
        await page.goto(URL, {waitUntil: "domcontentloaded"});
        await page.waitForFunction(() => window._testReleaseDetails);
        await page.locator(retry).focus();
        await page.evaluate(() => window._testReleaseDetails());
        await page.waitForFunction(() => window._testStartedBatch);
        await page.clock.runFor(400);
        assert(await page.locator("#status .index-progress").isVisible(), "An active index was interrupted");
        assert(!await page.locator(retry).count(), "Active indexing should own the status region");
        assert(await page.evaluate(() => document.activeElement.id) === "status", "Progress dropped focus");
        assert(await page.evaluate(() => window._testMusicRootRequestCache) === "no-store",
            "A saved folder ETag can validate a stale recursive size. The root probe must bypass HTTP cache.");
    },

    async "startup: OneDrive sign-in and scanning keep the same indexing heading"(page) {
        await page.setViewportSize({width: 390, height: 844});
        await configureStartupScenario(page, {signedIn: false, mockGraph: true, holdAccountDetails: true, openingWaitMs: 10_000});
        await page.route(URL + "seed-indexing", route => route.fulfill({contentType: "text/html", body: "<title>Seed</title>"}));
        await page.goto(URL + "seed-indexing");
        await page.evaluate(() => {
            sessionStorage.oneplay_connect_origin = "chooser";
            sessionStorage.code_verifier = "fixture-verifier";
        });
        let releaseToken;
        const tokenPending = new Promise(resolve => { releaseToken = resolve; });
        await page.route("https://login.microsoftonline.com/**/token", async route => {
            await tokenPending;
            await route.fulfill({
                headers: {"access-control-allow-origin": "*"},
                json: {access_token: "fixture-access", refresh_token: "fixture-refresh"},
            });
        });
        await page.clock.install();
        const title = page.getByText("Indexing your music...", {exact: true});
        const meter = page.locator("#status .progress-bar");
        let bounds;
        try {
            await page.goto(URL + "?code=fixture", {waitUntil: "domcontentloaded"});
            await title.waitFor({timeout: 4500});
            bounds = await title.boundingBox();
            assert(!await meter.isVisible(), "A scan meter was visible before scanning started");
            assert(!await page.locator(retry).count(), "Retry appeared before the visible wait expired");
        } finally {
            releaseToken();
        }
        await page.waitForFunction(() => window._testReleaseDetails);
        await page.clock.fastForward(10_001);
        await page.locator(retry).focus();
        assert(JSON.stringify(await title.boundingBox()) === JSON.stringify(bounds), "Retry moved the indexing heading");
        await page.evaluate(() => window._testReleaseDetails());
        await page.waitForFunction(() => window._testStartedBatch);
        assert(await meter.isVisible(), "Scanning did not reveal progress");
        assert(JSON.stringify(await title.boundingBox()) === JSON.stringify(bounds), "Real progress moved the indexing heading");
        assert(!await page.locator(retry).count(), "Retry stayed visible while scanning");
        assert(await page.evaluate(() => document.activeElement.id) === "status", "Progress dropped focus");
    },

    async "startup: a late OAuth body finishes with its one-use verifier"(page) {
        await seedCachedShare(page);
        await holdTokenBody(page);
        await page.goto(URL + "?code=fixture");
        await page.locator(retry).waitFor({timeout: 4500});
        await page.evaluate(() => window._testReleaseToken());
        await assertRestoredShare(page);
        const result = await page.evaluate(() => [localStorage.access_token, sessionStorage.usedVerifier,
            sessionStorage.tokenRequests, sessionStorage.code_verifier, location.search]);
        assert(JSON.stringify(result) === JSON.stringify(["fixture-access", "fixture-verifier", "1", null, ""]),
            "The delayed exchange did not complete exactly once");
    },

    async "startup: retry during OAuth body wait offers fresh sign-in"(page) {
        await holdTokenBody(page);
        const authorizeUrl = url => url.origin === "https://login.microsoftonline.com" && url.pathname.endsWith("/authorize");
        await page.route(authorizeUrl, route => route.fulfill({contentType: "text/html", body: "<title>Sign-in fixture</title>"}));
        await page.goto(URL + "?code=fixture");
        await page.locator(retry).click({timeout: 4500});
        await page.locator(signIn).waitFor();
        const state = await page.evaluate(() => [sessionStorage.tokenRequests, sessionStorage.code_verifier]);
        assert(state[0] === "1" && state[1] === undefined, "Retry reused the old exchange");
        const authorization = page.waitForRequest(request => authorizeUrl(new globalThis.URL(request.url())), {timeout: 4500});
        await page.locator(signIn).click();
        const params = new globalThis.URL((await authorization).url()).searchParams;
        assert(params.has("code_challenge") && params.get("code_challenge_method") === "S256", "Fresh sign-in did not start PKCE");
    },
};
