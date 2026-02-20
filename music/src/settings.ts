/**
 * Settings page component for OnePlay Music.
 *
 * KISS model:
 * - open(): build DOM fresh from current values.
 * - close(): destroy DOM.
 * - updateIndexSection(): live-update only indexing lines while open.
 */

import { logCatch } from './logger.js';
import { type EvidenceState } from './auth.js';
import { type IndexProgress } from './indexer.js';
import { showModal, addModalActions } from './modal.js';

export type TimerDuration = '15m' | '30m' | '45m' | '60m' | 'end-of-track';

export type ThemePreference = 'light' | 'dark' | 'auto';

export interface SettingsShareRow {
    readonly id: string;
    readonly label: string;
    readonly deniedReason?: string;
    readonly removeImpactTracks: number;
    readonly removeImpactFavorites: number;
}

export interface SettingsShareIndexRow {
    readonly id: string;
    readonly label: string;
    readonly progress?: IndexProgress;
}

export interface SettingsIndexFailure {
    readonly label: string;
    readonly message: string;
    readonly at: number;
}

interface OpenOptions {
    readonly evidence: EvidenceState;
    readonly timerDuration: TimerDuration;
    readonly debugEnabled: boolean;
    readonly lastIndexUpdatedAt: number | undefined;
    readonly shareRows?: readonly SettingsShareRow[];
    readonly onClose: () => void;
    readonly onSignOut: () => Promise<void> | void;
    readonly onReconnect: () => Promise<void> | void;
    readonly onRefreshNow: () => Promise<void> | void;
    readonly onAddShare: (url: string, signal?: AbortSignal) => Promise<void> | void;
    readonly onRenameShare: (id: string, nextName: string) => Promise<void> | void;
    readonly onRemoveShare: (id: string) => Promise<void> | void;
    readonly onTimerChange: (next: TimerDuration) => void;
    readonly theme: ThemePreference;
    readonly onThemeChange: (next: ThemePreference) => void;
    readonly onDebugToggle: (next: boolean) => void;
}

interface IndexStatus {
    readonly checkingForUpdates: boolean;
    readonly indexProgress: IndexProgress | undefined;
    readonly shareRows?: readonly SettingsShareIndexRow[];
    readonly lastIndexUpdatedAt: number | undefined;
    readonly latestFailure?: SettingsIndexFailure;
}

export interface SettingsView {
    open(initial: OpenOptions): void;
    close(): void;
    isOpen(): boolean;
    updateIndexSection(status: IndexStatus): void;
}

const DEBUG_ENABLED_NOTE = 'Log, evidence indicator and version-refresh are turned on.';

const TIMER_OPTIONS: ReadonlyArray<{ value: TimerDuration; label: string }> = [
    { value: '15m', label: '15m' },
    { value: '30m', label: '30m' },
    { value: '45m', label: '45m' },
    { value: '60m', label: '60m' },
    { value: 'end-of-track', label: 'End of track' },
];

/** Same delete glyph used by the action-bar right button in select mode. */
const ACTION_DELETE_ICON_SVG = '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5h14M7 5V4a1 1 0 011-1h4a1 1 0 011 1v1M5 5v12a1 1 0 001 1h8a1 1 0 001-1V5"/><path d="M8 9v5M12 9v5"/></svg>';

/** Formats a saved refresh timestamp as relative time ("5 mins ago", "just now"). */
function formatLastUpdated(at: number | undefined): string {
    if (at === undefined || !Number.isFinite(at)) return 'Last updated never';
    const mins = Math.floor((Date.now() - at) / 60_000);
    const relative = mins < 1 ? '<1 min ago'
        : mins === 1 ? '1 min ago'
        : mins < 60 ? `${mins} mins ago`
        : mins < 120 ? '1 hour ago'
        : `${Math.floor(mins / 60)} hours ago`;
    return `Last updated ${relative}`;
}

/** Runs a maybe-async UI callback with centralized error logging. */
function runMaybeAsyncUiAction(
    action: () => Promise<void> | void,
    context: string,
): void {
    Promise.resolve()
        .then(action)
        .catch(logCatch(context));
}

/** Renders an indexing status text with spinner. */
function appendSpinnerLine(target: HTMLElement, text: string): void {
    const line = document.createElement('div');
    line.className = 'settings-index-line-row';
    line.textContent = text;
    const spinner = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    spinner.setAttribute('viewBox', '0 0 16 16');
    spinner.setAttribute('aria-hidden', 'true');
    spinner.classList.add('sync-spinner');
    spinner.innerHTML = '<circle cx="8" cy="8" r="5"/>';
    line.appendChild(spinner);
    target.appendChild(line);
}

/** Removes raw URL clutter from failure text while keeping actionable error detail. */
function formatFailureMessageForDisplay(message: string): string {
    const noParenUrls = message.replace(/\s*\(https?:\/\/[^\s)]+\)/gi, '');
    const noUrls = noParenUrls.replace(/\s*https?:\/\/\S+/gi, '');
    return noUrls.replace(/\s+/g, ' ').trim() || message;
}

export function createSettings(container: HTMLElement): SettingsView {
    let openState = false;
    let indexStatus: IndexStatus = {
        checkingForUpdates: false,
        indexProgress: undefined,
        shareRows: [],
        lastIndexUpdatedAt: undefined,
        latestFailure: undefined,
    };

    let debugButton: HTMLButtonElement | undefined;
    let debugLineEl: HTMLElement | undefined;
    let indexLinesEl: HTMLElement | undefined;
    let indexHeadingEl: HTMLElement | undefined;
    let refreshButton: HTMLButtonElement | undefined;

    const renderDebugControls = (enabled: boolean): void => {
        if (debugButton) debugButton.textContent = enabled ? 'Turn off' : 'Turn on';
        if (!debugLineEl) return;
        debugLineEl.hidden = !enabled;
        debugLineEl.textContent = enabled ? DEBUG_ENABLED_NOTE : '';
    };

    const renderIndexSection = (): void => {
        if (!indexLinesEl || !refreshButton) return;
        const checkingForUpdates = indexStatus.checkingForUpdates;
        const hasShareBuild = (indexStatus.shareRows ?? []).some((row) => row.progress !== undefined);
        const indexingActive = checkingForUpdates || indexStatus.indexProgress !== undefined || hasShareBuild;
        if (indexHeadingEl) {
            indexHeadingEl.textContent = indexingActive ? 'Indexing\u2026' : 'Index';
        }

        indexLinesEl.replaceChildren();
        if (checkingForUpdates) {
            appendSpinnerLine(indexLinesEl, 'Checking for updates...');
        } else if (indexStatus.indexProgress) {
            const pct = Math.round(indexStatus.indexProgress.fraction * 100);
            const msg = indexStatus.indexProgress.message ? ` ${indexStatus.indexProgress.message}` : '';
            appendSpinnerLine(indexLinesEl, `OneDrive: ${pct}%${msg}`);
        }
        if (!checkingForUpdates) {
            for (const share of indexStatus.shareRows ?? []) {
                if (!share.progress) continue;
                const pct = Math.round(share.progress.fraction * 100);
                const msg = share.progress.message ? ` ${share.progress.message}` : '';
                appendSpinnerLine(indexLinesEl, `${share.label}: ${pct}%${msg}`);
            }
        }

        if (!checkingForUpdates && !indexStatus.indexProgress
            && (indexStatus.shareRows ?? []).every((row) => row.progress === undefined)) {
            const line = document.createElement('div');
            line.className = 'settings-index-line-row';
            if (indexStatus.latestFailure) {
                line.classList.add('settings-index-line-row-error');
                const shownMessage = formatFailureMessageForDisplay(indexStatus.latestFailure.message);
                line.textContent = `Last refresh failed: [${indexStatus.latestFailure.label}] ${shownMessage}`;
            } else {
                line.textContent = `${formatLastUpdated(indexStatus.lastIndexUpdatedAt)} \u2713`;
            }
            indexLinesEl.appendChild(line);
        }
        refreshButton.classList.toggle('settings-pill-refresh-urgent', !!indexStatus.latestFailure && !indexingActive);
        refreshButton.disabled = indexingActive;
    };

    return {
        open(initial) {
            container.replaceChildren();
            openState = true;
            debugButton = undefined;
            debugLineEl = undefined;
            indexLinesEl = undefined;
            indexHeadingEl = undefined;
            refreshButton = undefined;
            indexStatus = {
                checkingForUpdates: false,
                indexProgress: undefined,
                shareRows: [],
                lastIndexUpdatedAt: initial.lastIndexUpdatedAt,
                latestFailure: undefined,
            };

            const root = document.createElement('div');
            root.className = 'settings-shell';

            const header = document.createElement('div');
            header.className = 'settings-header';

            const title = document.createElement('span');
            title.className = 'settings-title';
            title.textContent = 'Settings';

            const closeSettings = (): void => {
                initial.onClose();
            };
            header.addEventListener('click', closeSettings);

            const menuBtn = document.createElement('button');
            menuBtn.type = 'button';
            menuBtn.className = 'row-icon row-icon-menu row-icon-menu-left row-icon-settings settings-menu';
            menuBtn.textContent = '\u2630\uFE0E';
            menuBtn.setAttribute('aria-label', 'Close settings');

            const closeBtn = document.createElement('button');
            closeBtn.type = 'button';
            closeBtn.className = 'settings-close';
            closeBtn.textContent = '\u00D7';
            header.append(menuBtn, title, closeBtn);

            const body = document.createElement('div');
            body.className = 'settings-body';

            const section = (name: string): HTMLElement => {
                const s = document.createElement('section');
                s.className = 'settings-section';
                const h = document.createElement('h3');
                h.textContent = name;
                s.appendChild(h);
                return s;
            };

            const oneDrive = section('OneDrive');
            const authBtn = document.createElement('button');
            authBtn.type = 'button';
            const reconnect = initial.evidence === 'evidence:signed-out';
            authBtn.className = reconnect ? 'settings-pill settings-pill-reconnect' : 'settings-pill';
            authBtn.textContent = reconnect ? 'Reconnect...' : 'Sign out';
            authBtn.addEventListener('click', () => {
                initial.onClose();
                runMaybeAsyncUiAction(
                    () => reconnect ? initial.onReconnect() : initial.onSignOut(),
                    'settings auth action',
                );
            });
            oneDrive.appendChild(authBtn);
            body.appendChild(oneDrive);

            const shared = section('Shared with you');
            const shareList = document.createElement('div');
            shareList.className = 'settings-share-list';
            for (const share of initial.shareRows ?? []) {
                const row = document.createElement('div');
                row.className = 'settings-share-item settings-share-row';

                const textWrap = document.createElement('div');
                textWrap.className = 'settings-share-text';

                const name = document.createElement('span');
                name.className = 'settings-share-name';
                name.textContent = share.label;
                textWrap.appendChild(name);

                if (share.deniedReason) {
                    const denied = document.createElement('span');
                    denied.className = 'settings-share-denied';
                    denied.textContent = share.deniedReason;
                    textWrap.appendChild(denied);
                }

                const actions = document.createElement('div');
                actions.className = 'settings-share-actions';

                const renameBtn = document.createElement('button');
                renameBtn.type = 'button';
                renameBtn.className = 'settings-share-icon-btn settings-share-rename';
                renameBtn.textContent = '\u270E';
                renameBtn.addEventListener('click', () => {
                    showModal('Rename share', (modal, close) => {
                        const input = document.createElement('input');
                        input.type = 'text';
                        input.value = share.label;
                        input.placeholder = 'Share name';
                        modal.appendChild(input);
                        addModalActions(modal, close, 'Save', async () => {
                            await initial.onRenameShare(share.id, input.value);
                        });
                        input.focus();
                        input.select();
                    }, undefined, true);
                });

                const removeBtn = document.createElement('button');
                removeBtn.type = 'button';
                removeBtn.className = 'settings-share-icon-btn settings-share-trash';
                removeBtn.innerHTML = ACTION_DELETE_ICON_SVG;
                removeBtn.addEventListener('click', () => {
                    showModal('Disconnect from share', (modal, close) => {
                        if (share.removeImpactFavorites > 0) {
                            const p = document.createElement('p');
                            p.textContent = `This will remove ${share.removeImpactTracks} tracks from ${share.removeImpactFavorites} playlists.`;
                            modal.appendChild(p);
                        }
                        addModalActions(modal, close, 'Disconnect', async () => {
                            await initial.onRemoveShare(share.id);
                        }, true);
                    });
                });

                actions.append(renameBtn, removeBtn);
                row.append(textWrap, actions);
                shareList.appendChild(row);
            }

            const addShareBtn = document.createElement('button');
            addShareBtn.type = 'button';
            addShareBtn.className = 'settings-share-item settings-share-add';
            const addShareName = document.createElement('span');
            addShareName.className = 'settings-share-name';
            addShareName.textContent = 'Add share URL...';
            const addShareIcon = document.createElement('span');
            addShareIcon.className = 'settings-share-icon-btn settings-share-add-icon';
            addShareIcon.textContent = '+';
            addShareBtn.append(addShareName, addShareIcon);
            addShareBtn.addEventListener('click', () => {
                showModal('Add share URL', (modal, close) => {
                    const p = document.createElement('p');
                    p.textContent = 'Other people can use their OneDrive app to share their music folders with you. Have them message you the URL, and paste it here.';
                    modal.appendChild(p);
                    const inputWrap = document.createElement('div');
                    inputWrap.className = 'modal-url-input-wrap';
                    const input = document.createElement('input');
                    input.type = 'text';
                    input.placeholder = 'https://...';
                    const clearBtn = document.createElement('button');
                    clearBtn.type = 'button';
                    clearBtn.className = 'modal-url-input-clear';
                    clearBtn.setAttribute('aria-label', 'Clear URL');
                    clearBtn.textContent = '\u00D7';
                    const renderClearButton = (): void => {
                        clearBtn.hidden = input.value.trim().length === 0;
                    };
                    input.addEventListener('input', renderClearButton);
                    clearBtn.addEventListener('click', () => {
                        input.value = '';
                        renderClearButton();
                        input.focus();
                    });
                    inputWrap.append(input, clearBtn);
                    modal.appendChild(inputWrap);
                    renderClearButton();
                    addModalActions(modal, close, 'Add', async (signal) => {
                        await initial.onAddShare(input.value, signal);
                    });
                    input.focus();
                }, undefined, true);
            });
            shareList.appendChild(addShareBtn);
            shared.appendChild(shareList);
            body.appendChild(shared);

            const timer = section('Duration of Timer mode');
            const timerSelect = document.createElement('select');
            timerSelect.className = 'settings-timer-select';
            for (const opt of TIMER_OPTIONS) {
                const optEl = document.createElement('option');
                optEl.value = opt.value;
                optEl.textContent = opt.label;
                timerSelect.appendChild(optEl);
            }
            timerSelect.value = initial.timerDuration;
            timerSelect.addEventListener('change', () => {
                initial.onTimerChange(timerSelect.value as TimerDuration);
            });
            timer.appendChild(timerSelect);
            body.appendChild(timer);

            const indexing = section('Index');
            indexHeadingEl = indexing.querySelector('h3')!;
            indexLinesEl = document.createElement('div');
            indexLinesEl.className = 'settings-index-line';
            refreshButton = document.createElement('button');
            refreshButton.type = 'button';
            refreshButton.className = 'settings-pill settings-pill-refresh';
            refreshButton.textContent = 'Refresh now';
            refreshButton.addEventListener('click', () => {
                indexStatus = { ...indexStatus, checkingForUpdates: true };
                renderIndexSection();
                runMaybeAsyncUiAction(() => initial.onRefreshNow(), 'settings refresh');
            });
            indexing.append(indexLinesEl, refreshButton);
            body.appendChild(indexing);
            renderIndexSection();

            const themeSec = section('Theme');
            const themeSelect = document.createElement('select');
            themeSelect.className = 'settings-theme-select';
            for (const opt of [
                { value: 'light', label: 'Light' },
                { value: 'dark', label: 'Dark' },
                { value: 'auto', label: 'Auto (system)' },
            ] as const) {
                const optEl = document.createElement('option');
                optEl.value = opt.value;
                optEl.textContent = opt.label;
                themeSelect.appendChild(optEl);
            }
            themeSelect.value = initial.theme;
            themeSelect.addEventListener('change', () => {
                initial.onThemeChange(themeSelect.value as ThemePreference);
            });
            themeSec.appendChild(themeSelect);
            body.appendChild(themeSec);

            const debug = section('Debug');
            let debugEnabled = initial.debugEnabled;
            debugButton = document.createElement('button');
            debugButton.type = 'button';
            debugButton.className = 'settings-pill';
            debugLineEl = document.createElement('div');
            debugLineEl.className = 'settings-debug-line';
            debugButton.addEventListener('click', () => {
                debugEnabled = !debugEnabled;
                renderDebugControls(debugEnabled);
                initial.onDebugToggle(debugEnabled);
            });
            renderDebugControls(debugEnabled);
            debug.append(debugLineEl, debugButton);
            body.appendChild(debug);

            root.append(header, body);
            container.replaceChildren(root);
        },

        close() {
            if (!openState) return;
            openState = false;
            container.replaceChildren();
            debugButton = undefined;
            debugLineEl = undefined;
            indexLinesEl = undefined;
            indexHeadingEl = undefined;
            refreshButton = undefined;
        },

        isOpen: () => openState,

        updateIndexSection(status) {
            indexStatus = status;
            if (!openState) return;
            renderIndexSection();
        },
    };
}
