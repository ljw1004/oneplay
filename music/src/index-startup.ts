/** Opening status, optional document retry, and service-worker reload wiring. */
import { log, logError, errorDetail } from './logger.js';
import type { IndexProgress } from './indexer.js';

const OPENING = 'Opening your library…';
const WAITING = 'Still opening your library…';
const OPENING_FAILED = 'OnePlay couldn’t open your library.';
const OFFLINE = 'Connect to the internet, then try again.';
const OPENING_WAIT_MS = 15_000;

interface IndexStartupDeps {
    readonly swDebug: boolean;
    readonly appVersionLabel: string;
    readonly getDebugEnabled: () => boolean;
    readonly getTestOpeningWaitMs: () => unknown;
    readonly onSignIn: () => void;
}

export function createIndexStartup(deps: IndexStartupDeps) {
    let swControllerChangeListenerAttached = false;
    let treeInstalled = false;
    let openingTimer: ReturnType<typeof setTimeout> | undefined;

    const statusEl = (): HTMLElement => document.getElementById('status')!;

    /** Keep the same action when an optional retry becomes a confirmed failure. */
    function appendRetryButton(status: HTMLElement): void {
        if (status.querySelector('.startup-retry')) return;
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'startup-retry';
        retry.textContent = 'Try again';
        retry.addEventListener('click', () => {
            retry.disabled = true;
            location.reload();
        });
        status.append(retry);
    }

    /** Each observed visible interval gets a full wait. The original attempt stays live. */
    function resetVisibleWait(): void {
        clearTimeout(openingTimer);
        const status = statusEl();
        if (document.hidden || status.hidden || status.querySelector('.startup-retry')) return;
        const opening = status.querySelector('.startup-opening');
        if (!opening) return;
        const override = deps.getTestOpeningWaitMs();
        const waitMs = typeof override === 'number' && Number.isFinite(override) && override > 0
            ? override : OPENING_WAIT_MS;
        openingTimer = setTimeout(() => {
            if (document.hidden || status.hidden || !opening.matches('.startup-opening') || !opening.isConnected) return;
            opening.textContent = WAITING;
            appendRetryButton(status);
            log(`startup: still opening (visible wait threshold ${waitMs}ms)`);
        }, waitMs);
    }

    /** Stop observing visibility once the opening screen has been replaced. */
    function stopOpeningWait(): void {
        clearTimeout(openingTimer);
        document.removeEventListener('visibilitychange', resetVisibleWait);
    }

    /** Replace status content and carry focus only when that content owned it. */
    function replaceStatusContent(content: HTMLElement, focusTarget = statusEl()): void {
        const status = statusEl();
        const hadFocus = status.contains(document.activeElement);
        stopOpeningWait();
        document.getElementById('tree-container')!.hidden = true;
        document.getElementById('settings-container')!.hidden = true;
        status.hidden = false;
        status.replaceChildren(content);
        if (hadFocus) focusTarget.focus({ preventScroll: true });
    }

    /** Start the opening screen, including when browser connectivity recovers. */
    function showOpening(): void {
        if (treeInstalled || statusEl().querySelector('.startup-opening')) return;
        const message = document.createElement('p');
        message.className = 'startup-message startup-opening';
        message.setAttribute('role', 'status');
        message.textContent = OPENING;
        replaceStatusContent(message);
        document.addEventListener('visibilitychange', resetVisibleWait);
        resetVisibleWait();
    }

    /** Record success only after the layout-visible tree and controls have been installed. */
    function recordTreeInstalled(moveFocus: boolean): void {
        if (treeInstalled) return;
        treeInstalled = true;
        stopOpeningWait();
        statusEl().replaceChildren();
        if (moveFocus) document.getElementById('tree-container')!.focus({ preventScroll: true });
        log('startup complete: tree');
    }

    /** The paired-store mismatch retains its existing exceptional screen. */
    function showCacheAccountMismatch(): void {
        const message = document.createElement('p');
        message.className = 'error-msg';
        message.textContent = 'This cached library belongs to a different OneDrive account.';
        replaceStatusContent(message);
        logError('startup complete: error');
    }

    /** Present a settled opening failure while retaining any focused retry action. */
    function showFailure(offline = false, moveFocus = false): void {
        if (treeInstalled) return;
        const status = statusEl();
        const message = status.querySelector<HTMLElement>('.startup-message') ?? document.createElement('p');
        if (status.hidden || !message.isConnected) replaceStatusContent(message);
        stopOpeningWait();
        message.className = 'startup-message startup-error';
        message.toggleAttribute('data-offline', offline);
        message.setAttribute('role', 'status');
        message.textContent = offline ? OFFLINE : OPENING_FAILED;
        const hadFocus = moveFocus || document.activeElement === status;
        appendRetryButton(status);
        if (hadFocus) status.querySelector<HTMLElement>('.startup-retry')?.focus({ preventScroll: true });
        logError('startup complete: error');
    }

    /** Reachability can change after an empty launch chose its initial action. */
    function showOfflineIfAwaitingRecovery(): void {
        const status = statusEl();
        if (!status.hidden && status.querySelector('.signin-btn:not(:disabled), .startup-error')) showFailure(true);
    }

    /** A confirmed browser reconnect can also retire a previous offline retry. */
    function showSignInIfAwaitingRecovery(browserOnline: boolean): void {
        const status = statusEl();
        const failure = status.querySelector('.startup-error');
        if (!status.hidden && failure && (browserOnline || !failure.hasAttribute('data-offline'))) showSignIn();
    }

    /** Show the existing interactive account action for a library without local data. */
    function showSignIn(): void {
        if (treeInstalled || statusEl().querySelector('.signin-btn')) return;
        const signIn = document.createElement('button');
        signIn.type = 'button';
        signIn.className = 'signin-btn';
        signIn.textContent = 'Sign in with OneDrive';
        signIn.addEventListener('click', deps.onSignIn);
        replaceStatusContent(signIn, signIn);
        log('startup complete: sign-in');
    }

    /** Index progress takes over the opening screen and updates its nodes in place. */
    function showIndexProgress(progress: IndexProgress): void {
        if (treeInstalled) return;
        const status = statusEl();
        if (!status.querySelector('.index-progress')) {
            const view = document.createElement('div');
            view.className = 'index-progress';
            view.innerHTML = '<div>Indexing your music...</div>'
                + '<div class="progress-bar"><div class="progress-fill"></div></div>'
                + '<div class="status-line"></div>';
            replaceStatusContent(view);
        }
        const pct = Math.round(progress.fraction * 100);
        status.querySelector<HTMLElement>('.progress-fill')!.style.width = `${pct}%`;
        status.querySelector('.status-line')!.textContent = `${pct}% — ${progress.message}`;
    }

    /** A visible offline message can outlast the evidence that first produced it. */
    function isShowingOfflineRetry(): boolean {
        const status = statusEl();
        return !status.hidden && status.querySelector('.startup-error[data-offline]') !== null;
    }

    /** A settled attempt must leave a usable tree or a concrete status outcome. */
    function showFailureIfUnresolved(offline = false): void {
        const status = statusEl();
        const settled = offline ? '.startup-error[data-offline], .error-msg' : '.startup-error, .error-msg, .signin-btn';
        if (treeInstalled || (!status.hidden && status.querySelector(settled))) return;
        showFailure(offline);
    }

    function attachSwControllerChangeReloadListener(): void {
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
    }

    async function onBodyLoad(startupInner: () => Promise<void>): Promise<void> {
        log(`====== APP LAUNCH v${deps.appVersionLabel} ========`);
        showOpening();
        try {
            await startupInner();
        } catch (error) {
            logError(`startup: unhandled error: ${errorDetail(error)}`);
        }
        showFailureIfUnresolved();
    }

    return {
        hasInstalledTree: () => treeInstalled,
        recordTreeInstalled,
        attachSwControllerChangeReloadListener,
        showCacheAccountMismatch,
        showOpening,
        showFailure,
        showOfflineIfAwaitingRecovery,
        showFailureIfUnresolved,
        isShowingOfflineRetry,
        showSignIn,
        showSignInIfAwaitingRecovery,
        showIndexProgress,
        onBodyLoad,
    };
}
