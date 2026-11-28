const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const url = globalThis.__ONEPLAY_TEST_URL;
const manifestUrl = 'https://ljw1004.github.io/oneplay-test/music/index.json';
const raw = 'https://raw.githubusercontent.com/ljw1004/oneplay-test/';
const trackPath = 'Demo Album/Alice.mp3';
const clip = fs.readFileSync(path.resolve(__dirname, '../../ios/Tests/ScaleTone.mp3'));
const blob = 'b'.repeat(40);
const commit = 'a'.repeat(40);
const manifest = {
    schemaVersion: 1, mediaCommit: commit, tracks: [{path: trackPath, bytes: clip.length, blob}],
};
const cors = {'access-control-allow-origin': '*'};
const explore = page => page.getByRole('button', {name:/Explore the demo library/});

/** Only the two published public endpoints serve the test workspace. */
async function serveDemo(page) {
    await page.route(manifestUrl, r => r.fulfill({json:manifest, headers:cors}));
    await page.route(raw + commit + '/Music/Demo%20Album/Alice.mp3', r =>
        r.fulfill({body:clip, contentType:'audio/mpeg', headers:cors}));
}

module.exports = {
    async 'demo: offline sign-out returns to the chooser and keeps pinned audio and position'(page) {
        await serveDemo(page);
        let graph = 0;
        await page.route('https://graph.microsoft.com/**', r => { graph++; return r.abort(); });
        await page.goto(url);
        await page.getByRole('heading', {name:'OneDrive', exact:true}).waitFor();
        assert(await page.getByText('cloud music player', {exact:true}).isVisible());
        await explore(page).focus();
        await page.keyboard.press('Enter');
        const folder = page.locator('#children .tree-row').filter({hasText:'Demo Album'});
        await folder.waitFor();
        assert.equal(await page.evaluate(() => document.activeElement?.id), 'tree-container');
        await folder.click({button:'right'});
        await page.locator('.action-dropdown').getByRole('button', {name:'Make available offline', exact:true}).click();
        await page.locator('.modal').getByRole('button',{name:'Make available offline', exact:true}).click();
        await folder.locator('.offline-badge.complete').waitFor();
        await page.addInitScript(() => Object.defineProperty(navigator, 'onLine', {get: () => false}));
        await page.unroute(manifestUrl);
        await page.route(manifestUrl, r => r.abort('internetdisconnected'));
        await page.reload();
        await folder.click();
        await page.locator('#children .tree-row.file').click();
        await page.waitForFunction(() => {
            const audio = document.getElementById('player');
            return audio.currentSrc.startsWith('blob:') && audio.currentTime > 0 && !audio.paused;
        });
        await page.getByRole('button', {name:'Settings, demo library'}).click();
        assert.equal(await page.getByRole('button',{name:'Sign out', exact:true}).count(), 0);
        assert.equal(await page.getByRole('button',{name:'Refresh now', exact:true}).count(), 0);
        assert.equal(await page.getByRole('heading',{name:'Debug', exact:true}).count(), 0);
        const credits = page.getByRole('link', {name:'credits', exact:true});
        assert.equal(await credits.getAttribute('href'), raw + commit + '/credits.txt');
        await page.getByRole('button',{name:'Sign out of Demo', exact:true}).click();
        await explore(page).waitFor();
        const connect = page.getByRole('button', {name:/Connect to OneDrive/});
        assert.equal(await connect.evaluate(el => el === document.activeElement), true);
        const checkpoint = await page.evaluate(() => ({
            selected: localStorage.getItem('oneplay_demo_active'),
            time: JSON.parse(localStorage.getItem('demo_oneplay_music_time')).time,
            paused: document.getElementById('player').paused,
        }));
        assert.equal(checkpoint.selected, null);
        assert(checkpoint.time > 0 && checkpoint.paused);
        await connect.click();
        await page.getByText('Connect to the internet to sign in to OneDrive.').waitFor();
        await explore(page).click();
        await page.waitForFunction(() => document.querySelector('#footer.visible') && document.getElementById('player').paused);
        const pinned = await page.evaluate(async ({key}) => {
            const {createMusicDatabase} = await import('./dist/db.js');
            return (await createMusicDatabase('oneplay-demo-music-cache', 1).audioGet(key))?.size;
        }, {key:'demo:' + blob + '-Demo%20Album/Alice.mp3'});
        assert.equal(pinned, clip.length);
        assert.equal(graph, 0);
    },

    async 'demo: pin retries its own recording while the catalog is unreachable'(page) {
        await serveDemo(page);
        await page.goto(url);
        await explore(page).click();
        const folder = page.locator('#children .tree-row').filter({hasText:'Demo Album'});
        await folder.waitFor();
        await page.evaluate(() => {
            Object.defineProperty(navigator, 'onLine', {get: () => false, configurable: true});
            document.dispatchEvent(new Event('visibilitychange'));
        });
        await folder.click({button:'right'});
        await page.locator('.action-dropdown').getByRole('button', {name:'Make available offline', exact:true}).click();
        await page.locator('.modal').getByRole('button',{name:'Make available offline', exact:true}).click();
        await folder.locator('.offline-badge.paused').waitFor();
        await page.unroute(manifestUrl);
        await page.route(manifestUrl, r => r.fulfill({status:503, headers:cors}));
        const rawTrack = raw + commit + '/Music/Demo%20Album/Alice.mp3';
        let gets = 0, heads = 0;
        await page.unroute(rawTrack);
        await page.route(rawTrack, r => {
            if (r.request().method() === 'HEAD') {
                heads++;
                return r.fulfill({status:403, headers:cors});
            }
            if (++gets === 1) return r.fulfill({status:503, headers:cors});
            return r.fulfill({body:clip, contentType:'audio/mpeg', headers:cors});
        });
        await page.evaluate(() => {
            Object.defineProperty(navigator, 'onLine', {get: () => true, configurable: true});
            window.dispatchEvent(new Event('online'));
        });
        await folder.locator('.offline-badge.complete').waitFor();
        assert.equal(gets, 2);
        assert.equal(heads, 0);
    },

    async 'demo: a new shortcut opens its folder after reload'(page) {
        await serveDemo(page);
        await page.goto(url);
        await explore(page).click();
        await page.locator('#children .tree-row').filter({hasText:'Demo Album'}).click({button:'right'});
        const actions = page.getByRole('button', {name:'Playlist and shortcut actions'});
        if (await actions.getAttribute('aria-expanded') !== 'true') await actions.click();
        await page.locator('.action-dropdown button').filter({hasText:'Add as Shortcut'}).click();
        await page.locator('.modal').getByRole('button', {name:'Create', exact:true}).click();
        const shortcut = page.locator('#children .tree-row[data-path*="fav:"]').filter({hasText:'Demo Album'});
        await shortcut.waitFor();
        await page.reload();
        await shortcut.click();
        await page.locator('#children .tree-row.file').filter({hasText:'Alice'}).waitFor();
    },

    async 'demo: an invalid saved catalog recovers from a valid publication'(page) {
        await serveDemo(page);
        await page.goto(url);
        await page.evaluate(async () => {
            const {createMusicDatabase} = await import('./dist/db.js');
            await createMusicDatabase('oneplay-demo-music-cache', 1).dbPut('catalog', {schemaVersion:99});
        });
        await explore(page).click();
        await page.locator('#children .tree-row').filter({hasText:'Demo Album'}).waitFor();
    },

    async 'demo: credits update in open Settings when the catalog refreshes'(page) {
        let release;
        const wait = new Promise(resolve => { release = resolve; });
        const next = 'c'.repeat(40);
        let requests = 0;
        await page.route(manifestUrl, async route => {
            if (++requests === 1) return route.fulfill({json:manifest, headers:cors});
            await wait;
            return route.fulfill({json:{...manifest, mediaCommit:next}, headers:cors}).catch(() => {});
        });
        try {
            await page.goto(url);
            await explore(page).click();
            await page.getByRole('button', {name:'Settings, demo library'}).click();
            const link = page.getByRole('link', {name:'credits', exact:true});
            assert.equal(await link.getAttribute('href'), raw + commit + '/credits.txt');
            release();
            await page.waitForFunction(href => document.querySelector('.settings-demo-summary a')?.href === href,
                raw + next + '/credits.txt');
            assert(await link.isVisible());
        } finally { release(); }
    },

    async 'demo: losing internet during first fetch keeps the chooser and recovers on reconnect'(page) {
        let release;
        let seen;
        const held = new Promise(resolve => { release = resolve; });
        const started = new Promise(resolve => { seen = resolve; });
        await page.route(manifestUrl, async route => {
            seen();
            await held;
            await route.abort('internetdisconnected').catch(() => {});
        });
        try {
            await page.goto(url);
            await explore(page).click();
            await started;
            await page.evaluate(() => Object.defineProperty(navigator, 'onLine', {get: () => false, configurable: true}));
            release();
            await page.getByText('The demo library needs an internet connection to open.').waitFor();
            assert(await page.getByRole('button', {name:/Connect to OneDrive/}).isVisible());
            await page.unroute(manifestUrl);
            await serveDemo(page);
            await page.evaluate(() => {
                Object.defineProperty(navigator, 'onLine', {get: () => true, configurable: true});
                window.dispatchEvent(new Event('online'));
            });
            await page.locator('#children .tree-row').filter({hasText:'Demo Album'}).waitFor();
        } finally { release(); }
    },

    async 'demo: reconnect during a pending opening retries only if that opening fails'(page) {
        let seen;
        let rejectFirst;
        let attempts = 0;
        const started = new Promise(resolve => { seen = resolve; });
        const pending = new Promise(resolve => { rejectFirst = resolve; });
        await page.route(manifestUrl, async route => {
            if (++attempts === 1) {
                seen();
                await pending;
                await route.abort('failed').catch(() => {});
            } else await route.fulfill({json:manifest, headers:cors});
        });
        try {
            await page.goto(url);
            await explore(page).click();
            await started;
            await page.evaluate(() => window.dispatchEvent(new Event('online')));
            assert.equal(attempts, 1);
            rejectFirst();
            await page.locator('#children .tree-row').filter({hasText:'Demo Album'}).waitFor();
            assert(attempts >= 2);
        } finally { rejectFirst(); }
    },

    async 'demo: online personal sign-out cancels a held account probe and opens both choices locally'(page) {
        let probeStarted;
        let finishProbe;
        const started = new Promise(resolve => { probeStarted = resolve; });
        const hold = new Promise(resolve => { finishProbe = resolve; });
        let microsoft = 0;
        await page.route('https://login.microsoftonline.com/**', route => { microsoft++; return route.abort(); });
        await page.route(url + 'seed-demo-signout', r => r.fulfill({contentType:'text/html', body:'<title>Seed</title>'}));
        await page.route('https://graph.microsoft.com/**', async r => {
            if (new URL(r.request().url()).pathname === '/v1.0/me/drive') {
                probeStarted();
                await hold;
            }
            await r.fulfill({status:503, headers:cors}).catch(() => {});
        });
        await page.goto(url + 'seed-demo-signout');
        await page.evaluate(async () => {
            const {dbPut} = await import('./dist/db.js');
            localStorage.account_info = JSON.stringify({driveId:'personal', displayName:'OneDrive'});
            localStorage.access_token = 'fixture-token';
            await dbPut('index:personal', {kind:'MusicData', count:1, folder:{id:'root',
                children:{'Personal song.mp3':{id:'track'}}}});
        });
        try {
            await page.goto(url);
            await started;
            await page.getByRole('button', {name:'Open settings'}).click();
            await page.getByRole('button', {name:'Sign out', exact:true}).click();
            await explore(page).waitFor({timeout:5000});
            assert.equal(microsoft, 0);
            assert.equal(await page.getByRole('button', {name:/Connect to OneDrive/}).evaluate(el => el === document.activeElement), true);
            assert.equal(await page.evaluate(() => localStorage.getItem('account_info')), null);
            assert.equal(await page.evaluate(() => localStorage.getItem('oneplay_music_playback')), null);
        } finally { finishProbe(); }
    },

    async 'demo: Connect replaces the chevron while waiting without shifting the chooser'(page) {
        await page.addInitScript(() => {
            const digest = crypto.subtle.digest.bind(crypto.subtle);
            Object.defineProperty(crypto.subtle, 'digest', {value: (...args) => new Promise(resolve => {
                window._testReleaseConnect = () => resolve(digest(...args));
            })});
        });
        await page.route('https://login.microsoftonline.com/**/authorize?**', route =>
            route.fulfill({status:302, headers:{location:url + '?error=access_denied'}}));
        await page.goto(url);
        const chooser = page.locator('.library-chooser');
        const connect = page.locator('.library-choice-onedrive');
        const trailing = connect.locator('.library-choice-next');
        await connect.waitFor();
        assert.equal(await connect.locator('img').evaluate(async image => {
            await image.decode();
            return image.naturalWidth;
        }), 128);
        const bounds = await chooser.boundingBox();
        const slot = await trailing.boundingBox();
        await connect.click();
        await page.waitForFunction(() => typeof window._testReleaseConnect === 'function');
        assert.equal(await connect.getAttribute('aria-busy'), 'true');
        assert.equal(await chooser.locator('.library-choice-status').textContent(), '');
        assert.equal(await trailing.evaluate(node => getComputedStyle(node, '::after').animationName), 'spin');
        assert.deepEqual(await chooser.boundingBox(), bounds);
        assert.deepEqual(await trailing.boundingBox(), slot);
        await page.evaluate(() => { window._testReleaseConnect(); });
        await page.waitForFunction(() => {
            const button = document.querySelector('.library-choice-onedrive');
            return button === document.activeElement && !button.hasAttribute('aria-busy') && !sessionStorage.oneplay_connect_origin;
        });
    },

    async 'demo: Connect fences a slow opening and cancellation keeps the chooser'(page) {
        await page.addInitScript(() => { window._testStartupOpeningWaitMs = 125; });
        let markStarted;
        let release;
        const started = new Promise(resolve => { markStarted = resolve; });
        const hold = new Promise(resolve => { release = resolve; });
        await page.route(manifestUrl, async r => {
            markStarted();
            await hold;
            await r.fulfill({json:manifest, headers:cors}).catch(() => {});
        });
        await page.route('https://login.microsoftonline.com/**/authorize?**', r =>
            r.fulfill({status:302, headers:{location:url + '?error=access_denied'}}));
        try {
            await page.goto(url);
            await explore(page).click();
            await started;
            await page.getByText('Still opening the demo library…').waitFor();
            const connect = page.getByRole('button',{name:/Connect to OneDrive/});
            const cancelled = page.waitForEvent('requestfailed', request => request.url() === manifestUrl);
            await connect.click();
            await page.waitForFunction(() =>
                document.activeElement?.classList.contains('library-choice-onedrive') &&
                !sessionStorage.getItem('oneplay_connect_origin'));
            release();
            await cancelled;
            assert(await explore(page).isVisible());
            assert.equal(await page.evaluate(() => localStorage.getItem('oneplay_demo_active')), null);
        } finally { release(); }
    },
};
