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
    readonly onChooseOneDrive: () => void;
    readonly onExploreDemo: () => void;
    readonly onDemoWaiting: () => void;
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
            if (status.querySelector<HTMLElement>('.library-chooser')) deps.onDemoWaiting();
            else {
                if (!opening.matches('.index-progress')) opening.textContent = WAITING;
                appendRetryButton(status);
            }
            log(`startup: still opening (visible wait threshold ${waitMs}ms)`);
        }, waitMs);
    }

    /** Stop observing visibility once the opening screen has been replaced. */
    function stopOpeningWait(): void {
        clearTimeout(openingTimer);
        document.removeEventListener('visibilitychange', resetVisibleWait);
    }

    /** Offer document retry after a full visible wait while the opening remains active. */
    function startOpeningWait(): void {
        document.addEventListener('visibilitychange', resetVisibleWait);
        resetVisibleWait();
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

    /** Show a regular startup while the app checks for a cached library. */
    function showOpening(): void {
        if (treeInstalled || statusEl().querySelector('.startup-opening')) return;
        const message = document.createElement('p');
        message.className = 'startup-message startup-opening';
        message.setAttribute('role', 'status');
        message.textContent = OPENING;
        replaceStatusContent(message);
        startOpeningWait();
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
        if (treeInstalled || statusEl().querySelector('.library-chooser')) return;
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
        if (!status.hidden && !status.querySelector<HTMLElement>('.library-chooser') && status.querySelector('.signin-btn:not(:disabled), .startup-error')) showFailure(true);
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

    /** Keep both actions alive while public catalog startup changes status in place. */
    function showLibraryChoices(message = '', opening = false, focusConnect = false): void {
        if (treeInstalled) return;
        const status = statusEl();
        let chooser = status.querySelector<HTMLElement>('.library-chooser');
        if (!chooser) {
            chooser = document.createElement('div');
            chooser.className = 'library-chooser';
            const heading = document.createElement('header');
            heading.className = 'library-chooser-heading';
            const title = document.createElement('h1');
            title.textContent = 'OneDrive';
            const subtitle = document.createElement('p');
            subtitle.textContent = 'cloud music player';
            heading.append(title, subtitle);
            chooser.append(heading);
            const choices = [
                {kind: 'onedrive', title: 'Connect to OneDrive', sub: 'Play music from your own collection',
                    icon: '<img class="library-choice-logo" src="./assets/onedrive.png" width="28" height="28" alt="">', action: deps.onChooseOneDrive},
                {kind: 'demo', title: 'Explore the demo library', sub: 'Try OnePlay without signing in',
                    icon: '<svg class="library-choice-icon" viewBox="0 0 24 24" aria-hidden="true">'
                        + '<path d="M7 7V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-2"/>'
                        + '<rect x="3" y="7" width="14" height="14" rx="2"/>'
                        + '<path d="M8 10.5l6 3.5-6 3.5Z" fill="currentColor" stroke="none"/></svg>', action: deps.onExploreDemo},
            ];
            for (const choice of choices) {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'library-choice library-choice-' + choice.kind + (choice.kind === 'onedrive' ? ' signin-btn' : '');
                button.innerHTML = choice.icon +
                    '<span><strong>' + choice.title + '</strong><span>' + choice.sub + '</span></span>' +
                    '<span class="library-choice-next" aria-hidden="true">›</span>';
                button.addEventListener('click', choice.action);
                chooser.append(button);
            }
            const note = document.createElement('p');
            note.className = 'library-choice-status';
            note.setAttribute('role', 'status');
            const connecting = document.createElement('span');
            connecting.className = 'library-choice-connection-status';
            connecting.setAttribute('role', 'status');
            chooser.append(note, connecting);
            replaceStatusContent(chooser, chooser.querySelector('button')!);
        }
        if (status.hidden) {
            document.getElementById('tree-container')!.hidden = true;
            document.getElementById('settings-container')!.hidden = true;
            status.hidden = false;
        }
        const note = chooser.querySelector('.library-choice-status')!;
        note.classList.toggle('startup-opening', opening);
        if (note.textContent !== message) note.textContent = message;
        stopOpeningWait();
        if (opening) startOpeningWait();
        if (focusConnect) chooser.querySelector<HTMLElement>('.library-choice-onedrive')?.focus({preventScroll: true});
    }

    /** A pending provider action occupies the chevron slot and keeps keyboard focus. */
    function setOneDriveConnecting(connecting: boolean): void {
        const status = statusEl();
        const button = status.querySelector('.library-choice-onedrive');
        if (!button) return;
        if (connecting) button.setAttribute('aria-busy', 'true');
        else button.removeAttribute('aria-busy');
        status.querySelector('.library-choice-connection-status')!.textContent = connecting ? 'Connecting to OneDrive.' : '';
    }

    /** During sign-in, reserve the scan's layout until progress is available. */
    function showIndexProgress(progress?: IndexProgress): void {
        if (treeInstalled) return;
        const status = statusEl();
        let view = status.querySelector<HTMLElement>('.index-progress');
        if (!view) {
            view = document.createElement('div');
            view.className = progress ? 'index-progress' : 'index-progress startup-opening';
            view.innerHTML = '<div role="status">Indexing your music...</div>'
                + '<div class="progress-bar"><div class="progress-fill"></div></div>'
                + '<div class="status-line"></div>';
            replaceStatusContent(view);
        }
        if (!progress) return;
        if (view.classList.contains('startup-opening')) {
            view.classList.remove('startup-opening');
            stopOpeningWait();
            const retry = status.querySelector('.startup-retry');
            if (retry && document.activeElement === retry) status.focus({preventScroll: true});
            retry?.remove();
        }
        const pct = Math.round(progress.fraction * 100);
        view.querySelector<HTMLElement>('.progress-fill')!.style.width = `${pct}%`;
        view.querySelector('.status-line')!.textContent = `${pct}% — ${progress.message}`;
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
        startOpeningWait,
        showFailure,
        showOfflineIfAwaitingRecovery,
        showFailureIfUnresolved,
        isShowingOfflineRetry,
        showSignIn,
        showLibraryChoices,
        setOneDriveConnecting,
        showSignInIfAwaitingRecovery,
        showIndexProgress,
        onBodyLoad,
    };
}
