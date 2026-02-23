import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createAuth, isAbortError } from '../../src/auth.js';

class MemoryStorage implements Storage {
    private readonly data = new Map<string, string>();

    get length(): number { return this.data.size; }

    clear(): void { this.data.clear(); }

    getItem(key: string): string | null { return this.data.has(key) ? this.data.get(key)! : null; }

    key(index: number): string | null { return Array.from(this.data.keys())[index] ?? null; }

    removeItem(key: string): void { this.data.delete(key); }

    setItem(key: string, value: string): void { this.data.set(key, value); }
}

function makeAbortError(): Error {
    if (typeof DOMException === 'function') return new DOMException('Aborted', 'AbortError');
    const err = new Error('Aborted');
    err.name = 'AbortError';
    return err;
}

function withAuthTestEnv(
    online: boolean,
    run: (ctx: { localStorage: Storage }) => Promise<void>,
): Promise<void> {
    const originalFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
    const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    const originalSessionStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

    const ls = new MemoryStorage();
    const ss = new MemoryStorage();
    ls.setItem('access_token', 'test-access-token');
    ls.setItem('refresh_token', 'test-refresh-token');

    Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        writable: true,
        value: { onLine: online },
    });
    Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        writable: true,
        value: ls,
    });
    Object.defineProperty(globalThis, 'sessionStorage', {
        configurable: true,
        writable: true,
        value: ss,
    });
    Object.defineProperty(globalThis, 'window', {
        configurable: true,
        writable: true,
        value: {
            location: { pathname: '/', origin: 'http://localhost:5500', search: '' },
            history: { replaceState() { /* noop for tests */ } },
        },
    });

    const restore = (): void => {
        if (originalFetch) Object.defineProperty(globalThis, 'fetch', originalFetch);
        else delete (globalThis as Record<string, unknown>).fetch;
        if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
        else delete (globalThis as Record<string, unknown>).navigator;
        if (originalLocalStorage) Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
        else delete (globalThis as Record<string, unknown>).localStorage;
        if (originalSessionStorage) Object.defineProperty(globalThis, 'sessionStorage', originalSessionStorage);
        else delete (globalThis as Record<string, unknown>).sessionStorage;
        if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
        else delete (globalThis as Record<string, unknown>).window;
    };

    return run({ localStorage: ls }).finally(restore);
}

describe('auth cancellation semantics', () => {
    it('user abort during request throws AbortError and does not transition evidence', async () => {
        await withAuthTestEnv(true, async () => {
            let requestStartedResolve!: () => void;
            const requestStarted = new Promise<void>((resolve) => { requestStartedResolve = resolve; });
            (globalThis as Record<string, unknown>).fetch = (_url: string, init?: RequestInit) => {
                requestStartedResolve();
                return new Promise<Response>((_resolve, reject) => {
                    const signal = init?.signal;
                    if (signal?.aborted) {
                        reject(makeAbortError());
                        return;
                    }
                    signal?.addEventListener('abort', () => reject(makeAbortError()), { once: true });
                });
            };

            const auth = createAuth();
            let transitionCount = 0;
            auth.onEvidenceChange = () => { transitionCount += 1; };
            const controller = new AbortController();
            const req = auth.fetch('https://graph.microsoft.com/v1.0/me', false, { signal: controller.signal });
            await requestStarted;
            controller.abort();
            await assert.rejects(req, (e: unknown) => isAbortError(e));
            assert.equal(transitionCount, 0);
            assert.equal(auth.getEvidence(), 'no-evidence');
        });
    });

    it('user abort during retry backoff exits immediately without extra retry', async () => {
        await withAuthTestEnv(true, async () => {
            let callCount = 0;
            let firstCallResolve!: () => void;
            const firstCall = new Promise<void>((resolve) => { firstCallResolve = resolve; });
            (globalThis as Record<string, unknown>).fetch = () => {
                callCount += 1;
                if (callCount === 1) firstCallResolve();
                return Promise.resolve(new Response('', { status: 503 }));
            };

            const auth = createAuth();
            const controller = new AbortController();
            const req = auth.fetch('https://graph.microsoft.com/v1.0/me', true, { signal: controller.signal });
            await firstCall;
            controller.abort();
            await assert.rejects(req, (e: unknown) => isAbortError(e));
            assert.equal(callCount, 1);
            assert.equal(auth.getEvidence(), 'no-evidence');
        });
    });

    it('known-offline at fetch initiation short-circuits network and classifies evidence', async () => {
        await withAuthTestEnv(false, async () => {
            (globalThis as Record<string, unknown>).fetch = (_url: string, init?: RequestInit) =>
                new Promise<Response>((_resolve, reject) => {
                    const signal = init?.signal;
                    if (signal?.aborted) {
                        reject(makeAbortError());
                        return;
                    }
                    signal?.addEventListener('abort', () => reject(makeAbortError()), { once: true });
                });

            const auth = createAuth();
            const r = await auth.fetch('https://graph.microsoft.com/v1.0/me', false, { timeoutMs: 5 });
            assert.equal(r.ok, false);
            assert.equal(r.status, 503);
            assert.equal(auth.getEvidence(), 'evidence:not-online');
        });
    });

    it('abort while waiting on refresh lock throws AbortError', async () => {
        await withAuthTestEnv(true, async () => {
            let refreshStartedResolve!: () => void;
            const refreshStarted = new Promise<void>((resolve) => { refreshStartedResolve = resolve; });
            (globalThis as Record<string, unknown>).fetch = (url: string, init?: RequestInit) => {
                if (url.includes('/oauth2/v2.0/token')) {
                    refreshStartedResolve();
                    return new Promise<Response>((_resolve, reject) => {
                        const signal = init?.signal;
                        if (signal?.aborted) {
                            reject(makeAbortError());
                            return;
                        }
                        signal?.addEventListener('abort', () => reject(makeAbortError()), { once: true });
                    });
                }
                return Promise.resolve(new Response('', { status: 401 }));
            };

            const auth = createAuth();
            const firstController = new AbortController();
            const first = auth.fetch(
                'https://graph.microsoft.com/v1.0/me',
                false,
                { signal: firstController.signal },
            ).catch(() => undefined);
            await refreshStarted;
            const secondController = new AbortController();
            const second = auth.fetch(
                'https://graph.microsoft.com/v1.0/me',
                false,
                { signal: secondController.signal },
            );
            secondController.abort();
            await assert.rejects(second, (e: unknown) => isAbortError(e));
            firstController.abort();
            await first;
        });
    });

    it('abort during refresh request does not sentinel tokens', async () => {
        await withAuthTestEnv(true, async ({ localStorage }) => {
            let refreshStartedResolve!: () => void;
            const refreshStarted = new Promise<void>((resolve) => { refreshStartedResolve = resolve; });
            (globalThis as Record<string, unknown>).fetch = (url: string, init?: RequestInit) => {
                if (url.includes('/oauth2/v2.0/token')) {
                    refreshStartedResolve();
                    return new Promise<Response>((_resolve, reject) => {
                        const signal = init?.signal;
                        if (signal?.aborted) {
                            reject(makeAbortError());
                            return;
                        }
                        signal?.addEventListener('abort', () => reject(makeAbortError()), { once: true });
                    });
                }
                return Promise.resolve(new Response('', { status: 401 }));
            };

            const auth = createAuth();
            const controller = new AbortController();
            const req = auth.fetch(
                'https://graph.microsoft.com/v1.0/me',
                false,
                { signal: controller.signal },
            );
            await refreshStarted;
            controller.abort();
            await assert.rejects(req, (e: unknown) => isAbortError(e));
            assert.equal(localStorage.getItem('access_token'), 'test-access-token');
            assert.equal(localStorage.getItem('refresh_token'), 'test-refresh-token');
        });
    });
});

describe('auth oauth redirect code-exchange failure handling', () => {
    it('timeout-like token exchange response returns timeout error and clears redirect state', async () => {
        await withAuthTestEnv(true, async () => {
            const win = globalThis.window as unknown as {
                location: { pathname: string; search: string };
                history: { replaceState: (_a: unknown, _b: string, _url: string) => void };
            };
            win.location.search = '?code=test-code';
            sessionStorage.setItem('code_verifier', 'pkce-verifier');
            let replaceCount = 0;
            win.history.replaceState = (_a, _b, _url) => {
                replaceCount += 1;
                win.location.search = '';
            };
            (globalThis as Record<string, unknown>).fetch = () =>
                Promise.resolve(new Response('Timeout after 10000ms', { status: 504, statusText: 'Request timed out' }));

            const auth = createAuth();
            const result = await auth.handleOauthRedirect();
            assert.equal(typeof result.error, 'string');
            assert.match(result.error ?? '', /exchangeCodeForToken: timeout/);
            assert.equal(sessionStorage.getItem('code_verifier'), null);
            assert.equal(win.location.search, '');
            assert.equal(replaceCount, 1);
        });
    });

    it('malformed token response returns parse error and clears redirect state', async () => {
        await withAuthTestEnv(true, async () => {
            const win = globalThis.window as unknown as {
                location: { pathname: string; search: string };
                history: { replaceState: (_a: unknown, _b: string, _url: string) => void };
            };
            win.location.search = '?code=test-code';
            sessionStorage.setItem('code_verifier', 'pkce-verifier');
            let replaceCount = 0;
            win.history.replaceState = (_a, _b, _url) => {
                replaceCount += 1;
                win.location.search = '';
            };
            (globalThis as Record<string, unknown>).fetch = () =>
                Promise.resolve(new Response('not-json', { status: 200 }));

            const auth = createAuth();
            const result = await auth.handleOauthRedirect();
            assert.equal(typeof result.error, 'string');
            assert.match(result.error ?? '', /exchangeCodeForToken: parse/);
            assert.equal(sessionStorage.getItem('code_verifier'), null);
            assert.equal(win.location.search, '');
            assert.equal(replaceCount, 1);
        });
    });
});
