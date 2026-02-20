/**
 * Startup terminal-state and deadline controller for OnePlay Music.
 *
 * Scope:
 * - Owns startup deadline race/latch and terminal-state enforcement.
 * - Owns startup sign-in/error rendering helpers.
 * - Owns SW controllerchange reload wiring for debug mode.
 *
 * Non-scope:
 * - Background sync/index refresh orchestration (owned by index-sync.ts).
 * - Runtime app composition/wiring (owned by index.ts).
 */
import { log, logError, errorDetail } from './logger.js';
import type { IndexProgress } from './indexer.js';

export type StartupTerminalState = 'tree' | 'sign-in' | 'error' | 'deadline';

export interface IndexStartupDeps {
    readonly swDebug: boolean;
    readonly startupDeadlineMsDefault: number;
    readonly startupDeadlineWithOauthCodeMs: number;
    readonly startupErrorMessage: string;
    readonly getDebugEnabled: () => boolean;
    readonly getTestStartupDeadlineMs: () => unknown;
    readonly onSignIn: () => void;
    readonly renderIndexing: (progress: IndexProgress) => void;
}

export interface IndexStartupController {
    markStartupTerminalState(state: StartupTerminalState): void;
    enterFirstTimeIndexingAndBypassStartupDeadline(): void;
    startupDeadlineMs(): number;
    attachSwControllerChangeReloadListener(): void;
    getStartupTerminalUiState(): Exclude<StartupTerminalState, 'deadline'> | undefined;
    isStartupTerminalUiRendered(): boolean;
    renderStartupErrorIntoStatusAndWireReload(message: string): void;
    showError(message: string): void;
    renderSignInButtonIntoStatus(): void;
    onBodyLoad(startupInner: () => Promise<void>): Promise<void>;
}

export function createIndexStartup(deps: IndexStartupDeps): IndexStartupController {
    let swControllerChangeListenerAttached = false;
    let startupTerminated = false;
    let startupDeadlineGuardActive = false;
    let startupDeadlineBypassedForFirstTimeIndexing = false;

    const statusEl = (): HTMLElement => document.getElementById('status')!;

    const markStartupTerminalState = (state: StartupTerminalState): void => {
        if (startupTerminated) return;
        startupTerminated = true;
        const message = `startup complete: ${state}`;
        if (state === 'error' || state === 'deadline') logError(message);
        else log(message);
    };

    const enterFirstTimeIndexingAndBypassStartupDeadline = (): void => {
        if (!startupDeadlineGuardActive || startupDeadlineBypassedForFirstTimeIndexing) return;
        startupDeadlineBypassedForFirstTimeIndexing = true;
        const treeContainer = document.getElementById('tree-container');
        const settingsContainer = document.getElementById('settings-container');
        if (treeContainer instanceof HTMLElement) treeContainer.hidden = true;
        if (settingsContainer instanceof HTMLElement) settingsContainer.hidden = true;
        statusEl().hidden = false;
        deps.renderIndexing({ fraction: 0, message: 'Starting index...' });
        log('startup: deadline bypassed (first-time indexing)');
    };

    const startupDeadlineMs = (): number => {
        const testOverride = deps.getTestStartupDeadlineMs();
        if (typeof testOverride === 'number' && Number.isFinite(testOverride) && testOverride > 0) {
            return testOverride;
        }
        try {
            return new URL(window.location.href).searchParams.has('code')
                ? deps.startupDeadlineWithOauthCodeMs
                : deps.startupDeadlineMsDefault;
        } catch {
            return deps.startupDeadlineMsDefault;
        }
    };

    const attachSwControllerChangeReloadListener = (): void => {
        if (!deps.swDebug || swControllerChangeListenerAttached || !('serviceWorker' in navigator)) return;
        swControllerChangeListenerAttached = true;
        let reloading = false;
        navigator.serviceWorker.addEventListener('controllerchange', () => {
            if (reloading) return;
            if (!deps.getDebugEnabled()) {
                log('sw: controllerchange ignored (debug disabled)');
                return;
            }
            reloading = true;
            log('sw: controllerchange, reloading');
            location.reload();
        });
    };

    const getStartupTerminalUiState = (): Exclude<StartupTerminalState, 'deadline'> | undefined => {
        const treeContainer = document.getElementById('tree-container');
        if (treeContainer instanceof HTMLElement && !treeContainer.hidden) return 'tree';
        const status = document.getElementById('status');
        if (!(status instanceof HTMLElement)) return undefined;
        if (status.querySelector('button.signin-btn')) return 'sign-in';
        if (status.querySelector('.error-msg, .startup-error')) return 'error';
        return undefined;
    };

    const isStartupTerminalUiRendered = (): boolean =>
        getStartupTerminalUiState() !== undefined;

    const renderStartupErrorIntoStatusAndWireReload = (message: string): void => {
        const status = statusEl();
        const treeContainer = document.getElementById('tree-container');
        const settingsContainer = document.getElementById('settings-container');
        if (treeContainer instanceof HTMLElement) treeContainer.hidden = true;
        if (settingsContainer instanceof HTMLElement) settingsContainer.hidden = true;
        status.hidden = false;

        const wrapper = document.createElement('div');
        wrapper.className = 'startup-error';
        const msg = document.createElement('p');
        msg.textContent = message;
        const reload = document.createElement('button');
        reload.type = 'button';
        reload.textContent = 'Reload';
        reload.className = 'signin-btn';
        reload.addEventListener('click', () => location.reload());
        wrapper.append(msg, reload);
        status.replaceChildren(wrapper);
    };

    const showError = (message: string): void => {
        const treeContainer = document.getElementById('tree-container');
        const settingsContainer = document.getElementById('settings-container');
        if (treeContainer instanceof HTMLElement) treeContainer.hidden = true;
        if (settingsContainer instanceof HTMLElement) settingsContainer.hidden = true;
        const p = document.createElement('p');
        p.className = 'error-msg';
        p.textContent = message;
        const status = statusEl();
        status.hidden = false;
        status.replaceChildren(p);
        markStartupTerminalState('error');
    };

    const renderSignInButtonIntoStatus = (): void => {
        const el = statusEl();
        const treeContainer = document.getElementById('tree-container');
        const settingsContainer = document.getElementById('settings-container');
        if (treeContainer instanceof HTMLElement) treeContainer.hidden = true;
        if (settingsContainer instanceof HTMLElement) settingsContainer.hidden = true;
        el.hidden = false;
        el.innerHTML = '<button class="signin-btn">Sign in with OneDrive</button>';
        el.querySelector('button')!.addEventListener('click', () => deps.onSignIn());
        markStartupTerminalState('sign-in');
    };

    const onBodyLoad = async (startupInner: () => Promise<void>): Promise<void> => {
        log('');
        log('===============================================================');
        startupTerminated = false;
        startupDeadlineGuardActive = true;
        startupDeadlineBypassedForFirstTimeIndexing = false;
        const deadlineMs = startupDeadlineMs();
        let winner: 'startup' | 'deadline' | undefined;

        const startupPromise = startupInner().catch((e) => {
            logError(`startup: unhandled error: ${errorDetail(e)}`);
            if (startupTerminated) return;
            markStartupTerminalState('error');
            renderStartupErrorIntoStatusAndWireReload(deps.startupErrorMessage);
        });
        const deadlinePromise = new Promise<'deadline'>((resolve) => {
            setTimeout(() => resolve('deadline'), deadlineMs);
        });

        try {
            winner = await Promise.race([
                startupPromise.then(() => 'startup' as const),
                deadlinePromise,
            ]);
            if (winner === 'deadline' && !startupTerminated) {
                if (startupDeadlineBypassedForFirstTimeIndexing) {
                    log(`startup: deadline ignored (${deadlineMs}ms) while first-time indexing continues`);
                } else {
                    logError(`startup: deadline exceeded (${deadlineMs}ms)`);
                    markStartupTerminalState('deadline');
                    renderStartupErrorIntoStatusAndWireReload(deps.startupErrorMessage);
                }
            }
        } finally {
            startupDeadlineGuardActive = false;
            if (startupTerminated) return;
            if (winner === 'deadline' && startupDeadlineBypassedForFirstTimeIndexing) return;
            const terminal = getStartupTerminalUiState();
            if (terminal) {
                markStartupTerminalState(terminal);
                return;
            }
            logError('startup: fell through without terminal UI');
            markStartupTerminalState('error');
            renderStartupErrorIntoStatusAndWireReload(deps.startupErrorMessage);
        }
    };

    return {
        markStartupTerminalState,
        enterFirstTimeIndexingAndBypassStartupDeadline,
        startupDeadlineMs,
        attachSwControllerChangeReloadListener,
        getStartupTerminalUiState,
        isStartupTerminalUiRendered,
        renderStartupErrorIntoStatusAndWireReload,
        showError,
        renderSignInButtonIntoStatus,
        onBodyLoad,
    };
}
