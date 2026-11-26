/** Standalone iPhone Mobile Safari storage check. Requires `npm run build`, an already-booted
 * iPhone simulator UDID, and idb. Run `node test/integration/iphone-browser-quota.cjs UDID`.
 * Writes 2.8 GB on a new loopback origin, then deletes that origin's database, even on failure.
 * The device lookup explicitly admits only CoreSimulator iPhones; this cannot target a handset.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const {execFile} = require('node:child_process');
const exec = require('node:util').promisify(execFile);
const root = path.resolve(__dirname, '../..');
// 60 artists × 10 albums × 50 recordings. One artist is pinned. A single sample buffer
// feeds both sequential seeding and bounded concurrent downloads, independently of the library size.
const fixture = {libraryCount:30000, pinnedCount:500, tracksPerAlbum:50, bytesPerTrack:5600000};
fixture.seedCount = Math.floor(2 ** 31 / fixture.bytesPerTrack);

/** Seed the real PWA audio and index stores, one transaction per recording. */
async function seed({libraryCount,pinnedCount,tracksPerAlbum,seedCount}) {
    const {audioPut, dbPut} = await import('/music/dist/db.js');
    const sample = new Uint8Array(await (await fetch('/sample/0.wav')).arrayBuffer());
    const pcm = new DataView(sample.buffer);
    const folder = {id:'root',children:{}};
    for (let i = 0; i < libraryCount; ++i) {
        const artist = Math.floor(i / pinnedCount), album = Math.floor((i % pinnedCount) / tracksPerAlbum);
        const artistFolder = folder.children['Artist ' + artist] ??= {id:'artist-' + artist,children:{}};
        const albumFolder = artistFolder.children['Album ' + album] ??= {id:'album-' + artist + '-' + album,children:{}};
        albumFolder.children['Track ' + i + '.wav'] = {id:String(i)};
        if (i < seedCount) {
            pcm.setUint32(44, i, true); // Make each saved recording distinct at its first PCM sample.
            await audioPut('quota:' + i, new Blob([sample], {type:'audio/wav'}));
        }
    }
    await dbPut('index:quota', {kind:'MusicData',schemaVersion:1,size:10,count:libraryCount,folder});
    await dbPut('favorites',{version:1,updatedAt:1,favorites:[],folderPins:[
        {driveId:'quota',sourceRootKey:'quota',itemId:'artist-0',path:['Artist 0'],isFolder:true}]});
    localStorage.setItem('oneplay_music_quota_bytes', String(2 * 1024 ** 3));
    localStorage.setItem('account_info', JSON.stringify({driveId:'quota',displayName:'Quota'}));
    localStorage.setItem('access_token','fixture');
    location.replace('/music/');
}

/** This script is injected into index.html, including the copy saved by the shipping worker. */
async function exercise({pinnedCount,tracksPerAlbum,seedCount,bytesPerTrack}) {
    const realFetch = fetch;
    const offline = location.search === '?offline';
    const report = data => realFetch('/event', {method:'POST',body:JSON.stringify(data)});
    const until = async (test, message, timeout = 30000) => {
        const deadline = performance.now() + timeout;
        while (!test()) {
            if (performance.now() > deadline) throw Error(message);
            await new Promise(resolve => setTimeout(resolve, 25));
        }
    };
    const requests = [];
    window.fetch = async (input, options) => {
        const u = new URL(typeof input === 'string' ? input : input.url, location.href);
        if (u.origin === location.origin) return realFetch(input, options);
        if (offline) {
            if (u.hostname === 'quota.invalid') requests.push(u.pathname.slice(1));
            throw TypeError('Offline fixture');
        }
        if (u.hostname === 'quota.invalid') return realFetch('/sample' + u.pathname + '.wav');
        if (u.hostname !== 'graph.microsoft.com') throw TypeError('Unknown fixture request');
        if (u.searchParams.get('$select') === '@microsoft.graph.downloadUrl')
            return Response.json({'@microsoft.graph.downloadUrl':'https://quota.invalid/' + u.pathname.split('/').pop()});
        if (u.pathname.endsWith('/me/drive')) return Response.json({id:'quota',owner:{user:{displayName:'Quota'}}});
        if (u.pathname.endsWith('/special/music')) return Response.json({id:'root',size:10,folder:{}});
        return new Response(null, {status:404});
    };
    const snapshot = () => window._testDownloads?.getSnapshot();
    if (!offline) {
        // The first two downloads were admitted below the limit. Both finish while the remaining
        // 115 recordings stay queued until the user changes quota.
        await until(() => snapshot()?.overQuota && snapshot().files.size === seedCount + 2, 'Quota did not pause');
        const paused = snapshot();
        const pausedCount = paused.files.size;
        const pending = Array.from({length:pinnedCount}, (_, i) => String(i)).find(id => !paused.files.has('quota:' + id));
        localStorage.setItem('quota-test-pending', pending);
        window._testTree.setSelectedPath(['OnePlay Music','quota']);
        document.querySelector('#children .folder').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}));
        document.querySelector('#action-bar .right-btn').click();
        document.querySelector('.action-dropdown button').click();
        await until(() => document.querySelector('.offline-warning')?.textContent === 'Reached storage limit', 'Warning missing');
        const quota = document.querySelector('.offline-global select');
        if (quota.value !== '2') throw Error('Wrong quota before resume');
        quota.value = '5';
        quota.dispatchEvent(new Event('change'));
        await until(() => !snapshot().overQuota && snapshot().files.size === pinnedCount, 'Quota did not resume', 120000);
        await until(() => navigator.serviceWorker.controller, 'Offline app shell was not installed');
        await report({event:'downloaded',pending,pausedCount,pausedBytes:paused.totalBytes,
            finalCount:snapshot().files.size,finalBytes:snapshot().totalBytes});
    } else {
        const pending = localStorage.getItem('quota-test-pending');
        await until(() => window._testPlayback && snapshot()?.files.has('quota:' + pending), 'Cold local load failed');
        const inventory = snapshot();
        if (inventory.files.size !== pinnedCount || inventory.totalBytes !== pinnedCount * bytesPerTrack)
            throw Error('Cold inventory does not match the completed cache');
        window._testTree.setSelectedPath(['OnePlay Music','quota','Artist 0','Album ' + Math.floor(Number(pending)/tracksPerAlbum)]);
        const row = () => [...document.querySelectorAll('#children .file')].find(el => el.textContent === 'Track ' + pending + '.wav');
        await until(() => row() && !row().classList.contains('unavailable'), 'Cold cached row unavailable');
        row().scrollIntoView({block:'center'});
        let trusted = false;
        // Safari's address-bar position and safe area vary by iPhone. One inert tap measures
        // the viewport's offset in simulator points before the real recording-row gesture.
        document.addEventListener('click', e => {
            e.preventDefault();
            e.stopImmediatePropagation();
            const r = row().getBoundingClientRect();
            report({event:'calibrated', clientX:e.clientX, clientY:e.clientY, x:r.x+r.width/2, y:r.y+r.height/2});
        }, {capture:true, once:true});
        document.addEventListener('click', e => { if (row()?.contains(e.target)) trusted = e.isTrusted; }, true);
        await report({event:'ready', pending});
        const audio = document.querySelector('audio');
        await until(() => !audio.paused && audio.currentTime > 0.15, 'Cached recording playback clock did not advance');
        await report({event:'playing',time:audio.currentTime,src:audio.currentSrc.split(':')[0],trusted,requests});
        audio.pause();
    }
}

async function main() {
    const udid = process.argv[2];
    const simctl = (...args) => exec('xcrun', ['simctl', ...args], {timeout:40000});
    const idb = (...args) => exec('idb', [...args,'--udid',udid], {timeout:40000});
    const sims = JSON.parse((await simctl('list','devices','booted','--json')).stdout).devices;
    assert(Object.values(sims).flat().some(sim => sim.udid === udid && sim.deviceTypeIdentifier?.includes('.iPhone-')),
        'Pass a booted iPhone simulator UDID');
    // A 31.7-second 44.1 kHz stereo PCM file. Every blob is decodable; low-level dither
    // keeps the fixture closer to real recorded data than a long run of silent samples.
    const sample = require('node:crypto').randomBytes(fixture.bytesPerTrack);
    sample.write('RIFF', 0); sample.writeUInt32LE(sample.length - 8, 4); sample.write('WAVEfmt ', 8);
    sample.writeUInt32LE(16, 16); sample.writeUInt16LE(1, 20); sample.writeUInt16LE(2, 22);
    sample.writeUInt32LE(44100, 24); sample.writeUInt32LE(44100 * 4, 28);
    sample.writeUInt16LE(4, 32); sample.writeUInt16LE(16, 34); sample.write('data', 36); sample.writeUInt32LE(sample.length - 44, 40);
    for (let i = 44; i < sample.length; i += 2) {
        const t = Math.floor((i - 44) / 4) / 44100;
        sample.writeInt16LE(Math.round(320 * Math.sin(t * 440 * 2 * Math.PI) + sample.readInt16LE(i) / 64), i);
    }
    const events = [];
    let offline = false, dropped = 0;
    const script = (fn) => `<script>(${fn})(${JSON.stringify(fixture)}).catch(error => fetch('/event',{method:'POST',body:JSON.stringify({event:'error',message:String(error)})}));</script>`;
    const server = http.createServer(async (req, res) => {
        try {
            const name = new URL(req.url, 'http://localhost').pathname;
            if (name === '/event' && req.method === 'POST') {
                let body = '';
                for await (const part of req) body += part;
                const event = JSON.parse(body); events.push(event); console.log(event);
                res.writeHead(204).end();
            } else if (name === '/cleanup') {
                res.setHeader('Content-Type','text/html');
                res.end(script(async function cleanup() {
                    await new Promise((resolve,reject) => {
                        const q = indexedDB.deleteDatabase('oneplay-music-cache'); q.onsuccess = resolve; q.onerror = () => reject(q.error);
                    });
                    localStorage.clear();
                    for (const cache of await caches.keys()) await caches.delete(cache);
                    for (const worker of await navigator.serviceWorker.getRegistrations()) await worker.unregister();
                    await fetch('/event',{method:'POST',body:JSON.stringify({event:'cleaned'})});
                }));
            } else if (offline) {
                dropped++; req.socket.destroy(); // No shell, media, or Graph is available on cold reopen.
            } else if (name === '/seed') {
                res.setHeader('Content-Type','text/html'); res.end(script(seed));
            } else if (/^\/sample\/\d+\.wav$/.test(name)) {
                const firstSample = Buffer.alloc(4);
                firstSample.writeUInt32LE(Number(path.basename(name, '.wav')));
                res.writeHead(200, {'Content-Type':'audio/wav','Content-Length':sample.length,'Cache-Control':'no-store'});
                res.write(sample.subarray(0,44)); res.write(firstSample); res.end(sample.subarray(48));
            } else if (name.startsWith('/music/')) {
                const file = path.join(root, name.slice('/music/'.length) || 'index.html');
                const body = await fs.readFile(file);
                const ext = path.extname(file);
                res.setHeader('Content-Type', {'.js':'text/javascript','.css':'text/css','.html':'text/html','.json':'application/json','.png':'image/png'}[ext] ?? 'application/octet-stream');
                res.setHeader('Cache-Control','no-store');
                res.end(ext === '.html' ? body.toString().replace('<head>', '<head>' + script(exercise)) : body);
            } else res.writeHead(404).end();
        } catch { res.writeHead(404).end(); }
    });
    await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const wait = async (event, timeout = 40000) => {
        const deadline = Date.now() + timeout;
        for (;;) {
            const result = events.find(item => item.event === event || (item.event === 'error' && event !== 'cleaned'));
            if (result?.event === 'error') throw Error(result.message);
            if (result) return result;
            assert(Date.now() < deadline, `Timed out waiting for ${event}`);
            await new Promise(resolve => setTimeout(resolve,150));
        }
    };
    const reopen = async (url) => {
        await simctl('terminate',udid,'com.apple.mobilesafari').catch(() => {});
        await simctl('openurl',udid,origin + url);
    };
    try {
        await reopen('/seed');
        const saved = await wait('downloaded',210000);
        assert.equal(saved.pausedCount, fixture.seedCount + 2);
        assert.equal(saved.pausedBytes, saved.pausedCount * fixture.bytesPerTrack);
        assert.equal(saved.finalCount, fixture.pinnedCount);
        assert.equal(saved.finalBytes, fixture.pinnedCount * fixture.bytesPerTrack);
        offline = true;
        await reopen('/music/?offline');
        await wait('ready');
        await idb('ui','tap','100','185','--reason','Measure Safari viewport offset for the recording-row tap');
        const target = await wait('calibrated');
        await idb('ui','tap',String(Math.round(100-target.clientX+target.x)),String(Math.round(185-target.clientY+target.y)),
            '--reason','Play the recording downloaded after raising quota');
        const played = await wait('playing');
        assert(played.trusted && played.src === 'blob' && played.time > 0.15);
        assert.deepEqual(played.requests, []);
        assert(dropped > 0, 'Reopened using the cached shell while localhost dropped requests');
    } finally {
        try { await reopen('/cleanup'); await wait('cleaned'); }
        finally { server.closeAllConnections(); server.close(); }
    }
}
main().catch(error => {console.error(error); process.exitCode = 1;});
