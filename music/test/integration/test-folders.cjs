const assert = require('node:assert/strict');
const add = 'Make available offline', remove = 'Make unavailable offline';

/** Each client starts with the same library, but keeps its own IndexedDB, download queue and network. */
async function seedFolderDevice(page, {cloud = {}, holdSecond = false, scale = false, overlap = false, soleAccount = false} = {}) {
    const url = globalThis.__ONEPLAY_TEST_URL;
    page.setDefaultTimeout(6500);
    const mediaRequests = [];
    const network = {connected:true, putAttempts:0, denyShare:false};
    let releaseSecond;
    const secondReady = new Promise(resolve => { releaseSecond = resolve; });
    const wav = silentWav();
    // The 45-byte PCM file isolates queue, IndexedDB and UI notification costs from transfer throughput.
    // The recording shared with the playlist keeps its two-minute duration for offline playback.
    const sample = Buffer.from(wav.subarray(0, 45));
    if (scale) { sample.writeUInt32LE(37, 4); sample.writeUInt32LE(1, 40); }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.route(url + 'seed', r => r.fulfill({contentType: 'text/html', body: '<title>Seed</title>'}));
    await page.route(url + 'fixture-*.wav', async route => {
        const id = route.request().url().split('fixture-').pop().split('.')[0];
        mediaRequests.push(id);
        if ((id === 'second' && holdSecond) || scale === 'albums' || (scale && mediaRequests.length > 5)) await secondReady;
        await route.fulfill({contentType:'audio/wav', body:scale && id !== 'first' ? sample : wav});
    });
    await page.route('https://graph.microsoft.com/**', route => {
        const request = route.request();
        const parsed = new URL(request.url());
        const documentRequest = parsed.pathname.endsWith('/approot:/favorites.json:/content');
        if (documentRequest && request.method() === 'PUT') network.putAttempts++;
        if (!network.connected) return route.abort('internetdisconnected');
        if (documentRequest) {
            if (request.method() === 'PUT') cloud.document = request.postDataJSON();
            return route.fulfill({status:cloud.document ? 200 : 404, json:cloud.document ?? {}});
        }
        if (parsed.pathname.endsWith('/me/drive')) return route.fulfill({json:{id:'drive', owner:{user:{displayName:'Listener'}}}});
        if (parsed.searchParams.get('$select') === '@microsoft.graph.downloadUrl') {
            const id = parsed.pathname.split('/').pop();
            return route.fulfill({json:{'@microsoft.graph.downloadUrl':url + 'fixture-' + id + '.wav'}});
        }
        if (network.denyShare && parsed.pathname.endsWith('/items/shared-root')) return route.fulfill({status:403, json:{}});
        if (parsed.pathname.endsWith('/special/music') || parsed.pathname.endsWith('/items/shared-root')) {
            const id = parsed.pathname.endsWith('/special/music') ? 'root' : 'shared-root';
            return route.fulfill({json:{id, name:id, size:10, folder:{}}});
        }
        return route.fulfill({status:request.method() === 'PUT' ? 200 : 404, json:{}});
    });
    await page.goto(url + 'seed');
    await page.evaluate(async ({scale, overlap, soleAccount}) => {
        const {dbPut} = await import('./dist/db.js');
        const children = {Books:{id:'books', children:{
            Dune:{id:'dune', children:{Disc:{id:'disc', children:{'Opening.wav':{id:'first'}, 'Ending.wav':{id:'second'}}}}},
            Poems:{id:'poems', children:{'Poem.wav':{id:'third'}}},
        }}};
        const index = (id, children, count) => ({kind:'MusicData', schemaVersion:1, size:10, count, folder:{id,children}});
        if (overlap) children.Books.children.Poems.children['Opening.wav'] = children.Books.children.Dune.children.Disc.children['Opening.wav'];
        const keep = {id:'keep', kind:'playlist', name:'Keep', hasPrivatePlayback:false, offlinePin:{paused:false},
            members:[{driveId:'drive', sourceRootKey:'drive', itemId:'first',
                path:['Books','Dune','Disc','Opening.wav'], isFolder:false}]};
        const favorites = soleAccount ? [] : [keep];
        const folderPins = [];
        if (scale === 'albums') {
            delete children.Books;
            favorites.length = 0;
            for (let a = 0; a < 100; ++a) {
                const artist = 'Artist ' + a;
                const albums = {};
                children[artist] = {id:'artist-' + a, children:albums};
                for (let b = 0; b < 30; ++b) {
                    const album = 'Album ' + b, id = a + '-' + b;
                    const tracks = {};
                    albums[album] = {id,children:tracks};
                    for (let t = 0; t < 10; ++t) tracks['Song ' + t + '.wav'] = {id:id + '-' + t};
                    if (a < 10 && b < 5) folderPins.push({driveId:'drive',sourceRootKey:'drive',itemId:id,
                        isFolder:true,path:[artist,album]});
                }
            }
        } else if (scale) {
            const disc = children.Books.children.Dune.children.Disc.children;
            for (let i = 0; i < 498; ++i) disc['Song ' + i] = {id:'pin-' + i};
            const archive = {id:'archive', children:{}};
            for (let i = 0; i < 29_499; ++i) {
                const album = 'Album ' + Math.floor(i / 500);
                archive.children[album] ??= {id:album, children:{}};
                archive.children[album].children['Song ' + i] = {id:'other-' + i};
            }
            children.Archive = archive;
            favorites.push({id:'all-archive', kind:'shortcut', name:'All Archive', hasPrivatePlayback:false,
                target:{driveId:'drive', sourceRootKey:'drive', itemId:'archive', path:['Archive'], isFolder:true}});
        }
        if (soleAccount) {
            children.Jazz = {id:'jazz', children:{}};
            // Enough loose tracks to give the account listing its own scroll offset.
            for (let i = 0; i < 40; i++) children['Song ' + i + '.wav'] = {id:'song-' + i};
        }
        await dbPut('index:drive', index('root', children, scale ? 30_000 : soleAccount ? 43 : 3));
        const concertTracks = overlap ? {'Live.wav':{id:'concert-track'}} : {};
        await dbPut('index-share:token', index('shared-root', {Concert:{id:'concert', children:concertTracks}}, Object.keys(concertTracks).length));
        await dbPut('shares', {version:1, updatedAt:1, shares:soleAccount ? [] : [{id:'connection', shareId:'token',
            name:'Shared', rootKey:'share:token', driveId:'remote', rootItemId:'shared-root', addedAt:1, updatedAt:1}]});
        await dbPut('favorites', {version:1, updatedAt:1, favorites, ...(folderPins.length ? {folderPins} : {})});
        localStorage.setItem('account_info', JSON.stringify({driveId:'drive', displayName:'Listener'}));
        localStorage.setItem('access_token', 'test-fixture');
    }, {scale, overlap, soleAccount});
    await page.goto(url);
    const name = (scope, title) => page.locator('#' + scope + ' .tree-row').filter({
        has:page.locator('.row-name', {hasText:new RegExp('^' + title + '$')}),
    });
    const child = title => name('children', title);
    const crumb = title => name('breadcrumbs', title);
    const pins = () => page.evaluate(() => window._testFavorites.getFolderPins().map(p => p.path.join('/')));
    const right = page.getByRole('button', {name:'Folder actions', exact:true});
    const folderMenu = async row => {
        await row.click({button:'right'});
        return page.locator('.action-dropdown');
    };
    const choose = async (row, label, confirm = true) => {
        const menu = await folderMenu(row);
        const status = await menu.getByRole('button').textContent();
        await menu.getByRole('button').click();
        const modal = page.locator('.modal');
        assert.equal(await modal.locator('h3').textContent(), status);
        await modal.getByRole('button', {name:confirm ? label : 'Close', exact:true}).click();
        await modal.waitFor({state:'hidden'});
    };
    if (soleAccount) await child('Books').waitFor();
    else if (scale === 'albums') await child('OneDrive').locator('.offline-badge.partial.downloading').waitFor();
    else await child('Keep').locator('.offline-badge.complete').waitFor();
    return {child, crumb, pins, choose, right, folderMenu, mediaRequests, releaseSecond, network};
}

module.exports = {
    async 'folders: flattened account paths, scroll and first shortcut at home'(page) {
        const {child, choose} = await seedFolderDevice(page, {soleAccount:true});
        const home = page.locator('.app-root');
        const names = page.locator('#breadcrumbs .crumb .row-name');
        assert.equal(await home.getAttribute('aria-current'), 'location');
        assert.equal(await page.locator('.empty-favorites-hint').count(), 0);
        const track = child('Song 39.wav');
        assert.deepEqual(JSON.parse(await track.getAttribute('data-path')), ['OnePlay Music','drive','Song 39.wav']);
        await page.getByRole('button', {name:'Search music'}).click();
        await page.locator('.search-input').fill('Song 39');
        await track.click();
        await page.waitForFunction(() => window._testPlayback.getInfo()?.track.at(-1) === 'Song 39.wav');
        assert.equal(await home.getAttribute('aria-current'), 'location');
        await child('Books').click();
        await page.locator('.footer-indicator').click();
        assert.equal(await names.count(), 1);
        assert(await track.evaluate(row => {
            const bounds = row.getBoundingClientRect(), list = row.parentElement.getBoundingClientRect();
            return bounds.top >= list.top && bounds.bottom <= list.bottom;
        }));
        await choose(child('Books'), add);
        await home.locator('.offline-badge.partial').waitFor();
        await child('Jazz').click();
        await page.waitForFunction(() => document.querySelector('#children').style.overflow === '');
        await page.evaluate(() => {
            const tree = window._testTree;
            const account = tree.getRoots().get('drive');
            const folderBox = () => document.querySelector('.crumb.selected .row-name').getBoundingClientRect();
            const before = folderBox();
            for (const sync of [false,true]) for (const indexing of [false,true]) {
                tree.setSyncing(sync);
                tree.setAccount(account.key, account.folder, account.info, indexing);
                const root = document.querySelector('.app-root');
                if (root.querySelectorAll('.sync-spinner').length !== Number(sync || indexing)
                    || !!root.querySelector('.offline-badge.partial') !== !(sync || indexing))
                    throw Error('Wrong folded indicator for sync=' + sync + ', indexing=' + indexing);
                const after = folderBox();
                if (before.x !== after.x || before.y !== after.y) throw Error('Sync moved the Jazz breadcrumb');
            }
            tree.setSelectMode(true, new Set());
            if (document.querySelector('.app-root .sync-spinner') || !document.querySelector('.app-root .offline-badge.partial'))
                throw Error('Selection should reveal the underlying arrow');
            tree.setSelectMode(false, new Set());
            tree.setSyncing(false);
            tree.setAccount(account.key, account.folder, account.info);
        });
        await home.locator('.row-name').click();
        await page.waitForFunction(() => document.querySelector('#children').style.overflow === '');
        await page.locator('#children').evaluate(el => { el.scrollTop = 160; });
        await page.waitForFunction(() => JSON.parse(localStorage.oneplay_music_scroll ?? '{}')['["OnePlay Music","drive"]']?.top === 160);
        await page.getByRole('button', {name:'Search music'}).click();
        await page.locator('.search-input').fill('Song 39');
        await child('Song 39.wav').waitFor();
        await page.locator('.search-close').click();
        assert.equal(await page.locator('#children').evaluate(el => el.scrollTop), 160);
        // Navigation can beat the scroll event. It must capture the outgoing list synchronously.
        await child('Books').evaluate(row => {
            row.parentElement.scrollTop = 192;
            row.click();
        });
        assert.equal(await names.count(), 2);
        assert.equal(await names.last().textContent(), 'Books');
        assert.equal(await home.locator('.offline-badge').count(), 0);
        await home.locator('.row-name').click();
        assert.equal(await page.locator('#children').evaluate(el => el.scrollTop), 192);
        await page.reload();
        await child('Books').waitFor();
        assert.equal(await page.locator('#children').evaluate(el => el.scrollTop), 192);
        // The previous UI could save the bare drive as the selected folder.
        await page.evaluate(() => { localStorage.oneplay_music_view = JSON.stringify({path:['OnePlay Music','drive']}); });
        await page.reload();
        await child('Books').waitFor();
        assert.equal(await home.getAttribute('aria-current'), 'location');
        assert.equal(await page.locator('#children').evaluate(el => el.scrollTop), 192);
        await child('Books').click({button:'right'});
        await page.locator('.share-btn').click();
        await page.getByRole('button', {name:/Add as Shortcut/}).click();
        await page.locator('.modal-confirm').click();
        await child('OneDrive').waitFor();
        await page.waitForFunction(() => !document.body.classList.contains('select-mode') && !document.querySelector('#tree-container').style.opacity);
        assert.equal(await names.count(), 1);
        assert.equal(await child('Books').locator('.fav-icon').count(), 1);
    },

    async 'folders: share and first playlist expand the trail in place'(page) {
        const {child} = await seedFolderDevice(page, {soleAccount:true});
        const trail = page.locator('.crumb .row-name');
        await child('Books').click();
        const folded = await trail.allTextContents();
        assert.equal(folded.length, 2);
        await page.evaluate(() => window._testTree.setShareRoots([{key:'share:new', connectionId:'connection',
            driveId:'remote', name:'Shared', reindexing:false}]));
        assert.deepEqual(await trail.allTextContents(), [folded[0],'OneDrive','Books']);
        await page.evaluate(() => window._testTree.setShareRoots([]));
        assert.deepEqual(await trail.allTextContents(), folded);
        await child('Dune').click({button:'right'});
        await page.locator('.share-btn').click();
        await page.getByRole('button', {name:/Put in new playlist/}).click();
        await page.locator('.modal input[type=text]').fill('Reading');
        await page.locator('.modal-confirm').click();
        await page.waitForFunction(() => !document.body.classList.contains('select-mode') && !document.querySelector('#tree-container').style.opacity);
        assert.deepEqual(await trail.allTextContents(), [folded[0],'OneDrive','Books']);
        await page.reload();
        await child('Dune').waitFor();
        assert.deepEqual(await trail.allTextContents(), [folded[0],'OneDrive','Books']);
        await child('Dune').click({button:'right'});
        await page.locator('.share-btn').click();
        await page.getByRole('button', {name:/Add as Shortcut/}).click();
        await page.locator('.modal-confirm').click();
        await page.locator('.crumb.selected .fav-icon').waitFor();
        assert.deepEqual(await trail.allTextContents(), [folded[0],'Dune']);
    },

    async 'folders: unreadable indexed bytes remain offline and playback skips to the next song'(page) {
        const device = await seedFolderDevice(page);
        await page.route('**/fixture-second.wav', r => r.fulfill({contentType:'audio/wav', body:Buffer.from([1,2,3])}));
        await device.child('OneDrive').click();
        await device.child('Books').click();
        await device.choose(device.child('Dune'), add);
        await device.child('Dune').locator('.offline-badge.complete').waitFor();
        await page.context().setOffline(true);
        await device.child('Dune').click();
        await device.child('Disc').click();
        await device.child('Ending.wav').click();
        await page.waitForFunction(() => window._testPlayback.getInfo()?.track.at(-1) === 'Opening.wav'
            && document.querySelector('audio').currentSrc.startsWith('blob:') && document.querySelector('audio').currentTime > 0.1);
        assert.equal(await page.evaluate(() => window._testDownloads.getSnapshot().files.get('drive:second')), 3);
    },

    async 'folders: an unreachable stream stays selected for playback'(page) {
        const device = await seedFolderDevice(page);
        await page.route('**/fixture-second.wav', r => r.abort('internetdisconnected'));
        await device.child('OneDrive').click();
        await device.child('Books').click();
        await device.child('Dune').click();
        await device.child('Disc').click();
        await device.child('Ending.wav').click();
        await page.waitForFunction(() => document.querySelector('audio').error && window._testPlayback.getInfo()?.phase === 'loaded');
        assert.equal(await page.evaluate(() => window._testPlayback.getInfo().track.at(-1)), 'Ending.wav');
    },

    /** Use real button clicks so capture-phase pointerdown and the ensuing click are both exercised. */
    async 'folders: action menus open on selection entry and toggle at the same anchor'(page) {
        const {child} = await seedFolderDevice(page);
        const menu = page.locator('.action-dropdown');
        const share = page.locator('.share-btn');
        const favorite = page.getByRole('button', {name:'Favorite actions'});
        // In landscape the popup can appear under the original finger. Releasing
        // over a command must leave that command available for a separate tap.
        await page.setViewportSize({width:640, height:300});
        const touch = await page.context().newCDPSession(page);
        await touch.send('Emulation.setTouchEmulationEnabled', {enabled:true});
        const point = await child('Keep').evaluate(row => {
            const r = row.getBoundingClientRect();
            return {x:r.right - 100, y:r.y + r.height / 2};
        });
        await touch.send('Input.dispatchTouchEvent', {type:'touchStart', touchPoints:[point]});
        await menu.getByRole('button', {name:'Rename…'}).waitFor();
        await menu.evaluate(async el => Promise.all(el.getAnimations().map(a => a.finished)));
        assert.ok(await page.evaluate(({x,y}) => !!document.elementFromPoint(x,y)?.closest('.action-dropdown button'), point));
        await touch.send('Input.dispatchTouchEvent', {type:'touchEnd', touchPoints:[]});
        await touch.detach();
        await page.setViewportSize({width:390, height:844});
        await menu.getByRole('button', {name:'Rename…'}).waitFor();
        assert.equal(await favorite.getAttribute('aria-expanded'), 'true');
        await favorite.click();
        assert.equal(await menu.count(), 0);
        await favorite.click();
        await menu.getByRole('button', {name:'Rename…'}).waitFor();
        await share.click();
        await menu.getByRole('button', {name:/Put in new playlist/}).waitFor();
        assert.equal(await menu.count(), 1);
        await share.click();
        assert.equal(await menu.count(), 0);
        await page.locator('#select-cancel').click();

        await child('Keep').click();
        const member = page.locator('#children .tree-row').first();
        await member.click({button:'right'});
        assert.equal(await share.getAttribute('aria-expanded'), 'true');
        assert.ok(await page.getByRole('button', {name:'Remove selected items'}).isVisible());
        await page.locator('#select-cancel').click();
        await page.locator('#breadcrumbs .tree-row').first().locator('.row-name').click();
        await child('OneDrive').click();
        await child('Books').click();
        await child('Dune').click();
        await child('Disc').click();
        const tracks = page.locator('#children .tree-row.file');
        await tracks.first().click({button:'right'});
        assert.equal(await share.getAttribute('aria-expanded'), 'true');
        await tracks.nth(1).click();
        assert.equal(await menu.count(), 0);
        assert.equal(await page.locator('.action-bar-text').textContent(), '2 Tracks');
        await share.click();
        await menu.getByRole('button', {name:/Put in new playlist/}).waitFor();
        await page.locator('#select-cancel').click();
        assert.equal(await menu.count(), 0);
    },

    async 'folders: remove favorites and playlist items with context-specific confirmation'(page) {
        const {child} = await seedFolderDevice(page);
        await page.evaluate(async () => {
            const favorites = window._testFavorites;
            const source = {driveId:'drive', sourceRootKey:'drive'};
            const disc = ['Books', 'Dune', 'Disc'];
            await favorites.add({id:'disc', kind:'shortcut', name:'Disc', hasPrivatePlayback:false,
                target:{...source, itemId:'disc', path:disc, isFolder:true}});
            await favorites.add({id:'reading', kind:'playlist', name:'Reading list', hasPrivatePlayback:false,
                members:[
                    {...source, itemId:'first', path:[...disc, 'Opening.wav'], isFolder:false},
                    {...source, itemId:'second', path:[...disc, 'Ending.wav'], isFolder:false},
                ]});
        });

        const origin = globalThis.__ONEPLAY_TEST_URL.includes('localhost') ? 'local' : 'production';
        const screenshot = name => page.screenshot({path:`/tmp/oneplay-remove-${origin}-${name}.png`, animations:'disabled'});
        const menu = page.locator('.action-dropdown');
        const menuRemove = menu.getByRole('button', {name:'Remove…', exact:true});
        const modal = page.locator('.modal');
        const directRemove = page.getByRole('button', {name:'Remove selected items', exact:true});
        const checkConfirmation = async (screen, title, description, button) => {
            assert.equal(await modal.locator('h3').textContent(), title);
            assert.deepEqual(await modal.locator('p').allTextContents(), [description]);
            const confirm = modal.getByRole('button', {name:'Remove', exact:true});
            assert.ok(await confirm.evaluate(el => el.classList.contains('modal-danger')));
            await screenshot(screen);
            await modal.getByRole('button', {name:button, exact:true}).click();
            await modal.waitFor({state:'hidden'});
        };

        await child('Disc').click({button:'right'});
        await menuRemove.waitFor();
        await screenshot('menu');
        await menuRemove.click();
        await checkConfirmation('shortcut', 'Remove favorite?', 'This shortcut will be removed.', 'Remove');
        await child('Disc').waitFor({state:'detached'});

        const playlist = child('Reading list');
        await playlist.click({button:'right'});
        await menuRemove.click();
        await checkConfirmation('playlist', 'Remove favorite?', 'This playlist will be removed.', 'Cancel');
        await page.locator('#select-cancel').click();
        await playlist.click();

        const opening = child('Opening.wav');
        const ending = child('Ending.wav');
        await opening.click({button:'right'});
        await directRemove.click();
        await checkConfirmation('one-item', 'Remove from playlist?', '1 item will be removed from the playlist.', 'Cancel');
        await ending.click();
        await directRemove.click();
        await checkConfirmation('two-items', 'Remove from playlist?', '2 items will be removed from the playlist.', 'Remove');
        await opening.waitFor({state:'detached'});
        await ending.waitFor({state:'detached'});

        await page.locator('#breadcrumbs .tree-row').first().locator('.row-name').click();
        await playlist.click({button:'right'});
        await child('Keep').click();
        await directRemove.click();
        await checkConfirmation('two-favorites', 'Remove 2 favorites?', '2 favorites will be removed.', 'Remove');
        await playlist.waitFor({state:'detached'});
        await child('Keep').waitFor({state:'detached'});

        for (const folder of ['OneDrive', 'Books', 'Dune', 'Disc']) await child(folder).click();
        await opening.waitFor();
        await ending.waitFor();
    },

    /** Exercise production UI and storage against an isolated library with an overlapping playlist and album. */
    async 'folders: folder selection, dotted progress, and offline playback through a surviving playlist'(page) {
        const {child, crumb, pins, choose, right, folderMenu, mediaRequests, releaseSecond} = await seedFolderDevice(page, {holdSecond:true, overlap:true});
        const url = globalThis.__ONEPLAY_TEST_URL;
        const screenshot = name => '/tmp/oneplay-m18-' + (url.includes('localhost') ? 'local' : 'production') + '-' + name + '.png';
        assert.equal(await child('OneDrive').locator('.offline-badge').count(), 0);
        await child('Shared').click();
        // CDP injects trusted touch input into Chromium. Hold until the app acknowledges long-press
        // selection, then release at the same coordinate to exercise its synthetic follow-up click.
        const touch = await page.context().newCDPSession(page);
        await touch.send('Emulation.setTouchEmulationEnabled', {enabled:true});
        const bounds = await child('Concert').locator('.row-name').boundingBox();
        await touch.send('Input.dispatchTouchEvent', {type:'touchStart', touchPoints:[{
            x:bounds.x + bounds.width/2, y:bounds.y + bounds.height/2,
        }]});
        await page.locator('body.select-mode .tree-row[aria-checked="true"]').waitFor();
        await touch.send('Input.dispatchTouchEvent', {type:'touchEnd', touchPoints:[]});
        await page.locator('.action-dropdown').getByRole('button', {name:add, exact:true}).click();
        await page.locator('.modal').getByRole('button', {name:'Close'}).click();
        await touch.detach();
        assert.deepEqual(await pins(), []);
        // A failed local commit leaves the same folder and action available in the open dialog.
        await page.evaluate(() => {
            const put = IDBObjectStore.prototype.put;
            IDBObjectStore.prototype.put = function(value, key) {
                const request = put.call(this, value, key);
                if (this.name === 'data' && key === 'favorites') {
                    IDBObjectStore.prototype.put = put;
                    this.transaction.abort();
                }
                return request;
            };
        });
        await (await folderMenu(child('Concert'))).getByRole('button', {name:add}).click();
        const dialog = page.locator('.modal');
        await dialog.getByRole('button', {name:add}).click();
        await dialog.getByText('Could not finish updating downloads. Try again.').waitFor();
        assert.deepEqual(await pins(), []);
        await dialog.getByRole('button', {name:add}).click();
        await dialog.waitFor({state:'hidden'});
        assert.equal(await page.evaluate(() => window._testFavorites.getFolderPins()[0].connectionId), 'connection');
        await child('Concert').locator('.offline-badge.complete').waitFor();
        await choose(child('Concert'), remove);
        await crumb('OnePlay').locator('.row-name').click();
        await child('OneDrive').click();
        await child('Books').click();
        await choose(child('Dune'), add);
        const partial = crumb('Books').locator('.offline-badge.partial');
        await partial.locator('svg[aria-label*="Some subfolders"][aria-label*="Downloading"]').waitFor();
        await child('Dune').locator('.offline-badge.downloading:not(.partial)').waitFor();
        await page.evaluate(() => window._testAuth.transition('evidence:not-online'));
        await partial.locator('svg[aria-label*="paused"] path:nth-child(2)').waitFor({state:'attached'});
        assert.equal(await crumb('OneDrive').locator('.offline-badge.partial').count(), 0);
        assert.equal(await page.locator('#breadcrumbs .offline-badge.partial').count(), 1);
        // Sample the rendered SVG at 8× to verify the dots are visible, separated
        // along the shaft, and symmetric across the vertical centerline.
        assert.ok(await partial.locator('svg').evaluate(async svg => {
            const drawing = svg.cloneNode(true);
            drawing.removeChild(drawing.lastElementChild); // Only compare the arrow, omitting the pause bar.
            const path = drawing.firstElementChild, css = getComputedStyle(svg.firstElementChild);
            for (const prop of ['fill','stroke','stroke-width','stroke-linecap','stroke-linejoin','stroke-dasharray']) {
                path.style.setProperty(prop, css.getPropertyValue(prop));
            }
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = 128;
            const img = new Image();
            img.src = 'data:image/svg+xml,' + encodeURIComponent(new XMLSerializer().serializeToString(drawing));
            await img.decode();
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, 128, 128);
            const pixels = ctx.getImageData(0, 0, 128, 128).data;
            const dot = (x,y) => pixels[4*(y*128+x)+3] >= 128;
            for (let y=0; y<128; y++) for (let x=0; x<64; x++) {
                if (dot(x,y) !== dot(127-x,y)) return false;
            }
            return dot(64,13) && !dot(64,26) && dot(64,38) && dot(32,58);
        }));
        await page.evaluate(() => window._testAuth.transition('evidence:signed-in'));
        releaseSecond();
        await child('Dune').locator('.offline-badge.complete').waitFor();
        await crumb('Books').locator('.offline-badge.partial.complete').waitFor();
        assert.deepEqual(new Set(mediaRequests), new Set(['concert-track','first','second']));
        assert.ok(await crumb('Books').evaluate(row => {
            const name = row.querySelector('.row-name').getBoundingClientRect();
            const badge = row.querySelector('.offline-badge').getBoundingClientRect();
            return badge.top < name.bottom && badge.bottom > name.top;
        }), 'The dotted arrow should wrap with Books');
        await child('Dune').click();
        const transition = await getTestSeq(page, '_testTreeFlipSeq');
        await child('Disc').click();
        await waitForFlipSettled(page, transition);
        await crumb('Dune').locator('.offline-badge.complete:not(.partial)').waitFor();
        assert.equal(await page.locator('#breadcrumbs .offline-badge').count(), 1);
        assert.equal(await crumb('Books').locator('.offline-badge').count(), 0);
        assert.equal(await crumb('OneDrive').locator('.offline-badge').count(), 0);
        assert.equal(await crumb('Disc').locator('.offline-badge').count(), 0);
        assert.ok(await crumb('Disc').getByRole('button', {name:'Play Disc'}).isVisible());
        await page.screenshot({path:screenshot('pinned-breadcrumb')});
        await crumb('Disc').locator('.row-name').click({button:'right'});
        assert.equal(await right.isVisible(), false);
        await page.locator('#select-cancel').click();
        const menu = await folderMenu(crumb('Books').locator('.row-name'));
        assert.deepEqual(await menu.getByRole('button').allTextContents(), ['Available offline…']);
        await page.screenshot({path:screenshot('partial-menu')});
        await menu.getByRole('button', {name:'Available offline…', exact:true}).click();
        const modal = page.locator('.modal');
        assert.equal(await modal.locator('h3').textContent(), 'Available offline…');
        await modal.getByText('1 child folder', {exact:true}).waitFor();
        await modal.locator('.offline-progress').filter({hasText:/2 tracks, .* ✓/}).waitFor();
        assert.ok(await modal.locator('.offline-fav-row .offline-badge.partial.complete').isVisible());
        assert.deepEqual(await modal.locator('.modal-actions').getByRole('button').allTextContents(), [add, remove]);
        const quota = modal.getByRole('combobox');
        await quota.selectOption('2');
        await page.waitForFunction(() => window._testDownloads.getSnapshot().quotaBytes === 2 * 1024 ** 3);
        await page.screenshot({path:screenshot('partial-dialog')});
        await modal.getByRole('button', {name:add}).click();
        await crumb('Books').locator('.offline-badge.complete:not(.partial)').waitFor();
        assert.deepEqual(await pins(), ['Books']);
        assert.equal(await crumb('Dune').locator('.offline-badge').count(), 0);
        await choose(crumb('Books').locator('.row-name'), remove);
        assert.deepEqual(await pins(), []);
        await choose(crumb('Dune').locator('.row-name'), add);
        await crumb('Dune').locator('.offline-badge.complete').waitFor();
        await crumb('Books').locator('.row-name').click();
        await crumb('Books').locator('.offline-badge.partial.complete').waitFor();
        assert.equal(await page.locator('#breadcrumbs .offline-badge').count(), 1);
        await choose(child('Poems'), add);
        await child('Poems').locator('.offline-badge.complete').waitFor();
        await (await folderMenu(crumb('Books').locator('.row-name'))).getByRole('button', {name:'Available offline…'}).click();
        await modal.getByText('2 child folders', {exact:true}).waitFor();
        // Opening.wav has the same physical ID in both descendant folders.
        await modal.getByText('3 tracks, 3 Mb ✓', {exact:true}).waitFor();
        await page.screenshot({path:screenshot('partial-dialog-two-folders')});
        await modal.getByRole('button', {name:remove}).click();
        await modal.waitFor({state:'hidden'});
        assert.deepEqual(await pins(), []);
        assert.equal(await crumb('OneDrive').locator('.offline-badge').count(), 0);
        await page.waitForFunction(() => {
            const files = window._testDownloads.getSnapshot().files;
            return files.size === 1 && files.has('drive:first');
        });
        await page.context().setOffline(true);
        await crumb('OnePlay').locator('.row-name').click();
        await child('Keep').click();
        await page.locator('#children .tree-row.file').click();
        await page.waitForFunction(() => {
            const audio = document.querySelector('audio');
            return audio.currentSrc.startsWith('blob:') && !audio.paused && audio.currentTime > 0;
        });
        assert.equal(await page.evaluate(() => window._testPlayback.getInfo().track.at(-1)), 'm:0');
        await crumb('OnePlay').locator('.row-name').click();
        await child('Keep').click({button:'right'});
        await page.getByRole('button', {name:'Available offline…', exact:true}).click();
        await page.locator('.modal').getByRole('button', {name:remove}).click();
        await child('Keep').locator('.offline-badge').waitFor({state:'hidden'});
        assert.deepEqual(await pins(), []);
        assert.ok(await page.evaluate(async () => !!await window._testDownloads.getOfflineBlob('drive','first')));
    },

    /** A receiver that misses the disconnect can still browse a cached listing while the new connection refreshes. */
    async 'folders: a reconnected share starts unpinned and refreshes its listing'(sender) {
        await seedFolderDevice(sender);
        const context = await sender.context().browser().newContext({serviceWorkers:'block'});
        try {
            const receiver = await context.newPage();
            const device = await seedFolderDevice(receiver);
            await device.child('Shared').click();
            await device.choose(device.child('Concert'), add);
            await device.child('Concert').locator('.offline-badge.complete').waitFor();

            let sharesDocument;
            await sender.route('https://graph.microsoft.com/**', route => {
                const request = route.request(), path = new URL(request.url()).pathname;
                if (path.endsWith('/shares.json:/content') && request.method() === 'PUT') {
                    sharesDocument = request.postDataJSON();
                    return route.fulfill({json:{}});
                }
                if (path.includes('/shares/')) return route.fulfill({json:path.endsWith('/driveItem')
                    ? {id:'shared-root', name:'Reconnected', folder:{}, parentReference:{driveId:'remote'}} : {id:'token'}});
                return route.fallback();
            });
            const write = () => sender.waitForResponse(r => r.url().includes('/shares.json:/content') && r.request().method() === 'PUT');
            await openSettingsPage(sender);
            await sender.locator('.settings-share-trash').click();
            await Promise.all([write(), sender.locator('.modal-danger').click()]);
            await sender.locator('.modal').waitFor({state:'hidden'});
            await Promise.all([write(), sender.evaluate(() => window._testShares.addFromUrl('https://example.test/same-link'))]);

            const probe = Promise.withResolvers(), release = Promise.withResolvers();
            await receiver.route('https://graph.microsoft.com/**', async route => {
                const request = route.request(), path = new URL(request.url()).pathname;
                if (path.endsWith('/special/music')) return route.fulfill({status:403}); // Share access is independent.
                if (path.endsWith('/shares.json:/content')) return route.fulfill({json:sharesDocument});
                if (path.endsWith('/items/shared-root')) {
                    probe.resolve();
                    await release.promise;
                    return route.fulfill({json:{id:'shared-root',size:11,folder:{}}});
                }
                if (path.endsWith('/$batch')) return route.fulfill({json:{
                    responses:request.postDataJSON().requests.map(r => ({id:r.id, status:200,
                        body:r.id === 'cache-shared-root' ? {kind:'MusicData',schemaVersion:1,size:11,count:0,
                            folder:{id:'shared-root', children:{New:{id:'new',children:{}}}}} : {value:[]}}))}});
                return route.fallback();
            });
            await openSettingsPage(receiver);
            await receiver.getByRole('button', {name:'Refresh now'}).click();
            await probe.promise;
            try {
                await closeSettingsPage(receiver);
                await device.crumb('OnePlay').locator('.row-name').click();
                await device.child('Reconnected').waitFor();
                await device.child('Reconnected').locator('.offline-badge').waitFor({state:'hidden'});
            } finally { release.resolve(); }
            await device.child('Reconnected').click();
            await device.child('New').waitFor();
            assert.equal(await device.child('New').locator('.offline-badge').count(), 0);
        } finally { await context.close(); }
    },

    /** A changed index may heal favorite paths only after the cloud intent was successfully checked. */
    async 'folders: a failed favorites read leaves moved references untouched until retry'(page) {
        await seedFolderDevice(page);
        const index = await page.evaluate(async () => {
            const {dbGet} = await import('./dist/db.js');
            const data = await dbGet('index:drive');
            const books = data.folder.children.Books.children;
            books.Poems.children['Opening.wav'] = books.Dune.children.Disc.children['Opening.wav'];
            delete books.Dune.children.Disc.children['Opening.wav'];
            data.size++;
            return data;
        });
        let failRead = true, uploads = 0;
        await page.route('https://graph.microsoft.com/**', route => {
            const request = route.request(), path = new URL(request.url()).pathname;
            if (path.endsWith('/special/music')) return route.fulfill({json:{id:'root', name:'Music', size:index.size, folder:{}}});
            if (path.endsWith('/$batch')) return route.fulfill({json:{responses:request.postDataJSON().requests.map(r =>
                ({id:r.id, status:200, body:r.id === 'cache-root' ? index : {value:[]}}))}});
            if (path.endsWith('/favorites.json:/content')) {
                if (request.method() === 'GET') return route.fulfill({status:failRead ? 503 : 404});
                uploads++;
            }
            return route.fallback();
        });
        const currentPath = () => page.evaluate(() => window._testFavorites.getAll()[0].members[0].path);
        await openSettingsPage(page);
        await page.getByRole('button', {name:'Refresh now'}).click();
        await page.waitForFunction(() => window.__ONEPLAY_MUSIC_LOGS.some(e => e.message.includes('pull: complete (settings-refresh')));
        assert.deepEqual(await currentPath(), ['Books','Dune','Disc','Opening.wav']);
        assert.equal(uploads, 0);
        failRead = false;
        const uploaded = page.waitForResponse(r => r.url().includes('/favorites.json:/content') && r.request().method() === 'PUT');
        await page.getByRole('button', {name:'Refresh now'}).click();
        await uploaded;
        assert.deepEqual(await currentPath(), ['Books','Poems','Opening.wav']);
    },

    /** A terminal response only stalls owners whose remaining recordings cannot transfer. */
    async 'folders: a missing recording pauses its branch while another album finishes'(page) {
        const {child, crumb, choose, folderMenu} = await seedFolderDevice(page);
        let failures = 0;
        await page.route('**/fixture-second.wav', route => {
            failures++;
            return route.fulfill({status:404});
        });
        await child('OneDrive').click();
        await child('Books').click();
        await choose(child('Dune'), add);
        await child('Dune').locator('.offline-badge.paused').waitFor();
        await choose(child('Poems'), add);
        await child('Poems').locator('.offline-badge.complete').waitFor();
        await child('Dune').locator('.offline-badge.paused').waitFor();
        await crumb('Books').locator('.offline-badge.partial.paused').waitFor();
        assert.ok(failures > 0);
        const menu = await folderMenu(crumb('Books').locator('.row-name'));
        await menu.getByRole('button', {name:'Available offline…'}).click();
        const details = page.locator('.modal .offline-progress');
        await details.filter({hasText:'Paused 2/3 tracks'}).waitFor();
        await page.unroute('**/fixture-second.wav');
        await details.getByRole('button', {name:'Retry downloads'}).click();
        await details.filter({hasText:/3 tracks, .* ✓/}).waitFor();
        await page.locator('.modal-close').click();
        await crumb('Books').locator('.offline-badge.partial.complete').waitFor();
    },

    /** A share can lose access even when the rest of the account continues to download. */
    async 'folders: a denied share pauses both its explicit and partial arrows'(page) {
        const cloud = {};
        const device = await seedFolderDevice(page, {cloud});
        await device.child('Shared').click();
        const put = page.waitForResponse(r => r.url().includes('/favorites.json:/content') && r.request().method() === 'PUT' && r.ok());
        await device.choose(device.child('Concert'), add);
        await put;
        // The bundled WKWebView test pulls these same bytes; the save timestamp is device-local.
        const bundledFixture = require('../../ios/Tests/SharedFolderPin.json');
        assert.deepEqual({...cloud.document, updatedAt:bundledFixture.updatedAt}, bundledFixture);
        await device.child('Concert').locator('.offline-badge.complete').waitFor();
        device.network.denyShare = true;
        await openSettingsPage(page);
        await page.getByRole('button', {name:'Refresh now'}).click();
        await page.waitForFunction(() => window._testShares.getDeniedRootKeys().has('share:token'));
        await closeSettingsPage(page);
        assert.equal(await page.evaluate(() => window._testAuth.getEvidence()), 'evidence:signed-in');
        await device.child('Concert').locator('.offline-badge.paused:not(.partial)').waitFor();
        await device.crumb('Shared').locator('.offline-badge.partial.paused').waitFor();
    },

    /** Measure execution inside lookup/expansion slices, excluding the scheduler's delay between turns. */
    async 'folders: actual JavaScript slices for a moved 500-track folder in a deep 30k index'(page) {
        const url = globalThis.__ONEPLAY_TEST_URL;
        await page.route(url + 'timing', r => r.fulfill({contentType:'text/html', body:'<title>Projection timing</title>'}));
        await page.goto(url + 'timing');
        const metrics = await page.evaluate(async () => {
            const {resolveVerifiedItemRef} = await import('./dist/favorites.js');
            const {createOfflinePins} = await import('./dist/native-pins.js');
            const folder = {id:'root',children:{}};
            for (let album = 0; album < 60; album++) {
                let parent = folder;
                for (let level = 0; level < 40; level++) {
                    const name = level === 0 ? 'Shelf ' + album : 'Level ' + level;
                    parent = parent.children[name] = {id:album + '-' + level, children:{}};
                }
                for (let track = 0; track < 500; track++) parent.children['Song ' + track] = {id:album + ':' + track};
            }
            const branch = folder.children['Shelf 0'];
            let reads = 0;
            Object.defineProperty(folder.children, 'Shelf 0', {enumerable:true, get() { reads++; return branch; }});
            const saved = {driveId:'drive', sourceRootKey:'drive', itemId:'59-39', isFolder:true, path:['Old album']};
            const roots = new Map([['drive', {key:'drive',type:'onedrive',info:{driveId:'drive'},folder,reindexing:false}]]);
            let activeTracks = 0;
            const pins = createOfflinePins({async setPinnedKeys(active) { activeTracks = active.size; }}, () => {});
            const slices = [];
            const timer = window.setTimeout;
            let start = performance.now();
            // Only the imported production modules run on this blank page. Timestamp the
            // end of their JS turn and the beginning of the continuation around each yield.
            window.setTimeout = (resume, ms) => {
                slices.push(performance.now() - start);
                return timer(() => { start = performance.now(); resume(); }, ms);
            };
            try {
                const current = await resolveVerifiedItemRef(saved, folder);
                await pins.publishOwners([], [current], roots, new Set(), true, true);
                slices.push(performance.now() - start);
                return {depth:current.path.length, reads, activeTracks, slices};
            } finally { window.setTimeout = timer; }
        });
        assert.equal(metrics.depth, 40);
        assert.equal(metrics.activeTracks, 500);
        assert.equal(metrics.reads, 1, 'Only healing looked up the moved folder');
        const longest = Math.max(...metrics.slices);
        emit('  Deep 30k rename and 500-track projection, JS work ' +
            metrics.slices.reduce((a,b) => a+b,0).toFixed(1) + ' ms over ' + metrics.slices.length +
            ' slices, longest ' + longest.toFixed(1) + ' ms');
        assert.ok(longest < 50, 'Lookup and projection keep every application slice below a long task');
    },

    async 'folders: badge callback during 500 downloads across 50 album pins in a 30k library'(page) {
        const device = await seedFolderDevice(page, {scale:'albums'});
        await device.child('OneDrive').click();
        await device.child('Artist 9').click();
        await device.child('Album 4').locator('.offline-badge.downloading').waitFor();
        await page.evaluate(() => {
            const metrics = window.albumProgress = {samples:[], rowReplacements:0, badgeChanges:0, navigation:0};
            const downloads = window._testDownloads, progress = downloads.onStateChange;
            const findRow = (area, name) => [...document.querySelectorAll('#' + area + ' .row-name')].find(el => el.textContent === name);
            downloads.onStateChange = inventory => {
                if (!inventory?.added) return progress(inventory);
                const first = document.querySelector('#children .tree-row');
                const complete = () => document.querySelectorAll('#children .offline-badge.complete').length;
                const before = complete();
                // Time the complete shipping notification, including owner counts and rendering.
                const start = performance.now();
                progress(inventory);
                metrics.samples.push(performance.now() - start);
                if (!first.isConnected) metrics.rowReplacements++;
                if (complete() !== before) metrics.badgeChanges++;
                if (metrics.samples.length % 100 === 1) {
                    const artist = 'Artist ' + inventory.added[0].split(':')[1].split('-')[0];
                    findRow('breadcrumbs','OneDrive').click();
                    findRow('children',artist).click();
                    if (window._testTree.getSelectedPath().at(-1) === artist) metrics.navigation++;
                }
            };
        });
        device.releaseSecond();
        await page.waitForFunction(() => window._testDownloads.getSnapshot().files.size === 500, undefined, {timeout:30000});
        const metrics = await page.evaluate(() => ({...window.albumProgress,
            pins:window._testFavorites.getFolderPins().length,
            complete:document.querySelectorAll('#children .offline-badge.complete').length}));
        assert.equal(metrics.pins, 50);
        assert.equal(metrics.complete, 5);
        assert.ok(metrics.navigation > 0, 'Navigated while album downloads were completing');
        assert.ok(metrics.badgeChanges > 0 && metrics.rowReplacements <= 50, 'Rows stay in place between album badge transitions');
        metrics.samples.sort((a,b) => a-b);
        const percentile = p => metrics.samples[Math.floor((metrics.samples.length-1)*p)].toFixed(2);
        emit('  50 album pins / 500 downloads: ' + metrics.samples.length + ' progress callbacks, p50/p95/max '
            + [0.5,0.95,1].map(percentile).join('/') + ' ms, ' + metrics.rowReplacements + ' row replacements, '
            + metrics.badgeChanges + ' visible badge changes, ' + metrics.navigation + ' navigations');
    },

    /** Capture navigation within a yielded 30k-track walk, then during real file completions on the same phone layout. */
    async 'folders: 30k tracks stay navigable during projection and 500 pinned downloads'(page) {
        const device = await seedFolderDevice(page, {scale:true});
        await device.child('OneDrive').click();
        await page.waitForFunction(() => localStorage.getItem('oneplay_music_index_last_updated'));
        const pinMetrics = await page.evaluate(async () => {
            const tree = window._testTree, downloads = window._testDownloads;
            const children = tree.getRoots().get('drive').folder.children;
            const metrics = {archiveReads:0, pinReads:0, navigations:0, completions:0, walkNavigation:false,
                commit:undefined};
            window.folderScaleMetrics = metrics;
            const clickChild = name => [...document.querySelectorAll('#children .row-name')].find(row => row.textContent === name)?.click();
            const watch = (leaf, read) => {
                const id = leaf.id;
                Object.defineProperty(leaf, 'id', {get() { read(); return id; }});
            };
            // A physical-leaf read distinguishes a subtree walk from painting its row or badge.
            for (const i of [0, 29498]) {
                watch(children.Archive.children['Album ' + Math.floor(i / 500)].children['Song ' + i], () => {
                    metrics.archiveReads++;
                    if (metrics.archiveReads === 3) setTimeout(() => {
                        document.querySelector('.modal-close')?.click();
                        clickChild('OneDrive');
                        metrics.walkNavigation = metrics.archiveReads === 3 && tree.getSelectedPath().at(-1) === 'drive';
                    }, 0);
                });
            }
            for (const i of [0, 497]) watch(children.Books.children.Dune.children.Disc.children['Song ' + i], () => {
                if (++metrics.pinReads === 1) setTimeout(() => {
                    clickChild('Books');
                    if (tree.getSelectedPath().at(-1) === 'Books') metrics.navigations++;
                }, 0);
            });
            const onProgress = downloads.onStateChange;
            downloads.onStateChange = inventory => {
                onProgress(inventory);
                if (inventory?.added && ++metrics.completions === 1) {
                    clickChild('Dune');
                    if (tree.getSelectedPath().at(-1) === 'Dune') metrics.navigations++;
                }
            };
            let start = performance.now();
            let last = start;
            let longest = 0;
            const sample = () => {
                const now = performance.now();
                longest = Math.max(longest, now - last);
                last = now;
            };
            const timer = setInterval(sample, 0);
            // Sampling a timer also captures browser scheduling delays between main-thread turns.
            window.finishScalePhase = (stop = false) => {
                sample();
                const phase = {elapsed:last - start, longest};
                start = last;
                longest = 0;
                if (stop) clearInterval(timer);
                return phase;
            };
            await window._testFavorites.setFolderPinned({driveId:'drive', sourceRootKey:'drive', itemId:'dune',
                isFolder:true, path:['Books','Dune']}, true);
            metrics.commit = window.finishScalePhase();
            return metrics;
        });
        await page.waitForFunction(() => window.folderScaleMetrics.pinReads >= 2 && window.folderScaleMetrics.navigations === 2);
        assert.equal(pinMetrics.archiveReads, 0, 'Pinning Dune did not walk the unpinned Archive');
        // Hold the fifth new response while opening the live folder modal. With its quota picker
        // focused, release all remaining responses and observe the number of progress updates.
        const menu = await device.folderMenu(device.crumb('Dune').locator('.row-name'));
        await menu.getByRole('button', {name:'Available offline…'}).click();
        await page.locator('.modal .offline-progress').filter({hasText:'Downloading'}).waitFor();
        await page.evaluate(() => {
            const progress = document.querySelector('.modal .offline-progress');
            const quota = document.querySelector('.modal select');
            quota.focus();
            window.folderScaleMetrics.progressUpdates = 0;
            const observer = new MutationObserver(() => window.folderScaleMetrics.progressUpdates++);
            observer.observe(progress, {childList:true, characterData:true, subtree:true});
            window.inspectScaleControls = () => {
                observer.disconnect();
                return document.activeElement === quota && quota.isConnected && progress.isConnected;
            };
        });
        device.releaseSecond();
        await page.locator('.modal .offline-progress').filter({hasText:'500 tracks, 959 Kb ✓'}).waitFor({timeout:30000});
        assert.ok(await page.evaluate(() => window.inspectScaleControls()), 'Progress does not rebuild the modal or steal quota focus');
        await page.locator('.modal-close').click();
        const finished = await page.evaluate(() => ({...window.folderScaleMetrics, download:window.finishScalePhase(),
            tracks:window._testDownloads.getSnapshot().files.size}));
        assert.equal(finished.navigations, 2, 'Opened Books during pinning and Dune on the first real completion');
        assert.equal(finished.tracks, 500);
        assert.equal(finished.completions, 499); // The overlapping playlist already owned Opening.wav.
        assert.equal(finished.pinReads, 2);
        assert.equal(finished.archiveReads, 0);
        assert.ok(finished.progressUpdates > 0 && finished.progressUpdates <= finished.completions + 1,
            'Modal text updates stay bounded by file completion notifications');

        // A separate explicit inspection counts the unpinned shortcut only while its dialog is open.
        await device.crumb('OnePlay').locator('.row-name').click();
        const inspect = async () => {
            await device.child('All Archive').click({button:'right'});
            await page.locator('.action-dropdown').getByRole('button', {name:add}).click();
        };
        await inspect();
        await page.getByText('29499 tracks', {exact:true}).waitFor();
        assert.equal(await page.evaluate(() => window.folderScaleMetrics.archiveReads), 2);
        await page.locator('.modal-close').click();
        await inspect();
        await page.waitForFunction(() => window.folderScaleMetrics.walkNavigation);

        // A fresh per-root cache includes a moved album and the same 30k physical IDs.
        // Drive the ordinary Settings refresh, including JSON decode, index persistence and healing.
        const moved = await page.evaluate(async () => {
            const {dbGet} = await import('./dist/db.js');
            const index = await dbGet('index:drive');
            const siblings = index.folder.children.Books.children;
            siblings.Relocated = siblings.Dune;
            delete siblings.Dune;
            index.size++;
            return index;
        });
        await page.route('https://graph.microsoft.com/**', route => {
            const path = new URL(route.request().url()).pathname;
            if (path.endsWith('/special/music')) return route.fulfill({json:{id:'root', name:'Music', size:moved.size, folder:{}}});
            if (!path.endsWith('/$batch')) return route.fallback();
            const requests = route.request().postDataJSON().requests;
            return route.fulfill({json:{responses:requests.map(item => ({
                id:item.id, status:200, body:item.id === 'cache-root' ? moved : {value:[]},
            }))}});
        });
        // Graph reports one new recording under the same stable folder ID.
        const newSong = Promise.withResolvers();
        moved.folder.children.Books.children.Relocated.children.Disc.children['Encore.mp3'] = {id:'encore'};
        moved.count++;
        await page.route(globalThis.__ONEPLAY_TEST_URL + 'fixture-encore.wav', async route => {
            await newSong.promise;
            return route.fallback();
        });
        await openSettingsPage(page);
        await page.evaluate(() => window.finishScalePhase());
        await page.getByRole('button', {name:'Refresh now'}).click();
        await page.waitForFunction(() => window._testFavorites.getFolderPins()[0]?.path.at(-1) === 'Relocated');
        await closeSettingsPage(page);
        await device.child('Books').click();
        await device.child('Relocated').locator('.offline-badge.downloading').waitFor();
        const movedMenu = await device.folderMenu(device.child('Relocated'));
        await movedMenu.getByRole('button', {name:'Available offline…'}).click();
        await page.locator('.modal .offline-progress').filter({hasText:/Downloading \d+\/501 tracks/}).waitFor();
        newSong.resolve();
        await page.locator('.modal .offline-progress').filter({hasText:'501 tracks, 960 Kb ✓'}).waitFor();
        await page.locator('.modal-close').click();
        await device.child('Relocated').locator('.offline-badge.complete').waitFor();
        const refresh = await page.evaluate(() => window.finishScalePhase(true));
        const timing = phase => phase.elapsed.toFixed(1) + '/' + phase.longest.toFixed(1) + ' ms';
        emit('  30k tracks, elapsed/longest sampled interval: pin ' + timing(finished.commit)
            + ', 499 completions ' + timing(finished.download) + ', moved-folder refresh ' + timing(refresh)
            + '; open modal updates ' + finished.progressUpdates);

        const unpinMenu = await device.folderMenu(device.child('Relocated'));
        await unpinMenu.getByRole('button', {name:'Available offline…'}).click();
        await page.evaluate(() => {
            const modal = document.querySelector('.modal');
            const metrics = window.unpin = {started:0, confirmed:0, navigation:0, longest:0};
            modal.addEventListener('click', () => {
                let last = metrics.started = performance.now();
                const timer = setInterval(() => {
                    const now = performance.now();
                    metrics.longest = Math.max(metrics.longest, now - last);
                    last = now;
                    if (window._testDownloads.getSnapshot().files.size === 1) {
                        metrics.cleanup = now - metrics.started;
                        clearInterval(timer);
                    }
                }, 4);
                const closed = new MutationObserver(() => {
                    if (modal.isConnected) return;
                    closed.disconnect();
                    const began = performance.now();
                    metrics.confirmed = began - metrics.started;
                    document.querySelector('#breadcrumbs .row-name').click();
                    metrics.navigation = performance.now() - began;
                });
                closed.observe(document.body, {childList:true});
            }, {capture:true, once:true});
        });
        await page.locator('.modal').getByRole('button', {name:remove,exact:true}).click();
        await page.waitForFunction(() => window.unpin.cleanup && window._testTree.getSelectedPath().length === 1);
        const {remaining, unpin} = await page.evaluate(async () => {
            const {audioFileSizes} = await import('./dist/db.js');
            return {remaining:[...await audioFileSizes()], unpin:window.unpin};
        });
        assert.deepEqual(remaining, [['drive:first',960044]]);
        emit('  Bulk unpin: dialog closed in ' + unpin.confirmed.toFixed(1) + ' ms; navigation took '
            + unpin.navigation.toFixed(1) + ' ms, cleanup of 500 files took ' + unpin.cleanup.toFixed(1)
            + ' ms, longest sampled interval ' + unpin.longest.toFixed(1) + ' ms');
        const requestsBeforeOfflinePlayback = device.mediaRequests.length;
        device.network.connected = false;
        await page.context().setOffline(true);
        await device.child('Keep').click();
        await page.locator('#children .file').click();
        await page.waitForFunction(() => {
            const audio = document.querySelector('audio');
            return audio.currentSrc.startsWith('blob:') && audio.duration > 100 && !audio.paused && audio.currentTime > 0.15;
        });
        assert.equal(device.mediaRequests.length, requestsBeforeOfflinePlayback, 'Offline playback made no additional media request');
    },

    /** A pull carries whole-document intent between clients. Only a locally successful download contributes progress. */
    async 'folders: two devices sync pin intent and keep independent progress through an offline edit'(firstPage) {
        const cloud = {};
        const first = await seedFolderDevice(firstPage, {cloud});
        const secondContext = await firstPage.context().browser().newContext({serviceWorkers:'block'});
        const secondPage = await secondContext.newPage();
        const saved = page => page.waitForResponse(response => response.request().method() === 'PUT'
            && response.url().includes('/favorites.json:/content') && response.ok());
        try {
            const second = await seedFolderDevice(secondPage, {cloud, holdSecond:true});
            await first.child('OneDrive').click();
            await first.child('Books').click();
            await Promise.all([saved(firstPage), first.choose(first.child('Dune'), add)]);
            await first.child('Dune').locator('.offline-badge.complete').waitFor();

            await openSettingsPage(secondPage);
            await secondPage.getByRole('button', {name:'Refresh now'}).click();
            await secondPage.waitForFunction(() => window._testFavorites.getFolderPins().some(p => p.itemId === 'dune'));
            await closeSettingsPage(secondPage);
            await second.child('OneDrive').click();
            await second.child('Books').click();
            await second.child('Dune').locator('.offline-badge.downloading').waitFor();
            const count = page => page.evaluate(() => window._testDownloads.getSnapshot().files.size);
            assert.deepEqual([await count(firstPage), await count(secondPage)], [2, 1]);
            assert.deepEqual(await first.pins(), await second.pins());
            second.releaseSecond();
            await second.child('Dune').locator('.offline-badge.complete').waitFor();

            // The app shell remains available while every request to OneDrive fails, including after reopen.
            first.network.connected = false;
            await first.choose(first.child('Poems'), add);
            await firstPage.reload();
            await firstPage.waitForFunction(() => window._testFavorites?.getFolderPins().some(p => p.itemId === 'poems'));
            assert.deepEqual(cloud.document.folderPins.map(p => p.itemId), ['dune']);
            const attemptsBeforePull = first.network.putAttempts;
            first.network.connected = true;
            await firstPage.evaluate(() => window._testFavorites.pullFavoritesFromOneDrive());
            assert.deepEqual(await first.pins(), ['Books/Dune', 'Books/Poems']);
            assert.equal(first.network.putAttempts, attemptsBeforePull);
            await Promise.all([saved(firstPage), firstPage.evaluate(() => window._testFavorites.rename('keep','Keep songs'))]);
            await secondPage.evaluate(() => window._testFavorites.pullFavoritesFromOneDrive());
            assert.deepEqual(await second.pins(), ['Books/Dune', 'Books/Poems']);
            assert.equal(await secondPage.evaluate(() => window._testFavorites.getAll()[0].name), 'Keep songs');
            await second.child('Poems').locator('.offline-badge.complete').waitFor();
        } finally {
            await secondContext.close();
        }
    },
};
