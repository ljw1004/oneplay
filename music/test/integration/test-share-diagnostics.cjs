const assert = require('node:assert/strict');

/** Reuse the real account cache and JS sync controller with a deterministic native reply handler.
 * The first details request disagrees with the drive admitted by Swift. On the next refresh an
 * account-wide 401 and two share-specific 403s arrive together. One 403 belongs to a retired grant. */
async function checkNativeAccountIsolation(page) {
    const result = await page.evaluate(async () => {
        const { createNativeLibrary } = await import('./dist/native-library.js');
        const { createIndexSync } = await import('./dist/index-sync.js');
        const { createShares } = await import('./dist/shares.js');
        const { createOneDriveProvider } = await import('./dist/onedrive-provider.js');
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
        const oneDrive = createOneDriveProvider(native.fetch, native.followContent);
        const shares = createShares({
            oneDrive, documents: oneDrive.documents, dbPut: async () => {},
            dbGet: async () => ({ shares: ['available', 'renewing', 'revoked'].map(id => ({
                id, shareId: id, name: id, rootKey: 'share:' + id, rootItemId: id, driveId: 'shared',
            })) }),
        }, () => {});
        await shares.loadFromCache();
        const sync = createIndexSync({
            auth: native, oneDrive, accountData: new Map(), getShares: () => shares,
            canPull: () => true, hasInstalledTree: () => true, showOpeningFailure() {},
            getTree: () => undefined, getFavorites: () => undefined, getSettings: () => undefined,
            ensureFavorites: async () => {}, ensureShares: async () => {}, showTree() {}, computeAndPushOfflineState() {},
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
        let heldWriteReleased = false;
        let cacheDeletedWhileWriteHeld = false;
        let failShareListing = false;
        let failLocalShareCommit = false;
        let failPrimaryProbe = false;
        let shareSize;
        let newTrack;
        let favoriteWrites = 0;
        let lastSavedFavorites;
        const enteredWrite = Promise.withResolvers();
        const finishWrite = Promise.withResolvers();
        const folder = (id, name) => ({ id, name, size: holdWrite ? 4 : failShareListing ? 3 : failFollow ? 2 : 1, folder: { childCount: 1 } });
        await context.route('https://graph.microsoft.com/**', async route => {
            const req = route.request();
            const path = new URL(req.url()).pathname.replace('/v1.0', '');
            const json = body => route.fulfill({ json: body });
            if (path === '/me/drive') return json({ id: 'fixture-drive', owner: { user: { displayName: 'Listener' } } });
            if (path === '/me/drive/special/music') return failPrimaryProbe
                ? route.fulfill({ status: 500, body: '' }) : json(folder('primary', 'Music'));
            if (path === '/drives/shared/items/album') return json({ ...folder('album', 'Shared album'), ...(shareSize && { size: shareSize }) });
            if (path.startsWith('/shares/')) {
                headers.push(req.headers().prefer);
                // The missing Graph share ID exercises the token-bearing legacy root key.
                return json(path.endsWith('/driveItem')
                    ? { ...folder('album', 'Shared album'), parentReference: { driveId: 'shared' } }
                    : {});
            }
            if (req.method() === 'PUT' && path.endsWith('favorites.json:/content')) lastSavedFavorites = req.postDataJSON();
            if ((failShareListing || failLocalShareCommit) && path.endsWith('favorites.json:/content')) {
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
                heldWriteReleased = true;
            }
            if (req.method() === 'DELETE' && path === '/me/drive/special/approot:/share-' + encodeURIComponent(encoded)
                && holdWrite && !heldWriteReleased) cacheDeletedWhileWriteHeld = true;
            if (path === '/$batch') return json({ responses: req.postDataJSON().requests.map(r => {
                if (failShareListing && r.id === 'children-album') return { id: r.id, status: 500 };
                if (r.id.startsWith('children-')) return { id: r.id, status: 200, body: { value: [
                    { name: 'Test.mp3', id: 'track', file: {}, size: 1 },
                    ...(r.id === 'children-album' ? [
                        folder('disc', 'Disc'),
                        ...(newTrack ? [{ name: newTrack, id: newTrack, file: {}, size: 1 }] : []),
                    ] : []),
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
        await page.locator('.settings-share-rename').click();
        await page.locator('.modal input').fill('Renamed album');
        const renamed = page.waitForResponse(response => response.request().method() === 'PUT'
            && response.url().includes('shares.json:/content')
            && response.request().postDataJSON().shares.some(share => share.name === 'Renamed album'));
        await page.locator('.modal-confirm').click();
        assert((await renamed).ok());
        await page.locator('.settings-close').click();
        await page.getByText('Renamed album', { exact: true }).first().click();
        await page.locator('#children').getByText('Test.mp3').waitFor();
        failFollow = true;
        await page.getByRole('button', { name: 'Open settings' }).click();
        await page.locator('.settings-pill-refresh').click();
        await page.waitForFunction(() => window.__ONEPLAY_MUSIC_LOGS.some(e => e.message.includes('batch redirect follow failed id=cache-album')));
        await page.waitForFunction(() => window.__ONEPLAY_MUSIC_LOGS.some(e => e.message.includes('favorites:onedrive-load: invalid JSON')));
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

        // A cached primary tree remains usable if its probe fails while the share refresh succeeds.
        failPrimaryProbe = true;
        shareSize = 5;
        newTrack = 'Shared refresh.mp3';
        await page.locator('.settings-pill-refresh').click();
        await page.waitForFunction(() => [...window._testTree.getRoots().values()].some(root =>
            root.type === 'share' && root.folder?.children['Shared refresh.mp3']));
        await page.waitForFunction(() => !document.querySelector('.settings-pill-refresh')?.disabled);

        // Reject the next share snapshot only, after Graph successfully delivered its listing.
        const snapshotWrites = await page.evaluate(() => {
            const put = IDBObjectStore.prototype.put;
            const before = window.__ONEPLAY_MUSIC_LOGS.filter(e => e.message.includes('pull: complete')).length;
            IDBObjectStore.prototype.put = function(value, key) {
                if (this.name === 'data' && String(key).startsWith('index-share:')) {
                    IDBObjectStore.prototype.put = put;
                    throw Error('Injected share index storage failure');
                }
                return put.apply(this, arguments);
            };
            return before;
        });
        failPrimaryProbe = false;
        failLocalShareCommit = true;
        shareSize = 6;
        newTrack = 'Uncommitted.mp3';
        await page.locator('.settings-pill-refresh').click();
        await page.waitForFunction(before => window.__ONEPLAY_MUSIC_LOGS.filter(e =>
            e.message.includes('pull: complete')).length > before, snapshotWrites);
        assert(await page.evaluate(() => {
            const share = [...window._testTree.getRoots().values()].find(root => root.type === 'share');
            return share.folder.children['Shared refresh.mp3'] && !share.folder.children['Uncommitted.mp3'];
        }));
        assert(await page.evaluate(() => window._testFavorites.getAll().some(f => f.id === 'cloud-favorite')));
        assert.equal(favoriteWrites, 0);
        failLocalShareCommit = false;
        shareSize = undefined;
        newTrack = undefined;

        const oldConnection = await page.evaluate(async () => {
            const share = window._testShares.getAll()[0];
            await window._testFavorites.setFolderPinned({ sourceRootKey: share.rootKey, connectionId: share.id,
                driveId: share.driveId, itemId: 'disc', isFolder: true, path: ['Disc'] }, true);
            return share.id;
        });

        // Disconnect while a previously dispatched cloud write is held. It must settle before
        // the namespace DELETE. The local pin edit can complete while that request is held.
        holdWrite = true;
        await page.locator('.settings-pill-refresh').click();
        await enteredWrite.promise;
        const deleted = page.waitForResponse(r => r.request().method() === 'DELETE'
            && r.url().endsWith('/share-' + encodeURIComponent(encoded)));
        await page.locator('.settings-share-trash').click();
        await page.locator('.modal-danger').click();
        await page.waitForFunction(() => window._testShares.getAll().length === 0);
        await page.waitForFunction(async () => {
            const { dbGet } = await import('./dist/db.js');
            return (await dbGet('favorites'))?.folderPins.length === 0;
        });
        // Another settings command can reconnect while the old writer still holds its
        // cache lease. Use that command directly while the first confirmation is open.
        const replacement = await page.evaluate(async link => {
            const share = await window._testShares.addFromUrl(link);
            return { id: share.id, pins: window._testFavorites.getFolderPins() };
        }, shareURL);
        assert.notEqual(replacement.id, oldConnection);
        assert.deepEqual(replacement.pins, []);
        finishWrite.resolve();
        await deleted;
        assert.equal(cacheDeletedWhileWriteHeld, false);
        await page.waitForFunction(() => !document.querySelector('.modal-backdrop'));
        await page.locator('.settings-pill-refresh').click();
        await page.waitForFunction(old => {
            const share = window._testShares.getAll()[0];
            return share && share.id !== old && window._testTree.getRoots().get(share.rootKey)?.folder?.children.Disc;
        }, oldConnection);
        assert.deepEqual(await page.evaluate(() => window._testFavorites.getFolderPins()), []);

        // A failed favorites write leaves the connection and pin intact for retry.
        await page.waitForFunction(() => !document.querySelector('.settings-pill-refresh')?.disabled);
        const failedConnection = await page.evaluate(async () => {
            const share = window._testShares.getAll()[0];
            await window._testFavorites.setFolderPinned({sourceRootKey:share.rootKey, connectionId:share.id,
                driveId:share.driveId, itemId:'disc', isFolder:true, path:['Disc']}, true);
            const put = IDBObjectStore.prototype.put;
            IDBObjectStore.prototype.put = function(value, key) {
                if (this.name === 'data' && key === 'favorites' && !value.folderPins.some(p => p.connectionId === share.id)) {
                    IDBObjectStore.prototype.put = put;
                    throw Error('Injected favorites disk failure');
                }
                return put.apply(this, arguments);
            };
            return share.id;
        });
        await page.locator('.settings-share-trash').click();
        await page.getByText('This will clear the offline setting for 1 folder in this share.').waitFor();
        await page.locator('.modal-danger').click();
        await page.getByText('Injected favorites disk failure').waitFor();
        const beforeRetry = await page.evaluate(async () => {
            const { dbGet } = await import('./dist/db.js');
            return { shares: (await dbGet('shares')).shares.map(s => s.id),
                pins: (await dbGet('favorites')).folderPins.map(p => p.connectionId) };
        });
        assert.deepEqual(beforeRetry, { shares: [failedConnection], pins: [failedConnection] });
        assert.equal(await page.locator('.settings-share-trash').count(), 1);
        const uploaded = page.waitForResponse(r => r.url().includes('favorites.json:/content')
            && r.request().method() === 'PUT' && r.request().postDataJSON().folderPins.length === 0);
        await page.locator('.modal-danger').click();
        await uploaded;
        await page.waitForFunction(() => !document.querySelector('.modal-backdrop'));
        assert.equal(await page.locator('.settings-share-trash').count(), 0);
        const afterRetry = await page.evaluate(async () => {
            const { dbGet } = await import('./dist/db.js');
            return { shares: (await dbGet('shares')).shares, pins: (await dbGet('favorites')).folderPins };
        });
        assert.deepEqual(afterRetry, { shares: [], pins: [] });
        assert.deepEqual(lastSavedFavorites.folderPins, []);
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
        console.log(`${engine.name()} passed share redemption, rename, browsing, redaction, native account isolation, favorite preservation after failed refresh and disconnect cleanup ordering`);
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
