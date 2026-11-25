const assert = require('node:assert/strict');

/** Reuse the real account cache and JS sync controller with a deterministic native reply handler.
 * The first details request disagrees with the drive admitted by Swift. On the next refresh an
 * account-wide 401 and two share-specific 403s arrive together. One 403 belongs to a retired grant. */
async function checkNativeAccountIsolation(page) {
    const result = await page.evaluate(async () => {
        const { createNativeLibrary } = await import('./dist/native-library.js');
        const { createIndexSync } = await import('./dist/index-sync.js');
        const { createShares } = await import('./dist/shares.js');
        const { dbGet } = await import('./dist/db.js');
        let detailsDrive = 'wrong-drive';
        const calls = [];
        let accessRevision = 0;
        const native = createNativeLibrary({ async postMessage(m) {
            if (m.op === 'state') return { driveID: 'fixture-drive', evidence: 'no-evidence' };
            if (m.op === 'playback') {
                const staleProof = m.proof === 'retired-before-commit';
                const applied = m.action === 'access' && m.subscription === 'fixture' && m.base === accessRevision && !staleProof;
                if (applied) accessRevision++;
                return {subscription: 'fixture', applied, staleProof, snapshot: {accessRevision}};
            }
            calls.push(m.url);
            const reply = (status, value, headers = {}) => ({
                status, headers, statusText: '', body: value === undefined ? '' : btoa(JSON.stringify(value)),
            });
            if (m.url.includes('/me/drive?')) return reply(200, { id: detailsDrive });
            if (m.url.includes('/items/available')) return reply(401, undefined, { 'X-OnePlay-Account-Error': 'interactionRequired' });
            if (m.url.includes('/items/renewing')) return reply(403, undefined, {'X-OnePlay-Account-Proof':'retired-before-commit'});
            if (m.url.includes('/items/revoked')) return reply(403, undefined, {'X-OnePlay-Account-Proof':'verified'});
            return reply(404);
        } });
        await native.loadAccountState('state');
        const shares = createShares({
            authFetch: native.fetch, dbPut: async () => {},
            dbGet: async () => ({ shares: ['available', 'renewing', 'revoked'].map(id => ({
                id, shareId: id, name: id, rootKey: 'share:' + id, rootItemId: id, driveId: 'shared',
            })) }),
        }, () => {});
        await shares.loadFromCache();
        const sync = createIndexSync({
            auth: native, accountData: new Map(), getShares: () => shares,
            getTree: () => undefined, getFavorites: () => undefined, getSettings: () => undefined,
            ensureFavorites: async () => {}, ensureShares: async () => {}, showTree() {},
        });
        const info = localStorage.getItem('account_info');
        const cacheKey = 'index:fixture-drive';
        const cached = await dbGet(cacheKey);
        sync.setSavedInfoRef(JSON.parse(info));
        sync.setCachedDataRef(cached);
        try {
            await sync.requestPullFromOneDrive('settings-refresh');
            const unchanged = localStorage.getItem('account_info') === info
                && sync.getSavedInfoRef().driveId === 'fixture-drive'
                && sync.getCachedDataRef() === cached
                && JSON.stringify(await dbGet(cacheKey)) === JSON.stringify(cached);
            const rejectedBeforePull = calls.length === 1;
            detailsDrive = 'fixture-drive';
            await sync.requestPullFromOneDrive('settings-refresh');
            return { unchanged, rejectedBeforePull, denied: [...shares.getDeniedRootKeys()] };
        } finally { sync.cancelScheduledPull(); }
    });
    assert.deepEqual(result, { unchanged: true, rejectedBeforePull: true, denied: ['share:revoked'] });
}

/** Drive the deployed shell with an isolated Graph fixture. No real account or share is modified. */
async function checkShareDiagnostics(browser, url) {
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 } });
    try {
        await context.addInitScript(() => {
            localStorage.setItem('access_token', 'fixture');
            window.testDiagnosticConsole = [];
            for (const level of ['log', 'error']) {
                const original = console[level].bind(console);
                console[level] = (...args) => { window.testDiagnosticConsole.push(args.join(' ')); original(...args); };
            }
        });
        const marker = 'OnePlayPrivateMarker';
        const shareURL = 'https://sharing.example/' + marker;
        const encoded = 'u!' + Buffer.from(shareURL).toString('base64url');
        const headers = [];
        let failFollow = false;
        let holdWrite = false;
        let failShareListing = false;
        let favoriteWrites = 0;
        const enteredWrite = Promise.withResolvers();
        const finishWrite = Promise.withResolvers();
        const cacheOperations = [];
        const folder = (id, name) => ({ id, name, size: holdWrite ? 4 : failShareListing ? 3 : failFollow ? 2 : 1, folder: { childCount: 1 } });
        await context.route('https://graph.microsoft.com/**', async route => {
            const req = route.request();
            const path = new URL(req.url()).pathname.replace('/v1.0', '');
            const json = body => route.fulfill({ json: body });
            if (path === '/me/drive') return json({ id: 'fixture-drive', owner: { user: { displayName: 'Listener' } } });
            if (path === '/me/drive/special/music') return json(folder('primary', 'Music'));
            if (path === '/drives/shared/items/album') return json(folder('album', 'Shared album'));
            if (path.startsWith('/shares/')) {
                headers.push(req.headers().prefer);
                // The missing Graph share ID exercises the token-bearing legacy root key.
                return json(path.endsWith('/driveItem')
                    ? { ...folder('album', 'Shared album'), parentReference: { driveId: 'shared' } }
                    : {});
            }
            if (failShareListing && path.endsWith('favorites.json:/content')) {
                if (req.method() === 'PUT') favoriteWrites++;
                else return json({ updatedAt: Date.now(), favorites: [{
                    kind: 'shortcut', id: 'cloud-favorite', name: 'New album', target: {
                        driveId: 'shared', sourceRootKey: 'share:' + encoded, path: ['New album'], itemId: 'new-album', isFolder: true,
                    },
                }] });
            }
            if (failFollow && req.method() === 'GET' && /(?:favorites|shares)\.json:\/content$/.test(path)) {
                // Parser exceptions can quote plain query parameters without a recognizable URL.
                return route.fulfill({ status: 200, contentType: 'application/json', body: 'sig=' + marker });
            }
            if (holdWrite && path === '/$batch' && req.postDataJSON().requests.some(r => r.id === 'write-album')) {
                enteredWrite.resolve();
                await finishWrite.promise;
                cacheOperations.push('write');
            }
            if (holdWrite && req.method() === 'DELETE') cacheOperations.push('delete');
            if (path === '/$batch') return json({ responses: req.postDataJSON().requests.map(r => {
                if (failShareListing && r.id === 'children-album') return { id: r.id, status: 500 };
                if (r.id.startsWith('children-')) return { id: r.id, status: 200, body: { value: [
                    { name: 'Test.mp3', id: 'track', file: {}, size: 1 },
                ] } };
                if (r.id === 'cache-album') return { id: r.id, status: 302,
                    headers: { Location: 'https://cdn.example/cache?sig=' + marker } };
                return { id: r.id, status: r.id.startsWith('write-') ? 200 : 404, body: {} };
            }) });
            return route.fulfill({ status: req.method() === 'PUT' ? 204 : 404, body: '' });
        });
        await context.route('https://cdn.example/**', route => failFollow
            ? route.abort() : route.fulfill({ json: {} }));
        const page = await context.newPage();
        await page.goto(url);
        await page.locator('.row-icon-settings').first().click();
        await page.getByRole('button', { name: /Add share URL/ }).click();
        await page.locator('.modal input').fill(shareURL);
        await page.locator('.modal-confirm').click();
        await page.waitForFunction(() => window._testSettings.isOpen() && [...window._testTree.getRoots().values()].some(r =>
            r.type === 'share' && r.folder?.children['Test.mp3']));
        await page.locator('.settings-close').click();
        await page.getByText('Shared album', { exact: true }).first().click();
        await page.locator('#children').getByText('Test.mp3').waitFor();
        failFollow = true;
        await page.getByRole('button', { name: 'Open settings' }).click();
        await page.locator('.settings-pill-refresh').click();
        await page.waitForFunction(() => window.__ONEPLAY_MUSIC_LOGS.some(e => e.message.includes('batch redirect follow failed id=cache-album')));
        assert.deepEqual(headers, ['redeemSharingLink', 'redeemSharingLink']);
        const logs = await page.evaluate(() => [
            JSON.stringify(window.__ONEPLAY_MUSIC_LOGS), document.querySelector('#log-panel').textContent,
            localStorage.getItem('oneplay_music_logs_v2'), window.testDiagnosticConsole.join('\n'),
        ]);
        for (const output of logs) {
            for (const operation of ['favorites:onedrive-load', 'shares:onedrive-load']) {
                assert(output.includes(operation + ': invalid JSON status=200'), 'Missing parse stage for ' + operation);
            }
            assert(!output.includes(marker) && !output.includes(encoded), 'Sensitive marker reached diagnostics');
        }
        await checkNativeAccountIsolation(page);

        // The adopted cloud favorite can legitimately be newer than the visible cached share.
        // A failed folder listing gives us no evidence for deleting it or publishing a change.
        failFollow = false;
        failShareListing = true;
        const previousPulls = await page.evaluate(() => window.__ONEPLAY_MUSIC_LOGS.filter(e => e.message.includes('pull: complete')).length);
        await page.locator('.settings-pill-refresh').click();
        await page.waitForFunction(n => window.__ONEPLAY_MUSIC_LOGS.filter(e => e.message.includes('pull: complete')).length > n
            && window.__ONEPLAY_MUSIC_LOGS.some(e => e.message.includes('index end: share status=failed')), previousPulls);
        assert(await page.evaluate(() => window._testFavorites.getAll().some(f => f.id === 'cloud-favorite')));
        assert.equal(favoriteWrites, 0);
        failShareListing = false;

        // Disconnect while a previously dispatched cloud write is held. It must settle before
        // the namespace DELETE, and no returned batch can recreate the local share index.
        holdWrite = true;
        await page.locator('.settings-pill-refresh').click();
        await enteredWrite.promise;
        await page.locator('.settings-share-trash').click();
        await page.locator('.modal-danger').click();
        await page.waitForFunction(() => window._testShares.getAll().length === 0);
        const deleted = page.waitForResponse(r => r.request().method() === 'DELETE');
        finishWrite.resolve();
        await deleted;
        await page.waitForFunction(() => !document.querySelector('.modal-backdrop'));
        assert.deepEqual(cacheOperations, ['write', 'delete']);
        assert.equal(await page.evaluate(async shareId => {
            const { dbGet } = await import('./dist/db.js');
            return await dbGet('index-share:' + shareId);
        }, encoded), undefined);
    } finally {
        await context.close();
    }
}

/** Standalone browsers let the same check cover both localhost and the release without the signed-in profile. */
if (require.main === module) (async () => {
    const url = process.env.ONEPLAY_MUSIC_TEST_URL || 'http://localhost:5500/music/';
    const { chromium, webkit } = require('playwright');
    for (const engine of [chromium, webkit]) {
        const browser = await engine.launch();
        try { await checkShareDiagnostics(browser, url); }
        finally { await browser.close(); }
        console.log(`${engine.name()} passed share redemption, browsing, redaction, native account isolation, favorite preservation after a failed share listing and disconnect during cache write`);
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
