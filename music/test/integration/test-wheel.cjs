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
