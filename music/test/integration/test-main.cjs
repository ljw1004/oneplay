/**
 * Integration test entrypoint (split from tree.test.cjs).
 * Keeps runner semantics and filter behavior unchanged.
 */

const helpers = require('./test-helpers.cjs');
const {
    chromium,
    fs,
    os,
    path,
    URL,
    PROFILE,
    TREE_NOT_VISIBLE_ERROR,
    emit,
    setup,
} = helpers;

// Expose helper functions/consts as globals so split case modules can keep
// the original concise test bodies without parameter plumbing.
const helperGlobals = { ...helpers };
delete helperGlobals.URL;
Object.assign(globalThis, helperGlobals);
globalThis.__ONEPLAY_TEST_URL = URL;

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

globalThis.assert = assert;

const tests = {
    ...require('./test-cases-tree-settings.cjs'),
    ...require('./test-cases-playback-select.cjs'),
    ...require('./test-cases-modes.cjs'),
    ...require('./test-cases-startup.cjs'),
};

let passed = 0;
let failed = 0;
const failures = [];

function isSignInGateFailure(error) {
    return (error && typeof error.message === 'string' && error.message === TREE_NOT_VISIBLE_ERROR);
}

/** Startup tests intentionally mutate auth/storage state and must never touch
 *  the shared persistent profile. */
function usesIsolatedProfile(name) {
    return name.startsWith('startup:');
}

/** Capture full localStorage snapshot for the current page origin. */
async function snapshotLocalStorage(page) {
    return await page.evaluate(() => {
        const snapshot = {};
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key === null) continue;
            snapshot[key] = localStorage.getItem(key);
        }
        return snapshot;
    });
}

/** Restore full localStorage snapshot for the current page origin. */
async function restoreLocalStorageSnapshot(page, snapshot) {
    await page.evaluate((stored) => {
        localStorage.clear();
        for (const [key, value] of Object.entries(stored)) {
            if (typeof value === 'string') localStorage.setItem(key, value);
        }
    }, snapshot);
}

(async () => {
    const filter = process.argv[2] || '';
    const ctx = await chromium.launchPersistentContext(PROFILE, { headless: true });
    /** Full localStorage snapshot for the app origin, restored at suite end.
     *  Prevents destructive tests (startup/auth paths) from poisoning the
     *  shared Chromium profile used for subsequent runs. */
    let originStorageSnapshot = {};

    // Unregister any previously-active service worker so it doesn't serve
    // stale cached HTML. page.route('**/sw.js') only blocks new registrations;
    // an already-active SW still intercepts fetches until unregistered.
    const initPage = ctx.pages()[0] || await ctx.newPage();
    await initPage.goto(URL, { waitUntil: 'domcontentloaded' });
    originStorageSnapshot = await snapshotLocalStorage(initPage);
    await (async () => {
        try {
            const cdp = await ctx.newCDPSession(initPage);
            await cdp.send('Network.enable');
            await cdp.send('Network.clearBrowserCache');
        } catch {
            // CDP cache clearing may be unavailable in some headless contexts.
        }
    })();
    await initPage.evaluate(async () => {
        const reg = await navigator.serviceWorker?.getRegistration();
        if (reg) await reg.unregister();
    }).catch(() => {});  // SW API may throw in some headless contexts
    await initPage.close();

    const entries = Object.entries(tests).filter(([name]) =>
        name.toLowerCase().includes(filter.toLowerCase()));

    if (entries.length === 0) {
        emit(`No tests matching "${filter}"`);
        await ctx.close();
        process.exit(1);
    }

    if (filter) emit(`Running ${entries.length} test(s) matching "${filter}"\n`);

    const totalStart = Date.now();
    let abortRemaining = false;
    for (const [name, fn] of entries) {
        let tempCtx = null;
        let tempProfileDir = null;
        const isolated = usesIsolatedProfile(name);
        if (isolated) {
            tempProfileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oneplay-music-it-startup-'));
            tempCtx = await chromium.launchPersistentContext(tempProfileDir, { headless: true });
        }
        const activeCtx = tempCtx || ctx;
        const page = await activeCtx.newPage();
        const t0 = Date.now();
        let perTestStorageSnapshot = {};
        try {
            await page.goto(URL, { waitUntil: 'domcontentloaded' });
            if (isolated) {
                await restoreLocalStorageSnapshot(page, originStorageSnapshot).catch(() => {});
            }
            perTestStorageSnapshot = await snapshotLocalStorage(page);
            if (!name.startsWith('startup:')) await setup(page);
            await fn(page);
            emit(`  ✓ ${name}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
            passed++;
        } catch (e) {
            emit(`  ✗ ${name}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
            emit(`    ${e.message}`);
            failed++;
            failures.push(name);
            if (isSignInGateFailure(e)) {
                abortRemaining = true;
                emit('Aborting remaining tests after sign-in gate failure.');
            }
        } finally {
            // Best-effort per-test restore so destructive auth/state changes
            // from one test cannot leak into subsequent tests.
            if (!isolated) {
                await page.goto(URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
                await restoreLocalStorageSnapshot(page, perTestStorageSnapshot).catch(() => {});
            }
            await page.close();
            if (tempCtx) await tempCtx.close();
            if (tempProfileDir) fs.rmSync(tempProfileDir, { recursive: true, force: true });
        }
        if (abortRemaining) break;
    }

    // Restore shared-profile localStorage to the pre-suite state so startup/auth
    // tests don't invalidate sign-in for future runs.
    const restorePage = await ctx.newPage();
    await restorePage.goto(URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await restoreLocalStorageSnapshot(restorePage, originStorageSnapshot);
    await restorePage.close();

    await ctx.close();

    const elapsed = ((Date.now() - totalStart) / 1000).toFixed(1);
    emit(`\n${passed} passed, ${failed} failed  (${elapsed}s total)`);
    if (failures.length > 0) {
        emit('Failures:');
        failures.forEach((f) => emit('  - ' + f));
    }
    process.exit(failed > 0 ? 1 : 0);
})();
