const assert = require('node:assert/strict');

module.exports = {
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
            await window._testPlayback.restoreVisualState(folder, [...folder,title], 'all', false, 0);
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
                const p = createPlayback(audio, document.querySelector('#footer'), async () => new Response(null, {status: 503}));
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
                }, authFetch: async () => new Response('{}'), fenceQueueEdit: () => p.fenceQueueEdit()}, async () => {
                    p.setContext(favs, roots);
                    await p.refreshLibraryQueue(true);
                });
                await favs.loadFromCache();
                if (!favs.getAll().length) await favs.add({kind: 'playlist', id: 'show', name: 'Show',
                    hasPrivatePlayback: false, members: ['A', 'B', 'C', 'D', 'archive'].map(member)});
                const saved = JSON.parse(localStorage.getItem('oneplay_music_playback'));
                if (saved) await p.restoreVisualState(saved.folder, saved.track, saved.mode, true,
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
                async () => Response.json({'@microsoft.graph.downloadUrl': media}));
            player.onPlaybackChange = tree.setPlaybackInfo;
            const accounts = new Map([['drive', {driveId: 'drive', folder}]]);
            await player.playFolder(root, accounts);
            tree.setSelectedPath([...root, 'A']);
            window.pick = name => player.playTrack([...root, 'A', name], accounts);
            window.pick('25');
            document.querySelector('.footer-gripper').click();
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
            const player = createPlayback(audio, document.querySelector('#footer'), async () =>
                Response.json({ '@microsoft.graph.downloadUrl': mediaUrl }));
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
            document.querySelector('.footer-gripper').click();
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
        await setFakeNow(page, base + 51 * 60000);
        await dispatchAudioTimeupdate(page);
        assert.equal(await isPaused(), true, 'the rearmed deadline must still expire');

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
