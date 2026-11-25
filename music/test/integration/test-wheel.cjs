const assert = require('node:assert/strict');

/** A seekable two-minute PCM fixture. Both queue entries deliberately use the same URL. */
function silentWav() {
    const samples = 120 * 8000;
    const header = Buffer.alloc(44);
    header.write('RIFF');
    header.writeUInt32LE(36 + samples, 4);
    header.write('WAVEfmt ', 8);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20); // PCM, mono, 8-bit
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(8000, 24);
    header.writeUInt32LE(8000, 28);
    header.writeUInt16LE(1, 32);
    header.writeUInt16LE(8, 34);
    header.write('data', 36);
    header.writeUInt32LE(samples, 40);
    return Buffer.concat([header, Buffer.alloc(samples, 128)]);
}

module.exports = {
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
