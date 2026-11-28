const assert = require('node:assert/strict');

module.exports = {
    /** Use the real offline shell, normal player controls, and enough rows to clip a playing marker. */
    async 'wheel: drawer follows Play, browsing and saved preference offline'(page) {
        const url = globalThis.__ONEPLAY_TEST_URL;
        const folder = ['OnePlay Music', 'fixture', 'Album'];
        page.setDefaultTimeout(5000);
        await page.setViewportSize({width: 390, height: 844});
        await page.route(url + 'drawer-seed', r => r.fulfill({contentType: 'text/html', body: '<title>Seed</title>'}));
        await page.route(url + 'drawer.wav', r => r.fulfill({contentType: 'audio/wav', body: silentWav()}));
        await page.goto(url + 'drawer-seed');
        await page.evaluate(async folder => {
            const {dbPut, audioPut} = await import('./dist/db.js');
            const tracks = Object.fromEntries(Array.from({length: 70}, (_, i) =>
                [`Track ${String(i + 1).padStart(2, '0')}.mp3`, {id: String(i)}]));
            await dbPut('index:fixture', {kind: 'MusicData', schemaVersion: 1, count: 71, size: 710,
                folder: {id: 'root', children: {Album: {id: 'album', children: tracks},
                    Empty: {id: 'empty', children: {}}, Other: {id: 'other', children: {'Uncached.mp3': {id: 'other-file'}}}}}});
            await dbPut('favorites', {updatedAt: 1, version: 1, favorites: [], folderPins: [
                {sourceRootKey: 'fixture', driveId: 'fixture', itemId: 'album', path: ['Album'], isFolder: true},
            ]});
            const blob = await (await fetch('drawer.wav')).blob();
            for (const id of ['0', '30', '34', '35', '36', '69']) await audioPut('fixture:' + id, blob);
            localStorage.account_info = JSON.stringify({driveId: 'fixture', displayName: 'Fixture'});
            localStorage.oneplay_music_view = JSON.stringify({path: folder, expanded: false}); // Legacy record.
            localStorage.demo_oneplay_music_view = JSON.stringify({path: ['OnePlay Music'], expanded: true, autoExpand: false});
        }, folder);
        await page.addInitScript(() => Object.defineProperty(navigator, 'onLine', {get: () => false}));
        await page.goto(url);
        const list = page.locator('#children');
        const rows = list.locator('.tree-row.file');
        const grip = page.getByRole('button', {name: 'Player controls'});
        const play = page.locator('.footer-playpause');
        const mode = page.locator('.mode-label');
        const active = () => page.evaluate(() => document.activeElement?.className);
        const stored = () => page.evaluate(() => JSON.parse(localStorage.oneplay_music_view));
        const layout = async expanded => {
            await page.waitForFunction(expanded => document.querySelector('.footer-gripper')?.getAttribute('aria-expanded') === String(expanded), expanded);
            await page.locator('.expansion').evaluate(async panel => {
                await Promise.allSettled(panel.getAnimations().map(animation => animation.finished));
            });
            assert.equal(await page.locator('.expansion').evaluate(el => el.inert), !expanded);
        };
        const playing = () => page.waitForFunction(() => {
            const audio = document.querySelector('audio');
            return !audio.paused && audio.readyState >= 2 && Number.isFinite(audio.duration) && audio.currentSrc.startsWith('blob:');
        });
        const measure = locator => locator.evaluate(el => {
            const list = document.querySelector('#children');
            const bounds = list.getBoundingClientRect();
            const marker = (el.querySelector('.track-indicator') ?? el).getBoundingClientRect();
            return {scroll: list.scrollTop, top: marker.top, bottom: marker.bottom, viewportBottom: bounds.bottom};
        });
        const nearBottom = async (row, clearance = 18) => row.evaluate((el, clearance) => {
            const list = document.getElementById('children');
            list.scrollTop += el.getBoundingClientRect().bottom - list.getBoundingClientRect().bottom + clearance;
        }, clearance);
        assert.equal(await grip.count(), 0, 'No target leaves the footer hidden');
        await rows.nth(34).waitFor();
        await page.waitForFunction(() => window._testDownloads.getSnapshot().files.has('fixture:36'));
        assert.equal(await rows.count(), 70);
        await nearBottom(rows.nth(34), 95);
        const before = await measure(rows.nth(34));
        const initiated = Date.now();
        await rows.nth(34).click();
        await layout(true);
        await playing();
        const openedMs = Date.now() - initiated;
        const after = await measure(rows.nth(34));
        assert.equal(JSON.stringify((await stored()).path), JSON.stringify(folder));
        assert.ok(after.scroll > before.scroll && Math.abs(after.bottom - after.viewportBottom) <= 1, JSON.stringify({before, after}));
        emit(`    70 rows, Play to settled drawer and audio ${openedMs}ms, marker and list ${JSON.stringify({before, after})}`);

        await list.evaluate(el => { el.scrollTop += 20; });
        await layout(true);
        await page.mouse.move(140, after.viewportBottom - 10);
        await page.mouse.wheel(60, 0);
        await layout(true);
        await page.mouse.wheel(0, 60);
        await layout(false);
        assert.equal((await stored()).autoExpand, true);
        await playing();
        await page.reload();
        await layout(false);
        assert.equal((await stored()).autoExpand, true);
        await play.click();
        await layout(true);
        await playing();
        await play.click();
        await layout(true);
        await page.mouse.move(140, after.viewportBottom - 10);
        await page.mouse.wheel(0, 30);
        await layout(false);
        await nearBottom(rows.nth(34));
        await play.focus();
        await grip.evaluate(button => button.click());
        await layout(true);
        assert.equal(await active(), 'footer-playpause');
        const manual = await measure(rows.nth(34));
        assert.ok(Math.abs(manual.bottom - manual.viewportBottom) <= 1);
        await mode.click();
        await grip.click();
        await layout(false);
        const accessibility = await page.context().newCDPSession(page);
        const {nodes} = await accessibility.send('Accessibility.getFullAXTree');
        await accessibility.detach();
        const accessibleButtons = nodes.filter(node => !node.ignored && node.role?.value === 'button').map(node => node.name?.value);
        assert.ok(accessibleButtons.includes('Player controls'));
        assert.ok(!['repeat', '+30s', '-15s'].some(name => accessibleButtons.includes(name)));
        await grip.focus();
        await page.keyboard.press('Tab');
        assert.equal(await active(), 'footer-playpause');
        await rows.nth(35).click();
        await layout(false);
        assert.equal((await stored()).autoExpand, false);
        await page.reload();
        await layout(false);
        assert.equal((await stored()).autoExpand, false);
        assert.equal(await page.locator('audio').evaluate(el => el.paused), true);
        await play.click();
        await playing();
        await layout(false);

        // Preserve compact swipe reach, while a deliberate down swipe inside the drawer opts out.
        const swipe = async (selector, dy) => {
            const box = await page.locator(selector).boundingBox();
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
            await page.mouse.down();
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + dy, {steps: 5});
            await page.mouse.up();
        };
        await swipe('.compact-gripper-reach', -45);
        await layout(true);
        await swipe('.footer-gripper', 45);
        await layout(false);
        assert.equal((await stored()).autoExpand, false);
        await grip.click();
        await layout(true);
        await page.locator('.expansion-inner').click({position: {x: 8, y: 85}});
        await layout(false);
        assert.equal((await stored()).autoExpand, false);
        await grip.click();
        await layout(true);
        await page.reload();
        await layout(true);
        assert.equal(await page.locator('audio').evaluate(el => el.paused), true);
        assert.equal((await stored()).autoExpand, true);

        await page.getByRole('button', {name: 'Search music'}).focus();
        await page.setViewportSize({width: 844, height: 390});
        await page.waitForFunction(() => document.querySelector('#tree-container').inert);
        assert.equal(await active(), 'footer-gripper');
        assert.equal((await grip.boundingBox()).height, 44);
        await page.setViewportSize({width: 390, height: 844});
        await page.waitForFunction(() => !document.querySelector('#tree-container').inert);
        await page.getByRole('button', {name: 'Search music'}).click();
        await layout(false);
        await page.getByRole('searchbox').fill('Track 37');
        await list.locator('.tree-row.file').filter({hasText: 'Track 37'}).click({timeout: 3000});
        await layout(true);
        await playing();
        await page.getByRole('button', {name: 'Open settings'}).click();
        await layout(false);
        await playing();
        assert.equal((await stored()).autoExpand, true);
        assert.equal(await page.evaluate(() => JSON.parse(localStorage.demo_oneplay_music_view).expanded), true);

        await page.getByRole('button', {name: 'Close settings'}).click();
        await page.locator('#breadcrumbs .tree-row').first().locator('.row-name').click();
        await page.getByRole('button', {name: 'Search music'}).click();
        await page.getByRole('searchbox').fill('Album');
        await grip.click();
        await layout(true);
        await list.locator('.tree-row.folder').filter({hasText: 'Album'}).click();
        await layout(false);
        assert.equal((await stored()).autoExpand, true);
        await playing();
        await page.setViewportSize({width: 844, height: 390});
        const folderPlay = page.getByRole('button', {name: 'Play Album'});
        await folderPlay.focus();
        await page.keyboard.press('Enter');
        await layout(true);
        assert.equal(await active(), 'footer-gripper', 'Keyboard folder Play hands off covered focus');
        await page.setViewportSize({width: 390, height: 844});
        await page.waitForFunction(() => !document.querySelector('#tree-container').inert);

        await setPlaybackMode(page, 'one');
        await mode.focus();
        const audio = page.locator('audio');
        const finish = async name => {
            await page.waitForFunction(name => window._testPlayback.getInfo()?.track.at(-1) === name, name);
            await playing();
            await audio.evaluate(el => { el.currentTime = el.duration; });
        };
        await finish('Track 01.mp3');
        await layout(false);
        assert.equal(await active(), 'footer-gripper');
        assert.equal((await stored()).autoExpand, true);
        await page.keyboard.press('Enter');
        await layout(true);
        await setPlaybackMode(page, 'all');
        await rows.nth(34).click();
        await finish('Track 35.mp3');
        await page.waitForFunction(() => window._testPlayback.getInfo().track.at(-1) === 'Track 36.mp3');
        await layout(true);
        await rows.nth(69).click();
        await finish('Track 70.mp3');
        await layout(false);
        assert.equal((await stored()).autoExpand, true);

        await rows.nth(34).click();
        await playing();
        await setFakeNow(page, 10_000);
        await setPlaybackMode(page, 'timer');
        await page.evaluate(() => {
            window._testNowMs += 31 * 60_000;
            document.querySelector('.footer-playpause').click();
        });
        await audio.evaluate(el => new Promise(resolve => {
            if (el.paused) requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
            else el.addEventListener('pause', resolve, {once: true});
        }));
        await layout(true); // A paused timeupdate at the same deadline belongs to manual Pause.
        const startAndWait = async button => {
            await page.evaluate(() => {
                window.resumed = new Promise(resolve => document.querySelector('audio').addEventListener('playing', () => resolve(), {once: true}));
            });
            await button.click();
            await page.evaluate(() => window.resumed);
        };
        await startAndWait(play);
        await playing();
        await page.evaluate(() => {
            window._testNowMs += 31 * 60_000;
            const audio = document.querySelector('audio');
            audio.currentTime = audio.duration;
        });
        await layout(false);
        assert.equal(await page.evaluate(() => window._testPlayback.getInfo().track.at(-1)), 'Track 35.mp3');
        assert.equal(await audio.evaluate(el => el.paused), true);

        await startAndWait(rows.nth(69));
        await page.evaluate(() => { window._testNowMs += 20 * 60_000; });
        await finish('Track 70.mp3');
        await layout(false);
        await startAndWait(play);
        await page.evaluate(() => { window._testNowMs += 11 * 60_000; });
        await dispatchAudioTimeupdate(page);
        assert.equal(await audio.evaluate(el => el.paused), false, 'Replay after the last track starts a fresh Timer');
        await layout(true);
    },

    /** A command receipt proves which run accepted Play, even when the live sample arrives first. */
    async 'wheel: native admission survives a join and rejects a delayed Play after a stop'(page) {
        const url = globalThis.__ONEPLAY_TEST_URL;
        await page.route(url, r => r.fulfill({contentType: 'text/html', body:
            '<link rel="stylesheet" href="index.css"><div id="footer"></div>'}));
        const open = async (restoring = false, rejecting = false) => {
            await page.goto(url);
            await page.evaluate(async ({restoring, rejecting}) => {
                const {attachNativePlayback} = await import('./dist/native-playback.js');
                const folder = ['OnePlay Music', 'demo', 'Album'];
                const tracks = ['a', 'b'].map(itemId => ({path: [...folder, itemId], key: itemId,
                    itemId, driveId: 'demo', sourceRootKey: 'demo', title: itemId, album: 'Album'}));
                const footer = document.getElementById('footer');
                const acceptedPlay = {session: 'session', targetRevision: 1, naturalStopID: 4};
                let sequence = 0;
                let sample = {naturalStopID: 4};
                window.publish = (item, stopID, state = 'playing', foregroundStart = true, session = acceptedPlay.session) => {
                    sample = {...acceptedPlay, ...(foregroundStart && {foregroundStart}), naturalStopID: stopID,
                        session, item, title: item, folder, path: item ? [...folder, item] : undefined, folderKey: 'album', state};
                    window.dispatchEvent(new CustomEvent('oneplay-playback', {detail: {sequence: ++sequence, snapshot: sample}}));
                };
                const initial = {expanded: true, autoExpand: true};
                const native = {async playback(action) {
                    if (action === 'snapshot' && restoring) {
                        await new Promise(resolve => { window.releaseRestore = resolve; });
                    }
                    const reply = {sequence: ++sequence, snapshot: sample};
                    if (action === 'intent') return {...reply, base: ''};
                    if (action === 'start') {
                        if (rejecting) throw new Error('unavailableOffline');
                        const old = {...reply, snapshot: {...sample, ...acceptedPlay, foregroundStart:true, item: 'a', state: 'positioning'}};
                        await new Promise(resolve => { window.releasePlay = resolve; });
                        return {...old, acceptedPlay};
                    }
                    return reply;
                }};
                const drawer = attachNativePlayback(native, footer,
                    info => { window.paintedTrack = info?.track.at(-1); }, () => {}, () => {}, {
                        initial, onStateChange: state => { window.savedDrawer = state; },
                        captureMarkerReveal: () => { window.revealedTrack = window.paintedTrack; },
                    });
                window.browse = drawer.collapse;
                window.start = () => { window.started = drawer.start({folder, tracks, folderKey: 'album'}, 0, true, '30m'); };
                window.beginNewSelection = drawer.beginSelection;
                window.rejectSelection = drawer.cancelSelection;
            }, {restoring, rejecting});
        };
        const isExpanded = () => page.locator('.footer-gripper').getAttribute('aria-expanded');
        for (const outcome of ['advance', 'stop', 'browse', 'pause', 'superseded', 'late-paint', 'during-cancel']) {
            await open();
            await page.evaluate(() => window.start());
            await page.waitForFunction(() => !!window.releasePlay, undefined, {timeout: 3000});
            await page.evaluate(async outcome => {
                if (outcome === 'late-paint' || outcome === 'during-cancel') window.beginNewSelection();
                const cancelling = outcome === 'during-cancel' ? window.rejectSelection() : undefined;
                window.publish('a', 4, 'positioning');
                if (outcome === 'advance') window.publish('b', 4);
                if (outcome === 'stop') window.publish('a', 5); // Timer and remote Resume can keep the target revision.
                if (outcome === 'browse') window.browse();
                if (outcome === 'pause') window.publish('a', 4, 'paused');
                await cancelling;
            }, outcome);
            assert.equal(await isExpanded(), 'false');
            if (outcome === 'superseded') await page.evaluate(() => window.beginNewSelection());
            if (outcome === 'superseded' || outcome === 'late-paint') await page.evaluate(() => window.rejectSelection());
            await page.evaluate(async () => { window.releasePlay(); await window.started; });
            assert.equal(await isExpanded(), String(outcome === 'advance'));
            assert.equal(await page.evaluate(() => window.revealedTrack), outcome === 'advance' ? 'b' : undefined);
            if (outcome !== 'advance') assert.equal(await page.evaluate(() => window.savedDrawer.expanded), false);
            if (outcome === 'advance') {
                await page.evaluate(() => {
                    window.publish(undefined, 4, 'ended'); // A held track at a fenced boundary has no target row.
                    window.publish('b', 4);
                });
                assert.equal(await isExpanded(), 'true', 'A fenced continuation restores the existing layout');
                await page.evaluate(() => window.publish('b', 5)); // A live view missed the stop before remote Play.
                assert.equal(await isExpanded(), 'false');
                await page.locator('.footer-gripper').click();
                await page.evaluate(() => window.publish('b', 5));
                assert.equal(await isExpanded(), 'true', 'The stop collapses once');
            }
        }
        for (const browse of [false, true]) {
            await open(true);
            await page.evaluate(browse => {
                if (browse) window.browse();
                window.publish('a', 5, 'paused', false);
                window.releaseRestore();
            }, browse);
            assert.equal(await isExpanded(), String(!browse));
            assert.equal(await page.evaluate(() => window.revealedTrack), undefined);
        }

        await open(false, true);
        await page.evaluate(async () => {
            window.start();
            await window.started;
            window.beginNewSelection();
            await window.rejectSelection();
            window.publish('a', 4, 'paused', false); // Legacy restore after blocked selections.
        });
        assert.equal(await isExpanded(), 'true');
        assert.equal(await page.evaluate(() => window.savedDrawer), undefined);
        assert.equal(await page.evaluate(() => window.revealedTrack), undefined);

        await open();
        await page.evaluate(() => window.start());
        await page.waitForFunction(() => !!window.releasePlay);
        await page.evaluate(() => window.publish('old', 4, 'paused', false, 'restored-session'));
        assert.equal(await isExpanded(), 'true', 'A delayed restored target uses the saved layout immediately');
        await page.evaluate(async () => {
            window.publish('a', 4, 'positioning');
            window.beginNewSelection();
            await window.rejectSelection();
            window.releasePlay();
            await window.started;
        });
        assert.equal(await isExpanded(), 'true');
        assert.equal(await page.evaluate(() => window.revealedTrack), undefined);
    },

    /** Rotating an open phone player must leave its wheel and two-line title fully usable. */
    async 'wheel: landscape fits the wheel, mode and wrapped title after rotation'(page) {
        const url = globalThis.__ONEPLAY_TEST_URL;
        await page.setViewportSize({width:390, height:844});
        await page.route('https://graph.microsoft.com/**', route => route.abort());
        await page.route(url + 'seed', route => route.fulfill({contentType:'text/html', body:'<title>Seed</title>'}));
        await page.goto(url + 'seed');
        const title = "Trodd en Bratt Say 'Well Done You' – Series Two, Episode Four – "
            + "The complete Sunday evening broadcast, including the introduction and closing credits.mp3";
        await page.evaluate(async title => {
            const {dbPut} = await import('./dist/db.js');
            const children = Object.fromEntries(['GoldenEye.mp3', title].map((name, i) => [name, {id:String(i)}]));
            await dbPut('index:show', {kind:'MusicData', schemaVersion:1, count:2, size:20, folder:{id:'root', children}});
            localStorage.setItem('account_info', JSON.stringify({driveId:'show', displayName:'Comedy Offline'}));
        }, title);
        await page.goto(url);
        await page.waitForFunction(() => !!window._testPlayback);
        await page.evaluate(async title => {
            const folder = ['OnePlay Music','show'];
            window._testTree.setSelectedPath(folder);
            await window._testPlayback.restoreVisualState(folder, [...folder,title], 'all', 0);
        }, title);
        await page.locator('.footer-gripper').click();
        await page.setViewportSize({width:844, height:390});
        const footer = page.locator('#footer.expanded');
        await footer.waitFor();
        const wheel = await footer.locator('.scrubber-shell').boundingBox();
        const bar = await footer.locator('.footer-bar').boundingBox();
        const grip = await footer.locator('.footer-gripper').boundingBox();
        assert.equal(grip.y, 1);
        assert.equal(bar.y + bar.height, 390);
        assert.equal(wheel.y, grip.y + grip.height);
        assert.equal(wheel.width, wheel.height);
        assert.equal(wheel.y + wheel.height, bar.y);
        assert.ok((await footer.locator('.footer-title').boundingBox()).height > 28, 'Title uses both lines');
        const mode = footer.locator('.mode-label');
        await mode.click();
        assert.equal(await mode.textContent(), 'repeat');
        await page.locator('.footer-gripper').click();
        await page.locator('#children .file').first().click({trial:true});
        const glyphHeights = await page.locator('#children .file .row-name').evaluateAll(names => names.map(name => {
            const glyph = document.createRange();
            glyph.setStart(name.firstChild, 0);
            glyph.setEnd(name.firstChild, 1);
            return glyph.getBoundingClientRect().height;
        }));
        assert.equal(glyphHeights.length, 2);
        assert.equal(glyphHeights[0], glyphHeights[1], 'Short and long filenames use the same rendered text size');
        await page.locator('.footer-gripper').click();
        assert.deepEqual(await footer.locator('.scrubber-shell').boundingBox(), wheel);
        await page.locator('.footer-gripper').click();
    },

    /** Decode distinct files through the browser player while row positions and a prepared successor change. */
    async 'wheel: browser playlist edits keep audible identity through a fenced boundary and cold restart'(page) {
        const url = globalThis.__ONEPLAY_TEST_URL;
        await page.route(url, r => r.fulfill({contentType: 'text/html', body:
            '<link rel="stylesheet" href="index.css"><button id="start">Start</button><audio muted></audio><div id="footer"></div>'}));
        await page.route('**/edit.wav', r => r.fulfill({contentType: 'audio/wav', body: silentWav()}));
        async function open() {
            await page.goto(url);
            await page.evaluate(async () => {
                const [{createPlayback}, {createFavorites}, {dbGet, dbPut}, {parseGlobalPlaybackTime}] = await Promise.all(
                    ['playback', 'favorites', 'db', 'playback-engine'].map(module => import('./dist/' + module + '.js')));
                const root = ['OnePlay Music', 'fav:show'];
                const member = name => ({driveId: 'drive', itemId: name, path: [name], isFolder: name === 'archive'});
                const children = Object.fromEntries(['A', 'B', 'C', 'D'].map(k => [k, {id: k}]));
                children.archive = {id: 'archive', children: Object.fromEntries(Array.from({length: 30_000}, (_, i) =>
                    ['extra' + i, {id: 'e' + i}]))};
                const folder = {id: 'library', children};
                const accounts = new Map([['drive', {driveId: 'drive', folder}]]);
                const roots = new Map([['drive', {type: 'onedrive', key: 'drive', name: 'Drive', info: {driveId: 'drive'}, folder}]]);
                const audio = document.querySelector('audio');
                const p = createPlayback(audio, document.querySelector('#footer'), async () => { throw new Error('Media unavailable'); });
                const wav = await (await fetch('edit.wav')).arrayBuffer();
                p.setDownloads({getOfflineBlob: async (_, id) => {
                    window.lastRead = id;
                    const bytes = new Uint8Array(wav.slice(0));
                    bytes[44] = id.charCodeAt(0);
                    return new Blob([bytes], {type: 'audio/wav'});
                }});
                const favs = createFavorites({dbGet, dbPut: async (key, value) => {
                    await dbPut(key, value);
                    if (window.holdWrite) await new Promise(resolve => { window.releaseWrite = resolve; });
                }, documents: {read: async () => null, write: async () => {}}, fenceQueueEdit: () => p.fenceQueueEdit()}, async () => {
                    p.setContext(favs, roots);
                    await p.refreshLibraryQueue(true);
                });
                await favs.loadFromCache();
                if (!favs.getAll().length) await favs.add({kind: 'playlist', id: 'show', name: 'Show',
                    hasPrivatePlayback: false, members: ['A', 'B', 'C', 'D', 'archive'].map(member)});
                const saved = JSON.parse(localStorage.getItem('oneplay_music_playback'));
                if (saved) await p.restoreVisualState(saved.folder, saved.track, saved.mode,
                    parseGlobalPlaybackTime(localStorage.oneplay_music_time, saved), saved.favId, accounts, saved);
                document.querySelector('#start').onclick = () => p.playFolder(root, accounts);
                window.removeAt = i => favs.removeMembers('show', [i]);
                window.startVanishingFolder = async () => {
                    await favs.add({kind: 'playlist', id: 'vanishing', name: 'Vanishing',
                        hasPrivatePlayback: false, members: [member('A')]});
                    window.releaseWrite = undefined;
                    window.holdWrite = true;
                    window.editDone = favs.remove('vanishing');
                };
                window.playVanishing = () => p.playFolder(['OnePlay Music', 'fav:vanishing'], accounts);
                window.startDuplicates = async () => {
                    await favs.add({kind: 'playlist', id: 'twice', name: 'Twice', hasPrivatePlayback: false,
                        members: ['A', 'B', 'B', 'C', 'D'].map(member)});
                    await p.playTrack(['OnePlay Music', 'fav:twice', 'm:1'], accounts);
                };
                window.removeDuplicate = () => favs.removeMembers('twice', [2]);
                window.reverseTwice = async () => {
                    const data = await dbGet('favorites');
                    data.favorites.find(f => f.id === 'twice').members.reverse();
                    await dbPut('favorites', data);
                    await favs.loadFromCache();
                };
                window.restoreDuplicate = async () => {
                    const {favorites} = await dbGet('favorites');
                    const incoming = structuredClone(favorites);
                    incoming.find(f => f.id === 'twice').members.splice(2, 0, member('B'));
                    await dbPut('favorites', {version: 1, updatedAt: Date.now(), favorites: incoming});
                    await favs.loadFromCache();
                };
                window.ack = () => p.refreshLibraryQueue(true);
                window.info = () => p.getInfo();
                window.sourceLetter = async () => String.fromCharCode(new Uint8Array(await (await fetch(audio.src)).arrayBuffer())[44]);
            });
        }
        await open();
        await page.locator('#start').click();
        const audible = async letter => {
            await page.waitForFunction(() => document.querySelector('audio').readyState >= 2 && !document.querySelector('audio').paused);
            assert.equal(await page.evaluate(() => window.sourceLetter()), letter);
            assert.equal(await page.locator('.footer-title').textContent(), letter);
        };
        await audible('A');
        const audio = page.locator('audio');
        await audio.evaluate(el => { el.currentTime = 80; el.dispatchEvent(new Event('timeupdate')); });
        await page.waitForFunction(() => window.lastRead === 'B');
        // B is already prepared. Hold the durable edit's acknowledgment, then finish A.
        await page.evaluate(() => { window.holdWrite = true; window.editDone = window.removeAt(1); });
        await page.waitForFunction(() => typeof window.releaseWrite === 'function');
        await audio.evaluate(el => el.dispatchEvent(new Event('ended')));
        assert.equal(await page.locator('.footer-title').textContent(), 'A');
        await page.evaluate(async () => { window.holdWrite = false; window.releaseWrite(); await window.editDone; await window.ack(); });
        await audible('C');
        assert.equal(await page.locator('.footer-gripper').getAttribute('aria-expanded'), 'true');
        assert.equal(await page.evaluate(() => window.info().track.at(-1)), 'm:1');
        // Commit a second edit that removes C, then lose the page before its revised queue is acknowledged.
        await page.evaluate(() => { window.releaseWrite = undefined; window.holdWrite = true; window.editDone = window.removeAt(1); });
        await page.waitForFunction(() => typeof window.releaseWrite === 'function');
        await open();
        assert.equal(await page.locator('.footer-title').textContent(), 'C');
        assert.equal(await page.locator('.footer-indicator').getAttribute('aria-disabled'), 'true');
        assert.equal(await page.evaluate(() => window.info()), undefined);
        assert.equal(await audio.evaluate(el => el.src), '');
        await page.locator('.footer-playpause').evaluate(el => el.click());
        await audible('C');
        await audio.evaluate(el => el.dispatchEvent(new Event('ended')));
        await audible('D');
        assert.equal(await page.evaluate(() => window.info().track.at(-1)), 'm:1');

        // A 2→1 duplicate group has no safe match. Restoring the identical group reattaches
        // the original ordinal and preserves its actual media source, position and pause state.
        await page.evaluate(() => window.startDuplicates());
        await audible('B');
        const heldSource = await audio.evaluate(el => { el.pause(); el.currentTime = 26; return el.src; });
        await page.evaluate(() => window.removeDuplicate());
        assert.equal(await page.evaluate(() => window.info()), undefined);
        assert.equal(await page.locator('.footer-title').textContent(), 'B');
        await page.evaluate(() => window.restoreDuplicate());
        assert.equal(await page.evaluate(() => window.info().track.at(-1)), 'm:1');
        assert.deepEqual(await audio.evaluate(el => [el.src, el.paused, Math.round(el.currentTime)]), [heldSource, true, 26]);

        // A held Previous in Shuffle or Repeat scans its former pass without wrapping.
        await setPlaybackMode(page, 'repeat');
        await page.evaluate(() => window.removeDuplicate());
        await page.locator('.scrubber-edge-button.left').evaluate(el => el.click());
        await audible('A');
        // Shuffle [A,B,C,D] with deterministic draws -> [A,C,D,B]. Reverse the
        // canonical rows. A and its successor C keep their shuffled positions and get fresh paths.
        await page.evaluate(() => { Math.random = () => 0.01; });
        await setPlaybackMode(page, 'shuffle');
        await page.evaluate(() => window.reverseTwice());
        assert.equal(await page.evaluate(() => window.info().track.at(-1)), 'm:3');
        await page.locator('.scrubber-edge-button.right').evaluate(el => el.click());
        await audible('C');
        assert.equal(await page.evaluate(() => window.info().track.at(-1)), 'm:1');
        await setPlaybackMode(page, 'one');
        await page.locator('.scrubber-edge-button.left').evaluate(el => el.click());
        await audible('D');

        // The old row is still selectable while its deletion is waiting for disk.
        // Its folder selection must not clear D when the rebuilt target is empty.
        await page.evaluate(() => window.startVanishingFolder());
        await page.waitForFunction(() => typeof window.releaseWrite === 'function');
        await page.evaluate(async () => {
            const selected = window.playVanishing();
            // Queue walking and publication settle in microtasks for this one-entry target.
            await new Promise(resolve => setTimeout(resolve, 0));
            window.holdWrite = false;
            window.releaseWrite();
            await Promise.all([selected, window.editDone]);
        });
        await audible('D');

        // The edit's recovery checkpoint must survive before the membership write can commit.
        const quota = await page.evaluate(async () => {
            const original = Storage.prototype.setItem;
            Storage.prototype.setItem = function(key, text) {
                if (key === 'oneplay_music_playback') throw new DOMException('fixture', 'QuotaExceededError');
                return original.call(this, key, text);
            };
            try { await window.removeDuplicate(); return 'unexpected success'; }
            catch (error) { return error.name; }
            finally { Storage.prototype.setItem = original; }
        });
        assert.equal(quota, 'QuotaExceededError');
        assert.equal(await page.locator('.footer-title').textContent(), 'D');
        assert.equal(await page.locator('#footer').getAttribute('aria-busy'), null);
    },

    /** Exercise selection, mode picks and bookmarks through the browser player with a known pass. */
    async 'wheel: favorite modes follow the playing route independently of Remember my spot'(page) {
        const url = globalThis.__ONEPLAY_TEST_URL;
        await page.route(url, r => r.fulfill({contentType: 'text/html', body:
            '<link rel="stylesheet" href="index.css"><audio muted></audio><div id="footer"></div>'}));
        await page.route('**/mode.wav', r => r.fulfill({contentType: 'audio/wav', body: silentWav()}));
        await page.goto(url);
        await page.evaluate(async () => {
            const [{createPlayback}, {createFavorites}] = await Promise.all(
                ['playback', 'favorites'].map(m => import('./dist/' + m + '.js')));
            const folder = {id: 'album', children: Object.fromEntries(['A','B','C'].map(id => [id, {id}]))};
            const roots = new Map([['drive', {type: 'onedrive', key: 'drive', name: 'Album', folder, info: {driveId: 'drive'}}]]);
            const accounts = new Map([['drive', {driveId: 'drive', folder}]]);
            const audio = document.querySelector('audio');
            const player = createPlayback(audio, document.querySelector('#footer'), async () => { throw new Error('Media unavailable'); });
            const wav = await (await fetch('mode.wav')).arrayBuffer();
            player.setDownloads({getOfflineBlob: async (_, id) => {
                const bytes = new Uint8Array(wav.slice(0));
                bytes[44] = id.charCodeAt(0);
                return new Blob([bytes], {type: 'audio/wav'});
            }});
            const favorites = createFavorites({dbPut: async () => {}, documents: {read: async () => null, write: async () => {}}}, async () => {
                player.setContext(favorites, roots);
                await player.refreshLibraryQueue(true);
            });
            for (const remember of [false, true]) {
                await favorites.add({kind: 'shortcut', id: String(remember), name: 'Album', hasPrivatePlayback: remember,
                    target: {driveId: 'drive', sourceRootKey: 'drive', itemId: 'album', path: [], isFolder: true}});
            }
            Math.random = () => 0;
            window.selectAlbum = (root, track) => {
                const path = ['OnePlay Music', root];
                return track ? player.playTrack([...path, track], accounts) : player.playFolder(path, accounts);
            };
            window.changeFavorite = (id, mode) => favorites.setMode(id, mode);
            window.setRemember = (id, remember) => favorites.setHasPrivatePlayback(id, remember);
        });
        const choose = (root, track) => page.evaluate(([r, t]) => window.selectAlbum(r, t), [root, track]);
        const mode = page.locator('.mode-label');
        const title = page.locator('.footer-title');
        for (const remember of [false, true]) {
            const id = String(remember), favorite = 'fav:' + id;
            await choose('drive');
            await setPlaybackMode(page, 'one');
            await choose(favorite, 'B');
            assert.equal(await mode.textContent(), 'one');
            await setPlaybackMode(page, 'shuffle');
            await choose('drive');
            assert.equal(await mode.textContent(), 'shuffle');
            assert.equal(await title.textContent(), 'B'); // Fresh [B,C,A] pass.
            await setPlaybackMode(page, 'all');
            await choose(favorite, 'A');
            assert.equal(await title.textContent(), 'A');
            assert.equal(await mode.textContent(), 'shuffle');
            await page.locator('.scrubber-edge-button.right').evaluate(el => el.click());
            // Tapped A first, then shuffled [C,B]. Wait for the new source to play past zero.
            await page.waitForFunction(() => document.querySelector('.footer-title').textContent === 'C'
                && !document.querySelector('audio').paused && document.querySelector('audio').currentTime > 0.05);
            assert.equal(await page.evaluate(async () => {
                const bytes = await (await fetch(document.querySelector('audio').src)).arrayBuffer();
                return String.fromCharCode(new Uint8Array(bytes)[44]);
            }), 'C');

            await page.evaluate(id => window.changeFavorite(id, 'one'), id);
            await page.evaluate(id => window.setRemember(id, id !== 'true'), id);
            assert.equal(await mode.textContent(), 'shuffle');
            await choose(favorite, 'A');
            assert.equal(await mode.textContent(), 'one');
            await page.evaluate(id => window.setRemember(id, id === 'true'), id);
            // The user's next selection sees the mode picked by this tap.
            await page.evaluate(root => {
                document.querySelector('.mode-label').click(); // One -> Timer.
                return window.selectAlbum(root, 'C');
            }, favorite);
            assert.equal(await mode.textContent(), 'timer');
            assert.equal(await title.textContent(), 'C');
        }
        // Sequential folder Play restores the private spot. A track tap starts that track at zero.
        const audio = page.locator('audio');
        await page.waitForFunction(() => document.querySelector('audio').readyState >= 2);
        await audio.evaluate(el => { el.pause(); el.currentTime = 28; });
        await page.waitForFunction(() => JSON.parse(localStorage['oneplay_music_fav:true']).time >= 28);
        await choose('drive');
        await choose('fav:true');
        await page.waitForFunction(() => document.querySelector('audio').currentTime >= 28);
        assert.equal(await title.textContent(), 'C');
        await choose('fav:true', 'C');
        await page.waitForFunction(() => document.querySelector('audio').readyState >= 2);
        assert.ok(await audio.evaluate(el => el.currentTime < 2));
    },

    /** Drive the native drawer through the snapshots from a cold Prev, including the gaps
     * between required reads. The fake clock makes a short wait and a visible wait distinct. */
    async 'wheel: native spinner stays through successive reads until playback'(page) {
        const url = globalThis.__ONEPLAY_TEST_URL;
        await page.route(url, route => route.fulfill({contentType: 'text/html', body: '<div id="footer"></div>'}));
        await page.goto(url);
        await page.clock.install({time: new Date('2026-01-01T00:00:00Z')});
        await page.clock.pauseAt(new Date('2026-01-01T00:01:00Z'));
        await page.evaluate(async () => {
            const {attachNativePlayback} = await import('./dist/native-playback.js');
            let reply = {sequence: 1, snapshot: {}};
            const native = {state: {}, playback: async () => reply};
            attachNativePlayback(native, document.querySelector('#footer'), info => { window.rowPhase = info?.phase; }, () => {}, () => {});
            window.pushPlayback = (state, targetRevision) => {
                reply = {sequence: reply.sequence + 1, snapshot: {state, targetRevision, item: 'occurrence', path: ['Satie', 'Track']}};
                window.dispatchEvent(new CustomEvent('oneplay-playback', {detail: reply}));
            };
        });
        const push = (state, target = 1) => page.evaluate(([s, r]) => window.pushPlayback(s, r), [state, target]);
        const check = async loading => {
            const indicators = await page.evaluate(() => [
                window.rowPhase === 'loading',
                document.querySelector('.footer-indicator').classList.contains('loading'),
                document.querySelector('.scrubber-text').classList.contains('loading'),
            ]);
            assert.deepEqual(indicators, [loading, loading, loading]);
        };
        await push('buffering');
        await page.clock.runFor(249);
        await check(false);
        await push('positioning'); // A brief miss during otherwise local setup.
        await page.clock.runFor(500);
        await check(false);
        await push('buffering');
        await page.clock.runFor(250);
        await check(true);
        // Swift can decline Prev at the start of the queue; its unchanged snapshot keeps this wait.
        await page.locator('.scrubber-edge-button.left').evaluate(button => button.click());
        await check(true);
        for (const state of ['positioning', 'buffering', 'positioning']) {
            await push(state);
            await check(true);
        }
        await push('playing');
        await check(false);
        // Apply the same rule to a stall after playback has started. A native seek that
        // preserves the occurrence gets a fresh target even when no web command was issued.
        await push('buffering');
        await page.clock.runFor(250);
        await check(true);
        await push('positioning', 2);
        await page.clock.runFor(500);
        await check(false);
        for (const state of ['paused', 'ended', 'error']) {
            await push('buffering', 2);
            await page.clock.runFor(250);
            await check(true);
            await push(state, 2);
            await check(false);
        }
    },
    /** The outgoing row's geometry decides whether Next and ended may move the tree. */
    async 'wheel: follow visible playback across rows and folders'(page) {
        const url = globalThis.__ONEPLAY_TEST_URL;
        await page.setViewportSize({width: 390, height: 844});
        await page.route(url, route => route.fulfill({contentType: 'text/html', body:
            '<link rel="stylesheet" href="index.css"><div id="tree-container"><div id="breadcrumbs"></div><div id="children"></div></div><audio id="player" muted></audio><div id="footer"></div>'}));
        await page.route('**/wheel-test.wav', route => route.fulfill({contentType: 'audio/wav', body: silentWav()}));
        await page.goto(url);
        await page.evaluate(async () => {
            const {createPlayback} = await import('./dist/playback.js');
            const {createTree} = await import('./dist/tree.js');
            const {createFavorites} = await import('./dist/favorites.js');
            const root = ['OnePlay Music', 'drive'];
            const album = id => ({id, children: Object.fromEntries(Array.from({length: 50}, (_, i) => {
                const name = String(i).padStart(2, '0');
                return [name, {id: id + name}];
            }))});
            const folder = {id: 'root', children: {A: album('A'), B: album('B')}};
            const tree = createTree(document.querySelector('#tree-container'));
            tree.setAccount('drive', folder, {driveId: 'drive', displayName: 'Music'});
            tree.setFavorites(createFavorites({}, () => {}));
            const media = URL.createObjectURL(await (await fetch('wheel-test.wav')).blob());
            const player = createPlayback(document.querySelector('audio'), document.querySelector('#footer'),
                async () => ({url: media}));
            player.onPlaybackChange = tree.setPlaybackInfo;
            const accounts = new Map([['drive', {driveId: 'drive', folder}]]);
            await player.playFolder(root, accounts);
            tree.setSelectedPath([...root, 'A']);
            window.pick = name => player.playTrack([...root, 'A', name], accounts);
            await window.pick('25');
            await Promise.all(document.querySelector('.expansion').getAnimations().map(a => a.finished));
        });
        const state = () => page.evaluate(() => {
            const list = document.querySelector('#children');
            const row = list.querySelector('.track-indicator')?.closest('.tree-row');
            const r = row?.getBoundingClientRect(), l = list.getBoundingClientRect();
            return {path: row && JSON.parse(row.dataset.path).slice(-2).join('/'), scroll: list.scrollTop,
                visible: !!r && r.top >= l.top - 1 && r.bottom <= l.bottom + 1};
        });
        const next = () => page.locator('.scrubber-edge-button.right').click();
        // Only the top three pixels of 25 are visible. Next should bring all of 26 into view.
        await page.locator('#children').evaluate(list => {
            const r = list.querySelector('.track-indicator').closest('.tree-row').getBoundingClientRect();
            list.scrollTop += r.top - list.getBoundingClientRect().bottom + 3;
        });
        await next();
        assert.equal((await state()).path, 'A/26');
        assert.ok((await state()).visible, 'Next should fully reveal the row below the list');
        // Browsing higher in the same folder, including when only the footer title is visible.
        await page.locator('#children').evaluate(list => { list.scrollTop = 27; });
        await next();
        assert.equal((await state()).scroll, 27);
        assert.equal((await state()).path, 'A/27');
        // The queue crosses a folder boundary. Only follow it when the listener can see A/49.
        const finishA = async visible => {
            await page.evaluate(visible => {
                window.pick('49');
                document.querySelector('#children').scrollTop = visible ? 1e6 : 27;
            }, visible);
            await page.waitForFunction(() => document.querySelector('audio').readyState >= 2 && !!document.querySelector('audio').src);
            await page.locator('audio').evaluate(audio => audio.dispatchEvent(new Event('ended')));
            await page.waitForFunction(() => document.querySelector('.footer-title').textContent === '00');
        };
        await finishA(false);
        assert.equal((await state()).scroll, 27);
        assert.equal((await state()).path, undefined);
        await finishA(true);
        assert.equal((await state()).path, 'B/00');
        assert.ok((await state()).visible);
    },
    /** Exercise the real wheel, player and media element without account or timing dependencies. */
    async 'wheel: preview, release, cancellation and stale playback'(page) {
        const url = globalThis.__ONEPLAY_TEST_URL;
        await page.route(url, route => route.fulfill({ contentType: 'text/html', body:
            '<link rel="stylesheet" href="index.css"><button id="start">Play</button><audio id="player" muted></audio><div id="footer"></div>' }));
        await page.route('**/wheel-test.wav*', route => route.fulfill({ contentType: 'audio/wav', body: silentWav() }));
        await page.goto(url);
        await page.evaluate(async () => {
            const { createPlayback } = await import('./dist/playback.js');
            const audio = document.querySelector('audio');
            document.addEventListener('pointerdown', e => { window.wheelTestPointerId = e.pointerId; });
            const blob = await (await fetch('wheel-test.wav')).blob();
            const mediaUrl = URL.createObjectURL(blob);
            window.replaceWheelTestSource = () => { audio.src = URL.createObjectURL(blob); };
            const player = createPlayback(audio, document.querySelector('#footer'), async () => ({url: mediaUrl}));
            const folder = { id: 'root', children: { A: { id: 'a' }, B: { id: 'b' } } };
            const accounts = new Map([['drive', { driveId: 'drive', folder }]]);
            document.querySelector('#start').onclick = () => player.playTrack(['OnePlay Music', 'drive', 'A'], accounts);
        });
        await page.locator('#start').click();
        await page.waitForFunction(() => !player.paused && player.currentTime > 0);
        // There is no ticking clock to repair a missing first paint on expansion.
        const audio = page.locator('audio');
        /** Wait for the real media seek with a bounded, condition-based assertion. */
        const waitForPosition = (seconds, tolerance = 1) =>
            page.waitForFunction(({ target, tolerance }) => {
                const el = document.querySelector('audio');
                return !el.seeking && Math.abs(el.currentTime - target) < tolerance;
            }, { target: seconds, tolerance }, { timeout: 3000 });
        const seekTo = async seconds => {
            await audio.evaluate((el, target) => { el.currentTime = target; }, seconds);
            await waitForPosition(seconds);
        };
        await audio.evaluate(el => el.pause());
        await seekTo(65);
        const opening = await page.evaluate(() => {
            const gripper = document.querySelector('.footer-gripper');
            if (gripper.getAttribute('aria-expanded') === 'true') gripper.click();
            gripper.click();
            return document.querySelector('.scrubber-text span').textContent;
        });
        assert.equal(opening, '1:05 / 2:00');
        await audio.evaluate(el => el.play());
        const base = Date.now();
        await setFakeNow(page, base);
        await setPlaybackMode(page, 'timer');
        await setFakeNow(page, base + 20 * 60000);

        const shell = page.locator('.scrubber-shell');
        // Start between buttons, move clockwise by 1/12 turn (+18 seconds).
        const box = await shell.boundingBox();
        const point = angle => ({
            x: box.x + box.width / 2 + (box.width / 2 - 34) * Math.cos(angle),
            y: box.y + box.height / 2 + (box.width / 2 - 34) * Math.sin(angle),
        });
        const start = point(Math.PI / 4);
        const end = point(Math.PI / 4 + Math.PI / 6);
        const time = () => audio.evaluate(el => el.currentTime);
        const pause = () => audio.evaluate(el => el.pause());
        const play = () => audio.evaluate(el => el.play());
        const isPaused = () => audio.evaluate(el => el.paused);

        /** Each drag starts from a known media position, with a real captured pointer. */
        const dragFrom = async seconds => {
            await seekTo(seconds);
            await page.mouse.move(start.x, start.y);
            await page.mouse.down();
            await page.mouse.move(end.x, end.y);
            assert.ok(Math.abs(await time() - seconds) < 1, 'drag must only preview');
        };

        await dragFrom(10);
        await dispatchAudioTimeupdate(page);
        assert.match(await page.locator('.scrubber-text span').textContent(), /^0:2[78] \/ 2:00$/);
        await page.mouse.up();
        await waitForPosition(28);
        assert.equal(await isPaused(), false, 'playing release');
        await setFakeNow(page, base + 31 * 60000);
        await dispatchAudioTimeupdate(page);
        assert.equal(await isPaused(), false, 'valid release must extend the original 30-minute deadline');
        await dragFrom(10);
        await setFakeNow(page, base + 51 * 60000);
        await dispatchAudioTimeupdate(page);
        assert.equal(await isPaused(), true, 'the rearmed deadline must still expire');
        assert.equal(await shell.evaluate(el => el.hasPointerCapture(window.wheelTestPointerId)), false);
        const stoppedAt = await time();
        await page.mouse.up();
        assert.equal(await isPaused(), true, 'late release must leave Timer paused');
        assert.equal(await time(), stoppedAt);
        await page.locator('.footer-gripper').click();
        await page.locator('.expansion').evaluate(async el => {
            await Promise.allSettled(el.getAnimations().map(animation => animation.finished));
        });

        await pause();
        await dragFrom(10);
        await page.mouse.up();
        await waitForPosition(28);
        assert.equal(await isPaused(), true, 'paused release');

        await play();
        await dragFrom(10);
        await pause();
        await page.mouse.up();
        await waitForPosition(28);
        assert.equal(await isPaused(), false, 'resume press-time intent');

        await dragFrom(110);
        await page.mouse.up();
        await waitForPosition(119.98, 0.01);
        assert.equal(await isPaused(), true, 'near-end release');
        // A paused press and release with no movement selects the precise media time.
        for (const [target, expected] of [[119.95, 119.98], [119.8, 119.8]]) {
            await seekTo(target);
            await page.mouse.click(start.x, start.y);
            await waitForPosition(expected, 0.01);
        }

        // Cancel and capture loss each discard the preview, even if a release follows.
        for (const event of ['pointercancel', 'lostpointercapture']) {
            await dragFrom(10);
            const preview = await page.locator('.scrubber-text span').textContent();
            await shell.evaluate((el, type) => {
                const id = window.wheelTestPointerId;
                if (type === 'lostpointercapture') el.releasePointerCapture(id);
                else el.dispatchEvent(new PointerEvent(type, { pointerId: id }));
            }, event);
            await page.mouse.move(end.x + 1, end.y);
            await page.mouse.up();
            assert.ok(Math.abs(await time() - 10) < 0.01, event);
            await page.waitForFunction(() => document.querySelector('.scrubber-thumb').hasAttribute('hidden'),
                undefined, { timeout: 3000 });
            assert.equal(await page.locator('.scrubber-text span').textContent(), preview);
            await dispatchAudioTimeupdate(page);
            assert.equal(await page.locator('.scrubber-text span').textContent(), '0:10 / 2:00');
        }

        // Next changes the play counter but reuses A's exact source. No move
        // intervenes, so pointerup itself must reject the stale seek and timer rearm.
        await dragFrom(10);
        await page.locator('.scrubber-edge-button.right').evaluate(button => button.click());
        await page.waitForFunction(() => !player.paused && player.currentTime > 0);
        await setFakeNow(page, base + 71 * 60000);
        await page.mouse.up();
        assert.ok(await time() < 2, 'same-URL successor received the old seek');
        await setFakeNow(page, base + 82 * 60000);
        await dispatchAudioTimeupdate(page);
        assert.equal(await isPaused(), true, 'stale release must not extend the successor deadline');
        await page.locator('.footer-gripper').click();
        await page.locator('.expansion').evaluate(async el => {
            await Promise.allSettled(el.getAnimations().map(animation => animation.finished));
        });

        // Source and counter can change independently. Check each on move and up.
        for (const [changePlay, moveBeforeUp] of [[true, true], [false, true], [false, false]]) {
            await play();
            await dragFrom(10);
            if (changePlay) {
                await page.locator('#start').evaluate(button => button.click());
                await page.waitForFunction(() => !player.paused && player.currentTime > 0 && player.currentTime < 2);
            } else {
                await page.evaluate(() => window.replaceWheelTestSource());
                await page.waitForFunction(() => player.readyState >= 2);
            }
            if (moveBeforeUp) {
                await page.mouse.move(end.x + 2, end.y);
                assert.equal(await shell.evaluate(el => el.hasPointerCapture(window.wheelTestPointerId)), false);
            }
            if (!changePlay) await pause();
            await page.mouse.up();
            if (!changePlay) assert.equal(await isPaused(), true, 'stale release restarted the replacement');
            assert.ok(await time() < 2, 'stale release must preserve the new position');
        }

        // Exactly opposite moves can happen when capture skips a pointer sample.
        // Preserve the original browser's half-turn rounding at fixed CSS coordinates.
        await shell.evaluate(el => {
            el.style.cssText = 'position:fixed;left:0;top:0;width:360px;height:360px;margin:0';
        });
        await seekTo(65);
        await page.mouse.move(80, 80);
        await page.mouse.down();
        await page.mouse.move(228, 60);
        await page.mouse.move(132, 300);
        await page.mouse.up();
        await waitForPosition(0, 0.01);
        await shell.evaluate(el => { el.style.cssText = ''; });

        // Hold the pointer across the skip debounce deadline. A timer queued
        // before the wheel took capture must never overwrite the preview.
        await seekTo(10);
        await page.mouse.move(start.x, start.y);
        await page.clock.install();
        await page.evaluate(() => {
            document.querySelector('.scrubber-shell').addEventListener('pointerdown', () => {
                document.querySelector('.scrubber-edge-button.top').click();
            }, { capture: true, once: true });
        });
        await page.mouse.down();
        assert.equal(await shell.evaluate(el => el.hasPointerCapture(window.wheelTestPointerId)), true);
        assert.equal(await page.locator('.scrubber-text span').textContent(), '0:40 / 2:00');
        await page.clock.runFor(201);
        assert.ok(Math.abs(await time() - 10) < 0.01, 'a queued skip fired during the drag');
        await page.mouse.up();
    },
};
